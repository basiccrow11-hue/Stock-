import { describe, expect, it } from 'vitest';
import {
  addDays,
  calendarWeeks,
  dayKey,
  dayNumber,
  emptyStreak,
  recordActivity,
  sanitizeStreak,
  setGoal,
  settle,
  streakEndingAt,
  streakMessage,
  streakStatus,
  weekday,
  type StreakData,
} from '../streak/streak';

const GOAL = 10 * 60;

/** Practise a full goal on each listed day, in order. */
function practise(data: StreakData, days: string[]): StreakData {
  for (const d of days) data = recordActivity(data, d, { activeSeconds: GOAL }).data;
  return data;
}

function run(start: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addDays(start, i));
}

describe('streak calendar arithmetic', () => {
  it('uses local calendar days and is immune to DST', () => {
    expect(dayKey(new Date(2026, 2, 8, 23, 30))).toBe('2026-03-08');
    // US DST starts 2026-03-08; the day count must still advance by exactly one.
    expect(dayNumber('2026-03-09') - dayNumber('2026-03-08')).toBe(1);
    expect(dayNumber('2026-11-02') - dayNumber('2026-11-01')).toBe(1);
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('knows weekdays', () => {
    expect(weekday('2026-10-08')).toBe(4); // Thursday
    expect(weekday('2026-10-04')).toBe(0); // Sunday
  });
});

describe('daily goal and streak', () => {
  it('completes a day only when the goal is reached', () => {
    let d = emptyStreak();
    let r = recordActivity(d, '2026-10-01', { activeSeconds: 300 });
    expect(r.completedNow).toBe(false);
    expect(r.streak).toBe(0);
    r = recordActivity(r.data, '2026-10-01', { activeSeconds: 299 });
    expect(r.completedNow).toBe(false);
    r = recordActivity(r.data, '2026-10-01', { activeSeconds: 1 });
    expect(r.completedNow).toBe(true);
    expect(r.streak).toBe(1);
    // Completing fires once per day.
    r = recordActivity(r.data, '2026-10-01', { activeSeconds: 600 });
    expect(r.completedNow).toBe(false);
    d = r.data;
    expect(d.days['2026-10-01'].activeSeconds).toBe(1200);
  });

  it('counts consecutive days and resets after a missed day without freezes', () => {
    let d = practise(emptyStreak(), run('2026-10-01', 3));
    expect(streakStatus(d, '2026-10-03').current).toBe(3);
    // Next day, not yet practised: the streak is alive but at risk.
    let s = streakStatus(d, '2026-10-04');
    expect(s.current).toBe(3);
    expect(s.atRisk).toBe(true);
    // Skip 10-04, come back 10-05: streak over (no freezes banked).
    s = streakStatus(settle(d, '2026-10-05').data, '2026-10-05');
    expect(s.current).toBe(0);
    expect(s.previous).toEqual({ length: 3, endedOn: '2026-10-03' });
    d = practise(d, ['2026-10-05']);
    expect(streakStatus(d, '2026-10-05').current).toBe(1);
    expect(streakStatus(d, '2026-10-05').best).toBe(3);
  });

  it('ignores negative or junk deltas', () => {
    const r = recordActivity(emptyStreak(), '2026-10-01', { activeSeconds: -500, tradesClosed: -2, reviews: 1.7 });
    expect(r.data.days['2026-10-01']).toEqual({ activeSeconds: 0, tradesClosed: 0, reviews: 1, done: false });
  });

  it('tracks trades and reviews without letting them complete the day', () => {
    const r = recordActivity(emptyStreak(), '2026-10-01', { tradesClosed: 25, reviews: 3 });
    expect(r.completedNow).toBe(false);
    const s = streakStatus(r.data, '2026-10-01');
    expect(s.todayTrades).toBe(25);
    expect(s.todayReviews).toBe(3);
  });
});

describe('milestones, best and freezes', () => {
  it('reports milestones and new bests once', () => {
    let d = emptyStreak();
    const events: (number | null)[] = [];
    for (const day of run('2026-09-01', 7)) {
      const r = recordActivity(d, day, { activeSeconds: GOAL });
      events.push(r.milestone);
      d = r.data;
    }
    expect(events).toEqual([null, null, 3, null, null, null, 7]);
    expect(d.best).toBe(7);
    // A later, longer streak reports a new best when it passes 7.
    d = settle(d, '2026-09-20').data;
    let newBest = 0;
    for (const day of run('2026-09-20', 8)) {
      const r = recordActivity(d, day, { activeSeconds: GOAL });
      if (r.newBest) newBest = r.streak;
      d = r.data;
    }
    expect(newBest).toBe(8);
  });

  it('earns a freeze every 7 practised days, capped at 2', () => {
    let d = emptyStreak();
    const earned: string[] = [];
    for (const day of run('2026-01-01', 28)) {
      const r = recordActivity(d, day, { activeSeconds: GOAL });
      if (r.earnedFreeze) earned.push(day);
      d = r.data;
    }
    expect(earned).toEqual(['2026-01-07', '2026-01-14']);
    expect(d.freezes).toBe(2);
  });

  it('spends freezes automatically to cover missed days, once', () => {
    let d = practise(emptyStreak(), run('2026-01-01', 7));
    expect(d.freezes).toBe(1);
    // Miss 01-08, open the app on 01-09.
    const first = settle(d, '2026-01-09');
    expect(first.usedFreezes).toEqual(['2026-01-08']);
    expect(first.data.freezes).toBe(0);
    // Idempotent.
    expect(settle(first.data, '2026-01-09').usedFreezes).toEqual([]);
    d = practise(first.data, ['2026-01-09']);
    expect(streakStatus(d, '2026-01-09').current).toBe(9);
    expect(streakEndingAt(d, '2026-01-09')).toBe(9);
  });

  it('does not spend freezes when the gap is longer than the bank', () => {
    let d = practise(emptyStreak(), run('2026-01-01', 14));
    expect(d.freezes).toBe(2);
    const r = settle(d, '2026-01-18'); // missed 15, 16, 17
    expect(r.usedFreezes).toEqual([]);
    expect(r.data.freezes).toBe(2);
    d = practise(r.data, ['2026-01-18']);
    expect(streakStatus(d, '2026-01-18').current).toBe(1);
  });

  it('covers two missed days with two freezes', () => {
    const d = practise(emptyStreak(), run('2026-01-01', 14));
    const r = recordActivity(d, '2026-01-17', { activeSeconds: GOAL });
    expect(r.usedFreezes).toEqual(['2026-01-15', '2026-01-16']);
    expect(r.streak).toBe(17);
  });

  it('does not let frozen days earn more freezes', () => {
    // 6 practised days, a freeze would be needed... build one first.
    let d = practise(emptyStreak(), run('2026-01-01', 7)); // practised 7 -> 1 freeze
    d = practise(d, ['2026-01-09']); // freeze covers 01-08; practised 8 in a 9-day streak
    d = practise(d, run('2026-01-10', 5)); // practised 13
    expect(d.freezes).toBe(0);
    const r = recordActivity(d, '2026-01-15', { activeSeconds: GOAL }); // practised 14 -> earns
    expect(r.earnedFreeze).toBe(true);
    expect(r.streak).toBe(15);
  });
});

describe('goal changes', () => {
  it('never rewrites completed days, and completes today when lowered', () => {
    let d = practise(emptyStreak(), ['2026-10-01']);
    d = setGoal(d, '2026-10-02', 60).data;
    expect(d.days['2026-10-01'].done).toBe(true);
    let r = recordActivity(d, '2026-10-02', { activeSeconds: 6 * 60 });
    expect(r.completedNow).toBe(false);
    r = setGoal(r.data, '2026-10-02', 5);
    expect(r.completedNow).toBe(true);
    expect(r.streak).toBe(2);
  });

  it('clamps the goal', () => {
    expect(setGoal(emptyStreak(), '2026-10-01', 0).data.goalMinutes).toBe(1);
    expect(setGoal(emptyStreak(), '2026-10-01', 10_000).data.goalMinutes).toBe(240);
  });
});

describe('persistence hygiene', () => {
  it('sanitizes stored data', () => {
    const d = sanitizeStreak({
      goalMinutes: 15,
      days: { '2026-10-01': { activeSeconds: 700, tradesClosed: 2, reviews: 'x', done: true }, nope: { activeSeconds: 5 } },
      frozen: ['2026-09-30', 'bad', '2026-09-30'],
      freezes: 9,
      best: -3,
    });
    expect(d.goalMinutes).toBe(15);
    expect(Object.keys(d.days)).toEqual(['2026-10-01']);
    expect(d.days['2026-10-01']).toEqual({ activeSeconds: 700, tradesClosed: 2, reviews: 0, done: true });
    expect(d.frozen).toEqual(['2026-09-30']);
    expect(d.freezes).toBe(2);
    expect(d.best).toBe(0);
    expect(sanitizeStreak(null)).toEqual(emptyStreak());
    expect(sanitizeStreak('garbage')).toEqual(emptyStreak());
  });
});

describe('presentation', () => {
  it('builds a Sunday-first calendar ending at today', () => {
    let d = practise(emptyStreak(), ['2026-10-06', '2026-10-07']);
    d = recordActivity(d, '2026-10-08', { activeSeconds: 120 }).data;
    const weeks = calendarWeeks(d, '2026-10-08', 2);
    expect(weeks).toHaveLength(2);
    expect(weeks[0][0].key).toBe('2026-09-27');
    const last = weeks[1];
    expect(last[0].key).toBe('2026-10-04');
    expect(last[2].state).toBe('done');
    expect(last[3].state).toBe('done');
    expect(last[4].state).toBe('partial');
    expect(last[5].state).toBe('future');
  });

  it('writes encouraging, accurate messages', () => {
    let d = emptyStreak();
    expect(streakMessage(streakStatus(d, '2026-10-01')).title).toBe('Start your streak today');
    d = recordActivity(d, '2026-10-01', { activeSeconds: 240 }).data;
    expect(streakMessage(streakStatus(d, '2026-10-01')).body).toContain('6 more minutes');
    d = practise(d, ['2026-10-01', '2026-10-02']);
    expect(streakMessage(streakStatus(d, '2026-10-02')).title).toBe('Day 2 complete');
    expect(streakMessage(streakStatus(d, '2026-10-02')).body).toContain('Next milestone: 3 days (1 to go)');
    expect(streakMessage(streakStatus(d, '2026-10-03')).title).toBe('Keep your 2-day streak going');
    expect(streakMessage(streakStatus(d, '2026-10-03')).body).toContain('10 more minutes');
    const later = settle(d, '2026-10-06').data;
    const m = streakMessage(streakStatus(later, '2026-10-06'));
    expect(m.title).toBe('Fresh start');
    expect(m.body).toContain('ran 2 days');
  });
});
