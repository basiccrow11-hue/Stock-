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
  localStorage.clear();
  document.body.innerHTML = '';
});

/** Types `value` into a field, or picks it in a select, as React sees it. */
function enter(field: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

async function mountTicket() {
  const { OrderTicket } = await import('./OrderTicket');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(OrderTicket)));
  const q = <T extends Element>(sel: string) => host.querySelector<T>(sel);
  const button = (text: string, within: ParentNode = host) => [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text);
  const more = q<HTMLDetailsElement>('details.ticket-more')!;
  /** The one-line estimate above the submit button, as "label value" pairs. */
  const estimate = () => Object.fromEntries([...host.querySelectorAll('.ticket-submit .ticket-est > div')].map((d) => [d.querySelector('dt')!.textContent, d.querySelector('dd')!]));
  return { host, q, button, more, estimate, unmount: () => act(() => root.unmount()) };
}

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

  it('keeps what most orders need in view, and the rest under More options, which names what is set in it while closed', async () => {
    const store = await import('../state/tradingStore');
    // A replay in regular hours, so a market order fills at once.
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false })).toBe(true);
    const t = await mountTicket();
    const symbol = store.useTrading.getState().activeSymbol;
    const summary = t.more.querySelector('summary')!;
    const outside = (el: Element | null | undefined) => !!el && !t.more.contains(el);
    const inside = (el: Element | null | undefined) => !!el && t.more.contains(el) && el !== summary;

    // In view: the four sides, the order type, quantity, the stop loss and target with their chart
    // pickers, the warning about the order and the button that places it.
    const sides = () => [...t.host.querySelectorAll('[aria-label="Order side"] button')].map((b) => b.textContent);
    expect(sides()).toEqual(['Buy', 'Sell', 'Short', 'Cover']);
    expect(outside(t.q('[aria-label="Order type"]'))).toBe(true);
    expect(outside(t.q('input[type="number"][min="1"]'))).toBe(true);
    for (const f of ['Stop loss', 'Take profit']) {
      expect(outside(t.q(`input[aria-label="${f}"]`))).toBe(true);
      expect(outside(t.q(`button[aria-label="Pick ${f.toLowerCase()} from chart"]`))).toBe(true);
    }
    expect(t.q('.ticket-submit')!.textContent).toContain('No stop loss: your risk on this trade is undefined.');
    expect(outside(t.button(`BUY 100 ${symbol} MKT`))).toBe(true);

    // Under More options, closed at first: time in force, extended hours, size for % risk, the 1R to 3R
    // targets, the strategy tag and the full estimate.
    expect(t.more.open).toBe(false);
    expect(summary.textContent).toBe('More options');
    const tif = t.q<HTMLSelectElement>('select')!;
    const ext = t.q<HTMLInputElement>('input[type="checkbox"]')!;
    const tag = t.q<HTMLInputElement>('input[aria-label="Strategy / setup tag"]')!;
    for (const el of [tif, ext, tag, t.q('input[aria-label="Risk per trade, percent of account"]'), t.button('Size'), t.button('1R'), t.button('2R'), t.button('3R'), t.q('.risk-box')]) expect(inside(el)).toBe(true);
    expect(tif.closest('label')!.textContent).toContain('Time in force');
    expect(ext.closest('label')!.textContent).toBe('Extended hours');

    // Set to something other than its default, an option shows on the closed summary and just above the
    // submit button, so nothing out of sight changes the order unnoticed. Extended hours counts only on a
    // limit order.
    const set = () => t.q('.ticket-submit .ticket-set')?.textContent ?? null;
    expect(set()).toBeNull();
    enter(tif, 'gtc');
    expect(summary.textContent).toBe('More options · GTC');
    expect(set()).toBe('GTC');
    act(() => t.button('Limit')!.click());
    act(() => ext.click());
    expect(summary.textContent).toBe('More options · GTC · Ext. hours');
    enter(tag, ' orb ');
    expect(summary.textContent).toBe('More options · GTC · Ext. hours · Tag: orb');
    expect(set()).toBe('GTC · Ext. hours · Tag: orb');
    act(() => t.button('Market')!.click());
    expect(summary.textContent).toBe('More options · GTC · Tag: orb');
    expect(set()).toBe('GTC · Tag: orb');
    // Open, the fields can still be scrolled under the submit area, which keeps naming them; the summary
    // names only itself. The button keeps its name, and screen readers hear the options with it.
    await act(async () => {
      summary.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(t.more.open).toBe(true);
    expect(summary.textContent).toBe('More options');
    expect(set()).toBe('GTC · Tag: orb');
    const submit = t.button(`BUY 100 ${symbol} MKT`)!;
    expect(submit.getAttribute('aria-describedby')).toBe(t.q('.ticket-set')!.id);

    // A fill never changes what a side means: Sell is still Sell, Cover still Cover, with a position open.
    act(() => void store.submitOrder({ symbol, action: 'buy', type: 'market', quantity: 10 }));
    expect(store.useTrading.getState().positions).toHaveLength(1);
    expect(sides()).toEqual(['Buy', 'Sell', 'Short', 'Cover']);
    t.unmount();
    await store.endSession();
  });

  it('starts each session with Day and regular hours, keeping the strategy tag, which stays named by the button', async () => {
    const store = await import('../state/tradingStore');
    const start = () => store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false });
    expect(await start()).toBe(true);
    const t = await mountTicket();
    const tif = () => t.q<HTMLSelectElement>('select')!;
    const ext = () => t.q<HTMLInputElement>('input[type="checkbox"]')!;
    const set = () => t.q('.ticket-submit .ticket-set')?.textContent ?? null;
    enter(tif(), 'gtc');
    act(() => t.button('Limit')!.click());
    act(() => ext().click());
    enter(t.q<HTMLInputElement>('input[aria-label="Strategy / setup tag"]')!, 'orb');
    expect(set()).toBe('GTC · Ext. hours · Tag: orb');

    // A new session (each cut of the chart starts one), with the ticket still on screen.
    await act(async () => void (await start()));
    expect([tif().value, ext().checked]).toEqual(['day', false]);
    expect(t.q<HTMLInputElement>('input[aria-label="Strategy / setup tag"]')!.value).toBe('orb');
    expect(set()).toBe('Tag: orb');
    t.unmount();
    await store.endSession();
  });

  it('sums up the estimate in one line above the submit button, with the risk in red over the limit', async () => {
    const store = await import('../state/tradingStore');
    const { useSettings } = await import('../state/settingsStore');
    await store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 1 });
    const t = await mountTicket();
    const symbol = store.useTrading.getState().activeSymbol;
    const last = store.useTrading.getState().quotes[symbol]!.last;
    /** The full table under More options, as "label value" pairs. */
    const table = () => {
      const cells = [...t.q('.risk-box')!.children].map((c) => c.textContent);
      return Object.fromEntries(cells.flatMap((c, i) => (i % 2 ? [] : [[c, cells[i + 1]]])));
    };
    const shown = () => Object.fromEntries(Object.entries(t.estimate()).map(([k, dd]) => [k, dd.textContent]));
    expect(Object.keys(shown())).toEqual(['Est. entry', 'Value', '$ risk', 'R:R']);
    expect(shown()['$ risk']).toBe('—');

    // With a stop and a target, the line agrees with the table: 10 shares, a stop $1 away, a target $2 away.
    enter(t.q<HTMLInputElement>('input[type="number"][min="1"]')!, '10');
    enter(t.q<HTMLInputElement>('input[aria-label="Stop loss"]')!, (last - 1).toFixed(2));
    enter(t.q<HTMLInputElement>('input[aria-label="Take profit"]')!, (last + 2).toFixed(2));
    const full = table();
    expect(shown()).toEqual({ 'Est. entry': full['Est. entry'], Value: full['Position value'], '$ risk': full['Dollar risk'], 'R:R': full['Reward : risk'] });
    expect(shown()['$ risk']).not.toBe('—');
    expect(t.estimate()['$ risk'].classList.contains('error')).toBe(false);

    // Over the risk limit (1% of $25,000 is $250), the risk is red, as the table's % of account is.
    expect(useSettings.getState().rules.maxRiskPctPerTrade).toBe(1);
    enter(t.q<HTMLInputElement>('input[type="number"][min="1"]')!, '400');
    expect(t.estimate()['$ risk'].classList.contains('error')).toBe(true);
    expect([...t.q('.risk-box')!.querySelectorAll('.error')].map((e) => e.previousElementSibling!.textContent)).toEqual(['% of account']);

    // An order that closes shares has no stop or target of its own: the line is its entry and value.
    act(() => t.button('Sell')!.click());
    expect(Object.keys(shown())).toEqual(['Est. entry', 'Value']);
    t.unmount();
    await store.endSession();
  });
});
