/**
 * Challenge definitions and evaluation. A challenge is evaluated against a session's trades and
 * equity curve; it can pass, fail, or still be in progress. Sessions that used rewind/restart are
 * marked unofficial: you have seen the future, so the result cannot count as a blind result.
 */
import type { EquityPoint, RoundTrip } from '../types';
import { plannedRR, initialRiskPerShare } from '../analytics/stats';
import { equityAt, followedAllRules, checkRules, type TradingRules } from '../learning/review';

export interface ChallengeContext {
  trips: readonly RoundTrip[];
  equityCurve: readonly EquityPoint[];
  startingBalance: number;
  equity: number;
  /** True once the replay reached its end time. */
  sessionFinished: boolean;
  rewound: boolean;
  rules: TradingRules;
}

export type ChallengeStatus = 'in_progress' | 'passed' | 'failed';

export interface ChallengeResult {
  status: ChallengeStatus;
  progress: number; // 0..1
  detail: string;
  official: boolean;
}

export interface ChallengeDefinition {
  id: string;
  title: string;
  description: string;
  /** Suggested replay setup. */
  setup: { startingBalance: number; mode: 'replay' | 'sim'; multiDay?: boolean };
  /** Needs a replay with an end time (cannot complete in the open-ended simulated market). */
  requiresSessionEnd?: boolean;
  evaluate(ctx: ChallengeContext): Omit<ChallengeResult, 'official'>;
}

function riskPct(t: RoundTrip, ctx: ChallengeContext): number | null {
  const rps = initialRiskPerShare(t);
  if (rps === null) return null;
  const eq = equityAt(ctx.equityCurve, t.entryTime, ctx.startingBalance);
  return eq > 0 ? ((rps * t.maxQuantity) / eq) * 100 : null;
}

