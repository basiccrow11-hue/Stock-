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
import { initialRiskPerShare, plannedRR, rMultiple } from '../analytics/stats';
import { exchangeDate, exchangeMinuteOfDay, REGULAR_OPEN } from '../time';

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
  riskDollars: number | null;
  riskPctOfEquity: number | null;
  equityAtEntry: number;
  atrAtEntry: number | null;
  stopDistanceAtr: number | null;
  targetDistanceAtr: number | null;
  afterExit: {
    barsObserved: number;
    /** Best price move in the trade's direction after the exit, per share (so far). */
    favorableMove: number;
    adverseMove: number;
    reachedOriginalTarget: boolean;
  } | null;
  findings: Finding[];
  rules: RuleCheck[];
}

/** The trade's last fill and the order it came from. */
function closingFill(trip: RoundTrip, fills: readonly Fill[], orders: readonly Order[]): { fill?: Fill; order?: Order } {
  const lastFillId = trip.fills[trip.fills.length - 1];
  const fill = fills.find((f) => f.id === lastFillId);
  return { fill, order: fill ? orders.find((o) => o.id === fill.orderId) : undefined };
}

/**
 * How the trade was closed, by the closing order: a stop order (bracket or placed separately) is
 * the stop loss, a limit that took profit is the target, a market order is a manual exit, and a
 * limit that closed at a loss is just an exit order.
 */
