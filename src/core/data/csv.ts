/**
 * CSV import for real historical bars (e.g. exported from a broker, TradingView, or a data vendor).
 * Accepts common column names and time formats, validates every row, and reports what it skipped.
 */
import type { Bar, Timeframe } from '../types';
import { REGULAR_OPEN, exchangeTimeToUnix, isTradingDay } from '../time';

export interface CsvParseOptions {
  /** How to read timestamps without an explicit offset. Default: exchange time (America/New_York). */
  naiveTimezone: 'exchange' | 'utc';
  /** Some vendors stamp bars with their CLOSE time; shift them to open time. */
  timestampsAreBarClose: boolean;
}

export interface CsvParseResult {
  bars: Bar[];
  baseTimeframe: Timeframe;
  rowsRead: number;
  rowsSkipped: number;
  warnings: string[];
  firstTime: number;
  lastTime: number;
}

const DEFAULT_OPTS: CsvParseOptions = { naiveTimezone: 'exchange', timestampsAreBarClose: false };

const ALIASES: Record<string, string[]> = {
  datetime: ['datetime', 'timestamp', 'time', 'date_time', 't', 'date/time', 'dt'],
  date: ['date', 'day'],
  clock: ['time', 'hour'],
  open: ['open', 'o', 'opening price'],
  high: ['high', 'h'],
  low: ['low', 'l'],
  close: ['close', 'c', 'last', 'closing price', 'price'],
  volume: ['volume', 'vol', 'v', 'qty'],
};

function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === delim && !quoted) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function detectDelimiter(header: string): string {
  const counts = [',', ';', '\t', '|'].map((d) => [d, header.split(d).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][0];
}

function parseNumber(s: string): number {
  if (s === undefined) return NaN;
  return Number(s.replace(/[$,\s]/g, ''));
}

/**
 * Parses many timestamp formats. Returns unix seconds or NaN. `dateOnly` reports daily data. `date`
 * is the calendar day the stamp names (YYYY-MM-DD): as written for text, the UTC day for epoch
 * numbers. Daily bars are filed under it, whatever time of day the vendor stamped them with.
 */
export function parseTimestamp(raw: string, naive: 'exchange' | 'utc'): { t: number; dateOnly: boolean; date?: string } {
  const s = raw.trim().replace(/^"|"$/g, '');
  if (/^\d{9,13}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    const t = Math.floor(n > 1e11 ? n / 1000 : n);
    return { t, dateOnly: false, date: new Date(t * 1000).toISOString().slice(0, 10) };
  }
  // ISO / RFC with explicit zone
  const zoned = s.match(/^(\d{4}-\d{2}-\d{2})[T ]\d/);
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && zoned) {
    const ms = Date.parse(s.replace(' ', 'T'));
    return { t: Number.isNaN(ms) ? NaN : Math.floor(ms / 1000), dateOnly: false, date: zoned[1] };
  }
  let y: number, mo: number, d: number;
  let rest = '';
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](.*))?$/);
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    rest = m[4] ?? '';
  } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](.*))?$/))) {
    // US format MM/DD/YYYY
    [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    rest = m[4] ?? '';
  } else if ((m = s.match(/^(\d{4})(\d{2})(\d{2})(?:[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?)?$/))) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    rest = m[4] ? `${m[4]}:${m[5]}:${m[6] ?? '00'}` : '';
  } else {
    return { t: NaN, dateOnly: false };
  }
  const date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (!rest) return { t: exchangeTimeToUnix(date, REGULAR_OPEN), dateOnly: true, date };
  const tm = rest.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([AaPp][Mm])?$/);
  if (!tm) return { t: NaN, dateOnly: false };
  let hh = Number(tm[1]);
  const mm = Number(tm[2]);
  const ss = Number(tm[3] ?? 0);
  if (tm[4]) {
    const pm = tm[4].toLowerCase() === 'pm';
    if (hh === 12) hh = pm ? 12 : 0;
    else if (pm) hh += 12;
  }
  if (naive === 'utc') return { t: Date.UTC(y, mo - 1, d, hh, mm, ss) / 1000, dateOnly: false, date };
  return { t: exchangeTimeToUnix(date, hh * 60 + mm) + ss, dateOnly: false, date };
}

