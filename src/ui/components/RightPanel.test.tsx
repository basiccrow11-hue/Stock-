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
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
});

/** A click on a disclosure's summary, and the toggle event the browser sends after it. */
async function toggle(summary: Element) {
  await act(async () => {
    (summary as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount() {
  const { RightPanel } = await import('./RightPanel');
  const asked: string[] = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(RightPanel, { onNewSession: (mode: string) => void asked.push(mode) })));
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text);
  const pairs = (sel: string) => Object.fromEntries([...host.querySelectorAll(sel)].map((d) => [d.querySelector('.k')!.textContent, d.querySelector('.v')!.textContent]));
  /** The account's line (its summary), and its details, as "label value" pairs. */
  const account = () => pairs('.acct > summary .acct-item');
  const details = () => pairs('.acct-more .acct-item');
  const box = () => host.querySelector<HTMLDetailsElement>('details.acct')!;
  return { host, asked, button, account, details, box, unmount: () => act(() => root.unmount()) };
}

describe('the right column', () => {
  it('says in one line how to start before there is a session, with the other ways in as small links', async () => {
    const p = await mount();
    const idle = p.host.querySelector('.right-idle')!;
    expect(idle.querySelector('p')!.textContent).toBe('Press Replay above the chart, then click the bar to start from. Your paper account and order ticket appear here.');
    // No big buttons repeating the chart's: two links, to the replay form and to the simulated market.
    expect([...p.host.querySelectorAll('button')].map((b) => [b.textContent, b.className])).toEqual([
      ['Advanced replay setup', 'link-btn'],
      ['Simulated market', 'link-btn'],
    ]);
    act(() => p.button('Advanced replay setup')!.click());
    act(() => p.button('Simulated market')!.click());
    expect(p.asked).toEqual(['replay', 'sim']);
    p.unmount();
  });

  it('shows the starting balance and the open positions, each of which can be closed from there', async () => {
    const store = await import('../state/tradingStore');
    const { money, signedMoney } = await import('../services/format');
    const ok = await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false });
    expect(ok).toBe(true);
    const p = await mount();
    expect(p.host.querySelector('.right-idle')).toBeNull();
    expect(p.button('Advanced replay setup')).toBeUndefined();
    // One line of what the top bar does not show; the rest one click away, closed at first.
    expect(p.account()).toEqual({ 'Session P/L': '$0.00', Realized: '$0.00', Trades: '0', 'Win rate': '—' });
    expect(p.box().open).toBe(false);
    expect(p.details()).toEqual({ 'Starting balance': '$25,000.00', Cash: '$25,000.00', 'Buying power': money(store.useTrading.getState().account!.buyingPower), 'Unrealized P/L': '$0.00' });
    expect(p.host.querySelector('.pos-mini')).toBeNull();

    act(() => void store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }));
    const { positions, account } = store.useTrading.getState();
    expect(positions).toHaveLength(1);
    expect(p.details()['Buying power']).toBe(money(account!.buyingPower));
    expect(p.details()['Cash']).toBe(money(account!.cash));
    const list = p.host.querySelector('.pos-mini')!;
    expect(list.querySelector('h3')!.textContent).toBe('Open positions (1)');
    const pick = list.querySelector<HTMLButtonElement>('.pos-mini-pick')!;
    expect(pick.textContent).toMatch(/^SPYLlong 10@ \d+\.\d\d[+−]?\$\d+\.\d\d$/);
    expect(pick.getAttribute('aria-pressed')).toBe('true');
    // The list comes before the order ticket, which follows the position's symbol.
    expect(list.compareDocumentPosition(p.host.querySelector('.ticket')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    act(() => p.host.querySelector<HTMLButtonElement>('button[aria-label="Close SPY position at market"]')!.click());
    expect(store.useTrading.getState().positions).toHaveLength(0);
    expect(p.host.querySelector('.pos-mini')).toBeNull();
    expect(p.account()['Trades']).toBe('1');
    expect(p.account()['Realized']).toBe(signedMoney(store.useTrading.getState().account!.realizedPnl));
    p.unmount();
    await store.endSession();
  });

  it('keeps the account details and the ticket’s More options open once opened, after a reload too', async () => {
    const store = await import('../state/tradingStore');
    const { OPEN_KEY } = await import('./useRememberedOpen');
    await store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 1 });
    const more = (host: Element) => host.querySelector<HTMLDetailsElement>('details.ticket-more')!;
    const p = await mount();
    expect(more(p.host).open).toBe(false);
    await toggle(p.box().querySelector('summary')!);
    expect(p.box().open).toBe(true);
    expect(JSON.parse(localStorage.getItem(OPEN_KEY)!)).toEqual({ 'account-details': true });
    p.unmount();

    // After a reload the account details are still open; More options was never opened.
    const again = await mount();
    expect(again.box().open).toBe(true);
    expect(more(again.host).open).toBe(false);
    await toggle(more(again.host).querySelector('summary')!);
    await toggle(again.box().querySelector('summary')!);
    expect(JSON.parse(localStorage.getItem(OPEN_KEY)!)).toEqual({ 'account-details': false, 'ticket-more': true });
    again.unmount();
    const third = await mount();
    expect(third.box().open).toBe(false);
    expect(more(third.host).open).toBe(true);
    third.unmount();

    // A malformed stored value is ignored, and blocked storage only means the choice is not kept.
    localStorage.setItem(OPEN_KEY, '{"account-details":"yes","ticket-more":1}');
    const junk = await mount();
    expect(junk.box().open).toBe(false);
    expect(more(junk.host).open).toBe(false);
    junk.unmount();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    const blocked = await mount();
    await toggle(more(blocked.host).querySelector('summary')!);
    expect(more(blocked.host).open).toBe(true);
    blocked.unmount();
    await store.endSession();
  });
});
