// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../services/idb', () => ({
  idb: {
    all: async () => [],
    set: async () => undefined,
    delete: async () => undefined,
    get: async () => undefined,
    modify: async (_s: string, _k: string, fn: (v: unknown) => unknown) => fn(undefined),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  document.body.innerHTML = '';
  await (await import('../state/tradingStore')).endSession();
});

async function mount() {
  const { Watchlist } = await import('./Watchlist');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(Watchlist)));
  /** Each row's symbol line, as shown. */
  const rows = () => [...host.querySelectorAll('.watch-row .sym')].map((s) => s.textContent);
  return { rows, unmount: () => act(() => root.unmount()) };
}

describe('the watchlist', () => {
  it('names each simulated stock’s kind, which sets how it moves', async () => {
    const store = await import('../state/tradingStore');
    expect(await store.startSim({ config: { seed: 1 }, startingBalance: 25_000, speed: 1 })).toBe(true);
    const w = await mount();
    expect(w.rows()).toEqual(['NOVA Growth stock', 'QBIT Large-cap tech', 'MINR Small cap', 'STLW Blue chip', 'VLTX Volatile momentum name', 'SIMX Index ETF']);
    w.unmount();
  });

  it('shows only tickers in a replay', async () => {
    const store = await import('../state/tradingStore');
    expect(await store.startReplay({ providerId: 'demo', symbol: 'AAPL', extraSymbols: ['SPY'], date: '2025-03-10', startTime: '09:30', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 60, blind: false })).toBe(true);
    const w = await mount();
    expect(w.rows().map((r) => r?.trim())).toEqual(['AAPL', 'SPY']);
    w.unmount();
  });
});
