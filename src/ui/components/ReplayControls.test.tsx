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
});
