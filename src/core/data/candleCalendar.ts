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
  afterHoursCloseMinute,
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
const DAY_MINUTES = 24 * 60;

/** The start minutes (exchange time, ascending) of a trading day's candles. */
type DayCandles = (date: string) => readonly number[];

/** `candles` are the chart's candles on `timeframe`, oldest first. */
export function candleCalendar(candles: readonly Bar[], timeframe: Timeframe): CandleCalendar {
  const daily = timeframe === '1D';
  const step = daily ? 86_400 : TIMEFRAME_MINUTES[timeframe] * 60;
  const daysCandles: DayCandles = daily ? () => [REGULAR_OPEN] : sessionCandles(candles, timeframe);
  const cache = new Map<string, readonly number[]>();
  const minutesOn = (date: string) => {
    let m = cache.get(date);
    if (!m) cache.set(date, (m = daysCandles(date)));
    return m;
  };

  /** Index of the last candle on `date` starting at or before minute `m` (-1 if none). */
  const atOrBefore = (date: string, m: number) => {
    const minutes = minutesOn(date);
    let lo = 0;
    let hi = minutes.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (minutes[mid] <= m) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  };
  /** Candles on trading day `date`. */
  const count = (date: string) => minutesOn(date).length;
  const at = (date: string, k: number) => exchangeTimeToUnix(date, minutesOn(date)[k]);
  /** Minute of the exchange day, with seconds as a fraction. */
  const minuteOf = (t: UnixSeconds) => exchangeMinuteOfDay(t) + (t % 60) / 60;
  /** Index of the candle on `date` that `t` (at or after the day's first candle) falls in. */
  const index = (date: string, t: UnixSeconds) => Math.max(0, atOrBefore(date, minuteOf(t)));
  const normal = count(NORMAL_DAY);

  /** Candle slots on the trading days in [a, b). */
  const slotsIn = (a: string, b: string): number => {
    if (b <= a) return 0;
    let n = tradingDaysBetween(a, b) * normal;
    for (let y = parseDate(a).y; y <= parseDate(b).y; y++) for (const e of earlyCloses(y)) if (e >= a && e < b) n -= normal - count(e);
    return n;
  };

  return {
    next: (t) => {
      const date = exchangeDate(t);
      if (isTradingDay(date)) {
        const k = atOrBefore(date, minuteOf(t)) + 1;
        if (k < count(date)) return at(date, k);
      }
      return at(nextTradingDay(date), 0);
    },
    slots: (from, t) => {
      const fromDay = exchangeDate(from);
      // The candle at or before t.
      const date = exchangeDate(t);
      let day = date;
      let k: number;
      if (isTradingDay(date) && t >= at(date, 0)) k = index(date, t);
      else k = count((day = prevTradingDay(date))) - 1;
      let c = at(day, k);
      if (c < from) {
        c = from;
        day = fromDay;
        k = index(fromDay, from);
      }
      const whole = slotsIn(fromDay, day) + k - index(fromDay, from);
      // The candle's own length: a day's short first candle (a 09:30-10:00 hourly bar) is crossed faster.
      const len = k + 1 < count(day) ? Math.min(step, at(day, k + 1) - c) : step;
      return whole + Math.min(1, (t - c) / len);
    },
    after: (from, k) => {
      const fromDay = exchangeDate(from);
      const target = index(fromDay, from) + k;
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
      return at(day, target - passed);
    },
  };
}

/**
 * The candles of each day, from the data's last full day (the newest day may still be forming):
 * its own candles set the open and where they fall, so bars a vendor placed on the clock hour (or a
 * 09:30-10:00 first hourly bar) keep their places; gaps wider than a candle are filled at the
 * timeframe's step, and the steps run on past its last candle so a normal day can follow an early
 * close. A day ends with the candle holding the session's final minute (after-hours when the data
 * has extended hours, else the regular close, both earlier on early-close days). After-hours bars
 * that start at the close (yfinance's hourly 15:30 then 16:00) start at an early close too. Data
 * whose sessions end elsewhere keeps its own last candle, moved by the early close.
 */
