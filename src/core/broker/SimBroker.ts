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
  Position,
  RoundTrip,
  Side,
  UnixSeconds,
} from '../types';
import { actionSide } from '../types';
import type { ExecutionConfig } from './config';
import { DEFAULT_EXECUTION_CONFIG, commissionFor, halfSpread } from './config';
import { assessRisk, strictRiskViolation } from '../risk/risk';
import { roundToTick } from '../util/math';
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
}

const TICK = 0.01;
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
    for (const o of this.workingOrders()) {
      if (!isOpeningAction(o.action)) continue;
      const ref = o.limitPrice ?? o.stopPrice ?? this.s.lastPrice[o.symbol] ?? 0;
      reserved += (o.quantity - o.filledQty) * ref;
    }
    return Math.max(0, acct.buyingPower - reserved);
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
    // Market orders are checked against the price they would actually get: buys pay the ask, sells hit the bid.
    const marketRef = last + (actionSide(req.action) === 'buy' ? 1 : -1) * halfSpread(this.cfg, last, this.currentSession() !== 'regular');
    const refPrice = req.type === 'market' ? marketRef : req.type === 'stop' ? req.stopPrice! : req.limitPrice!;

    if (opening) {
      const risk = assessRisk({
        action: req.action,
        quantity: qty,
        entryPrice: refPrice,
        stopLoss: req.stopLoss,
        takeProfit: req.takeProfit,
        equity: this.account().equity,
        commissionEstimate: commissionFor(this.cfg, qty, refPrice),
      });
      if (risk.errors.length) return reject(risk.errors[0]);
      const acct = this.account();
      const violation = strictRiskViolation(this.cfg.strictRisk, risk, { dayPnl: acct.dayPnl, dayStartEquity: this.s.dayStartEquity });
      if (violation) return reject(violation);
      warnings.push(...risk.warnings);
      const needed = qty * refPrice;
      const avail = this.availableBuyingPower();
      if (needed > avail + 0.005) return reject(`Insufficient buying power: need $${needed.toFixed(2)}, have $${avail.toFixed(2)}.`);
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
    };
    const session = this.currentSession();
    if (!this.eligible(order, session)) {
      order.status = 'pending';
      warnings.push(
        marketSession(now) === 'regular'
          ? 'The market is just opening: the order works from the first regular-hours bar (market orders fill at its open).'
          : session === 'closed' || order.type !== 'limit' || !order.extendedHours
            ? 'Market is not in regular hours. The order will work from the next regular session.'
            : 'Order queued.',
      );
    }
    this.s.orders.push(order);
    this.log('accepted', `${describe(order)} accepted`, order.id);

    if (this.cfg.marketOrderFill === 'last_price' && order.status === 'working') this.tryImmediate(order);
    this.touch();
    return { ok: true, order: { ...order }, warnings };
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
    if (changes.limitPrice !== undefined) {
      if (!(changes.limitPrice > 0) || (o.type !== 'limit' && o.type !== 'stop_limit')) return { ok: false, error: 'Invalid limit price.' };
      o.limitPrice = roundToTick(changes.limitPrice);
    }
    if (changes.stopPrice !== undefined) {
      if (!(changes.stopPrice > 0) || (o.type !== 'stop' && o.type !== 'stop_limit')) return { ok: false, error: 'Invalid stop price.' };
      o.stopPrice = roundToTick(changes.stopPrice);
    }
    if (changes.quantity !== undefined) o.quantity = changes.quantity;
    o.updatedAt = this.s.clock;
    this.log('info', `${describe(o)} modified`, o.id);
    if (this.cfg.marketOrderFill === 'last_price' && o.status === 'working') this.tryImmediate(o);
    this.touch();
    return { ok: true };
  }

  /** Flatten a position with a market order (cancels its bracket orders first). */
  closePosition(symbol: string): SubmitResult {
    const pos = this.position(symbol);
    if (pos.quantity === 0) return { ok: false, error: 'No position.', warnings: [] };
    for (const o of this.workingOrders(symbol)) if (!isOpeningAction(o.action)) this.cancel(o.id, 'Position closed manually');
    return this.submit({ symbol, action: pos.quantity > 0 ? 'sell' : 'cover', type: 'market', quantity: Math.abs(pos.quantity), tif: 'day' });
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

  private currentSession(): MarketSession {
    const lb = this.latestBarTime();
    return lb === null ? 'closed' : marketSession(lb);
  }

  private latestBarTime(): number | null {
    let t: number | null = null;
    for (const b of Object.values(this.s.lastBar)) if (t === null || b.time > t) t = b.time;
    return t;
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

  private eligible(o: Order, session: MarketSession): boolean {
    if (session === 'regular') return true;
    if (session === 'closed') return false;
    return this.cfg.allowExtendedHours && o.extendedHours && o.type === 'limit';
  }

  /** Advance the broker's clock without a bar (e.g. sim market ticks); rolls the trading day. */
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

    const path = this.intrabarPath(symbol, bar);
    let capacity = this.cfg.maxParticipation > 0 ? Math.floor(bar.volume * this.cfg.maxParticipation) : Infinity;
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
      for (let guard = 0; guard < 200 && capacity > 0; guard++) {
        const trig = this.nextTrigger(symbol, pos, end, session, skip);
        if (!trig) break;
        pos = trig.level;
        const segLen = Math.abs(end - path[seg]);
        const frac = (seg + (segLen > 0 ? Math.abs(pos - path[seg]) / segLen : 0)) / (path.length - 1);
        const t = bar.time + Math.min(barSeconds - 1, Math.floor(barSeconds * frac));
        reach(pos);
        const used = this.execute(trig.order, pos, t, capacity, bar.volume, ext, skip);
        capacity -= used;
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

  /** Finds the working order that fires first as price moves from `from` toward `to`. */
  private nextTrigger(symbol: string, from: number, to: number, session: MarketSession, skip: Set<string>): Trigger | null {
    let best: Trigger | null = null;
    const ext = session !== 'regular';
    for (const o of this.liveOrders()) {
      if (o.symbol !== symbol || o.status === 'pending' || !isOpen(o) || skip.has(o.id)) continue;
      if (!this.eligible(o, session)) continue;
      const level = this.triggerLevel(o, from, to, ext);
      if (level === null) continue;
      const distance = Math.abs(level - from);
      if (!best || distance < best.distance - EPS) best = { order: o, level, distance };
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

  /** Try to fill an order right now at the last price (market orders, marketable limits, passed stops). */
  private tryImmediate(o: Order): void {
    const bar = this.s.lastBar[o.symbol];
    const last = this.s.lastPrice[o.symbol];
    if (!bar || last === undefined) return;
    const session = marketSession(bar.time);
    if (!this.eligible(o, session)) return;
    const level = this.triggerLevel(o, last, last, session !== 'regular');
    if (level === null) return;
    const capacity = this.cfg.maxParticipation > 0 ? Math.floor(bar.volume * this.cfg.maxParticipation) : Infinity;
    const skip = new Set<string>();
    this.execute(o, level, this.s.clock, capacity, bar.volume, session !== 'regular', skip);
    // A stop-limit may have triggered without filling; that's fine, it now rests as a limit.
  }

  /**
   * Execute an order that fired at path price `x`. Returns shares filled (0 if it only triggered
   * or could not fill). Adds the order to `skip` when it should not be reconsidered this bar.
   */
  private execute(o: Order, x: number, time: UnixSeconds, capacity: number, barVolume: number, ext: boolean, skip: Set<string>): number {
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
      const quote = side === 'buy' ? x + hs : x - hs;
      const impactPct = barVolume > 0 ? (qty / barVolume) * 100 : 0;
      const slipBps = this.cfg.slippage.bps + this.cfg.slippage.impactBpsPerPctOfVolume * impactPct;
      const slip = (quote * slipBps) / 10_000;
      price = side === 'buy' ? ceilTick(quote + slip) : floorTick(quote - slip);
      slippage = Math.abs(price - quote) * qty;
    } else {
      // Limit (or triggered stop-limit): never worse than the limit; better if the market gapped through.
      const L = o.limitPrice!;
      price = side === 'buy' ? Math.min(L, ceilTick(x + hs)) : Math.max(L, floorTick(x - hs));
    }
    const spreadCost = hs * qty;

    this.applyFill(o, qty, price, time, slippage, spreadCost);
    if (isOpen(o)) skip.add(o.id); // partially filled: capacity exhausted for this bar
    return qty;
  }

  private applyFill(o: Order, qty: number, price: number, time: UnixSeconds, slippage: number, spreadCost: number): void {
    const side: Side = actionSide(o.action);
    // The fee for everything this order has filled, less what its earlier partial fills paid: the
    // per-order fee and minimum are charged once per order, not once per fill.
    const filled = o.filledQty + qty;
    const paid = o.commission ?? 0;
    const commission = Math.max(0, Math.round((commissionFor(this.cfg, filled, (o.avgFillPrice * o.filledQty + price * qty) / filled) - paid) * 100) / 100);
    o.commission = money(paid + commission);
    const symbol = o.symbol;
    const pos = this.s.positions[symbol] ?? { symbol, quantity: 0, avgPrice: 0, realizedPnl: 0 };
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
      if (trip.initialStop === undefined && o.stopLoss !== undefined) trip.initialStop = o.stopLoss;
      if (trip.initialTarget === undefined && o.takeProfit !== undefined) trip.initialTarget = o.takeProfit;
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
