import type { JournalEntry } from '../../core/journal';
import { formatExchangeTime } from '../../core/time';
import { dateTime } from '../services/format';
import { useLiveBlind } from '../state/liveBlind';
import { blindDayLabel, useTrading } from '../state/tradingStore';

/** For an entry from a blind session still running (in this tab or another), that session's start date; else null. */
function useBlindStart(): (entry: JournalEntry) => string | null {
  const session = useTrading((s) => s.session);
  const live = useLiveBlind((s) => s.sessions);
  return (entry) => {
    if (!entry.blind) return null;
    if (session?.blind && entry.sessionId === session.id) return session.startDate;
    return live[entry.sessionId] ?? null;
  };
}

/** Whether an entry comes from a blind session still running, whose calendar date stays hidden. */
export function useDateHidden(): (entry: JournalEntry) => boolean {
  const start = useBlindStart();
  return (entry) => start(entry) !== null;
}

/**
 * Formats a journal entry's times. While the blind session that produced the trade is still
 * running, in any tab, the calendar date stays hidden ("Day 2 10:15") wherever the entry is shown.
 */
export function useEntryTime(): (entry: JournalEntry, t: number) => string {
  const start = useBlindStart();
  return (entry, t) => {
    const s = start(entry);
    return s !== null ? `${blindDayLabel(t, s)} ${formatExchangeTime(t)}` : dateTime(t);
  };
}
