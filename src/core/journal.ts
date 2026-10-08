/** Journal entries: one per completed round trip, created automatically, annotated by the user. */
import type { DataSourceKind, RoundTrip, UnixSeconds } from './types';
import { returnPct } from './analytics/stats';
import type { TradeReview } from './learning/review';

export interface JournalNotes {
  why: string;
  setup: string;
  good: string;
  bad: string;
  change: string;
  other: string;
}

export const EMPTY_NOTES: JournalNotes = { why: '', setup: '', good: '', bad: '', change: '', other: '' };

export interface JournalEntry {
  id: string;
  sessionId: string;
  mode: 'replay' | 'sim';
  source: DataSourceKind;
  symbol: string;
  direction: 'long' | 'short';
  entryTime: UnixSeconds;
  exitTime: UnixSeconds;
  avgEntry: number;
  avgExit: number;
  quantity: number;
  stopLoss?: number;
  takeProfit?: number;
  pnl: number;
  returnPct: number;
  holdingSeconds: number;
  commission: number;
  tag: string;
  notes: JournalNotes;
  /** Key of the chart snapshot image in storage, if one was captured. */
  snapshotKey?: string;
  review?: TradeReview;
  /** The session had been rewound when this trade closed (not a blind result). */
  rewound: boolean;
  /** Traded in blind mode: dates stay hidden while that session is still running. */
  blind?: boolean;
  /** Full round trip, kept for analytics. */
  trip: RoundTrip;
  createdAt: number;
  /** Local day (YYYY-MM-DD) this trade last counted as reviewed for the practice streak. */
  reviewedOn?: string;
}

export function journalEntryFromTrip(trip: RoundTrip, ctx: { sessionId: string; mode: 'replay' | 'sim'; rewound: boolean; blind?: boolean }): JournalEntry {
  if (!trip.closed || trip.exitTime === undefined || trip.avgExit === undefined) throw new Error('Trip is not closed');
  return {
    id: `${ctx.sessionId}:${trip.id}`,
    sessionId: ctx.sessionId,
    mode: ctx.mode,
    source: trip.source,
    symbol: trip.symbol,
    direction: trip.direction,
    entryTime: trip.entryTime,
    exitTime: trip.exitTime,
    avgEntry: trip.avgEntry,
    avgExit: trip.avgExit,
    quantity: trip.maxQuantity,
    stopLoss: trip.initialStop,
    takeProfit: trip.initialTarget,
    pnl: trip.pnl,
    returnPct: returnPct(trip),
    holdingSeconds: trip.exitTime - trip.entryTime,
    commission: trip.commission,
    tag: trip.tag ?? '',
    notes: { ...EMPTY_NOTES },
    rewound: ctx.rewound,
    blind: ctx.blind,
    trip: { ...trip },
    createdAt: Date.now(),
  };
}
