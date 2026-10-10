/**
 * Post-trade review for Learning Mode.
 *
 * Everything here is computed from facts that exist at review time: the trade's fills and the bars
 * revealed so far. "After exit" analysis only uses bars that have already been revealed in the
 * replay, and is explicitly labelled "so far". The review explains what happened; it never says what
 * trade should have been taken next.
 */
import type { Bar, EquityPoint, Fill, Order, RoundTrip, Timeframe } from '../types';
import { aggregateBars } from '../data/aggregate';
import { atr } from '../indicators/indicators';
import { entryPastStop, entryPastTarget, equityBeforeEntry, initialRiskPerShare, plannedRR, plannedRRGap, rMultiple, riskBasis, type RRGap } from '../analytics/stats';
import { exchangeDate, exchangeMinuteOfDay, exchangeTimeToUnix, formatDuration, REGULAR_CLOSE, REGULAR_OPEN } from '../time';
import { formatTick, sameAtTick } from '../util/math';
import { pctAgainst } from '../risk/risk';

/** Moved to analytics, where the broker's Strict Mode measures a trade's risk against it too. */
export { equityBeforeEntry };

export interface TradingRules {
  maxRiskPctPerTrade: number;
  requireStopLoss: boolean;
  minRewardRisk: number;
  maxTradesPerDay: number;
  /** No new trades in the first N minutes after the open (0 = off). */
  noTradesFirstMinutes: number;
  maxDailyLossPct: number;
  /** Your own rules, in your words ("Only trade with the trend"): you say on each trade's review whether you followed them. */
  custom?: string[];
}

export const DEFAULT_TRADING_RULES: TradingRules = {
  maxRiskPctPerTrade: 1,
  requireStopLoss: true,
  minRewardRisk: 1.5,
  maxTradesPerDay: 5,
  noTradesFirstMinutes: 0,
  maxDailyLossPct: 3,
  custom: [],
};

export type ExitReason = 'stop_loss' | 'take_profit' | 'manual' | 'session_end' | 'other';

export interface Excursion {
  perShare: number;
  dollars: number;
  pct: number;
  r: number | null;
}

export interface Finding {
  tone: 'good' | 'bad' | 'neutral';
  title: string;
  detail: string;
}

export interface RuleCheck {
  rule: string;
  passed: boolean | null;
  detail: string;
  /** One of your own rules: the app cannot check it, so you say whether you followed it (JournalEntry.ruleChecks). */
  own?: boolean;
}

export interface TradeReview {
  tripId: string;
  outcome: 'win' | 'loss' | 'breakeven';
  exitReason: ExitReason;
  rMultiple: number | null;
  plannedRR: number | null;
  mfe: Excursion;
  mae: Excursion;
  /** Share of the best open profit that was kept (null when MFE is 0). */
  capturePct: number | null;
  /** The planned risk to the initial stop (the R unit). */
  riskDollars: number | null;
  riskPctOfEquity: number | null;
  /** The risk rule's limit (%) when the review was made, so a percentage over it reads as over. Absent on older reviews. */
  riskLimitPct?: number;
  /** Adds past the initial stop moved the average entry past it: the trade risked more than planned. */
  addedPastStop?: boolean;
  /**
   * The most the trade had at stake over its life (riskOverLife), when that was more than the risk
   * planned to its first stop, or that could not be measured. Absent on older reviews.
   */
  largestRiskDollars?: number;
  largestRiskPct?: number | null;
  /** Some shares had no working stop after the trade had one (RoundTrip.unprotectedAt). Absent on older reviews. */
  unprotected?: boolean;
  equityAtEntry: number;
  atrAtEntry: number | null;
  stopDistanceAtr: number | null;
  targetDistanceAtr: number | null;
  /** While price after the exit is still being watched: when the window ends (afterExit is null until then). */
  afterExitUntil?: number;
  afterExit: {
    barsObserved: number;
    /** What was watched: the window ("20 minutes") or, when the replay ended first, the bars it showed. */
    span?: string;
    /** Best price move in the trade's direction after the exit, per share. */
    favorableMove: number;
    adverseMove: number;
    reachedOriginalTarget: boolean;
  } | null;
  findings: Finding[];
  rules: RuleCheck[];
}

/** One order's share of a trade's exit: the shares it closed and their average price. */
interface ExitPart {
  order: Order;
  qty: number;
  price: number;
}

/** The orders that closed the trade, in the order they first filled. */
function exitParts(trip: RoundTrip, fills: readonly Fill[], orders: readonly Order[]): ExitPart[] {
  const ids = new Set(trip.fills);
  const closing = trip.direction === 'long' ? 'sell' : 'cover';
  const parts = new Map<string, ExitPart>();
  for (const f of fills) {
    if (!ids.has(f.id) || f.action !== closing) continue;
    const p = parts.get(f.orderId);
    if (p) {
      p.price = (p.price * p.qty + f.price * f.quantity) / (p.qty + f.quantity);
      p.qty += f.quantity;
      continue;
    }
    const order = orders.find((o) => o.id === f.orderId);
    if (order) parts.set(f.orderId, { order, qty: f.quantity, price: f.price });
  }
  return [...parts.values()];
}

/** The part that closed the most shares; on a tie, the later one, which finished the exit. */
function mainExit(parts: readonly ExitPart[]): ExitPart | undefined {
  return parts.reduce<ExitPart | undefined>((best, p) => (!best || p.qty >= best.qty ? p : best), undefined);
}

const isStop = (o: Order) => o.type === 'stop' || o.type === 'stop_limit';

/**
 * How the trade was closed, by the order that closed most of it: a stop order (bracket or placed
 * separately) is the stop loss, a limit that took profit or filled at the original target is the
 * target, a market order is a manual exit (unless the app placed it when the session ended), and any
 * other limit is just an exit order.
 */
export function exitReasonOf(trip: RoundTrip, fills: readonly Fill[], orders: readonly Order[]): ExitReason {
  const main = mainExit(exitParts(trip, fills, orders));
  if (!main) return 'other';
  if (main.order.sessionEnd) return 'session_end';
  if (isStop(main.order)) return 'stop_loss';
  if (main.order.type === 'limit') {
    const dir = trip.direction === 'long' ? 1 : -1;
    const profit = (main.price - trip.avgEntry) * dir > 0;
    const atTarget = trip.initialTarget !== undefined && (main.price - trip.initialTarget) * dir >= -1e-9;
    return profit || atTarget ? 'take_profit' : 'other';
  }
  return 'manual';
}

export function equityAt(curve: readonly EquityPoint[], time: number, fallback: number): number {
  let eq = fallback;
  for (const p of curve) {
    if (p.time > time) break;
    eq = p.equity;
  }
  return eq;
}

