// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Fragment, act, createElement } from 'react';
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
  vi.restoreAllMocks();
  const store = await import('../state/tradingStore');
  await store.endSession();
  store.setBrowseSource('demo');
  store.setActiveSymbol('SPY');
  (await import('../state/credentials')).useCredentials.setState({ creds: {} });
  (await import('../state/settingsStore')).useSettings.getState().update({ watchlist: ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META'] });
  (await import('./SymbolSearch')).closeSymbolSearch();
});

async function mount() {
  const { Watchlist } = await import('./Watchlist');
  const { SymbolSearchHost } = await import('./SymbolSearch');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(Fragment, null, createElement(Watchlist), createElement(SymbolSearchHost))));
  /** Each row's symbol line, as shown. */
  const rows = () => [...host.querySelectorAll('.watch-row .sym')].map((s) => s.textContent);
  /** With no session: each row's ticker, the data source it charts from, and the last close and change shown. */
  const items = () =>
    [...host.querySelectorAll('.watch-item')].map((item) => [item.querySelector('.sym')!.firstChild!.textContent, item.querySelector('.nm')!.textContent, item.querySelector('.px')!.textContent]);
  const item = (sym: string) => [...host.querySelectorAll<HTMLElement>('.watch-item')].find((i) => i.querySelector('.sym')!.firstChild!.textContent === sym)!;
  const add = () => host.querySelector<HTMLButtonElement>('button[aria-label="Add a symbol to the watchlist"]');
  return { host, rows, items, item, add, unmount: () => act(() => root.unmount()) };
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

  it('keeps the session’s rows as they are, with no + and no ×: a session’s symbols are fixed when it starts', async () => {
    const store = await import('../state/tradingStore');
    expect(await store.startReplay({ providerId: 'demo', symbol: 'AAPL', extraSymbols: ['SPY'], date: '2025-03-10', startTime: '09:30', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 60, blind: false })).toBe(true);
    const w = await mount();
    expect(w.host.querySelector('.panel-head')!.textContent).toBe('Watchlist2 symbols');
    expect(w.add()).toBeNull();
    expect(w.host.querySelector('.watch-x')).toBeNull();
    expect(w.host.textContent).not.toContain('No session');
    expect(w.host.querySelector('.panel-body p')!.textContent).toBe(
      'All symbols here replay on the same clock. Click one (or Tab to it and press Enter) to chart and trade it. Your own watchlist can be edited (+, ×) once the replay ends, or in Data & Settings.',
    );
    w.unmount();
  });

  it('says one symbol, and nothing of switching between symbols, in a bar replay of one', async () => {
    const store = await import('../state/tradingStore');
    expect(await store.startReplay({ providerId: 'demo', symbol: 'AAPL', date: '2025-03-10', startTime: '09:30', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 60, blind: false })).toBe(true);
    const w = await mount();
    expect(w.host.querySelector('.panel-head')!.textContent).toBe('Watchlist1 symbol');
    expect(w.host.querySelector('.panel-body p')!.textContent).toBe('Your own watchlist can be edited (+, ×) once the replay ends, or in Data & Settings.');
    w.unmount();
  });
});

