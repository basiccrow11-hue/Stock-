/**
 * Simulated broker: order book, fills, positions, cash, P/L and round-trip trade tracking.
 *
 * Fills are driven ONLY by bars passed to onBar() (plus the last known price for immediate market
 * fills). The broker never sees future data: it is a consumer of whatever the replay/backtest/sim
 * clock has revealed. Inside a bar it walks an assumed intrabar path (see ExecutionConfig.intrabarPath)
 * so stops, limits and bracket exits trigger at the price level where they would have been hit,
 * gaps fill at the gap price, and nothing fills "magically" at a convenient price.
 *
 * State is a plain JSON-serializable object so replay can snapshot/restore it for step-back.
 */
import type {
  AccountSnapshot,
  Bar,
  DataSourceKind,
  EquityPoint,
  Fill,
  Order,
  OrderAction,
  OrderRequest,
  OrderType,
  Position,
  RoundTrip,
  Side,
  UnixSeconds,
} from '../types';
import { actionSide } from '../types';
import type { ExecutionConfig } from './config';
import { DEFAULT_EXECUTION_CONFIG, commissionFor, halfSpread } from './config';
import { assessRisk, over } from '../risk/risk';
import { formatTick, roundToTick } from '../util/math';
import { equityBeforeEntry } from '../analytics/stats';
import {
  exchangeDate,
  exchangeMinuteOfDay,
  isTradingDay,
  marketSession,
  nextTradingDay,
  regularCloseMinute,
  type MarketSession,
} from '../time';

export interface BrokerEvent {
  time: UnixSeconds;
  kind: 'accepted' | 'filled' | 'partial' | 'cancelled' | 'rejected' | 'expired' | 'triggered' | 'info';
  orderId?: string;
  message: string;
}

export interface BrokerState {
  idPrefix: string;
  seq: number;
  source: DataSourceKind;
  startingBalance: number;
  cash: number;
  realizedPnl: number;
  commissionsPaid: number;
  positions: Record<string, Position>;
  orders: Order[];
  fills: Fill[];
  roundTrips: RoundTrip[];
  openTripBySymbol: Record<string, string>;
  lastPrice: Record<string, number>;
  lastBar: Record<string, Bar>;
  /**
   * Shares already traded against each symbol's last bar: its own fills, then orders filled at once
   * before the next bar. maxParticipation caps their total, not each order.
   */
  barVolumeUsed?: Record<string, number>;
  /** End time of the most recent processed bar (the broker's "now"). */
  clock: UnixSeconds;
  sessionDate: string;
  dayStartEquity: number;
  /**
   * The lowest equity since the session began at a moment every bar ending then had been processed,
   * taken as each such moment's bars begin (Strict Mode's daily limit holds once reached). The latest
   * moment is read live, not from here.
   */
  dayLowEquity?: number;
  /**
   * Equity when the bars ending at `time` began to be processed (the last moment every bar had closed):
   * what Strict Mode's daily limit is judged on while they fill, with each bar's own fills.
   */
  stepStart?: { time: UnixSeconds; equity: number };
  equityCurve: EquityPoint[];
  events: BrokerEvent[];
  version: number;
}

/** A restore point from SimBroker.checkpoint(). */
export interface BrokerCheckpoint {
  core: Omit<BrokerState, 'orders' | 'fills' | 'roundTrips' | 'equityCurve' | 'events'>;
  orders: number;
  /** Orders that were still open, by index (the others never change again). */
  openOrders: Array<[number, Order]>;
  fills: number;
  trips: number;
  /** Trips that were still open, by index. */
  openTrips: Array<[number, RoundTrip]>;
  curve: number;
  /** The latest equity point, which later bars at the same time update. */
  curveLast?: EquityPoint;
  events: BrokerEvent[];
}

export interface SubmitResult {
  ok: boolean;
  order?: Order;
  error?: string;
  warnings: string[];
  /** What else was done with the order, e.g. entries a close cancelled. */
  notes?: string[];
}

/**
 * The risk of the trade an opening order would join, counted from its first stop (SimBroker.tradeRiskOf):
 * what Strict Mode limits and Size by risk sizes to.
 */
export interface TradeRisk {
  /** The trade's first stop: the open trade's, or the stop loss its entries share. */
  stop: number;
  /** As a % of `equity`, the equity the trade started with (today's, while it has not). */
  pct: number;
  dollars: number;
  equity: number;
  /** Which number it is: the trade review's measure, or what the trade would lose at its first stop. */
  by: 'review' | 'loss';
  /** Shares held in the trade, and in its other working entries. */
  held: number;
  working: number;
  /** The trade's largest size so far, when the review's measure counts the trade at it (more shares than it holds and has working). */
  peak?: number;
  /** The trade's average entry is already at or past its first stop, so its risk can't be measured. */
  unmeasurable: boolean;
}

/** The tick a price trades in: a cent, or a hundredth of a cent below $1. */
function tickOf(price: number): number {
  return price >= 1 ? 0.01 : 0.0001;
}
/** Market impact is charged on at most one bar's whole volume (see execute). */
const MAX_IMPACT_PCT = 100;
/** The lowest price a fill can print at: one tick of a sub-dollar stock. */
const MIN_PRICE = 0.0001;
const EPS = 1e-9;
const MAX_EVENTS = 500;

