/**
 * Where the candles after the last one will fall, so a chart can place things to the right of the
 * data on the bars that will later fill those slots. Candles follow the exchange calendar: the
 * session hours of the last full day of data (shortened on early-close days) on trading days, one
 * per trading day on 1D. Nothing here looks at future data; it only extends the calendar.
 */
import type { Bar, Timeframe, UnixSeconds } from '../types';
import { TIMEFRAME_MINUTES } from '../types';
import { AFTERHOURS_CLOSE, PREMARKET_OPEN, REGULAR_OPEN, exchangeDate, exchangeMinuteOfDay, exchangeTimeToUnix, nextTradingDay, regularCloseMinute } from '../time';
import { bucketFor } from './aggregate';

export interface CandleCalendar {
  /** Start of the candle after the one starting at `t`. */
  next: (t: UnixSeconds) => UnixSeconds;
  /** Candle slots from the candle starting at `from` to time `t` (t >= from), with t's fraction through its candle. */
  slots: (from: UnixSeconds, t: UnixSeconds) => number;
  /** Start of the candle `k` (a whole number >= 0) slots after the one starting at `from`. */
  after: (from: UnixSeconds, k: number) => UnixSeconds;
}

/** Days walked at most, so bad input can never hang the caller (about 40 years of trading days). */
const MAX_DAYS = 10_000;

/** `candles` are aggregated to `timeframe`, oldest first. */
export function candleCalendar(candles: readonly Bar[], timeframe: Timeframe): CandleCalendar {
  const step = TIMEFRAME_MINUTES[timeframe] * 60;
  if (timeframe === '1D') {
    const next = (t: UnixSeconds) => exchangeTimeToUnix(nextTradingDay(exchangeDate(t)), REGULAR_OPEN);
    return calendar(step, next, (t) => t);
  }
  const { openMin, lastMin, refClose } = sessionHours(candles, timeframe);
  // The last candle of a day, snapped to the bucket grid (an early close moves it).
  const lastOf = (date: string): UnixSeconds => bucketFor(exchangeTimeToUnix(date, lastMin + regularCloseMinute(date) - refClose), timeframe).start;
  const next = (t: UnixSeconds): UnixSeconds => {
    const date = exchangeDate(t);
    // Trading days never contain a DST switch (those happen early on Sundays), so a day's candles are evenly spaced.
    return t < lastOf(date) ? t + step : exchangeTimeToUnix(nextTradingDay(date), openMin);
  };
  return calendar(step, next, (t) => Math.max(t, lastOf(exchangeDate(t))));
}

function calendar(step: number, next: (t: UnixSeconds) => UnixSeconds, dayLast: (t: UnixSeconds) => UnixSeconds): CandleCalendar {
  return {
    next,
    slots: (from, t) => {
      let c = from;
      let k = 0;
      for (let n = 0; n < MAX_DAYS; n++) {
        const last = dayLast(c);
        if (t < last + step) return k + (t - c) / step;
        k += Math.round((last - c) / step) + 1;
        const first = next(last);
        // A time between sessions belongs to the next session's first candle, as between real candles.
        if (t < first) return k;
        c = first;
      }
      return k;
    },
    after: (from, k) => {
      let c = from;
      for (let n = 0; n < MAX_DAYS && k > 0; n++) {
        const last = dayLast(c);
        const left = Math.round((last - c) / step);
        if (k <= left) return c + k * step;
        k -= left + 1;
        c = next(last);
      }
      return c;
    },
  };
}

/**
 * The first and last candle of a session, as minutes after midnight, taken from the last full day
 * in the data (the newest day may still be forming). With a single day of data, the standard
 * session: extended hours when that day has pre-market or after-hours candles.
 */
function sessionHours(candles: readonly Bar[], timeframe: Timeframe): { openMin: number; lastMin: number; refClose: number } {
  const n = candles.length;
  if (n) {
    const newest = exchangeDate(candles[n - 1].time);
    let j = n - 1;
    while (j >= 0 && exchangeDate(candles[j].time) === newest) j--;
    if (j >= 0) {
      const day = exchangeDate(candles[j].time);
      let f = j;
      while (f > 0 && exchangeDate(candles[f - 1].time) === day) f--;
      return { openMin: exchangeMinuteOfDay(candles[f].time), lastMin: exchangeMinuteOfDay(candles[j].time), refClose: regularCloseMinute(day) };
    }
  }
  const date = n ? exchangeDate(candles[0].time) : '2024-01-02';
  const close = regularCloseMinute(date);
  const extended = n > 0 && (exchangeMinuteOfDay(candles[0].time) < REGULAR_OPEN || exchangeMinuteOfDay(candles[n - 1].time) >= close);
  const first = bucketFor(exchangeTimeToUnix(date, extended ? PREMARKET_OPEN : REGULAR_OPEN), timeframe).start;
  const last = bucketFor(exchangeTimeToUnix(date, (extended ? Math.min(AFTERHOURS_CLOSE, close + 240) : close) - 1), timeframe).start;
  return { openMin: exchangeMinuteOfDay(first), lastMin: exchangeMinuteOfDay(last), refClose: close };
}
