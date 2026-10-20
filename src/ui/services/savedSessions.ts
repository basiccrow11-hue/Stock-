/**
 * Unfinished sessions, kept in this browser so a reload, a closed tab or a crash does not lose one:
 * the trading store saves the running session as it goes and can carry one on later from where it
 * was (tradingStore's resumeSession).
 *
 * The whole session is saved after anything its bars alone would not bring back (an order, a cancel,
 * a rewind, a settings change, a journal entry written) and every half minute while it plays. Where
 * its clock has got to since is noted at once, in localStorage, which a closing page still writes, so
 * carrying on goes forward from the last whole save to that point as Play went: no bar already seen
 * is hidden again and dealt out as if new.
 *
 * A tab holds a lock (Web Locks) on the session it runs, so a session running in another tab is not
 * offered and two tabs cannot both carry on the same one. A tab that closes, reloads or crashes lets
 * go of its lock. A browser without Web Locks keeps sessions too, but cannot tell one running in
 * another tab.
 */
import { idb } from './idb';
import type { SessionMeta } from '../state/tradingStore';
import type { ChallengeAttempt } from '../state/challengeStore';
import type { Timeframe, UnixSeconds } from '../../core/types';
import type { Checkpoint, SavedReplay } from '../../core/replay/ReplaySession';
import type { SimMarketSnapshot } from '../../core/sim/SimMarket';
import type { BrokerCheckpoint, BrokerEvent, BrokerState } from '../../core/broker/SimBroker';
import type { ExecutionConfig } from '../../core/broker/config';
import type { TradingRules } from '../../core/learning/review';
import { newId } from '../../core/util/ids';

/**
 * The version of the sessions this app saves. Version 2 stores the checkpoints' logs apart from them
 * (StoredCheckpoint): an app that reads only version 1 would carry such a session on but could not
 * rewind it, and refuses it instead. Sessions saved as version 1, each checkpoint with its whole log,
 * are still read.
 */
export const SAVED_SESSION_VERSION = 2;
/** Versions of saved sessions this app reads. */
const READABLE_VERSIONS: readonly number[] = [1, SAVED_SESSION_VERSION];
/** Unfinished sessions kept, the running one among them: older ones are let go when a session starts. */
export const MAX_SAVED_SESSIONS = 5;

export interface SessionView {
  activeSymbol: string;
  timeframe: Timeframe;
  speed: number;
}

/** What the list of unfinished sessions shows, kept apart from the session so listing reads little. */
export interface SessionSummary {
  id: string;
  /** When it was last saved (ms). */
  savedAt: number;
  meta: SessionMeta;
  /** The replay's or market's time it had reached. */
  now: UnixSeconds;
  closedTrades: number;
  openPositions: number;
  equity: number;
  startingBalance: number;
  finished: boolean;
  /** Whether its challenge attempt was still under way. Absent on summaries saved before this was noted. */
  challengeUnderWay?: boolean;
}

export interface SavedSession {
  /** As saved: this app saves SAVED_SESSION_VERSION, and reads version 1 too. */
  version: 1 | typeof SAVED_SESSION_VERSION;
  summary: SessionSummary;
  view: SessionView;
  warnings: string[];
  replay?: { providerId: string; state: SavedReplay };
  sim?: { market: SimMarketSnapshot; broker: BrokerState; config: ExecutionConfig };
  /** Its trades whose journal entry was written (one no longer in the journal was deleted). */
  journaledTrips: string[];
  /** Journal entries whose review waits for price after the exit, with what they are judged by. */
  watching: Array<[string, { timeframe: Timeframe; rules: TradingRules }]>;
  /** Its challenge attempt, while one is under way. */
  challenge: ChallengeAttempt | null;
}

/** A session as stored: a replay's checkpoints are stored apart, each once, and listed by key. */
type StoredSession = Omit<SavedSession, 'replay'> & { replay?: { providerId: string; state: Omit<SavedReplay, 'checkpoints'> & { checkpoints: string[] } } };