function ceilTick(p: number): number {
  return p >= 1 ? Math.ceil(p * 100 - 1e-7) / 100 : Math.ceil(p * 10_000 - 1e-7) / 10_000;
}
function floorTick(p: number): number {
  return p >= 1 ? Math.floor(p * 100 + 1e-7) / 100 : Math.floor(p * 10_000 + 1e-7) / 10_000;
}
/** "1 TEST share", "300 TEST shares". */
function shares(n: number, symbol?: string): string {
  return `${n} ${symbol ? `${symbol} ` : ''}share${n === 1 ? '' : 's'}`;
}
function money(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/** Point along the intrabar path where an order fires. */
interface Trigger {
  order: Order;
  level: number;
  distance: number;
}

export class SimBroker {
  private s: BrokerState;
  /**
   * Index of the oldest order that may still be open. Orders are appended in time order and a
   * terminal status (filled, cancelled, rejected, expired) never reverts, so everything before this
   * index can be skipped. Keeps per-bar work independent of how many orders the session has seen.
   */
  private openFrom = 0;
  /**
   * While onBar runs, what the daily limit adds to the account's equity to judge it as of this bar's
   * own fills: `offset`, the step's starting equity (stepStart) less the equity when this bar began, so
   * other symbols' bars processed before it at the same time are left out; and `adj`, which values the
   * shares this bar opened (and still holds, `held`, signed) at what was paid rather than at the
   * symbol's previous close. Undefined otherwise.
   */
  private bar?: { symbol: string; offset: number; held: number; adj: number };

  private liveOrders(): Order[] {
    const list = this.s.orders;
    while (this.openFrom < list.length && !isOpen(list[this.openFrom])) this.openFrom++;
    return this.openFrom === 0 ? list : list.slice(this.openFrom);
  }

  /** A working order by id. Open orders all sit from openFrom on, and the one asked for is usually among the newest. */
  private openOrderById(id: string): Order | undefined {
    this.liveOrders();
    const list = this.s.orders;
    for (let i = list.length - 1; i >= this.openFrom; i--) if (list[i].id === id) return isOpen(list[i]) ? list[i] : undefined;
    return undefined;
  }

  private tripById(id: string): RoundTrip | undefined {
    const trips = this.s.roundTrips;
    for (let i = trips.length - 1; i >= 0; i--) if (trips[i].id === id) return trips[i];
    return undefined;
  }
  cfg: ExecutionConfig;

  constructor(opts: { startingBalance: number; config?: ExecutionConfig; idPrefix?: string; source?: DataSourceKind; state?: BrokerState }) {
    this.cfg = opts.config ?? DEFAULT_EXECUTION_CONFIG;
    this.s =
      opts.state ??
      ({
        idPrefix: opts.idPrefix ?? 'acct',
        seq: 0,
        source: opts.source ?? 'DEMO',
        startingBalance: opts.startingBalance,
        cash: opts.startingBalance,
        realizedPnl: 0,
        commissionsPaid: 0,
        positions: {},
        orders: [],
        fills: [],
        roundTrips: [],
        openTripBySymbol: {},
        lastPrice: {},
        lastBar: {},
        barVolumeUsed: {},
        clock: 0,
        sessionDate: '',
        dayStartEquity: opts.startingBalance,
        equityCurve: [],
        events: [],
        version: 0,
      } satisfies BrokerState);
  }

  // ---------------------------------------------------------------- state

  getState(): BrokerState {
    return structuredClone(this.s);
  }

  restore(state: BrokerState): void {
    this.s = structuredClone(state);
    this.openFrom = 0;
  }

  /**
   * A cheap restore point for rollback(). Finished orders, closed trips, fills, equity points before
   * the latest one and log lines are never changed once written, so the checkpoint keeps how many
   * there were and copies only what can still change.
   */
  checkpoint(): BrokerCheckpoint {
    const { orders, fills, roundTrips, equityCurve, events, ...core } = this.s;
    this.liveOrders(); // moves openFrom past finished orders
    const openOrders: Array<[number, Order]> = [];
    for (let i = this.openFrom; i < orders.length; i++) if (isOpen(orders[i])) openOrders.push([i, structuredClone(orders[i])]);
    const openTrips: Array<[number, RoundTrip]> = [];
    for (const id of Object.values(core.openTripBySymbol)) {
      let i = roundTrips.length - 1;
      while (i >= 0 && roundTrips[i].id !== id) i--;
      if (i >= 0) openTrips.push([i, structuredClone(roundTrips[i])]);
    }
    const last = equityCurve[equityCurve.length - 1];
    return {
      core: structuredClone(core),
      orders: orders.length,
      openOrders,
      fills: fills.length,
      trips: roundTrips.length,
      openTrips,
      curve: equityCurve.length,
      curveLast: last && { ...last },
      events: events.slice(),
    };
  }

  /** The state at `cp`, rebuilt from the current one, which must have come from it. */
  private stateAt(cp: BrokerCheckpoint): BrokerState {
    const s = this.s;
    if (s.orders.length < cp.orders || s.fills.length < cp.fills || s.roundTrips.length < cp.trips || s.equityCurve.length < cp.curve) {
      throw new Error('That checkpoint is not from this account’s history.');
    }
    const orders = s.orders.slice(0, cp.orders);
    for (const [i, o] of cp.openOrders) orders[i] = structuredClone(o);
    const roundTrips = s.roundTrips.slice(0, cp.trips);
    for (const [i, t] of cp.openTrips) roundTrips[i] = structuredClone(t);
    const equityCurve = s.equityCurve.slice(0, cp.curve);
    if (cp.curveLast) equityCurve[cp.curve - 1] = { ...cp.curveLast };
    // The lists are new arrays; the entries they share with this state are never changed.
    return { ...structuredClone(cp.core), orders, fills: s.fills.slice(0, cp.fills), roundTrips, equityCurve, events: cp.events.slice() };
  }

  /** Go back to `cp`, taken earlier on this broker. */
  rollback(cp: BrokerCheckpoint): void {
    const version = this.s.version;
    this.s = this.stateAt(cp);
    // A version the UI has already seen is never reused.
    this.s.version = version + 1;
    this.openFrom = 0;
  }

  /** A separate broker starting from `cp`, taken earlier on this one, which stays as it is. */
  fork(cp: BrokerCheckpoint): SimBroker {
    return new SimBroker({ startingBalance: cp.core.startingBalance, config: this.cfg, state: this.stateAt(cp) });
  }

  /** Read-only view; do not mutate. */
  get state(): Readonly<BrokerState> {
    return this.s;
  }

  get version(): number {
    return this.s.version;
  }

  private nextId(kind: string): string {
    this.s.seq += 1;
    return `${this.s.idPrefix}-${kind}${this.s.seq}`;
  }

  private log(kind: BrokerEvent['kind'], message: string, orderId?: string): void {
    this.s.events.push({ time: this.s.clock, kind, message, orderId });
    if (this.s.events.length > MAX_EVENTS) this.s.events.splice(0, this.s.events.length - MAX_EVENTS);
  }

  /** Append an informational line to the event log. */
  logInfo(message: string): void {
    this.log('info', message);
  }

  private touch(): void {
    this.s.version += 1;
  }

  // ---------------------------------------------------------------- account

  position(symbol: string): Position {
    return this.s.positions[symbol] ?? { symbol, quantity: 0, avgPrice: 0, realizedPnl: 0 };
  }

  openPositions(): Position[] {
    return Object.values(this.s.positions).filter((p) => p.quantity !== 0);
  }

  workingOrders(symbol?: string): Order[] {
    return this.liveOrders().filter((o) => isOpen(o) && (!symbol || o.symbol === symbol));
  }

  markPrice(symbol: string): number | undefined {
    return this.s.lastPrice[symbol];
  }

  account(): AccountSnapshot {
    let longMV = 0;
    let shortMV = 0;
    let unrealized = 0;
    for (const p of Object.values(this.s.positions)) {
      if (p.quantity === 0) continue;
      const px = this.s.lastPrice[p.symbol] ?? p.avgPrice;
      if (p.quantity > 0) longMV += p.quantity * px;
      else shortMV += p.quantity * px; // negative
      unrealized += (px - p.avgPrice) * p.quantity;
    }
    const equity = this.s.cash + longMV + shortMV;
    const gross = longMV - shortMV;
    const buyingPower = Math.max(0, equity * this.cfg.marginMultiplier - gross);
    return {
      startingBalance: this.s.startingBalance,
      cash: money(this.s.cash),
      equity: money(equity),
      buyingPower: money(buyingPower),
      longMarketValue: money(longMV),
      shortMarketValue: money(shortMV),
      unrealizedPnl: money(unrealized),
      realizedPnl: money(this.s.realizedPnl),
      dayPnl: money(equity - this.s.dayStartEquity),
      commissionsPaid: money(this.s.commissionsPaid),
    };
  }

  /** Buying power not already committed to working opening orders. */
  availableBuyingPower(): number {
    const acct = this.account();
    let reserved = 0;
    for (const o of this.workingOrders()) if (isOpeningAction(o.action)) reserved += this.reservation(o);
    return Math.max(0, acct.buyingPower - reserved);
  }

  /** The buying power a working opening order holds back: its unfilled shares at its price. */
  private reservation(o: Order): number {
    return (o.quantity - o.filledQty) * (o.limitPrice ?? o.stopPrice ?? this.s.lastPrice[o.symbol] ?? 0);
  }

  /**
   * The most shares of an opening order the buying-power check accepts now: what is available at the
   * price it checks (a limit's or stop-limit's limit, otherwise where the order is expected to fill).
   */
  affordableQuantity(o: Pick<OrderRequest, 'symbol' | 'action' | 'type' | 'limitPrice' | 'stopPrice' | 'extendedHours'>, now?: UnixSeconds): number {
    const symbol = o.symbol.toUpperCase();
    if (this.s.lastPrice[symbol] === undefined) return 0;
    const px = o.type === 'limit' || o.type === 'stop_limit' ? o.limitPrice : this.expectedEntry({ ...o, symbol, extendedHours: !!o.extendedHours }, Math.max(now ?? this.s.clock, this.s.clock)).price;
    return px && px > 0 ? Math.max(0, Math.floor((this.availableBuyingPower() + 0.005) / px)) : 0;
  }

  /**
   * The stop loss and target a working entry's unfilled shares will get once it fills at `px` (by
   * default its own price): once it has started filling, those of its live bracket, which take its
   * later shares wherever they have been moved, else its own. A bracket stop that has fired, or sits at
   * or past `px` (moved to breakeven), closes the held shares before price can reach the entry again,
   * and the later shares then get the entry's own.
   */
  private bracketLevels(o: Order, px = this.entryPrice(o)): { stopLoss?: number; takeProfit?: number } {
    let { stopLoss, takeProfit } = o;
    if (o.filledQty > 0) {
      const dir = o.action === 'buy' ? 1 : -1;
      for (const c of this.workingOrders(o.symbol)) {
        if (c.parentId !== o.id) continue;
        if (c.type === 'stop' || c.type === 'stop_limit') {
          if (!c.triggered && (px - c.stopPrice!) * dir > 0) stopLoss = c.stopPrice;
        } else if (c.type === 'limit' && (c.limitPrice! - px) * dir > 0) takeProfit = c.limitPrice;
      }
    }
    return { stopLoss, takeProfit };
  }

  /** The price a working entry's unfilled shares are counted at: its limit, else its stop, else the last price. */
  private entryPrice(o: Pick<Order, 'symbol' | 'limitPrice' | 'stopPrice'>): number {
    return o.limitPrice ?? o.stopPrice ?? this.s.lastPrice[o.symbol] ?? 0;
  }

  /**
   * Where a working entry's unfilled shares are expected to fill (estimateFill; a stop that has fired
   * waits as a market order), and of that and where it would fill if it were through the market now,
   * the price nearer the trade's stop (`dir` 1 for a long).
   */
  private workingFill(o: Order, dir: number): { px: number; near: number } {
    const req = { ...o, quantity: o.quantity - o.filledQty, ...(o.type === 'stop' && o.triggered ? { type: 'market' as const } : {}) };
    const px = this.estimateFill(req) ?? this.entryPrice(o);
    return { px, near: Math.min(px * dir, this.expectedEntry(req).price * dir) * dir };
  }

  /**
   * The trade an opening order on `action`'s side of `symbol` would join: the shares held that way and
   * their open trade, the other working entries on that side (all but `excludeId`, in the order they
   * were placed) with where each is expected to fill, and the trade's first stop (see tradeRisk).
   */
  private tradeOf(symbol: string, action: OrderAction, excludeId?: string, ownStop?: number) {
    const dir = action === 'buy' ? 1 : -1;
    const pos = this.position(symbol);
    const held = pos.quantity * dir > 0 ? Math.abs(pos.quantity) : 0;
    const trip = held > 0 ? this.s.roundTrips.find((t) => t.symbol === symbol && !t.closed) : undefined;
    const entries = this.workingOrders(symbol)
      .filter((o) => o.action === action && o.id !== excludeId)
      .map((order) => ({ order, n: order.quantity - order.filledQty, ...this.workingFill(order, dir) }));
    // Until the trade has a first stop, the one its entries share; the furthest, if they differ.
    const stops = [...entries.map((e) => e.order.stopLoss), ownStop].filter((x): x is number => x !== undefined);
    const stop = trip?.initialStop ?? (stops.length ? stops.reduce((a, b) => ((b - a) * dir < 0 ? b : a)) : undefined);
    return { dir, pos, held, trip, entries, stops, stop, fromTrip: trip?.initialStop !== undefined };
  }

  /**
   * The risk of the trade an opening order joins, as Strict Mode and Size by risk count it: from the
   * trade's first stop (the open trade's, or until it has one, the stop loss its entries share), the
   * larger of
   * - the trade review's measure, which its risk rule and the challenges use: every share from the first
   *   stop over the trade's largest size, at its worst over which of the working entries fill, in part
   *   or in full (one cheap entry that fills can make room that it takes back if it does not); and
   * - what the trade would lose if its stops fired at the first stop: what it has made or lost so far,
   *   the held shares from their cost, the working entries from where they are expected to fill;
   * plus commissions in and out on the order itself, as a share of the equity the trade started with
   * (today's, while it has not). `o.quantity` is the order's unfilled shares, expected to fill at
   * `o.fillAt`; `own` is the working order it changes. Null when nothing in the trade has a stop.
   */
  tradeRiskOf(o: { symbol: string; action: OrderAction; quantity: number; fillAt: number; stopLoss?: number }, own?: Order): TradeRisk | null {
    const t = this.tradeOf(o.symbol, o.action, own?.id, o.stopLoss);
    if (t.stop === undefined) return null;
    const S = t.stop;
    const d = (px: number) => (px - S) * t.dir;
    const adds = [...t.entries.map((e) => ({ n: e.n, d: d(e.px) })), ...(o.quantity > 0 ? [{ n: o.quantity, d: d(o.fillAt) }] : [])];
    const Q0 = t.trip?.entryQtyTotal ?? 0;
    const D0 = t.trip ? Q0 * d(t.trip.avgEntry) : 0;
    const M0 = t.trip?.maxQuantity ?? 0;
    const N = adds.reduce((a, x) => a + x.n, 0);
    const equity = t.trip ? equityBeforeEntry(t.trip, this.s.fills, this.s.equityCurve, this.s.startingBalance) : this.account().equity;
    const base = { stop: S, equity, held: t.held, working: N - Math.max(0, o.quantity) };
    if (Q0 > 0 && D0 <= EPS) return { ...base, pct: Infinity, dollars: Infinity, by: 'review', unmeasurable: true };
    // Every fill set's average is at most the best greedy one, and with everything filled the size
    // and the total distance are both largest.
    let gD = D0;
    let gQ = Q0;
    for (const x of [...adds].sort((a, b) => b.d - a.d)) {
      if (gQ > 0 && x.d <= gD / gQ) break;
      gD += x.n * x.d;
      gQ += x.n;
    }
    const atPeak = gQ > 0 ? (M0 * gD) / gQ : 0;
    const atAll = Q0 + N > 0 ? ((t.held + N) * (D0 + adds.reduce((a, x) => a + x.n * x.d, 0))) / (Q0 + N) : 0;
    const review = Math.max(atPeak, atAll);
    const loss = -(t.trip?.pnl ?? 0) + t.held * d(t.pos.avgPrice) + adds.reduce((a, x) => a + x.n * x.d, 0);
    const commission = o.quantity > 0 ? 2 * commissionFor(this.cfg, o.quantity, o.fillAt) : 0;
    const dollars = Math.max(review, loss) + commission;
    const by = loss > review + EPS ? 'loss' : 'review';
    const peak = by === 'review' && M0 > t.held + N && atPeak >= atAll - EPS ? M0 : undefined;
    return { ...base, pct: equity > 0 ? (dollars / equity) * 100 : Infinity, dollars, by, unmeasurable: false, ...(peak ? { peak } : {}) };
  }

  /**
   * Whether today's loss has reached Strict Mode's daily limit: now, or at any earlier moment since the
   * session began once every bar ending then had closed, so the limit holds until the next session
   * even if open trades recover. While a bar fills, "now" is the last such moment plus that bar's own
   * fills, with the shares they opened worth what was paid: other symbols' bars ending at the same
   * time, processed before it, are not counted yet.
   */
  private dailyLimitReached(): boolean {
    const start = this.s.dayStartEquity;
    const now = this.account().equity + (this.bar ? this.bar.offset + this.bar.adj : 0);
    const low = Math.min(now, this.s.dayLowEquity ?? Infinity);
    return start > 0 && (money(start - low) / start) * 100 >= this.cfg.strictRisk.maxDailyLossPct - EPS;
  }

  /**
   * Why Strict Mode refuses an opening order, placed or changed (`own` is the working order changed;
   * `o.quantity` its unfilled shares), or null. In order: the daily loss limit; stops (this order's,
   * and every share already in the trade); entries that share one stop until the trade has a first
   * stop; nothing at or past the first stop; the trade's risk from it (tradeRiskOf); the position size.
   */
  private strictViolation(
    o: Pick<Order, 'symbol' | 'action' | 'type' | 'limitPrice' | 'stopPrice' | 'stopLoss' | 'extendedHours'> & { quantity: number },
    own: Order | undefined,
    fillAt: number,
    nearAt: number,
    positionValue: number,
  ): string | null {
    const cfg = this.cfg.strictRisk;
    const L = cfg.maxRiskPctPerTrade;
    if (this.dailyLimitReached()) {
      return own
        ? `Strict risk: daily loss limit of ${cfg.maxDailyLossPct}% reached, so working entries can't be changed until the next session. You can still cancel this one.`
        : `Strict risk: daily loss limit of ${cfg.maxDailyLossPct}% reached. No new entries or adds until the next session.`;
    }
    const t = this.tradeOf(o.symbol, o.action, own?.id, o.stopLoss);
    const long = t.dir === 1;
    const below = long ? 'below' : 'above';
    const exitWord = long ? 'Sell' : 'Cover';
    const sym = o.symbol;
    if (cfg.requireStopLoss) {
      if (o.stopLoss === undefined) return 'Strict risk: a valid stop loss is required.';
      // A stop-limit protects only if its limit lets it fill once price passes its stop.
      let covered = 0;
      for (const x of this.workingOrders(sym)) {
        if (x.action !== (long ? 'sell' : 'cover') || (x.type !== 'stop' && x.type !== 'stop_limit')) continue;
        if (x.type === 'stop_limit' && (x.triggered || (x.stopPrice! - x.limitPrice!) * t.dir < 0)) continue;
        covered += x.quantity - x.filledQty;
      }
      if (covered < t.held) {
        const at = t.stop !== undefined && t.fromTrip ? ` (at ${formatTick(t.stop)} or ${long ? 'higher' : 'lower'})` : '';
        const n = t.held - covered;
        const which = n === t.held ? `your ${shares(n, sym)}` : `${n} of your ${shares(t.held, sym)}`;
        return `Strict risk: ${which} ${n === 1 ? 'has' : 'have'} no stop. Place a ${exitWord} stop for ${n === 1 ? 'it' : 'them'}${at} before adding.`;
      }
      const bare = t.entries.find((e) => e.order.stopLoss === undefined);
      if (bare) return `Strict risk: your working ${describe(bare.order)} has no stop loss. Cancel it and place it again with one first.`;
    }
    if (!t.fromTrip && new Set(t.stops).size > 1) {
      const until = t.held ? `until the ${sym} trade has a first stop` : `with no ${sym} position yet`;
      const lead = `Strict risk: ${until}, ${long ? 'Buy' : 'Short'} entries working together must share one stop loss, so the trade's risk is measured from it whichever fills first.`;
      const stopped = t.entries.filter((e) => e.order.stopLoss !== undefined);
      const a = stopped[0];
      const b = stopped.find((e) => e.order.stopLoss !== a.order.stopLoss);
      if (b) {
        return `${lead} Your working ${describe(a.order)} and ${describe(b.order)} have different stops (${formatTick(a.order.stopLoss!)} and ${formatTick(b.order.stopLoss!)}): cancel one of them first.`;
      }
      return `${lead} Your working ${describe(a.order)} has its stop at ${formatTick(a.order.stopLoss!)}: use ${formatTick(a.order.stopLoss!)} here too, or cancel that order.`;
    }
    if (t.stop !== undefined) {
      const S = t.stop;
      const past = (px: number) => (px - S) * t.dir <= EPS;
      const wider = (stop: number | undefined) => stop !== undefined && (S - stop) * t.dir > EPS;
      if (past(nearAt)) {
        return `Strict risk: this order would fill at about ${formatTick(nearAt)}, at or ${below} the trade's first stop at ${formatTick(S)}, which would add past that stop. To re-enter after a stop-out, place the order once the trade has closed.`;
      }
      if (wider(o.stopLoss)) {
        return `Strict risk: this order's stop at ${formatTick(o.stopLoss!)} is ${below} the trade's first stop at ${formatTick(S)}. Every share is measured from ${formatTick(S)}, so use a stop at ${formatTick(S)} or ${long ? 'higher' : 'lower'}.`;
      }
      const stale = t.entries.find((e) => past(e.near) || wider(e.order.stopLoss));
      if (stale) {
        const what = past(stale.near) ? `would fill at or ${below} the trade's first stop at ${formatTick(S)}` : `has its stop ${below} the trade's first stop at ${formatTick(S)}`;
        return `Strict risk: your working ${describe(stale.order)} ${what}, and Strict Mode measures every share from that stop. Cancel it first.`;
      }
      const risk = this.tradeRiskOf({ symbol: sym, action: o.action, quantity: o.quantity, fillAt, stopLoss: o.stopLoss }, own)!;
      if (risk.unmeasurable) {
        if (t.fromTrip) return `Strict risk: the trade's average entry is at or ${below} its first stop at ${formatTick(S)}, so its risk can't be measured. No adds to this trade.`;
        // No first stop yet: S is the one this order (and its working entries) would give the trade.
        const A = formatTick(t.trip!.avgEntry);
        const whose = o.stopLoss !== undefined ? "this order's stop" : 'the stop your working entries share';
        const shared = o.stopLoss !== undefined && t.entries.some((e) => e.order.stopLoss !== undefined);
        const fix = o.stopLoss !== undefined ? `Use a stop ${below} ${A}${shared ? ' here and on your working entries' : ''}.` : `Change their stop to one ${below} ${A}.`;
        return `Strict risk: ${whose} at ${formatTick(S)} is at or ${long ? 'above' : 'below'} the trade's average entry of ${A}, so it would lock in a gain rather than cap a loss, and the trade's risk can't be measured. ${fix}`;
      }
      if (risk.pct > L + EPS) {
        if (!risk.held && !risk.working) return `Strict risk: this trade risks ${over(risk.pct, L, 2)}% (limit ${L}%).`;
        const parts = [risk.held ? `the ${shares(risk.held)} you hold` : '', risk.working ? `${shares(risk.working)} in working entries` : ''].filter(Boolean).join(' and ');
        if (risk.by === 'loss') {
          return `Strict risk: with this order the ${sym} trade would lose ${over(risk.pct, L, 2)}% if its stops fired at its first stop at ${formatTick(S)}, counting ${parts} and what the trade has already made or lost (limit ${L}%).`;
        }
        const raised = this.workingOrders(sym).some((x) => x.action === (long ? 'sell' : 'cover') && (x.type === 'stop' || x.type === 'stop_limit') && (x.stopPrice! - S) * t.dir > EPS);
        const tighter = o.stopLoss !== undefined && (o.stopLoss - S) * t.dir > EPS;
        const why = tighter ? `This order's tighter stop at ${formatTick(o.stopLoss!)}` : raised ? `${long ? 'Raising' : 'Lowering'} your stop` : '';
        const unchanged = why ? ` ${why} does not change this: the review counts every share from the first stop.` : '';
        if (risk.peak && t.trip) {
          // Sold down since its largest size: the review still counts that many shares, from the trade's average entry.
          const raises = (fillAt - t.trip.avgEntry) * t.dir > EPS;
          return `Strict risk: with this order the ${sym} trade would risk ${over(risk.pct, L, 2)}% (limit ${L}%). The trade review counts the trade at its largest size, ${shares(risk.peak)} (you hold ${shares(risk.held)} now), from its average entry to its first stop at ${formatTick(S)}${raises ? `, and this order ${long ? 'raises' : 'lowers'} that average` : ''}.${unchanged}`;
        }
        return `Strict risk: with this order the ${sym} trade would risk ${over(risk.pct, L, 2)}% (limit ${L}%), counting ${parts}, every share from the trade's first stop at ${formatTick(S)}, as the trade review counts it.${unchanged}`;
      }
    }
    // The position: the shares held that way at the last price, the working entries at their prices.
    const value = t.held * (this.s.lastPrice[sym] ?? 0) + t.entries.reduce((a, e) => a + e.n * this.entryPrice(e.order), 0) + positionValue;
    const equity = this.account().equity;
    const valuePct = equity > 0 ? (value / equity) * 100 : Infinity;
    if (valuePct > cfg.maxPositionPctOfEquity + EPS) {
      const n = t.held + t.entries.reduce((a, e) => a + e.n, 0);
      return `Strict risk: position is ${over(valuePct, cfg.maxPositionPctOfEquity, 0)}% of equity${n ? ` with the ${shares(n, sym)} you already hold or have working` : ''} (limit ${cfg.maxPositionPctOfEquity}%).`;
    }
    return null;
  }

  /**
   * A bracket error, saying where the entry was checked when that is not the order's own price: near
   * the last price for an order already through the market, or a stop-limit's stop.
   */
  private bracketMessage(
    o: Pick<Order, 'type' | 'limitPrice' | 'extendedHours'>,
    expected: ReturnType<SimBroker['expectedEntry']>,
    error: string,
  ): string {
    if (expected.through) {
      const fill = expected.atOnce ? this.cfg.marketOrderFill : o.type === 'limit' && o.extendedHours && this.cfg.allowExtendedHours ? 'next' : 'regular';
      return throughTheMarket(error, o.type, expected.price, fill);
    }
    if (o.type === 'stop_limit' && expected.price !== o.limitPrice) return `${error.replace(/\.$/, '')}: this stop-limit would fill at about ${formatTick(expected.price)}, where its stop fires.`;
    return error;
  }

  /**
   * What submit would say is wrong with an opening order's stop loss or target, checked where the order
   * is expected to fill (the ticket shows these before submit). Empty when they are fine, or when the
   * order is not complete enough to check.
   */
  bracketErrors(input: OrderRequest, now?: UnixSeconds): string[] {
    return this.at(now, (b) => {
      const p = b.prepare(input);
      if ('error' in p || !isOpeningAction(p.req.action)) return [];
      const o = { ...p.req, extendedHours: !!p.req.extendedHours };
      const expected = b.expectedEntry(o);
      const { errors } = assessRisk({ action: o.action, quantity: o.quantity, entryPrice: expected.price, stopLoss: o.stopLoss, takeProfit: o.takeProfit, equity: 0 });
      return errors.map((e) => b.bracketMessage(o, expected, e));
    });
  }

  /**
   * The checks an opening order must pass when it is placed or changed: its stop loss and target on the
   * right side of where it is expected to fill, Strict Mode (strictViolation), and buying power. `own`
   * is the working order being changed: it is left out of the trade it joins, and the buying power it
   * holds back is available to it. `o.quantity` is its unfilled shares.
   */
  private openingCheck(
    o: Pick<Order, 'symbol' | 'action' | 'type' | 'limitPrice' | 'stopPrice' | 'stopLoss' | 'takeProfit' | 'extendedHours'> & { quantity: number },
    own?: Order,
  ): { error?: string; warnings: string[]; quote: number; price: number } {
    // Orders are checked against the price they would actually get: buys pay the ask, sells hit the bid.
    const expected = this.expectedEntry(o);
    const refPrice = expected.price;
    const fail = (error: string) => ({ error, warnings: [], quote: expected.quote, price: refPrice });
    const acct = this.account();
    const assess = (px: number) =>
      assessRisk({ action: o.action, quantity: o.quantity, entryPrice: px, stopLoss: o.stopLoss, takeProfit: o.takeProfit, equity: acct.equity, commissionEstimate: commissionFor(this.cfg, o.quantity, px) });
    const risk = assess(refPrice);
    if (risk.errors.length) return fail(this.bracketMessage(o, expected, risk.errors[0]));
    // The risk itself is measured at the price the order is expected to fill at with its costs, as
    // the ticket sizes it and the review judges it.
    const fillAt = this.estimateFill(o) ?? refPrice;
    const costed = fillAt === refPrice ? risk : assess(fillAt);
    if (this.cfg.strictRisk.enabled) {
      const dir = o.action === 'buy' ? 1 : -1;
      const violation = this.strictViolation(o, own, fillAt, Math.min(fillAt * dir, refPrice * dir) * dir, o.type === 'stop_limit' ? o.quantity * o.limitPrice! : risk.positionValue);
      if (violation) return fail(violation);
    }
    // A limit (or a stop-limit once its stop fires) may still fill anywhere up to its limit.
    const needed = o.quantity * (o.type === 'limit' || o.type === 'stop_limit' ? o.limitPrice! : refPrice);
    const avail = this.availableBuyingPower() + (own ? this.reservation(own) : 0);
    if (needed > avail + 0.005) return fail(`Insufficient buying power: need $${needed.toFixed(2)}, have $${avail.toFixed(2)}.`);
    return { warnings: costed.warnings, quote: expected.quote, price: refPrice };
  }

  /**
   * Runs `fn` on this broker, or when `now` (the replay's or simulated market's time) is ahead of its
   * clock, on a copy brought up to it as submit brings the clock up first (yesterday's DAY orders
   * expire, the day's loss starts again), so a dry run sees what placing the order would.
   */
  private at<T>(now: UnixSeconds | undefined, fn: (b: SimBroker) => T): T {
    if (now === undefined || !(now > this.s.clock)) return fn(this);
    const f = this.fork(this.checkpoint());
    f.syncClock(now);
    return fn(f);
  }

  /**
   * The risk of the trade a new opening order would join with `input.quantity` shares (tradeRiskOf),
   * for the ticket. Null without a price, a stop anywhere in the trade, or a valid order.
   */
  tradeRisk(input: OrderRequest, now?: UnixSeconds): TradeRisk | null {
    return this.at(now, (b) => {
      const p = b.prepare(input);
      if ('error' in p || !isOpeningAction(p.req.action)) return null;
      const fillAt = b.estimateFill(p.req);
      return fillAt === null ? null : b.tradeRiskOf({ ...p.req, fillAt });
    });
  }

  /**
   * Size by risk: the most shares of a new opening order whose trade risks at most `riskPct`% as
   * tradeRiskOf counts it, cut to what submit would accept (Strict Mode's other limits, buying power)
   * and, for a market or stop order (which has no limit), to the buying power left with room for the
   * price to move before it fills. `reason` says what cut it below the asked risk, as a sentence.
   */
  sizeByRisk(
    input: Omit<OrderRequest, 'quantity'>,
    riskPct: number,
    now?: UnixSeconds,
  ): { ok: false; error: string } | { ok: true; quantity: number; risk: TradeRisk; needed: number; reason?: string } {
    return this.at(now, (b) => {
      const p = b.prepare({ ...input, quantity: 1 });
      if ('error' in p) return { ok: false as const, error: p.error };
      const req = { ...p.req, extendedHours: !!p.req.extendedHours };
      if (!isOpeningAction(req.action)) return { ok: false as const, error: 'Size by risk sizes Buy and Short orders.' };
      const sized = (n: number) => ({ ...req, quantity: n });
      const riskAt = (n: number) => {
        const fillAt = b.estimateFill(sized(n));
        return fillAt === null ? null : b.tradeRiskOf({ ...sized(n), fillAt });
      };
      const one = riskAt(1);
      if (!one) return { ok: false as const, error: 'Set a stop loss first. Position size = risk ÷ stop distance.' };
      const joined = one.held + one.working > 0;
      const S = formatTick(one.stop);
      const dir = req.action === 'buy' ? 1 : -1;
      const fill1 = b.estimateFill(sized(1))!;
      if ((fill1 - one.stop) * dir <= EPS) {
        return { ok: false as const, error: joined ? `This order is at or past the trade's first stop at ${S}, so it has no risk budget to size from.` : 'The stop loss is on the wrong side of the entry.' };
      }
      if (one.unmeasurable) return { ok: false as const, error: `The trade's average entry is at or past its first stop at ${S}, so its risk can't be measured.` };
      if (one.pct > riskPct + EPS) {
        return {
          ok: false as const,
          error: joined
            ? `With even one more share the ${req.symbol} trade would risk ${over(one.pct, riskPct, 2)}% from its first stop at ${S}${one.peak ? `, counted at its largest size of ${shares(one.peak)} as the trade review counts it` : ''}, more than the ${riskPct}% asked.`
            : `Even one share would risk more than ${riskPct}% of the account at this stop${2 * commissionFor(b.cfg, 1, fill1) > 0 ? ', with commissions in and out' : ''}.`,
        };
      }
      // Both searches keep the smaller end passing, so the size found always passes.
      const largest = (ok: (n: number) => boolean, cap = 1e9): number => {
        let lo = 1;
        let hi = 2;
        while (hi <= cap && ok(hi)) {
          lo = hi;
          hi *= 2;
        }
        hi = Math.min(hi, cap + 1);
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          if (ok(mid)) lo = mid;
          else hi = mid;
        }
        return lo;
      };
      const needed = largest((n) => (riskAt(n)?.pct ?? Infinity) <= riskPct + EPS);
      const refusal = (n: number) => b.openingCheck(sized(n)).error;
      const first = refusal(1);
      if (first) return { ok: false as const, error: first };
      const accepted = largest((n) => !refusal(n), needed);
      let quantity = accepted;
      let reason: string | undefined;
      if (accepted < needed) {
        const why = refusal(accepted + 1)!;
        reason = why.startsWith('Strict risk: ') ? `Strict Mode refuses ${accepted + 1}: ${why.slice('Strict risk: '.length)}` : `${accepted + 1} would be refused: ${why}`;
      }
      // A market or stop order can fill above the price buying power was checked at; a limit never does.
      if (req.type === 'market' || req.type === 'stop') {
        const covered = Math.floor(b.affordableQuantity(req) * 0.995);
        if (covered < 1) return { ok: false as const, error: 'No buying power is left for this order.' };
        if (covered < quantity) {
          quantity = covered;
          reason = `Your available buying power covers ${covered}, with room for the price to move before it fills.`;
        }
      }
      return { ok: true as const, quantity, risk: riskAt(quantity)!, needed, reason };
    });
  }

  // ---------------------------------------------------------------- orders

  /**
   * Submit's checks of the request itself, before any account limit: prices to the tick (a price the
   * order type does not use, such as a limit price on a stop order, is dropped, so it cannot pass for
   * its entry), a whole number of shares, the prices its type needs, extended hours, a price to trade
   * at, and the action against the position (Buy/Sell for a long, Short/Cover for a short).
   */
  private prepare(input: OrderRequest): { req: OrderRequest } | { error: string } {
    const tick = (v: number | undefined) => (v === undefined || !Number.isFinite(v) || v <= 0 ? undefined : roundToTick(v));
    const symbol = input.symbol.toUpperCase();
    const req: OrderRequest = {
      ...input,
      symbol,
      limitPrice: input.type === 'limit' || input.type === 'stop_limit' ? tick(input.limitPrice) : undefined,
      stopPrice: input.type === 'stop' || input.type === 'stop_limit' ? tick(input.stopPrice) : undefined,
      stopLoss: tick(input.stopLoss),
      takeProfit: tick(input.takeProfit),
    };
    const error = (e: string) => ({ error: e });
    const qty = req.quantity;
    if (!Number.isFinite(qty) || qty <= 0 || Math.floor(qty) !== qty) return error('Quantity must be a whole number of shares greater than 0.');
    if ((req.type === 'limit' || req.type === 'stop_limit') && !(req.limitPrice && req.limitPrice > 0)) return error('Limit price is required.');
    if ((req.type === 'stop' || req.type === 'stop_limit') && !(req.stopPrice && req.stopPrice > 0)) return error('Stop price is required.');
    if (req.extendedHours && req.type !== 'limit') return error('Only limit orders can be routed to extended hours.');
    if (req.extendedHours && !this.cfg.allowExtendedHours) return error('Extended-hours trading is disabled in Settings.');
    if (this.s.lastPrice[symbol] === undefined) return error('No price yet for this symbol. Start the replay first.');

    // Action legality mirrors a real broker's buy/sell vs short/cover distinction.
    const pos = this.position(symbol);
    switch (req.action) {
      case 'buy':
        if (pos.quantity < 0) return error(`You are short ${-pos.quantity} ${symbol}. Use Cover to buy back a short.`);
        break;
      case 'short':
        if (!this.cfg.allowShortSelling) return error('Short selling is disabled in Settings.');
        if (this.cfg.marginMultiplier < 1.5) return error('Short selling requires a margin account (set margin to 2x or more in Settings).');
        if (pos.quantity > 0) return error(`You are long ${pos.quantity} ${symbol}. Sell the long before shorting.`);
        break;
      case 'sell': {
        if (pos.quantity <= 0) return error(`No long position in ${symbol} to sell. Use Short to open a short.`);
        const avail = pos.quantity - this.committedExitQty(symbol, 'sell');
        if (qty > avail + EPS) return error(`Only ${Math.max(0, avail)} shares available to sell (others are committed to open orders).`);
        break;
      }
      case 'cover': {
        if (pos.quantity >= 0) return error(`No short position in ${symbol} to cover.`);
        const avail = -pos.quantity - this.committedExitQty(symbol, 'cover');
        if (qty > avail + EPS) return error(`Only ${Math.max(0, avail)} shares available to cover (others are committed to open orders).`);
        break;
      }
    }
    return { req };
  }

  /**
   * Under Strict Mode, why a protective stop at `stopPrice` (a Sell stop for a long, a Cover stop for a
   * short) can't be placed, or moved from `from`: past the open trade's first stop, and further from
   * the trade than it was. Tightening, and moving back toward the first stop, are always allowed.
   */
  private exitStopViolation(symbol: string, action: OrderAction, stopPrice: number, from?: number): string | null {
    if (!this.cfg.strictRisk.enabled) return null;
    const dir = action === 'sell' ? 1 : -1;
    if (this.position(symbol).quantity * dir <= 0) return null;
    const S = this.s.roundTrips.find((t) => t.symbol === symbol && !t.closed)?.initialStop;
    if (S === undefined || (S - stopPrice) * dir <= EPS || (from !== undefined && (from - stopPrice) * dir <= EPS)) return null;
    return `Strict risk: a stop on this trade can't go ${dir === 1 ? 'below' : 'above'} its first stop at ${formatTick(S)} (anything from ${formatTick(S)} ${dir === 1 ? 'up' : 'down'} is fine).`;
  }

  submit(input: OrderRequest): SubmitResult {
    const warnings: string[] = [];
    const reject = (error: string): SubmitResult => {
      this.log('rejected', `${input.action.toUpperCase()} ${input.quantity} ${input.symbol}: ${error}`);
      this.touch();
      return { ok: false, error, warnings };
    };
    const prepared = this.prepare(input);
    if ('error' in prepared) return reject(prepared.error);
    const req = prepared.req;
    const symbol = req.symbol;
    const qty = req.quantity;
    if ((req.action === 'sell' || req.action === 'cover') && (req.type === 'stop' || req.type === 'stop_limit')) {
      const violation = this.exitStopViolation(symbol, req.action, req.stopPrice!);
      if (violation) return reject(violation);
    }

    const opening = isOpeningAction(req.action);
    let quote = this.expectedEntry({ ...req, symbol, extendedHours: !!req.extendedHours }).quote;
    let checkedAt: number | undefined;
    if (opening) {
      const check = this.openingCheck({ ...req, symbol, quantity: qty, extendedHours: !!req.extendedHours });
      if (check.error) return reject(check.error);
      warnings.push(...check.warnings);
      quote = check.quote;
      checkedAt = check.price;
    } else if (req.stopLoss || req.takeProfit) {
      return reject('Stop loss / take profit brackets can only be attached to opening orders (Buy or Short).');
    }

    const now = this.s.clock;
    const order: Order = {
      id: this.nextId('o'),
      symbol,
      action: req.action,
      type: req.type,
      quantity: qty,
      limitPrice: req.limitPrice,
      stopPrice: req.stopPrice,
      tif: req.tif ?? 'day',
      extendedHours: !!req.extendedHours,
      stopLoss: req.stopLoss,
      takeProfit: req.takeProfit,
      tag: req.tag,
      status: 'working',
      filledQty: 0,
      avgFillPrice: 0,
      createdAt: now,
      updatedAt: now,
      triggered: false,
      sessionDate: this.orderSessionDate(now),
      activeFrom: now,
      ...(checkedAt !== undefined ? { quotedPrice: checkedAt } : req.type === 'market' ? { quotedPrice: quote } : {}),
    };
    if (!this.eligible(order, this.symbolSession(symbol))) {
      order.status = 'pending';
      const hours = marketSession(now);
      warnings.push(
        hours === 'regular'
          ? `${symbol} has not traded yet in this regular session: the order works from its first bar, on prices after this moment, never at an earlier close.`
          : !this.eligible(order, 'pre')
            ? 'Market is not in regular hours. The order will work from the next regular session.'
            : hours === 'closed'
              ? 'The market is closed: the order works from the first bar of the next session, pre-market included.'
              : `${symbol} has not traded yet in this session: the order works from its first bar.`,
      );
    }
    this.s.orders.push(order);
    this.log('accepted', `${describe(order)} accepted`, order.id);

    const notes: string[] = [];
    if (this.cfg.marketOrderFill === 'last_price' && order.status === 'working' && this.tryImmediate(order) === 'capped' && order.type === 'market') {
      notes.push(`Fills are capped at ${Math.round(this.cfg.maxParticipation * 100)}% of a bar's volume (Data & Settings), so the rest fills from the next bars.`);
    }
    this.touch();
    return { ok: true, order: { ...order }, warnings, ...(notes.length ? { notes } : {}) };
  }

  cancel(orderId: string, reason = 'Cancelled by user'): boolean {
    const o = this.openOrderById(orderId);
    if (!o) return false;
    o.status = 'cancelled';
    o.rejectReason = reason;
    o.updatedAt = this.s.clock;
    this.log('cancelled', `${describe(o)} cancelled: ${reason}`, o.id);
    this.touch();
    return true;
  }

  cancelAll(symbol?: string): number {
    let n = 0;
    for (const o of this.workingOrders(symbol)) if (this.cancel(o.id)) n++;
    return n;
  }

  /** Modify price/qty of a working order (like dragging an order line). */
  modify(orderId: string, changes: { limitPrice?: number; stopPrice?: number; quantity?: number }): { ok: boolean; error?: string } {
    const o = this.openOrderById(orderId);
    if (!o) return { ok: false, error: 'Order is not open.' };
    if (changes.quantity !== undefined && (changes.quantity < o.filledQty + 1 || Math.floor(changes.quantity) !== changes.quantity)) {
      return { ok: false, error: 'Quantity must be a whole number above the filled quantity.' };
    }
    if (changes.limitPrice !== undefined && (!(changes.limitPrice > 0) || (o.type !== 'limit' && o.type !== 'stop_limit'))) return { ok: false, error: 'Invalid limit price.' };
    if (changes.stopPrice !== undefined && (!(changes.stopPrice > 0) || (o.type !== 'stop' && o.type !== 'stop_limit'))) return { ok: false, error: 'Invalid stop price.' };
    if (changes.stopPrice !== undefined && o.triggered) return { ok: false, error: 'The stop has already triggered, so its price no longer applies.' };
    const limitPrice = changes.limitPrice !== undefined ? roundToTick(changes.limitPrice) : o.limitPrice;
    const stopPrice = changes.stopPrice !== undefined ? roundToTick(changes.stopPrice) : o.stopPrice;
    // A changed entry is checked as if it were placed now: its stop loss and target against where it
    // now fills, Strict Mode and buying power. Fewer shares at the same prices put nothing new at risk
    // (Strict Mode counts the trade at its worst over which entries fill), so an entry can always be
    // cut back, even once price has moved past its stop loss.
    const cutOnly = limitPrice === o.limitPrice && stopPrice === o.stopPrice && (changes.quantity ?? o.quantity) <= o.quantity;
    if (isOpeningAction(o.action)) {
      if (!cutOnly) {
        // Its unfilled shares take the live bracket's stop and target once it has started filling.
        const px = this.entryPrice({ symbol: o.symbol, limitPrice, stopPrice });
        const next = { ...o, ...this.bracketLevels(o, px), limitPrice, stopPrice, quantity: (changes.quantity ?? o.quantity) - o.filledQty };
        const { error, price } = this.openingCheck(next, o);
        if (error) return { ok: false, error };
        o.quotedPrice = price;
      }
    } else if (stopPrice !== undefined && stopPrice !== o.stopPrice) {
      const violation = this.exitStopViolation(o.symbol, o.action, stopPrice, o.stopPrice);
      if (violation) return { ok: false, error: violation };
    }
    o.limitPrice = limitPrice;
    o.stopPrice = stopPrice;
    if (changes.quantity !== undefined) o.quantity = changes.quantity;
    o.updatedAt = this.s.clock;
    o.activeFrom = this.s.clock;
    this.log('info', `${describe(o)} modified`, o.id);
    if (this.cfg.marketOrderFill === 'last_price' && o.status === 'working') this.tryImmediate(o);
    this.touch();
    return { ok: true };
  }

  /**
   * Flatten a position with a market order. Its exit orders (brackets) are cancelled first, and so is
   * the rest of any entry still filling into it (a market order, or one already partly filled), which
   * would otherwise go on adding shares after the close. Entries that have not started stay working.
   */
  closePosition(symbol: string): SubmitResult {
    const pos = this.position(symbol);
    if (pos.quantity === 0) return { ok: false, error: 'No position.', warnings: [] };
    const adding = pos.quantity > 0 ? 'buy' : 'short';
    const notes: string[] = [];
    for (const o of this.workingOrders(symbol)) {
      if (!isOpeningAction(o.action)) this.cancel(o.id, 'Position closed manually');
      else if (o.action === adding && (o.type === 'market' || o.filledQty > 0)) {
        notes.push(`Cancelled the unfilled ${o.quantity - o.filledQty} of ${describe(o)}, so it cannot add to the position after the close.`);
        this.cancel(o.id, 'Position closed manually');
      }
    }
    const r = this.submit({ symbol, action: pos.quantity > 0 ? 'sell' : 'cover', type: 'market', quantity: Math.abs(pos.quantity), tif: 'day' });
    return notes.length ? { ...r, notes: [...(r.notes ?? []), ...notes] } : r;
  }

  /** Qty already committed to working exit orders; an OCO group counts once. */
  private committedExitQty(symbol: string, action: 'sell' | 'cover'): number {
    const groups = new Map<string, number>();
    let loose = 0;
    for (const o of this.workingOrders(symbol)) {
      if (o.action !== action) continue;
      const rem = o.quantity - o.filledQty;
      if (o.ocoGroup) groups.set(o.ocoGroup, Math.max(groups.get(o.ocoGroup) ?? 0, rem));
      else loose += rem;
    }
    let total = loose;
    for (const v of groups.values()) total += v;
    return total;
  }

  // ---------------------------------------------------------------- clock

  /**
   * Bring the clock up to `now`, the replay's or the simulated market's time, before an order is
   * placed or changed. No bar trades in between, but the day can turn: yesterday's DAY orders expire,
   * and an order placed before the new day's first bar waits for that bar instead of filling at the
   * last close (data without extended hours, the simulated market before its first tick).
   */
  syncClock(now: UnixSeconds): void {
    if (!(now > this.s.clock)) return;
    this.s.clock = now;
    this.rollDay(now);
    this.touch();
  }

  /**
   * The session `symbol` trades in now: that of its own last bar, or none while the clock has moved on
   * to a session it has no bar for yet (a new day before its first bar, a symbol that opens late, a
   * daily bar that is only shown at the close, the post-market of a symbol without after-hours bars).
   * Orders then wait for its next bar rather than fill at an earlier session's price. The session is
   * read just before the clock, so at the very end of a bar's session (16:00 after the 15:59 bar, or a
   * daily bar's close) the symbol still trades at its close.
   */
  private symbolSession(symbol: string, clock = this.s.clock): MarketSession {
    const bar = this.s.lastBar[symbol];
    if (!bar || exchangeDate(clock - 1) > exchangeDate(bar.time)) return 'closed';
    const own = marketSession(bar.time);
    return clock > bar.time && marketSession(clock - 1) !== own ? 'closed' : own;
  }

  /**
   * Where an order is expected to fill, which its stop loss and target are checked against: a market
   * order at the quote (buys pay the ask, sells hit the bid), a stop at its stop price, a limit at its
   * limit, a stop-limit at its stop but never past its limit (once its stop fires it is a limit, which
   * fills near where it fired), unless the order is already through the market (`through`) and fills
   * near the quote: at once when it can trade now (`atOnce`), or as soon as its session opens (a plain
   * stop or limit placed in the pre-market, say, which fills at the open near today's price, not at its
   * own). A stop-limit is through when its stop has been passed and its limit lets it fill at the quote.
   * `quote` is that quote: the wider extended-hours one only for an order that can trade outside the
   * regular session (an extended-hours limit); market and stop orders wait for it. `tradesNow` says
   * whether the order can trade in the symbol's current session. `clock` is the time the order is
   * placed at (the broker's own clock, or the replay's ahead of it).
   */
  private expectedEntry(
    o: Pick<Order, 'symbol' | 'action' | 'type' | 'limitPrice' | 'stopPrice' | 'extendedHours'>,
    clock = this.s.clock,
  ): { price: number; quote: number; through: boolean; atOnce: boolean; tradesNow: boolean } {
    const last = this.s.lastPrice[o.symbol] ?? 0;
    const session = this.symbolSession(o.symbol, clock);
    const tradesNow = this.eligible(o, session);
    const extended = session !== 'regular' && o.type === 'limit' && !!o.extendedHours && this.cfg.allowExtendedHours;
    const hs = halfSpread(this.cfg, last, extended);
    const buy = actionSide(o.action) === 'buy';
    const quote = last + (buy ? hs : -hs);
    if (o.type === 'market') return { price: quote, quote, through: false, atOnce: false, tradesNow };
    const L = o.limitPrice!;
    const capped = (px: number) => (buy ? Math.min(L, px) : Math.max(L, px));
    // A stop-limit whose stop has fired (or would fire now) waits as a limit at its limit unless the
    // limit can fill at the quote.
    const fired = o.type === 'stop_limit' && ((o as Partial<Order>).triggered || this.triggerLevel({ ...o, triggered: false } as Order, last, last, false) !== null);
    const leg = fired ? ({ ...o, type: 'limit' } as Order) : (o as Order);
    // Already through the market, it fills near the quote: at once, or at the next bar's open (about
    // the same price) in next-bar-open mode, or at the first bar of the session it can trade in.
    if ((leg.type === 'stop' || leg.type === 'limit') && this.triggerLevel(leg, last, last, extended) !== null) {
      const atQuote = buy ? ceilTick(quote) : floorTick(quote);
      return { price: leg.type === 'stop' ? atQuote : capped(atQuote), quote, through: true, atOnce: tradesNow, tradesNow };
    }
    const own = leg.type === 'stop' ? o.stopPrice! : leg.type === 'limit' ? L : capped(o.stopPrice!);
    return { price: own, quote, through: false, atOnce: false, tradesNow };
  }

  /**
   * Where an order is expected to fill if placed now, with the costs a fill pays: a limit at its
   * limit; a market order, or a stop or limit already through the market, at the last price; a stop at
   * its stop price; with the spread, slippage and the market impact of the shares the last bar's volume
   * lets trade at once. The ticket sizes from this and Strict Mode checks risk at it, so a trade sized
   * to the rule's % passes the review's check of that %. A market order that waits for the next bar's
   * open, or a stop that price gaps through, can still fill elsewhere. Null before the symbol has a price.
   * `now` is the replay's or simulated market's time, which submit brings the clock up to first.
   */
  estimateFill(o: Pick<OrderRequest, 'symbol' | 'action' | 'type' | 'quantity' | 'limitPrice' | 'stopPrice' | 'extendedHours'>, now?: UnixSeconds): number | null {
    const symbol = o.symbol.toUpperCase();
    if (o.type === 'limit' || o.type === 'stop_limit') return o.limitPrice ?? null;
    const last = this.s.lastPrice[symbol];
    if (last === undefined) return null;
    const expected = this.expectedEntry({ ...o, symbol, extendedHours: !!o.extendedHours }, Math.max(now ?? this.s.clock, this.s.clock));
    const x = o.type === 'market' || expected.through ? last : o.stopPrice!;
    const volume = this.s.lastBar[symbol]?.volume ?? 0;
    // An order that fills against the last bar now pays the impact of its own shares, if what is left
    // of that bar's volume takes them all. One that fills on a later bar (a stop not yet reached, an
    // order waiting for its session, next-bar-open mode, or shares the last bar has no room left for)
    // pays the impact of as many as a whole bar lets trade.
    const fillsNow = this.cfg.marketOrderFill === 'last_price' && (o.type === 'market' ? expected.tradesNow : expected.atOnce);
    const left = this.barCapacity(volume, this.s.barVolumeUsed?.[symbol] ?? 0);
    const qty = fillsNow && left >= o.quantity ? o.quantity : Math.min(o.quantity, this.barCapacity(volume));
    // Market and stop orders only trade in the regular session, at its spread.
    return this.marketFill(actionSide(o.action), x, qty, volume, false).price;
  }

  /** How far past a limit price must trade before it fills: nothing when touching it is enough, else one tick of its price. */
  private limitThrough(L: number): number {
    return this.cfg.limitFill === 'trade_through' ? tickOf(L) : 0;
  }

  /** Shares that can still trade against a bar of `volume` once `used` have: a bar without volume (none recorded) is not capped. */
  private barCapacity(volume: number, used = 0): number {
    return this.cfg.maxParticipation > 0 && volume > 0 ? Math.max(0, Math.floor(volume * this.cfg.maxParticipation) - used) : Infinity;
  }

  /**
   * The trading session a new DAY order belongs to: today, or the next session if today's regular
   * session is over. `now` is the broker clock (end of the latest bar), so an order placed after the
   * 15:59 bar completes belongs to the next session.
   */
  private orderSessionDate(now: UnixSeconds): string {
    const date = exchangeDate(now);
    if (!isTradingDay(date)) return nextTradingDay(date);
    return exchangeMinuteOfDay(now) >= regularCloseMinute(date) ? nextTradingDay(date) : date;
  }

  private eligible(o: Pick<Order, 'extendedHours' | 'type'>, session: MarketSession): boolean {
    if (session === 'regular') return true;
    if (session === 'closed') return false;
    return this.cfg.allowExtendedHours && o.extendedHours && o.type === 'limit';
  }

  /** Start a new trading day when `barTime` is on one, and expire DAY orders whose session is over. */
  private rollDay(barTime: UnixSeconds): void {
    const date = exchangeDate(barTime);
    if (date !== this.s.sessionDate) {
      if (this.s.sessionDate) this.s.dayStartEquity = this.account().equity;
      this.s.dayLowEquity = undefined;
      this.s.sessionDate = date;
    }
    const session = marketSession(barTime);
    for (const o of this.liveOrders()) {
      if (!isOpen(o) || o.tif !== 'day' || !o.sessionDate) continue;
      const pastDate = date > o.sessionDate;
      const pastRegular = date === o.sessionDate && session === 'post' && !o.extendedHours;
      if (pastDate || pastRegular) {
        o.status = 'expired';
        o.updatedAt = barTime;
        this.log('expired', `${describe(o)} expired (DAY order)`, o.id);
      }
    }
  }

  // ---------------------------------------------------------------- bar processing

  /**
   * Process one newly revealed bar for `symbol`. `barSeconds` is the bar duration (60 for 1m).
   * Returns fills generated by this bar.
   */
  onBar(symbol: string, bar: Bar, barSeconds = 60): Fill[] {
    symbol = symbol.toUpperCase();
    const fillsBefore = this.s.fills.length;
    this.rollDay(bar.time);
    const end = bar.time + barSeconds;
    const equity = this.account().equity;
    if (this.s.stepStart?.time !== end) {
      // The first bar ending at `end`: every bar ending earlier has closed, so the account really has this equity.
      this.s.stepStart = { time: end, equity };
      this.s.dayLowEquity = Math.min(this.s.dayLowEquity ?? equity, equity);
    }
    this.bar = { symbol, offset: this.s.stepStart.equity - equity, held: 0, adj: 0 };
    const session = marketSession(bar.time);
    // Pending orders become working once their session arrives.
    for (const o of this.liveOrders()) {
      if (o.symbol === symbol && o.status === 'pending' && this.eligible(o, session)) o.status = 'working';
    }

    // The bar's assumed path in time: each point with the fraction of the bar elapsed when price is there.
    const points = this.intrabarPath(symbol, bar).map((p, i, all) => ({ p, f: i / (all.length - 1) }));
    // An order placed or changed after the bar opened (a daily or 5m bar shown beside a 1m symbol, a
    // symbol that opens late) trades only on the part of the path after that time: a point is added there.
    const startsAt = new Map<string, number>();
    for (const o of this.liveOrders()) {
      if (o.symbol !== symbol || !isOpen(o)) continue;
      const from = o.activeFrom ?? o.createdAt;
      if (from <= bar.time) continue;
      // The conservative fill mode fills a market order at the open of a bar that starts after it. That
      // bar may open the next session (a daily bar, an order in the day's last bar), so a DAY order lives until then.
      const nextOpen = o.type === 'market' && this.cfg.marketOrderFill === 'next_bar_open';
      const f = nextOpen ? 1 : Math.min(1, (from - bar.time) / barSeconds);
      if (nextOpen && o.tif === 'day' && o.sessionDate) {
        const next = this.orderSessionDate(bar.time + barSeconds);
        if (next > o.sessionDate) o.sessionDate = next;
      }
      startsAt.set(o.id, f);
      const k = points.findIndex((q) => q.f >= f);
      if (k > 0 && points[k].f > f) {
        const a = points[k - 1];
        const b = points[k];
        points.splice(k, 0, { p: a.p + ((b.p - a.p) * (f - a.f)) / (b.f - a.f), f });
      }
    }
    const path = points.map((q) => q.p);
    let capacity = this.barCapacity(bar.volume);
    let traded = 0;
    const ext = session !== 'regular';

    // Excursions (MFE/MAE): every price the path passes while a trade is open, including the part of
    // the bar before a trade closes in it. The path is straight between its points and open P/L is
    // linear in price between fills, so reaching each point and each fill level covers it.
    let tripId = this.s.openTripBySymbol[symbol];
    const reach = (price: number) => {
      if (!tripId) return;
      const trip = this.tripById(tripId)!;
      trip.highWhileOpen = Math.max(trip.highWhileOpen, price);
      trip.lowWhileOpen = Math.min(trip.lowWhileOpen, price);
      this.markOpenPnl(trip, price);
    };
    reach(path[0]);

    let seg = 0;
    for (; seg < path.length - 1 && capacity > 0; seg++) {
      let pos = path[seg];
      const end = path[seg + 1];
      const skip = new Set<string>();
      // Orders that start later in the bar sit this part of the path out.
      for (const [id, f] of startsAt) if (f > points[seg].f) skip.add(id);
      for (let guard = 0; guard < 200 && capacity > 0; guard++) {
        const trig = this.nextTrigger(symbol, pos, end, session, skip);
        if (!trig) break;
        pos = trig.level;
        const segLen = Math.abs(end - path[seg]);
        const frac = points[seg].f + (points[seg + 1].f - points[seg].f) * (segLen > 0 ? Math.abs(pos - path[seg]) / segLen : 0);
        const t = bar.time + Math.min(barSeconds - 1, Math.floor(barSeconds * frac));
        reach(pos);
        // At the very start of the bar, for an order placed before it began: the bar's open set the price.
        const atOpen = seg === 0 && pos === path[0] && !startsAt.has(trig.order.id);
        const used = this.execute(trig.order, pos, t, capacity, bar.volume, ext, skip, atOpen ? 'open' : 'bar', bar.time + barSeconds);
        capacity -= used;
        traded += used;
        // A trade opened (or reversed into) here starts at this level.
        tripId = this.s.openTripBySymbol[symbol];
        reach(pos);
      }
      reach(end);
    }
    // Out of capacity: no more fills this bar, but price still travels the rest of the path.
    for (let k = seg + 1; k < path.length; k++) reach(path[k]);

    this.s.lastPrice[symbol] = bar.close;
    this.s.lastBar[symbol] = { ...bar };
    (this.s.barVolumeUsed ??= {})[symbol] = traded;
    this.s.clock = Math.max(this.s.clock, bar.time + barSeconds);

    this.bar = undefined;
    this.recordEquity(bar.time + barSeconds);
    this.touch();
    return this.s.fills.slice(fillsBefore);
  }

  /** Record `trip`'s open P/L (before costs) with its symbol at `price`: what it made so far plus the shares still held. */
  private markOpenPnl(trip: RoundTrip, price: number): void {
    const pos = this.position(trip.symbol);
    const open = trip.pnl + trip.commission + (price - pos.avgPrice) * pos.quantity;
    trip.bestOpenPnl = Math.max(trip.bestOpenPnl ?? open, open);
    trip.worstOpenPnl = Math.min(trip.worstOpenPnl ?? open, open);
  }

  /** Update marks without trading (e.g. for symbols with no orders in a multi-symbol sim). */
  mark(symbol: string, price: number): void {
    this.s.lastPrice[symbol.toUpperCase()] = price;
  }

  private recordEquity(time: UnixSeconds): void {
    const eq = this.account().equity;
    const curve = this.s.equityCurve;
    const last = curve[curve.length - 1];
    if (last && last.time === time) last.equity = eq;
    else if (!last || time > last.time) curve.push({ time, equity: eq });
  }

  private intrabarPath(symbol: string, bar: Bar): number[] {
    const { open: o, high: h, low: l, close: c } = bar;
    let lowFirst = c >= o; // up bar: assume the dip came first
    if (this.cfg.intrabarPath === 'worst_case') {
      const q = this.position(symbol).quantity;
      if (q > 0) lowFirst = true;
      else if (q < 0) lowFirst = false;
    }
    return lowFirst ? [o, l, h, c] : [o, h, l, c];
  }

  /**
   * Finds the working order that fires first as price moves from `from` toward `to`. Orders at the
   * same level fire in the order they were placed, except that exits go before entries: an exit at
   * that level (a stop that price gaps through along with a resting add, a stop at the other side's
   * entry) closes the shares first, so the entry then opens a new trade instead of adding past the stop
   * or being cancelled.
   */
  private nextTrigger(symbol: string, from: number, to: number, session: MarketSession, skip: Set<string>): Trigger | null {
    let best: Trigger | null = null;
    let bestLate = false;
    const ext = session !== 'regular';
    for (const o of this.liveOrders()) {
      if (o.symbol !== symbol || o.status === 'pending' || !isOpen(o) || skip.has(o.id)) continue;
      if (!this.eligible(o, session)) continue;
      const level = this.triggerLevel(o, from, to, ext);
      if (level === null) continue;
      const distance = Math.abs(level - from);
      const late = isOpeningAction(o.action);
      if (!best || distance < best.distance - EPS || (bestLate && !late && distance <= best.distance + EPS)) {
        best = { order: o, level, distance };
        bestLate = late;
      }
    }
    return best;
  }

  /** Price along [from, to] at which the order's condition becomes true, or null. */
  private triggerLevel(o: Order, from: number, to: number, ext: boolean): number | null {
    const side = actionSide(o.action);
    const reach = (cond: (x: number) => boolean, boundary: number): number | null => {
      if (cond(from)) return from;
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      if (boundary >= lo - EPS && boundary <= hi + EPS && cond(to)) return boundary;
      return null;
    };
    const limitCond = (L: number): [(x: number) => boolean, number] => {
      const hs = halfSpread(this.cfg, L, ext);
      const through = this.limitThrough(L);
      if (side === 'buy') {
        const b = L - hs - through;
        return [(x) => x <= b + EPS, b];
      }
      const b = L + hs + through;
      return [(x) => x >= b - EPS, b];
    };
    const stopCond = (S: number): [(x: number) => boolean, number] =>
      side === 'buy' ? [(x) => x >= S - EPS, S] : [(x) => x <= S + EPS, S];

    switch (o.type) {
      case 'market':
        return from;
      case 'limit': {
        const [c, b] = limitCond(o.limitPrice!);
        return reach(c, b);
      }
      case 'stop': {
        // Once fired a stop is a market order: what the volume cap left fills from the next bars.
        if (o.triggered) return from;
        const [c, b] = stopCond(o.stopPrice!);
        return reach(c, b);
      }
      case 'stop_limit': {
        if (o.triggered) {
          const [c, b] = limitCond(o.limitPrice!);
          return reach(c, b);
        }
        const [c, b] = stopCond(o.stopPrice!);
        return reach(c, b);
      }
    }
  }

  /**
   * Try to fill an order right now at the last price (market orders, marketable limits, passed stops).
   * Returns 'capped' when the volume cap left part of an order that would otherwise fill unfilled.
   */
  private tryImmediate(o: Order): 'capped' | undefined {
    const bar = this.s.lastBar[o.symbol];
    const last = this.s.lastPrice[o.symbol];
    if (!bar || last === undefined) return;
    const session = this.symbolSession(o.symbol);
    if (!this.eligible(o, session)) return;
    const level = this.triggerLevel(o, last, last, session !== 'regular');
    if (level === null) return;
    // The last bar's volume is shared by everything that trades against it, however many orders.
    const used = this.s.barVolumeUsed?.[o.symbol] ?? 0;
    const capacity = this.barCapacity(bar.volume, used);
    const skip = new Set<string>();
    const fired = o.type === 'stop_limit' && !o.triggered;
    let filled = this.execute(o, level, this.s.clock, capacity, bar.volume, session !== 'regular', skip, 'placed', this.s.clock);
    // A stop-limit whose stop has just fired is now a limit: one the market already meets fills at once.
    if (fired && o.triggered && isOpen(o) && !skip.has(o.id)) {
      const at = this.triggerLevel(o, last, last, session !== 'regular');
      if (at !== null) filled = this.execute(o, at, this.s.clock, capacity, bar.volume, session !== 'regular', skip, 'placed', this.s.clock);
    }
    if (filled > 0) (this.s.barVolumeUsed ??= {})[o.symbol] = used + filled;
    // A stop-limit may have triggered without filling; that's fine, it now rests as a limit.
    return isOpen(o) && capacity - filled <= 0 ? 'capped' : undefined;
  }

  /**
   * Execute an order that fired at path price `x`. Returns shares filled (0 if it only triggered
   * or could not fill). Adds the order to `skip` when it should not be reconsidered this bar.
   * `knownAt` is when the fill becomes known (Fill.knownAt).
   */
  private execute(o: Order, x: number, time: UnixSeconds, capacity: number, barVolume: number, ext: boolean, skip: Set<string>, at: Fill['at'], knownAt: UnixSeconds): number {
    const side = actionSide(o.action);
    const pos = this.position(o.symbol);

    // Buy and Short only open or add, as at submit. One placed while flat can meet a position opened
    // the other way since (two-sided entries around a range); it is cancelled, not turned into an exit.
    if ((o.action === 'buy' && pos.quantity < 0) || (o.action === 'short' && pos.quantity > 0)) {
      const held = `${pos.quantity > 0 ? 'long' : 'short'} ${Math.abs(pos.quantity)} ${o.symbol}`;
      this.autoCancel(o, time, `You were ${held} when it would have filled. ${o.action === 'buy' ? 'Cover the short before buying.' : 'Sell the long before shorting.'}`, `you were ${held} when it would have filled`);
      skip.add(o.id);
      return 0;
    }

    // Under Strict Mode, once the day's loss reaches its limit an entry is cancelled rather than filled.
    if (isOpeningAction(o.action) && this.cfg.strictRisk.enabled && this.dailyLimitReached()) {
      this.autoCancel(o, time, `Strict Mode: the ${this.cfg.strictRisk.maxDailyLossPct}% daily loss limit was reached.`, "Strict Mode's daily loss limit was reached");
      skip.add(o.id);
      return 0;
    }

    if (o.type === 'stop_limit' && !o.triggered) {
      o.triggered = true;
      o.updatedAt = time;
      this.log('triggered', `${describe(o)} triggered at ${formatTick(x)}; now a limit at ${formatTick(o.limitPrice!)}`, o.id);
      return 0; // the limit leg is re-evaluated from this point on the path
    }
    if (o.type === 'stop') o.triggered = true;

    // Exits can never exceed the current position (protects against orphaned exit orders).
    let remaining = o.quantity - o.filledQty;
    if (o.action === 'sell') remaining = Math.min(remaining, Math.max(0, pos.quantity));
    if (o.action === 'cover') remaining = Math.min(remaining, Math.max(0, -pos.quantity));
    if (remaining <= 0) {
      o.status = 'cancelled';
      o.rejectReason = 'No position left to close';
      o.updatedAt = time;
      this.log('cancelled', `${describe(o)} cancelled: no position left to close`, o.id);
      skip.add(o.id);
      return 0;
    }
    const qty = Math.min(remaining, capacity);
    if (qty <= 0) {
      skip.add(o.id);
      return 0;
    }

    const hs = halfSpread(this.cfg, x, ext);
    let price: number;
    let slippage = 0;
    const isMarketable = o.type === 'market' || o.type === 'stop';
    if (isMarketable) {
      const fill = this.marketFill(side, x, qty, barVolume, ext);
      price = fill.price;
      slippage = Math.abs(price - fill.quote) * qty;
    } else {
      // Limit (or triggered stop-limit): never worse than the limit; better if the market gapped through.
      // Reached on the path in trade-through mode (price traded a tick past it), it fills at its price.
      const L = o.limitPrice!;
      const through = this.limitThrough(L);
      const hsL = halfSpread(this.cfg, L, ext);
      const crossed = through > 0 && Math.abs(x - (side === 'buy' ? L - hsL - through : L + hsL + through)) <= EPS;
      price = crossed ? L : side === 'buy' ? Math.min(L, ceilTick(x + hs)) : Math.max(L, floorTick(x - hs));
    }
    const spreadCost = hs * qty;

    this.applyFill(o, qty, price, time, slippage, spreadCost, at, knownAt);
    if (isOpen(o)) skip.add(o.id); // partially filled: capacity exhausted for this bar
    return qty;
  }

  /**
   * The price a marketable order (a market order, or a stop once it fires) gets for `qty` shares at path
   * price `x` against a bar of `barVolume` shares: the quote (buys pay the ask, sells hit the bid), then
   * slippage and market impact, rounded to the tick against the trader.
   */
  private marketFill(side: Side, x: number, qty: number, barVolume: number, ext: boolean): { price: number; quote: number } {
    const hs = halfSpread(this.cfg, x, ext);
    const quote = side === 'buy' ? x + hs : x - hs;
    // Impact grows with the share of the bar's volume taken, up to the whole bar: with no
    // participation cap an order can be many bars' volume, and an unbounded charge would put fills
    // tens of percent off the market (and sells below zero).
    const impactPct = barVolume > 0 ? Math.min(MAX_IMPACT_PCT, (qty / barVolume) * 100) : 0;
    const slipBps = this.cfg.slippage.bps + this.cfg.slippage.impactBpsPerPctOfVolume * impactPct;
    const slip = (quote * slipBps) / 10_000;
    return { price: side === 'buy' ? ceilTick(quote + slip) : Math.max(MIN_PRICE, floorTick(quote - slip)), quote };
  }

  private applyFill(o: Order, qty: number, price: number, time: UnixSeconds, slippage: number, spreadCost: number, at: Fill['at'], knownAt: UnixSeconds): void {
    const side: Side = actionSide(o.action);
    // The fee for everything this order has filled, less what its earlier partial fills paid: the
    // per-order fee and minimum are charged once per order, not once per fill.
    const filled = o.filledQty + qty;
    const paid = o.commission ?? 0;
    const commission = Math.max(0, Math.round((commissionFor(this.cfg, filled, (o.avgFillPrice * o.filledQty + price * qty) / filled) - paid) * 100) / 100);
    o.commission = money(paid + commission);
    const symbol = o.symbol;
    // What the account marked the symbol at as this fill came, so its effect on equity then is known.
    const markBefore = this.s.lastPrice[symbol] ?? price;
    const pos = this.s.positions[symbol] ?? { symbol, quantity: 0, avgPrice: 0, realizedPnl: 0 };
    const positionBefore = pos.quantity;
    const signed = side === 'buy' ? qty : -qty;

    // ---- position + realized P/L (average-cost)
    let realizedGross = 0;
    const opening = pos.quantity === 0 || Math.sign(pos.quantity) === Math.sign(signed);
    if (opening) {
      const newQty = pos.quantity + signed;
      pos.avgPrice = (pos.avgPrice * Math.abs(pos.quantity) + price * qty) / Math.abs(newQty);
      pos.quantity = newQty;
    } else {
      // Reducing (never flips: exits are clamped to position size).
      realizedGross = (price - pos.avgPrice) * qty * Math.sign(pos.quantity);
      pos.quantity += signed;
      if (pos.quantity === 0) pos.avgPrice = 0;
    }
    pos.realizedPnl += realizedGross - commission;
    this.s.positions[symbol] = pos;
    // The daily limit values shares this bar opened at their price; an exit closes those first.
    const b = this.bar?.symbol === symbol ? this.bar : undefined;
    if (b && opening) {
      b.held += signed;
      b.adj += signed * (price - markBefore);
    } else if (b && b.held !== 0) {
      const k = Math.min(qty, Math.abs(b.held));
      b.adj -= (b.adj * k) / Math.abs(b.held);
      b.held -= Math.sign(b.held) * k;
    }

    // ---- cash
    this.s.cash += side === 'buy' ? -qty * price : qty * price;
    this.s.cash -= commission;
    this.s.realizedPnl += realizedGross - commission;
    this.s.commissionsPaid += commission;

    // ---- order
    o.avgFillPrice = (o.avgFillPrice * o.filledQty + price * qty) / (o.filledQty + qty);
    o.filledQty += qty;
    o.updatedAt = time;
    o.status = o.filledQty >= o.quantity ? 'filled' : 'partially_filled';

    const fill: Fill = {
      id: this.nextId('f'),
      orderId: o.id,
      symbol,
      action: o.action,
      side,
      quantity: qty,
      price,
      commission,
      slippage: money(slippage),
      spreadCost: money(spreadCost),
      time,
      realizedPnl: money(realizedGross - commission),
      ...(at ? { at } : {}),
      markBefore,
      positionBefore,
      knownAt,
    };
    this.s.fills.push(fill);
    this.log(o.status === 'filled' ? 'filled' : 'partial', `${o.action.toUpperCase()} ${qty} ${symbol} @ ${price.toFixed(2)}${o.status === 'partially_filled' ? ` (partial ${o.filledQty}/${o.quantity})` : ''}`, o.id);

    this.updateRoundTrip(o, fill, opening);
    this.manageBrackets(o, qty);
    this.s.lastPrice[symbol] = this.s.lastPrice[symbol] ?? price;
  }

  /** Cancels a working order the user did not cancel (`why` for them, `logged` for the event log), so the UI announces it. */
  private autoCancel(o: Order, time: UnixSeconds, why: string, logged: string): void {
    o.status = 'cancelled';
    o.rejectReason = why;
    o.conflict = true;
    o.updatedAt = time;
    this.log('cancelled', `${describe(o)} cancelled: ${logged}`, o.id);
  }

  private updateRoundTrip(o: Order, fill: Fill, opening: boolean): void {
    const symbol = o.symbol;
    let tripId = this.s.openTripBySymbol[symbol];
    let trip = tripId ? this.tripById(tripId) : undefined;
    if (!trip) {
      tripId = this.nextId('t');
      trip = {
        id: tripId,
        symbol,
        direction: fill.side === 'buy' ? 'long' : 'short',
        entryTime: fill.time,
        maxQuantity: 0,
        avgEntry: 0,
        entryQtyTotal: 0,
        exitQtyTotal: 0,
        pnl: 0,
        commission: 0,
        initialStop: o.stopLoss,
        initialTarget: o.takeProfit,
        plannedEntry: plannedPrice(o),
        bracketEntry: fill.price,
        stopOrder: { id: o.id, qty: 0 },
        ...(o.takeProfit !== undefined ? { targetPlanned: plannedPrice(o), targetEntry: fill.price, targetOrder: { id: o.id, qty: 0 } } : {}),
        tag: o.tag,
        highWhileOpen: fill.price,
        lowWhileOpen: fill.price,
        fills: [],
        closed: false,
        source: this.s.source,
      };
      this.s.roundTrips.push(trip);
      this.s.openTripBySymbol[symbol] = tripId;
    }
    trip.fills.push(fill.id);
    trip.commission += fill.commission;
    trip.highWhileOpen = Math.max(trip.highWhileOpen, fill.price);
    trip.lowWhileOpen = Math.min(trip.lowWhileOpen, fill.price);
    if (opening) {
      trip.avgEntry = (trip.avgEntry * trip.entryQtyTotal + fill.price * fill.quantity) / (trip.entryQtyTotal + fill.quantity);
      trip.entryQtyTotal += fill.quantity;
      trip.pnl -= fill.commission;
      if (trip.initialStop === undefined && o.stopLoss !== undefined) {
        // An add brings the first stop (the trade opened without one): the stop's plan is that add's.
        trip.initialStop = o.stopLoss;
        trip.plannedEntry = plannedPrice(o);
        trip.bracketEntry = fill.price;
        trip.stopOrder = { id: o.id, qty: 0 };
        trip.stopFromAdd = true;
      }
      if (trip.initialTarget === undefined && o.takeProfit !== undefined) {
        trip.initialTarget = o.takeProfit;
        trip.targetPlanned = plannedPrice(o);
        trip.targetEntry = fill.price;
        trip.targetOrder = { id: o.id, qty: 0 };
      }
      // An entry order capped by bar volume fills in parts: the entry its stop or target came with is
      // the average of all of them, so its own later parts never count as adds past the stop.
      for (const [track, key] of [
        [trip.stopOrder, 'bracketEntry'],
        [trip.targetOrder, 'targetEntry'],
      ] as const) {
        if (!track || track.id !== o.id) continue;
        trip[key] = track.qty > 0 ? (trip[key]! * track.qty + fill.price * fill.quantity) / (track.qty + fill.quantity) : fill.price;
        track.qty += fill.quantity;
      }
      if (!trip.tag && o.tag) trip.tag = o.tag;
    } else {
      trip.avgExit = ((trip.avgExit ?? 0) * trip.exitQtyTotal + fill.price * fill.quantity) / (trip.exitQtyTotal + fill.quantity);
      trip.exitQtyTotal += fill.quantity;
      trip.pnl += fill.realizedPnl; // already net of this fill's commission
    }
    const posQty = Math.abs(this.position(symbol).quantity);
    trip.maxQuantity = Math.max(trip.maxQuantity, posQty);
    trip.pnl = money(trip.pnl);
    this.markOpenPnl(trip, fill.price);
    if (posQty === 0) {
      trip.closed = true;
      trip.exitTime = fill.time;
      delete this.s.openTripBySymbol[symbol];
      // Flat: any remaining exit orders for this symbol are orphans. So is the rest of an entry that had
      // already filled into the trade (as Close position cancels it): its bracket stop came with the
      // shares it closed, and a new trade from it would get a stop already past the price. Under Strict
      // Mode so are the other entries working on the trade's side: they were measured as part of it
      // (from its first stop, against the equity it started with), and filling now they would start a
      // new trade that was never checked.
      const entry = trip.direction === 'long' ? 'buy' : 'short';
      for (const x of this.liveOrders()) {
        if (x.symbol !== symbol || !isOpen(x)) continue;
        if (!isOpeningAction(x.action)) {
          x.status = 'cancelled';
          x.rejectReason = 'Position closed';
          x.updatedAt = fill.time;
          this.log('cancelled', `${describe(x)} cancelled: position closed`, x.id);
        } else if (x.action === entry && x.filledQty > 0) {
          this.autoCancel(x, fill.time, `It filled ${shares(x.filledQty)} into the ${symbol} trade, which has closed. Place it again to start a new trade.`, `the ${symbol} trade it filled into closed`);
        } else if (x.action === entry && this.cfg.strictRisk.enabled) {
          this.autoCancel(x, fill.time, `Strict Mode: it was measured as part of the ${symbol} trade that closed. Place it again to check it as a new trade.`, `Strict Mode measured it as part of the ${symbol} trade that closed`);
        }
      }
    }
  }

  /** Creates/updates bracket exits when an entry fills; maintains OCO between exits. */
  private manageBrackets(o: Order, qty: number): void {
    if (isOpeningAction(o.action) && (o.stopLoss || o.takeProfit)) {
      const exitAction: OrderAction = o.action === 'buy' ? 'sell' : 'cover';
      const children = this.liveOrders().filter((c) => c.parentId === o.id && isOpen(c));
      if (children.length === 0) {
        const base = {
          symbol: o.symbol,
          action: exitAction,
          quantity: qty,
          tif: 'gtc' as const,
          extendedHours: false,
          status: 'working' as const,
          filledQty: 0,
          avgFillPrice: 0,
          createdAt: this.s.clock,
          updatedAt: this.s.clock,
          triggered: false,
          parentId: o.id,
          ocoGroup: o.id,
          tag: o.tag,
        };
        if (o.stopLoss) {
          const sl: Order = { ...base, id: this.nextId('o'), type: 'stop', stopPrice: o.stopLoss };
          this.s.orders.push(sl);
          this.log('accepted', `Bracket stop loss ${describe(sl)} placed`, sl.id);
        }
        if (o.takeProfit) {
          const tp: Order = { ...base, id: this.nextId('o'), type: 'limit', limitPrice: o.takeProfit };
          this.s.orders.push(tp);
          this.log('accepted', `Bracket take profit ${describe(tp)} placed`, tp.id);
        }
      } else {
        for (const c of children) c.quantity += qty;
      }
      return;
    }
    if (o.ocoGroup) {
      for (const sib of this.liveOrders()) {
        if (sib.id === o.id || sib.ocoGroup !== o.ocoGroup || !isOpen(sib)) continue;
        sib.quantity -= qty;
        if (sib.quantity - sib.filledQty <= 0) {
          sib.status = 'cancelled';
          sib.rejectReason = 'OCO: other leg filled';
          sib.updatedAt = this.s.clock;
          this.log('cancelled', `${describe(sib)} cancelled (OCO)`, sib.id);
        }
      }
    }
  }
}

