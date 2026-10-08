import { describe, expect, it } from 'vitest';
import {
  addDays,
  calendarWeeks,
  celebrationLine,
  dayKey,
  dayNumber,
  emptyStreak,
  pendingCelebration,
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
    const r = recordActivity(emptyStreak(), '2026-10-01', { activeSeconds: -500, tradesClosed: -2.5 });
    expect(r.data.days['2026-10-01']).toEqual({ activeSeconds: 0, tradesClosed: 0, done: false });
  });

  it('tracks trades without letting them complete the day', () => {
    const r = recordActivity(emptyStreak(), '2026-10-01', { tradesClosed: 25 });
    expect(r.completedNow).toBe(false);
    expect(streakStatus(r.data, '2026-10-01').todayTrades).toBe(25);
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

describe('milestones and bests across freezes', () => {
  it('celebrates a milestone that a freeze carried the count past', () => {
    // 13 practised days and a freeze banked; day 14 is missed and frozen; day 15 is practised.
    const d = practise(emptyStreak(), run('2026-01-01', 13));
    expect(d.freezes).toBe(1);
    const r = recordActivity(d, '2026-01-15', { activeSeconds: GOAL });
    expect(r.usedFreezes).toEqual(['2026-01-14']);
    expect(r.streak).toBe(15);
    expect(r.milestone).toBe(14);
    // The celebration states the real streak and explains the freeze, rather than claiming 14.
    expect(r.data.celebrate).toEqual({ milestone: 14, streak: 15, day: '2026-01-15' });
    expect(celebrationLine(r.data.celebrate!)).toMatch(/^You passed the 14-day mark/);
    expect(celebrationLine({ milestone: 7, streak: 7, day: '2026-01-07' })).not.toMatch(/passed/);
  });

  it('keeps a milestone waiting until it is dismissed, including across a reload', () => {
    const d = practise(emptyStreak(), run('2026-01-01', 3));
    const c = { milestone: 3, streak: 3, day: '2026-01-03' };
    expect(d.celebrate).toEqual(c);
    expect(sanitizeStreak(JSON.parse(JSON.stringify(d))).celebrate).toEqual(c);
    // Junk is dropped, and so is a celebration without the day it belongs to.
    expect(sanitizeStreak({ ...d, celebrate: { milestone: 4, streak: 4, day: '2026-01-04' } }).celebrate).toBeNull();
    expect(sanitizeStreak({ ...d, celebrate: { milestone: 7, streak: 5, day: '2026-01-05' } }).celebrate).toBeNull();
    expect(sanitizeStreak({ ...d, celebrate: { milestone: 3, streak: 3 } }).celebrate).toBeNull();
    expect(sanitizeStreak({ ...d, celebrate: { milestone: 3, streak: 3, day: 'yesterday' } }).celebrate).toBeNull();
  });

  it('keeps a milestone while its streak runs and hides it once the streak has ended', () => {
    const d = practise(emptyStreak(), run('2026-01-01', 3));
    // Same day, the next day (not practised yet) and after practising that day: still running.
    expect(pendingCelebration(d, '2026-01-03')).toEqual(d.celebrate);
    expect(pendingCelebration(d, '2026-01-04')).toEqual(d.celebrate);
    expect(pendingCelebration(practise(d, ['2026-01-04']), '2026-01-04')).toEqual(d.celebrate);
    // A missed day with no freeze ends the streak: nothing to celebrate.
    expect(pendingCelebration(d, '2026-01-05')).toBeNull();
    expect(pendingCelebration(settle(d, '2026-01-05').data, '2026-01-05')).toBeNull();
    // A new streak practised afterwards does not revive the old celebration.
    expect(pendingCelebration(practise(d, ['2026-01-06']), '2026-01-06')).toBeNull();
    // A freeze that covers the gap keeps the streak, and the celebration, alive.
    const banked = { ...d, freezes: 1 };
    expect(settle(banked, '2026-01-05').data.celebrate).toEqual(d.celebrate);
    expect(pendingCelebration(settle(banked, '2026-01-05').data, '2026-01-05')).toEqual(d.celebrate);
    // A clock set back before the milestone day shows nothing, and loses nothing once it is right again.
    expect(pendingCelebration(d, '2026-01-02')).toBeNull();
    expect(pendingCelebration(settle(d, '2026-01-02').data, '2026-01-03')).toEqual(d.celebrate);
    // No missed days to cover: settle returns the same data, so nothing is saved.
    expect(settle(d, '2026-01-04').data).toBe(d);
  });

  it('returns a freeze when late practice completes the day it covered', () => {
    // 7 practised days earn a freeze. 10-08 has 588 s when midnight passes; a trade closed at 00:00:01
    // settles 10-09 first and spends the freeze on 10-08. Then the pre-midnight seconds arrive.
    let d = practise(emptyStreak(), run('2026-10-01', 7));
    d = recordActivity(d, '2026-10-08', { activeSeconds: 588 }).data;
    d = recordActivity(d, '2026-10-09', { tradesClosed: 1 }).data;
    expect(d.frozen).toEqual(['2026-10-08']);
    expect(d.freezes).toBe(0);
    const r = recordActivity(d, '2026-10-08', { activeSeconds: 13 });
    expect(r.completedNow).toBe(true);
    expect(r.refundedFreeze).toBe(true);
    expect(r.data.frozen).toEqual([]);
    expect(r.data.freezes).toBe(1);
    expect(streakStatus(r.data, '2026-10-09').frozenYesterday).toBe(false);
    expect(streakStatus(r.data, '2026-10-09').current).toBe(8);
  });

  it('does not repeat a milestone already celebrated', () => {
    const d = practise(emptyStreak(), run('2026-01-01', 14));
    const r = recordActivity(d, '2026-01-16', { activeSeconds: GOAL }); // 01-15 frozen
    expect(r.streak).toBe(16);
    expect(r.milestone).toBeNull();
  });

  it('counts frozen days toward the best streak, so it never drops after the streak ends', () => {
    const d = practise(emptyStreak(), run('2026-01-01', 14)); // best 14, two freezes
    const settled = settle(d, '2026-01-17').data; // 01-15 and 01-16 frozen
    expect(settled.best).toBe(16);
    // The streak ends on 01-18 (01-17 missed, no freezes left): best stays 16.
    const s = streakStatus(settled, '2026-01-18');
    expect(s.current).toBe(0);
    expect(s.best).toBe(16);
    expect(s.previous?.length).toBe(16);
  });
});

describe('time credit across windows', () => {
  const at = Date.UTC(2026, 9, 8, 12, 0, 0);
  it('credits overlapping stretches once', () => {
    let d = recordActivity(emptyStreak(), '2026-10-08', { activeSeconds: 5, at }).data;
    // Another window reports a 5 s tick ending 2 s later: only 2 s are new.
    d = recordActivity(d, '2026-10-08', { activeSeconds: 5, at: at + 2_000 }).data;
    expect(d.days['2026-10-08'].activeSeconds).toBe(7);
    expect(d.creditedUntil).toBe(at + 2_000);
  });

  it('starts over after the clock is set back', () => {
    let d = recordActivity(emptyStreak(), '2026-10-08', { activeSeconds: 5, at }).data;
    d = recordActivity(d, '2026-10-08', { activeSeconds: 5, at: at - 3_600_000 }).data;
    expect(d.days['2026-10-08'].activeSeconds).toBe(10);
    expect(d.creditedUntil).toBe(at - 3_600_000);
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
    expect(d.days['2026-10-01']).toEqual({ activeSeconds: 700, tradesClosed: 2, done: true });
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
