/**
 * Back up what this browser keeps for the app to one file, and restore it, so clearing site data
 * or moving to another browser or device loses nothing: the journal (with its chart snapshots),
 * challenge history, the practice streak, settings and appearance, chart drawings and, if asked,
 * imported price data. API keys are never included.
 *
 * Restoring adds; it never deletes or overwrites. A journal entry, challenge attempt, drawing or
 * dataset already here under the same id or ticker is kept as it is (a journal entry gets the
 * backup's chart snapshot if this browser does not have it); the streak keeps every day either
 * record has (see mergeStreak). Only the settings are replaced, and only when asked.
 */
import { idb } from './idb';
import type { JournalEntry } from '../../core/journal';
import type { CsvDataset } from '../../core/data/csvProvider';
import type { StreakData } from '../../core/streak/streak';
import { sanitizeStreak } from '../../core/streak/streak';
import { useJournal } from '../state/journalStore';
import { useChallenges, validAttempt, type ChallengeAttempt } from '../state/challengeStore';
import { readStreak, restoreStreak } from '../state/streakStore';
import { savedSettings, useSettings } from '../state/settingsStore';
import { allDrawings, mergeDrawings, readDrawing, type Drawing } from '../chart/drawings';
import { DATA_SOURCE_KINDS, TIMEFRAMES, type DataSourceKind } from '../../core/types';
import { EXIT_REASONS, type ExitReason } from '../../core/learning/review';
import { isCalendarTime } from '../../core/time';
import { csvProvider, saveCsvDataset, sessionStamped, showStoredCsvDataset } from '../state/dataRegistry';

export const BACKUP_FORMAT = 'stock-replay-backup';
export const BACKUP_VERSION = 1;
const SETTINGS_KEY = 'stock-replay-settings';

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  /** When the backup was made (ms). */
  createdAt: number;
  journal: JournalEntry[];
  /** Chart snapshot images of those entries, by snapshotKey. */
  snapshots: Record<string, string>;
  challenges: ChallengeAttempt[];
  streak: StreakData;
  /** The saved settings, as the settings store keeps them (no keys: those live elsewhere). */
  settings: Record<string, unknown> | null;
  drawings: Record<string, Drawing[]>;
  /** Imported price data, when it was included. */
  datasets?: CsvDataset[];
}

export interface BackupOptions {
  snapshots: boolean;
  datasets: boolean;
  /** Entries left out: those of a blind session that has not ended (running, or saved to carry on later), whose dates must stay hidden. */
  holdBack: (e: JournalEntry) => boolean;
}

/** Stored records, or the ones in memory when storage cannot be read. */
async function stored<T>(store: 'journal' | 'challenges' | 'datasets', fallback: () => T[]): Promise<T[]> {
  try {
    return await idb.all<T>(store);
  } catch {
    return fallback();
  }
}

/** A backup, with how many journal entries it leaves out (holdBack) and from how many sessions. */
export async function createBackup(o: BackupOptions): Promise<{ backup: Backup; heldBack: number; heldSessions: number }> {
  const all = await stored<JournalEntry>('journal', () => useJournal.getState().entries);
  const journal = all.filter((e) => !o.holdBack(e));
  const heldSessions = new Set(all.filter((e) => o.holdBack(e)).map((e) => e.sessionId)).size;
  // Collected as entries: `snapshots[key] = …` would store nothing for a key of "__proto__".
  const shots: [string, string][] = [];
  if (o.snapshots) {
    for (const e of journal) {
      if (!e.snapshotKey) continue;
      const shot = await idb.get<string>('snapshots', e.snapshotKey).catch(() => undefined);
      if (typeof shot === 'string') shots.push([e.snapshotKey, shot]);
    }
  }
  const challenges = await stored<ChallengeAttempt>('challenges', () => useChallenges.getState().attempts);
  let settings: Record<string, unknown> | null = null;
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as { state?: Record<string, unknown> } | null;
    settings = raw?.state ?? null;
  } catch {
    settings = null;
  }
  // Settings never saved (storage blocked): the ones in use.
  if (!settings) settings = JSON.parse(JSON.stringify(useSettings.getState())) as Record<string, unknown>;
  const backup: Backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    journal,
    snapshots: Object.fromEntries(shots),
    challenges,
    streak: readStreak(),
    settings,
    drawings: allDrawings(),
    // Daily data stored with midnight stamps by an earlier version goes in filed under its session.
    ...(o.datasets ? { datasets: (await stored<CsvDataset>('datasets', () => [])).map(sessionStamped) } : {}),
  };
  return { backup, heldBack: all.length - journal.length, heldSessions };
}