export function isOpen(o: Order): boolean {
  return o.status === 'working' || o.status === 'pending' || o.status === 'partially_filled';
}

export function isOpeningAction(a: OrderAction): boolean {
  return a === 'buy' || a === 'short';
}

/** A bracket error for a stop or limit already through the market, which fills at once at the quote rather than at its own price. */
/** `fill` is when it fills: now (by the fill mode), or 'regular' / 'next' for an order waiting for the regular session or for the stock's next bar. */
function throughTheMarket(error: string, type: OrderType, price: number, fill: ExecutionConfig['marketOrderFill'] | 'regular' | 'next'): string {
  const at = `at about ${formatTick(price)}`;
  const when =
    fill === 'last_price' ? `at once ${at}`
    : fill === 'next_bar_open' ? `at the next bar's open ${at}`
    : `${at} when the stock next trades${fill === 'regular' ? ' in the regular session' : ''}`;
  return `${error.replace(/\.$/, '')}: this ${type === 'stop' ? 'stop' : type === 'stop_limit' ? 'stop-limit' : 'limit'} is already through the market, so it would fill ${when}.`;
}

/**
 * The price an entry order was planned at: the price it was checked against when placed or last
 * changed (the quote for a market order; near the quote for a stop or limit already through the
 * market; a stop-limit's stop, never past its limit), else its limit or stop.
 */
function plannedPrice(o: Order): number | undefined {
  return o.quotedPrice ?? (o.type === 'limit' ? o.limitPrice : o.type === 'market' ? undefined : o.stopPrice);
}

export function describe(o: Order): string {
  const px =
    o.type === 'market'
      ? 'MKT'
      : o.type === 'limit'
        ? `LMT ${formatTick(o.limitPrice!)}`
        : o.type === 'stop'
          ? `STP ${formatTick(o.stopPrice!)}`
          : `STP ${formatTick(o.stopPrice!)} LMT ${formatTick(o.limitPrice!)}`;
  return `${o.action.toUpperCase()} ${o.quantity} ${o.symbol} ${px}`;
}