function sessionCandles(candles: readonly Bar[], timeframe: Timeframe): DayCandles {
  const stepMin = TIMEFRAME_MINUTES[timeframe];
  const n = candles.length;
  const minutesOn = (from: number, date: string) => {
    const out: number[] = [];
    for (let i = from; i < n && exchangeDate(candles[i].time) === date; i++) out.push(exchangeMinuteOfDay(candles[i].time));
    return out;
  };
  let refDay: string | null = null;
  let mins: number[] = [];
  if (n) {
    const newest = exchangeDate(candles[n - 1].time);
    let j = n - 1;
    while (j >= 0 && exchangeDate(candles[j].time) === newest) j--;
    if (j >= 0) {
      refDay = exchangeDate(candles[j].time);
      let f = j;
      while (f > 0 && exchangeDate(candles[f - 1].time) === refDay) f--;
      mins = minutesOn(f, refDay);
    }
  }
  const ref = refDay ?? (n ? exchangeDate(candles[0].time) : NORMAL_DAY);
  if (!refDay && n) mins = minutesOn(0, ref);
  const openMin = mins.length ? mins[0] : REGULAR_OPEN;
  const lastMin = mins.length ? mins[mins.length - 1] : REGULAR_OPEN;
  const refClose = regularCloseMinute(ref);
  const extended = n > 0 && (openMin < REGULAR_OPEN || lastMin >= refClose);
  const sessionEnd = (date: string) => (extended ? afterHoursCloseMinute(date) : regularCloseMinute(date));
  if (!refDay) {
    // One (partial) day of data: the standard session, from its open.
    const open = extended ? PREMARKET_OPEN : REGULAR_OPEN;
    const onGrid = mins.every((m) => (((m - REGULAR_OPEN) % stepMin) + stepMin) % stepMin === 0);
    if (!mins.length || onGrid) mins = [exchangeMinuteOfDay(bucketFor(exchangeTimeToUnix(ref, open), timeframe).start)];
    else while (mins[0] > open) mins.unshift(Math.max(mins[0] - stepMin, open));
  }
  /** `from` with gaps wider than a candle filled, run on at the step while below `end`. */
  const filled = (from: readonly number[], end: number) => {
    const out: number[] = [];
    for (const m of from) {
      while (out.length && out[out.length - 1] + stepMin < m) out.push(out[out.length - 1] + stepMin);
      if (!out.length || out[out.length - 1] < m) out.push(m);
    }
    while (out.length && out[out.length - 1] + stepMin < end) out.push(out[out.length - 1] + stepMin);
    return out;
  };
  // The reference day's last candle holds its session's final minute: every day ends the same way.
  const standard = !refDay || (lastMin <= sessionEnd(ref) - 1 && sessionEnd(ref) - 1 < lastMin + stepMin);
  const atClose = mins.indexOf(refClose);
  // After-hours candles restart at the close (less than a step after the candle before).
  const fromClose = standard && extended && atClose > 0 && refClose - mins[atClose - 1] < stepMin;
  const upTo = (list: number[], limit: number) => {
    let k = list.length;
    while (k > 1 && list[k - 1] > limit) k--;
    return list.slice(0, k);
  };
  if (!fromClose) {
    const minutes = filled(mins, DAY_MINUTES);
    return (date) => upTo(minutes, standard ? sessionEnd(date) - 1 : lastMin + regularCloseMinute(date) - refClose);
  }
  // Regular-session candles run to the day's close, the after-hours ones from it.
  const regular = mins.slice(0, atClose);
  const after = filled(mins.slice(atClose), DAY_MINUTES).map((m) => m - refClose);
  return (date) => {
    const close = regularCloseMinute(date);
    return upTo([...filled(regular, close).filter((m) => m < close), ...after.map((m) => m + close)], sessionEnd(date) - 1);
  };
}