/**
 * Whether this browser has saved settings of its own. A fresh one has none until a setting is
 * changed or a session started. Storage that cannot be read counts as having them.
 */
export function hasSavedSettings(): boolean {
  try {
    return localStorage.getItem(SETTINGS_KEY) !== null;
  } catch {
    return true;
  }
}

export function backupFileName(b: Backup): string {
  const d = new Date(b.createdAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `stock-replay-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

// ------------------------------------------------------------------ reading a file

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const numOrNull = (v: unknown) => v === null || isNum(v);
const NOTE_FIELDS = ['why', 'setup', 'good', 'bad', 'change', 'other'] as const;

/** Whether `v` has the shape the journal, analytics and review pages read from an entry. */
function validEntry(v: unknown): v is JournalEntry {
  if (!isObj(v)) return false;
  const e = v as Record<string, unknown>;
  if (![e.id, e.sessionId, e.symbol, e.tag].every(isStr)) return false;
  if (e.direction !== 'long' && e.direction !== 'short') return false;
  if (e.mode !== 'replay' && e.mode !== 'sim') return false;
  // Shown in the app's own words for it (DEMO DATA · SYNTHETIC, say): one the app knows.
  if (!DATA_SOURCE_KINDS.includes(e.source as DataSourceKind)) return false;
  if (e.snapshotMissing !== undefined && e.snapshotMissing !== 'off' && e.snapshotMissing !== 'failed') return false;
  if (![e.avgEntry, e.avgExit, e.quantity, e.pnl, e.returnPct, e.holdingSeconds, e.commission, e.createdAt].every(isNum)) return false;
  // Shown as dates: in a year the calendar has.
  if (![e.entryTime, e.exitTime].every(isCalendarTime)) return false;
  // Every note is searched as text, not only the ones the page shows.
  if (!isObj(e.notes) || !NOTE_FIELDS.every((k) => isStr((e.notes as Record<string, unknown>)[k])) || !Object.values(e.notes).every(isStr)) return false;
  if (typeof e.rewound !== 'boolean') return false;
  if (e.review !== undefined && !validReview(e.review)) return false;
  const t = e.trip;
  if (!isObj(t) || !isStr(t.id) || !isStr(t.symbol) || !isNum(t.entryTime) || !isNum(t.avgEntry) || !isNum(t.pnl) || !Array.isArray(t.fills)) return false;
  return true;
}

/** Whether `v` has what the trade review shows: its figures numbers (or none), its findings and rule checks text. */
function validReview(v: unknown): boolean {
  if (!isObj(v) || !EXIT_REASONS.includes(v.exitReason as ExitReason) || !isObj(v.mfe) || !isObj(v.mae)) return false;
  if (![v.rMultiple, v.plannedRR, v.capturePct, v.riskDollars, v.riskPctOfEquity, v.atrAtEntry, v.stopDistanceAtr, v.mfe.r, v.mae.r].every(numOrNull)) return false;
  if (!(v.riskLimitPct === undefined || isNum(v.riskLimitPct)) || !(v.largestRiskPct === undefined || numOrNull(v.largestRiskPct))) return false;
  if (!Array.isArray(v.findings) || !v.findings.every((f) => isObj(f) && [f.tone, f.title, f.detail].every(isStr))) return false;
  return Array.isArray(v.rules) && v.rules.every((c) => isObj(c) && isStr(c.rule) && isStr(c.detail));
}

/** Whether `v` is imported data the replay, the new replay form and the data list can use. */
function validDataset(v: unknown): v is CsvDataset {
  if (!isObj(v) || !isStr(v.symbol) || !v.symbol.trim() || !isStr(v.name) || !isStr(v.fileName)) return false;
  if (!TIMEFRAMES.includes(v.baseTimeframe as CsvDataset['baseTimeframe']) || !Array.isArray(v.bars) || !v.bars.length) return false;
  let last = -Infinity;
  for (const b of v.bars as unknown[]) {
    if (!isObj(b) || ![b.open, b.high, b.low, b.close, b.volume].every(isNum) || !isCalendarTime(b.time) || b.time <= last) return false;
    last = b.time;
  }
  return true;
}

export interface BackupContents {
  backup: Backup;
  /** Items the file had that could not be read and will be skipped. */
  skipped: number;
}

/** Read a backup file's text. Throws with a message for the user when it is not one. */
export function parseBackup(text: string): BackupContents {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This file is not a backup: it is not valid JSON.');
  }
  // A journal exported from the Journal page (a list of entries) restores too.
  if (Array.isArray(raw)) raw = { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: 0, journal: raw };
  if (!isObj(raw) || raw.format !== BACKUP_FORMAT) throw new Error('This file is not a Stock Replay backup.');
  if (!isNum(raw.version) || raw.version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of the app. Reload the app to update it, then try again.');
  let skipped = 0;
  /** The items of `list` as `read` reads them; those it cannot read (null) are skipped. */
  const keep = <T>(list: unknown, read: (v: unknown) => T | null): T[] => {
    if (!Array.isArray(list)) return [];
    const good = list.map(read).filter((v) => v !== null);
    skipped += list.length - good.length;
    return good;
  };
  /** A check as a reader: the item itself when it passes. */
  const checked =
    <T>(ok: (v: unknown) => v is T) =>
    (v: unknown): T | null =>
      ok(v) ? v : null;
  const journal = keep(raw.journal, checked(validEntry));
  // Built from entries, so a key of "__proto__" is kept as any other (`snapshots[k] = …` would store nothing).
  const snapshots: Record<string, string> = isObj(raw.snapshots) ? Object.fromEntries(Object.entries(raw.snapshots).filter((kv): kv is [string, string] => isStr(kv[1]) && kv[1].startsWith('data:image/'))) : {};
  const drawings: [string, Drawing[]][] = [];
  if (isObj(raw.drawings)) {
    for (const [sym, list] of Object.entries(raw.drawings)) {
      // A drawing whose colour is not one is kept, in the default colour (readDrawing).
      const good = keep(list, readDrawing);
      if (sym && good.length) drawings.push([sym, good]);
    }
  }
  // Only settings the app can use (savedSettings): a hand-edited file can break nothing.
  const settings = isObj(raw.settings) ? savedSettings(raw.settings) : {};
  const backup: Backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: isNum(raw.createdAt) ? raw.createdAt : 0,
    journal,
    snapshots,
    challenges: keep(raw.challenges, checked(validAttempt)),
    streak: sanitizeStreak(raw.streak),
    settings: Object.keys(settings).length ? settings : null,
    drawings: Object.fromEntries(drawings),
    ...(raw.datasets !== undefined ? { datasets: keep(raw.datasets, checked(validDataset)) } : {}),
  };
  return { backup, skipped };
}

// ------------------------------------------------------------------ restoring

export interface RestoreResult {
  journalAdded: number;
  journalKept: number;
  /** Chart snapshots added to journal entries already here that did not have theirs. */
  snapshotsAdded: number;
  challengesAdded: number;
  drawingsAdded: number;
  datasetsAdded: string[];
  /** Tickers whose imported data here was kept instead of the backup's. */
  datasetsKept: string[];
  settings: boolean;
  streakDays: number;
}

export async function restoreBackup(b: Backup, o: { settings: boolean }): Promise<RestoreResult> {
  const { added, snapshots } = await useJournal.getState().importEntries(b.journal, b.snapshots);
  const challengesAdded = await useChallenges.getState().importAttempts(b.challenges);
  restoreStreak(b.streak);
  let drawingsAdded = 0;
  for (const [sym, list] of Object.entries(b.drawings)) drawingsAdded += mergeDrawings(sym, list);
  const datasetsAdded: string[] = [];
  const datasetsKept: string[] = [];
  for (const d of b.datasets ?? []) {
    const sym = d.symbol.toUpperCase();
    // Decided by storage: what this tab shows is always stored, but a restore that stopped partway
    // may have stored data this tab does not show yet.
    const mine = await idb.get<CsvDataset>('datasets', sym).catch(() => undefined);
    if (mine && csvProvider.list().some((x) => x.symbol.toUpperCase() === sym)) datasetsKept.push(sym);
    else {
      if (mine) showStoredCsvDataset(mine);
      else await saveCsvDataset({ ...d, symbol: sym });
      datasetsAdded.push(sym);
    }
  }
  let settings = false;
  if (o.settings && b.settings) {
    try {
      // The settings store's own merge fills in anything missing and checks the appearance.
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ state: b.settings, version: 1 }));
      await useSettings.persist.rehydrate();
      settings = true;
    } catch {
      /* storage blocked or full: the settings in use stay */
    }
  }
  return {
    journalAdded: added.length,
    journalKept: b.journal.length - added.length,
    snapshotsAdded: snapshots,
    challengesAdded,
    drawingsAdded,
    datasetsAdded,
    datasetsKept,
    settings,
    streakDays: Object.values(b.streak.days).filter((d) => d.done).length,
  };
}