/**
 * A checkpoint as stored, its log apart. Each checkpoint holds the whole log as it was then (up to 500
 * lines), nearly all of them in the log of the checkpoint before it in the session's list (`base`) too,
 * so the log is stored as what changed since that one: the lines dropped from its front and those added
 * at its end. Without a base, `added` is the whole log. A checkpoint stored before logs were stored this
 * way has no `log`: its whole log is in `cp`.
 */
interface StoredCheckpoint {
  key: string;
  cp: Omit<Checkpoint, 'broker'> & { broker: Omit<BrokerCheckpoint, 'events'> & { events?: BrokerEvent[] } };
  log?: { base?: string; dropped: number; added: BrokerEvent[] };
}

/** Where the session's clock had got to when last noted, and what it showed. */
export interface SessionPosition {
  now: UnixSeconds;
  rewinds: number;
  view: SessionView;
}

const RECORD = 'session:';
const SUMMARY = 'session-summary:';
const CHECKPOINT = 'session-cp:';
const POSITION = 'stock-replay-session-position:';
const TAB = 'stock-replay-tab-session';
const LOCK = 'stock-replay-session:';

// ---------------------------------------------------------------- the sessions

/**
 * A replay's checkpoints never change once taken, so each is stored once, under its own key: these are
 * the keys of those stored, by checkpoint. Per session, the keys its stored record lists.
 */
const storedCheckpoints = new WeakMap<Checkpoint, string>();
const listedCheckpoints = new Map<string, string[]>();

/**
 * `after` as a change to the log `before`: the fewest lines dropped from its front (the log keeps only the
 * newest lines) and the lines added at its end. Null when it is not such a change. Lines are compared by
 * value, since a log read back from storage is a copy.
 */
function logChange(before: BrokerEvent[], after: BrokerEvent[]): { dropped: number; added: BrokerEvent[] } | null {
  const same = (a: BrokerEvent, b: BrokerEvent) => a === b || (a.time === b.time && a.kind === b.kind && a.message === b.message && a.orderId === b.orderId);
  if (!before.length) return { dropped: 0, added: after };
  for (let dropped = Math.max(0, before.length - after.length); dropped < before.length; dropped++) {
    let k = 0;
    while (dropped + k < before.length && same(before[dropped + k], after[k])) k++;
    if (dropped + k === before.length) return { dropped, added: after.slice(k) };
  }
  return null;
}

/**
 * Saves `s`: its new checkpoints, then the session, then its summary, so a session that is listed has
 * its record and a record has every checkpoint it lists, whenever the page goes. Rejects when storage is
 * blocked or full. Saves must not overlap (the trading store makes them one after another).
 *
 * A new checkpoint's log is stored as a change to the one before it in the list (StoredCheckpoint). That
 * one stays listed as long as it does: checkpoints only ever go from the end of the list (a rewind, or a
 * later one at the same moment taking the last one's place), so one listed has every one before it.
 */
export async function writeSession(s: SavedSession): Promise<void> {
  const id = s.summary.id;
  // Saved before but its summary gone: storage was emptied under the app (site data cleared with it
  // open), so the checkpoints stored then are gone too and are stored again.
  if (listedCheckpoints.has(id) && !(await idb.get('kv', SUMMARY + id))) {
    listedCheckpoints.delete(id);
    for (const cp of s.replay?.state.checkpoints ?? []) storedCheckpoints.delete(cp);
  }
  let stored: StoredSession = { ...s, replay: undefined };
  const keys: string[] = [];
  if (s.replay) {
    const { checkpoints, ...rest } = s.replay.state;
    for (const [i, cp] of checkpoints.entries()) {
      let key = storedCheckpoints.get(cp);
      if (!key) {
        key = `${CHECKPOINT}${id}:${newId('cp')}`;
        const { events, ...broker } = cp.broker;
        const change = i > 0 ? logChange(checkpoints[i - 1].broker.events, events) : null;
        const log = change ? { base: keys[i - 1], ...change } : { dropped: 0, added: events };
        await idb.set<StoredCheckpoint>('kv', key, { key, cp: { ...cp, broker }, log });
        storedCheckpoints.set(cp, key);
      }
      keys.push(key);
    }
    stored = { ...s, replay: { providerId: s.replay.providerId, state: { ...rest, checkpoints: keys } } };
  }
  await idb.set('kv', RECORD + id, stored);
  await idb.set('kv', SUMMARY + id, s.summary);
  // Checkpoints a rewind undid are no longer listed: let go.
  const listed = new Set(keys);
  const before = listedCheckpoints.get(id) ?? [];
  listedCheckpoints.set(id, keys);
  for (const key of before) if (!listed.has(key)) await idb.delete('kv', key);
}

