/**
 * Daily practice streak.
 *
 * Pure functions over a small persisted record so the rules can be tested without a browser.
 *
 * Rules (also shown to the user):
 *  - A day counts once you reach your daily goal of active practice minutes. The streak rewards
 *    showing up and practising, never P/L or trade count, so it cannot push you into forcing trades.
 *  - Days are the user's LOCAL calendar days ('YYYY-MM-DD'), not exchange days: the app is for
 *    practice when markets are closed, weekends included.
 *  - Every FREEZE_EVERY-th goal-met day within a running streak earns a streak freeze (at most
 *    MAX_FREEZES banked). Freezes are spent automatically to cover missed days, but only when there
 *    are enough for the whole gap; otherwise the streak ends and the freezes are kept for the next one.
 *  - Frozen days count toward the streak length (and the best streak), not toward earning freezes.
 *  - Changing the goal never rewrites history: a completed day stays completed.
 */

export type DayKey = string;

export interface DayActivity {
  /** Seconds of active practice. */
  activeSeconds: number;
  tradesClosed: number;
  /** Journal entries the user annotated that day. */
  reviews: number;
  /** Set once the day's goal was met; never unset. */
  done: boolean;
}

export interface StreakData {
  version: 1;
  goalMinutes: number;
  days: Record<DayKey, DayActivity>;
  /** Missed days covered by a streak freeze. */
  frozen: DayKey[];
  /** Banked freezes, 0..MAX_FREEZES. */
  freezes: number;
  /** Longest streak ever reached. */
  best: number;
  /**
   * Wall-clock time (ms) up to which practice time has been credited. Two open windows credit the
   * same stretch of real time only once.
   */
  creditedUntil: number;
  /**
   * Milestone waiting to be celebrated. It is kept until the user dismisses it, so a celebration
   * held back during playback is not lost when the tab is closed or reloaded, and dropped once the
   * streak that reached it has ended (see pendingCelebration).
   */
  celebrate: Celebration | null;
}

export interface Celebration {
  milestone: number;
  /** Streak length when it was reached (larger than the milestone when a freeze carried past it). */
  streak: number;
  /** Day the milestone was reached. */
  day: DayKey;
}

export const GOAL_OPTIONS = [5, 10, 15, 20, 30, 45, 60] as const;
export const DEFAULT_GOAL_MINUTES = 10;
export const MAX_FREEZES = 2;
export const FREEZE_EVERY = 7;
export const MILESTONES = [3, 7, 14, 30, 50, 100, 150, 200, 365, 500, 750, 1000] as const;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function emptyStreak(): StreakData {
  return { version: 1, goalMinutes: DEFAULT_GOAL_MINUTES, days: {}, frozen: [], freezes: 0, best: 0, creditedUntil: 0, celebrate: null };
}

function emptyDay(): DayActivity {
  return { activeSeconds: 0, tradesClosed: 0, reviews: 0, done: false };
}

