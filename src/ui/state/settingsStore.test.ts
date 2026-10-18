// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'stock-replay-settings';

/** What another tab does: write the key, then this tab hears about it through a storage event. */
function otherTabSaves(state: object) {
  const oldValue = localStorage.getItem(KEY);
  const newValue = JSON.stringify({ state, version: 1 });
  localStorage.setItem(KEY, newValue);
  window.dispatchEvent(new StorageEvent('storage', { key: KEY, oldValue, newValue, storageArea: localStorage }));
}

describe('settings in several open tabs', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('takes another tab’s save, so this tab’s next write keeps it', async () => {
    const { useSettings } = await import('./settingsStore');
    const theirs = { ...useSettings.getState(), execution: { ...useSettings.getState().execution, strictRisk: { ...useSettings.getState().execution.strictRisk, enabled: true } } };
    otherTabSaves(theirs);
    await vi.waitFor(() => expect(useSettings.getState().execution.strictRisk.enabled).toBe(true));
    // Starting a replay here writes the settings again.
    useSettings.getState().updateReplay({ date: '2024-03-12' });
    const stored = JSON.parse(localStorage.getItem(KEY)!).state;
    expect(stored.execution.strictRisk.enabled).toBe(true);
    expect(stored.replay.date).toBe('2024-03-12');
  });

  it('keeps what it has when another tab clears the key', async () => {
    const { useSettings } = await import('./settingsStore');
    useSettings.getState().applyTheme('light');
    localStorage.removeItem(KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, oldValue: 'x', newValue: null, storageArea: localStorage }));
    await new Promise((r) => setTimeout(r, 0));
    expect(useSettings.getState().appearance.theme).toBe('light');
  });

  it('remembers removing every indicator', async () => {
    const first = await import('./settingsStore');
    for (const i of first.useSettings.getState().indicators) first.useSettings.getState().removeIndicator(i.id);
    expect(first.useSettings.getState().indicators).toEqual([]);
    vi.resetModules();
    const reloaded = await import('./settingsStore');
    await vi.waitFor(() => expect(reloaded.useSettings.persist.hasHydrated()).toBe(true));
    expect(reloaded.useSettings.getState().indicators).toEqual([]);
  });
});

describe('your own rules in saved settings', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('start empty on settings saved before they existed, and keep only usable text from a damaged save', async () => {
    localStorage.setItem(KEY, JSON.stringify({ state: { rules: { maxRiskPctPerTrade: 2 } }, version: 1 }));
    const first = await import('./settingsStore');
    expect(first.useSettings.getState().rules).toMatchObject({ maxRiskPctPerTrade: 2, custom: [] });
    vi.resetModules();
    localStorage.setItem(KEY, JSON.stringify({ state: { rules: { custom: ['Trade with the trend', 3, '  ', null] } }, version: 1 }));
    const second = await import('./settingsStore');
    expect(second.useSettings.getState().rules.custom).toEqual(['Trade with the trend']);
    vi.resetModules();
    localStorage.setItem(KEY, JSON.stringify({ state: { rules: { custom: 'Trade with the trend' } }, version: 1 }));
    const third = await import('./settingsStore');
    expect(third.useSettings.getState().rules.custom).toEqual([]);
  });
});

describe('a damaged or hand-edited save', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('never replaces the store’s own functions, and keeps only settings of the right kind', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          update: 1,
          reset: 'x',
          watchlist: 'SPY',
          defaultBalance: '30000',
          execution: { commissionPerShare: 'abc', spread: { mode: 'cents' }, marketOrderFill: 'sometimes', strictRisk: { enabled: true, maxDailyLossPct: null } },
          replay: { symbol: 'AAPL', timeframe: '3m' },
          sim: { marketRegime: 'sideways', seed: 7 },
          indicators: [{ id: 'e', type: 'ema', enabled: true, period: 9, color: '#fff' }, { id: 'x', type: 'nope', enabled: true, color: '#fff' }, { id: 'p', type: 'sma', enabled: true, period: '9', color: '#fff' }],
          appearance: { theme: 'light', pnlHold: { panel: true, chart: false } },
        },
        version: 1,
      }),
    );
    const first = await import('./settingsStore');
    const s = first.useSettings.getState();
    expect(typeof s.update).toBe('function');
    expect(typeof s.reset).toBe('function');
    expect(s.watchlist).toEqual(first.DEFAULT_SETTINGS.watchlist);
    expect(s.defaultBalance).toBe(25_000);
    expect('commissionPerShare' in s.execution).toBe(false);
    expect(s.execution.spread).toEqual({ ...first.DEFAULT_SETTINGS.execution.spread, mode: 'cents' });
    expect(s.execution.marketOrderFill).toBe('last_price');
    expect(s.execution.strictRisk).toEqual({ ...first.DEFAULT_SETTINGS.execution.strictRisk, enabled: true });
    expect(s.replay).toMatchObject({ symbol: 'AAPL', timeframe: '1m' });
    expect(s.sim).toMatchObject({ marketRegime: 'auto', seed: 7 });
    expect(s.indicators.map((i) => i.id)).toEqual(['e']);
    expect(s.appearance).toMatchObject({ theme: 'light', pnlHold: { panel: true, chart: false } });
    s.update({ defaultBalance: 30_000 });
    s.reset();
    vi.resetModules();
    const reloaded = await import('./settingsStore');
    await vi.waitFor(() => expect(reloaded.useSettings.persist.hasHydrated()).toBe(true));
    expect(typeof reloaded.useSettings.getState().update).toBe('function');
    expect(reloaded.useSettings.getState().defaultBalance).toBe(25_000);
  });
});
