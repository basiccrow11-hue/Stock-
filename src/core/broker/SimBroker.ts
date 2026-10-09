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
import { assessRisk, over, strictRiskViolation, type Exposure } from '../risk/risk';
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

const TICK = 0.01;
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

  private liveOrders(): Order[] {
    const list = this.s.orders;
    while (this.openFrom < list.length && !isOpen(list[this.openFrom])) this.openFrom++;
    return this.openFrom === 0 ? list : list.slice(this.openFrom);
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
   * price it checks (a limit's own price, otherwise where the order is expected to fill).
   */
  affordableQuantity(o: Pick<OrderRequest, 'symbol' | 'action' | 'type' | 'limitPrice' | 'stopPrice' | 'extendedHours'>, now?: UnixSeconds): number {
    const symbol = o.symbol.toUpperCase();
    if (this.s.lastPrice[symbol] === undefined) return 0;
    const px = o.type === 'limit' ? o.limitPrice : this.expectedEntry({ ...o, symbol, extendedHours: !!o.extendedHours }, Math.max(now ?? this.s.clock, this.s.clock)).price;
    return px && px > 0 ? Math.max(0, Math.floor((this.availableBuyingPower() + 0.005) / px)) : 0;
  }

  /**
   * The stop loss and target a working entry's unfilled shares will get: once it has started filling,
   * those of its live bracket (which take its later shares, wherever they have been moved; `stopAt`
   * prices one stop as if moved there), else its own.
   */
  private bracketLevels(o: Order, stopAt?: { id: string; price: number }): { stopLoss?: number; takeProfit?: number } {
    let { stopLoss, takeProfit } = o;
    if (o.filledQty > 0) {
      for (const c of this.workingOrders(o.symbol)) {
        if (c.parentId !== o.id) continue;
        if (c.type === 'stop' || c.type === 'stop_limit') stopLoss = stopAt?.id === c.id ? stopAt.price : c.stopPrice;
        else if (c.type === 'limit') takeProfit = c.limitPrice;
      }
    }
    return { stopLoss, takeProfit };
  }

  /**
   * The equity a trade in `symbol` on `action`'s side is measured against: while one is open, the
   * equity it started with (as the trade review and the challenges measure it), else the account's.
   */
  private tradeEquity(symbol: string, action: 'buy' | 'short'): number {
    const dir = action === 'buy' ? 1 : -1;
    if (this.position(symbol).quantity * dir > 0) {
      const trip = this.s.roundTrips.find((t) => t.symbol === symbol && !t.closed);
      if (trip) return equityBeforeEntry(trip, this.s.fills, this.s.equityCurve, this.s.startingBalance);
    }
    return this.account().equity;
  }

  /**
   * The shares a new `action` order in `symbol` would join (see Exposure): those held in its direction
   * and those in its other working entries (all but `excludeId`). `stopAt` prices one exit stop as if
   * it were moved there.
   */
  exposure(symbol: string, action: 'buy' | 'short', excludeId?: string, stopAt?: { id: string; price: number }): Exposure {
    symbol = symbol.toUpperCase();
    const dir = action === 'buy' ? 1 : -1;
    const last = this.s.lastPrice[symbol] ?? 0;
    const pos = this.position(symbol);
    const held = pos.quantity * dir > 0 ? Math.abs(pos.quantity) : 0;
    let shares = held;
    let value = held * last;
    let risk = 0;
    let unprotected = 0;
    if (held) {
      const exit = action === 'buy' ? 'sell' : 'cover';
      let covered = 0;
      for (const o of this.workingOrders(symbol)) {
        if (o.action !== exit || (o.type !== 'stop' && o.type !== 'stop_limit')) continue;
        const n = Math.min(o.quantity - o.filledQty, held - covered);
        if (n <= 0) continue;
        covered += n;
        const stop = stopAt?.id === o.id ? stopAt.price : o.stopPrice!;
        risk += n * Math.max(0, (pos.avgPrice - stop) * dir);
      }
      unprotected += held - covered;
    }
    for (const o of this.workingOrders(symbol)) {
      if (o.action !== action || o.id === excludeId) continue;
      const n = o.quantity - o.filledQty;
      const px = o.limitPrice ?? o.stopPrice ?? last;
      shares += n;
      value += n * px;
      const { stopLoss } = this.bracketLevels(o, stopAt);
      if (stopLoss !== undefined) risk += n * Math.max(0, (px - stopLoss) * dir);
      else unprotected += n;
    }
    const equity = this.account().equity;
    const riskEquity = this.tradeEquity(symbol, action);
    return {
      symbol,
      shares,
      valuePct: equity > 0 ? (value / equity) * 100 : 0,
      riskPct: riskEquity > 0 ? (risk / riskEquity) * 100 : 0,
      riskEquity,
      unprotected,
    };
  }

  /**
   * The checks an opening order must pass when it is placed or changed: its stop loss and target on the
   * right side of where it is expected to fill, Strict Mode's limits for the whole trade it joins, and
   * buying power. `own` is the working order being changed: it is left out of what the trade already
   * holds, and the buying power it holds back is available to it. `o.quantity` is its unfilled shares.
   */
  private openingCheck(
    o: Pick<Order, 'symbol' | 'action' | 'type' | 'limitPrice' | 'stopPrice' | 'stopLoss' | 'takeProfit' | 'extendedHours'> & { quantity: number },
    own?: Order,
  ): { error?: string; strict?: boolean; warnings: string[]; quote: number } {
    // Orders are checked against the price they would actually get: buys pay the ask, sells hit the bid.
    const expected = this.expectedEntry(o);
    const refPrice = expected.price;
    const fail = (error: string) => ({ error, warnings: [], quote: expected.quote });
    const acct = this.account();
    const assess = (px: number) =>
      assessRisk({ action: o.action, quantity: o.quantity, entryPrice: px, stopLoss: o.stopLoss, takeProfit: o.takeProfit, equity: acct.equity, commissionEstimate: commissionFor(this.cfg, o.quantity, px) });
    const risk = assess(refPrice);
    if (risk.errors.length) return fail(expected.atOnce ? throughTheMarket(risk.errors[0], o.type, refPrice, this.cfg.marketOrderFill) : risk.errors[0]);
    // The risk itself is measured at the price the order is expected to fill at with its costs, as
    // the ticket sizes it and the review judges it.
    const fillAt = this.estimateFill(o) ?? refPrice;
    const costed = fillAt === refPrice ? risk : assess(fillAt);
    const strict = this.cfg.strictRisk;
    const existing = strict.enabled ? this.exposure(o.symbol, o.action === 'short' ? 'short' : 'buy', own?.id) : undefined;
    const violation = strictRiskViolation(strict, costed, { dayPnl: acct.dayPnl, dayStartEquity: this.s.dayStartEquity, existing });
    if (violation) return { ...fail(violation), strict: true };
    // A limit may still fill anywhere up to its price.
    const needed = o.quantity * (o.type === 'limit' ? o.limitPrice! : refPrice);
    const avail = this.availableBuyingPower() + (own ? this.reservation(own) : 0);
    if (needed > avail + 0.005) return fail(`Insufficient buying power: need $${needed.toFixed(2)}, have $${avail.toFixed(2)}.`);
    return { warnings: costed.warnings, quote: expected.quote };
  }

  // ---------------------------------------------------------------- orders

  submit(input: OrderRequest): SubmitResult {
    const warnings: string[] = [];
    // Prices are normalised to the exchange tick so fills land on real price levels.
    const tick = (v: number | undefined) => (v === undefined || !Number.isFinite(v) || v <= 0 ? undefined : roundToTick(v));
    const req: OrderRequest = {
      ...input,
      limitPrice: tick(input.limitPrice),
      stopPrice: tick(input.stopPrice),
      stopLoss: tick(input.stopLoss),
      takeProfit: tick(input.takeProfit),
    };
    const reject = (error: string): SubmitResult => {
      this.log('rejected', `${req.action.toUpperCase()} ${req.quantity} ${req.symbol}: ${error}`);
      this.touch();
      return { ok: false, error, warnings };
    };
    const symbol = req.symbol.toUpperCase();
    const qty = req.quantity;
    if (!Number.isFinite(qty) || qty <= 0 || Math.floor(qty) !== qty) return reject('Quantity must be a whole number of shares greater than 0.');
    if ((req.type === 'limit' || req.type === 'stop_limit') && !(req.limitPrice && req.limitPrice > 0)) return reject('Limit price is required.');
    if ((req.type === 'stop' || req.type === 'stop_limit') && !(req.stopPrice && req.stopPrice > 0)) return reject('Stop price is required.');
    if (req.extendedHours && req.type !== 'limit') return reject('Only limit orders can be routed to extended hours.');
    if (req.extendedHours && !this.cfg.allowExtendedHours) return reject('Extended-hours trading is disabled in Settings.');

    const pos = this.position(symbol);
    const last = this.s.lastPrice[symbol];
    if (last === undefined) return reject('No price yet for this symbol. Start the replay first.');

    // Action legality mirrors a real broker's buy/sell vs short/cover distinction.
    switch (req.action) {
      case 'buy':
        if (pos.quantity < 0) return reject(`You are short ${-pos.quantity} ${symbol}. Use Cover to buy back a short.`);
        break;
      case 'short':
        if (!this.cfg.allowShortSelling) return reject('Short selling is disabled in Settings.');
        if (this.cfg.marginMultiplier < 1.5) return reject('Short selling requires a margin account (set margin to 2x or more in Settings).');
        if (pos.quantity > 0) return reject(`You are long ${pos.quantity} ${symbol}. Sell the long before shorting.`);
        break;
      case 'sell': {
        if (pos.quantity <= 0) return reject(`No long position in ${symbol} to sell. Use Short to open a short.`);
        const avail = pos.quantity - this.committedExitQty(symbol, 'sell');
        if (qty > avail + EPS) return reject(`Only ${Math.max(0, avail)} shares available to sell (others are committed to open orders).`);
        break;
      }
      case 'cover': {
        if (pos.quantity >= 0) return reject(`No short position in ${symbol} to cover.`);
        const avail = -pos.quantity - this.committedExitQty(symbol, 'cover');
        if (qty > avail + EPS) return reject(`Only ${Math.max(0, avail)} shares available to cover (others are committed to open orders).`);
        break;
      }
    }

    const opening = isOpeningAction(req.action);
    let quote = this.expectedEntry({ ...req, symbol, extendedHours: !!req.extendedHours }).quote;
    if (opening) {
      const check = this.openingCheck({ ...req, symbol, quantity: qty, extendedHours: !!req.extendedHours });
      if (check.error) return reject(check.error);
      warnings.push(...check.warnings);
      quote = check.quote;
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
      ...(req.type === 'market' ? { quotedPrice: quote } : {}),
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
    const o = this.s.orders.find((x) => x.id === orderId);
    if (!o || !isOpen(o)) return false;
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
    const o = this.s.orders.find((x) => x.id === orderId);
    if (!o || !isOpen(o)) return { ok: false, error: 'Order is not open.' };
    if (changes.quantity !== undefined && (changes.quantity < o.filledQty + 1 || Math.floor(changes.quantity) !== changes.quantity)) {
      return { ok: false, error: 'Quantity must be a whole number above the filled quantity.' };
    }
    if (changes.limitPrice !== undefined && (!(changes.limitPrice > 0) || (o.type !== 'limit' && o.type !== 'stop_limit'))) return { ok: false, error: 'Invalid limit price.' };
    if (changes.stopPrice !== undefined && (!(changes.stopPrice > 0) || (o.type !== 'stop' && o.type !== 'stop_limit'))) return { ok: false, error: 'Invalid stop price.' };
    if (changes.stopPrice !== undefined && o.triggered) return { ok: false, error: 'The stop has already triggered, so its price no longer applies.' };
    const limitPrice = changes.limitPrice !== undefined ? roundToTick(changes.limitPrice) : o.limitPrice;
    const stopPrice = changes.stopPrice !== undefined ? roundToTick(changes.stopPrice) : o.stopPrice;
    // A changed entry is checked as if it were placed now: its stop loss and target against where it
    // now fills, Strict Mode and buying power. Fewer shares at the same prices put nothing new at risk,
    // so an entry can always be cut back, even once price has moved past its stop loss.
    const cutOnly = limitPrice === o.limitPrice && stopPrice === o.stopPrice && (changes.quantity ?? o.quantity) <= o.quantity;
    if (isOpeningAction(o.action)) {
      if (!cutOnly) {
        // Its unfilled shares take the live bracket's stop and target once it has started filling.
        const next = { ...o, ...this.bracketLevels(o), limitPrice, stopPrice, quantity: (changes.quantity ?? o.quantity) - o.filledQty };
        const { error, strict } = this.openingCheck(next, o);
        // Strict Mode never refuses a change that takes risk off the order (a price nearer its stop)
        // while the riskier order would stay working.
        if (error && !(strict && this.noRiskier(o, next))) return { ok: false, error };
      }
    } else if (stopPrice !== undefined && stopPrice !== o.stopPrice && this.cfg.strictRisk.enabled) {
      // Under Strict Mode an exit stop cannot be moved away to put more than the limit at risk.
      const entry = o.action === 'sell' ? 'buy' : 'short';
      const before = this.exposure(o.symbol, entry).riskPct;
      const after = this.exposure(o.symbol, entry, undefined, { id: o.id, price: stopPrice }).riskPct;
      const limit = this.cfg.strictRisk.maxRiskPctPerTrade;
      if (after > before + 1e-9 && after > limit + 1e-9) {
        return { ok: false, error: `Strict risk: with this stop at ${formatTick(stopPrice)}, the trade risks ${over(after, limit, 2)}% (limit ${limit}%).` };
      }
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

  /** Whether `next` (unfilled shares, prices) puts no more value or risk to its stop on the line than `o`'s unfilled shares. */
  private noRiskier(o: Order, next: Pick<Order, 'limitPrice' | 'stopPrice' | 'stopLoss'> & { quantity: number }): boolean {
    const dir = o.action === 'buy' ? 1 : -1;
    const last = this.s.lastPrice[o.symbol] ?? 0;
    const was = { n: o.quantity - o.filledQty, px: o.limitPrice ?? o.stopPrice ?? last };
    const now = { n: next.quantity, px: next.limitPrice ?? next.stopPrice ?? last };
    const risk = (x: { n: number; px: number }) => (next.stopLoss === undefined ? x.n : x.n * Math.max(0, (x.px - next.stopLoss) * dir));
    return now.n <= was.n && now.n * now.px <= was.n * was.px + 1e-9 && risk(now) <= risk(was) + 1e-9;
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
   * limit, unless the stop or limit is already through the market and fills at once, at the quote.
   * `quote` is that quote: the wider extended-hours one only for an order that can trade outside the
   * regular session (an extended-hours limit); market and stop orders wait for it. `clock` is the time
   * the order is placed at (the broker's own clock, or the replay's ahead of it).
   */
  private expectedEntry(
    o: Pick<Order, 'symbol' | 'action' | 'type' | 'limitPrice' | 'stopPrice' | 'extendedHours'>,
    clock = this.s.clock,
  ): { price: number; quote: number; atOnce: boolean } {
    const last = this.s.lastPrice[o.symbol] ?? 0;
    const session = this.symbolSession(o.symbol, clock);
    const extended = session !== 'regular' && o.type === 'limit' && !!o.extendedHours && this.cfg.allowExtendedHours;
    const hs = halfSpread(this.cfg, last, extended);
    const buy = actionSide(o.action) === 'buy';
    const quote = last + (buy ? hs : -hs);
    if (o.type === 'market') return { price: quote, quote, atOnce: false };
    const own = o.type === 'stop' ? o.stopPrice! : o.limitPrice!;
    // Already through the market, it fills near the quote: at once, or at the next bar's open (about
    // the same price) in next-bar-open mode.
    if ((o.type === 'stop' || o.type === 'limit') && this.eligible(o, session) && this.triggerLevel(o as Order, last, last, session !== 'regular') !== null) {
      const atQuote = buy ? ceilTick(quote) : floorTick(quote);
      return { price: o.type === 'stop' ? atQuote : buy ? Math.min(own, atQuote) : Math.max(own, atQuote), quote, atOnce: true };
    }
    return { price: own, quote, atOnce: false };
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
    const x = o.type === 'market' || expected.atOnce ? last : o.stopPrice!;
    const volume = this.s.lastBar[symbol]?.volume ?? 0;
    const qty = Math.min(o.quantity, this.barCapacity(volume, this.s.barVolumeUsed?.[symbol] ?? 0));
    // Market and stop orders only trade in the regular session, at its spread.
    return this.marketFill(actionSide(o.action), x, qty, volume, false).price;
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
   * same level fire in the order they were placed, except that a Buy or Short meeting a position the
   * other way goes last: an exit at that level (a stop at the other side's entry, a gap through both)
   * flattens the position first, so the entry then opens the new trade instead of being cancelled.
   */
  private nextTrigger(symbol: string, from: number, to: number, session: MarketSession, skip: Set<string>): Trigger | null {
    let best: Trigger | null = null;
    let bestLate = false;
    const ext = session !== 'regular';
    const q = this.position(symbol).quantity;
    for (const o of this.liveOrders()) {
      if (o.symbol !== symbol || o.status === 'pending' || !isOpen(o) || skip.has(o.id)) continue;
      if (!this.eligible(o, session)) continue;
      const level = this.triggerLevel(o, from, to, ext);
      if (level === null) continue;
      const distance = Math.abs(level - from);
      const late = (o.action === 'buy' && q < 0) || (o.action === 'short' && q > 0);
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
      const through = this.cfg.limitFill === 'trade_through' ? TICK : 0;
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
    const filled = this.execute(o, level, this.s.clock, capacity, bar.volume, session !== 'regular', skip, 'placed', this.s.clock);
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
      o.status = 'cancelled';
      o.rejectReason = `You were ${held} when it would have filled. ${o.action === 'buy' ? 'Cover the short before buying.' : 'Sell the long before shorting.'}`;
      o.conflict = true;
      o.updatedAt = time;
      this.log('cancelled', `${describe(o)} cancelled: you were ${held} when it would have filled`, o.id);
      skip.add(o.id);
      return 0;
    }

    if (o.type === 'stop_limit' && !o.triggered) {
      o.triggered = true;
      o.updatedAt = time;
      this.log('triggered', `${describe(o)} triggered at ${x.toFixed(2)}; now a limit at ${o.limitPrice!.toFixed(2)}`, o.id);
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
      const L = o.limitPrice!;
      price = side === 'buy' ? Math.min(L, ceilTick(x + hs)) : Math.max(L, floorTick(x - hs));
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
      // Flat: any remaining exit orders for this symbol are orphans.
      for (const x of this.liveOrders()) {
        if (x.symbol === symbol && isOpen(x) && !isOpeningAction(x.action)) {
          x.status = 'cancelled';
          x.rejectReason = 'Position closed';
          x.updatedAt = fill.time;
          this.log('cancelled', `${describe(x)} cancelled: position closed`, x.id);
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
function throughTheMarket(error: string, type: OrderType, price: number, fill: ExecutionConfig['marketOrderFill']): string {
  return `${error.replace(/\.$/, '')}: this ${type === 'stop' ? 'stop' : 'limit'} is already through the market, so it would fill ${fill === 'last_price' ? 'at once' : "at the next bar's open"} at about ${formatTick(price)}.`;
}

/** The price an entry order was placed at: its limit, its stop, or for a market order the price it was checked against. */
function plannedPrice(o: Order): number | undefined {
  return o.type === 'limit' ? o.limitPrice : o.type === 'market' ? o.quotedPrice : o.stopPrice;
}

export function describe(o: Order): string {
  const px =
    o.type === 'market'
      ? 'MKT'
      : o.type === 'limit'
        ? `LMT ${o.limitPrice?.toFixed(2)}`
        : o.type === 'stop'
          ? `STP ${o.stopPrice?.toFixed(2)}`
          : `STP ${o.stopPrice?.toFixed(2)} LMT ${o.limitPrice?.toFixed(2)}`;
  return `${o.action.toUpperCase()} ${o.quantity} ${o.symbol} ${px}`;
}