// ------------------------------------------------------------------ calendar arithmetic

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar day of a Date. */
export function dayKey(d: Date): DayKey {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Days since 1970-01-01 for a day key. Uses date-only UTC arithmetic, so DST never skews it. */
export function dayNumber(k: DayKey): number {
  const [y, m, d] = k.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function keyFromNumber(n: number): DayKey {
  const d = new Date(n * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(k: DayKey, n: number): DayKey {
  return keyFromNumber(dayNumber(k) + n);
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekday(k: DayKey): number {
  return (((dayNumber(k) + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
}

// ------------------------------------------------------------------ validation

/** Accepts anything (e.g. parsed localStorage) and returns well-formed data, dropping junk. */
export function sanitizeStreak(raw: unknown): StreakData {
  const out = emptyStreak();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<StreakData>;
  const nonNeg = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  if (typeof r.goalMinutes === 'number' && r.goalMinutes >= 1 && r.goalMinutes <= 240) out.goalMinutes = Math.round(r.goalMinutes);
  if (r.days && typeof r.days === 'object') {
    for (const [k, v] of Object.entries(r.days)) {
      if (!DAY_RE.test(k) || !v || typeof v !== 'object') continue;
      out.days[k] = {
        activeSeconds: nonNeg(v.activeSeconds),
        tradesClosed: Math.floor(nonNeg(v.tradesClosed)),
        reviews: Math.floor(nonNeg(v.reviews)),
        done: v.done === true,
      };
    }
  }
  if (Array.isArray(r.frozen)) out.frozen = [...new Set(r.frozen.filter((k): k is string => typeof k === 'string' && DAY_RE.test(k)))].sort();
  out.freezes = Math.min(MAX_FREEZES, Math.floor(nonNeg(r.freezes)));
  out.best = Math.floor(nonNeg(r.best));
  out.creditedUntil = nonNeg(r.creditedUntil);
  const c = r.celebrate;
  if (c && typeof c === 'object' && (MILESTONES as readonly number[]).includes(c.milestone) && Number.isInteger(c.streak) && c.streak >= c.milestone && typeof c.day === 'string' && DAY_RE.test(c.day))
    out.celebrate = { milestone: c.milestone, streak: c.streak, day: c.day };
  return out;
}

// ------------------------------------------------------------------ queries

export function isCovered(data: StreakData, k: DayKey, frozen = new Set(data.frozen)): boolean {
  return data.days[k]?.done === true || frozen.has(k);
}

/** Consecutive covered days ending at `k` (inclusive). */
export function streakEndingAt(data: StreakData, k: DayKey): number {
  const frozen = new Set(data.frozen);
  let n = 0;
  let d = dayNumber(k);
  while (isCovered(data, keyFromNumber(d), frozen)) {
    n++;
    d--;
  }
  return n;
}

/** Days that actually met the goal within the streak ending at `k` (freezes excluded). */
function practisedDaysEndingAt(data: StreakData, k: DayKey): number {
  const frozen = new Set(data.frozen);
  let n = 0;
  let d = dayNumber(k);
  for (let key = keyFromNumber(d); isCovered(data, key, frozen); key = keyFromNumber(--d)) if (data.days[key]?.done) n++;
  return n;
}

/** Most recent covered day strictly before `before`, or null. */
function lastCoveredBefore(data: StreakData, before: DayKey): DayKey | null {
  const limit = dayNumber(before);
  let best: number | null = null;
  for (const [k, v] of Object.entries(data.days)) {
    if (!v.done) continue;
    const n = dayNumber(k);
    if (n < limit && (best === null || n > best)) best = n;
  }
  for (const k of data.frozen) {
    const n = dayNumber(k);
    if (n < limit && (best === null || n > best)) best = n;
  }
  return best === null ? null : keyFromNumber(best);
}

export interface StreakStatus {
  today: DayKey;
  /** Current streak: includes today once today's goal is met, otherwise ends yesterday. */
  current: number;
  best: number;
  todayDone: boolean;
  todaySeconds: number;
  todayTrades: number;
  todayReviews: number;
  goalSeconds: number;
  /** A streak is running but today's goal is not met yet. */
  atRisk: boolean;
  freezes: number;
  /** Yesterday was covered by a freeze rather than practice. */
  frozenYesterday: boolean;
  nextMilestone: number | null;
  /** When there is no current streak: the last one that ended, if any. */
  previous: { length: number; endedOn: DayKey } | null;
}

export function streakStatus(data: StreakData, today: DayKey): StreakStatus {
  const t = data.days[today] ?? emptyDay();
  const yesterday = addDays(today, -1);
  const current = t.done ? streakEndingAt(data, today) : streakEndingAt(data, yesterday);
  let previous: StreakStatus['previous'] = null;
  if (current === 0) {
    const last = lastCoveredBefore(data, today);
    if (last) previous = { length: streakEndingAt(data, last), endedOn: last };
  }
  return {
    today,
    current,
    best: Math.max(data.best, current),
    todayDone: t.done,
    todaySeconds: t.activeSeconds,
    todayTrades: t.tradesClosed,
    todayReviews: t.reviews,
    goalSeconds: data.goalMinutes * 60,
    atRisk: !t.done && current > 0,
    freezes: data.freezes,
    frozenYesterday: data.frozen.includes(yesterday),
    nextMilestone: MILESTONES.find((m) => m > current) ?? null,
    previous,
  };
}

/**
 * The milestone still worth celebrating, or null. A celebration belongs to the streak that reached
 * it: once that streak has ended (a missed day with no freeze), congratulating the user on it would
 * contradict the "Fresh start" shown everywhere else. Only this check hides a stale one; the stored
 * record is left as it is, so a clock or time zone that moves back and forth never loses a
 * celebration. The next milestone or a dismissal replaces it.
 */
export function pendingCelebration(data: StreakData, today: DayKey): Celebration | null {
  const c = data.celebrate;
  if (!c) return null;
  const end = data.days[today]?.done ? today : addDays(today, -1);
  const reached = dayNumber(c.day);
  // The current run covers the days after end - length, up to end.
  return reached <= dayNumber(end) && reached > dayNumber(end) - streakEndingAt(data, end) ? c : null;
}

// ------------------------------------------------------------------ transitions

export interface SettleResult {
  data: StreakData;
  /** Days a freeze was just spent on (oldest first). */
  usedFreezes: DayKey[];
}

/**
 * Cover missed days between the last covered day and today with banked freezes, if there are
 * enough. Idempotent: calling it again the same day changes nothing.
 */
export function settle(data: StreakData, today: DayKey): SettleResult {
  const last = lastCoveredBefore(data, today);
  if (!last) return { data, usedFreezes: [] };
  const gap = dayNumber(today) - dayNumber(last) - 1;
  if (gap <= 0 || gap > data.freezes) return { data, usedFreezes: [] };
  const used: DayKey[] = [];
  for (let i = 1; i <= gap; i++) used.push(addDays(last, i));
  const covered: StreakData = { ...data, freezes: data.freezes - gap, frozen: [...data.frozen, ...used].sort() };
  // Frozen days lengthen the streak, so they can set a new best too.
  return { data: { ...covered, best: Math.max(covered.best, streakEndingAt(covered, addDays(today, -1))) }, usedFreezes: used };
}

/** Streak length at the most recent goal-met day before `k` within the run that reaches `k`, or 0. */
function streakAtPreviousPractice(data: StreakData, k: DayKey): number {
  const frozen = new Set(data.frozen);
  for (let d = dayNumber(k) - 1; ; d--) {
    const key = keyFromNumber(d);
    if (!isCovered(data, key, frozen)) return 0;
    if (data.days[key]?.done) return streakEndingAt(data, key);
  }
}

export interface ActivityDelta {
  activeSeconds?: number;
  tradesClosed?: number;
  reviews?: number;
  /**
   * Wall-clock time (ms) at the end of the practice being credited. When given, only time after
   * `creditedUntil` counts, so overlapping credits from two windows are not added twice.
   */
  at?: number;
}

/** A clock step back larger than this is treated as a clock change, not as overlapping windows. */
const CLOCK_STEP_MS = 60_000;

export interface RecordResult extends SettleResult {
  /** Today's goal was met by this update. */
  completedNow: boolean;
  /** Streak length after this update. */
  streak: number;
  /** Set when completing today reached a milestone. */
  milestone: number | null;
  newBest: boolean;
  earnedFreeze: boolean;
  /** The day had been covered by a freeze, then its goal was met after all: the freeze is returned. */
  refundedFreeze: boolean;
}

/** Add activity to today (settling missed days first) and evaluate the goal. */
export function recordActivity(input: StreakData, today: DayKey, delta: ActivityDelta): RecordResult {
  const { data: settled0, usedFreezes } = settle(input, today);
  let settled = settled0;
  let seconds = Math.max(0, delta.activeSeconds ?? 0);
  if (delta.at !== undefined && seconds > 0) {
    const until = settled.creditedUntil;
    // Count only the part of this stretch no other window has credited yet. If the clock jumped
    // back (a manual change), start over from the new time instead of refusing credit for that long.
    if (delta.at >= until - CLOCK_STEP_MS) seconds = Math.min(seconds, Math.max(0, (delta.at - until) / 1000));
    settled = { ...settled, creditedUntil: delta.at < until - CLOCK_STEP_MS ? delta.at : Math.max(until, delta.at) };
  }
  const prev = settled.days[today] ?? emptyDay();
  const day: DayActivity = {
    activeSeconds: prev.activeSeconds + seconds,
    tradesClosed: prev.tradesClosed + Math.max(0, Math.floor(delta.tradesClosed ?? 0)),
    reviews: prev.reviews + Math.max(0, Math.floor(delta.reviews ?? 0)),
    done: prev.done,
  };
  const completedNow = !day.done && day.activeSeconds >= settled.goalMinutes * 60;
  if (completedNow) day.done = true;
  let data: StreakData = { ...settled, days: { ...settled.days, [today]: day } };
  const streak = day.done ? streakEndingAt(data, today) : streakEndingAt(data, addDays(today, -1));
  let milestone: number | null = null;
  let newBest = false;
  let earnedFreeze = false;
  let refundedFreeze = false;
  if (completedNow && data.frozen.includes(today)) {
    // Practice credited late (the seconds just before midnight, or another window) completed a day
    // that a freeze had already covered. The day counts as practised and the freeze goes back.
    refundedFreeze = true;
    data = { ...data, frozen: data.frozen.filter((k) => k !== today), freezes: Math.min(MAX_FREEZES, data.freezes + 1) };
  }
  if (completedNow) {
    // A freeze can carry the count past a milestone between two practice days (13 practised, day 14
    // frozen, day 15 practised): celebrate the highest milestone passed since the last practice.
    const before = streakAtPreviousPractice(data, today);
    milestone = [...MILESTONES].reverse().find((m) => m > before && m <= streak) ?? null;
    newBest = streak > data.best && data.best > 0;
    // Freezes are earned by practice, not by other freezes: count only days that met the goal.
    const practised = practisedDaysEndingAt(data, today);
    if (practised > 0 && practised % FREEZE_EVERY === 0 && data.freezes < MAX_FREEZES) {
      earnedFreeze = true;
      data = { ...data, freezes: data.freezes + 1 };
    }
    data = { ...data, best: Math.max(data.best, streak) };
    if (milestone) data = { ...data, celebrate: { milestone, streak, day: today } };
  }
  return { data, usedFreezes, completedNow, streak, milestone, newBest, earnedFreeze, refundedFreeze };
}

/** Change the daily goal. If today's practice already meets the new goal, today completes. */
export function setGoal(data: StreakData, today: DayKey, minutes: number): RecordResult {
  const goalMinutes = Math.min(240, Math.max(1, Math.round(minutes)));
  return recordActivity({ ...data, goalMinutes }, today, {});
}

// ------------------------------------------------------------------ presentation helpers

export type CellState = 'done' | 'frozen' | 'partial' | 'none' | 'future';

export interface CalendarCell {
  key: DayKey;
  state: CellState;
  seconds: number;
}

/**
 * The last `weeks` weeks as columns of 7 days (Sunday first), ending with the week that contains
 * `today`. Days after today are 'future'.
 */
export function calendarWeeks(data: StreakData, today: DayKey, weeks: number): CalendarCell[][] {
  const frozen = new Set(data.frozen);
  const end = dayNumber(today);
  const start = end - weekday(today) - (weeks - 1) * 7;
  const out: CalendarCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: CalendarCell[] = [];
    for (let d = 0; d < 7; d++) {
      const n = start + w * 7 + d;
      const key = keyFromNumber(n);
      const a = data.days[key];
      const state: CellState = n > end ? 'future' : a?.done ? 'done' : frozen.has(key) ? 'frozen' : a && a.activeSeconds >= 60 ? 'partial' : 'none';
      col.push({ key, state, seconds: a?.activeSeconds ?? 0 });
    }
    out.push(col);
  }
  return out;
}

const MILESTONE_LINES: Record<number, string> = {
  3: 'Three days in a row. This is how habits start.',
  7: 'A full week of practice. Consistency is the edge most traders never build.',
  14: 'Two weeks straight. Reps like these are what make execution automatic.',
  30: 'A month of daily practice. Very few people stick with anything this long.',
  50: 'Fifty days. Your process is becoming a habit.',
  100: 'One hundred days. That is serious, deliberate practice.',
};

export function milestoneLine(n: number): string {
  return MILESTONE_LINES[n] ?? `${n} days in a row. Keep stacking reps.`;
}

/** Celebration text. When a freeze carried the streak past the milestone, say so instead of misstating the length. */
export function celebrationLine(c: Celebration): string {
  return c.streak === c.milestone ? milestoneLine(c.milestone) : `You passed the ${c.milestone}-day mark, with a streak freeze covering a missed day. ${milestoneLine(c.milestone)}`;
}

export function minutesText(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m} min`;
}

/** Headline and one supporting line for the current state. Encouraging, never about P/L. */
export function streakMessage(s: StreakStatus): { title: string; body: string } {
  const left = Math.max(1, Math.ceil((s.goalSeconds - s.todaySeconds) / 60));
  const goalMin = Math.round(s.goalSeconds / 60);
  if (s.todayDone) {
    const next = s.nextMilestone;
    return {
      title: `Day ${s.current} complete`,
      body: next ? `Come back tomorrow to make it ${s.current + 1}. Next milestone: ${next} days (${next - s.current} to go).` : `Come back tomorrow to make it ${s.current + 1}.`,
    };
  }
  if (s.current > 0) {
    const saved = s.frozenYesterday ? ' A streak freeze covered yesterday.' : '';
    return {
      title: `Keep your ${s.current}-day streak going`,
      body: `${left} more minute${left === 1 ? '' : 's'} of practice today makes it ${s.current + 1}.${saved}`,
    };
  }
  if (s.previous) {
    return {
      title: 'Fresh start',
      body: `Your last streak ran ${s.previous.length} day${s.previous.length === 1 ? '' : 's'}${s.best > s.previous.length ? ` (best: ${s.best})` : ''}. Practise ${s.todaySeconds > 0 ? `${left} more minute${left === 1 ? '' : 's'}` : `${goalMin} minutes`} today to start a new one.`,
    };
  }
  return {
    title: 'Start your streak today',
    body: `Practise ${s.todaySeconds > 0 ? `${left} more minute${left === 1 ? '' : 's'}` : `${goalMin} minutes`} today to light day 1.`,
  };
}
