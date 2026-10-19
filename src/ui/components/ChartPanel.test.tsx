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
vi.mock('../chart/ChartView', () => ({ ChartView: () => null }));

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
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (on: boolean) => act(() => root.render(createElement(ChartPanel, { onNewSession: (mode: string) => void asked.push(mode), active: on })));
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
  return { host, store, asked, button, replay, arrow, menu, item, loaded, render, unmount: () => act(() => root.unmount()) };
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
    expect(p.store.useTrading.getState().browse.providerId).toBe('demo');
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
