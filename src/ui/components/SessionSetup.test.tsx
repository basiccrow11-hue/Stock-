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

async function open(mode: 'replay' | 'sim' = 'replay') {
  const { SessionSetup } = await import('./SessionSetup');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(SessionSetup, { mode, onClose: () => undefined })));
  const dateField = () => document.querySelector<HTMLInputElement>('input[type=date]')!;
  return { root, dateField };
}

describe('the new replay form and blind replays', () => {
  it('does not show the date a running blind replay is hiding, from this tab or another', async () => {
    const { useSettings } = await import('../state/settingsStore');
    const { useLiveBlind } = await import('../state/liveBlind');
    useSettings.getState().updateReplay({ date: '2024-08-30' });
    useLiveBlind.setState({ sessions: { 'replay_other-tab': '2024-08-30' } });
    const hidden = await open();
    expect(hidden.dateField().value).toBe('');
    expect(document.body.textContent).toContain('belongs to a blind replay still running, so it stays hidden');
    expect(document.body.textContent).not.toContain('2024-08-30');
    act(() => hidden.root.unmount());

    // Once that replay is over, the date is the usual default again.
    useLiveBlind.setState({ sessions: {} });
    const shown = await open();
    expect(shown.dateField().value).toBe('2024-08-30');
    act(() => shown.root.unmount());
  });

  it('does not save a blind replay’s date as the next default', async () => {
    const { useSettings } = await import('../state/settingsStore');
    const store = await import('../state/tradingStore');
    useSettings.getState().updateReplay({ date: '2024-03-12', blind: false, providerId: 'demo', symbol: 'SPY', multiDay: false, startTime: '10:00', endTime: '16:00', includeWatchlist: false });
    const form = await open();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      set.call(form.dateField(), '2024-03-13');
      form.dateField().dispatchEvent(new Event('input', { bubbles: true }));
    });
    const blind = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('Blind mode'))!.querySelector('input')!;
    act(() => blind.click());
    const start = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Start replay')!;
    await act(async () => start.click());
    await vi.waitFor(() => expect(store.useTrading.getState().session?.blind).toBe(true));
    expect(store.useTrading.getState().session?.startDate).toBe('2024-03-13');
    expect(useSettings.getState().replay).toMatchObject({ date: '2024-03-12', blind: true, startTime: '10:00' });
    act(() => form.root.unmount());
    await store.endSession();
  });
});

describe('the replay form for a challenge', () => {
  it('starts a one-day challenge as one day, whatever the last replay was', async () => {
    const { useSettings } = await import('../state/settingsStore');
    const { SessionSetup } = await import('./SessionSetup');
    useSettings.getState().updateReplay({ date: '2024-03-12', endDate: '2024-09-30', multiDay: true, blind: false });
    const multi = () => [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('Multi-day replay'))!.querySelector('input')!;
    for (const [id, expected] of [['day-max-dd-5', false], ['grow-20-1pct', true]] as const) {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      await act(async () => root.render(createElement(SessionSetup, { mode: 'replay', onClose: () => undefined, presetChallenge: id })));
      expect(multi().checked).toBe(expected);
      act(() => root.unmount());
      host.remove();
    }
  });
});


