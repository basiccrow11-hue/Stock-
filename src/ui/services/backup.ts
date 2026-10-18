/**
 * Back up what this browser keeps for the app to one file, and restore it, so clearing site data
 * or moving to another browser or device loses nothing: the journal (with its chart snapshots),
 * challenge history, the practice streak, settings and appearance, chart drawings and, if asked,
 * imported price data. API keys are never included.
 *
 * Restoring adds; it never deletes or overwrites. A journal entry, challenge attempt, drawing or
 * dataset already here under the same id or ticker is kept as it is; the streak keeps every day
 * either record has (see mergeStreak). Only the settings are replaced, and only when asked.
 */
import { idb } from './idb';
import type { JournalEntry } from '../../core/journal';
import type { CsvDataset } from '../../core/data/csvProvider';
import type { StreakData } from '../../core/streak/streak';
import { sanitizeStreak } from '../../core/streak/streak';
import { useJournal } from '../state/journalStore';
import { useChallenges, type ChallengeAttempt } from '../state/challengeStore';
import { readStreak, restoreStreak } from '../state/streakStore';
import { useSettings } from '../state/settingsStore';
import { allDrawings, mergeDrawings, type Drawing } from '../chart/drawings';
import { csvProvider, saveCsvDataset } from '../state/dataRegistry';

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

export async function createBackup(o: BackupOptions): Promise<{ backup: Backup; heldBack: number }> {
  const all = await stored<JournalEntry>('journal', () => useJournal.getState().entries);
  const journal = all.filter((e) => !o.holdBack(e));
  const snapshots: Record<string, string> = {};
  if (o.snapshots) {
    for (const e of journal) {
      if (!e.snapshotKey) continue;
      const shot = await idb.get<string>('snapshots', e.snapshotKey).catch(() => undefined);
      if (typeof shot === 'string') snapshots[e.snapshotKey] = shot;
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
    snapshots,
    challenges,
    streak: readStreak(),
    settings,
    drawings: allDrawings(),
    ...(o.datasets ? { datasets: await stored<CsvDataset>('datasets', () => []) } : {}),
  };
  return { backup, heldBack: all.length - journal.length };
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
const NOTE_FIELDS = ['why', 'setup', 'good', 'bad', 'change', 'other'] as const;

/** Whether `v` has the shape the journal, analytics and review pages read from an entry. */
function validEntry(v: unknown): v is JournalEntry {
  if (!isObj(v)) return false;
  const e = v as Record<string, unknown>;
  if (![e.id, e.sessionId, e.symbol, e.tag].every(isStr)) return false;
  if (e.direction !== 'long' && e.direction !== 'short') return false;
  if (e.mode !== 'replay' && e.mode !== 'sim') return false;
  if (!isStr(e.source)) return false;
  if (![e.entryTime, e.exitTime, e.avgEntry, e.avgExit, e.quantity, e.pnl, e.returnPct, e.holdingSeconds, e.commission, e.createdAt].every(isNum)) return false;
  if (!isObj(e.notes) || !NOTE_FIELDS.every((k) => isStr((e.notes as Record<string, unknown>)[k]))) return false;
  if (typeof e.rewound !== 'boolean') return false;
  const t = e.trip;
  if (!isObj(t) || !isStr(t.id) || !isStr(t.symbol) || !isNum(t.entryTime) || !isNum(t.avgEntry) || !isNum(t.pnl) || !Array.isArray(t.fills)) return false;
  return true;
}

function validAttempt(v: unknown): v is ChallengeAttempt {
  return isObj(v) && isStr(v.id) && isStr(v.challengeId) && isStr(v.sessionId) && isStr(v.label) && isNum(v.startedAt) && isObj(v.result) && isStr(v.result.status);
}

function validDrawing(v: unknown): v is Drawing {
  return isObj(v) && isStr(v.id) && isStr(v.type) && isStr(v.color) && Array.isArray(v.points) && v.points.every((p) => isObj(p) && isNum(p.time) && isNum(p.price));
}

function validDataset(v: unknown): v is CsvDataset {
  if (!isObj(v) || !isStr(v.symbol) || !v.symbol.trim() || !isStr(v.baseTimeframe) || !Array.isArray(v.bars) || !v.bars.length) return false;
  let last = -Infinity;
  for (const b of v.bars as unknown[]) {
    if (!isObj(b) || ![b.time, b.open, b.high, b.low, b.close].every(isNum) || (b.time as number) <= last) return false;
    last = b.time as number;
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
  const keep = <T>(list: unknown, ok: (v: unknown) => v is T): T[] => {
    if (!Array.isArray(list)) return [];
    const good = list.filter(ok);
    skipped += list.length - good.length;
    return good;
  };
  const journal = keep(raw.journal, validEntry);
  const snapshots: Record<string, string> = {};
  if (isObj(raw.snapshots)) for (const [k, v] of Object.entries(raw.snapshots)) if (isStr(v) && v.startsWith('data:image/')) snapshots[k] = v;
  const drawings: Record<string, Drawing[]> = {};
  if (isObj(raw.drawings)) {
    for (const [sym, list] of Object.entries(raw.drawings)) {
      const good = keep(list, validDrawing);
      if (sym && good.length) drawings[sym] = good;
    }
  }
  const backup: Backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: isNum(raw.createdAt) ? raw.createdAt : 0,
    journal,
    snapshots,
    challenges: keep(raw.challenges, validAttempt),
    streak: sanitizeStreak(raw.streak),
    settings: isObj(raw.settings) ? raw.settings : null,
    drawings,
    ...(raw.datasets !== undefined ? { datasets: keep(raw.datasets, validDataset) } : {}),
  };
  return { backup, skipped };
}

// ------------------------------------------------------------------ restoring

export interface RestoreResult {
  journalAdded: number;
  journalKept: number;
  challengesAdded: number;
  drawingsAdded: number;
  datasetsAdded: string[];
  /** Tickers whose imported data here was kept instead of the backup's. */
  datasetsKept: string[];
  settings: boolean;
  streakDays: number;
}

export async function restoreBackup(b: Backup, o: { settings: boolean }): Promise<RestoreResult> {
  const added = await useJournal.getState().importEntries(b.journal, b.snapshots);
  const challengesAdded = await useChallenges.getState().importAttempts(b.challenges);
  restoreStreak(b.streak);
  let drawingsAdded = 0;
  for (const [sym, list] of Object.entries(b.drawings)) drawingsAdded += mergeDrawings(sym, list);
  const datasetsAdded: string[] = [];
  const datasetsKept: string[] = [];
  for (const d of b.datasets ?? []) {
    const sym = d.symbol.toUpperCase();
    const here = csvProvider.list().some((x) => x.symbol.toUpperCase() === sym) || (await idb.get('datasets', sym).catch(() => undefined)) !== undefined;
    if (here) datasetsKept.push(sym);
    else {
      await saveCsvDataset({ ...d, symbol: sym });
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
    challengesAdded,
    drawingsAdded,
    datasetsAdded,
    datasetsKept,
    settings,
    streakDays: Object.values(b.streak.days).filter((d) => d.done).length,
  };
}