/**
 * Files daily bars under their session: 09:30 exchange time on the day each one names. Vendors stamp
 * daily bars at midnight UTC, midnight New York, the open or the close; as instants, midnight UTC
 * falls on the previous evening in New York, which would date the bar a day early and show it before
 * its session has traded. `dates` gives the day per bar (the UTC day of the stamp when absent, which
 * is right for all of those). Bars on weekends and market holidays are dropped and counted.
 */
export function sessionStampDailyBars(bars: Bar[], dates?: ReadonlyMap<Bar, string>): { bars: Bar[]; offDays: number; merged: number } {
  const out: Bar[] = [];
  let offDays = 0;
  for (const b of bars) {
    const date = dates?.get(b) ?? new Date(b.time * 1000).toISOString().slice(0, 10);
    if (!isTradingDay(date)) {
      offDays++;
      continue;
    }
    out.push({ ...b, time: exchangeTimeToUnix(date, REGULAR_OPEN) });
  }
  out.sort((a, b) => a.time - b.time);
  const deduped: Bar[] = [];
  for (const b of out) {
    if (deduped.length && deduped[deduped.length - 1].time === b.time) deduped[deduped.length - 1] = b;
    else deduped.push(b);
  }
  return { bars: deduped, offDays, merged: out.length - deduped.length };
}

function detectTimeframe(bars: Bar[], dateOnly: boolean): Timeframe {
  if (dateOnly) return '1D';
  const diffs: number[] = [];
  for (let i = 1; i < bars.length && diffs.length < 5000; i++) {
    const d = bars[i].time - bars[i - 1].time;
    if (d > 0 && d < 6 * 3600) diffs.push(d);
  }
  if (!diffs.length) return '1D';
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];
  const table: [number, Timeframe][] = [
    [60, '1m'],
    [300, '5m'],
    [900, '15m'],
    [1800, '30m'],
    [3600, '1h'],
    [14400, '4h'],
  ];
  for (const [secs, tf] of table) if (median <= secs) return tf;
  return '1D';
}

const TF_SECONDS: Record<Timeframe, number> = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1D': 86400 };

