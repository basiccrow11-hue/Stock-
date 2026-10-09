import { describe, expect, it } from 'vitest';
import { ReplayEngine } from '../replay/ReplayEngine';
import { ReplaySession } from '../replay/ReplaySession';
import { DemoDataProvider } from '../data/demoProvider';
import { parseCsv } from '../data/csv';
import { DEFAULT_EXECUTION_CONFIG, ZERO_COST_CONFIG, type ExecutionConfig } from '../broker/config';
import type { BrokerCheckpoint } from '../broker/SimBroker';
import { ema, rsi, vwap } from '../indicators/indicators';
import type { Bar, UnixSeconds } from '../types';
import { bar, et, minuteBars, randomBars } from './helpers';

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

  it("steps one bar per candle at the data's own bar size, wherever the vendor put the bars", () => {
    const times = ['09:30', '10:00', '11:00', '12:00'];
    const hourly = times.map((t, i) => bar(et(D, t), 100 + i, 101 + i, 99 + i, 100 + i));
    const e = new ReplayEngine({ symbol: 'TEST', start: et(D, '09:30'), end: et(D, '16:00'), baseTimeframe: '1h' }, hourly);
    // The 09:30-10:00 bar and the 10:00 bar are two candles, not one 09:30-anchored hour.
    expect(e.stepCandle('1h').map((b) => b.time)).toEqual([et(D, '09:30')]);
    expect(e.stepCandle('1h').map((b) => b.time)).toEqual([et(D, '10:00')]);
  });
});

function setupFor() {
  return { symbol: 'TEST', date: D, startTime: '09:30', endTime: '16:00', startingBalance: 100_000, lookbackDays: 1 };
}

