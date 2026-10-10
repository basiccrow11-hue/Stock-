/**
 * Challenge definitions and evaluation. A challenge is evaluated against a session's trades and
 * equity curve; it can pass, fail, or still be in progress. Sessions that used rewind/restart are
 * marked unofficial: you have seen the future, so the result cannot count as a blind result.
 */
import type { EquityPoint, Fill, RoundTrip } from '../types';
import { plannedRR, plannedRRGap, initialRiskPerShare, riskBasis, rMultiple } from '../analytics/stats';
import { equityBeforeEntry, followedAllRules, checkRules, riskOverLife, type TradingRules } from '../learning/review';
import { over } from '../risk/risk';
import { formatExchangeDateTime } from '../time';

export interface ChallengeContext {
  trips: readonly RoundTrip[];
  /** Every fill of the session: a trade's risk is measured against the equity just before it opened. */
  fills: readonly Fill[];
  equityCurve: readonly EquityPoint[];
  startingBalance: number;
  equity: number;
  /** True once the replay reached its end time. */
  sessionFinished: boolean;
  rewound: boolean;
  /** The trading rules as they were when the attempt started, so editing Settings mid-challenge does not re-score it. */
  rules: TradingRules;
  /** How you marked your own rules on each trade's review (followed or broken, by the rule's text), by trade id. */
  ownRuleMarks?: ReadonlyMap<string, Readonly<Record<string, boolean>>>;
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

/** The risk planned to a trade's first stop, as % of the equity just before it opened. */
function riskPct(t: RoundTrip, ctx: ChallengeContext): number | null {
  const rps = initialRiskPerShare(t);
  if (rps === null) return null;
  const eq = equityBeforeEntry(t, ctx.fills, ctx.equityCurve, ctx.startingBalance);
  return eq > 0 ? ((rps * t.maxQuantity) / eq) * 100 : null;
}

/** The most a trade had at stake over its life (riskOverLife), as % of the equity just before it opened. */
function lifeRiskPct(t: RoundTrip, ctx: ChallengeContext): { pct: number | null; why: string } {
  const rps = initialRiskPerShare(t);
  const life = riskOverLife(t, rps !== null ? rps * t.maxQuantity : null);
  const eq = equityBeforeEntry(t, ctx.fills, ctx.equityCurve, ctx.startingBalance);
  return {
    pct: life.dollars !== null && eq > 0 ? (life.dollars / eq) * 100 : null,
    why: life.beforeStop ? ' before its stop was placed' : life.grew ? ' at its largest, after a stop moved further away or shares were added with a wider stop' : '',
  };
}

export const CHALLENGES: ChallengeDefinition[] = [
  {
    id: 'grow-20-1pct',
    title: 'Turn $10,000 into $12,000 risking ≤1% per trade',
    description:
      'Every trade needs a stop loss, with the entry or placed after it, and the most it has at stake must stay at 1% of equity or less: to its stops at any point, and as open loss before its stop is placed. Shares left without a stop fail it. One violation fails the challenge.',
    setup: { startingBalance: 10_000, mode: 'replay', multiDay: true },
    evaluate(ctx) {
      for (const t of ctx.trips) {
        const eq = equityBeforeEntry(t, ctx.fills, ctx.equityCurve, ctx.startingBalance);
        if (t.initialStop === undefined) {
          // An open trade may still get its stop, but how far it has gone against you without one counts already.
          if (t.closed) return { status: 'failed', progress: 0, detail: `A trade on ${t.symbol} closed without a stop loss.` };
          const lost = eq > 0 ? (Math.max(0, -(t.worstOpenPnl ?? 0)) / eq) * 100 : 0;
          if (lost > 1 + 1e-6) return { status: 'failed', progress: 0, detail: `A trade on ${t.symbol} lost ${over(lost, 1, 2)}% before it had a stop (limit 1%).` };
          continue;
        }
        if (t.unprotectedAt !== undefined) return { status: 'failed', progress: 0, detail: `${t.unprotectedQty} shares of a trade on ${t.symbol} had no stop from ${formatExchangeDateTime(t.unprotectedAt)}.` };
        if (riskBasis(t)?.from === 'first') return { status: 'failed', progress: 0, detail: `A trade on ${t.symbol} added past its stop, so it risked more than planned.` };
        const { pct, why } = lifeRiskPct(t, ctx);
        if (pct === null) return { status: 'failed', progress: 0, detail: `The risk of a trade on ${t.symbol} to its stop could not be measured.` };
        if (pct > 1 + 1e-6) return { status: 'failed', progress: 0, detail: `A trade on ${t.symbol} risked ${over(pct, 1, 2)}%${why} (limit 1%).` };
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
      // A loop, not a spread: a long replay's curve has more points than a call can take as arguments.
      const minEq = ctx.equityCurve.reduce((m, p) => Math.min(m, p.equity), ctx.startingBalance);
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
      const bad = closed.find((_, i) => rrs[i] === null);
      if (bad) {
        const gap = plannedRRGap(bad);
        const why = { stop_past_average: 'its stop sat past its average entry', entry_past_target: 'its entry filled past its target', average_past_target: 'adds moved its average entry past its target' };
        return {
          status: 'failed',
          progress: 0,
          detail: gap === null || gap === 'no_stop_or_target' ? 'A trade was missing a stop or a target.' : `The planned reward:risk of a trade on ${bad.symbol} could not be measured: ${why[gap]}.`,
        };
      }
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
    id: 'achieved-rr-2',
    title: 'Achieve 2:1 reward/risk over 10 trades',
    description:
      'What your trades actually made, in R (P/L over the risk to the first stop), not what the ticket planned. Every trade needs a stop. After 10 closed trades your average win must be at least twice your average loss (with no losses, at least +2R).',
    setup: { startingBalance: 25_000, mode: 'replay', multiDay: true },
    evaluate(ctx) {
      const closed = ctx.trips.filter((t) => t.closed);
      const rs = closed.map(rMultiple);
      const bad = closed.find((_, i) => rs[i] === null);
      if (bad) return { status: 'failed', progress: 0, detail: `A trade on ${bad.symbol} had no stop its risk could be measured from, so its R is unknown.` };
      const wins = (rs as number[]).filter((r) => r > 0);
      const losses = (rs as number[]).filter((r) => r < 0);
      const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
      const avgLoss = losses.length ? -losses.reduce((a, b) => a + b, 0) / losses.length : 0;
      // Against a loss of 1R when there were none: a win of 2R is 2:1.
      const ratio = avgWin / (avgLoss || 1);
      const text = `average win ${avgWin.toFixed(2)}R, average loss ${losses.length ? `−${avgLoss.toFixed(2)}R` : 'none'}: ${ratio.toFixed(2)}:1`;
      if (closed.length >= 10) {
        return ratio >= 2 - 1e-9
          ? { status: 'passed', progress: 1, detail: `Over ${closed.length} trades, ${text}.` }
          : { status: 'failed', progress: 1, detail: `Over ${closed.length} trades, ${text}, below 2:1.` };
      }
      return { status: 'in_progress', progress: closed.length / 10, detail: `${closed.length}/10 trades, ${text} so far.` };
    },
  },
  {
    id: 'rules-20',
    title: 'Complete 20 trades while following your rules',
    description:
      'Uses your trading rules from Settings (risk limit, stop required, minimum R:R, trades per day, daily loss limit, and your own rules) as they were when the challenge started. The app checks its rules; you say on each trade\'s review whether you followed your own, and a trade counts once you have. Breaking any rule on any trade fails it.',
    setup: { startingBalance: 25_000, mode: 'replay', multiDay: true },
    evaluate(ctx) {
      const closed = ctx.trips.filter((t) => t.closed);
      const own = ctx.rules.custom ?? [];
      // Trades whose review still asks whether you followed your own rules: they count once you answer.
      let unmarked = 0;
      for (const t of closed) {
        const checks = checkRules(
          { trip: t, fills: ctx.fills, orders: [], revealedBars: [], timeframe: '1m', equityCurve: ctx.equityCurve, startingBalance: ctx.startingBalance, allTrips: ctx.trips, rules: ctx.rules },
          riskPct(t, ctx),
          plannedRR(t),
        );
        const marks = ctx.ownRuleMarks?.get(t.id);
        const brokeOwn = own.filter((rule) => marks?.[rule] === false);
        if (!followedAllRules(checks) || brokeOwn.length) {
          const broken = [...checks.filter((c) => c.passed === false).map((c) => c.rule), ...brokeOwn].join(', ');
          return { status: 'failed', progress: 0, detail: `Rule broken on a ${t.symbol} trade: ${broken}.` };
        }
        if (own.some((rule) => marks?.[rule] === undefined)) unmarked++;
      }
      const counted = closed.length - unmarked;
      if (counted >= 20) return { status: 'passed', progress: 1, detail: '20 trades, every rule followed.' };
      const waiting = unmarked ? ` ${unmarked} more ${unmarked === 1 ? 'trade counts' : 'trades count'} once you mark your own rules on ${unmarked === 1 ? 'its review' : 'their reviews'} (in the Journal).` : '';
      return { status: 'in_progress', progress: counted / 20, detail: `${counted}/20 trades, all rules followed so far.${waiting}` };
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
