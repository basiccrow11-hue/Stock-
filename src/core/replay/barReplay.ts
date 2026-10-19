/**
 * Bar Replay: a replay started from a moment picked on the chart, as in TradingView. Click a candle and
 * the replay starts at its end, that candle the last one shown, or start at a date and time, or at a
 * random day's open. Everything here is worked out from bars the chart already shows (and the calendar):
 * where the replay starts, how long it plays on, and at what speed.
 */
import type { Bar, Timeframe, UnixSeconds } from '../types';
import { TIMEFRAME_MINUTES } from '../types';
import { candleFor, ownCandles } from '../data/aggregate';
import { lastIndexAtOrBefore } from '../util/math';
import { afterHoursCloseMinute, exchangeDate, exchangeMinuteOfDay, exchangeTimeToUnix, nextTradingDay, prevTradingDay, tradingDayOnOrAfter } from '../time';

/**
 * When the replay cut at the `timeframe` candle starting at `start` begins: the end of that candle, so it
 * is the last one shown, complete, and the next bar is the first one after it. `bars` are the chart's bars
 * (its data's, of `barTimeframe`, or its history's), oldest first, and `ends` when each ends (barEnds).
 *
 * Counted by the chart's own candles (candleFor): an intraday candle ends where its slot does (a 4-hour
 * candle from 13:30 at 17:30), but never later than that day's after-hours close (20:00, 17:00 on an early
 * close), where its data ends; a daily candle at that close, so all of its day is in and the next candle is
 * the next day; a candle that is one of the data's own bars (a chart at the data's bar size or finer) where
 * that bar ends. Never before the candle's last bar has ended, whichever comes later (an hourly bar from
 * 13:00 in a 4-hour candle that ends at 13:30). Null when no bar is in that candle.
 */
export function cutTime(start: UnixSeconds, timeframe: Timeframe, bars: readonly Bar[], ends: readonly UnixSeconds[], barTimeframe: Timeframe): UnixSeconds | null {
  // A daily candle starts at the 09:30 open, after its day's pre-market bars.
  const from = timeframe === '1D' ? exchangeTimeToUnix(exchangeDate(start), 0) : start;
  let last = -1;
  for (let i = lastIndexAtOrBefore(bars, from - 1, (b) => b.time) + 1; i < bars.length && candleFor(bars[i].time, timeframe, barTimeframe).start === start; i++) last = i;
  if (last < 0) return null;
  const barEnd = ends[last];
  const day = exchangeDate(bars[last].time);
  const dayEnd = exchangeTimeToUnix(day, afterHoursCloseMinute(day));
  let t: UnixSeconds;
  if (timeframe === '1D') t = Math.max(dayEnd, barEnd);
  else if (ownCandles(timeframe, barTimeframe)) t = barEnd;
  else t = Math.max(Math.min(start + TIMEFRAME_MINUTES[timeframe] * 60, dayEnd), barEnd);
  // A replay starts on a whole minute; the next bar opens at or after the candle's end, and lasts longer.
  return Math.ceil(t / 60) * 60;
}

/**
 * Trading days a bar replay plays on after the day it starts, by chart timeframe: about a week of
 * 1-minute or 5-minute candles, a few weeks to a few months of intraday ones, a year of daily ones.
 */
export const PLAY_ON_DAYS: Record<Timeframe, number> = { '1m': 5, '5m': 5, '15m': 10, '30m': 20, '1h': 40, '4h': 120, '1D': 250 };

/**
 * The last day of a bar replay starting on `day` on a `timeframe` chart: PLAY_ON_DAYS trading days on,
 * but never past `lastDay`, the end of the data, nor (`days`: the days an imported file has bars on, when
 * it can have gaps) across a trading day the data has no bars for, so the replay never plays empty days.
 */
export function playOnEndDate(day: string, timeframe: Timeframe, lastDay: string, days?: readonly string[] | null): string {
  const has = days ? new Set(days) : null;
  let end = day;
  for (let k = 0; k < PLAY_ON_DAYS[timeframe]; k++) {
    const next = nextTradingDay(end);
    if (next > lastDay || (has && !has.has(next))) break;
    end = next;
  }
  return end;
}

/** Trading days of bars before the one asked about that, with it, tell when the data's sessions end (sessionEndMinute). */
export const HOURS_DAYS = 5;

/**
 * When the data's sessions end, in minutes of the exchange day: the latest any of `bars` (with `ends`) ends
 * on the HOURS_DAYS trading days up to `day`, as the replay reads a stock's hours from its recent bars
 * (16:00 for regular-hours data, 20:00 with the after-hours). Null when none of `bars` is in those days.
 * A bar replay ends there on its last day, so it never plays an after-hours the data does not have.
 */
export function sessionEndMinute(bars: readonly Bar[], ends: readonly UnixSeconds[], day: string): number | null {
  let from = day;
  for (let i = 0; i < HOURS_DAYS; i++) from = prevTradingDay(from);
  const since = exchangeTimeToUnix(from, 0);
  const until = exchangeTimeToUnix(nextTradingDay(day), 0);
  let close: number | null = null;
  for (let i = lastIndexAtOrBefore(bars, since - 1, (b) => b.time) + 1; i < bars.length && bars[i].time < until; i++) {
    const end = Math.min(24 * 60, exchangeMinuteOfDay(bars[i].time) + (ends[i] - bars[i].time) / 60);
    close = Math.max(close ?? 0, end);
  }
  return close;
}

/** `minutes` after exchange midnight as HH:MM (24:00 is written 23:59, the latest a time field takes). */
export function hhmm(minutes: number): string {
  const m = Math.min(23 * 60 + 59, Math.max(0, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * The speed of `speeds` (simulated seconds per real second) that plays about one `timeframe` candle a
 * second: the nearest by ratio, so 15-minute candles take 1.5 s at 600x rather than half a second at 1800x.
 * A daily candle counts as one regular session (the fastest speed).
 */
export function candleSpeed(timeframe: Timeframe, speeds: readonly number[]): number {
  const seconds = timeframe === '1D' ? 6.5 * 3600 : TIMEFRAME_MINUTES[timeframe] * 60;
  let best = speeds[0];
  for (const s of speeds) if (Math.abs(Math.log(s / seconds)) < Math.abs(Math.log(best / seconds))) best = s;
  return best;
}

/**
 * A trading day from `from` to `to` (both included), each as likely as the next, for Random bar: from
 * `days` when the data has gaps (an imported file's days with bars). Null when there is none.
 */
export function randomDay(from: string, to: string, days?: readonly string[] | null, rand: () => number = Math.random): string | null {
  const pool: string[] = [];
  if (days) {
    for (const d of days) if (d >= from && d <= to) pool.push(d);
  } else {
    for (let d = tradingDayOnOrAfter(from); d <= to; d = nextTradingDay(d)) pool.push(d);
  }
  return pool.length ? pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))] : null;
}
