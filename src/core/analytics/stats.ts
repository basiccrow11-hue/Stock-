/**
 * Performance statistics computed from closed round-trip trades and an equity curve.
 */
import type { EquityPoint, Fill, RoundTrip } from '../types';
import { sameAtTick } from '../util/math';

export interface PerformanceStats {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakevenTrades: number;
  winRate: number; // 0..100
  grossProfit: number;
  grossLoss: number; // negative or 0
  netPnl: number;
  averageWin: number;
  averageLoss: number; // negative or 0
  profitFactor: number | null; // null when there are no losses
  /** Expectancy in dollars per trade. */
  expectancy: number;
  /** Average realized R multiple (trades with a known initial stop). */
  averageR: number | null;
  /** Expectancy in R (same as averageR, null without stops). */
  expectancyR: number | null;
  /** Average planned reward:risk on trades with both a stop and a target. */
  averagePlannedRR: number | null;
  /** Average realized |avg win| / |avg loss|. */
  payoffRatio: number | null;
  largestWin: number;
  largestLoss: number;
  averageHoldingSeconds: number;
  totalReturnPct: number;
  maxDrawdown: number; // dollars, positive
  maxDrawdownPct: number; // positive
  longTrades: number;
  shortTrades: number;
  commissions: number;
  maxConsecutiveLosses: number;
}

/**
 * The entry price and per-share risk to the initial stop that R is measured from: the average entry;
 * when that is at or past the stop, the entry the stop came with (adds past the stop moved the
 * average); and when that is past it too (a gap through both the entry order and its stop), the
 * price the entry order was placed at, which is the risk that was planned. None when the trade opened
 * without a stop and its average sat past the stop a later add brought (the earlier shares were past
 * it, the add filled past it, or shares added after it moved the average): R is never measured from an add.
 * None either when its average sat at or past a stop placed on its own after entry (a breakeven stop, one
 * locking in a gain, or one that shares added after it moved the average past): that stop came with no
 * entry, so the first entry's price and plan say nothing about it. Such a stop, or one an add brought,
 * counts as at the average when the average written to the stop's tick is the stop's price: an average
 * of fills at different prices can sit a fraction of a cent from a breakeven stop, and R from that
 * sliver would be hundreds.
 */
export function riskBasis(t: RoundTrip): { entry: number; risk: number; from: 'average' | 'first' | 'planned' } | null {
  if (t.initialStop === undefined || t.initialStop <= 0) return null;
  const dir = t.direction === 'long' ? 1 : -1;
  const avgRisk = (t.avgEntry - t.initialStop) * dir;
  const ownEntry = !t.stopFromAdd && t.stopPlacedAt === undefined;
  if (avgRisk > 0 && (ownEntry || !sameAtTick(t.avgEntry, t.initialStop))) return { entry: t.avgEntry, risk: avgRisk, from: 'average' };
  if (!ownEntry) return null;
  const candidates: Array<[number | undefined, 'first' | 'planned']> = [
    [t.bracketEntry, 'first'],
    [t.plannedEntry, 'planned'],
  ];
  for (const [entry, from] of candidates) {
    if (entry === undefined) continue;
    const risk = (entry - t.initialStop) * dir;
    if (risk > 0) return { entry, risk, from };
  }
  return null;
}

export function initialRiskPerShare(t: RoundTrip): number | null {
  return riskBasis(t)?.risk ?? null;
}

/**
 * True when the entry the initial stop came with filled at or past that stop (only a gap can do
 * that). Adds made later past the stop do not count: they are a choice, not a gap. Never for a stop
 * placed on its own after entry, which came with no entry.
 */
export function entryPastStop(t: RoundTrip): boolean {
  return t.initialStop !== undefined && t.stopPlacedAt === undefined && ((t.bracketEntry ?? t.avgEntry) - t.initialStop) * (t.direction === 'long' ? 1 : -1) <= 0;
}

/**
 * True when the entry the initial target came with filled at or past that target (a gap through both).
 * Never for a target placed on its own after entry.
 */
export function entryPastTarget(t: RoundTrip): boolean {
  return t.initialTarget !== undefined && t.targetPlacedAt === undefined && ((t.targetEntry ?? t.bracketEntry ?? t.avgEntry) - t.initialTarget) * (t.direction === 'long' ? 1 : -1) >= 0;
}

/** Realized R multiple: P/L divided by the dollars at risk to the initial stop. */
export function rMultiple(t: RoundTrip): number | null {
  const r = initialRiskPerShare(t);
  if (r === null || t.maxQuantity <= 0) return null;
  return t.pnl / (r * t.maxQuantity);
}

