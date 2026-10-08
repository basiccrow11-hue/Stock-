/** Journal entries persisted in IndexedDB; chart snapshots stored separately by key. */
import { create } from 'zustand';
import { idb } from '../services/idb';
import type { JournalEntry, JournalNotes } from '../../core/journal';
import { recordReview } from './streakStore';
import { dayKey } from '../../core/streak/streak';

const hasNotes = (n: JournalNotes) => Object.values(n).some((v) => typeof v === 'string' && v.trim() !== '');

const byExit = (a: JournalEntry, b: JournalEntry) => b.exitTime - a.exitTime || b.createdAt - a.createdAt;

/**
 * Other open tabs of the app hear about every journal write and re-read that entry, so a tab never
 * edits (and writes back) a stale copy of an entry another tab has changed.
 */
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('stock-replay-journal');
const announce = (id: string) => channel?.postMessage(id);

/** Put an entry's current version in the list (or take it out when it is gone). */
function replace(id: string, entry: JournalEntry | undefined): void {
  const others = useJournal.getState().entries.filter((e) => e.id !== id);
  useJournal.setState({ entries: entry ? [...others, entry].sort(byExit) : others });
}

async function stored(id: string): Promise<JournalEntry | undefined> {
  return idb.get<JournalEntry>('journal', id).catch(() => undefined);
}

interface JournalStore {
  entries: JournalEntry[];
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  add: (e: JournalEntry) => Promise<void>;
  update: (id: string, patch: Partial<JournalEntry>) => Promise<void>;
  updateNotes: (id: string, notes: Partial<JournalNotes>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  removeWhere: (pred: (e: JournalEntry) => boolean) => Promise<number>;
}

export const useJournal = create<JournalStore>()((set, get) => ({
  entries: [],
  loaded: false,
  error: null,
  load: async () => {
    try {
      const entries = await idb.all<JournalEntry>('journal');
      entries.sort(byExit);
      set({ entries, loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: (e as Error).message });
    }
  },
  add: async (e) => {
    set({ entries: [e, ...get().entries.filter((x) => x.id !== e.id)] });
    try {
      await idb.set('journal', e.id, e);
      announce(e.id);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
  update: async (id, patch) => {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry) return;
    // Shown at once, then applied to the stored copy, which another tab may have changed meanwhile.
    replace(id, { ...entry, ...patch });
    try {
      const next = { ...((await stored(id)) ?? entry), ...patch };
      await idb.set('journal', id, next);
      replace(id, next);
      announce(id);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
  updateNotes: async (id, notes) => {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry) return;
    // Only the fields edited here: another tab may have written the others.
    const changed = (Object.keys(notes) as (keyof JournalNotes)[]).filter((k) => notes[k] !== undefined && notes[k] !== entry.notes[k]);
    if (!changed.length) return;
    const base = (await stored(id)) ?? entry;
    const next = { ...base.notes, ...Object.fromEntries(changed.map((k) => [k, notes[k]])) };
    // The first note written on a trade counts as a review for the daily practice summary, once a
    // day: clearing the notes and writing them again is still the same review.
    const today = dayKey(new Date());
    const reviewed = !hasNotes(base.notes) && hasNotes(next) && base.reviewedOn !== today;
    if (reviewed) recordReview();
    await get().update(id, reviewed ? { notes: next, reviewedOn: today } : { notes: next });
  },
  remove: async (id) => {
    const entry = get().entries.find((e) => e.id === id);
    set({ entries: get().entries.filter((e) => e.id !== id) });
    await idb.delete('journal', id).catch(() => undefined);
    if (entry?.snapshotKey) await idb.delete('snapshots', entry.snapshotKey).catch(() => undefined);
    announce(id);
  },
  removeWhere: async (pred) => {
    const doomed = get().entries.filter(pred);
    for (const e of doomed) await get().remove(e.id);
    return doomed.length;
  },
}));

export async function saveSnapshot(key: string, dataUrl: string): Promise<void> {
  await idb.set('snapshots', key, dataUrl);
}

export async function loadSnapshot(key: string): Promise<string | undefined> {
  return idb.get<string>('snapshots', key);
}

channel?.addEventListener('message', (e: MessageEvent) => {
  if (typeof e.data !== 'string' || !useJournal.getState().loaded) return;
  const id = e.data;
  void stored(id).then((entry) => replace(id, entry));
});
