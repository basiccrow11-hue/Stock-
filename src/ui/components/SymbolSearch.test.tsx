// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('../chart/offscreenSnapshot', () => ({ offscreenSnapshot: async () => 'data:image/jpeg;base64,BB==' }));
// The chart draws on a canvas jsdom does not have: the toolbar's ticker and the search it opens are tested here.
vi.mock('../chart/ChartView', () => ({ ChartView: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEFAULT_WATCHLIST = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META'];

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  // jsdom lays nothing out: the dialog hands focus back only to a control that is on screen.
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList);
});

/** Mounted panels, unmounted after each test even when it fails (their key listeners are on the window). */
const roots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  const store = await import('../state/tradingStore');
  (await import('./SymbolSearch')).closeSymbolSearch();
  await store.endSession();
  store.setBrowseSource('demo');
  store.setActiveSymbol('SPY');
  store.dismissError();
  (await import('../state/credentials')).useCredentials.setState({ creds: {} });
  (await import('../state/settingsStore')).useSettings.getState().update({ watchlist: DEFAULT_WATCHLIST });
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

async function mount() {
  const store = await import('../state/tradingStore');
  const { ChartPanel } = await import('./ChartPanel');
  const settingsAt: string[] = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const render = (active: boolean) =>
    act(() => root.render(createElement(ChartPanel, { onNewSession: () => undefined, onOpenSettingsAt: (card: string) => void settingsAt.push(card), active })));
  render(true);
  await act(async () => undefined);
  const ticker = () => host.querySelector<HTMLButtonElement>('.chart-toolbar .sym-btn')!;
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const input = () => dialog()!.querySelector<HTMLInputElement>('.sym-query')!;
  /** Each result: its ticker and its name, as shown. */
  const rows = () => [...(dialog()?.querySelectorAll('.sym-row') ?? [])].map((r) => [r.querySelector('.sym')!.textContent, r.querySelector('.nm')?.textContent ?? '']);
  const row = (text: string) => [...dialog()!.querySelectorAll<HTMLElement>('.sym-row')].find((r) => r.querySelector('.sym')!.textContent === text)!;
  const sources = () => [...(dialog()?.querySelectorAll<HTMLButtonElement>('.sym-sources button') ?? [])].map((b) => [b.querySelector('.src-name')!.textContent, b.querySelector('.src-state')!.textContent, b.getAttribute('aria-pressed')]);
  const source = (name: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('.sym-sources button')].find((b) => b.querySelector('.src-name')!.textContent === name)!;
  const note = () => dialog()!.querySelector('.sym-note')?.textContent ?? '';
  const button = (text: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text);
  const open = async () => {
    ticker().focus();
    act(() => ticker().click());
    await act(async () => undefined);
  };
  /** Types `value` into the box as the user does. */
  const type = async (value: string) => {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => undefined);
  };
  const key = (target: Element, k: string, opts: KeyboardEventInit = {}) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts })));
  return { host, store, settingsAt, render, ticker, dialog, input, rows, row, sources, source, note, button, open, type, key, unmount: () => undefined };
}