export function exitReasonOf(trip: RoundTrip, fills: readonly Fill[], orders: readonly Order[]): ExitReason {
  const { fill, order } = closingFill(trip, fills, orders);
  if (!order || !fill) return 'other';
  if (order.type === 'stop' || order.type === 'stop_limit') return 'stop_loss';
  if (order.type === 'limit') return (trip.direction === 'long' ? fill.price > trip.avgEntry : fill.price < trip.avgEntry) ? 'take_profit' : 'other';
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
  const equityAtEntry = equityAt(input.equityCurve, trip.entryTime, input.startingBalance);
  const riskDollars = riskPerShare !== null ? riskPerShare * trip.maxQuantity : null;
  const riskPctOfEquity = riskDollars !== null && equityAtEntry > 0 ? (riskDollars / equityAtEntry) * 100 : null;

  // ATR on the trading timeframe, from candles that had completed before entry.
  const before = input.revealedBars.filter((b) => b.time < trip.entryTime);
  const candles = aggregateBars(before, input.timeframe);
  const atrSeries = atr(candles, 14);
  const atrAtEntry = atrSeries.length && !Number.isNaN(atrSeries[atrSeries.length - 1]) ? atrSeries[atrSeries.length - 1] : null;
  const stopDistanceAtr = atrAtEntry && riskPerShare ? riskPerShare / atrAtEntry : null;
  const targetDistance = trip.initialTarget !== undefined ? Math.abs(trip.initialTarget - trip.avgEntry) : null;
  const targetDistanceAtr = atrAtEntry && targetDistance ? targetDistance / atrAtEntry : null;

  // After-exit tape, revealed bars only.
  let afterExit: TradeReview['afterExit'] = null;
  if (trip.closed && trip.exitTime !== undefined && trip.avgExit !== undefined) {
    const post = input.revealedBars.filter((b) => b.time >= trip.exitTime!);
    if (post.length) {
      const hi = Math.max(...post.map((b) => b.high));
      const lo = Math.min(...post.map((b) => b.low));
      afterExit = {
        barsObserved: post.length,
        favorableMove: Math.max(0, long ? hi - trip.avgExit : trip.avgExit - lo),
        adverseMove: Math.max(0, long ? trip.avgExit - lo : hi - trip.avgExit),
        reachedOriginalTarget: trip.initialTarget !== undefined && (long ? hi >= trip.initialTarget : lo <= trip.initialTarget),
      };
    }
  }

  const findings: Finding[] = [];
  const outcome: TradeReview['outcome'] = trip.pnl > 0.005 ? 'win' : trip.pnl < -0.005 ? 'loss' : 'breakeven';
  const rText = r !== null ? ` (${r >= 0 ? '+' : ''}${r.toFixed(2)}R)` : '';
  findings.push({
    tone: outcome === 'win' ? 'good' : outcome === 'loss' ? 'bad' : 'neutral',
    title: `${outcome === 'win' ? 'Won' : outcome === 'loss' ? 'Lost' : 'Broke even'} ${money(Math.abs(trip.pnl))}${rText}`,
    detail: `${long ? 'Long' : 'Short'} ${trip.maxQuantity} @ ${trip.avgEntry.toFixed(2)}, exited @ ${trip.avgExit?.toFixed(2) ?? '—'} via ${
      { stop_loss: 'your stop loss', take_profit: 'your profit target', manual: 'a manual exit', other: 'an exit order' }[exitReason]
    }. While open, the trade was at best ${signed(best)} and at worst ${signed(worst)} (before costs).`,
  });

  if (riskPerShare === null) {
    findings.push({
      tone: 'bad',
      title: 'No stop loss',
      detail: `Your risk was undefined. The worst point of the trade was ${money(mae.dollars)} against you${
        equityAtEntry > 0 ? ` (${((mae.dollars / equityAtEntry) * 100).toFixed(2)}% of the account)` : ''
      }.`,
    });
  } else if (stopDistanceAtr !== null) {
    const tight = stopDistanceAtr < 0.75;
    findings.push({
      tone: tight ? 'bad' : 'neutral',
      title: tight ? 'Stop was tight relative to normal movement' : 'Stop distance',
      detail: `Your stop was ${riskPerShare.toFixed(2)} away, ${stopDistanceAtr.toFixed(2)}× the ATR(14) of ${input.timeframe} candles at entry (${atrAtEntry!.toFixed(2)}).${
        tight ? ' Stops well inside one ATR are often hit by ordinary noise rather than by the setup failing.' : ''
      }`,
    });
  }

  // Where the closing stop sat when it filled (it may have been moved since entry) and the fill.
  const closing = closingFill(trip, input.fills, input.orders);
  const stopAt = closing.order?.stopPrice;
  const exitPx = closing.fill?.price;
  if (exitReason === 'stop_loss' && riskPerShare && stopAt !== undefined && exitPx !== undefined) {
    const dir = long ? 1 : -1;
    const inR = (px: number) => ((px - trip.avgEntry) * dir) / riskPerShare;
    const fmtR = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
    // How far past the stop it filled: more than a quarter of the planned risk is not slippage noise.
    const past = (stopAt - exitPx) * dir;
    const filledPast = past >= 0.02 - 1e-9 && past > 0.25 * riskPerShare;
    const moved = Math.abs(stopAt - trip.initialStop!) > 1e-9;
    if (inR(exitPx) >= 0) {
      findings.push({
        tone: trip.pnl > 0.005 ? 'good' : 'neutral',
        title: 'Your moved stop closed the trade',
        detail: `You had moved your stop from ${trip.initialStop!.toFixed(2)} to ${stopAt.toFixed(2)}, and it filled at ${exitPx.toFixed(2)}${
          filledPast ? `, ${past.toFixed(2)} past it` : ''
        }: ${signed(trip.pnl)} on the trade after costs.${
          afterExit ? ` Since then price has moved ${afterExit.favorableMove.toFixed(2)} further your way over the ${afterExit.barsObserved} bars revealed (so far).` : ''
        }`,
      });
    } else if (filledPast) {
      findings.push({
        tone: 'bad',
        title: 'Stop filled well past its price',
        detail: `Your stop at ${stopAt.toFixed(2)} filled at ${exitPx.toFixed(2)}, ${past.toFixed(2)} past it, so this exit was ${fmtR(inR(exitPx))} per share instead of ${
          moved ? `the ${fmtR(inR(stopAt))} your moved stop allowed` : `the planned ${fmtR(-1)}`
        }. A stop turns into a market order when price reaches it and fills at the next price available, which can be far away after a gap or for a large order in a thin bar.`,
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
        title: 'Stopped out, then price went your way (so far)',
        detail: `After your stop filled, price moved ${afterExit.favorableMove.toFixed(2)} (${recovered.toFixed(1)}R) in your trade's direction over the ${afterExit.barsObserved} bars revealed since${
          afterExit.reachedOriginalTarget ? ', and reached your original target' : ''
        }. That pattern suggests the stop was placed where normal noise could reach it, not that the idea was wrong. It is one trade, so treat it as a data point, not a rule.`,
      });
    } else if (afterExit) {
      findings.push({
        tone: 'good',
        title: 'Stop did its job',
        detail: `Since you exited, price has not recovered meaningfully (best ${afterExit.favorableMove.toFixed(2)} in your direction so far). Your loss was capped ${
          moved ? `at your moved stop (${stopAt.toFixed(2)}; planned at ${trip.initialStop!.toFixed(2)})` : 'where you planned'
        }.`,
      });
    }
  }

  if (targetDistance !== null) {
    // A limit that took profit short of the original target (or a target moved closer) did not reach it.
    const atTarget = exitReason === 'take_profit' && exitPx !== undefined && (exitPx - trip.initialTarget!) * (long ? 1 : -1) >= -1e-9;
    if (atTarget) {
      findings.push({ tone: 'good', title: 'Target reached', detail: `Your target ${targetDistanceAtr !== null ? `(${targetDistanceAtr.toFixed(1)}× ATR away) ` : ''}was realistic for this move.` });
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

  if (riskPctOfEquity !== null) {
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
    equityAtEntry,
    atrAtEntry,
    stopDistanceAtr,
    targetDistanceAtr,
    afterExit,
    findings,
    rules: checkRules(input, riskPctOfEquity, rr),
  };
}

export function checkRules(input: ReviewInput, riskPctOfEquity: number | null, rr: number | null): RuleCheck[] {
  const { trip, rules, allTrips } = input;
  const out: RuleCheck[] = [];
  const hasStop = trip.initialStop !== undefined;
  if (rules.requireStopLoss) out.push({ rule: 'Use a stop loss', passed: hasStop, detail: hasStop ? `Stop at ${trip.initialStop!.toFixed(2)}` : 'No stop was attached at entry' });
  out.push({
    rule: `Risk ≤ ${rules.maxRiskPctPerTrade}% per trade`,
    passed: riskPctOfEquity === null ? (hasStop ? null : false) : riskPctOfEquity <= rules.maxRiskPctPerTrade + 1e-9,
    detail: riskPctOfEquity === null ? 'Risk undefined without a stop' : `${riskPctOfEquity.toFixed(2)}%`,
  });
  if (rules.minRewardRisk > 0) {
    out.push({
      rule: `Planned reward:risk ≥ ${rules.minRewardRisk}:1`,
      passed: rr === null ? false : rr >= rules.minRewardRisk - 1e-9,
      detail: rr === null ? 'Needs both a stop and a target' : `${rr.toFixed(2)}:1`,
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
    const lossBefore = sameDay.filter((t) => t.closed && t.exitTime! <= trip.entryTime).reduce((a, t) => a + t.pnl, 0);
    const eq = equityAt(input.equityCurve, trip.entryTime, input.startingBalance);
    const pct = eq > 0 ? (-lossBefore / eq) * 100 : 0;
    out.push({ rule: `Stop trading after −${rules.maxDailyLossPct}% on the day`, passed: pct < rules.maxDailyLossPct, detail: lossBefore < 0 ? `Down ${pct.toFixed(2)}% on closed trades before entry` : 'Not down on the day at entry' });
  }
  return out;
}

export function followedAllRules(checks: RuleCheck[]): boolean {
  return checks.every((c) => c.passed !== false);
}
