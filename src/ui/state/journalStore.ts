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

/** This tab's journal writes still in flight, per entry. */
const inflight = new Map<string, number>();

/**
 * Note and tag edits not yet confirmed written, per entry, as [value before, value after]. They are
 * kept in localStorage, which writes at once: an IndexedDB write started as the tab closes, reloads
 * or is killed in the background is often dropped. The next load finishes them.
 */
type Change = [before: string, after: string];
type Draft = { notes: Partial<Record<keyof JournalNotes, Change>>; tag?: Change };
const DRAFTS_KEY = 'stock-replay-journal-drafts';

function readDrafts(): Record<string, Draft> {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}');
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

function writeDrafts(drafts: Record<string, Draft>): void {
  try {
    if (Object.keys(drafts).length) localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    else localStorage.removeItem(DRAFTS_KEY);
  } catch {
    /* storage blocked or full: no safety net, the write itself still runs */
  }
}

/** Entries with a write that failed since their draft was started: their draft must stay. */
const unsaved = new Set<string>();

/**
 * A draft's edits on top of the stored entry. A field someone has changed since (another tab) is
 * left alone, and one the original write already saved needs nothing. Undefined when nothing changes.
 */
function applyDraft(cur: JournalEntry, d: Draft, today: string): JournalEntry | undefined {
  const notes = { ...cur.notes };
  let changed = false;
  for (const [k, [before, after]] of Object.entries(d.notes ?? {}) as [keyof JournalNotes, Change][])
    if (notes[k] === before && before !== after) {
      notes[k] = after;
      changed = true;
    }
  let tag = cur.tag;
  if (d.tag && tag === d.tag[0] && d.tag[0] !== d.tag[1]) {
    tag = d.tag[1];
    changed = true;
  }
  if (!changed) return undefined;
  const reviewed = !hasNotes(cur.notes) && hasNotes(notes) && cur.reviewedOn !== today;
  return { ...cur, tag, notes, ...(reviewed ? { reviewedOn: today } : {}) };
}

/**
 * Show `optimistic` at once, then apply `change` to the stored copy in one transaction, so fields
 * another tab saved meanwhile are kept. Writes to one entry land in the order they were made, and
 * the list takes the stored result only after the last of them, so an older write never puts back
 * text the user has typed since. If storage fails the change applies to this tab's copy only.
 */
async function write(id: string, before: JournalEntry, optimistic: JournalEntry, change: (cur: JournalEntry) => JournalEntry): Promise<JournalEntry> {
  replace(id, optimistic);
  inflight.set(id, (inflight.get(id) ?? 0) + 1);
  let next: JournalEntry;
  try {
    next = (await idb.modify<JournalEntry>('journal', id, (cur) => change(cur ?? before))) ?? optimistic;
    announce(id);
  } catch (err) {
    useJournal.setState({ error: (err as Error).message });
    unsaved.add(id);
    next = change(before);
  }
  const left = (inflight.get(id) ?? 1) - 1;
  if (left > 0) inflight.set(id, left);
  else {
    inflight.delete(id);
    if (!unsaved.has(id)) {
      const drafts = readDrafts();
      delete drafts[id];
      writeDrafts(drafts);
    }
    // Not when the entry was deleted here meanwhile (its delete lands after this write).
    if (useJournal.getState().entries.some((e) => e.id === id)) replace(id, next);
  }
  return next;
}

interface JournalStore {
  entries: JournalEntry[];
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  add: (e: JournalEntry) => Promise<void>;
  /** Save note fields and/or the tag. Fields equal to this tab's copy are left alone. */
  updateNotes: (id: string, notes: Partial<JournalNotes>, tag?: string) => Promise<void>;
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
      // Finish edits whose write was cut off when a tab closed.
      const drafts = readDrafts();
      const today = dayKey(new Date());
      let reviewed = false;
      for (const [id, d] of Object.entries(drafts)) {
        if (!entries.some((e) => e.id === id)) continue;
        const done = await idb.modify<JournalEntry>('journal', id, (cur) => (cur ? applyDraft(cur, d, today) : undefined));
        if (!done) continue;
        reviewed ||= done.reviewedOn === today && entries.find((e) => e.id === id)?.reviewedOn !== today;
        entries.splice(entries.findIndex((e) => e.id === id), 1, done);
        announce(id);
      }
      // Read again: an edit made meanwhile may have added to the drafts. Those of this tab's own
      // writes still in flight stay until the writes land.
      const left = readDrafts();
      for (const id of Object.keys(drafts)) if (!inflight.has(id)) delete left[id];
      writeDrafts(left);
      unsaved.clear();
      entries.sort(byExit);
      set({ entries, loaded: true, error: null });
      if (reviewed) recordReview();
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
  updateNotes: async (id, notes, tag) => {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry) return;
    // Only the fields edited here: another tab may have written the others.
    const keys = (Object.keys(notes) as (keyof JournalNotes)[]).filter((k) => notes[k] !== undefined && notes[k] !== entry.notes[k]);
    const edits = Object.fromEntries(keys.map((k) => [k, notes[k]])) as Partial<JournalNotes>;
    const retag = tag !== undefined && tag !== entry.tag ? { tag } : {};
    if (!keys.length && !('tag' in retag)) return;
    // Recorded before the write starts, so a tab closed mid-write loses nothing.
    const drafts = readDrafts();
    const draft: Draft = drafts[id] ?? { notes: {} };
    for (const k of keys) draft.notes[k] = [draft.notes[k]?.[0] ?? entry.notes[k], edits[k]!];
    if (tag !== undefined && 'tag' in retag) draft.tag = [draft.tag?.[0] ?? entry.tag, tag];
    drafts[id] = draft;
    writeDrafts(drafts);
    const today = dayKey(new Date());
    let reviewed = false;
    await write(id, entry, { ...entry, ...retag, notes: { ...entry.notes, ...edits } }, (cur) => {
      const merged = { ...cur.notes, ...edits };
      // The first note written on a trade counts as a review for the daily practice summary, once
      // a day: clearing the notes and writing them again is still the same review.
      reviewed = !hasNotes(cur.notes) && hasNotes(merged) && cur.reviewedOn !== today;
      return { ...cur, ...retag, notes: merged, ...(reviewed ? { reviewedOn: today } : {}) };
    });
    if (reviewed) recordReview();
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
  // This tab's own write in flight reads the stored copy, other tab's change included, when it lands.
  if (inflight.has(id)) return;
  void stored(id).then((entry) => replace(id, entry));
});
