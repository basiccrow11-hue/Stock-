import { describe, expect, it } from 'vitest';
import { computeStats, drawdown, plannedRR, rMultiple } from '../analytics/stats';
import { assessRisk, positionSizeForRisk } from '../risk/risk';
import { reviewTrade, DEFAULT_TRADING_RULES } from '../learning/review';
import { CHALLENGES, evaluateChallenge, type ChallengeContext } from '../challenges/challenges';
import { SimBroker } from '../broker/SimBroker';
import { ZERO_COST_CONFIG } from '../broker/config';
import type { RoundTrip } from '../types';
import { bar, et } from './helpers';

function trip(p: Partial<RoundTrip>): RoundTrip {
  return {
    id: Math.random().toString(36),
    symbol: 'T',
    direction: 'long',
    entryTime: et('2025-01-15', '10:00'),
    exitTime: et('2025-01-15', '10:30'),
    maxQuantity: 100,
    avgEntry: 100,
    avgExit: 101,
    entryQtyTotal: 100,
    exitQtyTotal: 100,
    pnl: 100,
    commission: 0,
    highWhileOpen: 101,
    lowWhileOpen: 99.5,
    fills: [],
    closed: true,
    source: 'DEMO',
    ...p,
  };
}

describe('performance statistics', () => {
  const trips = [trip({ pnl: 200, initialStop: 99, initialTarget: 103 }), trip({ pnl: -100, initialStop: 99, initialTarget: 102 }), trip({ pnl: 50 }), trip({ pnl: -50, direction: 'short', initialStop: 101 })];
  const curve = [10_000, 10_200, 10_100, 10_150, 10_100].map((equity, i) => ({ time: i, equity }));
  const s = computeStats(trips, curve, 10_000);

  it('computes win/loss metrics', () => {
    expect(s.totalTrades).toBe(4);
    expect(s.winningTrades).toBe(2);
    expect(s.losingTrades).toBe(2);
    expect(s.winRate).toBe(50);
    expect(s.averageWin).toBe(125);
    expect(s.averageLoss).toBe(-75);
    expect(s.profitFactor).toBeCloseTo(250 / 150, 10);
    expect(s.expectancy).toBe(25);
    expect(s.largestWin).toBe(200);
    expect(s.largestLoss).toBe(-100);
    expect(s.totalReturnPct).toBe(1);
    expect(s.longTrades).toBe(3);
    expect(s.shortTrades).toBe(1);
  });

  it('computes R multiples and planned reward/risk', () => {
    expect(rMultiple(trips[0])).toBe(2); // 200 / (1 * 100)
    expect(plannedRR(trips[0])).toBe(3);
    expect(s.averagePlannedRR).toBe(2.5);
    expect(s.averageR).toBeCloseTo((2 - 1 - 0.5) / 3, 10);
  });

  it('computes max drawdown from the equity curve', () => {
    const d = drawdown(curve);
    expect(d.maxDrawdown).toBe(100);
    expect(d.maxDrawdownPct).toBeCloseTo((100 / 10_200) * 100, 10);
  });

  it('handles an empty history', () => {
    const e = computeStats([], [], 10_000);
    expect(e.totalTrades).toBe(0);
    expect(e.winRate).toBe(0);
    expect(e.profitFactor).toBeNull();
  });
});

describe('risk calculations', () => {
  it('computes dollar risk, percent risk, reward and R:R', () => {
    const r = assessRisk({ action: 'buy', quantity: 100, entryPrice: 50, stopLoss: 49, takeProfit: 53, equity: 10_000 });
    expect(r.positionValue).toBe(5000);
    expect(r.stopDistance).toBe(1);
    expect(r.dollarRisk).toBe(100);
    expect(r.pctRisk).toBe(1);
    expect(r.reward).toBe(300);
    expect(r.rewardRiskRatio).toBe(3);
    expect(r.warnings).toHaveLength(0);
  });

  it('warns on large risk and on missing stops, for shorts too', () => {
    const r = assessRisk({ action: 'short', quantity: 470, entryPrice: 50, stopLoss: 51, equity: 10_000 });
    expect(r.direction).toBe('short');
    expect(r.warnings).toContain('WARNING: This trade risks 4.7% of your account.');
    expect(assessRisk({ action: 'buy', quantity: 1, entryPrice: 50, equity: 10_000 }).warnings[0]).toMatch(/No stop loss/);
  });

  it('sizes positions from risk', () => {
    expect(positionSizeForRisk(25_000, 1, 40, 39.5)).toBe(500);
    expect(positionSizeForRisk(25_000, 1, 40, 40)).toBe(0);
  });
});

