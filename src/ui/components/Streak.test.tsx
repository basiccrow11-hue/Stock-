// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { emptyStreak, recordActivity, type StreakData } from '../../core/streak/streak';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  document.body.innerHTML = '';
});

async function mount({ keepModules = false } = {}) {
  if (!keepModules) vi.resetModules();
  const { StreakCelebration } = await import('./Streak');
  const streak = await import('../state/streakStore');
  const { useTrading } = await import('../state/tradingStore');
  const { useToasts } = await import('../state/toasts');
  const home = document.createElement('main');
  home.tabIndex = -1;
  home.dataset.focusHome = '';
  // jsdom has no layout; the dialog only returns focus to elements that are on screen.
  home.getClientRects = () => [new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList;
  document.body.appendChild(home);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(StreakCelebration, { view: 'trade' })));
  const toasts: string[] = [];
  const seen = (s: ReturnType<typeof useToasts.getState>) => {
    for (const t of s.toasts) if (!toasts.includes(`${t.id}|${t.text}`)) toasts.push(`${t.id}|${t.text}`);
  };
  seen(useToasts.getState());
  useToasts.subscribe(seen);
  return { streak, useTrading, useToasts, toasts, home, unmount: () => act(() => root.unmount()) };
}

const dialog = () => document.querySelector('[role=dialog]');

describe('milestone celebration', () => {
  it('announces a held celebration each time a milestone is reached, in a tab left open for days', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(new Date(2026, 9, 1, 10, 0, 0));
    const { streak, useTrading, useToasts, toasts, unmount } = await mount();
    const stop = streak.startPracticeTracker(() => true, () => useTrading.getState().playing);
    const practiseDay = (d: number) => {
      act(() => {
        vi.setSystemTime(new Date(2026, 9, d, 10, 0, 0));
        vi.advanceTimersByTime(5000);
      });
      act(() => useTrading.setState({ playing: true }));
      for (let i = 0; i < 130; i++)
        act(() => {
          window.dispatchEvent(new Event('keydown'));
          vi.advanceTimersByTime(5000);
        });
      act(() => useTrading.setState({ playing: false }));
      const shown = dialog()?.textContent ?? null;
      // Once the celebration is up, the note that it was waiting is gone.
      if (shown) expect(useToasts.getState().toasts.map((t) => t.text).filter((t) => /celebration waits/.test(t))).toEqual([]);
      if (shown) act(() => streak.dismissCelebration());
      return shown;
    };
    expect(practiseDay(1)).toBeNull();
    expect(practiseDay(2)).toBeNull();
    expect(practiseDay(3)).toMatch(/Milestone reached/);
    // 10-04 and 10-05 missed: the streak ends. A new run reaches 3 again on 10-08.
    expect(practiseDay(6)).toBeNull();
    expect(practiseDay(7)).toBeNull();
    expect(practiseDay(8)).toMatch(/Milestone reached/);
    expect(toasts.filter((t) => /celebration waits until you pause/.test(t))).toHaveLength(2);
    stop();
    unmount();
  });

  it('never celebrates a streak that ended while the celebration was waiting', async () => {
    // Reached 10-03 during playback, tab closed, back on 10-08: the streak is over.
    let d: StreakData = emptyStreak();
    for (const k of ['2026-10-01', '2026-10-02', '2026-10-03']) d = recordActivity(d, k, { activeSeconds: 600 }).data;
    expect(d.celebrate).not.toBeNull();
    localStorage.setItem('stock-replay-streak', JSON.stringify(d));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 8, 9, 0, 0));
    const { unmount } = await mount();
    expect(dialog()).toBeNull();
    unmount();
  });

  it('returns focus to the terminal, not the page body, when a celebration shown at load is dismissed', async () => {
    let d: StreakData = emptyStreak();
    for (const k of ['2026-10-06', '2026-10-07', '2026-10-08']) d = recordActivity(d, k, { activeSeconds: 600 }).data;
    localStorage.setItem('stock-replay-streak', JSON.stringify(d));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 8, 18, 0, 0));
    const { home, unmount } = await mount();
    expect(dialog()?.textContent).toMatch(/Milestone reached/);
    // Focus sits on the dialog itself, so a stray Enter or Space does not dismiss it unseen.
    expect(document.activeElement).toBe(dialog());
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(home);
    unmount();
  });

  it('waits while you type in a field and while a trade review is about to open', async () => {
    let d: StreakData = emptyStreak();
    for (const k of ['2026-10-06', '2026-10-07', '2026-10-08']) d = recordActivity(d, k, { activeSeconds: 600 }).data;
    localStorage.setItem('stock-replay-streak', JSON.stringify(d));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(2026, 9, 8, 18, 0, 0));
    vi.resetModules();
    const { useTrading } = await import('../state/tradingStore');
    useTrading.setState({ reviewsPending: 1 });
    const note = document.createElement('textarea');
    document.body.appendChild(note);
    note.focus();
    const { toasts, unmount } = await mount({ keepModules: true });
    expect(dialog()).toBeNull();
    expect(toasts.some((t) => /shows after your trade review/.test(t))).toBe(true);
    // The review closes while a note is being typed: still held until the typing pauses.
    act(() => {
      note.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      useTrading.setState({ reviewsPending: 0 });
    });
    expect(dialog()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(2000);
      note.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(2000));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(note);
    act(() => vi.advanceTimersByTime(2000));
    expect(dialog()?.textContent).toMatch(/Milestone reached/);
    unmount();
  });
});