/** The session saved under `id`, or null when there is none this version of the app can read whole. */
export async function readSession(id: string): Promise<SavedSession | null> {
  const s = await idb.get<StoredSession>('kv', RECORD + id);
  if (!s || !READABLE_VERSIONS.includes(s.version) || s.summary?.id !== id) return null;
  if (!s.replay) return { ...s, replay: undefined };
  const keys = s.replay.state.checkpoints;
  const found = new Map((await idb.withPrefix<StoredCheckpoint>('kv', `${CHECKPOINT}${id}:`)).map((c) => [c.key, c]));
  // Each log is rebuilt from the one it is stored as a change to, which comes before it in the list.
  const logs = new Map<string, BrokerEvent[]>();
  const checkpoints: Checkpoint[] = [];
  for (const key of keys) {
    const c = found.get(key);
    if (!c) return null;
    let events = c.cp.broker.events;
    if (c.log) {
      const base = c.log.base === undefined ? [] : logs.get(c.log.base);
      if (!base || c.log.dropped > base.length) return null;
      events = base.slice(c.log.dropped).concat(c.log.added);
    }
    if (!Array.isArray(events)) return null;
    logs.set(key, events);
    checkpoints.push({ ...c.cp, broker: { ...c.cp.broker, events } });
  }
  if (!checkpoints.length) return null;
  // Settings that were one object in the session are one again (each was stored on its own).
  const configs = new Map<string, ExecutionConfig>();
  const shared = (c: ExecutionConfig) => {
    const k = JSON.stringify(c);
    if (!configs.has(k)) configs.set(k, c);
    return configs.get(k)!;
  };
  const config = shared(s.replay.state.config);
  for (const [i, cp] of checkpoints.entries()) {
    cp.config = shared(cp.config);
    storedCheckpoints.set(cp, keys[i]);
  }
  listedCheckpoints.set(id, keys);
  return { ...s, replay: { providerId: s.replay.providerId, state: { ...s.replay.state, config, checkpoints } } };
}

/**
 * The data source (a HISTORICAL_PROVIDERS id) the replay saved under `id` loads its bars from, or null for
 * the simulated market or a session that cannot be read. Reads only its record, not its checkpoints.
 */
export async function savedSource(id: string): Promise<string | null> {
  const s = await idb.get<StoredSession>('kv', RECORD + id);
  return s && s.summary?.id === id && typeof s.replay?.providerId === 'string' ? s.replay.providerId : null;
}

/** Forgets a session: its record, its summary, its checkpoints and where its clock had got to. */
export async function deleteSession(id: string): Promise<void> {
  try {
    localStorage.removeItem(POSITION + id);
  } catch {
    /* storage blocked: nothing was noted */
  }
  noted.delete(id);
  listedCheckpoints.delete(id);
  await idb.delete('kv', SUMMARY + id);
  await idb.delete('kv', RECORD + id);
  for (const { key } of await idb.withPrefix<{ key: string }>('kv', `${CHECKPOINT}${id}:`)) await idb.delete('kv', key);
}

/** Every unfinished session kept, those a tab is running included. */
export async function keptSessions(): Promise<SessionSummary[]> {
  const all = await idb.withPrefix<SessionSummary>('kv', SUMMARY);
  return all.filter((s) => s && typeof s.id === 'string' && typeof s.savedAt === 'number' && s.meta);
}

