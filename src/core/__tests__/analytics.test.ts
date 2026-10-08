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
    expect(review.findings.map((f) => f.title)).toContain('Stopped out, then price went your way');
    expect(review.rules.find((r) => r.rule.startsWith('Risk'))!.passed).toBe(true);

    // With only the bars revealed up to the exit, the review cannot know what happened later.
    const early = reviewTrade({ trip: st.roundTrips[0], fills: st.fills, orders: st.orders, revealedBars: bars.slice(0, 4), timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 10_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
    expect(early.afterExit!.reachedOriginalTarget).toBe(false);
  });

  it('waits for a fixed stretch after a stop before judging it, so the verdict does not depend on replay speed', () => {
    const t0 = et('2025-01-15', '10:00');
    const b = new SimBroker({ startingBalance: 10_000, config: ZERO_COST_CONFIG });
    const bars = [bar(t0, 100, 100, 100, 100)];
    b.onBar('T', bars[0]);
    b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 10, stopLoss: 99.5, takeProfit: 101 });
    // Stopped out in the first bar; then flat for 20 minutes, then a rally the window does not reach.
    const path: [number, number, number, number][] = [[100, 100.1, 99.4, 99.5], ...Array.from({ length: 21 }, () => [99.5, 99.6, 99.4, 99.5] as [number, number, number, number]), ...Array.from({ length: 10 }, () => [101, 101.5, 100.9, 101.2] as [number, number, number, number])];
    path.forEach(([o, h, l, c], i) => {
      const nb = bar(t0 + 60 * (i + 1), o, h, l, c);
      bars.push(nb);
      b.onBar('T', nb);
    });
    const st = b.state;
    const trip = st.roundTrips[0];
    const at = (shown: number, now: number, ended = false) =>
      reviewTrade({ trip, fills: st.fills, orders: st.orders, revealedBars: bars.slice(0, shown), timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 10_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES, now, ended });
    const exit = trip.exitTime!;
    // Right after the stop (one step): nothing to judge yet, and the review says what it waits for.
    const waiting = at(2, exit + 60);
    expect(waiting.afterExit).toBeNull();
    expect(waiting.afterExitUntil).toBe(exit + 20 * 60);
    expect(waiting.findings.map((f) => f.title)).toContain('What price does next');
    expect(waiting.findings.map((f) => f.title)).not.toContain('Stop did its job');
    // A slow step-through and a jump far past the window give the same verdict, on the same 20 minutes.
    const stepped = at(23, exit + 20 * 60);
    const jumped = at(bars.length, exit + 3 * 3600);
    for (const r of [stepped, jumped]) {
      expect(r.afterExitUntil).toBeUndefined();
      expect(r.findings.find((f) => f.title === 'Stop did its job')!.detail).toContain('In the 20 minutes after you exited, price did not recover meaningfully (best 0.10 in your direction).');
    }
    expect(stepped.afterExit).toEqual(jumped.afterExit);
    // The replay ended inside the window: judged on what it showed, and said so.
    const ended = at(6, exit + 4 * 60, true);
    expect(ended.findings.find((f) => f.title === 'Stop did its job')!.detail).toContain('In the 4 bars the replay showed after you exited');
  });

  it('measures MFE/MAE as the best and worst open P/L, through partial exits and adds', () => {
    const t0 = et('2025-01-15', '09:30');
    const at = (b: SimBroker, i: number, px: number) => b.onBar('T', bar(t0 + 60 * i, px, px, px, px));
    const review = (b: SimBroker) => {
      const st = b.state;
      return reviewTrade({ trip: st.roundTrips[0], fills: st.fills, orders: st.orders, revealedBars: [], timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 1_000_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
    };

    // Scale out: 900 of 1000 shares sold 0.50 up, the last 100 ride 10 up. The peak open P/L is the result.
    const out = new SimBroker({ startingBalance: 1_000_000, config: ZERO_COST_CONFIG });
    at(out, 0, 100);
    out.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 1000 });
    at(out, 1, 100.5);
    out.submit({ symbol: 'T', action: 'sell', type: 'market', quantity: 900 });
    at(out, 2, 110);
    out.submit({ symbol: 'T', action: 'sell', type: 'market', quantity: 100 });
    const kept = review(out);
    expect(out.state.roundTrips[0].pnl).toBeCloseTo(1450, 6);
    expect(kept.mfe.dollars).toBeCloseTo(1450, 6);
    expect(kept.capturePct).toBeCloseTo(100, 6);
    expect(kept.findings.map((f) => f.title)).toContain('Captured most of the move');

    // Scale in: 100 at 100 (stop 95), 900 more at 110, all out at 108. Price never went below 100.
    const add = new SimBroker({ startingBalance: 1_000_000, config: ZERO_COST_CONFIG });
    at(add, 0, 100);
    add.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 100, stopLoss: 95 });
    at(add, 1, 110);
    add.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 900 });
    at(add, 2, 108);
    add.closePosition('T');
    const added = review(add);
    expect(add.state.roundTrips[0].pnl).toBeCloseTo(-1000, 6);
    expect(added.mae.dollars).toBeCloseTo(1000, 6);
    expect(added.mfe.dollars).toBeCloseTo(1000, 6);
    expect(added.findings[0].detail).toContain('at best +$1000.00 and at worst −$1000.00');
  });

  describe('how the trade was closed', () => {
    const t0 = et('2025-01-15', '09:30');
    /** Long 100 at 100 (stop 99, target 104 unless given), then `script` runs with a bar function. */
    const run = (script: (b: SimBroker, next: (o: number, h: number, l: number, c: number) => void) => void, bracket: { stopLoss?: number; takeProfit?: number } = { stopLoss: 99, takeProfit: 104 }) => {
      const b = new SimBroker({ startingBalance: 100_000, config: ZERO_COST_CONFIG });
      const bars = [bar(t0, 100, 100, 100, 100)];
      b.onBar('T', bars[0]);
      b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 100, ...bracket });
      script(b, (o, h, l, c) => {
        const nb = bar(t0 + 60 * bars.length, o, h, l, c);
        bars.push(nb);
        b.onBar('T', nb);
      });
      const st = b.state;
      expect(st.roundTrips[0].closed).toBe(true);
      const review = reviewTrade({ trip: st.roundTrips[0], fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
      return { review, titles: review.findings.map((f) => f.title), text: review.findings.map((f) => `${f.title}: ${f.detail}`).join('\n') };
    };
    const flat = (next: (o: number, h: number, l: number, c: number) => void, px: number) => next(px, px, px, px);

    it('says the loss was capped as planned only when the stop filled at its price', () => {
      const planned = run((_, next) => {
        next(100, 100.2, 98.9, 99);
        flat(next, 98.8);
      });
      expect(planned.titles).toContain('Stop did its job');
      expect(planned.text).toContain('Your loss was capped where you planned.');

      // The next bar opens at 96, far through the 99 stop.
      const gapped = run((_, next) => {
        next(96, 96.5, 95.5, 96.2);
        flat(next, 96);
      });
      expect(gapped.review.exitReason).toBe('stop_loss');
      expect(gapped.titles).toContain('Stop filled well past its price');
      expect(gapped.text).toContain('Your stop at 99.00 filled at 96.00, 3.00 past it, so this exit was -4.00R per share instead of the planned -1.00R.');
      expect(gapped.text).not.toContain('capped');
      expect(gapped.text).toContain('A stop turns into a market order');

      // The same gap through a stop-limit put in place of the bracket stop: a limit, not a market order.
      const stopLimit = run((b, next) => {
        b.cancel(b.state.orders.find((o) => o.parentId && o.type === 'stop')!.id);
        b.submit({ symbol: 'T', action: 'sell', type: 'stop_limit', stopPrice: 99, limitPrice: 95, quantity: 100 });
        next(96.5, 97, 96, 96.2);
        flat(next, 96);
      }, { stopLoss: 99 });
      expect(stopLimit.titles).toContain('Stop filled well past its price');
      expect(stopLimit.text).toContain('A stop-limit becomes a limit order at 95.00 when price reaches its stop');
      expect(stopLimit.text).not.toContain('market order');
    });

    it('describes a stop moved into profit or widened for what it was', () => {
      const trailed = run((b, next) => {
        flat(next, 102);
        b.modify(b.state.orders.find((o) => o.parentId && o.type === 'stop')!.id, { stopPrice: 101.5 });
        next(102, 102, 101, 101.2);
        flat(next, 101);
      });
      expect(trailed.review.outcome).toBe('win');
      expect(trailed.titles).toContain('Your moved stop closed the trade');
      expect(trailed.text).toContain('You had moved your stop from 99.00 to 101.50, and it filled at 101.50: +$150.00 on the trade after costs.');
      expect(trailed.text).not.toContain('capped');

      const widened = run((b, next) => {
        b.modify(b.state.orders.find((o) => o.parentId && o.type === 'stop')!.id, { stopPrice: 98 });
        next(100, 100, 97.9, 98);
        flat(next, 97.9);
      });
      expect(widened.titles).toContain('You widened your stop');
      expect(widened.text).toContain('this exit was -2.00R per share instead of the planned -1.00R');
    });

    it('classifies exits by the closing order, bracket or not', () => {
      const userStop = run((b, next) => {
        b.submit({ symbol: 'T', action: 'sell', type: 'stop', quantity: 100, stopPrice: 99 });
        next(100, 100, 98.9, 99);
      }, {});
      expect(userStop.review.exitReason).toBe('stop_loss');
      expect(userStop.review.findings[0].detail).toContain('via your stop loss');

      const userTarget = run((b, next) => {
        b.submit({ symbol: 'T', action: 'sell', type: 'limit', quantity: 100, limitPrice: 101 });
        next(100, 101.2, 100, 101);
      }, {});
      expect(userTarget.review.exitReason).toBe('take_profit');

      const limitAtLoss = run((b) => {
        b.submit({ symbol: 'T', action: 'sell', type: 'limit', quantity: 100, limitPrice: 99.5 });
      }, {});
      expect(limitAtLoss.review.exitReason).toBe('other');

      const market = run((b) => void b.closePosition('T'), {});
      expect(market.review.exitReason).toBe('manual');

      // A target moved closer and filled there did not reach the planned one.
      const early = run((b, next) => {
        b.modify(b.state.orders.find((o) => o.parentId && o.type === 'limit')!.id, { limitPrice: 102 });
        next(100, 102.5, 100, 102.2);
      });
      expect(early.review.exitReason).toBe('take_profit');
      expect(early.titles).not.toContain('Target reached');
      expect(early.titles).toContain('Target not reached');
      const target = run((_, next) => next(100, 104.5, 100, 104.2));
      expect(target.titles).toContain('Target reached');
    });

    /** Long 1000 at 100 (stop 98, target 102) where each bar fills at most a quarter of its volume. */
    const thin = (script: (next: (o: number, h: number, l: number, c: number, v: number) => void) => void) => {
      const b = new SimBroker({ startingBalance: 200_000, config: { ...ZERO_COST_CONFIG, maxParticipation: 0.25 } });
      const bars = [bar(t0, 100, 100, 100, 100, 100_000)];
      b.onBar('T', bars[0]);
      b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 1000, stopLoss: 98, takeProfit: 102 });
      script((o, h, l, c, v) => {
        const nb = bar(t0 + 60 * bars.length, o, h, l, c, v);
        bars.push(nb);
        b.onBar('T', nb);
      });
      const st = b.state;
      const review = reviewTrade({ trip: st.roundTrips[0], fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 200_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
      return { review, find: (title: string) => review.findings.find((f) => f.title === title)?.detail };
    };

    it('goes by the order that closed most of a trade closed in parts', () => {
      const stopFirst = thin((next) => {
        next(100, 100.2, 97.8, 98.5, 3200); // the stop takes 800 at 98
        next(98.5, 101, 98.4, 100.9, 100_000);
        next(100.9, 102.4, 100.8, 102.2, 100_000); // the target takes the last 200 at 102
      });
      expect(stopFirst.review.exitReason).toBe('stop_loss');
      expect(stopFirst.review.findings[0].detail).toContain('exited @ 98.80 in 2 parts');
      expect(stopFirst.find('Closed in parts')).toBe('800 by your stop at 98.00, then 200 at your target at 102.00. The rest of this review goes by the order that closed the most shares.');
      expect(stopFirst.find('Target reached')).toContain('though only 200 of 1000 shares filled there');

      const half = thin((next) => {
        next(100, 102.5, 100.7, 101.2, 2000); // the target takes 500 at 102
        next(101.2, 101.3, 97.5, 97.8, 100_000); // the stop takes the other 500 at 98
        for (let i = 0; i < 3; i++) next(97.8, 98.2, 97.4, 97.9, 100_000);
      });
      expect(half.review.outcome).toBe('breakeven');
      expect(half.find('Stop did its job')).toContain('It closed 500 of 1000 shares where you planned.');
      expect(half.find('Stop did its job')).not.toContain('loss');
    });

    it('measures risk from the order price when a gap fills the entry past its own stop', () => {
      const b = new SimBroker({ startingBalance: 100_000, config: ZERO_COST_CONFIG });
      const bars = [bar(et('2025-01-15', '15:59'), 101, 101.2, 100.8, 101)];
      b.onBar('T', bars[0]);
      b.submit({ symbol: 'T', action: 'buy', type: 'limit', limitPrice: 100, quantity: 100, stopLoss: 99.5, takeProfit: 101.5, tif: 'gtc' });
      for (let i = 0; i < 5; i++) {
        bars.push(bar(et('2025-01-16', '09:30') + 60 * i, 99, 99.4, 98.8, 99.2));
        b.onBar('T', bars[bars.length - 1]);
      }
      const st = b.state;
      const t = st.roundTrips[0];
      expect([t.avgEntry, t.avgExit, t.plannedEntry]).toEqual([99, 99, 100]);
      const review = reviewTrade({ trip: t, fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
      expect([review.rMultiple, review.plannedRR, review.riskDollars]).toEqual([0, 3, 50]);
      const titles = review.findings.map((f) => f.title);
      expect(titles).toContain('Entry filled past your stop');
      expect(titles).not.toContain('No stop loss');
      expect(review.rules.filter((r) => r.passed === false)).toEqual([]);
      expect(evaluateChallenge(CHALLENGES.find((c) => c.id === 'grow-20-1pct')!, { trips: [t], equityCurve: st.equityCurve, startingBalance: 100_000, equity: 100_000, sessionFinished: false, rewound: false, rules: DEFAULT_TRADING_RULES }).status).toBe('in_progress');
    });

    it('measures risk from the price a market order was placed at when it fills at the next open past its stop', () => {
      const b = new SimBroker({ startingBalance: 100_000, config: ZERO_COST_CONFIG });
      const bars = [bar(et('2025-01-15', '15:59'), 101, 101.2, 100.8, 101), bar(et('2025-01-15', '16:05'), 101, 101, 101, 101, 5000)];
      for (const x of bars) b.onBar('T', x);
      // After the close: the market order waits for the next open.
      expect(b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 100, stopLoss: 100.5, takeProfit: 102.5 }).order!.status).toBe('pending');
      for (let i = 0; i < 5; i++) {
        bars.push(bar(et('2025-01-16', '09:30') + 60 * i, 100, 100.2, 99.8, 100));
        b.onBar('T', bars[bars.length - 1]);
      }
      const st = b.state;
      const t = st.roundTrips[0];
      expect([t.closed, t.firstEntry, t.plannedEntry]).toEqual([true, 100, 101]);
      const ctx = { equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES };
      const review = reviewTrade({ trip: t, fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', ...ctx });
      expect(review.plannedRR).toBe(3);
      expect(review.riskDollars).toBe(50);
      expect(review.rMultiple).not.toBeNull();
      const text = review.findings.map((f) => `${f.title}: ${f.detail}`).join('\n');
      expect(text).toContain('Entry filled past your stop: Your market order was placed with price at 101.00 and filled at the next open, 100.00, already past your stop at 100.50');
      expect(text).not.toContain('No stop loss');
      expect(review.rules.filter((r) => r.passed === false)).toEqual([]);
      for (const id of ['grow-20-1pct', 'avg-rr-2', 'rules-20']) {
        const c = CHALLENGES.find((x) => x.id === id)!;
        expect(evaluateChallenge(c, { trips: [t], equityCurve: st.equityCurve, startingBalance: 100_000, equity: 100_000, sessionFinished: false, rewound: false, rules: DEFAULT_TRADING_RULES }).status).toBe('in_progress');
      }
    });

    it('calls adding past the stop what it is, not a gap, and still measures R', () => {
      for (const firstType of ['limit', 'market'] as const) {
        const b = new SimBroker({ startingBalance: 100_000, config: ZERO_COST_CONFIG });
        const t0 = et('2025-01-15', '10:00');
        const bars = [bar(t0, 100, 100, 100, 100)];
        const next = (o: number, h: number, l: number, c: number) => {
          bars.push(bar(t0 + 60 * bars.length, o, h, l, c));
          b.onBar('T', bars[bars.length - 1]);
        };
        b.onBar('T', bars[0]);
        b.submit({ symbol: 'T', action: 'buy', type: firstType, limitPrice: firstType === 'limit' ? 100 : undefined, quantity: 100, stopLoss: 99, takeProfit: 103 });
        if (firstType === 'limit') next(100, 100, 100, 100);
        // Widen the stop, then buy more below the original stop.
        b.modify(b.state.orders.find((o) => o.parentId && o.type === 'stop')!.id, { stopPrice: 97.5 });
        next(98.5, 98.5, 98.5, 98.5);
        b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 300, stopLoss: 97.5 });
        next(98.5, 98.5, 97, 97.2);
        const st = b.state;
        const t = st.roundTrips[0];
        expect([t.closed, t.firstEntry, t.avgEntry]).toEqual([true, 100, 98.875]);
        const review = reviewTrade({ trip: t, fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
        const titles = review.findings.map((f) => f.title);
        expect(titles).not.toContain('Entry filled past your stop');
        expect(titles).not.toContain('No stop loss');
        expect(titles).toContain('You widened your stop');
        expect(titles).toContain('Added past your stop');
        expect(review.addedPastStop).toBe(true);
        expect(review.rMultiple).toBeCloseTo(-1.375, 9);
        expect(review.rules.find((r) => r.rule.startsWith('Risk'))).toMatchObject({ passed: false, detail: 'Added past your stop: more than the planned risk' });
        const grow = evaluateChallenge(CHALLENGES.find((c) => c.id === 'grow-20-1pct')!, { trips: [t], equityCurve: st.equityCurve, startingBalance: 100_000, equity: 100_000, sessionFinished: false, rewound: false, rules: DEFAULT_TRADING_RULES });
        expect(grow).toMatchObject({ status: 'failed', detail: 'A trade on T added past its stop, so it risked more than planned.' });
      }
    });
  });

  it('gives no share of open profit kept when price never moved a tick the trade’s way', () => {
    // A three-fill average entry with float noise: 100.09999999999998 against a high of 100.1.
    const avgEntry = (100.1 + 100.1 + 100.1) / 3;
    const t = trip({ avgEntry, highWhileOpen: 100.1, lowWhileOpen: 99.6, avgExit: 99.6, pnl: -50, initialStop: 99.6 });
    const review = reviewTrade({ trip: t, fills: [], orders: [], revealedBars: [], timeframe: '1m', equityCurve: [], startingBalance: 10_000, allTrips: [t], rules: DEFAULT_TRADING_RULES });
    expect(review.capturePct).toBeNull();
    const moved = reviewTrade({ trip: { ...t, highWhileOpen: 100.6, avgExit: 100.35, pnl: 25 }, fills: [], orders: [], revealedBars: [], timeframe: '1m', equityCurve: [], startingBalance: 10_000, allTrips: [t], rules: DEFAULT_TRADING_RULES });
    expect(moved.capturePct).toBeCloseTo(50, 6);
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
