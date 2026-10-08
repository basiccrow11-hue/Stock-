/**
 * Daily practice streak: persistence, the active-time tracker and user-facing events.
 *
 * Rules live in core/streak/streak.ts. Storage is read-modify-write on every change (not a cached
 * copy) so two open tabs do not overwrite each other's progress.
 */
import { create } from 'zustand';
import {
  dayKey,
  emptyStreak,
  milestoneLine,
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

function load(): StreakData {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? sanitizeStreak(JSON.parse(raw)) : emptyStreak();
  } catch {
    return emptyStreak();
  }
}

function save(d: StreakData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* storage full or blocked: the streak keeps working in memory for this session */
  }
}

interface StreakStore {
  data: StreakData;
  today: DayKey;
  panelOpen: boolean;
  /** Milestone to celebrate (shown once, then cleared). */
  celebrate: { streak: number; line: string } | null;
}

export const useStreak = create<StreakStore>()(() => ({
  data: load(),
  today: dayKey(new Date()),
  panelOpen: false,
  celebrate: null,
}));

function fmtDay(k: DayKey): string {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function announceFreezes(used: DayKey[], streak: number): void {
  if (!used.length) return;
  const days = used.map(fmtDay).join(' and ');
  toast('info', `A streak freeze covered ${days}. Your ${streak}-day streak is safe.`, 8000);
}

function announce(r: RecordResult): void {
  announceFreezes(r.usedFreezes, r.streak);
  if (!r.completedNow) return;
  if (r.milestone) useStreak.setState({ celebrate: { streak: r.milestone, line: milestoneLine(r.milestone) } });
  else toast('success', `Daily goal reached. ${r.streak}-day streak${r.newBest ? ', a new personal best' : ''}. See you tomorrow.`, 6000);
  if (r.earnedFreeze) toast('info', `You earned a streak freeze (${r.data.freezes} banked). It covers a missed day automatically.`, 8000);
}

function commit(fn: (d: StreakData, today: DayKey) => RecordResult): void {
  const today = dayKey(new Date());
  const r = fn(load(), today);
  save(r.data);
  useStreak.setState({ data: r.data, today });
  announce(r);
}

export function recordPractice(delta: ActivityDelta): void {
  commit((d, today) => recordActivity(d, today, delta));
}

export function recordTradeClosed(): void {
  recordPractice({ tradesClosed: 1 });
}

export function recordReview(): void {
  recordPractice({ reviews: 1 });
}

export function setStreakGoal(minutes: number): void {
  commit((d, today) => setGoal(d, today, minutes));
}

export function openStreakPanel(open = true): void {
  useStreak.setState({ panelOpen: open });
}

export function dismissCelebration(): void {
  useStreak.setState({ celebrate: null });
}

/** Spend freezes for missed days and roll the calendar over (on load and at midnight). */
function settleNow(): void {
  const today = dayKey(new Date());
  const r = settle(load(), today);
  if (r.usedFreezes.length) {
    save(r.data);
    announceFreezes(r.usedFreezes, streakStatus(r.data, today).current);
  }
  useStreak.setState({ data: r.data, today });
}

/**
 * Count active practice time. A tick counts when the tab is in front, the current screen counts
 * (`counting()`), and the user was active in the last 90 s, or a replay is playing and they were
 * active in the last 10 minutes. Returns a cleanup function.
 */
export function startPracticeTracker(counting: () => boolean, playing: () => boolean): () => void {
  let lastInput = Date.now();
  let lastTick = Date.now();
  const onInput = () => {
    lastInput = Date.now();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      // Time spent hidden never counts; pick up changes another tab made.
      lastTick = Date.now();
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
  const timer = setInterval(() => {
    const now = Date.now();
    // Cap a tick's credit so a sleeping laptop or a throttled timer cannot add a burst of time.
    const dt = Math.min(now - lastTick, TICK_MS * 2) / 1000;
    lastTick = now;
    if (dayKey(new Date()) !== useStreak.getState().today) settleNow();
    if (document.visibilityState !== 'visible' || !counting()) return;
    const idle = (now - lastInput) / 1000;
    if (idle < IDLE_SECONDS || (playing() && idle < WATCHING_SECONDS)) recordPractice({ activeSeconds: dt });
  }, TICK_MS);

  return () => {
    clearInterval(timer);
    for (const ev of events) window.removeEventListener(ev, onInput);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('storage', onStorage);
  };
}
