/** Journal entries persisted in IndexedDB; chart snapshots stored separately by key. */
import { create } from 'zustand';
import { idb } from '../services/idb';
import type { JournalEntry, JournalNotes } from '../../core/journal';
import type { TradeReview } from '../../core/learning/review';
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

/** The stored entry: undefined when it is gone, null when it could not be read. */
async function stored(id: string): Promise<JournalEntry | undefined | null> {
  return idb.get<JournalEntry>('journal', id).catch(() => null);
}

/** This tab's journal writes still in flight, per entry. */
const inflight = new Map<string, number>();

/**
 * Note and tag edits not yet confirmed written, per entry, as [value in the store before, value
 * after]. They are kept in localStorage, which writes at once: an IndexedDB write started as a tab
 * closes, reloads or is killed in the background is often dropped. Whichever tab next sees such a
 * draft finishes it, field by field and only where the store still holds the value it started from.
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

/** A draft's fields, with the tag as one of them. */
function draftFields(d: Draft): [string, Change][] {
  return [...(Object.entries(d.notes ?? {}) as [string, Change][]), ...(d.tag ? [['tag', d.tag] as [string, Change]] : [])];
}

const fieldOf = (e: JournalEntry, k: string): string => (k === 'tag' ? e.tag : e.notes[k as keyof JournalNotes]);

/**
 * A draft's edits on top of the stored entry: each field that still holds the value its edit
 * started from. Undefined when that changes nothing.
 */
function applyDraft(cur: JournalEntry, d: Draft | undefined, today: string): JournalEntry | undefined {
  if (!d) return undefined;
  const notes = { ...cur.notes };
  let tag = cur.tag;
  let changed = false;
  for (const [k, [before, after]] of draftFields(d)) {
    if (fieldOf(cur, k) !== before || before === after) continue;
    if (k === 'tag') tag = after;
    else notes[k as keyof JournalNotes] = after;
    changed = true;
  }
  if (!changed) return undefined;
  const reviewed = !hasNotes(cur.notes) && hasNotes(notes) && cur.reviewedOn !== today;
  return { ...cur, tag, notes, ...(reviewed ? { reviewedOn: today } : {}) };
}

/**
 * Bring an entry's draft up to date with what the store now holds (`stored`, undefined when the
 * entry is gone): fields holding their edit's value are done; fields this tab has just written
 * (`wrote`) now start from the stored value; with `dropStale`, fields another value has overtaken
 * are given up.
 */
function settleDraft(id: string, stored: JournalEntry | undefined, wrote: string[], dropStale: boolean): void {
  const drafts = readDrafts();
  const d = drafts[id];
  if (!d) return;
  if (stored) {
    for (const [k, c] of draftFields(d)) {
      const now = fieldOf(stored, k);
      if (now === c[1] || (dropStale && now !== c[0])) {
        if (k === 'tag') delete d.tag;
        else delete d.notes[k as keyof JournalNotes];
      } else if (wrote.includes(k)) c[0] = now;
    }
  }
  if (!stored || (!Object.keys(d.notes ?? {}).length && !d.tag)) delete drafts[id];
  writeDrafts(drafts);
}

/**
 * Finish the drafts other tabs left behind (a tab that closed mid-write), for entries this tab
 * has no write in flight for. On load, fields another value has overtaken are given up too.
 */
async function finishDrafts(onLoad: boolean): Promise<void> {
  const today = dayKey(new Date());
  for (const [id, d] of Object.entries(readDrafts())) {
    if (inflight.has(id)) continue;
    let cur: JournalEntry | undefined;
    const done = await idb.modify<JournalEntry>('journal', id, (c) => {
      cur = c;
      return c ? applyDraft(c, d, today) : undefined;
    });
    settleDraft(id, done ?? cur, [], onLoad);
    if (done) announce(id);
  }
}

/**
 * Show `optimistic` at once, then apply `change` to the stored copy in one transaction, so fields
 * another tab saved meanwhile are kept. Writes to one entry land in the order they were made, and
 * the list takes the stored result only after the last of them, so an older write never puts back
 * text the user has typed since. If storage fails the change applies to this tab's copy only.
 * Resolves with the stored result, or null when the write failed.
 */
