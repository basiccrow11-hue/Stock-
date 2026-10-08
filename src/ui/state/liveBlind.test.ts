// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'stock-replay-live-blind';

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
