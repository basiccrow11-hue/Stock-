/**
 * Aggregates base-resolution bars (normally 1m) into display timeframes.
 *
 * Intraday buckets are anchored to the 09:30 ET open so 30m/1h/4h candles line up with the
 * regular session the way most terminals draw them. Daily candles cover the regular session only
 * (falling back to all bars if a day has no regular-session data, e.g. a pre-market-only feed).
 *
 * Aggregating only the bars that have been revealed produces a correctly *forming* last candle,
 * which is exactly how a live chart looks mid-bar. This module never sees future bars because
 * callers only pass it revealed data.
 */
import type { Bar, Timeframe, UnixSeconds } from '../types';
import { TIMEFRAME_MINUTES } from '../types';
import { REGULAR_OPEN, exchangeDate, exchangeMinuteOfDay, exchangeTimeToUnix, marketSession } from '../time';

export interface BucketKey {
  key: string;
  start: UnixSeconds;
}

export function bucketFor(time: UnixSeconds, timeframe: Timeframe): BucketKey {
  const date = exchangeDate(time);
  if (timeframe === '1D') return { key: date, start: exchangeTimeToUnix(date, REGULAR_OPEN) };
  const n = TIMEFRAME_MINUTES[timeframe];
  const mod = exchangeMinuteOfDay(time);
  const idx = Math.floor((mod - REGULAR_OPEN) / n);
  // Bucket start = this bar's time moved back to the bucket boundary (same exchange day, no DST jump inside a day's session).
  return { key: `${date}#${idx}`, start: time - (mod - (REGULAR_OPEN + idx * n)) * 60 - (time % 60) };
}

/** Batch aggregation of chronologically sorted base bars. */
export function aggregateBars(bars: readonly Bar[], timeframe: Timeframe, baseTimeframe: Timeframe = '1m'): Bar[] {
  if (timeframe === baseTimeframe) return bars.map((b) => ({ ...b }));
  const agg = new BarAggregator(timeframe);
  const out: Bar[] = [];
  for (const b of bars) {
    const r = agg.push(b);
    if (!r) continue;
    if (r.isNew) out.push(r.bar);
    else out[out.length - 1] = r.bar;
  }
  return out;
}

/**
 * Incremental aggregator: feed base bars one at a time; get back the candle they belong to and
 * whether it is a new candle or an update of the forming one.
 */
export class BarAggregator {
  private current: Bar | null = null;
  private currentKey = '';
  /** For daily bars: whether the current day already has regular-session data. */
  private currentHasRegular = false;

  constructor(readonly timeframe: Timeframe) {}

  push(bar: Bar): { bar: Bar; isNew: boolean } | null {
    const { key, start } = bucketFor(bar.time, this.timeframe);
    const isDaily = this.timeframe === '1D';
    const regular = !isDaily || marketSession(bar.time) === 'regular';

    if (key !== this.currentKey || !this.current) {
      this.currentKey = key;
      this.current = { time: start, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
      this.currentHasRegular = regular;
      return { bar: { ...this.current }, isNew: true };
    }

    const c = this.current;
    if (isDaily) {
      if (!regular && this.currentHasRegular) return { bar: { ...c }, isNew: false }; // ignore post-market in daily candle
      if (regular && !this.currentHasRegular) {
        // First regular-session bar replaces the pre-market placeholder candle.
        this.current = { time: start, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
        this.currentHasRegular = true;
        return { bar: { ...this.current }, isNew: false };
      }
    }
    c.high = Math.max(c.high, bar.high);
    c.low = Math.min(c.low, bar.low);
    c.close = bar.close;
    c.volume += bar.volume;
    return { bar: { ...c }, isNew: false };
  }

  reset(): void {
    this.current = null;
    this.currentKey = '';
    this.currentHasRegular = false;
  }
}

/** Filter to regular trading hours. */
export function regularSessionOnly(bars: readonly Bar[]): Bar[] {
  return bars.filter((b) => marketSession(b.time) === 'regular');
}

/**
 * Adds bars that continue `base` (oldest first) in place: one with the last bar's time is that bar
 * in a later state and replaces it, later ones are appended, older ones are already held and
 * skipped. Returns the index of the first bar changed, or -1 when nothing changed.
 */
export function mergeBars(base: Bar[], bars: readonly Bar[]): number {
  let from = -1;
  for (const b of bars) {
    const last = base[base.length - 1];
    if (last && b.time < last.time) continue;
    if (last && b.time === last.time) base[base.length - 1] = { ...b };
    else base.push({ ...b });
    if (from < 0) from = base.length - 1;
  }
  return from;
}
