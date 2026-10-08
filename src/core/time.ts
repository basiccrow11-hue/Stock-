/**
 * Exchange-time helpers. US equities trade on America/New_York time, so every
 * session boundary is computed in that zone (DST-aware via Intl), never in the
 * user's local zone.
 */
import type { UnixSeconds } from './types';

export const EXCHANGE_TZ = 'America/New_York';

/** Minutes after midnight, exchange time. */
export const PREMARKET_OPEN = 4 * 60;
export const REGULAR_OPEN = 9 * 60 + 30;
export const REGULAR_CLOSE = 16 * 60;
export const EARLY_CLOSE = 13 * 60;
export const AFTERHOURS_CLOSE = 20 * 60;

export type MarketSession = 'pre' | 'regular' | 'post' | 'closed';

export interface ExchangeParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EXCHANGE_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});

// Hot path: these helpers run for every bar in replays, charts and backtests. Intl formatting is
// slow, so we only use it to find the UTC offset, cached per UTC hour (US DST switches happen on
// the hour), and derive everything else arithmetically. Calendar info is cached per local day.
const offsetCache = new Map<number, number>();

function offsetFor(t: UnixSeconds): number {
  const h = Math.floor(t / 3600);
  let off = offsetCache.get(h);
  if (off === undefined) {
    const out: Record<string, string> = {};
    for (const p of partsFormatter.formatToParts(new Date(h * 3_600_000))) out[p.type] = p.value;
    const asUtc = Date.UTC(Number(out.year), Number(out.month) - 1, Number(out.day), Number(out.hour), Number(out.minute), Number(out.second)) / 1000;
    off = asUtc - h * 3600;
    if (offsetCache.size > 500_000) offsetCache.clear();
    offsetCache.set(h, off);
  }
  return off;
}

interface DayInfo {
  year: number;
  month: number;
  day: number;
  weekday: number;
  date: string;
}

const dayCache = new Map<number, DayInfo>();

function dayInfo(localDayIndex: number): DayInfo {
  let info = dayCache.get(localDayIndex);
  if (!info) {
    const d = new Date(localDayIndex * 86_400_000);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    info = { year, month, day, weekday: d.getUTCDay(), date: `${year}-${pad2(month)}-${pad2(day)}` };
    if (dayCache.size > 200_000) dayCache.clear();
    dayCache.set(localDayIndex, info);
  }
  return info;
}

export function exchangeParts(t: UnixSeconds): ExchangeParts {
  const local = t + offsetFor(t);
  const di = Math.floor(local / 86400);
  const sec = local - di * 86400;
  const info = dayInfo(di);
  return {
    year: info.year,
    month: info.month,
    day: info.day,
    hour: Math.floor(sec / 3600),
    minute: Math.floor((sec % 3600) / 60),
    second: Math.floor(sec % 60),
    weekday: info.weekday,
  };
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Exchange calendar date (YYYY-MM-DD) for a timestamp. */
export function exchangeDate(t: UnixSeconds): string {
  return dayInfo(Math.floor((t + offsetFor(t)) / 86400)).date;
}

/** Minutes after exchange midnight. */
export function exchangeMinuteOfDay(t: UnixSeconds): number {
  const local = t + offsetFor(t);
  return Math.floor((local - Math.floor(local / 86400) * 86400) / 60);
}

/** Offset of exchange time from UTC in seconds at instant t (e.g. -18000 for EST). */
export function exchangeOffsetSeconds(t: UnixSeconds): number {
  return offsetFor(t);
}

/** Convert an exchange-local date + minute-of-day to a UTC unix timestamp. DST-safe. */
export function exchangeTimeToUnix(date: string, minuteOfDay: number): UnixSeconds {
  const [y, m, d] = date.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, minuteOfDay, 0) / 1000;
  // Two passes handle the DST transition correctly.
  let guess = naive - exchangeOffsetSeconds(naive);
  guess = naive - exchangeOffsetSeconds(guess);
  return guess;
}

export function parseDate(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number);
  return { y, m, d };
}

