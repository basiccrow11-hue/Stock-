// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Bar } from '../../core/types';

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

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the replay controls', () => {
  it('jump to a date and time from a menu, so the controls fit on one row', async () => {
    const store = await import('../state/tradingStore');
    const { ReplayControls } = await import('./ReplayControls');
    const { exchangeTimeToUnix, formatExchangeTime } = await import('../../core/time');
    const ok = await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false });
    expect(ok).toBe(true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(ReplayControls)));
    const trigger = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Jump to…')!;
    const menu = () => host.querySelector<HTMLElement>('[role="dialog"][aria-label="Jump to a time"]');
    const field = (label: string) => [...menu()!.querySelectorAll('label')].find((l) => l.textContent!.startsWith(label))!.querySelector('input')!;

    // The fields are not in the bar until the menu is opened.
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('input')).toBeNull();
    act(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // They start at the replay clock.
    expect(field('Date').value).toBe('2024-03-12');
    expect(field('Time (ET)').value).toBe(formatExchangeTime(store.useTrading.getState().now));

    // Escape closes the menu and gives focus back to its button.
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    act(() => trigger.click());
    act(() => {
      const time = field('Time (ET)');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(time, '10:30');
      time.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => [...menu()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Jump')!.click());
    expect(store.useTrading.getState().now).toBe(exchangeTimeToUnix('2024-03-12', 10 * 60 + 30));
    expect(menu()).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);

    act(() => root.unmount());
    await store.endSession();
  });

  it('run to the end time when the data stops before it, by Play or by Step, and only then end a blind replay', async () => {
    const store = await import('../state/tradingStore');
    const { csvProvider } = await import('../state/dataRegistry');
    const { useToasts } = await import('../state/toasts');
    const { ReplayControls } = await import('./ReplayControls');
    const { exchangeTimeToUnix } = await import('../../core/time');
    // THIN trades all of March 11 and on the 12th until its 15:39 bar, then not again before the close.
    const bars: Bar[] = [];
    for (const [d, n] of [['2024-03-11', 390], ['2024-03-12', 370]] as const) {
      for (let i = 0; i < n; i++) bars.push({ time: exchangeTimeToUnix(d, 570 + i), open: 10, high: 10.01, low: 9.99, close: 10, volume: 1000 });
    }
    csvProvider.upsert({ symbol: 'THIN', name: 'THIN', baseTimeframe: '1m', bars, importedAt: 0, fileName: 'THIN.csv' });
    const at = (hhmm: string) => exchangeTimeToUnix('2024-03-12', Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.includes(label))!;
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    try {
      for (const how of ['step', 'play'] as const) {
        const blind = how === 'step';
        expect(await store.startReplay({ providerId: 'csv', symbol: 'THIN', date: '2024-03-12', startTime: '15:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 60, blind })).toBe(true);
        act(() => root.render(createElement(ReplayControls)));
        act(() => store.jumpTo(at('15:40')));
        // The last bar is in, but nothing says so before the clock gets to the end time.
        expect(store.getBaseBars('THIN').at(-1)!.time).toBe(at('15:39'));
        expect(store.useTrading.getState().finished).toBe(false);
        expect(host.textContent).not.toContain('END OF REPLAY');
        expect(button('Step forward one bar').disabled).toBe(false);
        expect(button('Play').disabled).toBe(false);
        expect(store.useTrading.getState().session!.blind).toBe(blind);
        useToasts.setState({ toasts: [] });
        if (how === 'step') {
          act(() => button('Step forward one bar').click());
          act(() => void vi.advanceTimersByTime(100));
        } else {
          act(() => button('Play').click());
          // A minute a second at 60x: 20 seconds to the end time, then Play stops there.
          for (let i = 0; i < 25; i++) {
            clock += 1000;
            act(() => void vi.advanceTimersByTime(50));
          }
          act(() => void vi.advanceTimersByTime(100));
          expect(store.useTrading.getState().playing).toBe(false);
          expect(useToasts.getState().toasts.map((t) => t.text)).toContain('Replay reached the end time.');
        }
        const s = store.useTrading.getState();
        expect(s.now, how).toBe(at('16:00'));
        expect(s.finished, how).toBe(true);
        expect(host.textContent, how).toContain('END OF REPLAY');
        expect(button('Step forward one bar').disabled, how).toBe(true);
        expect(s.session!.blind, how).toBe(false);
        await store.endSession();
      }
    } finally {
      act(() => root.unmount());
      vi.useRealTimers();
      now.mockRestore();
      csvProvider.remove('THIN');
      await store.endSession();
    }
  });
});
