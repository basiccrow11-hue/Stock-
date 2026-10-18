/**
 * Blind sessions still running in any open tab. The journal is shared between tabs, so a trade from
 * a blind session in one tab shows up in the others at once, and they must keep its date hidden too.
 * Each tab lists its running blind session (with its start date, for the "Day N" labels) in
 * localStorage and renews it on a heartbeat; it removes it when the session ends or the tab closes.
 * The listing of a tab that died without saying so lapses after a couple of minutes.
 *
 * A blind session saved to carry on later (savedSessions) has not ended when no tab runs it, so its
 * date stays hidden then too. The trading store lists those apart, with no heartbeat, from when it
 * saves one until the session ends, is let go or gives its date back.
 */
import { create } from 'zustand';

const KEY = 'stock-replay-live-blind';
const SAVED_KEY = 'stock-replay-saved-blind';
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

function readSaved(): LiveBlind {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, start]) => typeof start === 'string')) as LiveBlind;
  } catch {
    return {};
  }
}

function writeSaved(saved: LiveBlind): void {
  try {
    if (Object.keys(saved).length) localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
    else localStorage.removeItem(SAVED_KEY);
  } catch {
    // Storage unavailable: the session's dates show once no tab runs it.
  }
}

/** Blind sessions whose date is still hidden: running in any tab, this one included, or saved to carry on later. */
export const useLiveBlind = create<{ sessions: LiveBlind }>(() => ({ sessions: {} }));

/** This tab's running blind session. */
let mine: { id: string; start: string } | null = null;

/** The sessions tabs list as running, without those whose tab stopped renewing them. */
function running(listing = read()): LiveBlind {
  const now = Date.now();
  const sessions: LiveBlind = {};
  for (const [id, e] of Object.entries(listing)) {
    if (e && typeof e.start === 'string' && typeof e.beat === 'number' && now - e.beat < TTL_MS) sessions[id] = e.start;
  }
  return sessions;
}

function refresh(listing = read()): void {
  const sessions: LiveBlind = { ...readSaved(), ...running(listing) };
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

/** Lists saved session `id` as a blind one whose date is still hidden (`start`: its start date), or takes it off (null). */
export function setSavedBlind(id: string, start: string | null): void {
  const saved = readSaved();
  if ((saved[id] ?? null) === start) return;
  if (start === null) delete saved[id];
  else saved[id] = start;
  writeSaved(saved);
  refresh();
}

/**
 * Brings the saved listing in line with the sessions kept, once as the app opens. `kept` reads every
 * one with, for a blind one whose date is still hidden, its start date, and whether a version of the
 * app from before this listing saved it (`older`). A session listed but no longer kept goes, unless a
 * tab runs it (its first save may not have landed yet). One kept but not listed is added only if an
 * older version saved it: this version lists a blind session each time it saves it, so one it saved
 * and no longer lists has ended or given its date back, even if what is stored does not say so yet.
 */
export async function reconcileSavedBlind(kept: () => Promise<{ id: string; start: string | null; older: boolean }[]>): Promise<void> {
  // Read first: a session listed while `kept` is read is not taken for one no longer kept.
  const before = readSaved();
  const all = await kept();
  const ids = new Set(all.map((k) => k.id));
  const saved = readSaved();
  const live = running();
  for (const id of Object.keys(before)) if (!ids.has(id) && !(id in live)) delete saved[id];
  for (const k of all) if (k.start !== null && k.older && !(k.id in before)) saved[k.id] = k.start;
  writeSaved(saved);
  refresh();
}

if (typeof window !== 'undefined') {
  setInterval(beat, BEAT_MS);
  window.addEventListener('storage', (e) => {
    if (e.key === KEY || e.key === SAVED_KEY || e.key === null) refresh();
  });
  // A closing tab takes its session off the list of those running (a saved one stays listed as saved);
  // one restored from the back/forward cache puts it back.
  window.addEventListener('pagehide', () => {
    if (mine) unlist(mine.id);
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) beat();
  });
  refresh();
}
