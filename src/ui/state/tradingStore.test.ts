// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Bar } from '../../core/types';
import { exchangeTimeToUnix } from '../../core/time';
import { mergeBars } from '../../core/data/aggregate';

vi.mock('../services/idb', () => ({
  idb: {
    all: async () => [],
    set: async () => undefined,
    delete: async () => undefined,
    get: async () => undefined,
    modify: async (_s: string, _k: string, fn: (v: unknown) => unknown) => fn(undefined),
  },
}));

describe('jumping forward in a replay', () => {
  it('redraws the chart once, moves the clock and journals a trade that closed inside the jump', async () => {
    const store = await import('./tradingStore');
    const { useJournal } = await import('./journalStore');
    const ok = await store.startReplay({
      providerId: 'demo',
      symbol: 'SPY',
      date: '2024-03-12',
      startTime: '10:00',
      endTime: '16:00',
      startingBalance: 25_000,
      lookbackDays: 1,
      timeframe: '1m',
      speed: 1,
      blind: false,
    });
    expect(ok).toBe(true);
    store.stepForward();
    store.stepForward();
    const price = store.lastPrice('SPY')!;
    expect(store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10, stopLoss: price - 0.2, takeProfit: price + 0.2 }).ok).toBe(true);
    store.stepForward();
    expect(store.useTrading.getState().positions).toHaveLength(1);

    // What the chart holds: a reset reloads the revealed bars; an append adds bars after them.
    let chart: Bar[] = store.getBaseBars('SPY');
    const events: string[] = [];
    const off = store.onChartEvent((e) => {
      events.push(e.type);
      if (e.type === 'reset') chart = store.getBaseBars('SPY');
      else if (e.type === 'append' && e.symbol === 'SPY') chart.push(...e.bars);
    });
    const target = exchangeTimeToUnix('2024-03-12', 12 * 60);
    store.jumpTo(target);
    off();
    await vi.waitFor(() => expect(useJournal.getState().entries).toHaveLength(1));

    expect(events).toEqual(['reset']);
    expect(chart.map((b) => b.time)).toEqual(store.getBaseBars('SPY').map((b) => b.time));
    expect(store.useTrading.getState().now).toBe(target);
    expect(store.useTrading.getState().positions).toHaveLength(0);
  });
});

describe('quotes', () => {
  it('measures the day change from the previous regular-session close, not its after-hours print', async () => {
    const store = await import('./tradingStore');
    const ok = await store.startReplay({ providerId: 'demo', symbol: 'TSLA', date: '2024-03-12', startTime: '09:30', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false });
    expect(ok).toBe(true);
    const bars = store.getBaseBars('TSLA');
    const close = bars.find((b) => b.time === exchangeTimeToUnix('2024-03-11', 15 * 60 + 59))!.close;
    const afterHours = bars.find((b) => b.time === exchangeTimeToUnix('2024-03-11', 19 * 60 + 59))!.close;
    expect(afterHours).not.toBe(close);
    expect(store.useTrading.getState().quotes.TSLA.prevClose).toBe(close);
    await store.endSession();
  });
});

describe('the simulated market on the chart', () => {
  it('sends every minute a step covers, so a stalled frame leaves no gap', async () => {
    const store = await import('./tradingStore');
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 300 });
      const symbol = store.useTrading.getState().activeSymbol;
      const chart = store.getBaseBars(symbol);
      const off = store.onChartEvent((e) => {
        if (e.type === 'reset') throw new Error('unexpected reset');
        if (e.symbol === symbol) mergeBars(chart, e.bars);
      });
      store.play();
      // A stalled frame: one loop covers a whole second of real time, five simulated minutes.
      for (let i = 0; i < 3; i++) {
        clock += 1000;
        vi.advanceTimersByTime(50);
      }
      off();
      store.pause();
      const truth = store.getBaseBars(symbol);
      expect(chart.length).toBe(truth.length);
      expect(chart).toEqual(truth);
    } finally {
      vi.useRealTimers();
      now.mockRestore();
      await store.endSession();
    }
  });
});

