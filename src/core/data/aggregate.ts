/**
 * Aggregates base-resolution bars (normally 1m) into display timeframes.
 *
 * Intraday buckets are anchored to the 09:30 ET open so 30m/1h/4h candles line up with the
 * regular session the way most terminals draw them. At the data's own bar size (or finer), each
 * bar is its own candle where the vendor placed it: hourly bars on the clock hour, a 09:30-10:00
 * first hourly bar, 4-hour bars from 04:00. Daily candles cover the regular session only
 * (falling back to all bars if a day has no regular-session data, e.g. a pre-market-only feed).
 *
 * Aggregating only the bars that have been revealed produces a correctly *forming* last candle,
 * which is exactly how a live chart looks mid-bar. This module never sees future bars because
 * callers only pass it revealed data.
 */
import type { Bar, Timeframe, UnixSeconds } from '../types';
import { TIMEFRAMES, TIMEFRAME_MINUTES } from '../types';
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

/** Whether a `timeframe` chart of `baseTimeframe` data shows each bar as its own candle. */
export function ownCandles(timeframe: Timeframe, baseTimeframe: Timeframe): boolean {
  return timeframe !== '1D' && TIMEFRAMES.indexOf(timeframe) <= TIMEFRAMES.indexOf(baseTimeframe);
}

/** The candle that the base bar starting at `time` belongs to on a `timeframe` chart of `baseTimeframe` data. */
export function candleFor(time: UnixSeconds, timeframe: Timeframe, baseTimeframe: Timeframe): BucketKey {
  return ownCandles(timeframe, baseTimeframe) ? { key: String(time), start: time } : bucketFor(time, timeframe);
}

/** Batch aggregation of chronologically sorted base bars. */
export function aggregateBars(bars: readonly Bar[], timeframe: Timeframe, baseTimeframe: Timeframe = '1m'): Bar[] {
  if (ownCandles(timeframe, baseTimeframe)) return bars.map((b) => ({ ...b }));
  const agg = new BarAggregator(timeframe, baseTimeframe);
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

  constructor(
    readonly timeframe: Timeframe,
    readonly baseTimeframe: Timeframe = '1m',
  ) {}

  push(bar: Bar): { bar: Bar; isNew: boolean } | null {
    const { key, start } = candleFor(bar.time, this.timeframe, this.baseTimeframe);
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