/** What a trade had at stake over its life: see riskOverLife. */
export interface LifeRisk {
  /** The largest of the measures below that is known, in dollars; null when none is. */
  dollars: number | null;
  /** More was at risk to its working stops, as some bar began, than was planned to its first stop. */
  grew: boolean;
  /** Its open loss before its stop came (placed after entry, or with an add) was more than either. */
  beforeStop: boolean;
  /** Some shares had no working stop after the trade had one: the loss on them was not limited. */
  unprotected: boolean;
}

/**
 * The most a trade had at stake over its life, as its review, its risk rule and the challenges count
 * it: the larger of the risk planned to its first stop (`planned`, in dollars), the most at risk to its
 * working stops as any bar began (a stop moved further away, shares added with a wider stop:
 * RoundTrip.maxRisk), and, when its stop came after entry, the largest open loss it had before that
 * (RoundTrip.lossBeforeStop). Trades recorded before these were tracked have only the planned risk.
 */
export function riskOverLife(trip: RoundTrip, planned: number | null): LifeRisk {
  const known = [planned, trip.maxRisk, trip.lossBeforeStop].filter((x): x is number => x !== null && x !== undefined);
  const dollars = known.length ? Math.max(...known) : null;
  const atStops = Math.max(planned ?? 0, trip.maxRisk ?? 0);
  return {
    dollars,
    grew: trip.maxRisk !== undefined && trip.maxRisk > (planned ?? 0) + 0.005,
    beforeStop: trip.lossBeforeStop !== undefined && trip.lossBeforeStop > atStops + 0.005,
    unprotected: trip.unprotectedAt !== undefined,
  };
}

/**
 * When some of the trade's shares were first left with no working stop (RoundTrip.unprotectedAt), as
 * time after its entry, never as a date: a blind replay hides the date, and this text is stored.
 */
export function unprotectedSince(trip: RoundTrip): string {
  const s = (trip.unprotectedAt ?? trip.entryTime) - trip.entryTime;
  return s < 60 ? 'less than a minute after entry' : `${formatDuration(s)} after entry`;
}

/** An excursion of `dollars` (open P/L), also per share, as % of the position and in R, at the trade's full size. */
function excursion(dollars: number, trip: RoundTrip, riskPerShare: number | null): Excursion {
  const size = trip.maxQuantity;
  return {
    perShare: size > 0 ? dollars / size : 0,
    dollars,
    pct: trip.avgEntry > 0 && size > 0 ? (dollars / (trip.avgEntry * size)) * 100 : 0,
    r: riskPerShare && size > 0 ? dollars / (riskPerShare * size) : null,
  };
}

const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
const signed = (v: number) => `${v < -0.005 ? '−' : '+'}$${Math.abs(v).toFixed(2)}`;

/**
 * How long price is watched after an exit before the review says whether the stop was well placed,
 * per chart timeframe: a fixed stretch, so the verdict does not depend on how fast the replay moved.
 */
export const AFTER_EXIT_WINDOW: Record<Timeframe, { seconds: number; label: string }> = {
  '1m': { seconds: 20 * 60, label: '20 minutes' },
  '5m': { seconds: 2 * 3600, label: '2 hours' },
  '15m': { seconds: 5 * 3600, label: '5 hours' },
  '30m': { seconds: 10 * 3600, label: '10 hours' },
  '1h': { seconds: 24 * 3600, label: '24 hours' },
  '4h': { seconds: 3 * 86400, label: '3 days' },
  '1D': { seconds: 28 * 86400, label: '4 weeks' },
};

export interface ReviewInput {
  trip: RoundTrip;
  fills: readonly Fill[];
  orders: readonly Order[];
  /** Revealed base bars only (the replay's visible tape). */
  revealedBars: readonly Bar[];
  timeframe: Timeframe;
  /** The bars' own size (default 1m): at that timeframe each bar is its own candle. */
  baseTimeframe?: Timeframe;
  equityCurve: readonly EquityPoint[];
  startingBalance: number;
  allTrips: readonly RoundTrip[];
  rules: TradingRules;
  /**
   * The replay clock. While it is inside the after-exit window the verdict waits (afterExitUntil);
   * without it the bars given are taken as all there is.
   */
  now?: number;
  /** The session is over: give the verdict on the bars shown, even if the window is not. */
  ended?: boolean;
}

