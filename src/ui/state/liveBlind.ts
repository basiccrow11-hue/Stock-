/**
 * Blind sessions still running in any open tab. The journal is shared between tabs, so a trade from
 * a blind session in one tab shows up in the others at once, and they must keep its date hidden too.
 * Each tab lists its running blind session (with its start date, for the "Day N" labels) in
 * localStorage and renews it on a heartbeat; it removes it when the session ends or the tab closes.
 * The listing of a tab that died without saying so lapses after a couple of minutes.
 */
import { create } from 'zustand';

const KEY = 'stock-replay-live-blind';
const BEAT_MS = 20_000;
/** Longer than the slowest a background tab's timers run (about once a minute). */
const TTL_MS = 150_000;

/** Session id → its start date (YYYY-MM-DD). */
export type LiveBlind = Record<string, string>;

type Listing = Record<string, { start: string; beat: number }>;

function read(): Listing {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Listing) : {};
  } catch {
    return {};
  }
}

function write(listing: Listing): void {
  try {
    if (Object.keys(listing).length) localStorage.setItem(KEY, JSON.stringify(listing));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: other tabs cannot see this session, this tab still hides its own dates.
  }
}

/** Blind sessions running in any tab, this one included. */
export const useLiveBlind = create<{ sessions: LiveBlind }>(() => ({ sessions: {} }));

/** This tab's running blind session. */
let mine: { id: string; start: string } | null = null;

function refresh(listing = read()): void {
  const now = Date.now();
  const sessions: LiveBlind = {};
  for (const [id, e] of Object.entries(listing)) {
    if (e && typeof e.start === 'string' && typeof e.beat === 'number' && now - e.beat < TTL_MS) sessions[id] = e.start;
  }
  if (mine) sessions[mine.id] = mine.start;
  const cur = useLiveBlind.getState().sessions;
  const same = Object.keys(sessions).length === Object.keys(cur).length && Object.entries(sessions).every(([id, s]) => cur[id] === s);
  if (!same) useLiveBlind.setState({ sessions });
}

/** Renew this tab's listing and drop lapsed ones. */
function beat(): void {
  const listing = read();
  const now = Date.now();
  let changed = false;
  for (const [id, e] of Object.entries(listing)) {
    if (e && typeof e.beat === 'number' && now - e.beat < TTL_MS) continue;
    delete listing[id];
    changed = true;
  }
  if (mine) listing[mine.id] = { start: mine.start, beat: now };
  if (mine || changed) write(listing);
  refresh(listing);
}

function unlist(id: string): void {
  const listing = read();
  if (!(id in listing)) return;
  delete listing[id];
  write(listing);
}

/** Sets this tab's running blind session: its id and start date, or null when none is running. */
export function setLiveBlind(session: { id: string; start: string } | null): void {
  if (mine?.id === session?.id && mine?.start === session?.start) return;
  if (mine) unlist(mine.id);
  mine = session;
  beat();
}

if (typeof window !== 'undefined') {
  setInterval(beat, BEAT_MS);
  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === null) refresh();
  });
  // A closing tab takes its session off the list; one restored from the back/forward cache puts it back.
  window.addEventListener('pagehide', () => {
    if (mine) unlist(mine.id);
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) beat();
  });
  refresh();
}
