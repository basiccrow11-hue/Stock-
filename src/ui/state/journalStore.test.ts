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
