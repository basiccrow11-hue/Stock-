import type { JournalEntry } from '../../core/journal';
import { formatExchangeTime } from '../../core/time';
import { dateTime } from '../services/format';
import { blindDayLabel, useTrading } from '../state/tradingStore';

/**
 * Formats a journal entry's times. While the blind session that produced the trade is still
 * running, the calendar date stays hidden ("Day 2 10:15") wherever the entry is shown.
 */
export function useEntryTime(): (entry: JournalEntry, t: number) => string {
  const sessionId = useTrading((s) => s.session?.id);
  return (entry, t) => (entry.blind && entry.sessionId === sessionId ? `${blindDayLabel(t)} ${formatExchangeTime(t)}` : dateTime(t));
}