describe('the watchlist with no session', () => {
  it('lists your symbols, each from the data source that has it, with the last close of local data only', async () => {
    const { useSettings } = await import('../state/settingsStore');
    const reg = await import('../state/dataRegistry');
    const { price, pct } = await import('../services/format');
    const { exchangeTimeToUnix, addDays, prevTradingDay, PREMARKET_OPEN } = await import('../../core/time');
    useSettings.getState().update({ watchlist: ['SPY', 'QQQ', 'PLTR'] });
    const polygon = [vi.spyOn(reg.polygonProvider, 'getBars'), vi.spyOn(reg.polygonProvider, 'getCoarseBars'), vi.spyOn(reg.polygonProvider, 'availableRange')];
    const w = await mount();
    // The demo's last two daily closes, as its daily chart shows them.
    const last = reg.demoProvider.lastDate;
    const daily = await reg.demoProvider.getCoarseBars({ symbol: 'SPY', from: exchangeTimeToUnix(prevTradingDay(last), PREMARKET_OPEN), to: exchangeTimeToUnix(addDays(last, 1), 0) }, '1D');
    const [prev, end] = daily.slice(-2);
    await vi.waitFor(() => expect(w.items()[0][2]).not.toBe(''));
    await act(async () => undefined);
    expect(w.items()).toEqual([
      ['SPY', 'Demo', `${price(end.close)}${pct((end.close / prev.close - 1) * 100, 2, true)}`],
      ['QQQ', 'Demo', expect.stringMatching(/^\d+\.\d\d[+−]\d+\.\d\d%$/)],
      // No source here has it: the chart's own is asked, and its chart will say so.
      ['PLTR', 'No data', ''],
    ]);
    expect(w.item('PLTR').querySelector('.watch-row')!.getAttribute('title')).toMatch(/^No data source here has PLTR/);
    expect(w.host.textContent).not.toContain('No session');

    // With a Polygon key it charts from Polygon, but no price is fetched: each would spend the rate limit.
    const { useCredentials } = await import('../state/credentials');
    act(() => useCredentials.setState({ creds: { polygonApiKey: 'k' } }));
    await act(async () => undefined);
    expect(w.items()[2]).toEqual(['PLTR', 'Polygon', '']);
    for (const asked of polygon) expect(asked).not.toHaveBeenCalled();
    w.unmount();
  }, 30_000);

  it('shows no close for a symbol a replay not finished keeps the chart from, blind or not, and its close again once it goes', async () => {
    const store = await import('../state/tradingStore');
    const { useSettings } = await import('../state/settingsStore');
    const reg = await import('../state/dataRegistry');
    const { price } = await import('../services/format');
    const { exchangeTimeToUnix, prevTradingDay, PREMARKET_OPEN } = await import('../../core/time');
    useSettings.getState().update({ watchlist: ['SPY', 'QQQ'] });
    const last = reg.demoProvider.lastDate;
    const close = async (symbol: string) => (await reg.demoProvider.getCoarseBars({ symbol, from: exchangeTimeToUnix(prevTradingDay(last), PREMARKET_OPEN), to: exchangeTimeToUnix(last, 24 * 60) }, '1D')).at(-1)!.close;
    // The saved sessions are read first (none here), and SPY's close is worked out before a replay of it is left unfinished.
    expect((await store.browseLastClose('demo', 'SPY'))!.last).toBe(await close('SPY'));
    const day = prevTradingDay(prevTradingDay(last));
    const hold = { id: 'replay-left', providerId: 'demo', symbols: ['SPY'], date: day, blind: false, elsewhere: false };
    act(() => store.useTrading.setState((s) => ({ browse: { ...s.browse, holds: [hold] } })));
    const [spy, qqq] = [await close('SPY'), await close('QQQ')];
    const w = await mount();
    // QQQ is not in that replay: its latest close. SPY has none, not even the one worked out before.
    await vi.waitFor(() => expect(w.items()[1][2]!.startsWith(price(qqq))).toBe(true));
    await act(async () => undefined);
    expect(w.items()[0]).toEqual(['SPY', 'Demo', '']);
    expect(await store.browseLastClose('demo', 'SPY')).toBeNull();
    // Blind, or running in another tab: none either.
    for (const other of [{ ...hold, blind: true, date: undefined }, { ...hold, elsewhere: true }]) {
      act(() => store.useTrading.setState((s) => ({ browse: { ...s.browse, holds: [other] } })));
      await act(async () => undefined);
      expect(w.items()[0][2]).toBe('');
    }
    // Discarded or ended: its close is back.
    act(() => store.useTrading.setState((s) => ({ browse: { ...s.browse, holds: [] } })));
    await vi.waitFor(() => expect(w.items()[0][2]!.startsWith(price(spy))).toBe(true));
    w.unmount();
  }, 30_000);

  it('picks each symbol’s data source: the chart’s own when it has it, else imported, demo, Polygon, Alpaca', async () => {
    const { watchSource } = await import('./Watchlist');
    const { csvProvider } = await import('../state/dataRegistry');
    const { useCredentials } = await import('../state/credentials');
    expect([watchSource('SPY', 'demo'), watchSource('PLTR', 'demo'), watchSource('SPY', 'polygon')]).toEqual(['demo', 'demo', 'demo']);
    const bars = [{ time: 1_710_250_200, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
    csvProvider.upsert({ symbol: 'PLTR', name: 'PLTR', baseTimeframe: '1D', bars, importedAt: 0, fileName: 'PLTR.csv' });
    try {
      expect([watchSource('PLTR', 'demo'), watchSource('SPY', 'csv')]).toEqual(['csv', 'demo']);
      // A ticker both have: the chart's own source, else your imported file before the demo's made-up bars.
      csvProvider.upsert({ symbol: 'QQQ', name: 'QQQ', baseTimeframe: '1D', bars, importedAt: 0, fileName: 'QQQ.csv' });
      expect([watchSource('QQQ', 'demo'), watchSource('QQQ', 'csv'), watchSource('QQQ', 'polygon')]).toEqual(['demo', 'csv', 'csv']);
      csvProvider.remove('QQQ');
      useCredentials.setState({ creds: { polygonApiKey: 'k' } });
      expect([watchSource('SPY', 'polygon'), watchSource('AMC', 'demo'), watchSource('AMC', 'alpaca')]).toEqual(['polygon', 'polygon', 'polygon']);
      useCredentials.setState({ creds: { alpacaKeyId: 'id', alpacaSecret: 'sec' } });
      expect([watchSource('AMC', 'alpaca'), watchSource('PLTR', 'alpaca')]).toEqual(['alpaca', 'alpaca']);
    } finally {
      csvProvider.remove('PLTR');
    }
  });

  it('charts a symbol with a click, takes one off with ×, and adds one with +', async () => {
    const store = await import('../state/tradingStore');
    const { useSettings } = await import('../state/settingsStore');
    useSettings.getState().update({ watchlist: ['SPY', 'QQQ', 'AAPL'] });
    const w = await mount();
    act(() => w.item('QQQ').querySelector<HTMLButtonElement>('.watch-row')!.click());
    expect(store.useTrading.getState()).toMatchObject({ activeSymbol: 'QQQ', browse: { providerId: 'demo' } });
    expect(w.item('QQQ').className).toContain(' on');
    expect(w.item('QQQ').querySelector('.watch-row')!.getAttribute('aria-pressed')).toBe('true');

    // ×: off the list, and focus goes on to the next row's ×, not to the page.
    const x = w.item('QQQ').querySelector<HTMLButtonElement>('.watch-x')!;
    expect(x.getAttribute('aria-label')).toBe('Remove QQQ from the watchlist');
    x.focus();
    act(() => x.click());
    expect(useSettings.getState().watchlist).toEqual(['SPY', 'AAPL']);
    expect(document.activeElement).toBe(w.item('AAPL').querySelector('.watch-x'));
    act(() => (document.activeElement as HTMLButtonElement).click());
    expect(document.activeElement).toBe(w.item('SPY').querySelector('.watch-x'));
    act(() => (document.activeElement as HTMLButtonElement).click());
    expect(document.activeElement).toBe(w.add());
    expect(w.host.textContent).toContain('Your watchlist is empty');

    // +: the symbol search, whose pick goes on the list and onto the chart. (jsdom lays nothing out: the
    // dialog hands focus back only to a control on screen.)
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList);
    act(() => w.add()!.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector('h2')!.textContent).toBe('Add to watchlist');
    const input = dialog.querySelector<HTMLInputElement>('.sym-query')!;
    expect(document.activeElement).toBe(input);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'amd');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => undefined);
    act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(useSettings.getState().watchlist).toEqual(['AMD']);
    expect(store.useTrading.getState().activeSymbol).toBe('AMD');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(w.add());
    expect(w.items().map((i) => i[0])).toEqual(['AMD']);
    w.unmount();
  });
});