export function reviewTrade(input: ReviewInput): TradeReview {
  const { trip, rules } = input;
  const long = trip.direction === 'long';
  const riskPerShare = initialRiskPerShare(trip);
  // Prices are written to their tick (4 decimals below $1), distances to the stock's.
  const tick = trip.avgEntry < 1 ? 0.0001 : 0.01;
  const dist = (v: number) => v.toFixed(tick < 0.01 ? 4 : 2);
  const r = rMultiple(trip);
  const rr = plannedRR(trip);
  // The best price reached, measured from the average entry like the target.
  const bestMove = Math.max(0, long ? trip.highWhileOpen - trip.avgEntry : trip.avgEntry - trip.lowWhileOpen);
  // Best and worst open P/L. Older trades without them: the price range at full size.
  const best = trip.bestOpenPnl ?? bestMove * trip.maxQuantity;
  const worst = trip.worstOpenPnl ?? -Math.max(0, long ? trip.avgEntry - trip.lowWhileOpen : trip.highWhileOpen - trip.avgEntry) * trip.maxQuantity;
  const mfe = excursion(Math.max(0, best), trip, riskPerShare);
  const mae = excursion(Math.max(0, -worst), trip, riskPerShare);
  const exitReason = exitReasonOf(trip, input.fills, input.orders);
  // A gap through both the entry order and its stop: R is measured from the order's price instead.
  const pastStop = entryPastStop(trip) && riskPerShare !== null;
  const pastTarget = entryPastTarget(trip);
  const basis = riskBasis(trip);
  const addedPastStop = basis?.from === 'first';
  const bracketEntry = trip.bracketEntry ?? trip.avgEntry;
  // The entry orders the stop and the target came with: the first one, or the add that brought them.
  const tripFills = trip.fills.map((id) => input.fills.find((f) => f.id === id));
  const entryOrders = tripFills.map((f) => f && input.orders.find((o) => o.id === f.orderId)).filter((o) => o?.action === 'buy' || o?.action === 'short');
  const stopOrder = (trip.stopFromAdd && entryOrders.find((o) => o?.stopLoss !== undefined)) || entryOrders[0];
  const targetOrder = entryOrders.find((o) => o?.takeProfit !== undefined) ?? entryOrders[0];
  /** An entry order's own price (its limit, else its stop; a market order has none). */
  const ownPrice = (o: Order | undefined) => (!o || o.type === 'market' ? undefined : o.type === 'limit' ? o.limitPrice : o.stopPrice);
  /** The order was checked at, and expected to fill near, a price other than its own (already through the market, or a stop-limit's limit). */
  const expectedElsewhere = (o: Order | undefined, planned: number | undefined) => {
    const own = ownPrice(o);
    return own !== undefined && planned !== undefined && Math.abs(planned - own) > 1e-9;
  };
  // How that order came to fill past its own stop or target: a gap at a bar's open (also older trades,
  // which did not record it), the spread and slippage, a limit through the market, or price moving past
  // both before the order could fill (an order placed while a daily bar was still hidden).
  /** Index of the revealed bar holding time `t`, or -1. */
  const barAt = (t: number) => {
    const bars = input.revealedBars;
    let lo = 0;
    let hi = bars.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].time <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  /** Where an order that fired with no room left in the bar starting at `noRoom` first filled, at `filled`: the next bar's open, or a later one's. */
  const openAfter = (noRoom: number, filled: number) => {
    const a = barAt(noRoom);
    const b = barAt(filled);
    return a >= 0 && b >= 0 && b - a <= 1 ? "the next bar's open" : "a later bar's open";
  };
  const entryPast = (order: Order | undefined, planned: number | undefined, price: number, what: 'stop' | 'target', level: number): { text: string; gap: boolean } => {
    const fill = order && tripFills.find((f) => f?.orderId === order.id);
    const market = order?.type === 'market';
    const name = order && order !== entryOrders[0] ? (market ? 'market add' : 'add') : market ? 'market order' : 'entry order';
    const own = ownPrice(order);
    const at = own !== undefined ? ` at ${formatTick(own)}` : planned !== undefined ? ` at ${formatTick(planned)}` : '';
    // Capped by bar volume, the order filled in parts and only the later ones went past the level.
    const parts = tripFills.filter((f) => f && order && f.orderId === order.id).length;
    const sign = long ? 1 : -1;
    if (fill && parts > 1 && (what === 'target' ? (fill.price - level) * sign : (level - fill.price) * sign) < 0) {
      return {
        gap: false,
        text: `Your ${name}${at} filled in ${parts} parts, each capped at a share of a bar's volume (Data & Settings), and the later parts filled past your ${what} at ${formatTick(level)}, for an average of ${formatTick(price)}.`,
      };
    }
    // A stop or stop-limit entry that fired with no room left under its bar's volume cap filled from a later bar.
    if (fill && order?.noRoomBar !== undefined && fill.at === 'open') {
      return {
        gap: true,
        text: `Your ${name}${at} fired on a bar whose volume cap (Data & Settings) left no room for it, so it filled from ${openAfter(order.noRoomBar, fill.time)}, at ${formatTick(fill.price)}, already past your ${what} at ${formatTick(level)}${parts > 1 ? `, for an average of ${formatTick(price)}` : ''}.`,
      };
    }
    if (!fill?.at || fill.at === 'open') {
      return {
        gap: true,
        text: market
          ? `Your ${name} was placed${planned !== undefined ? ` with price at ${formatTick(planned)}` : ''} and filled at the next open, ${formatTick(price)}, already past your ${what} at ${formatTick(level)}.`
          : expectedElsewhere(order, planned)
            ? `Your ${name}${at} was expected to fill near ${formatTick(planned!)}, but price gapped past your ${what} at ${formatTick(level)} before it could, so it filled at ${formatTick(price)}.`
            : `Price gapped through both your ${name}${at} and your ${what} at ${formatTick(level)}, so it filled at ${formatTick(price)}.`,
      };
    }
    // The market price before this fill's spread and slippage: if that was short of the level, the costs carried it past.
    const before = price - (sign * (fill.slippage + fill.spreadCost)) / fill.quantity;
    if ((what === 'target' ? (before - level) * sign : (level - before) * sign) < 0) {
      return { gap: false, text: `Your ${name}${at} filled at ${formatTick(price)}, past your ${what} at ${formatTick(level)}: the spread and slippage of the fill alone carried it past a ${what} that close.` };
    }
    if (fill.at === 'placed') return { gap: false, text: `Your ${name}${at} was already through the market, so it filled at once at ${formatTick(price)}, past your ${what} at ${formatTick(level)}.` };
    return { gap: false, text: `Your ${name}${at} filled at ${formatTick(price)}, already past your ${what} at ${formatTick(level)}: price was past both by the time the order could fill.` };
  };
  const gapNote = (what: string) => ` An order waiting for the next bar, or for the market to open, fills at that bar's open wherever price is, even past its own ${what}.`;
  const equityAtEntry = equityBeforeEntry(trip, input.fills, input.equityCurve, input.startingBalance);
  const riskDollars = riskPerShare !== null ? riskPerShare * trip.maxQuantity : null;
  const riskPctOfEquity = riskDollars !== null && equityAtEntry > 0 ? (riskDollars / equityAtEntry) * 100 : null;
  const life = riskOverLife(trip, riskDollars);
  const lifePct = life.dollars !== null && equityAtEntry > 0 ? (life.dollars / equityAtEntry) * 100 : null;
  // More at stake at some point than planned (or a measure where the plan had none).
  const largest = life.dollars !== null && (riskDollars === null || life.dollars > riskDollars + 0.005) ? life.dollars : null;

  // ATR on the trading timeframe, from candles that had completed before entry.
  const before = input.revealedBars.filter((b) => b.time < trip.entryTime);
  const candles = aggregateBars(before, input.timeframe, input.baseTimeframe);
  const atrSeries = atr(candles, 14);
  const atrAtEntry = atrSeries.length && !Number.isNaN(atrSeries[atrSeries.length - 1]) ? atrSeries[atrSeries.length - 1] : null;
  const stopDistanceAtr = atrAtEntry && riskPerShare ? riskPerShare / atrAtEntry : null;
  // An entry that filled past its own target has no distance left to it.
  const targetDistance = trip.initialTarget !== undefined && !pastTarget ? Math.abs(trip.initialTarget - trip.avgEntry) : null;
  const targetDistanceAtr = atrAtEntry && targetDistance ? targetDistance / atrAtEntry : null;

  // After-exit tape over a fixed window, revealed bars only. Until the replay has shown the whole
  // window the verdict waits, so it does not depend on how far one step or jump went.
  let afterExit: TradeReview['afterExit'] = null;
  let afterExitUntil: number | undefined;
  if (trip.closed && trip.exitTime !== undefined && trip.avgExit !== undefined) {
    const window = AFTER_EXIT_WINDOW[input.timeframe];
    const until = trip.exitTime + window.seconds;
    const post = input.revealedBars.filter((b) => b.time >= trip.exitTime! && b.time < until);
    const whole = input.now === undefined || input.now >= until;
    if (!whole && !input.ended) afterExitUntil = until;
    else if (post.length) {
      const hi = post.reduce((m, b) => Math.max(m, b.high), -Infinity);
      const lo = post.reduce((m, b) => Math.min(m, b.low), Infinity);
      afterExit = {
        barsObserved: post.length,
        span: whole ? window.label : `${post.length} bar${post.length === 1 ? '' : 's'} the replay showed`,
        favorableMove: Math.max(0, long ? hi - trip.avgExit : trip.avgExit - lo),
        adverseMove: Math.max(0, long ? trip.avgExit - lo : hi - trip.avgExit),
        reachedOriginalTarget: trip.initialTarget !== undefined && (long ? hi >= trip.initialTarget : lo <= trip.initialTarget),
      };
    }
  }

  const findings: Finding[] = [];
  const outcome: TradeReview['outcome'] = trip.pnl > 0.005 ? 'win' : trip.pnl < -0.005 ? 'loss' : 'breakeven';
  const rText = r !== null ? ` (${r >= 0 ? '+' : ''}${r.toFixed(2)}R)` : '';
  const dir = long ? 1 : -1;
  const parts = exitParts(trip, input.fills, input.orders);
  // A limit exit at or beyond the original target reached it.
  const reachedTarget = (p: ExitPart) => trip.initialTarget !== undefined && p.order.type === 'limit' && (p.price - trip.initialTarget) * dir >= -1e-9;
  findings.push({
    tone: outcome === 'win' ? 'good' : outcome === 'loss' ? 'bad' : 'neutral',
    title: `${outcome === 'win' ? 'Won' : outcome === 'loss' ? 'Lost' : 'Broke even'} ${money(Math.abs(trip.pnl))}${rText}`,
    detail: `${long ? 'Long' : 'Short'} ${trip.maxQuantity} @ ${formatTick(trip.avgEntry)}, exited @ ${(trip.avgExit !== undefined ? formatTick(trip.avgExit) : '—')} ${
      parts.length > 1
        ? `in ${parts.length} parts`
        : `via ${{ stop_loss: 'your stop loss', take_profit: 'your profit target', manual: 'a manual exit', session_end: 'the close at the last price when the session ended', other: 'an exit order' }[exitReason]}`
    }. While open, the trade was at best ${signed(best)} and at worst ${signed(worst)} (before costs).`,
  });
  if (parts.length > 1) {
    const how = (p: ExitPart) =>
      p.order.sessionEnd ? 'when the session ended' : isStop(p.order) ? 'by your stop' : reachedTarget(p) ? 'at your target' : p.order.type === 'limit' ? 'by a limit order' : 'at market';
    findings.push({
      tone: 'neutral',
      title: 'Closed in parts',
      detail: `${parts.map((p) => `${p.qty} ${how(p)} at ${formatTick(p.price)}`).join(', then ')}. The rest of this review goes by the order that closed the most shares.`,
    });
  }

  const avgOf = (fs: Fill[]) => {
    const n = fs.reduce((a, f) => a + f.quantity, 0);
    return n > 0 ? fs.reduce((a, f) => a + f.price * f.quantity, 0) / n : undefined;
  };
  const entries = tripFills.filter((f): f is Fill => f?.action === 'buy' || f?.action === 'short');

  /**
   * What a stop at the average entry (written to the stop's tick, riskBasis) risked before costs: nothing
   * when the average was the stop's price or past it, a fraction of a tick when it was just short of it.
   */
  const sliver = (S: number) => ((trip.avgEntry - S) * (long ? 1 : -1) > 1e-9 ? (S >= 1 ? 'less than half a cent a share' : 'less than $0.00005 a share') : 'nothing');

  /**
   * Why the stop a later add brought sat at or past the trade's average entry: the average was the stop's
   * price, the shares bought before it were already past it (it locked in a gain), the add itself filled
   * past it, or later adds moved the average.
   */
  const stopPastAverage = (S: number): string => {
    const at = entries.findIndex((f) => f.orderId === stopOrder?.id);
    const before = avgOf(at > 0 ? entries.slice(0, at) : []);
    const add = avgOf(entries.filter((f) => f.orderId === stopOrder?.id));
    const sign = long ? 1 : -1;
    const lead = `Your stop at ${formatTick(S)} came with a later add`;
    const end = "so the trade's risk cannot be measured in R.";
    if (sameAtTick(trip.avgEntry, S)) {
      return `${lead}, and your average entry came to the stop's own price: it risked ${sliver(S)} before costs, ${end}`;
    }
    if (before !== undefined && (before - S) * sign < -1e-9) {
      return `${lead}, and it sat past your average entry of ${formatTick(trip.avgEntry)}: it locked in a gain on your earlier shares rather than capping a loss, ${end}`;
    }
    if (add !== undefined && (add - S) * sign < -1e-9) {
      return `${lead}, which filled at ${formatTick(add)}, already past it, and your average entry of ${formatTick(trip.avgEntry)} ended up past it too, ${end}`;
    }
    return `${lead}, and shares added after it took your average entry to ${formatTick(trip.avgEntry)}, past that stop, ${end}`;
  };

  /**
   * Why a stop placed on its own after entry sat at or past the trade's average entry: it was placed at the
   * average (a breakeven stop) or past it (locking in a gain), or it was placed with a loss to cap and
   * shares added after it took the average to it or past it.
   */
  const laterStopPastAverage = (S: number, placedAt: number): string => {
    const sign = long ? 1 : -1;
    const placed = formatDuration(placedAt - trip.entryTime);
    const end = "so the trade's risk cannot be measured in R.";
    const atAverage = sameAtTick(trip.avgEntry, S);
    // The average of the shares held when it was placed: the entries known by then.
    const then = avgOf(entries.filter((f) => (f.knownAt ?? f.time) <= placedAt));
    if (then !== undefined && (then - S) * sign > 0 && !sameAtTick(then, S)) {
      return `Your stop at ${formatTick(S)} was placed ${placed} after you entered, ${long ? 'below' : 'above'} your average entry of ${formatTick(then)} then, but shares added after it took your average entry to ${formatTick(trip.avgEntry)}, ${atAverage ? "the stop's own price" : 'past that stop'}, ${end}`;
    }
    return atAverage
      ? `Your stop at ${formatTick(S)}, placed ${placed} after you entered, was at your average entry: it risked ${sliver(S)} before costs, ${end}`
      : `Your stop at ${formatTick(S)}, placed ${placed} after you entered, sat past your average entry of ${formatTick(trip.avgEntry)}: it locked in a gain rather than capping a loss, ${end}`;
  };

  if (riskPerShare === null) {
    const worstText = `The worst point of the trade was ${money(mae.dollars)} against you${
      equityAtEntry > 0 ? ` (${((mae.dollars / equityAtEntry) * 100).toFixed(2)}% of the account)` : ''
    }.`;
    findings.push(
      trip.initialStop === undefined
        ? { tone: 'bad', title: 'No stop loss', detail: `Your risk was undefined. ${worstText}` }
        : trip.stopPlacedAt !== undefined
          ? { tone: 'bad', title: 'Risk not measurable', detail: `${laterStopPastAverage(trip.initialStop, trip.stopPlacedAt)} ${worstText}` }
          : trip.stopFromAdd
          ? { tone: 'bad', title: 'No stop on your first entry', detail: `${stopPastAverage(trip.initialStop)} ${worstText}` }
          : { tone: 'bad', title: 'Risk not measurable', detail: `Your entry filled past your stop at ${formatTick(trip.initialStop)}, so the trade's risk cannot be measured in R. ${worstText}` },
    );
  } else if (stopDistanceAtr !== null) {
    const tight = stopDistanceAtr < 0.75;
    findings.push({
      tone: tight ? 'bad' : 'neutral',
      title: tight ? 'Stop was tight relative to normal movement' : 'Stop distance',
      detail: `Your stop was ${dist(riskPerShare)} away${
        basis?.from === 'planned'
          ? stopOrder?.type === 'market'
            ? ' from the price when you placed your order'
            : expectedElsewhere(stopOrder, basis.entry)
              ? ' from where your order was expected to fill'
              : ' from your order’s price'
          : basis?.from === 'first'
            ? ' from your first entry'
            : ''
      }, ${stopDistanceAtr.toFixed(2)}× the ATR(14) of ${input.timeframe} candles at entry (${atrAtEntry! < 0.01 ? atrAtEntry!.toFixed(4) : dist(atrAtEntry!)}).${
        tight ? ' Stops well inside one ATR are often hit by ordinary noise rather than by the setup failing.' : ''
      }`,
    });
  }

  // A stop placed as its own order after entry: how long the trade went without one, and what it cost.
  if (trip.stopPlacedAt !== undefined && trip.stopPlacedAt > trip.entryTime) {
    const lost = trip.lossBeforeStop ?? 0;
    const inR = riskDollars ? ` (${(lost / riskDollars).toFixed(2)}R)` : '';
    findings.push({
      tone: riskDollars === null ? (lost > 0.005 ? 'bad' : 'neutral') : lost > riskDollars + 0.005 ? 'bad' : 'neutral',
      title: `Stop placed ${formatDuration(trip.stopPlacedAt - trip.entryTime)} after entry`,
      detail: `Your stop at ${formatTick(trip.initialStop!)} was its own order, placed after you entered. Until then the trade had no stop, ${
        lost > 0.005 ? `and its open loss reached ${money(lost)}${inR}${riskDollars !== null && lost > riskDollars + 0.005 ? ', more than the stop then risked' : ''}` : 'though price did not go against you in that time'
      }. A stop loss set with the entry in the ticket protects a trade from its first moment.`,
    });
  }

  // Where the closing stop sat when it filled (it may have been moved since entry) and its fills.
  const main = mainExit(parts);
  const stopAt = main?.order.stopPrice;
  const exitPx = main?.price;
  /**
   * How far past the stop it filled (`past`), and whether that is more than slippage noise: two ticks of
   * the price it filled at beyond the half spread every fill pays (on a sub-dollar stock that alone is
   * many ticks), so rounding to the tick is not the fill going past the stop.
   */
  const stopSlip = (stop: number, px: number) => {
    const past = (stop - px) * dir;
    const mainFills = input.fills.filter((f) => f.orderId === main!.order.id && trip.fills.includes(f.id));
    const halfSpread = mainFills.reduce((a, f) => a + f.spreadCost, 0) / Math.max(1, mainFills.reduce((a, f) => a + f.quantity, 0));
    const beyond = past - halfSpread;
    return { past, beyond, slipped: beyond >= 2 * (px >= 1 ? 0.01 : 0.0001) - 1e-9 };
  };
  /** Why the closing stop could fill past its price. */
  const stopFillNote = () =>
    main!.order.type === 'stop_limit'
      ? `A stop-limit becomes a limit order at ${formatTick(main!.order.limitPrice!)} when price reaches its stop and fills at any price up to that limit, which can be well past the stop after a gap.`
      : 'A stop turns into a market order when price reaches it and fills at the next price available, which can be far away after a gap or for a large order in a thin bar.';
  if (exitReason === 'stop_loss' && riskPerShare && stopAt !== undefined && exitPx !== undefined) {
    const inR = (px: number) => ((px - trip.avgEntry) * dir) / riskPerShare;
    const fmtR = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
    // Filled well past the stop: also more than a quarter of the planned risk.
    const { past, beyond, slipped } = stopSlip(stopAt, exitPx);
    const filledPast = slipped && beyond > 0.25 * riskPerShare;
    // The closing stop is judged by its own history: the stop an add brought with it (its own bracket)
    // starts at that add's stop loss, any other at the first stop; a price other than its start is the
    // user's move.
    const parent = main!.order.parentId ? input.orders.find((o) => o.id === main!.order.parentId) : undefined;
    const fromAdd = parent !== undefined && parent.id !== trip.stopOrder?.id && parent.stopLoss !== undefined;
    const origin = fromAdd ? parent.stopLoss! : trip.initialStop!;
    const moved = Math.abs(stopAt - origin) > 1e-9;
    const widened = moved && (origin - stopAt) * dir > 0;
    const theStop = fromAdd ? (moved ? "your add's moved stop" : "your add's stop") : moved ? 'your moved stop' : 'your stop';
    // When an add's stop closed the trade, the first stop may still have been moved away as well.
    const firstStop = fromAdd && trip.stopOrder ? input.orders.find((o) => o.parentId === trip.stopOrder!.id && (o.type === 'stop' || o.type === 'stop_limit')) : undefined;
    const firstWidened = firstStop !== undefined && (trip.initialStop! - firstStop.stopPrice!) * dir > 1e-9;
    const addStopText = "the stop that came with your add";
    // A stop that fired is a market order: when the volume cap let only part of it trade there, the
    // rest filled over the next bars, here after price had come back past the stop.
    const stopParts = main!.order.type === 'stop' ? input.fills.filter((f) => f.orderId === main!.order.id) : [];
    const first = stopParts[0];
    // It fired with no room left under its bar's volume cap, so none of it filled on that bar.
    const noRoom = main!.order.noRoomBar;
    const noneThere = first !== undefined && noRoom !== undefined;
    if (!pastStop && (stopParts.length > 1 || noneThere) && (exitPx - stopAt) * dir > 0) {
      const Stop = `${theStop[0].toUpperCase()}${theStop.slice(1)} at ${formatTick(stopAt)}`;
      const after = `That helped this time; had price kept going, ${noneThere ? 'they' : 'the rest'} would have filled further past the stop. For a position this large against the stock's volume, a stop does not fix the exit price.`;
      findings.push({
        tone: 'neutral',
        title: noneThere ? 'Your stop fired, and it filled after price came back' : 'Your stop fired, and the rest filled after price came back',
        detail: noneThere
          ? `${Stop} fired on a bar whose volume cap (Data & Settings) left no room for it, so none of its ${main!.qty} shares could ${long ? 'sell' : 'be bought back'} there. A stop that has fired is a market order, so ${stopParts.length > 1 ? `they ${long ? 'sold' : 'were bought back'} over later bars as price came back, the first ${first.quantity} at ${openAfter(noRoom!, first.time)}, ${formatTick(first.price)}, for an average of ${formatTick(exitPx)}` : `they ${long ? 'sold' : 'were bought back'} at ${openAfter(noRoom!, first.time)}, ${formatTick(exitPx)}, after price had come back`}. ${after}`
          : `${Stop} fired, but the volume cap (Data & Settings) let only ${first.quantity} of its ${main!.qty} shares ${long ? 'sell' : 'be bought back'} on the bar it fired, at ${formatTick(first.price)}. A stop that has fired is a market order, so the rest ${long ? 'sold' : 'was bought back'} over the next bars as price came back, for an average of ${formatTick(exitPx)}. ${after}`,
      });
    }
    if (pastStop) {
      const how = entryPast(stopOrder, trip.plannedEntry, bracketEntry, 'stop', trip.initialStop!);
      findings.push({
        tone: 'neutral',
        title: 'Entry filled past your stop',
        detail: `${how.text} The stop then closed the trade at ${formatTick(exitPx)}: ${signed(trip.pnl)} after costs, ${fmtR(r ?? 0)} of the ${dist(riskPerShare)} per share you planned to risk.${how.gap ? gapNote('stop') : ''}`,
      });
    } else if ((moved || fromAdd) && inR(exitPx) >= 0) {
      findings.push({
        tone: trip.pnl > 0.005 ? 'good' : 'neutral',
        title: moved ? 'Your moved stop closed the trade' : "Your add's stop closed the trade",
        detail: `${
          moved
            ? `You had moved ${fromAdd ? addStopText : 'your stop'} from ${formatTick(origin)} to ${formatTick(stopAt)}, and it filled`
            : `The stop that came with your add, at ${formatTick(stopAt)} (your first stop was at ${formatTick(trip.initialStop!)}), filled`
        } at ${formatTick(exitPx)}${filledPast ? `, ${dist(past)} past it` : ''}: ${signed(trip.pnl)} on the trade after costs.${
          afterExit ? ` In the ${afterExit.span} after your exit, price moved ${dist(afterExit.favorableMove)} further your way.` : ''
        }`,
      });
    } else if (filledPast) {
      findings.push({
        tone: 'bad',
        title: 'Stop filled well past its price',
        detail: `Your stop at ${formatTick(stopAt)} filled at ${formatTick(exitPx)}, ${dist(past)} past it, so this exit was ${fmtR(inR(exitPx))} per share instead of ${
          moved || fromAdd ? `the ${fmtR(inR(stopAt))} ${theStop} allowed` : `the planned ${fmtR(-1)}`
        }. ${stopFillNote()}`,
      });
    } else if ((widened || firstWidened) && inR(stopAt) < -1 - 1e-9) {
      const planned = widened && fromAdd && inR(origin) < -1 - 1e-9 ? `the ${fmtR(inR(origin))} where it was placed (your first stop planned ${fmtR(-1)})` : `the planned ${fmtR(-1)}`;
      findings.push({
        tone: 'bad',
        title: 'You widened your stop',
        detail: `${
          widened
            ? `You moved ${fromAdd ? addStopText : 'your stop'} from ${formatTick(origin)} to ${formatTick(stopAt)}, further from your entry,`
            : `You moved your first stop from ${formatTick(trip.initialStop!)} to ${formatTick(firstStop!.stopPrice!)}, further from your entry, and ${addStopText} was at ${formatTick(stopAt)},`
        } so this exit was ${fmtR(inR(exitPx))} per share instead of ${planned}. Moving a stop away to avoid being stopped out turns a planned loss into a bigger one.`,
      });
    } else if (fromAdd && inR(stopAt) < -1 - 1e-9) {
      findings.push({
        tone: 'bad',
        title: "Your add's stop was wider",
        detail: `The stop that came with your add, at ${formatTick(stopAt)}${moved ? ` (you had moved it from ${formatTick(origin)})` : ''}, was further from your entry than your first stop at ${formatTick(trip.initialStop!)}, so this exit was ${fmtR(inR(exitPx))} per share instead of the planned ${fmtR(-1)}. An add with a wider stop takes the trade's risk past what you planned for it.`,
      });
    } else if (afterExit && (afterExit.reachedOriginalTarget || afterExit.favorableMove / riskPerShare >= 1)) {
      const recovered = afterExit.favorableMove / riskPerShare;
      findings.push({
        tone: 'bad',
        title: 'Stopped out, then price went your way',
        detail: `In the ${afterExit.span} after your stop filled, price moved ${dist(afterExit.favorableMove)} (${recovered.toFixed(1)}R) in your trade's direction${
          afterExit.reachedOriginalTarget ? ', and reached your original target' : ''
        }. That pattern suggests the stop was placed where normal noise could reach it, not that the idea was wrong. It is one trade, so treat it as a data point, not a rule.`,
      });
    } else if (afterExitUntil !== undefined) {
      findings.push({
        tone: 'neutral',
        title: 'What price does next',
        detail: `Once the replay has shown the ${AFTER_EXIT_WINDOW[input.timeframe].label} after your stop filled, this review adds whether price went on against you or came back your way.`,
      });
    } else if (afterExit) {
      // Filled more than a quarter R past it, though not 'well past': say where.
      const filledAt = past > 0.25 * riskPerShare + 1e-9 ? `, though it filled at ${formatTick(exitPx)}` : '';
      const where = fromAdd
        ? `at ${theStop} (${formatTick(stopAt)}${moved ? `; placed at ${formatTick(origin)}` : ''}; your first stop was at ${formatTick(trip.initialStop!)})${filledAt}`
        : moved
          ? `at ${theStop} (${formatTick(stopAt)}; planned at ${formatTick(trip.initialStop!)})${filledAt}`
          : filledAt
            ? `at your stop at ${formatTick(stopAt)}${filledAt}`
            : 'where you planned';
      findings.push({
        tone: 'good',
        title: 'Stop did its job',
        detail: `In the ${afterExit.span} after you exited, price did not recover meaningfully (best ${dist(afterExit.favorableMove)} in your direction). ${
          outcome === 'loss' ? `Your loss was capped ${where}.` : `It closed ${parts.length > 1 ? `${main!.qty} of ${trip.exitQtyTotal} shares` : 'the position'} ${where}.`
        }`,
      });
    }
  } else if (exitReason === 'stop_loss' && riskPerShare === null && stopAt !== undefined && exitPx !== undefined && stopSlip(stopAt, exitPx).slipped) {
    // With no R to measure it in (a breakeven stop, say), what the fill past the stop cost is said in dollars.
    const { past } = stopSlip(stopAt, exitPx);
    const placed = input.fills.find((f) => f.orderId === main!.order.id && trip.fills.includes(f.id))?.at === 'placed';
    findings.push({
      tone: 'neutral',
      title: 'Stop filled past its price',
      detail: placed
        ? `Your stop at ${formatTick(stopAt)} was already past the market when you placed or changed it, so it filled at once at ${formatTick(exitPx)}, ${dist(past)} past its price.`
        : `Your stop at ${formatTick(stopAt)} filled at ${formatTick(exitPx)}, ${dist(past)} past it, which cost ${money(past * main!.qty)} on the ${main!.qty} shares it closed. ${stopFillNote()}`,
    });
  }

  if (pastTarget) {
    const planned = trip.targetPlanned ?? trip.plannedEntry;
    const how = entryPast(targetOrder, planned, trip.targetEntry ?? bracketEntry, 'target', trip.initialTarget!);
    // Planned reward:risk falls back to where the order was expected to fill when the entry R uses is past the target too.
    const fromPlan = rr !== null && basis !== null && (trip.initialTarget! - basis.entry) * dir <= 0;
    const plannedFrom =
      targetOrder?.type === 'market'
        ? 'the price when you placed the order'
        : expectedElsewhere(targetOrder, planned)
          ? `${formatTick(planned!)}, where the order was expected to fill`
          : 'the price you placed the order at';
    findings.push({
      tone: 'neutral',
      title: 'Entry filled past your target',
      detail: `${how.text} The trade then closed at ${(trip.avgExit !== undefined ? formatTick(trip.avgExit) : '—')}: ${signed(trip.pnl)} after costs.${fromPlan ? ` Planned reward:risk is measured from ${plannedFrom}.` : ''}${how.gap ? gapNote('target') : ''}`,
    });
  } else if (targetDistance !== null) {
    // A limit that took profit short of the original target (or a target moved closer) did not reach it.
    const atTarget = parts.filter(reachedTarget).reduce((a, p) => a + p.qty, 0);
    if (atTarget > 0) {
      findings.push({
        tone: 'good',
        title: 'Target reached',
        detail: `Your target ${targetDistanceAtr !== null ? `(${targetDistanceAtr.toFixed(1)}× ATR away) ` : ''}was realistic for this move${
          atTarget < trip.exitQtyTotal ? `, though only ${atTarget} of ${trip.exitQtyTotal} shares filled there` : ''
        }.`,
      });
    } else {
      const reach = targetDistance > 0 ? (bestMove / targetDistance) * 100 : 0;
      findings.push({
        tone: reach < 50 ? 'bad' : 'neutral',
        title: reach < 50 ? 'Target was far from what price offered' : 'Target not reached',
        detail: `The best price while you were in the trade covered ${reach.toFixed(0)}% of the distance to your target${
          targetDistanceAtr !== null ? `, which was ${targetDistanceAtr.toFixed(1)}× ATR away` : ''
        }.${reach < 50 && targetDistanceAtr !== null && targetDistanceAtr > 3 ? ' Targets several ATRs away need an unusually strong move to fill.' : ''}`,
      });
    }
  }

  let capturePct: number | null = null;
  // Only once price moved at least a tick your way: below that there was no open profit to keep
  // (and float noise in the average entry would make a nonsense percentage).
  if (mfe.perShare >= tick - 1e-9) {
    capturePct = (trip.pnl / mfe.dollars) * 100;
    if (outcome === 'win' && capturePct < 40) {
      findings.push({ tone: 'bad', title: 'Gave back most of the open profit', detail: `Peak open profit was ${money(mfe.dollars)}; you kept ${money(trip.pnl)} (${capturePct.toFixed(0)}%).` });
    } else if (outcome === 'win' && capturePct >= 70) {
      findings.push({ tone: 'good', title: 'Captured most of the move', detail: `You kept ${capturePct.toFixed(0)}% of the best open profit (${money(mfe.dollars)}).` });
    }
    if (outcome === 'loss' && mfe.r !== null && mfe.r >= 1) {
      findings.push({ tone: 'bad', title: 'A winner turned into a loser', detail: `The trade was up ${mfe.r.toFixed(1)}R at its best before closing at a loss. Decide in advance what you do once a trade reaches +1R.` });
    }
  }

  if (addedPastStop) {
    findings.push({
      tone: 'bad',
      title: 'Added past your stop',
      detail: `You added at prices past your original stop at ${formatTick(trip.initialStop!)}, which moved your average entry to ${formatTick(trip.avgEntry)}. Your plan risked ${dist(riskPerShare!)} per share from your first entry at ${formatTick(bracketEntry)} (${money(riskDollars!)} at this size). Shares added past the stop cannot be closed by it at the planned loss, so the trade risked more than you planned.`,
    });
  } else if (riskPctOfEquity !== null && largest !== null && lifePct !== null) {
    findings.push({
      tone: lifePct > rules.maxRiskPctPerTrade + 1e-9 ? 'bad' : 'neutral',
      title: `Risked up to ${pctAgainst(lifePct, rules.maxRiskPctPerTrade)}% of the account`,
      detail: `${money(riskDollars!)} (${riskPctOfEquity.toFixed(2)}%) was at risk to your stop as planned, but ${
        life.beforeStop ? `the trade's open loss reached ${money(largest)} before your stop was placed` : `${money(largest)} was at risk to your stops at one point, after a stop moved further from your entry or shares were added with a wider stop`
      }, with ${money(equityAtEntry)} equity at entry. Your rule is ${rules.maxRiskPctPerTrade}% or less, counted at the trade's largest.`,
    });
  } else if (riskPctOfEquity !== null) {
    findings.push({
      tone: riskPctOfEquity > rules.maxRiskPctPerTrade + 1e-9 ? 'bad' : 'good',
      title: `Risked ${pctAgainst(riskPctOfEquity, rules.maxRiskPctPerTrade)}% of the account`,
      detail: `${money(riskDollars!)} at risk to your stop with ${money(equityAtEntry)} equity. Your rule is ${rules.maxRiskPctPerTrade}% or less.`,
    });
  }
  if (life.unprotected) {
    findings.push({
      tone: 'bad',
      title: 'Shares left without a stop',
      detail: `${trip.unprotectedQty} of your shares had no working stop from ${unprotectedSince(trip)}: a stop was cancelled or expired, covered fewer shares than you held, or shares were bought without one. The loss on them was not limited.`,
    });
  }

  return {
    tripId: trip.id,
    outcome,
    exitReason,
    rMultiple: r,
    plannedRR: rr,
    mfe,
    mae,
    capturePct,
    riskDollars,
    riskPctOfEquity,
    riskLimitPct: rules.maxRiskPctPerTrade,
    ...(addedPastStop ? { addedPastStop } : {}),
    ...(largest !== null ? { largestRiskDollars: largest, largestRiskPct: equityAtEntry > 0 ? (largest / equityAtEntry) * 100 : null } : {}),
    ...(life.unprotected ? { unprotected: true } : {}),
    equityAtEntry,
    atrAtEntry,
    stopDistanceAtr,
    targetDistanceAtr,
    ...(afterExitUntil !== undefined ? { afterExitUntil } : {}),
    afterExit,
    findings,
    rules: checkRules(input, riskPctOfEquity, rr),
  };
}

