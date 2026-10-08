/**
 * Where the candles after the last one will fall, so a chart can place things to the right of the
 * data on the bars that will later fill those slots. Candles follow the exchange calendar: the
 * session hours the data has (regular or extended, shorter on early-close days) on trading days,
 * one per trading day on 1D. Nothing here looks at future data; it only extends the calendar.
 * Distances are counted arithmetically, so a point years past the data costs no more than one
 * near it (charts project every point on every frame).
 */
import type { Bar, Timeframe, UnixSeconds } from '../types';
import { TIMEFRAME_MINUTES } from '../types';
import {
  AFTERHOURS_CLOSE,
  PREMARKET_OPEN,
  REGULAR_OPEN,
  addDays,
  earlyCloses,
  exchangeDate,
  exchangeMinuteOfDay,
  exchangeTimeToUnix,
  isTradingDay,
  nextTradingDay,
  parseDate,
  prevTradingDay,
  regularCloseMinute,
  tradingDayOnOrAfter,
  tradingDaysBetween,
} from '../time';
import { bucketFor } from './aggregate';

export interface CandleCalendar {
  /** Start of the candle after the one starting at `t`. */
  next: (t: UnixSeconds) => UnixSeconds;
  /**
   * Candle slots from the candle starting at `from` to time `t` (t >= from): whole slots to the
   * candle at or before t, plus t's fraction through it (a time between sessions counts as the
   * next session's first candle, as between real candles).
   */
  slots: (from: UnixSeconds, t: UnixSeconds) => number;
  /** Start of the candle `k` (a whole number >= 0) slots after the one starting at `from`. */
  after: (from: UnixSeconds, k: number) => UnixSeconds;
}

/** A trading day without an early close, to count a normal day's candles. */
const NORMAL_DAY = '2024-03-12';

/** `candles` are aggregated to `timeframe`, oldest first. */
export function candleCalendar(candles: readonly Bar[], timeframe: Timeframe): CandleCalendar {
  const daily = timeframe === '1D';
  const step = daily ? 86_400 : TIMEFRAME_MINUTES[timeframe] * 60;
  const { firstOf, lastOf } = daily ? dailyCandles() : sessionCandles(candles, timeframe);
  const perDay = (date: string) => Math.round((lastOf(date) - firstOf(date)) / step) + 1;
  const normal = perDay(NORMAL_DAY);

  /** Candle slots on the trading days in [a, b). */
  const slotsIn = (a: string, b: string): number => {
    if (b <= a) return 0;
    let n = tradingDaysBetween(a, b) * normal;
    for (let y = parseDate(a).y; y <= parseDate(b).y; y++) for (const e of earlyCloses(y)) if (e >= a && e < b) n -= normal - perDay(e);
    return n;
  };

  /** Slots from the first candle of trading day `day` to the candle starting at `c`. */
  const inDay = (day: string, c: UnixSeconds) => (c - firstOf(day)) / step;

  return {
    next: (t) => {
      const date = exchangeDate(t);
      // Trading days never contain a DST switch (those happen early on Sundays): a day's candles are evenly spaced.
      return t < lastOf(date) ? t + step : firstOf(nextTradingDay(date));
    },
    slots: (from, t) => {
      const fromDay = exchangeDate(from);
      // The candle at or before t.
      const date = exchangeDate(t);
      let day = date;
      let c: UnixSeconds;
      if (isTradingDay(date) && t >= firstOf(date)) c = Math.min(firstOf(date) + Math.floor((t - firstOf(date)) / step) * step, lastOf(date));
      else c = lastOf((day = prevTradingDay(date)));
      if (c < from) {
        c = from;
        day = fromDay;
      }
      const whole = slotsIn(fromDay, day) + inDay(day, c) - inDay(fromDay, from);
      return whole + Math.min(1, (t - c) / step);
    },
    after: (from, k) => {
      const fromDay = exchangeDate(from);
      const target = inDay(fromDay, from) + k;
      let day = fromDay;
      let passed = 0;
      // Gallop: whole decades, years, weeks, then days.
      for (const chunk of [3653, 365, 28, 7, 1]) {
        for (;;) {
          const to = tradingDayOnOrAfter(addDays(day, chunk));
          const add = slotsIn(day, to);
          if (passed + add > target) break;
          passed += add;
          day = to;
        }
      }
      return firstOf(day) + (target - passed) * step;
    },
  };
}

function dailyCandles() {
  const at = (date: string) => exchangeTimeToUnix(date, REGULAR_OPEN);
  return { firstOf: at, lastOf: at };
}

/**
 * The first and last candle of each day. The data's own first candle of its last full day sets
 * the open (the newest day may still be forming). The last candle is the one holding the session's
 * final minute: after-hours when the data has extended hours, else the regular close, both earlier
 * on early-close days. Data whose sessions end elsewhere keeps its own last candle, moved by the
 * early close.
 */
function sessionCandles(candles: readonly Bar[], timeframe: Timeframe) {
  const n = candles.length;
  let refDay: string | null = null;
  let openMin = REGULAR_OPEN;
  let lastMin = REGULAR_OPEN;
  if (n) {
    const newest = exchangeDate(candles[n - 1].time);
    let j = n - 1;
    while (j >= 0 && exchangeDate(candles[j].time) === newest) j--;
    if (j >= 0) {
      refDay = exchangeDate(candles[j].time);
      let f = j;
      while (f > 0 && exchangeDate(candles[f - 1].time) === refDay) f--;
      openMin = exchangeMinuteOfDay(candles[f].time);
      lastMin = exchangeMinuteOfDay(candles[j].time);
    }
  }
  const day0 = refDay ?? (n ? exchangeDate(candles[0].time) : NORMAL_DAY);
  const extended = n > 0 && (refDay ? openMin < REGULAR_OPEN || lastMin >= regularCloseMinute(refDay) : exchangeMinuteOfDay(candles[0].time) < REGULAR_OPEN || exchangeMinuteOfDay(candles[n - 1].time) >= regularCloseMinute(day0));
  const bucketAt = (date: string, min: number) => bucketFor(exchangeTimeToUnix(date, min), timeframe).start;
  const sessionEnd = (date: string) => (extended ? Math.min(AFTERHOURS_CLOSE, regularCloseMinute(date) + 240) : regularCloseMinute(date));
  if (!refDay) openMin = exchangeMinuteOfDay(bucketAt(day0, extended ? PREMARKET_OPEN : REGULAR_OPEN));
  const standard = !refDay || exchangeMinuteOfDay(bucketAt(refDay, sessionEnd(refDay) - 1)) === lastMin;
  const ref = refDay;
  return {
    firstOf: (date: string) => exchangeTimeToUnix(date, openMin),
    lastOf: (date: string) => (standard ? bucketAt(date, sessionEnd(date) - 1) : bucketAt(date, lastMin + regularCloseMinute(date) - regularCloseMinute(ref!))),
  };
}