export function parseCsv(text: string, options: Partial<CsvParseOptions> = {}): CsvParseResult {
  const opts = { ...DEFAULT_OPTS, ...options };
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('The file has no data rows.');
  const delim = detectDelimiter(lines[0]);
  const header = splitLine(lines[0], delim).map((h) => h.toLowerCase().replace(/^"|"$/g, '').trim());
  const find = (key: string, exclude: number[] = []) => header.findIndex((h, i) => !exclude.includes(i) && ALIASES[key].includes(h));

  let iDateTime = find('datetime');
  const iDate = find('date');
  let iClock = -1;
  if (iDate >= 0) {
    iClock = find('clock', [iDate]);
    if (iDateTime === iClock) iDateTime = -1;
  }
  const iOpen = find('open');
  const iHigh = find('high');
  const iLow = find('low');
  // Prefer an explicit "close" over "adj close"/"price".
  let iClose = header.indexOf('close');
  if (iClose < 0) iClose = find('close');
  const iVol = find('volume');
  const missing = [
    [iOpen, 'open'],
    [iHigh, 'high'],
    [iLow, 'low'],
    [iClose, 'close'],
  ].filter(([i]) => (i as number) < 0);
  if (missing.length) throw new Error(`Missing column(s): ${missing.map((m) => m[1]).join(', ')}. Found: ${header.join(', ')}`);
  if (iDateTime < 0 && iDate < 0) throw new Error(`No date/time column found. Expected one of: ${ALIASES.datetime.join(', ')}.`);

  const warnings: string[] = [];
  const bars: Bar[] = [];
  const dates = new Map<Bar, string>();
  let skipped = 0;
  let sawDateOnly = false;
  let sawIntraday = false;
  for (let li = 1; li < lines.length; li++) {
    const cols = splitLine(lines[li], delim);
    let ts: { t: number; dateOnly: boolean; date?: string };
    if (iDate >= 0 && iClock >= 0) ts = parseTimestamp(`${cols[iDate]} ${cols[iClock]}`, opts.naiveTimezone);
    else ts = parseTimestamp(cols[iDateTime >= 0 ? iDateTime : iDate] ?? '', opts.naiveTimezone);
    const o = parseNumber(cols[iOpen]);
    const h = parseNumber(cols[iHigh]);
    const l = parseNumber(cols[iLow]);
    const c = parseNumber(cols[iClose]);
    const v = iVol >= 0 ? parseNumber(cols[iVol]) : 0;
    if (![ts.t, o, h, l, c].every(Number.isFinite) || o <= 0 || c <= 0 || l <= 0) {
      skipped++;
      continue;
    }
    if (h < Math.max(o, c) - 1e-9 || l > Math.min(o, c) + 1e-9) {
      skipped++;
      continue;
    }
    if (ts.dateOnly) sawDateOnly = true;
    else sawIntraday = true;
    const bar: Bar = { time: ts.t, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) && v > 0 ? v : 0 };
    bars.push(bar);
    if (ts.date) dates.set(bar, ts.date);
  }
  if (!bars.length) throw new Error('No valid rows. Check the column format.');
  if (sawDateOnly && sawIntraday) warnings.push('The file mixes daily and intraday rows.');
  bars.sort((a, b) => a.time - b.time);
  const deduped: Bar[] = [];
  for (const b of bars) {
    if (deduped.length && deduped[deduped.length - 1].time === b.time) {
      deduped[deduped.length - 1] = b;
      continue;
    }
    deduped.push(b);
  }
  let merged = bars.length - deduped.length;
  const tf = detectTimeframe(deduped, sawDateOnly && !sawIntraday);
  let out = deduped;
  let offDays = 0;
  if (tf === '1D') {
    const daily = sessionStampDailyBars(deduped, dates);
    out = daily.bars;
    merged += daily.merged;
    offDays = daily.offDays;
    if (daily.offDays) warnings.push(`${daily.offDays} daily bar(s) dated on a weekend or market holiday were skipped.`);
    if (!out.length) throw new Error('No daily bars fall on trading days. Check the date column.');
  } else if (opts.timestampsAreBarClose) for (const b of out) b.time -= TF_SECONDS[tf];
  if (merged) warnings.push(`${merged} duplicate timestamps were merged (last row kept).`);
  if (iVol < 0) warnings.push('No volume column: volume-based features (VWAP, participation limits) will be degraded.');
  if (skipped) warnings.push(`${skipped} invalid row(s) skipped.`);
  return {
    bars: out,
    baseTimeframe: tf,
    rowsRead: lines.length - 1,
    rowsSkipped: skipped + offDays,
    warnings,
    firstTime: out[0].time,
    lastTime: out[out.length - 1].time,
  };
}

/**
 * Two sets of bars for one ticker as one, in time order. Where both have a bar at the same time,
 * `incoming` wins. Both must be sorted by time.
 */
export function combineBars(existing: readonly Bar[], incoming: readonly Bar[]): { bars: Bar[]; replaced: number } {
  const bars: Bar[] = [];
  let replaced = 0;
  let i = 0;
  let j = 0;
  while (i < existing.length || j < incoming.length) {
    const a = existing[i];
    const b = incoming[j];
    if (b === undefined || (a !== undefined && a.time < b.time)) {
      bars.push(a);
      i++;
    } else {
      if (a !== undefined && a.time === b.time) {
        replaced++;
        i++;
      }
      bars.push(b);
      j++;
    }
  }
  return { bars, replaced };
}