/** Everything about a session's account (the log without its rewind lines). */
function account(s: ReplaySession) {
  const { events, version, ...rest } = s.broker.state;
  void version;
  return { ...rest, events: events.filter((e) => !e.message.startsWith('Rewound')) };
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

  it('logs a rewind without the calendar date, which blind mode hides', () => {
    const s = new ReplaySession(engineWith(bars), setupFor(), ZERO_COST_CONFIG, 's', 'DEMO');
    for (let i = 0; i < 5; i++) s.step();
    const rewound = () => s.broker.state.events.filter((e) => e.message.startsWith('Rewound')).map((e) => e.message);
    s.stepBack();
    expect(rewound()).toEqual(['Rewound to 09:34 ET. Results after a rewind are not blind.']);
    s.restart();
    expect(rewound()).toEqual(['Rewound to 09:30 ET. Results after a rewind are not blind.']);
    expect(s.broker.state.events.some((e) => e.message.includes(D))).toBe(false);
  });

  it('says exactly which trades a rewind will undo, wherever Play left the clock', () => {
    /** A session played like the Play button (37 s steps), trading a bracket whenever flat. */
    const played = (steps: number) => {
      const s = new ReplaySession(engineWith(bars), setupFor(), ZERO_COST_CONFIG, 's', 'DEMO');
      for (let i = 0; i < steps; i++) {
        if (i % 3 === 0 && s.broker.position('TEST').quantity === 0) {
          const px = s.engine.lastPrice()!;
          s.submit({ symbol: 'TEST', action: 'buy', type: 'market', quantity: 10, stopLoss: px - 0.6, takeProfit: px + 0.6 });
        }
        s.advance(37);
      }
      return s;
    };
    const state = (s: ReplaySession) => new Map(s.broker.state.roundTrips.map((t) => [t.id, t.closed]));
    let checked = 0;
    for (let steps = 5; steps < 120; steps += 7) {
      for (const rewind of ['stepBack', 'jump'] as const) {
        const s = played(steps);
        const target = rewind === 'stepBack' ? s.stepBackTarget()! : s.now - 437;
        const predicted = s.undoneBy(target);
        const before = state(s);
        if (rewind === 'stepBack') s.stepBack();
        else s.jumpTo(target);
        const after = state(s);
        let closed = 0;
        let open = 0;
        for (const [id, wasClosed] of before) {
          if (wasClosed && after.get(id) !== true) closed++;
          else if (!wasClosed && !after.has(id)) open++;
        }
        expect(predicted).toEqual({ open, closed, hides: true });
        checked += closed;
      }
    }
    // The walk must actually undo closed trades, or it proves nothing.
    expect(checked).toBeGreaterThan(5);
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

describe('ReplaySession: undo is exact', () => {
  const bars = randomBars(600, 33, et(D, '06:00'));
  const T = (hhmm: string) => et(D, hhmm);
  const SLIPPY: ExecutionConfig = { ...ZERO_COST_CONFIG, slippage: { bps: 25, impactBpsPerPctOfVolume: 0 } };
  const bracketIfFlat = (s: ReplaySession) => {
    if (s.broker.position('TEST').quantity !== 0) return;
    const px = s.engine.lastPrice()!;
    s.submit({ symbol: 'TEST', action: 'buy', type: 'market', quantity: 10, stopLoss: px - 0.4, takeProfit: px + 0.4 });
  };
  type Action = [UnixSeconds, (s: ReplaySession) => void];
  /** Trading at fixed times, and a settings change that changes later fills. */
  const ACTIONS: Action[] = [
    ...['09:30', '09:41', '09:52', '10:03', '10:14', '10:25', '10:36', '10:47', '10:58'].map((t): Action => [T(t), bracketIfFlat]),
    [T('10:20'), (s: ReplaySession) => s.setConfig(SLIPPY)] as Action,
  ].sort((a, b) => a[0] - b[0]);

  /** A session that ran straight to `target`, trading as ACTIONS says until `actionsUntil`. */
  const play = (target: UnixSeconds, actionsUntil = target, move = (s: ReplaySession, t: UnixSeconds) => void s.jumpTo(t)) => {
    const s = new ReplaySession(engineWith(bars), setupFor(), ZERO_COST_CONFIG, 's', 'DEMO');
    for (const [t, act] of ACTIONS) {
      if (t > Math.min(target, actionsUntil)) break;
      if (t > s.now) move(s, t);
      act(s);
    }
    if (target > s.now) move(s, target);
    return s;
  };

  it('a rewind leaves the account exactly as if the replay had run straight to that moment', () => {
    for (const target of [T('09:45'), T('10:07') + 30, T('10:20'), T('10:20') + 30, T('10:33'), T('10:59') + 30]) {
      const s = play(T('11:30'));
      s.jumpTo(target);
      expect(account(s)).toEqual(account(play(target)));
      expect(s.broker.cfg).toBe(SLIPPY); // the current settings still apply from here on
    }
    // Rewind, go forward (no trading this time), rewind again.
    const s = play(T('11:30'));
    s.jumpTo(T('10:50'));
    expect(account(s)).toEqual(account(play(T('10:50'))));
    s.jumpTo(T('11:10'));
    expect(account(s)).toEqual(account(play(T('11:10'), T('10:50'))));
    s.jumpTo(T('10:05'));
    expect(account(s)).toEqual(account(play(T('10:05'))));
    expect(s.broker.state.roundTrips.length).toBeGreaterThan(1);
  });

  it('step back after a multi-bar step or fast Play undoes only the last bar', () => {
    const moves: Record<string, (s: ReplaySession) => void> = {
      '+1 15m': (s) => void s.stepCandle('15m'),
      'Play at 3600x': (s) => void s.advance(180),
    };
    for (const [name, move] of Object.entries(moves)) {
      const s = play(T('10:00'));
      for (let i = 0; i < 4; i++) move(s);
      const target = s.stepBackTarget()!;
      const predicted = s.undoneBy(target);
      const before = s.broker.state.roundTrips.length;
      s.stepBack();
      const ref = play(target, T('10:00'));
      expect(account(s), name).toEqual(account(ref));
      expect(predicted, name).toEqual({ open: 0, closed: before - ref.broker.state.roundTrips.length, hides: true });
      // The chart and the account agree: the mark is the last bar still on the chart.
      expect(s.broker.markPrice('TEST')).toBe(s.engine.lastPrice());
    }
  });

  it('Restart returns to the starting account, even after an order placed before the first bar', () => {
    const s = new ReplaySession(engineWith(bars), setupFor(), ZERO_COST_CONFIG, 's', 'DEMO');
    s.submit({ symbol: 'TEST', action: 'buy', type: 'market', quantity: 100, stopLoss: 90 });
    for (let i = 0; i < 5; i++) s.step();
    s.closePosition('TEST');
    s.step();
    expect(s.broker.state.roundTrips[0].closed).toBe(true);
    expect(s.undoneBy(s.start, true)).toEqual({ open: 0, closed: 1, hides: true });
    // Going back to the start time keeps what was done at that moment...
    s.jumpTo(s.start);
    expect(s.broker.workingOrders()).toHaveLength(1);
    // ...Restart does not.
    s.restart();
    expect(s.broker.state.orders).toEqual([]);
    expect(s.broker.state.fills).toEqual([]);
    expect(s.broker.state.roundTrips).toEqual([]);
    expect(s.broker.account().cash).toBe(100_000);
    s.step();
    expect(s.broker.state.fills).toEqual([]);
  });

  it('settings changed after a point stay in force there when a later rewind replays it', () => {
    const FEES: ExecutionConfig = { ...ZERO_COST_CONFIG, commission: { perShare: 0, perOrder: 5, minimumPerOrder: 0, maxPctOfValue: 0 } };
    const session = () => {
      const s = new ReplaySession(engineWith(bars), setupFor(), ZERO_COST_CONFIG, 's', 'DEMO');
      s.jumpTo(T('09:40'));
      const px = s.engine.lastPrice()!;
      s.submit({ symbol: 'TEST', action: 'buy', type: 'market', quantity: 10, stopLoss: px - 3, takeProfit: px + 3 });
      return s;
    };
    const s = session();
    s.jumpTo(T('09:45'));
    s.setConfig(FEES);
    s.jumpTo(T('09:50'));
    // Back before the change: the new settings apply from here on...
    s.jumpTo(T('09:44'));
    expect(s.broker.cfg).toBe(FEES);
    s.jumpTo(T('11:30'));
    expect(s.broker.state.roundTrips[0].closed).toBe(true);
    expect(s.broker.state.fills.at(-1)!.commission).toBe(5);
    // ...so stepping back replays those bars with them too, and undoes nothing but the last bar.
    const target = s.stepBackTarget()!;
    expect(s.undoneBy(target)).toEqual({ open: 0, closed: 0, hides: true });
    s.stepBack();
    const ref = session();
    ref.jumpTo(T('09:44'));
    ref.setConfig(FEES);
    ref.jumpTo(target);
    expect(account(s)).toEqual(account(ref));
  });

  it('Restart at the start time clears what was done there, and is not a rewind', () => {
    const s = new ReplaySession(engineWith(bars, T('10:00')), { ...setupFor(), startTime: '10:00' }, ZERO_COST_CONFIG, 's', 'DEMO');
    s.submit({ symbol: 'TEST', action: 'buy', type: 'market', quantity: 100 });
    expect(s.broker.position('TEST').quantity).toBe(100);
    expect(s.undoneBy(s.start, true)).toEqual({ open: 1, closed: 0, hides: false });
    s.restart();
    expect(s.broker.state.orders).toEqual([]);
    expect(s.broker.account().cash).toBe(100_000);
    expect(s.rewound).toBe(false);
    expect(s.broker.state.events.map((e) => e.message)).toEqual(['Back to the start: orders and trades cleared.']);
  });

  it('going back before any new bar has appeared is not a rewind', () => {
    const s = new ReplaySession(engineWith(bars), setupFor(), ZERO_COST_CONFIG, 's', 'DEMO');
    s.submit({ symbol: 'TEST', action: 'buy', type: 'limit', limitPrice: 1, quantity: 10 });
    // Play at 1x for 40 seconds: the clock moves, but the 09:30 bar is not complete yet.
    s.advance(40);
    expect(s.engine.started).toBe(false);
    s.jumpTo(T('09:30') + 10);
    expect(s.rewound).toBe(false);
    expect(s.broker.workingOrders()).toHaveLength(1);
    expect(s.undoneBy(s.start, true)).toEqual({ open: 0, closed: 0, hides: false });
    s.restart();
    expect(s.rewound).toBe(false);
    expect(s.broker.state.orders).toEqual([]);
    expect(s.broker.state.events.map((e) => e.message)).toEqual(['Back to the start: orders and trades cleared.']);
    // Once a bar has been seen, going back is a rewind.
    s.advance(60);
    expect(s.undoneBy(s.start, true).hides).toBe(true);
    s.restart();
    expect(s.rewound).toBe(true);
  });

  it('keeps few, small checkpoints however long the session and however many trades', () => {
    const s = new ReplaySession(engineWith(randomBars(3000, 7, et(D, '04:00')), et(D, '04:00'), et('2025-01-17', '20:00')), { ...setupFor(), startTime: '04:00' }, ZERO_COST_CONFIG, 's', 'DEMO');
    let actions = 0;
    for (let i = 0; i < 2900 && !s.finished; i++) {
      if (i % 20 === 0) {
        const px = s.engine.lastPrice()!;
        if (s.broker.position('TEST').quantity === 0) s.submit({ symbol: 'TEST', action: 'buy', type: 'limit', extendedHours: true, quantity: 10, limitPrice: px + 0.05 });
        else s.closePosition('TEST');
        actions++;
      }
      s.step();
    }
    const checkpoints = (s as unknown as { checkpoints: Array<{ broker: BrokerCheckpoint }> }).checkpoints;
    expect(s.broker.state.roundTrips.filter((t) => t.closed).length).toBeGreaterThan(20);
    expect(checkpoints.length).toBeLessThanOrEqual(actions + 2900 / 256 + 2);
    // Each holds only what can still change (the log lines it lists are shared, not copied).
    for (const { broker } of checkpoints) {
      const { events, ...own } = broker;
      void events;
      expect(JSON.stringify(own).length).toBeLessThan(3000);
    }
  });
});

describe('A new day before its first bar', () => {
  // Regular hours only: no pre-market bars. Jan 14 closes at 100, Jan 15 opens at 110.
  const rth = [...minuteBars('2025-01-14', '15:56', [[100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100]]), ...minuteBars('2025-01-15', '09:30', [[110, 111, 109, 110], [110, 111, 109, 110], [110, 111, 109, 110]])];
  const session = (start: number, config = ZERO_COST_CONFIG) => {
    const e = new ReplayEngine({ symbol: 'GAP', start, end: et('2025-01-15', '16:00'), baseTimeframe: '1m' }, rth);
    return new ReplaySession(e, { symbol: 'GAP', date: '2025-01-15', startTime: '09:30', endTime: '16:00', startingBalance: 100_000, lookbackDays: 1 }, config, 'g', 'HISTORICAL');
  };

  it('fills orders placed at the open at the first bar of the day, never at the last close', () => {
    const s = session(et('2025-01-15', '09:30'));
    expect(s.broker.state.clock).toBe(et('2025-01-14', '16:00'));
    const m = s.submit({ symbol: 'GAP', action: 'buy', type: 'market', quantity: 10 });
    expect(m.order!.status).toBe('pending');
    expect(m.warnings).toContain('GAP has not traded yet in this regular session: the order works from its first bar, on prices after this moment, never at an earlier close.');
    expect(m.notes).toBeUndefined();
    // A marketable limit waits too, and so does changing it.
    const l = s.submit({ symbol: 'GAP', action: 'buy', type: 'limit', limitPrice: 120, quantity: 10, tif: 'gtc' });
    expect(l.order!.status).toBe('pending');
    expect(s.modify(l.order!.id, { limitPrice: 125 }).ok).toBe(true);
    expect(s.broker.state.fills).toEqual([]);
    expect(s.broker.state.orders.map((o) => o.createdAt)).toEqual([et('2025-01-15', '09:30'), et('2025-01-15', '09:30')]);
    s.step();
    expect(s.broker.state.fills.map((f) => [f.price, f.time])).toEqual([
      [110, et('2025-01-15', '09:30')],
      [110, et('2025-01-15', '09:30')],
    ]);
  });

  it('expires yesterday’s DAY orders and holds Close position for the open when the clock passes the night', () => {
    const s = session(et('2025-01-14', '15:58'));
    s.step(); // 15:59 on Jan 14
    expect(s.submit({ symbol: 'GAP', action: 'buy', type: 'market', quantity: 10 }).order!.status).toBe('filled');
    const day = s.submit({ symbol: 'GAP', action: 'buy', type: 'limit', limitPrice: 90, quantity: 10 }).order!;
    s.step(); // 16:00: the last bar of Jan 14 is in
    expect(s.advance(60)).toEqual([]); // the night is skipped to the next open
    expect(s.now).toBe(et('2025-01-15', '09:30'));
    const close = s.closePosition('GAP');
    expect(close.order!.status).toBe('pending');
    expect(s.broker.state.orders.find((o) => o.id === day.id)!.status).toBe('expired');
    s.step();
    expect(s.broker.position('GAP').quantity).toBe(0);
    expect(s.broker.state.fills[1]).toMatchObject({ price: 110, time: et('2025-01-15', '09:30') });
  });
});

describe('Sessions are decided per symbol', () => {
  // ONE trades from 09:30; TWO, thinly traded, first trades at 09:35 (it closed at 100 the day before).
  const flat = (n: number, px: number) => Array.from({ length: n }, () => [px, px, px, px] as [number, number, number, number]);
  const one = [...minuteBars('2025-01-14', '15:58', flat(2, 50)), ...minuteBars('2025-01-15', '09:30', flat(10, 51))];
  const two = [...minuteBars('2025-01-14', '15:58', flat(2, 100)), ...minuteBars('2025-01-15', '09:35', [[110, 111, 109, 110], ...flat(4, 110)])];
  const setup = { symbol: 'ONE', date: '2025-01-15', startTime: '09:30', endTime: '16:00', startingBalance: 100_000, lookbackDays: 1 };
  const engine = (symbol: string, bars: Bar[], tf: '1m' | '1D' = '1m') => new ReplayEngine({ symbol, start: et('2025-01-15', '09:30'), end: et('2025-01-15', '16:00'), baseTimeframe: tf }, bars);

  it('holds an order on a symbol that has not traded yet today until its own first bar', () => {
    const s = new ReplaySession([engine('ONE', one), engine('TWO', two)], setup, ZERO_COST_CONFIG, 'p', 'HISTORICAL');
    s.step();
    s.step(); // 09:32: ONE has traded today, TWO has not
    const m = s.submit({ symbol: 'TWO', action: 'buy', type: 'market', quantity: 10 });
    expect(m.order!.status).toBe('pending');
    expect(m.warnings).toContain('TWO has not traded yet in this regular session: the order works from its first bar, on prices after this moment, never at an earlier close.');
    // A limit far above yesterday's close waits too, and is never filled at a price TWO did not trade at today.
    const l = s.submit({ symbol: 'TWO', action: 'buy', type: 'limit', limitPrice: 105, quantity: 10, tif: 'gtc' });
    expect(l.order!.status).toBe('pending');
    while (s.now < et('2025-01-15', '09:36')) s.step();
    expect(s.broker.state.fills.map((f) => [f.price, f.time])).toEqual([[110, et('2025-01-15', '09:35')]]);
    expect(s.broker.state.orders.find((o) => o.id === l.order!.id)!.status).toBe('working');
  });

  it('fills an order on a daily symbol beside a 1m one on that day’s bar, from the time it was placed', () => {
    // SPY daily: Jan 14 closes at 100; Jan 15 is an up day 110 → 108 → 114 → 112 (low first).
    const spy = [bar(et('2025-01-14', '09:30'), 99, 101, 98, 100), bar(et('2025-01-15', '09:30'), 110, 114, 108, 112)];
    const s = new ReplaySession([engine('ONE', one), engine('SPY', spy, '1D')], setup, ZERO_COST_CONFIG, 'm', 'HISTORICAL');
    expect(s.submit({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }).order!.status).toBe('pending');
    s.step();
    s.step(); // 09:32: Jan 15 for SPY is not shown until its close
    const later = s.submit({ symbol: 'SPY', action: 'buy', type: 'limit', limitPrice: 109, quantity: 10, tif: 'gtc' });
    expect(later.order!.status).toBe('pending');
    expect(s.broker.state.fills).toEqual([]);
    while (s.now < et('2025-01-15', '13:00')) s.advance(1800);
    // Placed at 13:00, after the path's low: the rest of the day never comes back down to 108.50.
    const afterLow = s.submit({ symbol: 'SPY', action: 'buy', type: 'limit', limitPrice: 108.5, quantity: 10, tif: 'gtc' });
    while (s.now < et('2025-01-15', '16:00')) s.advance(1800);
    expect(s.broker.state.orders.find((o) => o.id === afterLow.order!.id)!.status).toBe('working');
    // The market order placed at the open fills at the open; the limit placed at 09:32 only on the path
    // after 09:32 (the low of 108 came at about 11:40), so at 109, never at Jan 14's close of 100.
    const fills = s.broker.state.fills.map((f) => [f.price, f.time]);
    expect(fills[0]).toEqual([110, et('2025-01-15', '09:30')]);
    expect(fills[1][0]).toBe(109);
    expect(fills[1][1]).toBeGreaterThanOrEqual(et('2025-01-15', '09:32'));
  });

  it('says an extended-hours order works from the day’s first bar, pre-market included', () => {
    const pre = [...minuteBars('2025-01-14', '19:58', flat(2, 100)), ...minuteBars('2025-01-15', '04:00', flat(3, 101))];
    const e = new ReplayEngine({ symbol: 'EXT', start: et('2025-01-15', '04:00'), end: et('2025-01-15', '16:00'), baseTimeframe: '1m' }, pre);
    const s = new ReplaySession(e, { ...setup, symbol: 'EXT', startTime: '04:00' }, ZERO_COST_CONFIG, 'x', 'HISTORICAL');
    const ext = s.submit({ symbol: 'EXT', action: 'buy', type: 'limit', limitPrice: 102, extendedHours: true, quantity: 10 });
    expect(ext.order!.status).toBe('pending');
    expect(ext.warnings).toContain('EXT has not traded yet in this session: the order works from its first bar.');
    const reg = s.submit({ symbol: 'EXT', action: 'buy', type: 'limit', limitPrice: 102, quantity: 10 });
    expect(reg.warnings).toContain('Market is not in regular hours. The order will work from the next regular session.');
    s.step();
    expect(s.broker.state.fills.map((f) => [f.orderId, f.price, f.time])).toEqual([[ext.order!.id, 101, et('2025-01-15', '04:00')]]);
  });

  it('fills a next-bar-open market order at the open of the next bar that starts after it', () => {
    const bars = minuteBars('2025-01-15', '09:30', [[100, 100, 100, 100], [101, 101, 101, 101], [102, 102, 102, 102], [103, 103, 103, 103]]);
    const e = new ReplayEngine({ symbol: 'NB', start: et('2025-01-15', '09:31'), end: et('2025-01-15', '16:00'), baseTimeframe: '1m' }, bars);
    const s = new ReplaySession(e, { ...setup, symbol: 'NB', startTime: '09:31' }, { ...ZERO_COST_CONFIG, marketOrderFill: 'next_bar_open' }, 'n', 'HISTORICAL');
    s.advance(30); // 09:31:30, inside the 09:31 bar
    s.submit({ symbol: 'NB', action: 'buy', type: 'market', quantity: 10 });
    s.advance(30);
    expect(s.broker.state.fills).toEqual([]);
    s.advance(60);
    expect(s.broker.state.fills.map((f) => [f.price, f.time])).toEqual([[102, et('2025-01-15', '09:32')]]);
  });
});

describe('After the close', () => {
  // EXT has after-hours bars; RTH has regular hours only; DLY is daily (each day's bar is shown at its close).
  const flat = (n: number, px: number) => Array.from({ length: n }, () => [px, px, px, px] as [number, number, number, number]);
  const ext = [...minuteBars('2025-01-14', '15:58', flat(2, 50)), ...minuteBars('2025-01-15', '15:58', flat(64, 50))];
  const rth = [...minuteBars('2025-01-14', '15:58', flat(2, 100)), ...minuteBars('2025-01-15', '15:50', flat(10, 100))];
  const dly = [bar(et('2025-01-14', '09:30'), 199, 201, 198, 199), bar(et('2025-01-15', '09:30'), 199, 202, 198, 200)];
  const engine = (symbol: string, bars: Bar[], tf: '1m' | '1D' = '1m') => new ReplayEngine({ symbol, start: et('2025-01-15', '15:58'), end: et('2025-01-15', '20:00'), baseTimeframe: tf }, bars);
  const setup = { symbol: 'EXT', date: '2025-01-15', startTime: '15:58', endTime: '20:00', startingBalance: 100_000, lookbackDays: 1 };

  it('fills at the close at 16:00 but keeps orders on symbols without after-hours bars waiting after it', () => {
    const s = new ReplaySession([engine('EXT', ext), engine('RTH', rth), engine('DLY', dly, '1D')], setup, ZERO_COST_CONFIG, 'a', 'HISTORICAL');
    s.advance(120);
    expect(s.now).toBe(et('2025-01-15', '16:00'));
    expect(s.submit({ symbol: 'DLY', action: 'buy', type: 'market', quantity: 1 }).order!.status).toBe('filled');
    expect(s.submit({ symbol: 'RTH', action: 'buy', type: 'market', quantity: 1 }).order!.status).toBe('filled');
    expect(s.broker.state.fills.map((f) => f.price)).toEqual([200, 100]);
    while (s.now < et('2025-01-15', '17:00')) s.advance(600);
    for (const symbol of ['RTH', 'DLY']) {
      const r = s.submit({ symbol, action: 'buy', type: 'market', quantity: 1 });
      expect(r.order!.status).toBe('pending');
      expect(r.warnings).toContain('Market is not in regular hours. The order will work from the next regular session.');
      // An extended-hours limit waits for the symbol's next bar too, rather than taking its 4 pm close.
      const l = s.submit({ symbol, action: 'buy', type: 'limit', limitPrice: 300, extendedHours: true, quantity: 1 });
      expect(l.order!.status).toBe('pending');
      expect(l.warnings).toContain(`${symbol} has not traded yet in this session: the order works from its first bar.`);
    }
    s.advance(600);
    expect(s.broker.state.fills).toHaveLength(2);
  });
});

describe('Bars without volume', () => {
  it('fills whole orders under the default volume cap and says nothing about a cap', () => {
    const bars = minuteBars('2025-01-15', '09:30', Array.from({ length: 5 }, () => [100, 100.5, 99.5, 100] as [number, number, number, number]), 0);
    const e = new ReplayEngine({ symbol: 'NOV', start: et('2025-01-15', '09:32'), end: et('2025-01-15', '16:00'), baseTimeframe: '1m' }, bars);
    const s = new ReplaySession(e, { symbol: 'NOV', date: '2025-01-15', startTime: '09:32', endTime: '16:00', startingBalance: 1_000_000, lookbackDays: 0 }, DEFAULT_EXECUTION_CONFIG, 'n', 'HISTORICAL');
    expect(DEFAULT_EXECUTION_CONFIG.maxParticipation).toBe(0.25);
    const m = s.submit({ symbol: 'NOV', action: 'buy', type: 'market', quantity: 1000 });
    expect(m.order!.status).toBe('filled');
    expect(m.notes).toBeUndefined();
    s.submit({ symbol: 'NOV', action: 'buy', type: 'limit', limitPrice: 99.6, quantity: 2000 });
    s.step();
    expect(s.broker.position('NOV').quantity).toBe(3000);
  });
});

describe('Daily base bars', () => {
  // Daily bars are stamped at the 09:30 open, like a daily CSV.
  const days = ['2025-02-03', '2025-02-04', '2025-02-05', '2025-02-06', '2025-02-07'];
  const daily = days.map((d, i) => bar(et(d, '09:30'), 100 + i, 102 + i, 99 + i, 101 + i));

  it('fills and equity points fall inside the regular session of their day', () => {
    const e = new ReplayEngine({ symbol: 'XYZ', start: et('2025-02-05', '09:30'), end: et('2025-02-07', '16:00'), baseTimeframe: '1D' }, daily);
    const s = new ReplaySession(e, { symbol: 'XYZ', date: '2025-02-05', startTime: '09:30', endTime: '16:00', startingBalance: 100_000, lookbackDays: 2 }, ZERO_COST_CONFIG, 'd', 'DEMO');
    expect(s.broker.state.clock).toBe(et('2025-02-04', '16:00'));
    // At 09:30 on Feb 5 its session has no bar yet: the order waits for it rather than taking Feb 4's close.
    expect(s.submit({ symbol: 'XYZ', action: 'buy', type: 'market', quantity: 10, takeProfit: 103.5 }).order!.status).toBe('pending');
    expect(s.broker.state.fills).toEqual([]);
    s.step(); // Feb 5: up bar 102 → 101 → 104 → 103, the entry fills at its open and the target on the way up
    expect([s.broker.state.fills[0].price, s.broker.state.fills[0].time]).toEqual([102, et('2025-02-05', '09:30')]);
    const exit = s.broker.state.fills[1];
    expect(exit.price).toBe(103.5);
    expect(exit.time).toBeGreaterThan(et('2025-02-05', '09:30'));
    expect(exit.time).toBeLessThan(et('2025-02-05', '16:00'));
    expect(s.broker.state.clock).toBe(et('2025-02-05', '16:00'));
    expect(s.broker.state.equityCurve.map((p) => p.time)).toEqual([et('2025-02-04', '16:00'), et('2025-02-05', '16:00')]);
  });
});

describe('Next-bar-open fills on daily bars', () => {
  it('fills a DAY market order placed during a daily session at the next session’s open instead of expiring it', () => {
    const days = ['2025-02-03', '2025-02-04', '2025-02-05', '2025-02-06', '2025-02-07'];
    const daily = days.map((d, i) => bar(et(d, '09:30'), 100 + i, 102 + i, 99 + i, 101 + i));
    const e = new ReplayEngine({ symbol: 'XYZ', start: et('2025-02-05', '09:30'), end: et('2025-02-07', '16:00'), baseTimeframe: '1D' }, daily);
    const s = new ReplaySession(e, { symbol: 'XYZ', date: '2025-02-05', startTime: '09:30', endTime: '16:00', endDate: '2025-02-07', startingBalance: 100_000, lookbackDays: 2 }, { ...ZERO_COST_CONFIG, marketOrderFill: 'next_bar_open' }, 'd', 'DEMO');
    s.advance(3 * 3600); // 12:30 on Feb 5, inside its daily bar
    const r = s.submit({ symbol: 'XYZ', action: 'buy', type: 'market', quantity: 10, tif: 'day' });
    while (s.now < et('2025-02-06', '16:00')) s.advance(3600);
    expect(s.broker.state.orders.find((o) => o.id === r.order!.id)!.status).toBe('filled');
    expect(s.broker.state.fills.map((f) => [f.price, f.time])).toEqual([[103, et('2025-02-06', '09:30')]]);
  });
});

describe('Play on coarse base bars', () => {
  // A bar takes its whole duration at the chosen speed; only stretches with nothing trading are skipped.
  it('plays a daily bar over its session and skips only the night', () => {
    const days = ['2025-02-03', '2025-02-04', '2025-02-05', '2025-02-06', '2025-02-07'];
    const daily = days.map((d, i) => bar(et(d, '09:30'), 100 + i, 102 + i, 99 + i, 101 + i));
    const e = new ReplayEngine({ symbol: 'XYZ', start: et('2025-02-05', '09:30'), end: et('2025-02-07', '16:00'), baseTimeframe: '1D' }, daily);
    const s = new ReplaySession(e, { symbol: 'XYZ', date: '2025-02-05', startTime: '09:30', endTime: '16:00', startingBalance: 100_000, lookbackDays: 2 }, ZERO_COST_CONFIG, 'd', 'DEMO');
    expect(s.advance(3600)).toEqual([]);
    expect(s.now).toBe(et('2025-02-05', '10:30'));
    expect(s.advance(6 * 3600).map((r) => r.bar.time)).toEqual([et('2025-02-05', '09:30')]);
    // After the close the clock jumps to the next open, and that day's bar again takes its session.
    expect(s.advance(60)).toEqual([]);
    expect(s.now).toBe(et('2025-02-06', '09:30'));
  });

  it('never shows a daily bar stamped at UTC midnight before its session, and trades on it', () => {
    const days = ['2024-02-28', '2024-02-29', '2024-03-01', '2024-03-04', '2024-03-05', '2024-03-06'];
    // Close encodes the session: 301 for March 1.
    const rows = days.map((d) => {
      const c = Number(d.slice(5).replace('-', ''));
      return `${d}T00:00:00Z,${c},${c + 1},${c - 1},${c}`;
    });
    const parsed = parseCsv(`time,open,high,low,close\n${rows.join('\n')}\n`);
    const e = new ReplayEngine({ symbol: 'Z', start: et('2024-03-04', '09:30'), end: et('2024-03-06', '16:00'), baseTimeframe: parsed.baseTimeframe }, parsed.bars);
    const s = new ReplaySession(e, { symbol: 'Z', date: '2024-03-04', startTime: '09:30', endTime: '16:00', endDate: '2024-03-06', startingBalance: 100_000, lookbackDays: 5 }, ZERO_COST_CONFIG, 'z', 'HISTORICAL');
    expect(e.lastBar()!.close).toBe(301);
    // March 4 has not traded yet at its 09:30: both orders wait for its bar and fill at its open.
    expect(s.submit({ symbol: 'Z', action: 'buy', type: 'market', quantity: 10 }).order!.status).toBe('pending');
    expect(s.submit({ symbol: 'Z', action: 'buy', type: 'limit', limitPrice: 999, quantity: 10, tif: 'gtc' }).order!.status).toBe('pending');
    s.stepCandle('1D');
    expect(s.now).toBe(et('2024-03-04', '16:00'));
    expect(e.lastBar()!.close).toBe(304);
    expect(s.broker.state.fills.map((f) => [f.price, f.time])).toEqual([
      [304, et('2024-03-04', '09:30')],
      [304, et('2024-03-04', '09:30')],
    ]);
    // Paused at that close, the next market order fills at it, the last price shown.
    expect(s.submit({ symbol: 'Z', action: 'buy', type: 'market', quantity: 10 }).order!.status).toBe('filled');
    expect(s.broker.state.fills[2].price).toBe(304);
  });

  it('plays an hourly bar over its hour, and never reveals one that ends after the end time', () => {
    const hours = ['09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:30'];
    const hourly = ['2025-01-14', D].flatMap((d, k) => hours.map((h, i) => bar(et(d, h), 100 + i + k, 101 + i + k, 99 + i + k, 100.5 + i + k)));
    const session = () =>
      new ReplaySession(
        new ReplayEngine({ symbol: 'H', start: et(D, '09:30'), end: et(D, '16:00'), baseTimeframe: '1h' }, hourly),
        { symbol: 'H', date: D, startTime: '09:30', endTime: '16:00', startingBalance: 100_000, lookbackDays: 1 },
        ZERO_COST_CONFIG,
        'h',
        'DEMO',
      );
    const played = session();
    expect(played.advance(30 * 60)).toEqual([]);
    expect(played.advance(30 * 60).map((r) => r.bar.time)).toEqual([et(D, '09:30')]);
    while (!played.finished) played.advance(600);
    // The 15:30 bar ends at 16:30, after the 16:00 end: no way forward shows it.
    const stepped = session();
    while (!stepped.finished) stepped.stepCandle('1h');
    for (const s of [played, stepped]) {
      expect(s.engine.lastBar()!.time).toBe(et(D, '14:30'));
      expect(s.now).toBe(et(D, '16:00'));
    }
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

  it('rewinds several symbols exactly', async () => {
    const run = async (target: UnixSeconds) => {
      const { session: s } = await ReplaySession.load(p, { ...setupFor(), symbol: 'SPY', extraSymbols: ['AAPL'], lookbackDays: 1 }, ZERO_COST_CONFIG, 'm');
      s.jumpTo(et(D, '09:40'));
      for (const sym of ['SPY', 'AAPL']) {
        const px = s.broker.markPrice(sym)!;
        s.submit({ symbol: sym, action: 'buy', type: 'market', quantity: 10, stopLoss: px * 0.998, takeProfit: px * 1.002 });
      }
      s.jumpTo(target);
      return s;
    };
    const s = await run(et(D, '11:00'));
    s.stepCandle('15m', 'AAPL');
    s.jumpTo(et(D, '10:07') + 30);
    expect(account(s)).toEqual(account(await run(et(D, '10:07') + 30)));
    expect(s.broker.state.roundTrips.filter((t) => t.closed).length).toBeGreaterThan(0);
  });
});
