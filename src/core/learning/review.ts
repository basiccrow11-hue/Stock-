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

export function exitReasonOf(trip: RoundTrip, fills: readonly Fill[], orders: readonly Order[]): ExitReason {
  const lastFillId = trip.fills[trip.fills.length - 1];
  const fill = fills.find((f) => f.id === lastFillId);
  const order = fill ? orders.find((o) => o.id === fill.orderId) : undefined;
  if (!order) return 'other';
  if (order.parentId && order.type === 'stop') return 'stop_loss';
  if (order.parentId && order.type === 'limit') return 'take_profit';
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

function excursion(perShare: number, trip: RoundTrip, riskPerShare: number | null): Excursion {
  return {
    perShare,
    dollars: perShare * trip.maxQuantity,
    pct: trip.avgEntry > 0 ? (perShare / trip.avgEntry) * 100 : 0,
    r: riskPerShare ? perShare / riskPerShare : null,
  };
}

const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;

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
  const mfePerShare = Math.max(0, long ? trip.highWhileOpen - trip.avgEntry : trip.avgEntry - trip.lowWhileOpen);
  const maePerShare = Math.max(0, long ? trip.avgEntry - trip.lowWhileOpen : trip.highWhileOpen - trip.avgEntry);
  const mfe = excursion(mfePerShare, trip, riskPerShare);
  const mae = excursion(maePerShare, trip, riskPerShare);
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
    }. While open, price moved at most ${mfePerShare.toFixed(2)} in your favour and ${maePerShare.toFixed(2)} against you.`,
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

  if (exitReason === 'stop_loss' && afterExit && riskPerShare) {
    const recovered = afterExit.favorableMove / riskPerShare;
    if (afterExit.reachedOriginalTarget || recovered >= 1) {
      findings.push({
        tone: 'bad',
        title: 'Stopped out, then price went your way (so far)',
        detail: `After your stop filled, price moved ${afterExit.favorableMove.toFixed(2)} (${recovered.toFixed(1)}R) in your trade's direction over the ${afterExit.barsObserved} bars revealed since${
          afterExit.reachedOriginalTarget ? ', and reached your original target' : ''
        }. That pattern suggests the stop was placed where normal noise could reach it, not that the idea was wrong. It is one trade, so treat it as a data point, not a rule.`,
      });
    } else {
      findings.push({ tone: 'good', title: 'Stop did its job', detail: `Since you exited, price has not recovered meaningfully (best ${afterExit.favorableMove.toFixed(2)} in your direction so far). Your loss was capped where you planned.` });
    }
  }

  if (targetDistance !== null) {
    if (exitReason === 'take_profit') {
      findings.push({ tone: 'good', title: 'Target reached', detail: `Your target ${targetDistanceAtr !== null ? `(${targetDistanceAtr.toFixed(1)}× ATR away) ` : ''}was realistic for this move.` });
    } else {
      const reach = targetDistance > 0 ? (mfePerShare / targetDistance) * 100 : 0;
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
  if (mfe.dollars > 0) {
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