export const CHALLENGES: ChallengeDefinition[] = [
  {
    id: 'grow-20-1pct',
    title: 'Turn $10,000 into $12,000 risking ≤1% per trade',
    description: 'Every trade needs a stop loss, and the risk to that stop must be 1% of equity or less. One violation fails the challenge.',
    setup: { startingBalance: 10_000, mode: 'replay', multiDay: true },
    evaluate(ctx) {
      for (const t of ctx.trips) {
        const r = riskPct(t, ctx);
        if (r === null) return { status: 'failed', progress: 0, detail: `Trade on ${t.symbol} had no stop loss.` };
        if (r > 1 + 1e-6) return { status: 'failed', progress: 0, detail: `A trade risked ${r.toFixed(2)}% (limit 1%).` };
      }
      const target = ctx.startingBalance * 1.2;
      const progress = Math.max(0, Math.min(1, (ctx.equity - ctx.startingBalance) / (target - ctx.startingBalance)));
      if (ctx.equity >= target) return { status: 'passed', progress: 1, detail: `Equity reached $${ctx.equity.toFixed(2)}.` };
      return { status: 'in_progress', progress, detail: `Equity $${ctx.equity.toFixed(2)} of $${target.toFixed(0)}. All trades within 1% risk so far.` };
    },
  },
  {
    id: 'day-max-dd-5',
    title: 'Trade a historical day without losing more than 5%',
    description: 'Take at least 3 trades. If equity ever falls 5% below the starting balance, the challenge fails. Passes when the replay ends.',
    setup: { startingBalance: 25_000, mode: 'replay' },
    requiresSessionEnd: true,
    evaluate(ctx) {
      const minEq = Math.min(ctx.startingBalance, ...ctx.equityCurve.map((p) => p.equity));
      const ddPct = ((ctx.startingBalance - minEq) / ctx.startingBalance) * 100;
      if (ddPct >= 5) return { status: 'failed', progress: 0, detail: `Equity fell ${ddPct.toFixed(2)}% below the start.` };
      const closed = ctx.trips.filter((t) => t.closed).length;
      if (ctx.sessionFinished) {
        return closed >= 3
          ? { status: 'passed', progress: 1, detail: `Finished the day; worst drawdown from start ${ddPct.toFixed(2)}%.` }
          : { status: 'failed', progress: closed / 3, detail: `Only ${closed} closed trades; the challenge needs at least 3.` };
      }
      return { status: 'in_progress', progress: Math.min(1, closed / 3) * 0.5, detail: `Worst drawdown from start ${ddPct.toFixed(2)}% of 5%. ${closed}/3 trades.` };
    },
  },
  {
    id: 'avg-rr-2',
    title: 'Average 2:1 planned reward/risk over 10 trades',
    description: 'Every trade needs a stop and a target. After 10 closed trades, the average planned reward:risk must be at least 2:1.',
    setup: { startingBalance: 25_000, mode: 'replay', multiDay: true },
    evaluate(ctx) {
      const closed = ctx.trips.filter((t) => t.closed);
      const rrs = closed.map(plannedRR);
      if (rrs.some((r) => r === null)) return { status: 'failed', progress: 0, detail: 'A trade was missing a stop or a target.' };
      const avg = rrs.length ? (rrs as number[]).reduce((a, b) => a + b, 0) / rrs.length : 0;
      if (closed.length >= 10) {
        return avg >= 2
          ? { status: 'passed', progress: 1, detail: `Average planned R:R ${avg.toFixed(2)}:1 over ${closed.length} trades.` }
          : { status: 'failed', progress: 1, detail: `Average planned R:R ${avg.toFixed(2)}:1 is below 2:1.` };
      }
      return { status: 'in_progress', progress: closed.length / 10, detail: `${closed.length}/10 trades, average planned R:R ${avg.toFixed(2)}:1.` };
    },
  },
  {
    id: 'rules-20',
    title: 'Complete 20 trades while following your rules',
    description: 'Uses the trading rules from Settings (risk limit, stop required, minimum R:R, trades per day, daily loss limit). Breaking any rule on any trade fails it.',
    setup: { startingBalance: 25_000, mode: 'replay', multiDay: true },
    evaluate(ctx) {
      const closed = ctx.trips.filter((t) => t.closed);
      for (const t of closed) {
        const checks = checkRules(
          { trip: t, fills: [], orders: [], revealedBars: [], timeframe: '1m', equityCurve: ctx.equityCurve, startingBalance: ctx.startingBalance, allTrips: ctx.trips, rules: ctx.rules },
          riskPct(t, ctx),
          plannedRR(t),
        );
        if (!followedAllRules(checks)) {
          const broken = checks.filter((c) => c.passed === false).map((c) => c.rule).join(', ');
          return { status: 'failed', progress: 0, detail: `Rule broken on a ${t.symbol} trade: ${broken}.` };
        }
      }
      if (closed.length >= 20) return { status: 'passed', progress: 1, detail: '20 trades, every rule followed.' };
      return { status: 'in_progress', progress: closed.length / 20, detail: `${closed.length}/20 trades, all rules followed so far.` };
    },
  },
  {
    id: 'positive-expectancy-15',
    title: 'Positive expectancy over 15 trades',
    description: 'After 15 closed trades your average P/L per trade (after costs) must be above zero.',
    setup: { startingBalance: 25_000, mode: 'sim' },
    evaluate(ctx) {
      const closed = ctx.trips.filter((t) => t.closed);
      const exp = closed.length ? closed.reduce((a, t) => a + t.pnl, 0) / closed.length : 0;
      if (closed.length >= 15) {
        return exp > 0
          ? { status: 'passed', progress: 1, detail: `Expectancy $${exp.toFixed(2)} per trade.` }
          : { status: 'failed', progress: 1, detail: `Expectancy $${exp.toFixed(2)} per trade.` };
      }
      return { status: 'in_progress', progress: closed.length / 15, detail: `${closed.length}/15 trades, expectancy so far $${exp.toFixed(2)}.` };
    },
  },
];

export function evaluateChallenge(def: ChallengeDefinition, ctx: ChallengeContext): ChallengeResult {
  return { ...def.evaluate(ctx), official: !ctx.rewound };
}
