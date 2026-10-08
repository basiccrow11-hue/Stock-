/** Journal entries persisted in IndexedDB; chart snapshots stored separately by key. */
import { create } from 'zustand';
import { idb } from '../services/idb';
import type { JournalEntry, JournalNotes } from '../../core/journal';

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
      entries.sort((a, b) => b.exitTime - a.exitTime || b.createdAt - a.createdAt);
      set({ entries, loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: (e as Error).message });
    }
  },
  add: async (e) => {
    set({ entries: [e, ...get().entries.filter((x) => x.id !== e.id)] });
    try {
      await idb.set('journal', e.id, e);
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },
  update: async (id, patch) => {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry) return;
    const next = { ...entry, ...patch };
    set({ entries: get().entries.map((e) => (e.id === id ? next : e)) });
    await idb.set('journal', id, next).catch((err) => set({ error: (err as Error).message }));
  },
  updateNotes: async (id, notes) => {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry) return;
    await get().update(id, { notes: { ...entry.notes, ...notes } });
  },
  remove: async (id) => {
    const entry = get().entries.find((e) => e.id === id);
    set({ entries: get().entries.filter((e) => e.id !== id) });
    await idb.delete('journal', id).catch(() => undefined);
    if (entry?.snapshotKey) await idb.delete('snapshots', entry.snapshotKey).catch(() => undefined);
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
