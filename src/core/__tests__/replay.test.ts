import { describe, expect, it } from 'vitest';
import { ReplayEngine } from '../replay/ReplayEngine';
import { ReplaySession } from '../replay/ReplaySession';
import { DemoDataProvider } from '../data/demoProvider';
import { ZERO_COST_CONFIG } from '../broker/config';
import { ema, rsi, vwap } from '../indicators/indicators';
import type { Bar } from '../types';
import { et, randomBars } from './helpers';

const D = '2025-01-15';

function engineWith(bars: Bar[], start = et(D, '09:30'), end = et(D, '16:00')) {
  return new ReplayEngine({ symbol: 'TEST', start, end, baseTimeframe: '1m' }, bars);
}

describe('ReplayEngine: no look-ahead', () => {
  const bars = randomBars(600, 11, et(D, '06:00'));

  it('at the start only bars that completed before the start time are visible', () => {
    const e = engineWith(bars);
    const visible = e.visibleBaseBars();
    expect(visible.length).toBeGreaterThan(0);
    for (const b of visible) expect(b.time + 60).toBeLessThanOrEqual(et(D, '09:30'));
    expect(visible[visible.length - 1].time).toBe(et(D, '09:29'));
    expect(e.now).toBe(et(D, '09:30'));
    expect(e.lastPrice()).toBe(visible[visible.length - 1].close);
  });

  it('each step reveals exactly one completed bar and nothing beyond now', () => {
    const e = engineWith(bars);
    for (let i = 0; i < 50; i++) {
      const before = e.revealedCount;
      e.step();
      expect(e.revealedCount).toBe(before + 1);
      for (const b of e.visibleBaseBars()) expect(b.time + 60).toBeLessThanOrEqual(e.now);
      for (const c of e.visibleBars('5m')) expect(c.time).toBeLessThan(e.now);
    }
  });

  it('advanceTo reveals only bars that have completed by the target time', () => {
    const e = engineWith(bars);
    const revealed = e.advanceTo(et(D, '09:35') + 30);
    expect(revealed.map((b) => b.time)).toEqual([0, 1, 2, 3, 4].map((i) => et(D, '09:30') + i * 60));
  });

  it('does not expose the future tape through any property or serialization', () => {
    const e = engineWith(bars);
    const futureClose = bars[bars.length - 1].close;
    expect(Object.keys(e)).not.toContain('bars');
    const serialized = JSON.stringify(e);
    expect(serialized).not.toContain(String(futureClose));
    expect(JSON.stringify(e.visibleBaseBars())).not.toContain(String(futureClose));
  });

  it('identical pasts with different futures produce identical charts, indicators, and fills', () => {
    // Same history up to 10:30, then the future diverges wildly.
    const past = randomBars(270, 5, et(D, '06:00')); // 06:00 .. 10:29
    const futureA = randomBars(200, 99, et(D, '10:30'), past[past.length - 1].close);
    const futureB = futureA.map((b) => ({ ...b, open: b.open * 3, high: b.high * 3, low: b.low * 0.2, close: b.close * 0.5 }));
    const runA = new ReplaySession(engineWith([...past, ...futureA]), setupFor(), ZERO_COST_CONFIG, 'same', 'DEMO');
    const runB = new ReplaySession(engineWith([...past, ...futureB]), setupFor(), ZERO_COST_CONFIG, 'same', 'DEMO');

    for (const run of [runA, runB]) {
      run.submit({ symbol: 'TEST', action: 'buy', type: 'limit', quantity: 10, limitPrice: past[209].close - 0.5, tif: 'day' });
    }
    // Step both up to 10:30 (just before the futures diverge).
    while (runA.now < et(D, '10:30')) {
      runA.step();
      runB.step();
      const va = runA.engine.visibleBars('5m');
      const vb = runB.engine.visibleBars('5m');
      expect(va).toEqual(vb);
      const ca = va.map((b) => b.close);
      const cb = vb.map((b) => b.close);
      expect(ema(ca, 9)).toEqual(ema(cb, 9));
      expect(rsi(ca, 14)).toEqual(rsi(cb, 14));
      expect(vwap(runA.engine.visibleBaseBars())).toEqual(vwap(runB.engine.visibleBaseBars()));
      expect(runA.broker.account()).toEqual(runB.broker.account());
      expect(runA.broker.state.fills).toEqual(runB.broker.state.fills);
      expect(runA.broker.state.orders).toEqual(runB.broker.state.orders);
    }
    // One more step and they diverge, proving the test data really differs.
    runA.step();
    runB.step();
    expect(runA.engine.lastPrice()).not.toEqual(runB.engine.lastPrice());
  });

  it('stepCandle completes the forming candle', () => {
    const e = engineWith(bars);
    e.step(); // 09:30 revealed, 5m candle 09:30-09:35 forming
    const r = e.stepCandle('5m');
    expect(r).toHaveLength(4);
    expect(e.now).toBe(et(D, '09:35'));
    expect(e.stepCandle('5m')).toHaveLength(5);
  });
});

