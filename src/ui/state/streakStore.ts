/**
 * Daily practice streak: persistence, the active-time tracker and user-facing events.
 *
 * Rules live in core/streak/streak.ts. Storage is read-modify-write on every change (not a cached
 * copy) so two open tabs do not overwrite each other's progress. If storage is blocked or full, the
 * streak keeps working in memory for the rest of the session.
 */
import { create } from 'zustand';
import {
  MAX_FREEZES,
  dayKey,
  emptyStreak,
  recordActivity,
  sanitizeStreak,
  setGoal,
  settle,
  streakStatus,
  type ActivityDelta,
  type DayKey,
  type RecordResult,
  type StreakData,
} from '../../core/streak/streak';
import { toast } from './toasts';

const KEY = 'stock-replay-streak';

/** Seconds without input after which the user counts as idle. */
const IDLE_SECONDS = 90;
/** A playing replay keeps counting this long after the last input (watching tape is practice). */
const WATCHING_SECONDS = 600;
const TICK_MS = 5_000;

/** False once localStorage refused a read or write; from then on `memory` is the source of truth. */
let storageOk = true;
let memory: StreakData | null = null;

function load(): StreakData {
  if (storageOk) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch {
      storageOk = false;
    }
    if (storageOk) {
      try {
        return raw ? sanitizeStreak(JSON.parse(raw)) : emptyStreak();
      } catch {
        return emptyStreak(); // damaged record: start clean rather than crash
      }
    }
  }
  return memory ?? emptyStreak();
}

function save(d: StreakData): void {
  memory = d;
  if (!storageOk) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    // Full or blocked. Reading the stale stored copy back would undo progress, so stop using it.
    storageOk = false;
  }
}

/** Test hook: forget the in-memory fallback. */
export function resetStreakStorageForTests(): void {
  storageOk = true;
  memory = null;
}

interface StreakStore {
  data: StreakData;
  today: DayKey;
  panelOpen: boolean;
}

export const useStreak = create<StreakStore>()(() => ({
  data: load(),
  today: dayKey(new Date()),
  panelOpen: false,
}));

/**
 * Credits the running tracker's not-yet-counted seconds. Called before any other change on a new
 * day, so the seconds just before midnight reach yesterday before a freeze is spent on it.
 */
let flushTracker: (() => void) | null = null;

function fmtDay(k: DayKey): string {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function announceFreezes(used: DayKey[], streak: number): void {
  if (!used.length) return;
  const days = used.map(fmtDay).join(' and ');
  const what = used.length === 1 ? 'A streak freeze' : `${used.length} streak freezes`;
  toast('info', `${what} covered ${days}. Your ${streak}-day streak is safe.`, 8000);
}

function announce(r: RecordResult): void {
  announceFreezes(r.usedFreezes, r.streak);
  if (!r.completedNow) return;
  // A milestone gets the celebration dialog (StreakCelebration) instead of the goal toast.
  if (!r.milestone) toast('success', `Daily goal reached. ${r.streak}-day streak${r.newBest ? ', a new personal best' : ''}. See you tomorrow.`, 6000);
  if (r.refundedFreeze) toast('info', `That day's goal was met after all, so its streak freeze is back (${r.data.freezes} of ${MAX_FREEZES} banked).`, 8000);
  else if (r.earnedFreeze) toast('info', `You earned a streak freeze (${r.data.freezes} of ${MAX_FREEZES} banked). It covers a missed day automatically.`, 8000);
}

function commit(fn: (d: StreakData, today: DayKey) => RecordResult, day: DayKey = dayKey(new Date())): void {
  const r = fn(load(), day);
  save(r.data);
  useStreak.setState({ data: r.data, today: dayKey(new Date()) });
  announce(r);
}

/** Add activity to today, or to `day` (used for the seconds just before midnight). */
export function recordPractice(delta: ActivityDelta, day?: DayKey): void {
  commit((d, k) => recordActivity(d, k, delta), day);
}

export function recordTradeClosed(): void {
  flushTracker?.();
  recordPractice({ tradesClosed: 1 });
}

export function recordReview(): void {
  flushTracker?.();
  recordPractice({ reviews: 1 });
}

export function setStreakGoal(minutes: number): void {
  flushTracker?.();
  commit((d, today) => setGoal(d, today, minutes));
}

export function openStreakPanel(open = true): void {
  useStreak.setState({ panelOpen: open });
}

/** Clear the pending milestone (in every open window, through storage). */
export function dismissCelebration(): void {
  const d = { ...load(), celebrate: null };
  save(d);
  useStreak.setState({ data: d });
}

/** Spend freezes for missed days and roll the calendar over (on load and at midnight). */
function settleNow(): void {
  const today = dayKey(new Date());
  const before = load();
  const r = settle(before, today);
  if (r.data !== before) save(r.data);
  if (r.usedFreezes.length) announceFreezes(r.usedFreezes, streakStatus(r.data, today).current);
  useStreak.setState({ data: r.data, today });
}

/** Local midnight at the start of the day containing `ms`. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Count active practice time. A tick counts when the tab is in front, the current screen counts
 * (`counting()`), and the user was active in the last 90 s, or a replay is playing and they were
 * active in the last 10 minutes. Returns a cleanup function.
 *
 * Idle time and tick length are measured on the monotonic clock (performance.now), so changing the
 * system clock cannot turn idle time into practice. Wall-clock time is only used for the calendar day
 * and for not double-counting time across windows.
 */
export function startPracticeTracker(counting: () => boolean, playing: () => boolean): () => void {
  let lastInput = performance.now();
  let lastTick = performance.now();
  let lastWall = Date.now();
  const onInput = () => {
    lastInput = performance.now();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      // Time spent hidden never counts; pick up changes another tab made.
      lastTick = performance.now();
      lastWall = Date.now();
      settleNow();
    }
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) useStreak.setState({ data: load() });
  };
  const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
  for (const ev of events) window.addEventListener(ev, onInput, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('storage', onStorage);

  settleNow();
  const tick = () => {
    const now = performance.now();
    const wall = Date.now();
    // Cap a tick's credit so a sleeping laptop or a throttled timer cannot add a burst of time.
    const dt = Math.min(now - lastTick, TICK_MS * 2) / 1000;
    const prevWall = lastWall;
    lastTick = now;
    lastWall = wall;
    const active =
      document.visibilityState === 'visible' && counting() && (now - lastInput < IDLE_SECONDS * 1000 || (playing() && now - lastInput < WATCHING_SECONDS * 1000));
    const midnight = startOfDay(wall);
    if (active && dt > 0 && prevWall < midnight && wall - prevWall < 60_000) {
      // The tick spans midnight: the seconds before it belong to yesterday, which may still need them.
      const before = Math.min(dt, (midnight - prevWall) / 1000);
      recordPractice({ activeSeconds: before, at: midnight }, dayKey(new Date(midnight - 1)));
      settleNow();
      if (dt - before > 0) recordPractice({ activeSeconds: dt - before, at: wall });
      return;
    }
    if (dayKey(new Date(wall)) !== useStreak.getState().today) settleNow();
    if (active && dt > 0) recordPractice({ activeSeconds: dt, at: wall });
  };
  const timer = setInterval(tick, TICK_MS);
  // Only a change on a new day needs the pending seconds first; flushing more often is harmless.
  const flush = () => {
    if (dayKey(new Date()) !== useStreak.getState().today) tick();
  };
  flushTracker = flush;

  return () => {
    clearInterval(timer);
    if (flushTracker === flush) flushTracker = null;
    for (const ev of events) window.removeEventListener(ev, onInput);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('storage', onStorage);
  };
}