describe('the symbol search', () => {
  it('opens from the ticker in the chart toolbar on the chart’s data source, says which sources are ready, and gives focus back on Esc', async () => {
    const p = await mount();
    expect(p.ticker().getAttribute('aria-label')).toBe('SPY: search symbols');
    expect(p.ticker().textContent).toBe('SPY');
    await p.open();
    expect(p.dialog()!.querySelector('h2')!.textContent).toBe('Symbol search');
    expect(document.activeElement).toBe(p.input());
    expect(p.sources()).toEqual([
      ['Demo', 'Ready', 'true'],
      ['Imported', 'Not set up', 'false'],
      ['Polygon', 'Not set up', 'false'],
      ['Alpaca', 'Not set up', 'false'],
    ]);
    expect(p.rows()).toHaveLength(11);
    expect(p.rows()[0]).toEqual(['SPY', 'S&P 500 ETF']);
    // The symbol charted now is marked.
    expect(p.row('SPY').querySelector('.sym-pick')!.getAttribute('aria-current')).toBe('true');
    // A key added makes its source ready.
    const { useCredentials } = await import('../state/credentials');
    act(() => useCredentials.setState({ creds: { polygonApiKey: 'k' } }));
    expect(p.sources()[2]).toEqual(['Polygon', 'Ready', 'false']);

    p.key(p.input(), 'Escape');
    expect(p.dialog()).toBeNull();
    expect(document.activeElement).toBe(p.ticker());
    p.unmount();
  });

  it('finds tickers and names as you type, moves through them with the arrows, and charts the one picked', async () => {
    const p = await mount();
    await p.open();
    await p.type('a');
    expect(p.rows().slice(0, 3).map((r) => r[0])).toEqual(['AAPL', 'AMZN', 'AMD']);
    await p.type('alphabet');
    expect(p.rows()).toEqual([['GOOGL', 'Alphabet']]);

    // Arrows: down into the results, through them, Home and End, and up again into the box.
    await p.type('');
    p.key(p.input(), 'ArrowDown');
    const picks = () => [...p.dialog()!.querySelectorAll<HTMLButtonElement>('.sym-pick')];
    expect(document.activeElement).toBe(picks()[0]);
    p.key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(picks()[1]);
    p.key(document.activeElement!, 'End');
    expect(document.activeElement).toBe(picks()[10]);
    p.key(document.activeElement!, 'Home');
    expect(document.activeElement).toBe(picks()[0]);
    p.key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(p.input());
    // Typing on a result goes on in the box.
    p.key(p.input(), 'ArrowDown');
    p.key(document.activeElement!, 'm');
    await act(async () => undefined);
    expect(document.activeElement).toBe(p.input());
    expect(p.input().value).toBe('m');
    p.key(p.input(), 'ArrowDown');
    p.key(document.activeElement!, 'Backspace');
    await act(async () => undefined);
    expect([document.activeElement, p.input().value]).toEqual([p.input(), '']);
    await p.type('msf');
    expect(p.rows().map((r) => r[0])).toEqual(['MSFT']);
    // Enter charts the first result.
    p.key(p.input(), 'Enter');
    expect(p.store.useTrading.getState()).toMatchObject({ activeSymbol: 'MSFT', browse: { providerId: 'demo' } });
    expect(p.dialog()).toBeNull();
    expect(document.activeElement).toBe(p.ticker());
    expect(p.ticker().textContent).toBe('MSFT');
    p.unmount();
  });

  it('says plainly that the demo has only its made-up symbols, and opens Data & Settings where real bars come in', async () => {
    const p = await mount();
    await p.open();
    await p.type('pltr');
    expect(p.note()).toBe('PLTR is not in the demo data. The demo has only these 11 symbols, and their prices are made up. To chart PLTR, bring in its real bars:Import a CSV fileAdd a Polygon or Alpaca API key');
    // The list stays in view, but Enter picks none of it.
    expect(p.rows()).toHaveLength(11);
    expect(p.dialog()!.querySelector('.sym-row.next')).toBeNull();
    p.key(p.input(), 'Enter');
    expect(p.store.useTrading.getState().activeSymbol).toBe('SPY');
    act(() => p.button('Import a CSV file')!.click());
    expect(p.settingsAt).toEqual(['csv-import']);
    expect(p.dialog()).toBeNull();

    await p.open();
    await p.type('pltr');
    act(() => p.button('Add a Polygon or Alpaca API key')!.click());
    expect(p.settingsAt).toEqual(['csv-import', 'api-keys']);

    // A source not set up lists nothing and says what it needs.
    await p.open();
    act(() => p.source('Imported').click());
    expect(document.activeElement).toBe(p.input());
    expect(p.rows()).toEqual([]);
    expect(p.note()).toBe('No CSV data imported yet. Import a file of a ticker’s bars (from your broker, TradingView or a data vendor) to chart and replay it.Import a CSV file');
    act(() => p.source('Polygon').click());
    expect(p.note()).toBe('Polygon needs your own API key. With it, any US ticker can be charted and replayed.Add a Polygon API key');
    act(() => p.source('Alpaca').click());
    act(() => p.button('Add an Alpaca API key')!.click());
    expect(p.settingsAt).toEqual(['csv-import', 'api-keys', 'api-keys']);
    p.unmount();
  });

  it('lists imported tickers, and says when one is not among them', async () => {
    const { csvProvider } = await import('../state/dataRegistry');
    csvProvider.upsert({ symbol: 'PLTR', name: 'PLTR', baseTimeframe: '1D', bars: [{ time: 1_710_250_200, open: 1, high: 1, low: 1, close: 1, volume: 1 }], importedAt: 0, fileName: 'PLTR.csv' });
    try {
      const p = await mount();
      await p.open();
      act(() => p.source('Imported').click());
      await act(async () => undefined);
      expect(p.sources()[1]).toEqual(['Imported', 'Ready', 'true']);
      expect(p.rows()).toEqual([['PLTR', '']]);
      await p.type('rddt');
      expect(p.note()).toBe('RDDT is not in your imported data. Import a CSV file of its bars to chart it.Import a CSV file');
      await p.type('pl');
      p.key(p.input(), 'Enter');
      expect(p.store.useTrading.getState()).toMatchObject({ activeSymbol: 'PLTR', browse: { providerId: 'csv' } });
      p.unmount();
    } finally {
      csvProvider.remove('PLTR');
    }
  });

  it('with a Polygon or Alpaca key, takes any ticker typed in, first, and charts it from there', async () => {
    const { useCredentials } = await import('../state/credentials');
    const { useSettings } = await import('../state/settingsStore');
    useCredentials.setState({ creds: { polygonApiKey: 'k', alpacaKeyId: 'id', alpacaSecret: 'sec' } });
    const p = await mount();
    await p.open();
    act(() => p.source('Polygon').click());
    await act(async () => undefined);
    expect(p.input().getAttribute('aria-label')).toBe('Search Polygon tickers');
    expect(p.rows()[0]).toEqual(['SPY', 'S&P 500 ETF']);
    await p.type('pltr');
    expect(p.rows()).toEqual([['Use PLTR', 'Load its bars from Polygon']]);
    expect(p.row('Use PLTR').className).toContain('next');
    await p.type('amd');
    expect(p.rows()[0]).toEqual(['AMD', '']);
    expect(p.rows().some((r) => r[0] === 'Use AMD')).toBe(false);
    await p.type('brk.b');
    expect(p.rows()[0][0]).toBe('Use BRK.B');
    await p.type('s&p!');
    expect(p.note()).toBe('“s&p!” is not a ticker: tickers are letters and digits, with a dot or a dash before a share class (BRK.B, BF-B).');
    await p.type('pltr');
    p.key(p.input(), 'Enter');
    expect(p.store.useTrading.getState()).toMatchObject({ activeSymbol: 'PLTR', browse: { providerId: 'polygon' } });
    expect(useSettings.getState().replay).toMatchObject({ providerId: 'polygon', symbol: 'PLTR' });
    // Opened again, it starts on the chart's source.
    await p.open();
    expect(p.sources()[2]).toEqual(['Polygon', 'Ready', 'true']);
    expect(p.row('PLTR')).toBeUndefined();
    act(() => p.source('Alpaca').click());
    await p.type('rddt');
    act(() => p.row('Use RDDT').querySelector<HTMLButtonElement>('.sym-pick')!.click());
    expect(p.store.useTrading.getState()).toMatchObject({ activeSymbol: 'RDDT', browse: { providerId: 'alpaca' } });
    p.unmount();
  });

  it('stars a ticker onto the watchlist, and off it', async () => {
    const { useCredentials } = await import('../state/credentials');
    const { useSettings } = await import('../state/settingsStore');
    const p = await mount();
    await p.open();
    const star = (sym: string) => p.row(sym).querySelector<HTMLButtonElement>('.sym-star')!;
    expect([star('SPY').getAttribute('aria-pressed'), star('IWM').getAttribute('aria-pressed')]).toEqual(['true', 'false']);
    expect(star('SPY').getAttribute('aria-label')).toBe('Remove SPY from the watchlist');
    act(() => star('SPY').click());
    act(() => star('IWM').click());
    expect(useSettings.getState().watchlist).toEqual([...DEFAULT_WATCHLIST.slice(1), 'IWM']);
    expect([star('SPY').getAttribute('aria-pressed'), star('IWM').getAttribute('aria-label')]).toEqual(['false', 'Remove IWM from the watchlist']);
    // Any ticker a vendor takes, before it is ever charted; starring does not chart it.
    act(() => useCredentials.setState({ creds: { polygonApiKey: 'k' } }));
    act(() => p.source('Polygon').click());
    await p.type('pltr');
    act(() => star('Use PLTR').click());
    expect(useSettings.getState().watchlist.at(-1)).toBe('PLTR');
    expect(p.store.useTrading.getState().activeSymbol).toBe('SPY');
    expect(p.dialog()).not.toBeNull();
    p.unmount();
  });

  it('during a session lists the session’s own symbols, and says how to chart another ticker', async () => {
    const p = await mount();
    expect(await p.store.startReplay({ providerId: 'demo', symbol: 'AAPL', extraSymbols: ['SPY'], date: '2024-03-12', startTime: '09:30', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 60, blind: false })).toBe(true);
    await act(async () => undefined);
    await p.open();
    expect(p.dialog()!.querySelector('.sym-sources')).toBeNull();
    expect(p.dialog()!.textContent).toContain('This replay’s symbols. To chart another ticker, exit the replay (✕ under the chart), then search again.');
    expect(p.rows()).toEqual([
      ['AAPL', 'Apple'],
      ['SPY', 'S&P 500 ETF'],
    ]);
    expect(p.dialog()!.querySelector('.sym-star')).toBeNull();
    await p.type('pltr');
    expect(p.note()).toBe('PLTR is not in this replay.');
    await p.type('sp');
    p.key(p.input(), 'Enter');
    expect(p.store.useTrading.getState()).toMatchObject({ activeSymbol: 'SPY', session: { mode: 'replay' } });

    expect(await p.store.startSim({ config: { seed: 1 }, startingBalance: 25_000, speed: 1 })).toBe(true);
    await act(async () => undefined);
    await p.open();
    expect(p.dialog()!.textContent).toContain('The simulated market’s stocks. To chart a real ticker, exit it (✕ under the chart), then search again.');
    expect(p.rows().map((r) => r[0])).toEqual(['NOVA', 'QBIT', 'MINR', 'STLW', 'VLTX', 'SIMX']);
    await p.type('stlw');
    p.key(p.input(), 'Enter');
    expect(p.store.useTrading.getState().activeSymbol).toBe('STLW');
    p.unmount();
  }, 30_000);

  it('opens with a letter typed while the chart has focus, that letter in the box, and with no other key', async () => {
    const p = await mount();
    const typed = (target: Element, k: string, opts: KeyboardEventInit = {}) => {
      p.key(target, k, opts);
      const d = p.dialog();
      const value = d ? p.input().value : null;
      if (d) p.key(p.input(), 'Escape');
      return value;
    };
    // Nothing focused (a click on the chart), or a control of the chart panel.
    expect(typed(document.body, 'n')).toBe('N');
    p.ticker().focus();
    expect(typed(p.ticker(), 'Q', { shiftKey: true })).toBe('Q');
    // Not with Ctrl, Alt or Cmd, not for other keys, and not in a field or elsewhere on the screen.
    expect([typed(document.body, 'n', { ctrlKey: true }), typed(document.body, 'n', { metaKey: true }), typed(document.body, 'n', { altKey: true }), typed(document.body, '1'), typed(document.body, ' ')]).toEqual([null, null, null, null, null]);
    const field = document.body.appendChild(document.createElement('input'));
    field.focus();
    expect(typed(field, 'n')).toBeNull();
    const other = document.body.appendChild(document.createElement('button'));
    other.focus();
    expect(typed(other, 'n')).toBeNull();
    // Not while a menu is open, nor with the Trade screen covered by another page.
    (document.activeElement as HTMLElement).blur();
    const menu = document.body.appendChild(document.createElement('div'));
    menu.className = 'popover';
    expect(typed(document.body, 'n')).toBeNull();
    menu.remove();
    p.render(false);
    expect(typed(document.body, 'n')).toBeNull();
    p.render(true);
    expect(typed(document.body, 'n')).toBe('N');
    p.unmount();
  });

  it('is offered by a chart that cannot be shown', async () => {
    const p = await mount();
    act(() => p.store.browseSymbol('polygon', 'PLTR'));
    // The chart asks for its bars, and they cannot come: there is no key.
    await vi.waitFor(() => {
      p.store.getBaseBars('PLTR');
      expect(p.store.useTrading.getState().browse.error).toBe('Add a Polygon API key in Data & Settings.');
    });
    await act(async () => undefined);
    const search = [...p.host.querySelectorAll<HTMLButtonElement>('.browse-empty button')].find((b) => b.textContent === 'Search symbols')!;
    act(() => search.click());
    await act(async () => undefined);
    expect(p.dialog()!.querySelector('h2')!.textContent).toBe('Symbol search');
    expect(p.sources()[2]).toEqual(['Polygon', 'Not set up', 'true']);
    p.unmount();
  });
});