describe('a replay that fails to start', () => {
  it('announces the error and keeps the Start button focusable', async () => {
    const { useSettings } = await import('../state/settingsStore');
    const { demoProvider } = await import('../state/dataRegistry');
    const down = vi.spyOn(demoProvider, 'getBars').mockRejectedValue(new Error('The data service is down.'));
    useSettings.getState().updateReplay({ date: '2024-03-12', blind: false, providerId: 'demo', symbol: 'SPY', multiDay: false, startTime: '10:00', endTime: '16:00', includeWatchlist: false });
    const form = await open();
    const start = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Start replay')!;
    const alert = () => [...document.querySelectorAll('[role="alert"]')].map((e) => e.textContent).join('');
    for (let attempt = 0; attempt < 2; attempt++) {
      start.focus();
      await act(async () => start.click());
      await vi.waitFor(() => expect(alert()).toContain('The data service is down.'));
      // Never disabled while loading (aria-disabled instead), so focus is still on it after the failure.
      expect(start.disabled).toBe(false);
      expect(start.getAttribute('aria-disabled')).toBeNull();
      expect(document.activeElement).toBe(start);
    }
    act(() => form.root.unmount());
    down.mockRestore();
  });

  it('shows the error in a form opened while it loaded, or as a toast once every form is closed', async () => {
    const { useSettings } = await import('../state/settingsStore');
    const { useToasts } = await import('../state/toasts');
    const { demoProvider } = await import('../state/dataRegistry');
    let fail!: (e: Error) => void;
    const down = vi.spyOn(demoProvider, 'getBars').mockImplementation(() => new Promise((_, reject) => (fail = reject)));
    useSettings.getState().updateReplay({ date: '2024-03-12', blind: false, providerId: 'demo', symbol: 'SPY', multiDay: false, startTime: '10:00', endTime: '16:00', includeWatchlist: false });
    const toasts = () => useToasts.getState().toasts.map((t) => t.text);
    for (const reopen of [true, false]) {
      useToasts.setState({ toasts: [] });
      const first = await open();
      await act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Start replay')!.click());
      act(() => first.root.unmount()); // closed while it loads
      document.body.innerHTML = '';
      const second = reopen ? await open() : null;
      await act(async () => fail(new Error('The data service is down.')));
      if (second) {
        await vi.waitFor(() => expect(document.querySelector('.alert.error')?.textContent).toBe('The data service is down.'));
        expect([...document.querySelectorAll('[role="alert"]')].map((e) => e.textContent).join('')).toContain('The data service is down.');
        expect(toasts()).toEqual([]);
        act(() => second.root.unmount());
      } else {
        await vi.waitFor(() => expect(toasts()).toEqual(['The replay did not start: The data service is down.']));
      }
    }
    down.mockRestore();
  });

  it('refuses a ticker the demo data does not have, and names the ones it does', async () => {
    const { useSettings } = await import('../state/settingsStore');
    useSettings.getState().updateReplay({ date: '2024-03-12', blind: false, providerId: 'demo', symbol: 'NFLX', multiDay: false, startTime: '10:00', endTime: '16:00', includeWatchlist: false });
    const form = await open();
    await vi.waitFor(() => expect(document.querySelector('.alert.warn')?.textContent).toMatch(/^The demo data has no NFLX\. Choose one of: .*AAPL.*\.$/));
    expect([...document.querySelectorAll('button')].find((b) => b.textContent === 'Start replay')!.disabled).toBe(true);
    act(() => form.root.unmount());
  });
});

describe('starts that overlap', () => {
  it('ignores Start while another start is still loading', async () => {
    const { useSettings } = await import('../state/settingsStore');
    const store = await import('../state/tradingStore');
    useSettings.getState().updateReplay({ date: '2024-03-12', blind: false, providerId: 'demo', symbol: 'SPY', multiDay: false, startTime: '10:00', endTime: '16:00', includeWatchlist: false });
    const form = await open();
    act(() => store.useTrading.setState({ loading: true })); // a start from a form closed while it loaded
    const start = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Loading data…')!;
    expect(start.getAttribute('aria-disabled')).toBe('true');
    await act(async () => start.click());
    expect(store.useTrading.getState().session).toBeNull();
    act(() => form.root.unmount());
    store.useTrading.setState({ loading: false });
  });

  it('drops a replay still loading when a newer session starts', async () => {
    const store = await import('../state/tradingStore');
    const replay = store.startReplay({ providerId: 'demo', symbol: 'SPY', extraSymbols: [], date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 0, timeframe: '1m', speed: 60, blind: false });
    const sim = store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 60 });
    expect(await replay).toBe(false);
    expect(await sim).toBe(true);
    expect(store.useTrading.getState().session?.mode).toBe('sim');
    expect(store.useTrading.getState().loading).toBe(false);
    await store.endSession();
  });
});

describe('the simulated market form', () => {
  it('starts at 1x, real time, unless a speed was chosen before', async () => {
    const { useSettings } = await import('../state/settingsStore');
    const store = await import('../state/tradingStore');
    const speed = () => [...document.querySelectorAll('label')].find((l) => l.querySelector('span')?.textContent === 'Speed')!.querySelector('select')!;
    const form = await open('sim');
    expect(speed().value).toBe('1');
    expect(speed().selectedOptions[0].textContent).toBe('1x real time');
    const start = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Start market')!;
    await act(async () => start.click());
    await vi.waitFor(() => expect(store.useTrading.getState().session?.mode).toBe('sim'));
    expect(store.useTrading.getState().speed).toBe(1);
    expect(store.useTrading.getState().playing).toBe(true);
    act(() => form.root.unmount());
    await store.endSession();

    // A speed saved before, by this version or an older one, is kept.
    useSettings.getState().update({ sim: { ...useSettings.getState().sim, speed: 30 } });
    const again = await open('sim');
    expect(speed().value).toBe('30');
    act(() => again.root.unmount());
  });

  it('does not claim its tickers can never match a real one', async () => {
    const form = await open('sim');
    const text = document.body.textContent!;
    expect(text).not.toMatch(/never uses or imitates real tickers/);
    expect(text).toContain('The companies and their news are invented: a ticker that happens to match a real listing is a coincidence');
    act(() => form.root.unmount());
  });
});