/** Unfinished sessions no tab is running, newest first. */
export async function listSessions(): Promise<SessionSummary[]> {
  const all = await keptSessions();
  const running = await lockedSessions();
  return all.filter((s) => !running.has(s.id) && !held.has(s.id)).sort((a, b) => b.savedAt - a.savedAt);
}

// ---------------------------------------------------------------- where the clock has got to

const noted = new Map<string, string>();

/** Notes where session `id`'s clock has got to and what it shows (cheap: unchanged, nothing is written). */
export function notePosition(id: string, p: SessionPosition): void {
  const text = JSON.stringify(p);
  if (noted.get(id) === text) return;
  noted.set(id, text);
  try {
    localStorage.setItem(POSITION + id, text);
  } catch {
    /* storage blocked: carrying on starts from the last whole save */
  }
}

/**
 * Calls `fn` when another tab notes where its session's clock has got to, or forgets a session (in
 * localStorage, which tells the other tabs): it started, played, saved or ended one. Returns what stops
 * listening.
 */
export function onPositionsNotedElsewhere(fn: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(POSITION)) fn();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

export function readPosition(id: string): SessionPosition | null {
  try {
    const p = JSON.parse(localStorage.getItem(POSITION + id) ?? 'null') as SessionPosition | null;
    if (!p || !Number.isFinite(p.now) || !Number.isFinite(p.rewinds) || typeof p.view?.activeSymbol !== 'string' || typeof p.view.timeframe !== 'string' || !Number.isFinite(p.view.speed)) return null;
    return p;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- this tab's session

/** The session this tab runs, kept for the tab (sessionStorage), so a reload carries it on by itself. */
export function rememberTabSession(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(TAB, id);
    else sessionStorage.removeItem(TAB);
  } catch {
    /* storage blocked: a reload offers the session instead */
  }
}

export function tabSession(): string | null {
  try {
    return sessionStorage.getItem(TAB);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- which tab runs which session

/** Sessions this tab holds the lock on, with what lets it go. */
const held = new Map<string, () => void>();

function lockManager(): LockManager | null {
  return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
}

/** Takes the lock on session `id` for this tab. False when another tab holds it. */
export function claimSession(id: string): Promise<boolean> {
  if (held.has(id)) return Promise.resolve(true);
  const locks = lockManager();
  if (!locks) {
    held.set(id, () => undefined);
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    locks
      .request(LOCK + id, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        // Held until released, or until the page goes.
        return new Promise<void>((release) => {
          held.set(id, release);
          resolve(true);
        });
      })
      .catch(() => resolve(false));
  });
}

export function releaseSession(id: string): void {
  held.get(id)?.();
  held.delete(id);
}

/**
 * Calls `fn` once a session another tab is running is let go there (it ended there, or the tab closed or
 * crashed), so the list of unfinished sessions can be looked at again. Returns what stops listening.
 */
export function onSessionFreed(fn: () => void): () => void {
  const locks = lockManager();
  if (!locks) return () => undefined;
  const stop = new AbortController();
  void (async () => {
    const all = await idb.withPrefix<SessionSummary>('kv', SUMMARY).catch(() => [] as SessionSummary[]);
    const running = await lockedSessions();
    for (const s of all) {
      if (stop.signal.aborted || !running.has(s?.id) || held.has(s.id)) continue;
      // Granted once the other tab lets go; let go again at once, then told (once the lock is free).
      locks
        .request(LOCK + s.id, { signal: stop.signal }, () => {
          if (!stop.signal.aborted) setTimeout(fn, 50);
        })
        .catch(() => undefined);
    }
  })();
  return () => stop.abort();
}

/** Sessions some tab (this one included) holds the lock on. */
async function lockedSessions(): Promise<Set<string>> {
  const locks = lockManager();
  if (!locks) return new Set();
  try {
    const { held: list = [] } = await locks.query();
    return new Set(list.map((l) => l.name ?? '').filter((n) => n.startsWith(LOCK)).map((n) => n.slice(LOCK.length)));
  } catch {
    return new Set();
  }
}