async function write(id: string, before: JournalEntry, optimistic: JournalEntry, change: (cur: JournalEntry) => JournalEntry): Promise<JournalEntry | null> {
  replace(id, optimistic);
  inflight.set(id, (inflight.get(id) ?? 0) + 1);
  let next: JournalEntry;
  let saved: JournalEntry | null = null;
  try {
    next = saved = (await idb.modify<JournalEntry>('journal', id, (cur) => change(cur ?? before))) ?? optimistic;
    announce(id);
  } catch (err) {
    useJournal.setState({ error: (err as Error).message });
    next = change(before);
  }
  const left = (inflight.get(id) ?? 1) - 1;
  if (left > 0) inflight.set(id, left);
  else {
    inflight.delete(id);
    // Not when the entry was deleted here meanwhile (its delete lands after this write).
    if (useJournal.getState().entries.some((e) => e.id === id)) replace(id, next);
  }
  return saved;
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
  /** Replace the trade review (the notes and everything else stay as stored). */
  updateReview: (id: string, review: TradeReview) => Promise<void>;
  /** Mark one of your own rules followed or broken on a trade (null clears the mark). */
  updateRuleCheck: (id: string, rule: string, followed: boolean | null) => Promise<void>;
}

export const useJournal = create<JournalStore>()((set, get) => ({
  entries: [],
  loaded: false,
  error: null,
  load: async () => {
    try {
      // Finish edits whose write was cut off when a tab closed.
      await finishDrafts(true);
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
    const saved = await write(id, entry, { ...entry, ...retag, notes: { ...entry.notes, ...edits } }, (stored) => {
      // Another tab's edits cut off by its closing travel with this write.
      const cur = applyDraft(stored, readDrafts()[id], today) ?? stored;
      const merged = { ...cur.notes, ...edits };
      // The first note written on a trade marks the day it was reviewed (the practice panel counts
      // them): clearing the notes and writing them again the same day is still the same review.
      const reviewed = !hasNotes(stored.notes) && hasNotes(merged) && stored.reviewedOn !== today;
      return { ...cur, ...retag, notes: merged, ...(reviewed ? { reviewedOn: today } : {}) };
    });
    if (saved) settleDraft(id, saved, [...keys, ...('tag' in retag ? ['tag'] : [])], false);
  },
  remove: async (id) => {
    const entry = get().entries.find((e) => e.id === id);
    set({ entries: get().entries.filter((e) => e.id !== id) });
    settleDraft(id, undefined, [], true);
    await idb.delete('journal', id).catch(() => undefined);
    if (entry?.snapshotKey) await idb.delete('snapshots', entry.snapshotKey).catch(() => undefined);
    announce(id);
  },
  removeWhere: async (pred) => {
    const doomed = get().entries.filter(pred);
    for (const e of doomed) await get().remove(e.id);
    return doomed.length;
  },
  updateReview: async (id, review) => {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry) return;
    await write(id, entry, { ...entry, review }, (stored) => ({ ...stored, review }));
  },
  updateRuleCheck: async (id, rule, followed) => {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry) return;
    // Only this rule's mark: another tab may have marked the others.
    const mark = (e: JournalEntry): JournalEntry => {
      const checks = { ...e.ruleChecks };
      if (followed === null) delete checks[rule];
      else checks[rule] = followed;
      return { ...e, ruleChecks: checks };
    };
    await write(id, entry, mark(entry), mark);
  },
}));

export async function saveSnapshot(key: string, dataUrl: string): Promise<void> {
  await idb.set('snapshots', key, dataUrl);
}

export async function loadSnapshot(key: string): Promise<string | undefined> {
  return idb.get<string>('snapshots', key);
}

// A tab that closed mid-write leaves a draft: an open tab finishes it shortly after (its own write,
// if the tab is still alive, normally lands first and clears it). Then it re-reads every entry
// another tab was saving, since a tab that closes just after its write may never get to tell the
// others (its message is dropped). So an open tab shows the edit and never saves over it.
const draftIds = (v: string | null): string[] => {
  try {
    return Object.keys(JSON.parse(v ?? '{}') ?? {});
  } catch {
    return [];
  }
};
const saving = new Set<string>();
let finishing: ReturnType<typeof setTimeout> | undefined;
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key !== DRAFTS_KEY || !useJournal.getState().loaded) return;
    for (const id of [...draftIds(e.oldValue), ...draftIds(e.newValue)]) saving.add(id);
    clearTimeout(finishing);
    finishing = setTimeout(async () => {
      const ids = [...saving];
      saving.clear();
      try {
        await finishDrafts(false);
        for (const id of ids) {
          if (inflight.has(id) || !useJournal.getState().entries.some((x) => x.id === id)) continue;
          const entry = await stored(id);
          if (entry !== null) replace(id, entry);
        }
      } catch {
        /* the next load tries again */
      }
    }, 1500);
  });

channel?.addEventListener('message', (e: MessageEvent) => {
  if (typeof e.data !== 'string' || !useJournal.getState().loaded) return;
  const id = e.data;
  // This tab's own write in flight reads the stored copy, other tab's change included, when it lands.
  if (inflight.has(id)) return;
  void stored(id).then((entry) => entry !== null && replace(id, entry));
});
