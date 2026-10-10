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
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('the order ticket', () => {
  it('announces a bracket error only once typing has settled, however slowly a price is typed', async () => {
    const store = await import('../state/tradingStore');
    const { OrderTicket } = await import('./OrderTicket');
    await store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 1 });
    const last = store.useTrading.getState().quotes[store.useTrading.getState().activeSymbol]!.last;
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(OrderTicket)));
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Take profit"]')!;
    const said = () => document.querySelector('[role="status"]')!.textContent;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const type = (value: string) =>
      act(() => {
        set.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });

    // A target just above a long's entry, typed a key every 0.6 s: its first three prefixes are below
    // the entry (79.40 here: '7', '79', '79.' on the way to 79.99).
    expect(last - Math.floor(last)).toBeLessThan(0.9);
    const target = `${Math.floor(last)}.99`;
    const heard: string[] = [];
    for (let i = 1; i <= target.length; i++) {
      type(target.slice(0, i));
      act(() => vi.advanceTimersByTime(600));
      heard.push(said()!);
    }
    act(() => vi.advanceTimersByTime(1500));
    expect(heard.every((s) => s === '')).toBe(true);
    expect(said()).toBe('');

    // Left on the wrong side, it is heard a second after the last key.
    type('1');
    act(() => vi.advanceTimersByTime(1100));
    expect(said()).toBe('Take profit must be above the entry price for a long.');
    act(() => root.unmount());
    vi.useRealTimers();
    await store.endSession();
  });

  it('heads the ticket with its symbol and the modelled bid and ask beside the last price', async () => {
    const store = await import('../state/tradingStore');
    const { OrderTicket } = await import('./OrderTicket');
    const { modelledQuote } = await import('../services/modelledQuote');
    const { useSettings } = await import('../state/settingsStore');
    const { marketSession } = await import('../../core/time');
    const { price } = await import('../services/format');
    await store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 1 });
    const { activeSymbol, quotes, now } = store.useTrading.getState();
    const last = quotes[activeSymbol]!.last;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(OrderTicket)));
    const { bid, ask } = modelledQuote(useSettings.getState().execution, last, marketSession(now) !== 'regular');
    expect(bid).toBeLessThan(ask);
    expect(host.querySelector('.ticket-head h3')!.textContent).toBe(activeSymbol);
    expect(host.querySelector('.ticket-head')!.textContent).toContain(`Bid ${price(bid)} Ask ${price(ask)}Last ${price(last)}`);
    act(() => root.unmount());
    await store.endSession();
  });
});