function setupFor() {
  return { symbol: 'TEST', date: D, startTime: '09:30', endTime: '16:00', startingBalance: 100_000, lookbackDays: 1 };
}

describe('ReplaySession: rewind, jump, and fills', () => {
  const bars = randomBars(600, 21, et(D, '06:00'));

  it('step back restores the account exactly and records the rewind', () => {
    const s = new ReplaySession(engineWith(bars), setupFor(), ZERO_COST_CONFIG, 's', 'DEMO');
    for (let i = 0; i < 5; i++) s.step();
    const acctBefore = s.broker.account();
    const tBefore = s.now;
    s.submit({ symbol: 'TEST', action: 'buy', type: 'market', quantity: 100 });
    for (let i = 0; i < 5; i++) s.step();
    expect(s.broker.position('TEST').quantity).toBe(100);
    s.jumpTo(tBefore);
    expect(s.rewound).toBe(true);
    // The buy happened at tBefore, after the snapshot of that reveal point, so it is kept...
    expect(s.broker.position('TEST').quantity).toBe(100);
    // ...but rewinding one more bar undoes it.
    s.stepBack();
    expect(s.broker.position('TEST').quantity).toBe(0);
    expect(s.broker.account().equity).toBe(acctBefore.equity);
  });

  it('restart returns to the initial state', () => {
    const s = new ReplaySession(engineWith(bars), setupFor(), ZERO_COST_CONFIG, 's', 'DEMO');
    s.submit({ symbol: 'TEST', action: 'buy', type: 'market', quantity: 100 });
    for (let i = 0; i < 30; i++) s.step();
    s.restart();
    expect(s.now).toBe(et(D, '09:30'));
    expect(s.broker.state.fills).toHaveLength(0);
    expect(s.broker.position('TEST').quantity).toBe(0);
  });

  it('jumping forward processes every skipped bar, so stops trigger along the way', () => {
    const s = new ReplaySession(engineWith(bars), setupFor(), ZERO_COST_CONFIG, 's', 'DEMO');
    const px = s.engine.lastPrice()!;
    s.submit({ symbol: 'TEST', action: 'buy', type: 'market', quantity: 10, stopLoss: px - 1.5, takeProfit: px + 1.5 });
    s.jumpTo(et(D, '15:00'));
    const trip = s.broker.state.roundTrips[0];
    expect(trip.closed).toBe(true);
    const stop = Math.round((px - 1.5) * 100) / 100;
    const target = Math.round((px + 1.5) * 100) / 100;
    // Exit is at the stop (or worse on a gap) or at the target (or better on a gap).
    expect(trip.avgExit! <= stop + 1e-9 || trip.avgExit! >= target - 1e-9).toBe(true);
    expect(trip.exitTime!).toBeLessThan(et(D, '15:00'));
    expect(s.rewound).toBe(false);
  });
});

