import { describe, expect, it } from 'vitest';
import { computeStats, drawdown, plannedRR, rMultiple } from '../analytics/stats';
import { assessRisk, positionSizeForRisk } from '../risk/risk';
import { reviewTrade, DEFAULT_TRADING_RULES } from '../learning/review';
import { CHALLENGES, evaluateChallenge, type ChallengeContext } from '../challenges/challenges';
import { SimBroker } from '../broker/SimBroker';
import { DEFAULT_EXECUTION_CONFIG, ZERO_COST_CONFIG } from '../broker/config';
import type { Bar, RoundTrip } from '../types';
import { ReplaySession } from '../replay/ReplaySession';
import { ReplayEngine } from '../replay/ReplayEngine';
import { bar, et, minuteBars } from './helpers';

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

    it("does not call a sub-dollar short's stop at $1 filled past its price when only the cent rounding took it there", () => {
      const verdict = (entry: number, stop: number) => {
        const b = new SimBroker({ startingBalance: 100_000, config: DEFAULT_EXECUTION_CONFIG });
        const t0 = et('2025-01-15', '10:00');
        const bars: Bar[] = [];
        const next = (o: number, h: number, l: number, c: number) => {
          const nb = bar(t0 + 60 * bars.length, o, h, l, c, 5_000_000);
          bars.push(nb);
          b.onBar('T', nb);
        };
        for (let i = 0; i < 20; i++) next(entry, entry + 0.002, entry - 0.002, entry);
        expect(b.submit({ symbol: 'T', action: 'short', type: 'market', quantity: 20000, stopLoss: stop }).ok).toBe(true);
        // Price creeps up through the stop, 0.002 a bar: no gap.
        let p = entry;
        for (let i = 0; i < 12 && b.position('T').quantity !== 0; i++) {
          const n = +(p + 0.002).toFixed(4);
          next(p, n, p - 0.001, n);
          p = n;
        }
        for (let i = 0; i < 30; i++) next(p, p + 0.001, p - 0.001, p);
        const st = b.state;
        expect(st.fills.at(-1)!.price).toBe(stop + 0.01);
        return reviewTrade({ trip: st.roundTrips[0], fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES }).findings.map((f) => f.title);
      };
      // The cover stop fills at the next cent up from its stop, its half spread and slippage, as the same
      // short at $1.50 does.
      for (const [entry, stop] of [[0.99, 1], [0.998, 1.01], [1.5, 1.52]] as const) {
        expect(verdict(entry, stop)).not.toContain('Stop filled well past its price');
      }
    });

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
      const stopMost = thin((next) => {
        next(100, 102.5, 100, 102.2, 800); // the target takes 200 at 102
        next(101.5, 101.6, 97.5, 97.8, 100_000); // the stop takes the other 800 at 98
      });
      expect(stopMost.review.exitReason).toBe('stop_loss');
      expect(stopMost.review.findings[0].detail).toContain('exited @ 98.80 in 2 parts');
      expect(stopMost.find('Closed in parts')).toBe('200 at your target at 102.00, then 800 by your stop at 98.00. The rest of this review goes by the order that closed the most shares.');
      expect(stopMost.find('Target reached')).toContain('though only 200 of 1000 shares filled there');
      // A stop that fired sells what the volume cap left at the next bar, even after price recovers.
      const stopFirst = thin((next) => {
        next(100, 100.2, 97.8, 98.5, 3200); // the stop takes 800 at 98
        next(98.5, 101, 98.4, 100.9, 100_000); // and the last 200 at this bar's open
      });
      expect(stopFirst.review.exitReason).toBe('stop_loss');
      expect(stopFirst.review.findings[0].detail).toContain('exited @ 98.10 via your stop loss');
      expect(stopFirst.find('Closed in parts')).toBeUndefined();

      // The stop never moved: the rest filled above it because price came back, not because it was trailed.
      const rest = thin((next) => {
        next(100, 100.1, 97.9, 98.2, 800); // the stop takes 200 at 98
        next(101.5, 101.8, 101.2, 101.6, 100_000); // and the other 800 at this bar's open
      });
      expect(rest.review.exitReason).toBe('stop_loss');
      expect(rest.find('Your stop fired, and the rest filled after price came back')).toBe(
        "Your stop at 98.00 fired, but the volume cap (Data & Settings) let only 200 of its 1000 shares sell on the bar it fired, at 98.00. A stop that has fired is a market order, so the rest sold over the next bars as price came back, for an average of 100.80. That helped this time; had price kept going, the rest would have filled further past the stop. For a position this large against the stock's volume, a stop does not fix the exit price.",
      );
      expect(rest.find('Your moved stop closed the trade')).toBeUndefined();

      // A losing stop-out whose rest filled a little better still gets the verdict on what price did next.
      const lossRest = thin((next) => {
        next(100, 100.2, 97.8, 98.5, 3200); // the stop takes 800 at 98
        next(98.5, 101, 98.4, 100.9, 100_000); // and the last 200 at this bar's open, 98.50
        for (let i = 0; i < 25; i++) next(100.9, 101.1, 100.8, 101, 100_000);
      });
      expect(lossRest.review.outcome).toBe('loss');
      expect(lossRest.find('Your stop fired, and the rest filled after price came back')).toContain('for an average of 98.10. That helped this time');
      expect(lossRest.find('Stopped out, then price went your way')).toContain('price moved 3.00 (1.5R)');

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
      expect(evaluateChallenge(CHALLENGES.find((c) => c.id === 'grow-20-1pct')!, { trips: [t], fills: st.fills, equityCurve: st.equityCurve, startingBalance: 100_000, equity: 100_000, sessionFinished: false, rewound: false, rules: DEFAULT_TRADING_RULES }).status).toBe('in_progress');
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
      expect([t.closed, t.bracketEntry, t.plannedEntry]).toEqual([true, 100, 101]);
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
        expect(evaluateChallenge(c, { trips: [t], fills: st.fills, equityCurve: st.equityCurve, startingBalance: 100_000, equity: 100_000, sessionFinished: false, rewound: false, rules: DEFAULT_TRADING_RULES }).status).toBe('in_progress');
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
        expect([t.closed, t.bracketEntry, t.avgEntry]).toEqual([true, 100, 98.875]);
        const review = reviewTrade({ trip: t, fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
        const titles = review.findings.map((f) => f.title);
        expect(titles).not.toContain('Entry filled past your stop');
        expect(titles).not.toContain('No stop loss');
        expect(titles).toContain('You widened your stop');
        expect(titles).toContain('Added past your stop');
        expect(review.addedPastStop).toBe(true);
        expect(review.rMultiple).toBeCloseTo(-1.375, 9);
        expect(review.rules.find((r) => r.rule.startsWith('Risk'))).toMatchObject({ passed: false, detail: 'Added past your stop: more than the planned risk' });
        const grow = evaluateChallenge(CHALLENGES.find((c) => c.id === 'grow-20-1pct')!, { trips: [t], fills: st.fills, equityCurve: st.equityCurve, startingBalance: 100_000, equity: 100_000, sessionFinished: false, rewound: false, rules: DEFAULT_TRADING_RULES });
        expect(grow).toMatchObject({ status: 'failed', detail: 'A trade on T added past its stop, so it risked more than planned.' });
      }
    });

    // Opened at market without a stop at 90 (100 shares), then an add at market brings the first stop.
    function pyramid(add: number, stop: number) {
      const b = new SimBroker({ startingBalance: 100_000, config: ZERO_COST_CONFIG });
      const t0 = et('2025-01-15', '10:00');
      const bars = [bar(t0, 90, 90, 90, 90)];
      const next = (o: number, h: number, l: number, c: number) => {
        bars.push(bar(t0 + 60 * bars.length, o, h, l, c));
        b.onBar('T', bars[bars.length - 1]);
      };
      b.onBar('T', bars[0]);
      b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 100 });
      next(95, 100, 95, 100);
      b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: add, stopLoss: stop });
      next(100, 100, stop - 1, stop - 1); // the add's stop fills on the way down
      b.closePosition('T');
      next(stop - 1, stop - 1, stop - 1, stop - 1);
      const st = b.state;
      const t = st.roundTrips[0];
      const ctx = { equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES };
      const review = reviewTrade({ trip: t, fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', ...ctx });
      const grow = evaluateChallenge(CHALLENGES.find((c) => c.id === 'grow-20-1pct')!, { trips: [t], fills: st.fills, equityCurve: st.equityCurve, startingBalance: 100_000, equity: 100_000, sessionFinished: false, rewound: false, rules: DEFAULT_TRADING_RULES });
      return { t, review, grow, text: review.findings.map((f) => `${f.title}: ${f.detail}`).join('\n') };
    }

    it('takes a stop that came with an add from that add, not from the first entry made without one', () => {
      // 300 more at 100 with a stop at 95: average 97.50, so R is measured from it.
      const { t, review, grow, text } = pyramid(300, 95);
      expect([t.closed, t.stopFromAdd, t.bracketEntry, t.plannedEntry, t.avgEntry]).toEqual([true, true, 100, 100, 97.5]);
      expect(text).not.toContain('Entry filled past your stop');
      expect(text).not.toContain('next open');
      expect(review.rMultiple).not.toBeNull();
      expect(review.rules.find((r) => r.rule === 'Use a stop loss')).toMatchObject({ passed: false, detail: 'No stop at entry (one came with a later add, at 95.00)' });
      expect(grow).toMatchObject({ status: 'failed', detail: 'Trade on T had no stop loss on its first entry.' });
    });

    it('says a stop that came with an add past the average entry locked in a gain, not that there was no stop', () => {
      // 10 more at 100 with a stop at 99: average 90.91, below the stop.
      const { review, text } = pyramid(10, 99);
      expect(review.rMultiple).toBeNull();
      expect(text).toContain('No stop on your first entry: Your stop at 99.00 came with a later add, and it sat past your average entry of 90.91');
      expect(text).not.toContain('No stop loss');
      expect(text).not.toContain('Added past your stop');
      expect(review.rules.find((r) => r.rule.startsWith('Risk'))).toMatchObject({ passed: null, detail: 'Not measurable: the stop sat past your average entry' });
    });

    it('measures planned R:R from the order’s price when the entry fills past its own target, and calls the exit the target', () => {
      const b = new SimBroker({ startingBalance: 100_000, config: ZERO_COST_CONFIG });
      const bars = [bar(et('2025-01-15', '15:59'), 100, 100.2, 99.8, 100), bar(et('2025-01-15', '16:05'), 100, 100, 100, 100, 5000)];
      for (const x of bars) b.onBar('T', x);
      // After the close, planned 2:1 from 100: stop 99, target 102. The next day opens at 102.50.
      expect(b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 100, stopLoss: 99, takeProfit: 102 }).order!.status).toBe('pending');
      for (let i = 0; i < 3; i++) {
        bars.push(bar(et('2025-01-16', '09:30') + 60 * i, 102.5, 102.6, 102.4, 102.5));
        b.onBar('T', bars[bars.length - 1]);
      }
      const st = b.state;
      const t = st.roundTrips[0];
      expect([t.closed, t.avgEntry, t.plannedEntry]).toEqual([true, 102.5, 100]);
      expect(plannedRR(t)).toBe(2);
      const ctx = { equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES };
      const review = reviewTrade({ trip: t, fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', ...ctx });
      expect(review.exitReason).toBe('take_profit');
      const text = review.findings.map((f) => `${f.title}: ${f.detail}`).join('\n');
      expect(text).toContain('via your profit target');
      expect(text).toContain('Entry filled past your target: Your market order was placed with price at 100.00 and filled at the next open, 102.50, already past your target at 102.00.');
      expect(text).not.toContain('Target reached');
      expect(review.rules.find((r) => r.rule.startsWith('Planned'))).toMatchObject({ passed: true, detail: '2.00:1' });
      const rr = evaluateChallenge(CHALLENGES.find((c) => c.id === 'avg-rr-2')!, { trips: [t], fills: st.fills, equityCurve: st.equityCurve, startingBalance: 100_000, equity: 100_000, sessionFinished: false, rewound: false, rules: DEFAULT_TRADING_RULES });
      expect(rr.status).toBe('in_progress');
    });
  });

  describe('a target that came with an add, and entries that cannot fill past their own brackets', () => {
    const review = (b: SimBroker, bars: ReturnType<typeof bar>[]) => {
      const st = b.state;
      const t = st.roundTrips[0];
      const r = reviewTrade({ trip: t, fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
      const rr = evaluateChallenge(CHALLENGES.find((c) => c.id === 'avg-rr-2')!, { trips: [t], fills: st.fills, equityCurve: st.equityCurve, startingBalance: 100_000, equity: 100_000, sessionFinished: false, rewound: false, rules: DEFAULT_TRADING_RULES });
      return { t, r, rr, text: r.findings.map((f) => `${f.title}: ${f.detail}`).join('\n'), rule: r.rules.find((x) => x.rule.startsWith('Planned'))! };
    };
    // Long 100 at 100 with a stop at 98 and no target; then, averaging down, 100 more at 99 with a target at 99.80.
    function averagedDown() {
      const b = new SimBroker({ startingBalance: 100_000, config: ZERO_COST_CONFIG });
      const t0 = et('2025-01-15', '10:00');
      const bars = [bar(t0, 100, 100, 100, 100)];
      const next = (o: number, h: number, l: number, c: number) => {
        bars.push(bar(t0 + 60 * bars.length, o, h, l, c));
        b.onBar('T', bars[bars.length - 1]);
      };
      b.onBar('T', bars[0]);
      b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 100, stopLoss: 98 });
      next(99, 99, 99, 99);
      expect(b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 100, stopLoss: 98, takeProfit: 99.8 }).ok).toBe(true);
      return { b, bars, next };
    }

    it('checks that target against the add’s own fill, not the first entry', () => {
      const { b, bars, next } = averagedDown();
      next(99, 99.9, 99, 99.9); // the add's target fills at 99.80
      b.closePosition('T');
      const { t, r, text, rule } = review(b, bars);
      expect([t.closed, t.initialTarget, t.targetEntry, t.targetPlanned, t.avgEntry]).toEqual([true, 99.8, 99, 99, 99.5]);
      expect(plannedRR(t)).toBeCloseTo(0.2, 9);
      expect(text).not.toContain('Entry filled past your target');
      expect(text).not.toContain('next open');
      expect(r.findings.map((f) => f.title)).toContain('Target reached');
      expect(rule.detail).toBe('0.20:1');
    });

    it('says adds moved the average past the target when that is why planned R:R cannot be measured', () => {
      const { b, bars, next } = averagedDown();
      next(100.4, 100.4, 100.4, 100.4); // gaps over the target, which fills at 100.40
      b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 300 });
      b.closePosition('T');
      const { t, text, rule, rr } = review(b, bars);
      expect(t.avgEntry).toBeCloseTo(100.04, 9);
      expect(plannedRR(t)).toBeNull();
      expect(text).not.toContain('Entry filled past your target');
      expect(rule).toMatchObject({ passed: false, detail: 'Not measurable: your adds moved your average entry past the target' });
      expect(rr).toMatchObject({ status: 'failed', detail: 'The planned reward:risk of a trade on T could not be measured: adds moved its average entry past its target.' });
    });

    it('refuses a price change that puts an entry past its own stop or target, and leaves the order as it was', () => {
      const b = new SimBroker({ startingBalance: 100_000, config: ZERO_COST_CONFIG });
      b.onBar('T', bar(et('2025-01-15', '10:00'), 100, 100, 100, 100));
      const limit = b.submit({ symbol: 'T', action: 'buy', type: 'limit', limitPrice: 99.4, quantity: 10, stopLoss: 98.4, takeProfit: 99.8 }).order!;
      expect(b.modify(limit.id, { limitPrice: 100.05 })).toEqual({ ok: false, error: 'Take profit must be above the entry price for a long: this limit is already through the market, so it would fill at once at about 100.00.' });
      expect(b.modify(limit.id, { limitPrice: 99.9 })).toEqual({ ok: false, error: 'Take profit must be above the entry price for a long.' });
      expect(b.state.orders.find((o) => o.id === limit.id)!.limitPrice).toBe(99.4);
      const stop = b.submit({ symbol: 'T', action: 'buy', type: 'stop', stopPrice: 101, quantity: 10, stopLoss: 100.5 }).order!;
      expect(b.modify(stop.id, { stopPrice: 100.4 })).toEqual({ ok: false, error: 'Stop loss must be below the entry price for a long.' });
      expect(b.modify(stop.id, { stopPrice: 101.5 }).ok).toBe(true);
      // So does a buy stop below the market, and a sell stop above it, which trigger at once.
      expect(b.modify(stop.id, { stopPrice: 99 })).toEqual({ ok: false, error: 'Stop loss must be below the entry price for a long: this stop is already through the market, so it would fill at once at about 100.00.' });
      expect(b.submit({ symbol: 'T', action: 'buy', type: 'stop', stopPrice: 99, quantity: 10, stopLoss: 98.5, takeProfit: 99.8 })).toMatchObject({
        ok: false,
        error: 'Take profit must be above the entry price for a long: this stop is already through the market, so it would fill at once at about 100.00.',
      });
      // A buy limit above the market fills at once at the market, so its stop must be below that too.
      expect(b.submit({ symbol: 'T', action: 'buy', type: 'limit', limitPrice: 101, quantity: 10, stopLoss: 100.5 })).toMatchObject({
        ok: false,
        error: 'Stop loss must be below the entry price for a long: this limit is already through the market, so it would fill at once at about 100.00.',
      });
      expect(b.state.fills).toEqual([]);
    });

    it('blames the spread and slippage, not a gap, for a market entry that fills past a target that close', () => {
      const b = new SimBroker({ startingBalance: 100_000, config: { ...ZERO_COST_CONFIG, slippage: { bps: 5, impactBpsPerPctOfVolume: 0 } } });
      const t0 = et('2025-01-15', '10:00');
      const bars = [bar(t0, 100, 100, 100, 100), bar(t0 + 60, 100.1, 100.1, 100.1, 100.1)];
      b.onBar('T', bars[0]);
      b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 10, stopLoss: 99, takeProfit: 100.02 });
      b.onBar('T', bars[1]);
      const { t, text } = review(b, bars);
      expect([t.closed, t.targetEntry]).toEqual([true, 100.05]);
      expect(text).toContain('Entry filled past your target: Your market order at 100.00 filled at 100.05, past your target at 100.02: the spread and slippage of the fill alone carried it past a target that close.');
      expect(text).not.toMatch(/gapped|next open|bar's open/);
    });

    it('says price was already past both when an order on a hidden daily bar fills past its stop', () => {
      const b = new SimBroker({ startingBalance: 100_000, config: ZERO_COST_CONFIG });
      const day = (d: string, o: number, h: number, l: number, c: number) => bar(et(d, '09:30'), o, h, l, c);
      const bars = [day('2025-01-14', 99, 112, 98, 111), day('2025-01-15', 110, 114, 108, 112)];
      b.onBar('T', bars[0], 23_400);
      b.syncClock(et('2025-01-15', '12:00'));
      // Placed at noon below yesterday's close, while the day's bar is hidden: by then its path
      // (110 → 108 → 114 → 112) is near 108.92.
      expect(b.submit({ symbol: 'T', action: 'buy', type: 'limit', limitPrice: 110, quantity: 10, stopLoss: 109.5, tif: 'gtc' }).order!.status).toBe('pending');
      b.onBar('T', bars[1], 23_400);
      const { t, text } = review(b, bars);
      expect([t.closed, t.bracketEntry]).toEqual([true, 108.93]);
      expect(b.state.fills[0].time).toBeGreaterThanOrEqual(et('2025-01-15', '12:00'));
      expect(text).toContain('Entry filled past your stop: Your entry order at 110.00 filled at 108.93, already past your stop at 109.50: price was past both by the time the order could fill.');
      expect(text).not.toMatch(/gapped|next open|bar's open/);
    });
  });

  it('calls an add’s own bracket stop that, not a stop the user moved', () => {
    const t0 = et('2025-01-15', '09:30');
    const b = new SimBroker({ startingBalance: 100_000, config: ZERO_COST_CONFIG });
    const bars = [bar(t0, 100, 100, 100, 100)];
    const next = (o: number, h: number, l: number, c: number) => {
      bars.push(bar(t0 + 60 * bars.length, o, h, l, c));
      b.onBar('T', bars[bars.length - 1]);
    };
    b.onBar('T', bars[0]);
    b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 500, stopLoss: 98 });
    next(100, 100, 99, 99);
    b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 500, stopLoss: 97 }); // the add brings its own stop
    next(99, 99, 96.5, 96.6); // both stops fire; neither was ever modified
    const st = b.state;
    const review = reviewTrade({ trip: st.roundTrips[0], fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
    const titles = review.findings.map((f) => f.title);
    expect(titles).not.toContain('You widened your stop');
    expect(review.findings.find((f) => f.title === "Your add's stop was wider")?.detail).toBe(
      "The stop that came with your add, at 97.00, was further from your entry than your first stop at 98.00, so this exit was -1.67R per share instead of the planned -1.00R. An add with a wider stop takes the trade's risk past what you planned for it.",
    );
  });

  it("judges the stop an add brought by its own history, whatever happened to the first stop", () => {
    // 500 bought at 100 with a stop at 98; `before` runs before the add of 1000 at 99.50 with its own
    // stop at `addStop`, `after` after it; then price falls to 96.60 (or `low`).
    const trade = (addStop: number, before: (b: SimBroker) => void, after: (b: SimBroker, add: string) => void, low = 96.6, up = false) => {
      const t0 = et('2025-01-15', '09:30');
      const b = new SimBroker({ startingBalance: 100_000, config: ZERO_COST_CONFIG });
      const bars = [bar(t0, 100, 100, 100, 100)];
      const next = (o: number, h: number, l: number, c: number) => {
        bars.push(bar(t0 + 60 * bars.length, o, h, l, c));
        b.onBar('T', bars[bars.length - 1]);
      };
      b.onBar('T', bars[0]);
      b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 500, stopLoss: 98 });
      if (up) next(105, 105, 105, 105);
      before(b);
      next(up ? 105 : 99.5, up ? 105 : 99.5, up ? 105 : 99.5, up ? 105 : 99.5);
      const add = b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 1000, stopLoss: addStop }).order!;
      after(b, add.id);
      next(bars.at(-1)!.close, bars.at(-1)!.close, low, low);
      b.closePosition('T');
      next(low, low, low, low);
      const st = b.state;
      const r = reviewTrade({ trip: st.roundTrips[0], fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
      return r.findings.map((f) => `${f.title}: ${f.detail}`).join('\n');
    };
    const stopOf = (b: SimBroker, parent: string) => b.state.orders.find((o) => o.parentId === parent && o.type === 'stop')!.id;
    const first = (b: SimBroker) => stopOf(b, b.state.orders[0].id);
    const none = () => {};
    // The first stop tightened to 99, the add's own stop at 97 never touched: not a widened stop.
    const tightened = trade(97, (b) => b.modify(first(b), { stopPrice: 99 }), none);
    expect(tightened).not.toMatch(/You moved|widened/);
    expect(tightened).toContain("Your add's stop was wider: The stop that came with your add, at 97.00, was further from your entry than your first stop at 98.00");
    // The add's own stop tightened from 96 to 97 is still wider than the first, and says so.
    const addTightened = trade(96, none, (b, add) => b.modify(stopOf(b, add), { stopPrice: 97 }));
    expect(addTightened).not.toMatch(/widened/);
    expect(addTightened).toContain("Your add's stop was wider: The stop that came with your add, at 97.00 (you had moved it from 96.00), was further from your entry than your first stop at 98.00");
    // Moved away from where the add placed it, it is a widened stop, measured from there.
    const addWidened = trade(97, none, (b, add) => b.modify(stopOf(b, add), { stopPrice: 96 }), 95.6);
    expect(addWidened).toContain('You widened your stop: You moved the stop that came with your add from 97.00 to 96.00, further from your entry, so this exit was -2.20R per share instead of the -1.60R where it was placed (your first stop planned -1.00R).');
    // The first stop widened to 97 and the add's own stop placed there too: the widening is the user's.
    const firstWidened = trade(97, (b) => b.modify(first(b), { stopPrice: 97 }), none);
    expect(firstWidened).toContain('You widened your stop: You moved your first stop from 98.00 to 97.00, further from your entry, and the stop that came with your add was at 97.00, so this exit was');
    // A pyramid: the first stop trailed to 103, an add at 105 with its own stop at 104 closes most of it.
    const pyramid = trade(104, (b) => b.modify(first(b), { stopPrice: 103 }), none, 102.5, true);
    expect(pyramid).toContain("Your add's stop closed the trade: The stop that came with your add, at 104.00 (your first stop was at 98.00), filled at 104.00: +$");
    expect(pyramid).not.toMatch(/You (had )?moved/);
  });

  it('treats one entry order filled in parts by the volume cap as one entry, not as adds past the stop', () => {
    const b = new SimBroker({ startingBalance: 100_000, config: DEFAULT_EXECUTION_CONFIG });
    // Pre-market, where an extended-hours limit can fill but stops are not active yet.
    const t0 = et('2025-01-15', '08:00');
    const bars = [
      bar(t0, 100, 100, 100, 100, 4000),
      bar(t0 + 60, 100.1, 100.1, 99.4, 99.45, 4000), // 1000 of the 2000 fill at the limit (25% of the volume)
      bar(t0 + 120, 99, 99.1, 98.9, 99, 4000), // the rest of the same order fills at an open past the stop
      bar(et('2025-01-15', '09:30'), 99, 99.1, 98.9, 99, 40000), // the stop closes the trade at the open
    ];
    b.onBar('T', bars[0]);
    expect(b.submit({ symbol: 'T', action: 'buy', type: 'limit', limitPrice: 99.9, quantity: 2000, stopLoss: 99.5, takeProfit: 101, tif: 'day', extendedHours: true }).ok).toBe(true);
    for (const x of bars.slice(1)) b.onBar('T', x);
    const st = b.state;
    expect(st.roundTrips).toHaveLength(1);
    const t = st.roundTrips[0];
    expect(t.closed).toBe(true);
    expect(t.maxQuantity).toBe(2000);
    expect(t.bracketEntry).toBeCloseTo(t.avgEntry, 9);
    const r = reviewTrade({ trip: t, fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
    const titles = r.findings.map((f) => f.title);
    expect(titles).not.toContain('Added past your stop');
    expect(r.findings.find((f) => f.title === 'Entry filled past your stop')!.detail).toMatch(/^Your entry order at 99\.90 filled in 2 parts, each capped at a share of a bar's volume/);
    expect(r.rules.find((c) => c.rule.startsWith('Risk'))!.passed).toBe(true);
  });

  it("closes the trade with its stop before the rest of a part-filled entry fills at a gap, and cancels the rest", () => {
    const b = new SimBroker({ startingBalance: 100_000, config: DEFAULT_EXECUTION_CONFIG });
    const t0 = et('2025-01-15', '10:00');
    const bars = [
      bar(t0, 100, 100, 100, 100, 4000),
      bar(t0 + 60, 100.1, 100.1, 99.4, 99.45, 4000), // 1000 of the 2000 fill at the limit
      bar(t0 + 120, 99, 99.1, 98.9, 99, 4000), // gap past the stop: the stop sells first and closes the trade
      bar(t0 + 180, 99, 99.1, 98.9, 99, 40000), // the rest of the entry would fill here, with a stop already past the price
    ];
    b.onBar('T', bars[0]);
    const entry = b.submit({ symbol: 'T', action: 'buy', type: 'limit', limitPrice: 99.9, quantity: 2000, stopLoss: 99.5, takeProfit: 101, tif: 'day' }).order!;
    for (const x of bars.slice(1)) b.onBar('T', x);
    const st = b.state;
    expect(st.fills.map((f) => [f.time - t0, f.side, f.quantity])).toEqual([
      [85, 'buy', 1000],
      [120, 'sell', 1000],
    ]);
    // One order, one trade: the rest is cancelled when the trade it filled into closes, and the user is told.
    expect(st.roundTrips.map((t) => [t.maxQuantity, t.closed])).toEqual([[1000, true]]);
    expect(st.orders.find((o) => o.id === entry.id)).toMatchObject({
      status: 'cancelled',
      filledQty: 1000,
      conflict: true,
      rejectReason: 'It filled 1000 shares into the T trade, which has closed. Place it again to start a new trade.',
    });
    const r = reviewTrade({ trip: st.roundTrips[0], fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
    expect(r.findings.map((f) => f.title)).not.toContain('Added past your stop');
    expect(r.rules.find((c) => c.rule.startsWith('Risk'))!.passed).toBe(true);
  });

  it('turns one large entry on a thin stock into one trade when its stop fires while it is still filling', () => {
    // 5000 shares at 10 on 2000-share bars (a 500-share cap) while price drifts through the stop with no
    // gap: the stop and the rest of the entry would take turns, buying and selling every other bar.
    const b = new SimBroker({ startingBalance: 100_000, config: DEFAULT_EXECUTION_CONFIG });
    const t0 = et('2025-01-15', '10:00');
    const bars = [bar(t0, 10.05, 10.05, 10.05, 10.05, 2000)];
    for (let i = 1; i <= 8; i++) {
      const px = Math.round((10 - 0.1 * i) * 100) / 100;
      bars.push(bar(t0 + 60 * i, px + 0.1, px + 0.1, px, px, 2000));
    }
    for (let i = 9; i <= 20; i++) bars.push(bar(t0 + 60 * i, 9.4, 9.42, 9.38, 9.4, 2000));
    b.onBar('T', bars[0]);
    expect(b.submit({ symbol: 'T', action: 'buy', type: 'limit', limitPrice: 10, quantity: 5000, stopLoss: 9.6, takeProfit: 11, tif: 'day' }).ok).toBe(true);
    for (const x of bars.slice(1)) b.onBar('T', x);
    const st = b.state;
    expect(st.roundTrips.length).toBe(1);
    expect(st.roundTrips[0].closed).toBe(true);
    expect(b.position('T').quantity).toBe(0);
    expect(st.fills.filter((f) => f.side === 'buy').reduce((a, f) => a + f.quantity, 0)).toBeLessThan(5000);
  });

  it('counts a loss on a position carried from an earlier day toward the daily loss rule', () => {
    const b = new SimBroker({ startingBalance: 100_000, config: ZERO_COST_CONFIG });
    const bars = [bar(et('2025-01-14', '15:58'), 100, 100, 100, 100), bar(et('2025-01-14', '15:59'), 100, 100, 100, 100)];
    b.onBar('T', bars[0]);
    b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 1000, stopLoss: 94, takeProfit: 110, tif: 'gtc' });
    b.onBar('T', bars[1]);
    // It opens 4% of the account lower the next morning and is closed; then a new trade the same day.
    const d2 = [bar(et('2025-01-15', '09:30'), 96, 96, 96, 96), bar(et('2025-01-15', '09:31'), 96, 96, 96, 96)];
    b.onBar('T', d2[0]);
    b.closePosition('T');
    b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 100, stopLoss: 95, takeProfit: 99 });
    b.onBar('T', d2[1]);
    b.closePosition('T');
    const st = b.state;
    const r = reviewTrade({ trip: st.roundTrips[1], fills: st.fills, orders: st.orders, revealedBars: [...bars, ...d2], timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
    expect(r.rules.find((c) => c.rule.startsWith('Stop trading after'))).toEqual({ rule: 'Stop trading after −3% on the day', passed: false, detail: 'Down 4.00% on the day at entry' });
  });

  it('counts a stop-out earlier in the entry’s own bar toward the daily loss rule, on minute and daily bars', () => {
    const lossRule = (b: SimBroker, bars: ReturnType<typeof bar>[], timeframe: '1m' | '1D') => {
      const st = b.state;
      const t = st.roundTrips.find((x) => x.maxQuantity === 100)!;
      return reviewTrade({ trip: t, fills: st.fills, orders: st.orders, revealedBars: bars, timeframe, equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES }).rules.find((c) => c.rule.startsWith('Stop trading after'));
    };
    const failed = { rule: 'Stop trading after −3% on the day', passed: false, detail: 'Down 3.50% on the day at entry' };
    // 1m: long 1000 with a stop at 96.5 and a buy limit at 96 below it; the 10:00 bar falls through both.
    const m = new SimBroker({ startingBalance: 100_000, config: ZERO_COST_CONFIG });
    const t0 = et('2025-01-15', '09:58');
    const minute = [bar(t0, 100, 100, 100, 100), bar(t0 + 60, 100, 100, 99.5, 99.5), bar(t0 + 120, 99.5, 99.6, 95.9, 96.1), bar(t0 + 180, 96.1, 96.2, 96, 96.1)];
    m.onBar('T', minute[0]);
    m.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 1000, stopLoss: 96.5, takeProfit: 106, tif: 'day' });
    m.onBar('T', minute[1]);
    m.submit({ symbol: 'T', action: 'buy', type: 'limit', limitPrice: 96, quantity: 100, stopLoss: 95, takeProfit: 99, tif: 'day' });
    for (const x of minute.slice(2)) m.onBar('T', x);
    expect(m.state.roundTrips.map((t) => t.pnl)).toEqual([-3500, 0]);
    expect(lossRule(m, minute, '1m')).toEqual(failed);
    // 1D: a buy stop fills and is stopped out during the 15th, then a buy limit fills later that day.
    const d = new SimBroker({ startingBalance: 100_000, config: ZERO_COST_CONFIG });
    const day = (date: string, o: number, h: number, l: number, c: number) => bar(et(date, '09:30'), o, h, l, c);
    const daily = [day('2025-01-14', 100, 101, 99, 100), day('2025-01-15', 100, 100.5, 95, 95.5)];
    d.onBar('T', daily[0], 390 * 60);
    d.submit({ symbol: 'T', action: 'buy', type: 'stop', stopPrice: 100.2, quantity: 1000, stopLoss: 96.7, takeProfit: 110, tif: 'gtc' });
    d.submit({ symbol: 'T', action: 'buy', type: 'limit', limitPrice: 95.5, quantity: 100, stopLoss: 94, takeProfit: 99, tif: 'gtc' });
    d.onBar('T', daily[1], 390 * 60);
    expect(d.state.roundTrips.map((t) => t.pnl)).toEqual([-3500, 0]);
    expect(lossRule(d, daily, '1D')).toEqual(failed);
  });

  it('judges the daily loss and risk at a trade’s entry by time, whatever order several symbols’ daily bars were processed in', () => {
    // AAA long 1000 from the 14th with a stop at 96.5 (3.5% of the account); BBB buy limit 49.5 for the 15th, 500 shares, stop 47.5 (1%).
    const run = (order: string[], aaa15: Bar, bbb15: Bar) => {
      const data: Record<string, Bar[]> = {
        AAA: [bar(et('2025-01-14', '09:30'), 99, 101, 98, 100), aaa15, bar(et('2025-01-16', '09:30'), 95.5, 96, 95, 95.5)],
        BBB: [bar(et('2025-01-14', '09:30'), 50, 51, 49, 50), bbb15, bar(et('2025-01-16', '09:30'), 52, 52.5, 51.5, 52)],
      };
      const engines = order.map((s) => new ReplayEngine({ symbol: s, start: et('2025-01-15', '09:30'), end: et('2025-01-16', '16:00'), baseTimeframe: '1D' }, data[s]));
      const session = new ReplaySession(engines, { symbol: order[0], date: '2025-01-15', startTime: '09:30', endTime: '16:00', endDate: '2025-01-16', startingBalance: 100_000, lookbackDays: 1 }, ZERO_COST_CONFIG, 'd', 'HISTORICAL');
      session.submit({ symbol: 'AAA', action: 'buy', type: 'market', quantity: 1000, stopLoss: 96.5, takeProfit: 110, tif: 'gtc' });
      session.submit({ symbol: 'BBB', action: 'buy', type: 'limit', limitPrice: 49.5, quantity: 500, stopLoss: 47.5, takeProfit: 55, tif: 'gtc' });
      session.step();
      const st = session.broker.state;
      const a = st.roundTrips.find((t) => t.symbol === 'AAA')!;
      const b = st.roundTrips.find((t) => t.symbol === 'BBB')!;
      const rev = reviewTrade({ trip: b, fills: st.fills, orders: st.orders, revealedBars: session.engineFor('BBB')!.visibleBaseBars(), timeframe: '1D', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
      return { stopFirst: a.exitTime! < b.entryTime, rules: rev.rules.filter((r) => /^Risk|^Stop trading/.test(r.rule)).map((r) => [r.passed, r.detail]) };
    };
    // AAA is stopped out late in the day, after BBB's entry: not counted, in either order.
    const later = [bar(et('2025-01-15', '09:30'), 100, 101, 95, 95.5), bar(et('2025-01-15', '09:30'), 50, 53, 49, 52)] as const;
    for (const order of [['AAA', 'BBB'], ['BBB', 'AAA']]) {
      expect(run(order, ...later), order.join()).toEqual({ stopFirst: false, rules: [[true, '1.00%'], [true, 'Not down on the day at entry']] });
    }
    // AAA is stopped out early, before BBB's entry: counted, in either order.
    const earlier = [bar(et('2025-01-15', '09:30'), 100, 104.5, 95, 103), bar(et('2025-01-15', '09:30'), 50, 50.5, 49, 49.2)] as const;
    for (const order of [['AAA', 'BBB'], ['BBB', 'AAA']]) {
      expect(run(order, ...earlier), order.join()).toEqual({ stopFirst: true, rules: [[false, '1.04%'], [false, 'Down 3.50% on the day at entry']] });
    }
  });

  it('counts another symbol’s stop that gapped through at the open an entry filled at, whichever symbol is listed first', () => {
    const run = (order: string[]) => {
      const flat = (n: number, p: number) => Array.from({ length: n }, () => [p, p + 0.05, p - 0.05, p] as [number, number, number, number]);
      const data: Record<string, Bar[]> = {
        // AAA is held overnight with a stop at 97; the 15th opens at 95, through it.
        AAA: [...minuteBars('2025-01-14', '15:58', flat(2, 100)), ...minuteBars('2025-01-15', '09:30', flat(30, 95))],
        BBB: [...minuteBars('2025-01-14', '15:58', flat(2, 50)), ...minuteBars('2025-01-15', '09:30', flat(30, 50))],
      };
      const engines = order.map((x) => new ReplayEngine({ symbol: x, start: et('2025-01-14', '16:00'), end: et('2025-01-15', '10:00'), baseTimeframe: '1m' }, data[x]));
      const s = new ReplaySession(engines, { symbol: order[0], date: '2025-01-14', startTime: '16:00', endDate: '2025-01-15', endTime: '10:00', startingBalance: 100_000, lookbackDays: 1 }, ZERO_COST_CONFIG, 'g', 'HISTORICAL');
      s.submit({ symbol: 'AAA', action: 'buy', type: 'market', quantity: 1000, stopLoss: 97, takeProfit: 110, tif: 'gtc' });
      s.jumpTo(et('2025-01-15', '09:00'));
      // BBB sized to 1% of the $100,000 the account shows before the open, filled at the 09:30 open.
      s.submit({ symbol: 'BBB', action: 'buy', type: 'market', quantity: 2000, stopLoss: 49.5, takeProfit: 52, tif: 'day' });
      s.step();
      const st = s.broker.state;
      const a = st.roundTrips.find((t) => t.symbol === 'AAA')!;
      const b = st.roundTrips.find((t) => t.symbol === 'BBB')!;
      const rev = reviewTrade({ trip: b, fills: st.fills, orders: st.orders, revealedBars: s.engineFor('BBB')!.visibleBaseBars(), timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
      return { same: a.exitTime === b.entryTime, equity: rev.equityAtEntry, rules: rev.rules.filter((r) => /^Risk|^Stop trading/.test(r.rule)).map((r) => [r.passed, r.detail]) };
    };
    for (const order of [['AAA', 'BBB'], ['BBB', 'AAA']]) {
      expect(run(order), order.join()).toEqual({ same: true, equity: 95_000, rules: [[false, '1.05%'], [false, 'Down 5.00% on the day at entry']] });
    }
  });

  it('values a position opened at a gap at its price, not at the close before the gap, when judging a later entry', () => {
    // BBB is bought at the 15th's open, which gapped from 50 to 53; AAA's limit entry fills later that day.
    // AAA: 500 shares, stop 97 below a 99 entry = $1000 = 1% of the account. The account lost nothing.
    for (const order of [['AAA', 'BBB'], ['BBB', 'AAA']]) {
      const data: Record<string, Bar[]> = {
        AAA: [bar(et('2025-01-14', '09:30'), 99, 101, 98, 100), bar(et('2025-01-15', '09:30'), 100, 101, 98.5, 100), bar(et('2025-01-16', '09:30'), 100, 101, 99, 100)],
        BBB: [bar(et('2025-01-14', '09:30'), 49, 51, 48, 50), bar(et('2025-01-15', '09:30'), 53, 54, 52.5, 53.5), bar(et('2025-01-16', '09:30'), 53.5, 54, 53, 53.5)],
      };
      const engines = order.map((s) => new ReplayEngine({ symbol: s, start: et('2025-01-15', '09:30'), end: et('2025-01-16', '16:00'), baseTimeframe: '1D' }, data[s]));
      const session = new ReplaySession(engines, { symbol: order[0], date: '2025-01-15', startTime: '09:30', endTime: '16:00', endDate: '2025-01-16', startingBalance: 100_000, lookbackDays: 1 }, ZERO_COST_CONFIG, 'd', 'HISTORICAL');
      session.submit({ symbol: 'BBB', action: 'buy', type: 'market', quantity: 1000, tif: 'gtc' });
      session.submit({ symbol: 'AAA', action: 'buy', type: 'limit', limitPrice: 99, quantity: 500, stopLoss: 97, takeProfit: 110, tif: 'gtc' });
      session.step();
      const st = session.broker.state;
      const a = st.roundTrips.find((t) => t.symbol === 'AAA')!;
      expect(st.fills.find((f) => f.symbol === 'BBB')!.price).toBe(53);
      const rev = reviewTrade({ trip: a, fills: st.fills, orders: st.orders, revealedBars: session.engineFor('AAA')!.visibleBaseBars(), timeframe: '1D', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
      expect(rev.equityAtEntry, order.join()).toBe(100_000);
      expect(rev.rules.filter((r) => /^Risk|^Stop trading/.test(r.rule)).map((r) => [r.passed, r.detail])).toEqual([[true, '1.00%'], [true, 'Not down on the day at entry']]);
      const ctx = { trips: [a], fills: st.fills, equityCurve: st.equityCurve, startingBalance: 100_000, equity: 100_000, sessionFinished: false, rewound: false, rules: DEFAULT_TRADING_RULES };
      expect(evaluateChallenge(CHALLENGES.find((c) => c.id === 'grow-20-1pct')!, ctx).status).toBe('in_progress');
    }
  });

  it('leaves a daily bar’s fills out of a 1-minute entry made while that bar was still hidden, at 09:30 as at 09:31', () => {
    // AAA (daily) is held long 1000 from the 14th with a stop at 96.5; the 15th opens at 96, through the
    // stop. That bar is shown at the close, so a 1-minute BBB entry that morning saw an account still at
    // $100,000, as the ticket and Strict Mode did. BBB: 2000 shares with a stop 0.50 away = 1%.
    const verdict = (stepsBeforeEntry: number, order: string[]) => {
      const flat = (n: number) => Array.from({ length: n }, () => [50, 50.05, 49.95, 50] as [number, number, number, number]);
      const data: Record<string, { bars: Bar[]; tf: '1D' | '1m' }> = {
        AAA: { tf: '1D', bars: [bar(et('2025-01-14', '09:30'), 99, 101, 98, 100), bar(et('2025-01-15', '09:30'), 96, 97, 95, 96.5), bar(et('2025-01-16', '09:30'), 96, 97, 95, 96)] },
        BBB: { tf: '1m', bars: [...minuteBars('2025-01-14', '15:58', flat(2)), ...minuteBars('2025-01-15', '09:30', flat(390))] },
      };
      const engines = order.map((s) => new ReplayEngine({ symbol: s, start: et('2025-01-14', '16:00'), end: et('2025-01-15', '16:00'), baseTimeframe: data[s].tf }, data[s].bars));
      const s = new ReplaySession(engines, { symbol: order[0], date: '2025-01-14', startTime: '16:00', endTime: '16:00', endDate: '2025-01-15', startingBalance: 100_000, lookbackDays: 1 }, ZERO_COST_CONFIG, 'd', 'HISTORICAL');
      s.submit({ symbol: 'AAA', action: 'buy', type: 'market', quantity: 1000, stopLoss: 96.5, takeProfit: 120, tif: 'gtc' });
      s.jumpTo(et('2025-01-15', '09:00'));
      for (let i = 0; i < stepsBeforeEntry; i++) s.step();
      s.submit({ symbol: 'BBB', action: 'buy', type: 'market', quantity: 2000, stopLoss: 49.5, takeProfit: 52, tif: 'day' });
      while (!s.finished) s.step();
      const st = s.broker.state;
      const b = st.roundTrips.find((t) => t.symbol === 'BBB')!;
      const aaaStop = st.roundTrips.find((t) => t.symbol === 'AAA')!.exitTime!;
      expect(aaaStop).toBeLessThanOrEqual(b.entryTime);
      const rev = reviewTrade({ trip: b, fills: st.fills, orders: st.orders, revealedBars: s.engineFor('BBB')!.visibleBaseBars(), timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
      return { equity: rev.equityAtEntry, rules: rev.rules.filter((r) => /^Risk|^Stop trading/.test(r.rule)).map((r) => [r.passed, r.detail]) };
    };
    for (const order of [['AAA', 'BBB'], ['BBB', 'AAA']]) {
      for (const steps of [0, 1]) {
        expect(verdict(steps, order), `${order.join()} after ${steps}`).toEqual({ equity: 100_000, rules: [[true, '1.00%'], [true, 'Not down on the day at entry']] });
      }
    }
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
  const base: ChallengeContext = { trips: [], fills: [], equityCurve: [], startingBalance: 10_000, equity: 10_000, sessionFinished: false, rewound: false, rules: DEFAULT_TRADING_RULES };
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

describe('the review of a sub-dollar stock', () => {
  const t0 = et('2025-03-04', '10:00');
  const run = (stopLoss: number, entry: number, script: (b: SimBroker, next: (o: number, h: number, l: number, c: number) => void) => void) => {
    const b = new SimBroker({ startingBalance: 100_000, config: ZERO_COST_CONFIG });
    const bars = [bar(t0, entry, entry, entry, entry)];
    b.onBar('T', bars[0]);
    b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 40_000, stopLoss });
    script(b, (o, h, l, c) => {
      bars.push(bar(t0 + 60 * bars.length, o, h, l, c));
      b.onBar('T', bars[bars.length - 1]);
    });
    const st = b.state;
    const review = reviewTrade({ trip: st.roundTrips[0], fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
    return { review, text: review.findings.map((f) => `${f.title}: ${f.detail}`).join('\n') };
  };

  it('judges gaps, moved stops and kept profit by the tick, and writes prices to it', () => {
    // A gap from 0.4523 through the 0.4410 stop to 0.4300 is about -2R, not a loss capped as planned.
    const gap = run(0.441, 0.4523, (_, next) => next(0.43, 0.43, 0.429, 0.43));
    expect(gap.text).toContain('Stop filled well past its price: Your stop at 0.4410 filled at 0.4300, 0.0110 past it, so this exit was -1.97R per share instead of the planned -1.00R.');
    expect(gap.text).not.toContain('capped where you planned');
    expect(gap.review.rules.find((r) => r.rule === 'Use a stop loss')?.detail).toBe('Stop at 0.4410');
    // A stop moved from 0.4410 to 0.4380 is named with both prices.
    const widened = run(0.441, 0.4523, (b, next) => {
      b.modify(b.state.orders.find((o) => o.parentId && o.type === 'stop')!.id, { stopPrice: 0.438 });
      next(0.44, 0.44, 0.437, 0.437);
    });
    expect(widened.text).toContain('You widened your stop: You moved your stop from 0.4410 to 0.4380, further from your entry, so this exit was -1.27R per share instead of the planned -1.00R.');
    // Best open profit of 0.9 cents a share, of which 0.1 cent was kept.
    const gaveBack = run(0.49, 0.5, (b, next) => {
      next(0.5, 0.509, 0.5, 0.505);
      next(0.505, 0.505, 0.501, 0.501);
      b.closePosition('T');
    });
    expect(gaveBack.review.capturePct).toBeCloseTo(11.11, 1);
    expect(gaveBack.text).toContain('Gave back most of the open profit');
  });

  it('leaves the half spread out of how far past the stop it filled, and writes every price to the tick', () => {
    const t1 = et('2025-03-04', '10:00');
    const b = new SimBroker({ startingBalance: 100_000, config: DEFAULT_EXECUTION_CONFIG });
    const bars: Bar[] = [];
    const next = (o: number, h: number, l: number, c: number) => {
      bars.push(bar(t1 + 60 * bars.length, o, h, l, c, 10_000_000));
      b.onBar('T', bars[bars.length - 1]);
    };
    next(0.4523, 0.4523, 0.4523, 0.4523);
    b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 20_000, stopLoss: 0.441 });
    // Price trades down through the stop with no gap: the sell gets the bid, half a cent under.
    next(0.445, 0.445, 0.4405, 0.4405);
    const st = b.state;
    const exit = st.fills.find((f) => f.action === 'sell')!;
    expect(exit.price).toBe(0.4359);
    const review = reviewTrade({ trip: st.roundTrips[0], fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
    expect(review.findings.map((f) => f.title)).not.toContain('Stop filled well past its price');
  });

  it('names the first entry of a trade that added past its stop to the tick', () => {
    const { text } = run(0.441, 0.4523, (b, next) => {
      b.cancel(b.state.orders.find((o) => o.parentId && o.type === 'stop')!.id);
      next(0.45, 0.4502, 0.43, 0.431);
      b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 100_000 });
      next(0.431, 0.433, 0.43, 0.432);
      b.closePosition('T');
    });
    expect(text).toContain('from your first entry at 0.4523');
  });
});

describe('a risk just over the limit', () => {
  it('reads as over it in the review, the rules and the 1% challenge', () => {
    const b = new SimBroker({ startingBalance: 10_000, config: { ...ZERO_COST_CONFIG, marketOrderFill: 'next_bar_open' } });
    const t0 = et('2025-01-15', '10:00');
    const bars: Bar[] = [];
    const next = (o: number, h: number, l: number, c: number) => {
      bars.push(bar(t0 + 60 * bars.length, o, h, l, c));
      b.onBar('T', bars[bars.length - 1]);
    };
    next(50, 50, 50, 50);
    // 40 shares with a 2.50 stop risk $100 at 50.00; the next open is a cent higher, $100.40.
    b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 40, stopLoss: 47.5 });
    next(50.01, 50.2, 49.9, 50.1);
    b.closePosition('T');
    next(50.1, 50.2, 50, 50.1);
    const st = b.state;
    const review = reviewTrade({ trip: st.roundTrips[0], fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 10_000, allTrips: st.roundTrips, rules: DEFAULT_TRADING_RULES });
    expect(review.findings.find((f) => f.title.startsWith('Risked'))).toMatchObject({ tone: 'bad', title: 'Risked 1.004% of the account' });
    expect(review.rules.find((r) => r.rule.startsWith('Risk'))).toMatchObject({ passed: false, detail: '1.004%' });
    const ch = evaluateChallenge(CHALLENGES[0], { trips: st.roundTrips, fills: st.fills, equityCurve: st.equityCurve, startingBalance: 10_000, equity: b.account().equity, sessionFinished: false, rewound: false, rules: DEFAULT_TRADING_RULES });
    expect(ch).toMatchObject({ status: 'failed', detail: 'A trade risked 1.004% (limit 1%).' });
  });
});


describe('stops past $1 on sub-dollar trades, pre-market entries, and planned R:R from the expected fill', () => {
  const runTrade = (cfg: typeof DEFAULT_EXECUTION_CONFIG, startAt: string, prep: (b: SimBroker, next: (o: number, h: number, l: number, c: number) => void) => void, rules = DEFAULT_TRADING_RULES) => {
    const b = new SimBroker({ startingBalance: 100_000, config: cfg });
    const t0 = et('2025-01-15', startAt);
    const bars: Bar[] = [];
    const next = (o: number, h: number, l: number, c: number) => {
      const nb = bar(t0 + 60 * bars.length, o, h, l, c, 5_000_000);
      bars.push(nb);
      b.onBar('T', nb);
    };
    prep(b, next);
    const st = b.state;
    expect(st.roundTrips[0].closed).toBe(true);
    const review = reviewTrade({ trip: st.roundTrips[0], fills: st.fills, orders: st.orders, revealedBars: bars, timeframe: '1m', equityCurve: st.equityCurve, startingBalance: 100_000, allTrips: st.roundTrips, rules });
    return { review, titles: review.findings.map((f) => f.title), text: review.findings.map((f) => `${f.title}: ${f.detail}`).join('\n') };
  };

  it("calls a sub-dollar short's stop at $1.00 filled 3 cents past it well past, as on a $5 stock", () => {
    for (const [p, stop] of [[0.98, 1], [4.98, 5]] as const) {
      const { titles } = runTrade(DEFAULT_EXECUTION_CONFIG, '10:00', (b, next) => {
        for (let i = 0; i < 20; i++) next(p, p, p, p);
        expect(b.submit({ symbol: 'T', action: 'short', type: 'market', quantity: 10_000, stopLoss: stop, tif: 'gtc' }).ok).toBe(true);
        for (let i = 0; i < 2; i++) next(p, p, p, p);
        const o = +(stop + 0.02).toFixed(2);
        for (let i = 0; i < 26; i++) next(o, o + 0.002, o - 0.002, o);
      });
      expect(titles).toContain('Stop filled well past its price');
      expect(titles).not.toContain('Stop did its job');
    }
  });

  it('calls a stop filled well past it by the ticks of the price it filled at, below $1 for a trade above it', () => {
    const { titles } = runTrade(ZERO_COST_CONFIG, '10:00', (b, next) => {
      for (let i = 0; i < 20; i++) next(1.03, 1.03, 1.03, 1.03);
      expect(b.submit({ symbol: 'T', action: 'buy', type: 'market', quantity: 10_000, stopLoss: 1.01, tif: 'gtc' }).ok).toBe(true);
      // Gaps to 0.9878: 2.2 cents, over a whole R, past the stop at 1.01.
      for (let i = 0; i < 26; i++) next(0.9878, 0.9878, 0.9878, 0.9878);
    });
    expect(titles).toContain('Stop filled well past its price');
  });

  it('says a pre-market entry came before the open in the first-minutes rule', () => {
    const { review } = runTrade(
      DEFAULT_EXECUTION_CONFIG,
      '08:00',
      (b, next) => {
        for (let i = 0; i < 20; i++) next(10, 10, 10, 10);
        expect(b.submit({ symbol: 'T', action: 'buy', type: 'limit', limitPrice: 10.05, extendedHours: true, quantity: 100, tif: 'gtc' }).ok).toBe(true);
        for (let i = 0; i < 3; i++) next(10, 10, 10, 10);
        expect(b.submit({ symbol: 'T', action: 'sell', type: 'limit', limitPrice: 9.95, extendedHours: true, quantity: 100, tif: 'gtc' }).ok).toBe(true);
        for (let i = 0; i < 3; i++) next(10, 10, 10, 10);
      },
      { ...DEFAULT_TRADING_RULES, noTradesFirstMinutes: 15 },
    );
    expect(review.rules.find((r) => r.rule === 'No entries in the first 15 min')).toMatchObject({ passed: true, detail: 'Entered in the pre-market, 70 min before the open' });
  });

  it('measures planned R:R from where a limit already through the market was expected to fill, and says so', () => {
    const { text } = runTrade(ZERO_COST_CONFIG, '09:00', (b, next) => {
      for (let i = 0; i < 30; i++) next(100, 100, 100, 100);
      // Placed in the pre-market for the open, above the last price: expected to fill near 100.
      expect(b.submit({ symbol: 'T', action: 'buy', type: 'limit', limitPrice: 101, quantity: 100, stopLoss: 99, takeProfit: 100.5, tif: 'day' }).ok).toBe(true);
      // The open gaps to 100.80, past the target.
      for (let i = 0; i < 3; i++) next(100.8, 100.8, 100.8, 100.8);
    });
    expect(text).toContain('Planned reward:risk is measured from 100.00, where the order was expected to fill.');
  });
});
