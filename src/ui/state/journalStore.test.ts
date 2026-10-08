// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_NOTES, type JournalEntry } from '../../core/journal';

vi.mock('../services/idb', () => ({
  idb: {
    all: async () => [],
    set: async () => undefined,
    delete: async () => undefined,
    get: async () => undefined,
    modify: async (_s: string, _k: string, fn: (v: unknown) => unknown) => fn(undefined),
  },
}));

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('journal reviews', () => {
  it('counts a trade as reviewed once a day, however often its notes are cleared and rewritten', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0));
    vi.resetModules();
    const { useJournal } = await import('./journalStore');
    const { useStreak } = await import('./streakStore');
    useJournal.setState({ entries: [{ id: 't1', notes: { ...EMPTY_NOTES } } as JournalEntry] });
    const reviews = () => {
      const s = useStreak.getState();
      return s.data.days[s.today]?.reviews ?? 0;
    };
    const write = (why: string) => useJournal.getState().updateNotes('t1', { ...EMPTY_NOTES, why });
    await write('breakout');
    expect(reviews()).toBe(1);
    await write('');
    await write('breakout retest');
    expect(reviews()).toBe(1);
    expect(useJournal.getState().entries[0].reviewedOn).toBe('2026-10-08');
  });
});

describe('journal in two tabs', () => {
  it('never writes a stale copy back over notes another tab saved, and counts the review once', async () => {
    vi.doMock('../services/idb', () => {
      const db = ((globalThis as { __journalDb?: Map<string, unknown> }).__journalDb ??= new Map());
      return {
        idb: {
          all: async () => [...db.values()],
          get: async (_s: string, k: string) => db.get(k),
          set: async (_s: string, k: string, v: unknown) => void db.set(k, structuredClone(v)),
          delete: async (_s: string, k: string) => void db.delete(k),
          modify: async (_s: string, k: string, fn: (v: unknown) => unknown) => {
            const next = fn(structuredClone(db.get(k)));
            if (next !== undefined) db.set(k, structuredClone(next));
            return next;
          },
        },
      };
    });
    const db = ((globalThis as { __journalDb?: Map<string, unknown> }).__journalDb ??= new Map());
    db.set('t1', { id: 't1', exitTime: 1, createdAt: 1, notes: { ...EMPTY_NOTES } });
    const { dayKey } = await import('../../core/streak/streak');
    vi.resetModules();
    const a = (await import('./journalStore')).useJournal;
    vi.resetModules();
    const b = (await import('./journalStore')).useJournal;
    await a.getState().load();
    await b.getState().load();
    // Tab A writes the first note. Tab B, not yet told, writes another field from its old copy.
    await a.getState().updateNotes('t1', { ...EMPTY_NOTES, why: 'A' });
    await b.getState().updateNotes('t1', { ...EMPTY_NOTES, setup: 'B' });
    expect((db.get('t1') as JournalEntry).notes).toMatchObject({ why: 'A', setup: 'B' });
    const reviews = JSON.parse(localStorage.getItem('stock-replay-streak')!).days[dayKey(new Date())].reviews;
    expect(reviews).toBe(1);
    // Each tab hears about the other's writes and shows the stored version.
    await new Promise((r) => setTimeout(r, 50));
    expect(a.getState().entries[0].notes).toMatchObject({ why: 'A', setup: 'B' });
    vi.doUnmock('../services/idb');
  });
});

