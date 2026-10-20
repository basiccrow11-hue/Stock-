// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { exchangeDate, exchangeTimeToUnix, isTradingDay, parseHHMM, prevTradingDay } from '../../core/time';

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
// The chart draws on a canvas jsdom does not have (its part of Bar Replay is tested in ChartView.test.tsx);
// the toolbar and the notes around it are what is tested here.
vi.mock('../chart/ChartView', async () => {
  const { createElement } = await import('react');
  return { ChartView: () => createElement('div', { className: 'chart-wrap' }) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

afterEach(async () => {
  const store = await import('../state/tradingStore');
  store.setSelectingBar(false);
  await store.endSession();
  store.setBrowseSource('demo');
  store.setActiveSymbol('SPY');
  store.setTimeframe('1m');
  store.dismissError();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

const at = (date: string, time: string) => exchangeTimeToUnix(date, parseHHMM(time));

async function mount(active = true) {
  const store = await import('../state/tradingStore');
  const { ChartPanel } = await import('./ChartPanel');
  const asked: string[] = [];
  /** The cards of Data & Settings the panel opened the page at. */
  const opened: string[] = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (on: boolean) =>
    act(() => root.render(createElement(ChartPanel, { onNewSession: (mode: string) => void asked.push(mode), onOpenSettingsAt: (card: string) => void opened.push(card), active: on })));
  render(active);
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('button')];
  const button = (text: string) => buttons().find((b) => b.getAttribute('aria-label') === text || b.textContent!.trim() === text);
  const replay = () => buttons().find((b) => b.textContent!.trim() === 'Replay')!;
  const arrow = () => button('More ways to start a replay')!;
  const menu = () => host.querySelector<HTMLElement>('[role="menu"]');
  const item = (text: string) => [...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].find((b) => b.textContent === text);
  /** The chart's bars, which the chart (stood in for here) asks for, once they are in. */
  const loaded = async () => {
    await vi.waitFor(
      () => {
        store.getBaseBars(store.useTrading.getState().activeSymbol);
        expect(store.selectBarBlocked()).toBeNull();
      },
      { timeout: 20_000 },
    );
    await act(async () => undefined);
  };
  return { host, store, asked, opened, button, replay, arrow, menu, item, loaded, render, unmount: () => act(() => root.unmount()) };
}

/** Types `value` into a field as the user does. */
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the Replay button in the chart toolbar', () => {
  it('takes the place of New replay and Sim market, picks a bar once the chart is in, and stops when pressed again', async () => {
    const p = await mount();
    const { useToasts } = await import('../state/toasts');
    expect(p.button('New replay')).toBeUndefined();
    expect(p.button('Sim market')).toBeUndefined();
    // Before the chart's bars are in there is nothing to pick from: it says so.
    expect(p.replay().getAttribute('aria-disabled')).toBe('true');
    expect(p.replay().title).toBe('The chart is still loading.');
    useToasts.setState({ toasts: [] });
    act(() => p.replay().click());
    expect(p.store.useTrading.getState().selectingBar).toBe(false);
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(['The chart is still loading.']);

    await p.loaded();
    expect(p.replay().getAttribute('aria-disabled')).toBeNull();
    act(() => p.replay().click());
    expect(p.store.useTrading.getState().selectingBar).toBe(true);
    expect(p.replay().getAttribute('aria-pressed')).toBe('true');
    act(() => p.replay().click());
    expect(p.store.useTrading.getState().selectingBar).toBe(false);
    expect(p.replay().getAttribute('aria-pressed')).toBe('false');

    // Another page over the chart stops picking a bar.
    act(() => p.replay().click());
    expect(p.store.useTrading.getState().selectingBar).toBe(true);
    p.render(false);
    expect(p.store.useTrading.getState().selectingBar).toBe(false);
    p.unmount();
  }, 30_000);

  it('opens the other ways to start from its arrow: Select bar, Select date, Random bar, the full setup and the simulated market', async () => {
    const p = await mount();
    await p.loaded();
    act(() => p.arrow().click());
    expect(p.arrow().getAttribute('aria-expanded')).toBe('true');
    expect([...p.menu()!.children].map((e) => (e.getAttribute('role') === 'separator' ? '—' : e.textContent))).toEqual(['Select bar', 'Select date…', 'Random bar', 'Advanced replay setup…', '—', 'Simulated market…']);
    // It opens on its first item; the arrows go through them.
    expect(document.activeElement).toBe(p.item('Select bar'));
    act(() => void p.menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement).toBe(p.item('Select date…'));
    act(() => void p.menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(document.activeElement).toBe(p.item('Simulated market…'));

    act(() => p.item('Advanced replay setup…')!.click());
    expect(p.menu()).toBeNull();
    act(() => p.arrow().click());
    act(() => p.item('Simulated market…')!.click());
    expect(p.asked).toEqual(['replay', 'sim']);
    act(() => p.arrow().click());
    act(() => p.item('Select bar')!.click());
    expect(p.menu()).toBeNull();
    expect(p.store.useTrading.getState().selectingBar).toBe(true);
    p.unmount();
  }, 30_000);

  it('Select date checks the day and time as the setup form does, and starts the replay there', async () => {
    const p = await mount();
    const { demoProvider } = await import('../state/dataRegistry');
    const { useSettings } = await import('../state/settingsStore');
    await p.loaded();
    act(() => p.arrow().click());
    act(() => p.item('Select date…')!.click());
    const dialog = () => p.host.querySelector<HTMLElement>('[role="dialog"][aria-label="Start the replay at a date"]')!;
    const field = (label: string) => [...dialog().querySelectorAll('label')].find((l) => l.textContent!.startsWith(label))!.querySelector('input')!;
    const warning = () => dialog().querySelector('.alert.warn')?.textContent ?? null;
    const start = () => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Start replay')!;
    expect(dialog().textContent).toContain('Replay SPY from a date');
    expect(document.activeElement).toBe(field('Date'));
    expect(field('Date').value).toBe(useSettings.getState().replay.date);
    expect(field('Time (ET)').value).toBe('09:30');

    type(field('Date'), '');
    expect(warning()).toBe('Choose a date.');
    expect(start().disabled).toBe(true);
    type(field('Date'), '2024-03-16');
    expect(warning()).toBe('2024-03-16 is not a trading day (weekend or NYSE holiday).');
    type(field('Date'), '2001-03-15');
    await vi.waitFor(() => expect(warning()).toMatch(/^Data for SPY covers \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\.$/));
    let day = prevTradingDay(prevTradingDay(demoProvider.lastDate));
    while (!isTradingDay(day)) day = prevTradingDay(day);
    type(field('Date'), day);
    type(field('Time (ET)'), '');
    expect(warning()).toBe('Enter the time as HH:MM.');
    type(field('Time (ET)'), '10:15');
    expect(warning()).toBeNull();

    // Back goes to the menu.
    act(() => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Back')!.click());
    expect(p.item('Select date…')).toBeDefined();
    act(() => p.item('Select date…')!.click());
    type(field('Date'), day);
    type(field('Time (ET)'), '10:15');
    act(() => start().click());
    await vi.waitFor(() => expect(p.store.useTrading.getState().session).not.toBeNull(), { timeout: 20_000 });
    expect(p.store.useTrading.getState()).toMatchObject({ now: at(day, '10:15'), session: { symbols: ['SPY'], blind: false } });
    p.unmount();
  }, 30_000);

  it('Random bar starts at the open of a day of the data', async () => {
    const p = await mount();
    const { demoProvider } = await import('../state/dataRegistry');
    await p.loaded();
    act(() => p.arrow().click());
    act(() => p.item('Random bar')!.click());
    expect(p.menu()).toBeNull();
    await vi.waitFor(() => expect(p.store.useTrading.getState().session).not.toBeNull(), { timeout: 20_000 });
    const s = p.store.useTrading.getState();
    const day = exchangeDate(s.now);
    expect(isTradingDay(day)).toBe(true);
    expect(day <= demoProvider.lastDate).toBe(true);
    expect(s.now).toBe(at(day, '09:30'));
    p.unmount();
  }, 30_000);
});

describe('the chart with no session', () => {
  it('says how to start a replay until that tip is dismissed or followed, and remembers it', async () => {
    const tip = 'Press Replay, then click the bar to start from.';
    let p = await mount();
    expect(p.host.querySelector('.browse-tip span')!.textContent).toBe(tip);
    act(() => p.button('Dismiss this tip')!.click());
    expect(p.host.textContent).not.toContain(tip);
    p.unmount();
    p = await mount();
    expect(p.host.textContent).not.toContain(tip);
    p.unmount();

    localStorage.clear();
    p = await mount();
    expect(p.host.textContent).toContain(tip);
    await p.loaded();
    act(() => p.replay().click());
    act(() => p.replay().click());
    expect(p.host.textContent).not.toContain(tip);
    p.unmount();
    p = await mount();
    expect(p.host.textContent).not.toContain(tip);
    p.unmount();
  }, 30_000);

  it('says the chart is loading, why it cannot be shown, and offers the demo data in place of a source it cannot use', async () => {
    const p = await mount();
    const { ReplaySession } = await import('../../core/replay/ReplaySession');
    // IWM's bars take a while to come in.
    const real = ReplaySession.preview.bind(ReplaySession);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    vi.spyOn(ReplaySession, 'preview').mockImplementation(async (provider, setup, signal) => {
      if (setup.symbol === 'IWM') await held;
      return real(provider, setup, signal);
    });
    act(() => p.store.setActiveSymbol('IWM'));
    act(() => void p.store.getBaseBars('IWM'));
    await vi.waitFor(() => expect(p.host.querySelector('.browse-loading')?.textContent).toBe('Loading IWM…'));
    release();
    await p.loaded();
    expect(p.host.querySelector('.browse-loading')).toBeNull();
    expect(p.host.querySelector('.browse-empty')).toBeNull();

    act(() => p.store.setBrowseSource('polygon'));
    await vi.waitFor(() => {
      p.store.getBaseBars('IWM');
      expect(p.host.querySelector('.browse-empty')?.textContent).toContain('Add a Polygon API key in Data & Settings.');
    });
    const { getProvider } = await import('../state/dataRegistry');
    expect(p.host.querySelector('.browse-empty strong')!.textContent).toBe(`No chart of IWM from ${getProvider('polygon').name}`);
    // Nothing to start a replay from, nor a tip to press Replay.
    expect(p.replay().getAttribute('aria-disabled')).toBe('true');
    expect(p.host.querySelector('.browse-tip')).toBeNull();
    act(() => p.button('Use the demo data')!.click());
    expect(p.store.useTrading.getState()).toMatchObject({ activeSymbol: 'IWM', browse: { providerId: 'demo' } });
    await p.loaded();
    expect(p.host.querySelector('.browse-empty')).toBeNull();

    // A ticker the data does not have: no way to a source it is already on.
    act(() => p.store.setActiveSymbol('ZZZZ'));
    await vi.waitFor(() => {
      p.store.getBaseBars('ZZZZ');
      expect(p.host.querySelector('.browse-empty')?.textContent).toContain('The demo data has no ZZZZ.');
    });
    expect(p.button('Use the demo data')).toBeUndefined();
    expect(p.button('Try again')).toBeDefined();
    p.unmount();
  }, 30_000);

  it('charts the demo’s copy of a ticker, or SPY, from the demo data button, and opens Data & Settings at the card that brings in what is missing', async () => {
    const p = await mount();
    const { useSettings } = await import('../state/settingsStore');
    const card = () => p.host.querySelector('.browse-empty')?.textContent ?? '';
    // A Polygon ticker the demo does not have, with no key: the key's card, or the demo's SPY.
    act(() => p.store.browseSymbol('polygon', 'PLTR'));
    await vi.waitFor(() => {
      p.store.getBaseBars('PLTR');
      expect(card()).toContain('Add a Polygon API key in Data & Settings.');
    });
    expect(p.button('Import a CSV file')).toBeUndefined();
    act(() => p.button('Add a Polygon API key')!.click());
    expect(p.opened).toEqual(['api-keys']);
    const use = p.button('Use the demo data')!;
    use.focus();
    act(() => use.click());
    expect(p.store.useTrading.getState()).toMatchObject({ activeSymbol: 'SPY', browse: { providerId: 'demo', error: null } });
    expect(useSettings.getState().replay).toMatchObject({ providerId: 'demo', symbol: 'SPY' });
    // Focus goes on to the ticker's button, not to the page.
    expect(document.activeElement).toBe(p.host.querySelector('.chart-toolbar .sym-btn'));
    await p.loaded();
    expect(card()).toBe('');

    act(() => p.store.browseSymbol('alpaca', 'NVDA'));
    await vi.waitFor(() => {
      p.store.getBaseBars('NVDA');
      expect(p.button('Add an Alpaca API key')).toBeDefined();
    });
    act(() => p.button('Use the demo data')!.click());
    expect(p.store.useTrading.getState()).toMatchObject({ activeSymbol: 'NVDA', browse: { providerId: 'demo' } });
    await p.loaded();

    // Imported data with none imported: the import card.
    act(() => p.store.browseSymbol('csv', 'QQQ'));
    await vi.waitFor(() => {
      p.store.getBaseBars('QQQ');
      expect(card()).toContain('No CSV data imported yet.');
    }, { timeout: 10_000 });
    expect(p.button('Add a Polygon API key')).toBeUndefined();
    act(() => p.button('Import a CSV file')!.click());
    expect(p.opened).toEqual(['api-keys', 'csv-import']);
    p.unmount();
  }, 30_000);

  it('hides why a replay did not start while a bar is picked, so the hint on the chart can be read', async () => {
    const p = await mount();
    await p.loaded();
    const newest = p.store.getBaseBars('SPY').at(-1)!.time;
    await act(async () => void (await p.store.startBarReplay(newest)));
    const alert = () => p.host.querySelector('.browse-notes [role="alert"]');
    expect(alert()?.textContent).toContain('Nothing follows this bar in the data yet');
    act(() => p.replay().click());
    expect(p.store.useTrading.getState().selectingBar).toBe(true);
    expect(alert()).toBeNull();
    // Picking stopped, it is back until dismissed.
    act(() => p.replay().click());
    expect(alert()?.textContent).toContain('Nothing follows this bar in the data yet');
    p.unmount();
  }, 30_000);

  it('covers the chart of a ticker a blind replay keeps hidden, and says where it stops for a replay that is not blind', async () => {
    const p = await mount();
    await p.loaded();
    const { demoProvider } = await import('../state/dataRegistry');
    const until = at(prevTradingDay(demoProvider.lastDate), '10:05');
    const hold = { id: 'replay_other', providerId: 'demo', symbols: ['SPY', 'QQQ'], until, blind: true, elsewhere: false };
    // As read from the saved sessions (the stand-in storage here keeps none).
    const holds = (h: (typeof hold)[]) => act(() => p.store.useTrading.setState((s) => ({ browse: { ...s.browse, holds: h } })));
    const card = () => p.host.querySelector<HTMLElement>('.browse-empty');
    holds([hold]);
    expect(card()!.getAttribute('role')).toBe('status');
    expect(card()!.textContent).toContain('A blind replay of SPY is unfinished. Resume or discard it to chart SPY here.');
    expect(p.button('Search symbols')).toBeDefined();
    expect(p.button('Try again')).toBeUndefined();
    expect(p.host.querySelector('.browse-tip')).toBeNull();
    expect(p.replay().getAttribute('aria-disabled')).toBe('true');
    // Hiding the unfinished sessions does not show the chart; the card offers them back.
    act(() => p.button('Hide unfinished sessions')!.click());
    expect(card()!.textContent).toContain('A blind replay of SPY is unfinished.');
    act(() => p.button('Show unfinished sessions')!.click());
    expect(p.button('Hide unfinished sessions')).toBeDefined();
    holds([{ ...hold, elsewhere: true }]);
    expect(card()!.textContent).toContain('A blind replay of SPY is running in another tab. Its chart stays hidden here until that replay ends, as its date does.');

    // Not blind: the chart is drawn up to its clock, and says so.
    holds([{ ...hold, blind: false }]);
    expect(card()).toBeNull();
    const cap = () => p.host.querySelector('.browse-cap')?.textContent ?? null;
    expect(cap()).toBe(`Bars shown up to ${exchangeDate(until)} 10:05 ET, where your unfinished SPY replay is.`);
    holds([{ ...hold, blind: false, elsewhere: true }]);
    expect(cap()).toBe(`Bars shown up to ${exchangeDate(until)} 10:05 ET, where the SPY replay running in another tab was last saved.`);
    act(() => p.replay().click());
    expect(cap()).toBeNull();
    act(() => p.replay().click());
    // Another ticker is not held back.
    holds([{ ...hold, blind: false, symbols: ['QQQ'] }]);
    expect(cap()).toBeNull();
    holds([]);
    p.unmount();
  }, 30_000);

  it('keeps its notes under the legend\'s first row, however many lines that takes, and under a lower row that reaches under them', async () => {
    // jsdom lays nothing out: the boxes are given here, and the observers called as the browser would.
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private fn: () => void) {
          observers.push(() => this.fn());
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const p = await mount();
    const notes = p.host.querySelector<HTMLElement>('.browse-notes')!;
    const top = () => notes.style.getPropertyValue('--clear-of-legend');
    expect(top()).toBe('8px');
    const host = p.host.querySelector<HTMLElement>('.chart-host')!;
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    // The chart draws its legend: one line of prices.
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    const row = legend.appendChild(document.createElement('div'));
    row.className = 'legend-row';
    let bottom = 124;
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => ({ bottom }) as DOMRect);
    await act(async () => void p.host.querySelector('.chart-wrap')!.appendChild(legend));
    expect(top()).toBe('32px');
    // A narrower chart wraps it onto two lines.
    bottom = 138;
    act(() => observers.forEach((o) => o()));
    expect(top()).toBe('46px');
    bottom = 124;
    act(() => observers.forEach((o) => o()));
    expect(top()).toBe('32px');

    // Rows of overlay indicators below it: one that reaches under the notes (Bollinger Bands' three values)
    // takes them below it; one that ends short of them leaves them where they are.
    const tip = notes.querySelector<HTMLElement>('.browse-tip')!;
    vi.spyOn(tip, 'getBoundingClientRect').mockReturnValue({ left: 600, right: 900, width: 300, top: 0, bottom: 0 } as DOMRect);
    const overlay = (rowBottom: number, right: number) => {
      const r = document.createElement('div');
      r.className = 'legend-ind';
      vi.spyOn(r, 'getBoundingClientRect').mockReturnValue({ bottom: rowBottom, right } as DOMRect);
      return r;
    };
    const sma = overlay(138, 400);
    await act(async () => void legend.appendChild(sma));
    expect(top()).toBe('32px');
    const bb = overlay(152, 640);
    await act(async () => void legend.appendChild(bb));
    expect(top()).toBe('60px');
    // Removing the indicator places them again.
    await act(async () => bb.remove());
    expect(top()).toBe('32px');
    await act(async () => legend.remove());
    expect(top()).toBe('8px');
    const css = (await import('node:fs')).readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');
    expect(css).toMatch(/\n\.browse-notes \{ position: absolute; top: var\(--clear-of-legend, 30px\);/);
    vi.unstubAllGlobals();
    p.unmount();
  }, 30_000);

  it('says why a replay did not start until that is dismissed', async () => {
    const p = await mount();
    await p.loaded();
    const newest = p.store.getBaseBars('SPY').at(-1)!.time;
    await act(async () => void (await p.store.startBarReplay(newest)));
    const alert = () => p.host.querySelector('.browse-notes [role="alert"]');
    expect(alert()?.textContent).toContain('Nothing follows this bar in the data yet');
    act(() => p.button('Dismiss this message')!.click());
    expect(alert()).toBeNull();
    expect(p.store.useTrading.getState().error).toBeNull();
    p.unmount();
  }, 30_000);
});
