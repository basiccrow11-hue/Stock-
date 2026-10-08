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
