// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Bar } from '../../core/types';
import { exchangeTimeToUnix } from '../../core/time';

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