describe('learning review', () => {
  it('reports MFE/MAE, R, exit reason, and post-exit movement from revealed bars only', () => {
    const b = new SimBroker({ startingBalance: 10_000, config: ZERO_COST_CONFIG });
    const t0 = et('2025-01-15', '09:30');
    const bars = [bar(t0, 100, 100, 100, 100)];
    b.onBar('T', bars[0]);
    b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 50, stopLoss: 99.8, takeProfit: 102 });
    const path: [number, number, number, number][] = [
      [100, 100.6, 99.9, 100.4],
      [100.4, 100.5, 99.7, 99.75], // stop at 99.8 hit
      [99.75, 101, 99.7, 100.9],
      [100.9, 102.4, 100.8, 102.2], // after exit, price reaches the original target
    ];
    path.forEach(([o, h, l, c], i) => {
      const nb = bar(t0 + 60 * (i + 1), o, h, l, c);
      bars.push(nb);
      b.onBar('T', nb);
    });
    const st = b.state;
    const review = reviewTrade({
      trip: st.roundTrips[0],
      fills: st.fills,
      orders: st.orders,
      revealedBars: bars,
      timeframe: '1m',
      equityCurve: st.equityCurve,
      startingBalance: 10_000,
      allTrips: st.roundTrips,
      rules: DEFAULT_TRADING_RULES,
    });
    expect(review.exitReason).toBe('stop_loss');
    expect(review.rMultiple).toBeCloseTo(-1, 6);
    expect(review.mfe.perShare).toBeCloseTo(0.6, 6);
    // Worst price while in the trade was the stop fill (99.80); the 99.70 low came after the exit.
    expect(review.mae.perShare).toBeCloseTo(0.2, 6);
    expect(review.afterExit!.reachedOriginalTarget).toBe(true);
    expect(review.findings.map((f) => f.title)).toContain('Stopped out, then price went your way (so far)');
    expect(review.rules.find((r) => r.rule.startsWith('Risk'))!.passed).toBe(true);

    // With only the bars revealed up to the exit, the review cannot know what happened later.
    const early = reviewTrade({ trip: st.roundTrips[0], fills: st.fills, orders: st.orders, revealedBars: bars.slice(0, 4), timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 10_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
    expect(early.afterExit!.reachedOriginalTarget).toBe(false);
  });
});

describe('challenges', () => {
  const base: ChallengeContext = { trips: [], equityCurve: [], startingBalance: 10_000, equity: 10_000, sessionFinished: false, rewound: false, rules: DEFAULT_TRADING_RULES };
  const grow = CHALLENGES.find((c) => c.id === 'grow-20-1pct')!;
  const dd = CHALLENGES.find((c) => c.id === 'day-max-dd-5')!;

  it('fails the 1% challenge on a trade without a stop or with too much risk', () => {
    expect(evaluateChallenge(grow, { ...base, trips: [trip({ initialStop: undefined })] }).status).toBe('failed');
    expect(evaluateChallenge(grow, { ...base, trips: [trip({ initialStop: 98 })], equityCurve: [{ time: 0, equity: 10_000 }] }).status).toBe('failed'); // 2%
    const ok = evaluateChallenge(grow, { ...base, trips: [trip({ initialStop: 99.5 })], equity: 11_000 });
    expect(ok.status).toBe('in_progress');
    expect(ok.progress).toBeCloseTo(0.5, 10);
    expect(evaluateChallenge(grow, { ...base, equity: 12_000 }).status).toBe('passed');
  });

  it('drawdown challenge fails at 5% below start and is unofficial after a rewind', () => {
    const r = evaluateChallenge(dd, { ...base, equityCurve: [{ time: 1, equity: 9_490 }] });
    expect(r.status).toBe('failed');
    const done = evaluateChallenge(dd, { ...base, rewound: true, sessionFinished: true, trips: [trip({}), trip({}), trip({})], equityCurve: [{ time: 1, equity: 9_800 }] });
    expect(done.status).toBe('passed');
    expect(done.official).toBe(false);
  });
});
