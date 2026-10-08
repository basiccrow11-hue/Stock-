// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_NOTES, type JournalEntry } from '../../core/journal';

vi.mock('../services/idb', () => ({
  idb: { all: async () => [], set: async () => undefined, delete: async () => undefined, get: async () => undefined },
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
