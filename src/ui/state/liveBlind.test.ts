// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'stock-replay-live-blind';
const SAVED = 'stock-replay-saved-blind';

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  localStorage.clear();
});

describe('blind sessions running in other tabs', () => {
  it('are seen in every tab until they end or their tab stops renewing them', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-08T15:00:00Z') });
    const now = Date.now();
    localStorage.setItem(KEY, JSON.stringify({ other: { start: '2025-01-15', beat: now }, gone: { start: '2024-05-01', beat: now - 200_000 } }));
    const { setLiveBlind, useLiveBlind } = await import('./liveBlind');
    // A listing whose tab stopped renewing it long ago does not count.
    expect(useLiveBlind.getState().sessions).toEqual({ other: '2025-01-15' });

    setLiveBlind({ id: 'mine', start: '2025-02-03' });
    expect(useLiveBlind.getState().sessions).toEqual({ other: '2025-01-15', mine: '2025-02-03' });
    expect(Object.keys(JSON.parse(localStorage.getItem(KEY)!)).sort()).toEqual(['mine', 'other']);

    // The other tab ends its session.
    const listing = JSON.parse(localStorage.getItem(KEY)!);
    delete listing.other;
    localStorage.setItem(KEY, JSON.stringify(listing));
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(useLiveBlind.getState().sessions).toEqual({ mine: '2025-02-03' });

    // This tab keeps renewing its own; a listing nobody renews lapses.
    localStorage.setItem(KEY, JSON.stringify({ ...JSON.parse(localStorage.getItem(KEY)!), crashed: { start: '2023-03-03', beat: Date.now() } }));
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(useLiveBlind.getState().sessions.crashed).toBe('2023-03-03');
    vi.advanceTimersByTime(160_000);
    expect(useLiveBlind.getState().sessions).toEqual({ mine: '2025-02-03' });
    expect(Object.keys(JSON.parse(localStorage.getItem(KEY)!))).toEqual(['mine']);

    // Closing the tab takes it off the list; the session ending does too.
    window.dispatchEvent(new Event('pagehide'));
    expect(localStorage.getItem(KEY)).toBeNull();
    setLiveBlind(null);
    expect(useLiveBlind.getState().sessions).toEqual({});
  });
});

describe('blind sessions saved to carry on later', () => {
  it('are seen in every tab from the start, with no heartbeat, through a closing tab, until taken off', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-08T15:00:00Z') });
    localStorage.setItem(SAVED, JSON.stringify({ left: '2024-03-12' }));
    const { setLiveBlind, setSavedBlind, useLiveBlind } = await import('./liveBlind');
    expect(useLiveBlind.getState().sessions).toEqual({ left: '2024-03-12' });

    // Carried on here, then the tab closes: it is no longer running, but still saved.
    setLiveBlind({ id: 'left', start: '2024-03-12' });
    window.dispatchEvent(new Event('pagehide'));
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(SAVED)!)).toEqual({ left: '2024-03-12' });
    setLiveBlind(null);
    vi.advanceTimersByTime(600_000);
    expect(useLiveBlind.getState().sessions).toEqual({ left: '2024-03-12' });

    // Another tab saves one, and lets go of it.
    localStorage.setItem(SAVED, JSON.stringify({ left: '2024-03-12', other: '2023-06-01' }));
    window.dispatchEvent(new StorageEvent('storage', { key: SAVED }));
    expect(useLiveBlind.getState().sessions).toEqual({ left: '2024-03-12', other: '2023-06-01' });
    localStorage.setItem(SAVED, JSON.stringify({ left: '2024-03-12' }));
    window.dispatchEvent(new StorageEvent('storage', { key: SAVED }));
    expect(useLiveBlind.getState().sessions).toEqual({ left: '2024-03-12' });

    setSavedBlind('left', null);
    expect(useLiveBlind.getState().sessions).toEqual({});
    expect(localStorage.getItem(SAVED)).toBeNull();
  });

  it('are brought in line with the sessions kept as the app opens, without undoing what tabs list meanwhile', async () => {
    localStorage.setItem(SAVED, JSON.stringify({ gone: '2020-01-02', kept: '2024-03-12', ending: '2022-02-02', starting: '2021-01-04' }));
    // A tab runs one it has listed as saved, before its first save has landed.
    localStorage.setItem(KEY, JSON.stringify({ starting: { start: '2021-01-04', beat: Date.now() } }));
    const { reconcileSavedBlind, setSavedBlind, useLiveBlind } = await import('./liveBlind');
    await reconcileSavedBlind(async () => {
      // While the sessions kept are read, another tab starts one and ends another.
      setSavedBlind('started', '2025-01-15');
      setSavedBlind('ending', null);
      return [
        { id: 'kept', start: '2024-03-12', older: false },
        { id: 'older', start: '2023-06-01', older: true },
        // Taken off by the tab that ended it, or gave its date back, before its deletion or save landed.
        { id: 'ended', start: '2019-05-06', older: false },
        { id: 'ending', start: '2022-02-02', older: false },
        { id: 'plain', start: null, older: true },
        { id: 'started', start: '2025-01-15', older: false },
      ];
    });
    const listed = { kept: '2024-03-12', older: '2023-06-01', started: '2025-01-15', starting: '2021-01-04' };
    expect(useLiveBlind.getState().sessions).toEqual(listed);
    expect(JSON.parse(localStorage.getItem(SAVED)!)).toEqual(listed);
  });
});