const RR_GAP_DETAIL: Record<RRGap, string> = {
  no_stop_or_target: 'Needs both a stop and a target',
  stop_past_average: 'Not measurable: the stop sat at or past your average entry',
  entry_past_target: 'Not measurable: the entry filled past the target',
  average_past_target: 'Not measurable: your adds moved your average entry past the target',
};

export function checkRules(input: ReviewInput, riskPctOfEquity: number | null, rr: number | null): RuleCheck[] {
  const { trip, rules, allTrips } = input;
  const out: RuleCheck[] = [];
  const hasStop = trip.initialStop !== undefined;
  if (rules.requireStopLoss) {
    // A stop placed after entry counts, as does one an add brought; the time without it is counted in
    // the risk rule (the loss before the stop came) and named in the review.
    const late = trip.stopPlacedAt !== undefined ? `, placed ${formatDuration(trip.stopPlacedAt - trip.entryTime)} after entry` : trip.stopFromAdd ? ', which came with a later add' : '';
    out.push({ rule: 'Use a stop loss', passed: hasStop, detail: hasStop ? `Stop at ${formatTick(trip.initialStop!)}${late}` : 'The trade never had a stop' });
  }
  const addedPastStop = riskBasis(trip)?.from === 'first';
  // Counted at the trade's largest over its life (riskOverLife), against the equity it opened with.
  const plannedRisk = initialRiskPerShare(trip);
  const life = riskOverLife(trip, plannedRisk !== null ? plannedRisk * trip.maxQuantity : null);
  const equityAtEntry = equityBeforeEntry(trip, input.fills, input.equityCurve, input.startingBalance);
  const lifePct = life.dollars !== null && equityAtEntry > 0 ? (life.dollars / equityAtEntry) * 100 : null;
  const pct = lifePct !== null && (riskPctOfEquity === null || lifePct > riskPctOfEquity) ? lifePct : riskPctOfEquity;
  out.push({
    rule: `Risk ≤ ${rules.maxRiskPctPerTrade}% per trade`,
    passed: addedPastStop || life.unprotected ? false : pct === null ? (hasStop ? null : false) : pct <= rules.maxRiskPctPerTrade + 1e-9,
    detail: addedPastStop
      ? 'Added past your stop: more than the planned risk'
      : life.unprotected
        ? `${trip.unprotectedQty} shares had no stop from ${unprotectedSince(trip)}`
        : pct === null
          ? hasStop
            ? 'Not measurable: the stop sat at or past your average entry'
            : 'Risk undefined without a stop'
          : pct !== riskPctOfEquity
            ? `${pctAgainst(pct, rules.maxRiskPctPerTrade)}% at its largest${riskPctOfEquity !== null ? ` (${riskPctOfEquity.toFixed(2)}% planned)` : life.beforeStop ? ', lost before its stop was placed' : ''}`
            : `${pctAgainst(pct, rules.maxRiskPctPerTrade)}%`,
  });
  if (rules.minRewardRisk > 0) {
    out.push({
      rule: `Planned reward:risk ≥ ${rules.minRewardRisk}:1`,
      passed: rr === null ? false : rr >= rules.minRewardRisk - 1e-9,
      detail: rr !== null ? `${rr.toFixed(2)}:1` : RR_GAP_DETAIL[plannedRRGap(trip) ?? 'no_stop_or_target'],
    });
  }
  const day = exchangeDate(trip.entryTime);
  const sameDay = allTrips.filter((t) => exchangeDate(t.entryTime) === day).sort((a, b) => a.entryTime - b.entryTime);
  const n = sameDay.findIndex((t) => t.id === trip.id) + 1;
  if (rules.maxTradesPerDay > 0) out.push({ rule: `Max ${rules.maxTradesPerDay} trades per day`, passed: n <= rules.maxTradesPerDay, detail: `Trade #${n} of the day` });
  if (rules.noTradesFirstMinutes > 0) {
    const minute = exchangeMinuteOfDay(trip.entryTime);
    const mins = minute - REGULAR_OPEN;
    const detail = mins < 0 ? `Entered in the pre-market, ${-mins} min before the open` : minute >= REGULAR_CLOSE ? 'Entered after the close' : `Entered ${mins} min after the open`;
    out.push({ rule: `No entries in the first ${rules.noTradesFirstMinutes} min`, passed: mins >= rules.noTradesFirstMinutes || mins < 0, detail });
  }
  if (rules.maxDailyLossPct > 0) {
    // The day's P/L at entry as the account's Day P/L and Strict Mode count it: from the equity the day
    // started with, so a loss on a position carried from an earlier day counts too, up to the moment of
    // the entry, so a stop-out earlier in the entry's own bar counts.
    const dayStart = equityAt(input.equityCurve, exchangeTimeToUnix(day, 0), input.startingBalance);
    const dayPnl = equityBeforeEntry(trip, input.fills, input.equityCurve, input.startingBalance) - dayStart;
    const pct = dayStart > 0 ? (-dayPnl / dayStart) * 100 : 0;
    out.push({ rule: `Stop trading after −${rules.maxDailyLossPct}% on the day`, passed: pct < rules.maxDailyLossPct, detail: dayPnl < 0 ? `Down ${pct.toFixed(2)}% on the day at entry` : 'Not down on the day at entry' });
  }
  for (const rule of rules.custom ?? []) out.push({ rule, passed: null, detail: 'Your own rule: say whether you followed it', own: true });
  return out;
}

export function followedAllRules(checks: RuleCheck[]): boolean {
  return checks.every((c) => c.passed !== false);
}
