// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * jsdom has no layout, so the bar gets a simple one: 7px per character of the text it shows (parts
 * marked data-cut take no room), on one 40px row while that fits the window's width, else on two.
 */
let width = 0;
const shownWidth = (bar: Element) => {
  const copy = bar.cloneNode(true) as Element;
  copy.querySelectorAll('[data-cut]').forEach((e) => e.remove());
  return copy.textContent!.length * 7;
};
const stubbed = ['offsetHeight', 'clientWidth', 'scrollWidth'] as const;
const original = stubbed.map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const);

beforeEach(() => {
  const isBar = (el: HTMLElement) => el.classList.contains('topbar');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: function (this: HTMLElement) { return isBar(this) ? (shownWidth(this) > width ? 80 : 40) : 0; } });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: function (this: HTMLElement) { return isBar(this) ? width : 0; } });
  // The bar wraps rather than scrolls sideways.
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: function (this: HTMLElement) { return isBar(this) ? width : 0; } });
});

afterEach(() => {
  for (const [k, d] of original) {
    if (d) Object.defineProperty(HTMLElement.prototype, k, d);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
  document.body.innerHTML = '';
});

describe('the top bar', () => {
  it('shows buying power first, then the other figures in order, as far as they fit on one row', async () => {
    const store = await import('../state/tradingStore');
    const { TopBar } = await import('./TopBar');
    await store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 1 });
    width = 10_000;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(TopBar, { view: 'trade', onView: () => undefined })));
    const bar = host.querySelector<HTMLElement>('.topbar')!;
    const metric = (k: string) => [...bar.querySelectorAll('.metric')].find((m) => m.querySelector('.k')!.textContent === k)!;
    const shown = () => [...bar.querySelectorAll('.metric')].filter((m) => !m.hasAttribute('data-cut')).map((m) => m.querySelector('.k')!.textContent);
    const resize = (w: number) =>
      act(() => {
        width = w;
        window.dispatchEvent(new Event('resize'));
      });

    // A wide window has room for everything.
    expect(shown()).toEqual(['Account value', 'Cash', 'Buying power', 'Day P/L', 'Unrealized', 'Realized']);
    expect(bar.querySelector('.brand-name')!.hasAttribute('data-cut')).toBe(false);

    // With no room to spare, only account value and day P/L, which always show; the name is left to screen readers.
    const bare = (() => {
      bar.querySelectorAll('[data-fit]').forEach((e) => e.setAttribute('data-cut', ''));
      return shownWidth(bar);
    })();
    resize(bare);
    expect(shown()).toEqual(['Account value', 'Day P/L']);
    expect(bar.querySelector('.brand-name')!.hasAttribute('data-cut')).toBe(true);
    expect(bar.querySelector('.brand-name')!.textContent).toBe('Stock Replay');

    // Room for buying power, and for cash after it, but not for unrealized P/L: cash waits its turn,
    // so a wider window only ever adds figures, in the same order.
    const len = (k: string) => metric(k).textContent!.length * 7;
    expect(len('Cash')).toBeLessThan(len('Unrealized'));
    resize(bare + len('Buying power') + len('Cash'));
    expect(shown()).toEqual(['Account value', 'Buying power', 'Day P/L']);

    resize(bare + len('Buying power') + len('Unrealized'));
    expect(shown()).toEqual(['Account value', 'Buying power', 'Day P/L', 'Unrealized']);

    act(() => root.unmount());
    await store.endSession();
  });
});