export function formatDate(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Day of week (0 = Sunday) of a calendar date, independent of time zone. */
export function weekdayOf(date: string): number {
  const { y, m, d } = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(date: string, n: number): string {
  const { y, m, d } = parseDate(date);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return formatDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

// ---------- NYSE holiday calendar ----------

function nthWeekday(y: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return formatDate(y, month, day);
}

function lastWeekday(y: number, month: number, weekday: number): string {
  const lastDay = new Date(Date.UTC(y, month, 0)).getUTCDate();
  const lastDow = new Date(Date.UTC(y, month - 1, lastDay)).getUTCDay();
  return formatDate(y, month, lastDay - ((lastDow - weekday + 7) % 7));
}

/** Gregorian Easter Sunday (anonymous Gregorian algorithm). */
function easter(y: number): string {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return formatDate(y, month, day);
}

/** Fixed-date holiday observed on Friday if Saturday, Monday if Sunday. */
function observed(date: string): string | null {
  const dow = weekdayOf(date);
  if (dow === 6) return addDays(date, -1);
  if (dow === 0) return addDays(date, 1);
  return date;
}

/** One-off closures (national days of mourning etc.). */
const SPECIAL_CLOSURES = new Set(['2018-12-05', '2025-01-09']);

const holidayCache = new Map<number, Set<string>>();

export function nyseHolidays(y: number): Set<string> {
  const cached = holidayCache.get(y);
  if (cached) return cached;
  const days: (string | null)[] = [];
  // New Year's Day: if it falls on Saturday NYSE does NOT close the prior Friday.
  const ny = formatDate(y, 1, 1);
  days.push(weekdayOf(ny) === 6 ? null : observed(ny));
  days.push(nthWeekday(y, 1, 1, 3)); // MLK Day
  days.push(nthWeekday(y, 2, 1, 3)); // Presidents' Day
  days.push(addDays(easter(y), -2)); // Good Friday
  days.push(lastWeekday(y, 5, 1)); // Memorial Day
  if (y >= 2022) days.push(observed(formatDate(y, 6, 19))); // Juneteenth
  days.push(observed(formatDate(y, 7, 4)));
  days.push(nthWeekday(y, 9, 1, 1)); // Labor Day
  days.push(nthWeekday(y, 11, 4, 4)); // Thanksgiving
  days.push(observed(formatDate(y, 12, 25)));
  const set = new Set(days.filter((d): d is string => d !== null));
  for (const d of SPECIAL_CLOSURES) if (d.startsWith(String(y))) set.add(d);
  holidayCache.set(y, set);
  return set;
}

const tradingDayCache = new Map<string, boolean>();

export function isTradingDay(date: string): boolean {
  let v = tradingDayCache.get(date);
  if (v === undefined) {
    const dow = weekdayOf(date);
    v = dow !== 0 && dow !== 6 && !nyseHolidays(parseDate(date).y).has(date);
    tradingDayCache.set(date, v);
  }
  return v;
}

/** Regular close in minutes for a trading day (13:00 on early-close days). */
const closeCache = new Map<string, number>();

export function regularCloseMinute(date: string): number {
  let v = closeCache.get(date);
  if (v === undefined) {
    v = computeRegularClose(date);
    closeCache.set(date, v);
  }
  return v;
}

function computeRegularClose(date: string): number {
  const { y, m, d } = parseDate(date);
  const thanksgiving = nthWeekday(y, 11, 4, 4);
  if (date === addDays(thanksgiving, 1)) return EARLY_CLOSE;
  // Christmas Eve and July 3rd close early when they are trading days.
  if (m === 12 && d === 24 && isTradingDay(date)) return EARLY_CLOSE;
  if (m === 7 && d === 3 && isTradingDay(date) && weekdayOf(formatDate(y, 7, 4)) !== 6) return EARLY_CLOSE;
  return REGULAR_CLOSE;
}

export function nextTradingDay(date: string): string {
  let d = addDays(date, 1);
  while (!isTradingDay(d)) d = addDays(d, 1);
  return d;
}

export function prevTradingDay(date: string): string {
  let d = addDays(date, -1);
  while (!isTradingDay(d)) d = addDays(d, -1);
  return d;
}

/** Nearest trading day on or before `date`. */
export function tradingDayOnOrBefore(date: string): string {
  return isTradingDay(date) ? date : prevTradingDay(date);
}

export function marketSession(t: UnixSeconds): MarketSession {
  const date = exchangeDate(t);
  if (!isTradingDay(date)) return 'closed';
  const mod = exchangeMinuteOfDay(t);
  const close = regularCloseMinute(date);
  if (mod >= REGULAR_OPEN && mod < close) return 'regular';
  if (mod >= PREMARKET_OPEN && mod < REGULAR_OPEN) return 'pre';
  if (mod >= close && mod < AFTERHOURS_CLOSE) return 'post';
  return 'closed';
}

export function formatExchangeTime(t: UnixSeconds, withSeconds = false): string {
  const p = exchangeParts(t);
  return `${pad2(p.hour)}:${pad2(p.minute)}${withSeconds ? ':' + pad2(p.second) : ''}`;
}

export function formatExchangeDateTime(t: UnixSeconds): string {
  return `${exchangeDate(t)} ${formatExchangeTime(t)} ET`;
}

/** Parse "HH:MM" to minutes. */
export function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