describe('Demo data provider', () => {
  const p = new DemoDataProvider(new Date('2026-10-08T12:00:00Z'));

  it('is deterministic for a given symbol and date', () => {
    const a = p.getBarsSync({ symbol: 'AAPL', from: et(D, '04:00'), to: et(D, '20:00') });
    const b = new DemoDataProvider(new Date('2026-10-08T12:00:00Z')).getBarsSync({ symbol: 'AAPL', from: et(D, '04:00'), to: et(D, '20:00') });
    expect(a).toEqual(b);
    expect(a).toHaveLength(960);
  });

  it('produces valid OHLC bars with session-shaped volume', () => {
    const bars = p.getBarsSync({ symbol: 'TSLA', from: et(D, '04:00'), to: et(D, '20:00') });
    for (const b of bars) {
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
      expect(b.volume).toBeGreaterThan(0);
    }
    const vol = (from: string, to: string) => bars.filter((b) => b.time >= et(D, from) && b.time < et(D, to)).reduce((a, b) => a + b.volume, 0);
    expect(vol('09:30', '10:00')).toBeGreaterThan(vol('12:00', '12:30'));
    expect(vol('09:30', '16:00')).toBeGreaterThan(vol('04:00', '09:30') * 5);
  });

  it('has no data on holidays or after the last completed day', async () => {
    expect(p.getBarsSync({ symbol: 'SPY', from: et('2025-07-04', '04:00'), to: et('2025-07-04', '20:00') })).toHaveLength(0);
    expect(p.lastDate).toBe('2026-10-07');
    expect(p.getBarsSync({ symbol: 'SPY', from: et('2026-10-08', '04:00'), to: et('2026-10-09', '20:00') })).toHaveLength(0);
  });

  it('days connect: the premarket starts where the prior after-hours ended', () => {
    const bars = p.getBarsSync({ symbol: 'NVDA', from: et('2025-01-14', '04:00'), to: et('2025-01-15', '20:00') });
    const lastPrev = bars.filter((b) => b.time < et(D, '04:00')).pop()!;
    const firstToday = bars.find((b) => b.time >= et(D, '04:00'))!;
    expect(Math.abs(firstToday.open - lastPrev.close) / lastPrev.close).toBeLessThan(0.002);
  });

  it('loads a full replay session through the provider interface', async () => {
    const { session: s } = await ReplaySession.load(p, { ...setupFor(), symbol: 'SPY', lookbackDays: 2 }, ZERO_COST_CONFIG, 'x');
    expect(s.broker.state.source).toBe('DEMO');
    expect(s.engine.visibleBaseBars().every((b) => b.time < et(D, '09:30'))).toBe(true);
    s.jumpTo(et(D, '16:00'));
    expect(s.engine.finished).toBe(true);
  });

  it('replays several symbols on one clock and trades any of them', async () => {
    const { session: s, warnings } = await ReplaySession.load(p, { ...setupFor(), symbol: 'SPY', extraSymbols: ['AAPL', 'NOPE'], lookbackDays: 1 }, ZERO_COST_CONFIG, 'm');
    expect(s.symbols).toEqual(['SPY', 'AAPL']);
    expect(warnings[0]).toMatch(/NOPE skipped/);
    for (let i = 0; i < 10; i++) s.step();
    expect(s.engineFor('AAPL')!.now).toBe(s.engine.now);
    expect(s.engineFor('AAPL')!.lastBar()!.time).toBe(s.engine.lastBar()!.time);
    expect(s.submit({ symbol: 'AAPL', action: 'buy', type: 'market', quantity: 5 }).ok).toBe(true);
    s.stepCandle('5m');
    expect(s.broker.markPrice('AAPL')).toBe(s.engineFor('AAPL')!.lastPrice());
    s.stepBack();
    s.stepBack();
    expect(s.engineFor('AAPL')!.now).toBe(s.engine.now);
  });
});
