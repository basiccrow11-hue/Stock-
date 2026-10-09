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
import { entryPastStop, entryPastTarget, initialRiskPerShare, plannedRR, plannedRRGap, rMultiple, riskBasis, type RRGap } from '../analytics/stats';
import { exchangeDate, exchangeMinuteOfDay, exchangeTimeToUnix, REGULAR_OPEN } from '../time';

export interface TradingRules {
  maxRiskPctPerTrade: number;
  requireStopLoss: boolean;
  minRewardRisk: number;
  maxTradesPerDay: number;
  /** No new trades in the first N minutes after the open (0 = off). */
  noTradesFirstMinutes: number;
  maxDailyLossPct: number;
}

export const DEFAULT_TRADING_RULES: TradingRules = {
  maxRiskPctPerTrade: 1,
  requireStopLoss: true,
  minRewardRisk: 1.5,
  maxTradesPerDay: 5,
  noTradesFirstMinutes: 0,
  maxDailyLossPct: 3,
};

export type ExitReason = 'stop_loss' | 'take_profit' | 'manual' | 'other';

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
  /** Adds past the initial stop moved the average entry past it: the trade risked more than planned. */
  addedPastStop?: boolean;
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
 * target, a market order is a manual exit, and any other limit is just an exit order.
 */
export function exitReasonOf(trip: RoundTrip, fills: readonly Fill[], orders: readonly Order[]): ExitReason {
  const main = mainExit(exitParts(trip, fills, orders));
  if (!main) return 'other';
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

/**
 * The account's equity just before `trip` opened, as the account knew it then: the equity curve's
 * last point at or before the entry, plus each other fill that came after that point and before the
 * entry and was known by the time the entry was (a daily bar beside 1-minute data is known only at
 * its close, so its fills count for an entry on that daily bar, not for a 1-minute entry made while it
 * was hidden). Each such fill moves equity by what the position held before it made from the price
 * it was last marked at to the fill's price, less commission; shares it opens are valued at what was
 * paid for them, so a position opened at a gap is not a loss. So a stop-out earlier in the entry's own
 * bar counts, and nothing after the entry does. Another symbol's bar fill at the entry's very moment (a
 * stop gapped through at the open an entry also filled at) counts, as part of the market the entry met,
 * so the result does not depend on the order in which the bars of several symbols were processed.
 * Positions are marked at bar closes, not inside a bar.
 */
export function equityBeforeEntry(trip: RoundTrip, fills: readonly Fill[], curve: readonly EquityPoint[], startingBalance: number): number {
  let i = curve.length - 1;
  while (i >= 0 && curve[i].time > trip.entryTime) i--;
  const base = i >= 0 ? curve[i].equity : startingBalance;
  const at = i >= 0 ? curve[i].time : -Infinity;
  const entryIndex = fills.findIndex((f) => f.id === trip.fills[0]);
  const entry = fills[entryIndex];
  if (!entry || entry.knownAt === undefined) return base; // older fills: the curve alone
  const known = entry.knownAt;
  // A curve point is written as each bar ends, so it holds the fills of bars that had ended by then,
  // but not those of an order that filled at once when placed at that same moment.
  const inCurve = (f: Fill) => f.knownAt! < at || (f.knownAt === at && f.at !== 'placed');
  const own = new Set(trip.fills);
  const mark = new Map<string, number>();
  let equity = base;
  // In the fills' order, which for any one symbol is the order in time.
  for (let k = 0; k < fills.length; k++) {
    const f = fills[k];
    if (own.has(f.id) || f.knownAt === undefined || f.knownAt > known || inCurve(f)) continue;
    if (f.time > entry.time) continue;
    // At the entry's moment, the fills' order is the real sequence only within one symbol's bar or
    // between orders that filled as they were placed; across symbols' bars it is processing order.
    if (f.time === entry.time && k > entryIndex && (f.symbol === entry.symbol || (f.at === 'placed' && entry.at === 'placed'))) continue;
    const held = f.positionBefore ?? 0;
    const from = mark.get(f.symbol) ?? f.markBefore ?? f.price;
    equity += held * (f.price - from) - f.commission;
    mark.set(f.symbol, f.price);
  }
  return equity;
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
  // How that order came to fill past its own stop or target: a gap at a bar's open (also older trades,
  // which did not record it), the spread and slippage, a limit through the market, or price moving past
  // both before the order could fill (an order placed while a daily bar was still hidden).
  const entryPast = (order: Order | undefined, planned: number | undefined, price: number, what: 'stop' | 'target', level: number): { text: string; gap: boolean } => {
    const fill = order && tripFills.find((f) => f?.orderId === order.id);
    const market = order?.type === 'market';
    const name = order && order !== entryOrders[0] ? (market ? 'market add' : 'add') : market ? 'market order' : 'entry order';
    const at = planned !== undefined ? ` at ${planned.toFixed(2)}` : '';
    // Capped by bar volume, the order filled in parts and only the later ones went past the level.
    const parts = tripFills.filter((f) => f && order && f.orderId === order.id).length;
    const sign = long ? 1 : -1;
    if (fill && parts > 1 && (what === 'target' ? (fill.price - level) * sign : (level - fill.price) * sign) < 0) {
      return {
        gap: false,
        text: `Your ${name}${at} filled in ${parts} parts, each capped at a share of a bar's volume (Data & Settings), and the later parts filled past your ${what} at ${level.toFixed(2)}, for an average of ${price.toFixed(2)}.`,
      };
    }
    if (!fill?.at || fill.at === 'open') {
      return {
        gap: true,
        text: market
          ? `Your ${name} was placed${planned !== undefined ? ` with price at ${planned.toFixed(2)}` : ''} and filled at the next open, ${price.toFixed(2)}, already past your ${what} at ${level.toFixed(2)}.`
          : `Price gapped through both your ${name}${at} and your ${what} at ${level.toFixed(2)}, so it filled at ${price.toFixed(2)}.`,
      };
    }
    // The market price before this fill's spread and slippage: if that was short of the level, the costs carried it past.
    const before = price - (sign * (fill.slippage + fill.spreadCost)) / fill.quantity;
    if ((what === 'target' ? (before - level) * sign : (level - before) * sign) < 0) {
      return { gap: false, text: `Your ${name}${at} filled at ${price.toFixed(2)}, past your ${what} at ${level.toFixed(2)}: the spread and slippage of the fill alone carried it past a ${what} that close.` };
    }
    if (fill.at === 'placed') return { gap: false, text: `Your ${name}${at} was already through the market, so it filled at once at ${price.toFixed(2)}, past your ${what} at ${level.toFixed(2)}.` };
    return { gap: false, text: `Your ${name}${at} filled at ${price.toFixed(2)}, already past your ${what} at ${level.toFixed(2)}: price was past both by the time the order could fill.` };
  };
  const gapNote = (what: string) => ` An order waiting for the next bar, or for the market to open, fills at that bar's open wherever price is, even past its own ${what}.`;
  const equityAtEntry = equityBeforeEntry(trip, input.fills, input.equityCurve, input.startingBalance);
  const riskDollars = riskPerShare !== null ? riskPerShare * trip.maxQuantity : null;
  const riskPctOfEquity = riskDollars !== null && equityAtEntry > 0 ? (riskDollars / equityAtEntry) * 100 : null;

  // ATR on the trading timeframe, from candles that had completed before entry.
  const before = input.revealedBars.filter((b) => b.time < trip.entryTime);
  const candles = aggregateBars(before, input.timeframe);
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
      const hi = Math.max(...post.map((b) => b.high));
      const lo = Math.min(...post.map((b) => b.low));
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
    detail: `${long ? 'Long' : 'Short'} ${trip.maxQuantity} @ ${trip.avgEntry.toFixed(2)}, exited @ ${trip.avgExit?.toFixed(2) ?? '—'} ${
      parts.length > 1
        ? `in ${parts.length} parts`
        : `via ${{ stop_loss: 'your stop loss', take_profit: 'your profit target', manual: 'a manual exit', other: 'an exit order' }[exitReason]}`
    }. While open, the trade was at best ${signed(best)} and at worst ${signed(worst)} (before costs).`,
  });
  if (parts.length > 1) {
    const how = (p: ExitPart) => (isStop(p.order) ? 'by your stop' : reachedTarget(p) ? 'at your target' : p.order.type === 'limit' ? 'by a limit order' : 'at market');
    findings.push({
      tone: 'neutral',
      title: 'Closed in parts',
      detail: `${parts.map((p) => `${p.qty} ${how(p)} at ${p.price.toFixed(2)}`).join(', then ')}. The rest of this review goes by the order that closed the most shares.`,
    });
  }

  if (riskPerShare === null) {
    const worstText = `The worst point of the trade was ${money(mae.dollars)} against you${
      equityAtEntry > 0 ? ` (${((mae.dollars / equityAtEntry) * 100).toFixed(2)}% of the account)` : ''
    }.`;
    findings.push(
      trip.initialStop === undefined
        ? { tone: 'bad', title: 'No stop loss', detail: `Your risk was undefined. ${worstText}` }
        : trip.stopFromAdd
          ? {
              tone: 'bad',
              title: 'No stop on your first entry',
              detail: `Your stop at ${trip.initialStop.toFixed(2)} came with a later add, and it sat past your average entry of ${trip.avgEntry.toFixed(2)}: it locked in a gain on your earlier shares rather than capping a loss, so the trade's risk cannot be measured in R. ${worstText}`,
            }
          : { tone: 'bad', title: 'Risk not measurable', detail: `Your entry filled past your stop at ${trip.initialStop.toFixed(2)}, so the trade's risk cannot be measured in R. ${worstText}` },
    );
  } else if (stopDistanceAtr !== null) {
    const tight = stopDistanceAtr < 0.75;
    findings.push({
      tone: tight ? 'bad' : 'neutral',
      title: tight ? 'Stop was tight relative to normal movement' : 'Stop distance',
      detail: `Your stop was ${riskPerShare.toFixed(2)} away${
        basis?.from === 'planned' ? (stopOrder?.type === 'market' ? ' from the price when you placed your order' : ' from your order’s price') : basis?.from === 'first' ? ' from your first entry' : ''
      }, ${stopDistanceAtr.toFixed(2)}× the ATR(14) of ${input.timeframe} candles at entry (${atrAtEntry!.toFixed(2)}).${
        tight ? ' Stops well inside one ATR are often hit by ordinary noise rather than by the setup failing.' : ''
      }`,
    });
  }

  // Where the closing stop sat when it filled (it may have been moved since entry) and its fills.
  const main = mainExit(parts);
  const stopAt = main?.order.stopPrice;
  const exitPx = main?.price;
  if (exitReason === 'stop_loss' && riskPerShare && stopAt !== undefined && exitPx !== undefined) {
    const inR = (px: number) => ((px - trip.avgEntry) * dir) / riskPerShare;
    const fmtR = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
    // How far past the stop it filled: more than a quarter of the planned risk is not slippage noise.
    const past = (stopAt - exitPx) * dir;
    const filledPast = past >= 0.02 - 1e-9 && past > 0.25 * riskPerShare;
    // A stop at another price than the first is the user's move, unless it is the untouched stop an
    // add brought with it (its own bracket) while the first stop stayed where it was.
    const isStop = (o: Order) => o.type === 'stop' || o.type === 'stop_limit';
    const firstStop = trip.stopOrder ? input.orders.find((o) => o.parentId === trip.stopOrder!.id && isStop(o)) : undefined;
    const firstMoved = firstStop !== undefined && Math.abs(firstStop.stopPrice! - trip.initialStop!) > 1e-9;
    const parent = main!.order.parentId ? input.orders.find((o) => o.id === main!.order.parentId) : undefined;
    const addStop =
      !firstMoved && parent !== undefined && parent.id !== trip.stopOrder?.id && parent.stopLoss !== undefined && Math.abs(stopAt - parent.stopLoss) <= 1e-9 && Math.abs(stopAt - trip.initialStop!) > 1e-9;
    const moved = !addStop && Math.abs(stopAt - trip.initialStop!) > 1e-9;
    const theStop = moved ? 'your moved stop' : addStop ? "your add's stop" : 'your stop';
    // A stop that fired is a market order: when the volume cap let only part of it trade there, the
    // rest filled over the next bars, here after price had come back past the stop.
    const stopParts = main!.order.type === 'stop' ? input.fills.filter((f) => f.orderId === main!.order.id) : [];
    if (!pastStop && stopParts.length > 1 && (exitPx - stopAt) * dir > 0) {
      const first = stopParts[0];
      findings.push({
        tone: 'neutral',
        title: 'Your stop fired, and the rest filled after price came back',
        detail: `${theStop[0].toUpperCase()}${theStop.slice(1)} at ${stopAt.toFixed(2)} fired, but the volume cap (Data & Settings) let only ${first.quantity} of its ${main!.qty} shares ${long ? 'sell' : 'be bought back'} on the bar it fired, at ${first.price.toFixed(2)}. A stop that has fired is a market order, so the rest ${long ? 'sold' : 'was bought back'} over the next bars as price came back, for an average of ${exitPx.toFixed(2)}. That helped this time; had price kept going, the rest would have filled further past the stop. For a position this large against the stock's volume, a stop does not fix the exit price.`,
      });
    }
    if (pastStop) {
      const how = entryPast(stopOrder, trip.plannedEntry, bracketEntry, 'stop', trip.initialStop!);
      findings.push({
        tone: 'neutral',
        title: 'Entry filled past your stop',
        detail: `${how.text} The stop then closed the trade at ${exitPx.toFixed(2)}: ${signed(trip.pnl)} after costs, ${fmtR(r ?? 0)} of the ${riskPerShare.toFixed(2)} per share you planned to risk.${how.gap ? gapNote('stop') : ''}`,
      });
    } else if ((moved || addStop) && inR(exitPx) >= 0) {
      findings.push({
        tone: trip.pnl > 0.005 ? 'good' : 'neutral',
        title: moved ? 'Your moved stop closed the trade' : "Your add's stop closed the trade",
        detail: `${
          moved ? `You had moved your stop from ${trip.initialStop!.toFixed(2)} to ${stopAt.toFixed(2)},` : `The stop that came with your add, at ${stopAt.toFixed(2)} (your first stop was at ${trip.initialStop!.toFixed(2)}),`
        } and it filled at ${exitPx.toFixed(2)}${
          filledPast ? `, ${past.toFixed(2)} past it` : ''
        }: ${signed(trip.pnl)} on the trade after costs.${
          afterExit ? ` In the ${afterExit.span} after your exit, price moved ${afterExit.favorableMove.toFixed(2)} further your way.` : ''
        }`,
      });
    } else if (filledPast) {
      findings.push({
        tone: 'bad',
        title: 'Stop filled well past its price',
        detail: `Your stop at ${stopAt.toFixed(2)} filled at ${exitPx.toFixed(2)}, ${past.toFixed(2)} past it, so this exit was ${fmtR(inR(exitPx))} per share instead of ${
          moved || addStop ? `the ${fmtR(inR(stopAt))} ${theStop} allowed` : `the planned ${fmtR(-1)}`
        }. ${
          main!.order.type === 'stop_limit'
            ? `A stop-limit becomes a limit order at ${main!.order.limitPrice!.toFixed(2)} when price reaches its stop and fills at any price up to that limit, which can be well past the stop after a gap.`
            : 'A stop turns into a market order when price reaches it and fills at the next price available, which can be far away after a gap or for a large order in a thin bar.'
        }`,
      });
    } else if (inR(stopAt) < -1 - 1e-9 && addStop) {
      findings.push({
        tone: 'bad',
        title: "Your add's stop was wider",
        detail: `The stop that came with your add, at ${stopAt.toFixed(2)}, was further from your entry than your first stop at ${trip.initialStop!.toFixed(2)}, so this exit was ${fmtR(inR(exitPx))} per share instead of the planned ${fmtR(-1)}. An add with a wider stop takes the trade's risk past what you planned for it.`,
      });
    } else if (inR(stopAt) < -1 - 1e-9) {
      findings.push({
        tone: 'bad',
        title: 'You widened your stop',
        detail: `You moved your stop from ${trip.initialStop!.toFixed(2)} to ${stopAt.toFixed(2)}, further from your entry, so this exit was ${fmtR(inR(exitPx))} per share instead of the planned ${fmtR(-1)}. Moving a stop away to avoid being stopped out turns a planned loss into a bigger one.`,
      });
    } else if (afterExit && (afterExit.reachedOriginalTarget || afterExit.favorableMove / riskPerShare >= 1)) {
      const recovered = afterExit.favorableMove / riskPerShare;
      findings.push({
        tone: 'bad',
        title: 'Stopped out, then price went your way',
        detail: `In the ${afterExit.span} after your stop filled, price moved ${afterExit.favorableMove.toFixed(2)} (${recovered.toFixed(1)}R) in your trade's direction${
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
      const where = moved || addStop ? `at ${theStop} (${stopAt.toFixed(2)}; planned at ${trip.initialStop!.toFixed(2)})` : 'where you planned';
      findings.push({
        tone: 'good',
        title: 'Stop did its job',
        detail: `In the ${afterExit.span} after you exited, price did not recover meaningfully (best ${afterExit.favorableMove.toFixed(2)} in your direction). ${
          outcome === 'loss' ? `Your loss was capped ${where}.` : `It closed ${parts.length > 1 ? `${main!.qty} of ${trip.exitQtyTotal} shares` : 'the position'} ${where}.`
        }`,
      });
    }
  }

  if (pastTarget) {
    const how = entryPast(targetOrder, trip.targetPlanned ?? trip.plannedEntry, trip.targetEntry ?? bracketEntry, 'target', trip.initialTarget!);
    // Planned reward:risk falls back to the order's own price when the entry R uses is past the target too.
    const fromPlan = rr !== null && basis !== null && (trip.initialTarget! - basis.entry) * dir <= 0;
    findings.push({
      tone: 'neutral',
      title: 'Entry filled past your target',
      detail: `${how.text} The trade then closed at ${trip.avgExit?.toFixed(2) ?? '—'}: ${signed(trip.pnl)} after costs.${fromPlan ? ' Planned reward:risk is measured from the price you placed the order at.' : ''}${how.gap ? gapNote('target') : ''}`,
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
  if (mfe.perShare >= 0.01 - 1e-9) {
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
      detail: `You added at prices past your original stop at ${trip.initialStop!.toFixed(2)}, which moved your average entry to ${trip.avgEntry.toFixed(2)}. Your plan risked ${riskPerShare!.toFixed(2)} per share from your first entry at ${bracketEntry.toFixed(2)} (${money(riskDollars!)} at this size). Shares bought past the stop cannot be closed by it at the planned loss, so the trade risked more than you planned.`,
    });
  } else if (riskPctOfEquity !== null) {
    findings.push({
      tone: riskPctOfEquity > rules.maxRiskPctPerTrade ? 'bad' : 'good',
      title: `Risked ${riskPctOfEquity.toFixed(2)}% of the account`,
      detail: `${money(riskDollars!)} at risk to your stop with ${money(equityAtEntry)} equity. Your rule is ${rules.maxRiskPctPerTrade}% or less.`,
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
    ...(addedPastStop ? { addedPastStop } : {}),
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
  stop_past_average: 'Not measurable: the stop sat past your average entry',
  entry_past_target: 'Not measurable: the entry filled past the target',
  average_past_target: 'Not measurable: your adds moved your average entry past the target',
};

export function checkRules(input: ReviewInput, riskPctOfEquity: number | null, rr: number | null): RuleCheck[] {
  const { trip, rules, allTrips } = input;
  const out: RuleCheck[] = [];
  const hasStop = trip.initialStop !== undefined;
  // A stop that only came with an add leaves the first entry without one.
  const stopAtEntry = hasStop && !trip.stopFromAdd;
  if (rules.requireStopLoss) {
    out.push({
      rule: 'Use a stop loss',
      passed: stopAtEntry,
      detail: stopAtEntry ? `Stop at ${trip.initialStop!.toFixed(2)}` : hasStop ? `No stop at entry (one came with a later add, at ${trip.initialStop!.toFixed(2)})` : 'No stop was attached at entry',
    });
  }
  const addedPastStop = riskBasis(trip)?.from === 'first';
  out.push({
    rule: `Risk ≤ ${rules.maxRiskPctPerTrade}% per trade`,
    passed: addedPastStop ? false : riskPctOfEquity === null ? (hasStop ? null : false) : riskPctOfEquity <= rules.maxRiskPctPerTrade + 1e-9,
    detail: addedPastStop
      ? 'Added past your stop: more than the planned risk'
      : riskPctOfEquity === null
        ? hasStop
          ? 'Not measurable: the stop sat past your average entry'
          : 'Risk undefined without a stop'
        : `${riskPctOfEquity.toFixed(2)}%`,
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
    const mins = exchangeMinuteOfDay(trip.entryTime) - REGULAR_OPEN;
    out.push({ rule: `No entries in the first ${rules.noTradesFirstMinutes} min`, passed: mins >= rules.noTradesFirstMinutes || mins < 0, detail: `Entered ${mins} min after the open` });
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
  return out;
}

export function followedAllRules(checks: RuleCheck[]): boolean {
  return checks.every((c) => c.passed !== false);
}
