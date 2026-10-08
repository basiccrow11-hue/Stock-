// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, emptyStreak, recordActivity, type StreakData } from '../../core/streak/streak';

type Store = typeof import('./streakStore');

async function freshStore(): Promise<Store> {
  vi.resetModules();
  return await import('./streakStore');
}

function seed(days: string[]): StreakData {
  let d = emptyStreak();
  for (const k of days) d = recordActivity(d, k, { activeSeconds: 600 }).data;
  localStorage.setItem('stock-replay-streak', JSON.stringify(d));
  return d;
}

/** Simulate a user who keeps interacting, for `minutes`, in 5 s ticks. */
function practise(minutes: number): void {
  for (let i = 0; i < minutes * 12; i++) {
    window.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(5_000);
  }
}

const today = (m: Store) => {
  const s = m.useStreak.getState();
  return s.data.days[s.today];
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('practice tracker', () => {
  it('counts active time and completes the daily goal', async () => {
    vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0));
    const m = await freshStore();
    const stop = m.startPracticeTracker(() => true, () => false);
    practise(10);
    expect(today(m)?.activeSeconds).toBeGreaterThanOrEqual(595);
    expect(today(m)?.done).toBe(true);
    stop();
  });

  it('keeps working in memory when storage refuses writes', async () => {
    vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const m = await freshStore();
    const stop = m.startPracticeTracker(() => true, () => false);
    practise(5);
    expect(today(m)?.activeSeconds).toBeGreaterThanOrEqual(295);
    m.setStreakGoal(30);
    practise(1);
    expect(m.useStreak.getState().data.goalMinutes).toBe(30);
    stop();
  });

  it('does not turn idle time into practice when the system clock steps back', async () => {
    vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0));
    const m = await freshStore();
    const stop = m.startPracticeTracker(() => true, () => false);
    window.dispatchEvent(new Event('keydown'));
    vi.setSystemTime(new Date(2026, 9, 8, 11, 0, 0)); // clock corrected back one hour
    vi.advanceTimersByTime(20 * 60_000); // 20 minutes without any input
    // Only the 90 s idle allowance after the last key press counts.
    expect(today(m)?.activeSeconds ?? 0).toBeLessThanOrEqual(95);
    expect(today(m)?.done ?? false).toBe(false);
    stop();
  });

  it('counts real time once when two windows are open', async () => {
    vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0));
    const m = await freshStore();
    const stopA = m.startPracticeTracker(() => true, () => true);
    const stopB = m.startPracticeTracker(() => true, () => false);
    practise(5);
    const secs = today(m)?.activeSeconds ?? 0;
    expect(secs).toBeGreaterThanOrEqual(295);
    expect(secs).toBeLessThanOrEqual(305);
    stopA();
    stopB();
  });

  it('credits the seconds before midnight to the day they happened', async () => {
    seed(['2026-10-06', '2026-10-07']);
    vi.setSystemTime(new Date(2026, 9, 8, 23, 50, 0));
    const m = await freshStore();
    const stop = m.startPracticeTracker(() => true, () => false);
    practise(20); // 23:50 to 00:10 without a break
    const days = m.useStreak.getState().data.days;
    expect(days['2026-10-08'].done).toBe(true);
    expect(days['2026-10-08'].activeSeconds).toBeGreaterThanOrEqual(595);
    expect(days['2026-10-09'].activeSeconds).toBeLessThanOrEqual(605);
    expect(m.useStreak.getState().today).toBe('2026-10-09');
    stop();
  });

  it('credits the seconds before midnight before a trade close can spend a freeze', async () => {
    // Seven practised days bank a freeze; 10-08 is 12 s short of its goal at 23:59:47.
    let d = emptyStreak();
    for (let i = 0; i < 7; i++) d = recordActivity(d, addDays('2026-10-01', i), { activeSeconds: 600 }).data;
    d = recordActivity(d, '2026-10-08', { activeSeconds: 588 }).data;
    localStorage.setItem('stock-replay-streak', JSON.stringify(d));
    vi.setSystemTime(new Date(2026, 9, 8, 23, 59, 47));
    const m = await freshStore();
    const toasts = (await import('./toasts')).useToasts;
    const stop = m.startPracticeTracker(() => true, () => false);
    window.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(10_000); // ticks at 23:59:52 and 23:59:57: 598 s
    vi.advanceTimersByTime(4_000); // 00:00:01, before the next tick
    m.recordTradeClosed();
    const after = m.useStreak.getState().data;
    expect(after.days['2026-10-08'].done).toBe(true);
    expect(after.frozen).toEqual([]);
    expect(after.freezes).toBe(1);
    expect(after.days['2026-10-09'].tradesClosed).toBe(1);
    expect(toasts.getState().toasts.map((t) => t.text).join(' | ')).not.toMatch(/freeze covered/);
    stop();
  });

  it('keeps a milestone reached during playback until it is dismissed, across a reload', async () => {
    seed(['2026-10-06', '2026-10-07']);
    vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0));
    let m = await freshStore();
    let stop = m.startPracticeTracker(() => true, () => true);
    practise(10);
    expect(m.useStreak.getState().data.celebrate).toEqual({ milestone: 3, streak: 3, day: '2026-10-08' });
    stop();
    // The tab is closed before playback pauses.
    m = await freshStore();
    stop = m.startPracticeTracker(() => true, () => false);
    expect(m.useStreak.getState().data.celebrate).toEqual({ milestone: 3, streak: 3, day: '2026-10-08' });
    m.dismissCelebration();
    expect(m.useStreak.getState().data.celebrate).toBeNull();
    expect(JSON.parse(localStorage.getItem('stock-replay-streak')!).celebrate).toBeNull();
    stop();
  });

  it('drops a held milestone when the user comes back after the streak has ended', async () => {
    seed(['2026-10-01', '2026-10-02']);
    vi.setSystemTime(new Date(2026, 9, 3, 12, 0, 0));
    let m = await freshStore();
    let stop = m.startPracticeTracker(() => true, () => true);
    practise(10);
    expect(m.useStreak.getState().data.celebrate).toEqual({ milestone: 3, streak: 3, day: '2026-10-03' });
    stop();
    // Closed during playback; back on 10-06 with 10-04 and 10-05 missed and no freeze.
    vi.setSystemTime(new Date(2026, 9, 6, 9, 0, 0));
    m = await freshStore();
    stop = m.startPracticeTracker(() => true, () => false);
    expect(m.useStreak.getState().data.celebrate).toBeNull();
    expect(JSON.parse(localStorage.getItem('stock-replay-streak')!).celebrate).toBeNull();
    stop();
  });

  it('spends a freeze for a missed day when the app opens', async () => {
    seed(Array.from({ length: 7 }, (_, i) => addDays('2026-10-01', i))); // earns one freeze
    vi.setSystemTime(new Date(2026, 9, 9, 10, 0, 0)); // 10-08 was missed
    const m = await freshStore();
    const stop = m.startPracticeTracker(() => true, () => false);
    const d = m.useStreak.getState().data;
    expect(d.frozen).toEqual(['2026-10-08']);
    expect(d.freezes).toBe(0);
    stop();
  });
});