describe('journal edits cut off by closing the tab', () => {
  const entry = (notes: Partial<typeof EMPTY_NOTES> = {}, tag = '') => ({ id: 't1', exitTime: 1, createdAt: 1, tag, notes: { ...EMPTY_NOTES, ...notes } }) as JournalEntry;

  /** A store whose IndexedDB writes either never finish (the tab closed mid-write) or work. */
  async function tab(db: Map<string, unknown>, writes: 'hang' | 'work') {
    vi.resetModules();
    vi.doMock('../services/idb', () => ({
      idb: {
        all: async () => [...db.values()].map((v) => structuredClone(v)),
        get: async (_s: string, k: string) => structuredClone(db.get(k)),
        set: async (_s: string, k: string, v: unknown) => void db.set(k, structuredClone(v)),
        delete: async (_s: string, k: string) => void db.delete(k),
        modify: (_s: string, k: string, fn: (v: unknown) => unknown) => {
          if (writes === 'hang') return new Promise(() => undefined);
          const next = fn(structuredClone(db.get(k)));
          if (next !== undefined) db.set(k, structuredClone(next));
          return Promise.resolve(next);
        },
      },
    }));
    const { useJournal } = await import('./journalStore');
    await useJournal.getState().load();
    return useJournal;
  }

  it('finishes the edit on the next load', async () => {
    const db = new Map<string, unknown>([['t1', entry({ why: 'breakout' })]]);
    const closing = await tab(db, 'hang');
    void closing.getState().updateNotes('t1', { why: 'breakout, retest' }, 'ORB');
    expect((db.get('t1') as JournalEntry).notes.why).toBe('breakout');
    const next = await tab(db, 'work');
    expect(db.get('t1')).toMatchObject({ tag: 'ORB', notes: { why: 'breakout, retest' } });
    expect(next.getState().entries[0]).toMatchObject({ tag: 'ORB', notes: { why: 'breakout, retest' } });
    expect(localStorage.getItem('stock-replay-journal-drafts')).toBeNull();
    vi.doUnmock('../services/idb');
  });

  it('never puts an old edit over a newer one saved in another tab', async () => {
    const db = new Map<string, unknown>([['t1', entry({ why: 'breakout' })]]);
    const closing = await tab(db, 'hang');
    void closing.getState().updateNotes('t1', { why: 'first thought', other: 'note' });
    // Another tab saves the same field meanwhile.
    db.set('t1', entry({ why: 'second thought' }));
    await tab(db, 'work');
    expect((db.get('t1') as JournalEntry).notes).toMatchObject({ why: 'second thought', other: 'note' });
    vi.doUnmock('../services/idb');
  });

  it("keeps a closed tab's edit when another open tab saves the same trade", async () => {
    const db = new Map<string, unknown>([['t1', entry()]]);
    const other = await tab(db, 'work');
    const closing = await tab(db, 'hang');
    void closing.getState().updateNotes('t1', { why: 'breakout over premarket high' });
    await other.getState().updateNotes('t1', {}, 'ORB');
    expect(db.get('t1')).toMatchObject({ tag: 'ORB', notes: { why: 'breakout over premarket high' } });
    expect(other.getState().entries[0].notes.why).toBe('breakout over premarket high');
    expect(localStorage.getItem('stock-replay-journal-drafts')).toBeNull();
    vi.doUnmock('../services/idb');
  });

  it("shows a closed tab's edit in a tab that is already open", async () => {
    const db = new Map<string, unknown>([['t1', entry()]]);
    const other = await tab(db, 'work');
    const closing = await tab(db, 'hang');
    void closing.getState().updateNotes('t1', { why: 'fade at VWAP' });
    window.dispatchEvent(new StorageEvent('storage', { key: 'stock-replay-journal-drafts', newValue: localStorage.getItem('stock-replay-journal-drafts') }));
    await new Promise((r) => setTimeout(r, 1700));
    expect((db.get('t1') as JournalEntry).notes.why).toBe('fade at VWAP');
    expect(other.getState().entries[0].notes.why).toBe('fade at VWAP');
    expect(localStorage.getItem('stock-replay-journal-drafts')).toBeNull();
    vi.doUnmock('../services/idb');
  });

  it('finishes the last of several saves cut off mid-sequence', async () => {
    const db = new Map<string, unknown>([['t1', entry()]]);
    const ok = await tab(db, 'work');
    await ok.getState().updateNotes('t1', { why: 'break' });
    // The next save starts from what the store holds; then the tab closes before it lands.
    const drafts = { t1: { notes: { why: ['break', 'breakout'] } } };
    localStorage.setItem('stock-replay-journal-drafts', JSON.stringify(drafts));
    await tab(db, 'work');
    expect((db.get('t1') as JournalEntry).notes.why).toBe('breakout');
    vi.doUnmock('../services/idb');
  });

  it('leaves nothing behind once a write lands', async () => {
    const db = new Map<string, unknown>([['t1', entry()]]);
    const ok = await tab(db, 'work');
    await ok.getState().updateNotes('t1', { why: 'breakout' });
    expect(localStorage.getItem('stock-replay-journal-drafts')).toBeNull();
    expect((db.get('t1') as JournalEntry).notes.why).toBe('breakout');
    vi.doUnmock('../services/idb');
  });
});
