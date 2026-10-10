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

async function mount() {
  const { RightPanel } = await import('./RightPanel');
  const asked: string[] = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(RightPanel, { onNewSession: (mode: string) => void asked.push(mode) })));
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text);
  /** The account box as "label value" pairs. */
  const account = () => Object.fromEntries([...host.querySelectorAll('.acct > div')].map((d) => [d.querySelector('dt')!.textContent, d.querySelector('dd')!.textContent]));
  return { host, asked, button, account, unmount: () => act(() => root.unmount()) };
}

describe('the right column', () => {
  it('says how to start before there is a session', async () => {
    const p = await mount();
    expect(p.host.textContent).toContain('No session running');
    act(() => p.button('Start a historical replay')!.click());
    act(() => p.button('Start the simulated market')!.click());
    expect(p.asked).toEqual(['replay', 'sim']);
    p.unmount();
  });

  it('shows the starting balance and the open positions, each of which can be closed from there', async () => {
    const store = await import('../state/tradingStore');
    const { money } = await import('../services/format');
    const ok = await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false });
    expect(ok).toBe(true);
    const p = await mount();
    expect(p.host.textContent).not.toContain('No session running');
    expect(p.button('Start a historical replay')).toBeUndefined();
    const before = p.account();
    expect(before['Starting balance']).toBe('$25,000.00');
    expect(Object.keys(before)).toEqual(['Starting balance', 'Cash', 'Buying power', 'Session P/L', 'Unrealized P/L', 'Realized P/L', 'Closed trades', 'Win rate']);
    expect(p.host.querySelector('.pos-mini')).toBeNull();

    act(() => void store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }));
    const { positions, account } = store.useTrading.getState();
    expect(positions).toHaveLength(1);
    expect(p.account()['Buying power']).toBe(money(account!.buyingPower));
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
    expect(p.account()['Closed trades']).toBe('1');
    p.unmount();
    await store.endSession();
  });
});
