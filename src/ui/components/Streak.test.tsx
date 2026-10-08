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

async function mount() {
  vi.resetModules();
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
  useToasts.subscribe((s) => {
    for (const t of s.toasts) if (!toasts.includes(`${t.id}|${t.text}`)) toasts.push(`${t.id}|${t.text}`);
  });
  return { streak, useTrading, toasts, home, unmount: () => act(() => root.unmount()) };
}

const dialog = () => document.querySelector('[role=dialog]');

describe('milestone celebration', () => {
  it('announces a held celebration each time a milestone is reached, in a tab left open for days', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
    vi.setSystemTime(new Date(2026, 9, 1, 10, 0, 0));
    const { streak, useTrading, toasts, unmount } = await mount();
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
    expect(document.activeElement?.textContent).toBe('Keep going');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(home);
    unmount();
  });
});
