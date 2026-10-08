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