describe('blind replays', () => {
  it('hide the date in every open tab while running and give it back at the end', async () => {
    const store = await import('./tradingStore');
    const { useLiveBlind } = await import('./liveBlind');
    const ok = await store.startReplay({
      providerId: 'demo',
      symbol: 'SPY',
      date: '2024-03-12',
      startTime: '10:00',
      endTime: '10:30',
      startingBalance: 25_000,
      lookbackDays: 1,
      timeframe: '1m',
      speed: 1,
      blind: true,
    });
    expect(ok).toBe(true);
    const id = store.useTrading.getState().session!.id;
    expect(useLiveBlind.getState().sessions).toEqual({ [id]: '2024-03-12' });
    expect(JSON.parse(localStorage.getItem('stock-replay-live-blind')!)[id].start).toBe('2024-03-12');

    store.jumpTo(exchangeTimeToUnix('2024-03-12', 10 * 60 + 30));
    const s = store.useTrading.getState();
    expect(s.finished).toBe(true);
    expect(s.session).toMatchObject({ id, blind: false, label: 'SPY · 2024-03-12' });
    expect(useLiveBlind.getState().sessions).toEqual({});
    expect(localStorage.getItem('stock-replay-live-blind')).toBeNull();
  });
});

describe('what the store publishes', () => {
  it('a new equity curve whenever it changes, so charts of it keep up while the replay plays', async () => {
    const store = await import('./tradingStore');
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false })).toBe(true);
    store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 });
    const before = store.useTrading.getState().equityCurve;
    const last = before.at(-1)!;
    const lastEquity = last.equity;
    store.stepForward();
    store.jumpTo(store.useTrading.getState().now + 120);
    const after = store.useTrading.getState().equityCurve;
    expect(after).not.toBe(before);
    expect(after.length).toBeGreaterThan(before.length);
    // What was published before is left as it was.
    expect(last.equity).toBe(lastEquity);
    await store.endSession();
  });

  it('says once when a working order is cancelled because a position the other way opened first', async () => {
    const store = await import('./tradingStore');
    const { useToasts } = await import('./toasts');
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false })).toBe(true);
    const px = store.lastPrice('SPY')!;
    const at = (v: number) => Math.round(v * 100) / 100;
    // Two-sided entries around the price while flat: once one fills, the other meets a position the other way.
    expect(store.submitOrder({ symbol: 'SPY', action: 'short', type: 'limit', quantity: 10, limitPrice: at(px + 0.3), tif: 'gtc' }).ok).toBe(true);
    expect(store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'limit', quantity: 5, limitPrice: at(px - 0.3), tif: 'gtc' }).ok).toBe(true);
    const notices = () => useToasts.getState().toasts.filter((t) => t.text.includes('when it would have filled'));
    // Forward jumps publish at once (steps are throttled to the screen's pace).
    const minute = () => store.jumpTo(store.useTrading.getState().now + 60);
    for (let i = 0; i < 360 && !store.useTrading.getState().orders.some((o) => o.conflict); i++) minute();
    const cancelled = store.useTrading.getState().orders.find((o) => o.conflict)!;
    expect(cancelled.status).toBe('cancelled');
    const held = store.useTrading.getState().positions[0];
    expect(Math.sign(held.quantity)).toBe(cancelled.action === 'short' ? 1 : -1);
    expect(notices().map((t) => t.text)).toEqual([`${cancelled.action.toUpperCase()} ${cancelled.quantity} SPY LMT ${cancelled.limitPrice!.toFixed(2)} cancelled. ${cancelled.rejectReason}`]);
    // Stepping back over a later bar replays the cancellation, but it is not announced again.
    minute();
    store.stepBack();
    await vi.waitFor(() => expect(store.useTrading.getState().orders.find((o) => o.id === cancelled.id)!.status).toBe('cancelled'));
    expect(notices()).toHaveLength(1);
    expect(store.useTrading.getState().positions[0]).toMatchObject({ quantity: held.quantity, avgPrice: held.avgPrice });
    await store.endSession();
  });
});