/**
 * Reward to the initial target over risk to the initial stop, from the same entry as R. When the
 * entry the target came with filled at or past it (a gap), the plan is what that order was placed for.
 */
export function plannedRR(t: RoundTrip): number | null {
  const b = riskBasis(t);
  if (b === null || t.initialTarget === undefined) return null;
  const dir = t.direction === 'long' ? 1 : -1;
  const reward = (t.initialTarget - b.entry) * dir;
  if (reward > 0) return reward / b.risk;
  const planned = t.targetPlanned ?? t.plannedEntry;
  if (!entryPastTarget(t) || planned === undefined) return null;
  const plannedReward = (t.initialTarget - planned) * dir;
  const plannedRisk = (planned - t.initialStop!) * dir;
  return plannedReward > 0 && plannedRisk > 0 ? plannedReward / plannedRisk : null;
}

/** Why a trade has no planned reward:risk (null when it has one). */
export type RRGap = 'no_stop_or_target' | 'stop_past_average' | 'entry_past_target' | 'average_past_target';

export function plannedRRGap(t: RoundTrip): RRGap | null {
  if (plannedRR(t) !== null) return null;
  if (t.initialStop === undefined || t.initialTarget === undefined) return 'no_stop_or_target';
  if (riskBasis(t) === null) return 'stop_past_average';
  return entryPastTarget(t) ? 'entry_past_target' : 'average_past_target';
}

export function returnPct(t: RoundTrip): number {
  const basis = t.avgEntry * t.maxQuantity;
  return basis > 0 ? (t.pnl / basis) * 100 : 0;
}

export function drawdown(curve: readonly EquityPoint[]): { maxDrawdown: number; maxDrawdownPct: number; series: { time: number; drawdownPct: number }[] } {
  let peak = -Infinity;
  let maxDd = 0;
  let maxDdPct = 0;
  const series: { time: number; drawdownPct: number }[] = [];
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    const dd = peak - p.equity;
    const pct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
    if (pct > maxDdPct) maxDdPct = pct;
    series.push({ time: p.time, drawdownPct: -pct });
  }
  return { maxDrawdown: maxDd, maxDrawdownPct: maxDdPct, series };
}

export function computeStats(trips: readonly RoundTrip[], curve: readonly EquityPoint[], startingBalance: number): PerformanceStats {
  const closed = trips.filter((t) => t.closed);
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = losses.reduce((a, t) => a + t.pnl, 0);
  const netPnl = closed.reduce((a, t) => a + t.pnl, 0);
  const n = closed.length;
  const averageWin = wins.length ? grossProfit / wins.length : 0;
  const averageLoss = losses.length ? grossLoss / losses.length : 0;
  const rs = closed.map(rMultiple).filter((r): r is number => r !== null);
  const rrs = closed.map(plannedRR).filter((r): r is number => r !== null);
  const holds = closed.map((t) => (t.exitTime ?? t.entryTime) - t.entryTime);
  const { maxDrawdown, maxDrawdownPct } = drawdown(curve);
  const endEquity = curve.length ? curve[curve.length - 1].equity : startingBalance + netPnl;
  let streak = 0;
  let maxStreak = 0;
  for (const t of closed) {
    streak = t.pnl < 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  return {
    totalTrades: n,
    winningTrades: wins.length,
    losingTrades: losses.length,
    breakevenTrades: n - wins.length - losses.length,
    winRate: n ? (wins.length / n) * 100 : 0,
    grossProfit,
    grossLoss,
    netPnl,
    averageWin,
    averageLoss,
    profitFactor: grossLoss < 0 ? grossProfit / -grossLoss : null,
    expectancy: n ? netPnl / n : 0,
    averageR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    expectancyR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    averagePlannedRR: rrs.length ? rrs.reduce((a, b) => a + b, 0) / rrs.length : null,
    payoffRatio: wins.length && losses.length ? averageWin / -averageLoss : null,
    largestWin: wins.length ? wins.reduce((m, t) => Math.max(m, t.pnl), -Infinity) : 0,
    largestLoss: losses.length ? losses.reduce((m, t) => Math.min(m, t.pnl), Infinity) : 0,
    averageHoldingSeconds: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : 0,
    totalReturnPct: startingBalance > 0 ? ((endEquity - startingBalance) / startingBalance) * 100 : 0,
    maxDrawdown,
    maxDrawdownPct,
    longTrades: closed.filter((t) => t.direction === 'long').length,
    shortTrades: closed.filter((t) => t.direction === 'short').length,
    commissions: closed.reduce((a, t) => a + t.commission, 0),
    maxConsecutiveLosses: maxStreak,
  };
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
