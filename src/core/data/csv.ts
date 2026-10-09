/**
 * CSV import for real historical bars (e.g. exported from a broker, TradingView, or a data vendor).
 * Accepts common column names and time formats, validates every row, and reports what it skipped.
 */
import type { Bar, Timeframe } from '../types';
import { REGULAR_OPEN, exchangeDate, exchangeTimeToUnix, isTradingDay } from '../time';

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
  volume: ['volume', 'vol', 'vol.', 'v', 'qty'],
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

/**
 * A ticker guessed from an export's file name: AAPL_1m.csv, msft-2024.csv, BRK.B_daily.csv, BRK-B.csv
 * (a one-letter class suffix stays) and TradingView's NASDAQ_AAPL, 1D.csv (the exchange prefix goes).
 */
export function tickerFromFileName(name: string): string | null {
  let base = name.replace(/\.(csv|txt)$/i, '').trim().toUpperCase();
  const tv = base.match(/^(?:NASDAQ|NYSE|NYSEARCA|NYSEAMERICAN|AMEX|ARCA|BATS|CBOE|OTC|OTCMKTS)[_:]([A-Z0-9.]+)/);
  if (tv) base = tv[1];
  const m = base.match(/^([A-Z]{1,6})(?:([.-])([A-Z]))?(?![A-Z0-9])/);
  return m ? m[1] + (m[3] ? m[2] + m[3] : '') : null;
}

function detectDelimiter(header: string): string {
  const counts = [',', ';', '\t', '|'].map((d) => [d, header.split(d).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][0];
}

/**
 * Which decimal mark a number shows, if it settles it: a comma (185,64 or 1.234,56, as in files from
 * many European locales) or a point. The decimal mark is the later of ',' and '.' in a number that
 * has both; one that has only one of them is a decimal mark unless exactly three digits follow it
 * after a group other than 0 (then it may group thousands, as in 1,000; 0,812 cannot).
 */
function decimalMarkOf(raw: string | undefined): ',' | '.' | null {
  const s = (raw ?? '').replace(/[$\s"]/g, '').replace(/^[-+]/, '');
  const c = s.lastIndexOf(',');
  const p = s.lastIndexOf('.');
  if (c >= 0 && p >= 0) return c > p ? ',' : '.';
  if (c < 0 && p < 0) return null;
  const [mark, other, at] = c >= 0 ? ([',', '.', c] as const) : (['.', ',', p] as const);
  // 1,234,567 or 1.234.567: the mark groups thousands, so the decimal mark is the other one.
  if (s.indexOf(mark) !== at) return other;
  return s.length - at - 1 !== 3 || /^0*$/.test(s.slice(0, at)) ? mark : null;
}

function parseNumber(s: string | undefined, decimalComma = false): number {
  if (s === undefined) return NaN;
  const t = s.replace(/[$\s"]/g, '');
  if (t === '') return NaN;
  return Number(decimalComma ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, ''));
}

/** A volume cell, which some exports abbreviate (82.49M, 1.2K). NaN when unreadable. */
function parseVolume(s: string | undefined, decimalComma: boolean): number {
  const m = (s ?? '').replace(/[\s"]/g, '').match(/^(.*?)([KkMmBb])$/);
  if (!m) return parseNumber(s, decimalComma);
  return parseNumber(m[1], decimalComma) * { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase() as 'k' | 'm' | 'b'];
}

const daysInMonth = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

/** A date written with the year last: 01/16/2024, 16.01.2024, 16-01-2024 (the first two numbers, and the separator). */
const YEAR_LAST = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})(?:[ T](.*))?$/;

/**
 * Parses many timestamp formats. Returns unix seconds or NaN. `dateOnly` reports daily data. `date`
 * is the calendar day the stamp names (YYYY-MM-DD): as written for text, the UTC day for epoch
 * numbers. Daily bars are filed under it, whatever time of day the vendor stamped them with. Dates
 * with the year last are month first (US) unless `dayFirst`. A day or time that does not exist
 * (month 13, 31 April, 25:00) is NaN, not rolled over.
 */
export function parseTimestamp(raw: string, naive: 'exchange' | 'utc', dayFirst = false): { t: number; dateOnly: boolean; date?: string } {
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
  } else if ((m = s.match(YEAR_LAST))) {
    [mo, d, y] = dayFirst ? [Number(m[3]), Number(m[1]), Number(m[4])] : [Number(m[1]), Number(m[3]), Number(m[4])];
    rest = m[5] ?? '';
  } else if ((m = s.match(/^(\d{4})(\d{2})(\d{2})(?:[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?)?$/))) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    rest = m[4] ? `${m[4]}:${m[5]}:${m[6] ?? '00'}` : '';
  } else {
    return { t: NaN, dateOnly: false };
  }
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return { t: NaN, dateOnly: false };
  const date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (!rest) return { t: exchangeTimeToUnix(date, REGULAR_OPEN), dateOnly: true, date };
  const tm = rest.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([AaPp][Mm])?$/);
  if (!tm) return { t: NaN, dateOnly: false };
  let hh = Number(tm[1]);
  const mm = Number(tm[2]);
  const ss = Number(tm[3] ?? 0);
  if (hh > (tm[4] ? 12 : 23) || mm > 59 || ss > 59) return { t: NaN, dateOnly: false };
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
 * is right for all of those). Bars on weekends and market holidays are dropped and listed.
 */
export function sessionStampDailyBars(bars: Bar[], dates?: ReadonlyMap<Bar, string>): { bars: Bar[]; offDays: string[]; merged: number } {
  const out: Bar[] = [];
  const offDays: string[] = [];
  for (const b of bars) {
    const date = dates?.get(b) ?? new Date(b.time * 1000).toISOString().slice(0, 10);
    if (!isTradingDay(date)) {
      offDays.push(date);
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

/**
 * The bar size: the largest supported size that (nearly) every gap between bars within a day is a
 * whole number of. Gaps, not their median, so a thinly traded stock's 1-minute bars (a bar only in
 * minutes that traded) stay 1-minute bars. A day's first gap is left out when there are others, since
 * vendors often stamp the first hourly bar 09:30 and the next 10:00. A size the replay does not
 * support (3-minute or 2-hour bars) is an error rather than being rounded to a nearby one.
 */
function detectTimeframe(bars: Bar[], dateOnly: boolean): Timeframe {
  if (dateOnly) return '1D';
  const all: number[] = [];
  const later: number[] = [];
  for (let i = 1; i < bars.length && all.length < 20_000; i++) {
    const d = bars[i].time - bars[i - 1].time;
    if (!(d > 0 && d < 6 * 3600)) continue;
    all.push(d);
    if (i >= 2 && exchangeDate(bars[i - 1].time) === exchangeDate(bars[i - 2].time)) later.push(d);
  }
  if (!all.length) return '1D';
  const gaps = later.length >= Math.max(3, all.length / 4) ? later : all;
  const table: [number, Timeframe][] = [
    [14400, '4h'],
    [3600, '1h'],
    [1800, '30m'],
    [900, '15m'],
    [300, '5m'],
    [60, '1m'],
  ];
  const counts = new Map<number, number>();
  for (const d of gaps) counts.set(d, (counts.get(d) ?? 0) + 1);
  const [typical, most] = [...counts].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0];
  // The size itself must be a common gap (the commonest for sparse bars), or 3-minute bars would pass as 1-minute ones.
  for (const [secs, tf] of table) {
    const n = counts.get(secs) ?? 0;
    if ((n >= Math.max(2, 0.03 * gaps.length) || n === most) && gaps.filter((d) => d % secs === 0).length >= 0.99 * gaps.length) return tf;
  }
  const spacing = typical % 3600 === 0 ? `${typical / 3600} hours` : typical % 60 === 0 ? `${typical / 60} minutes` : `${typical} seconds`;
  throw new Error(`The bars in this file are ${spacing} apart, a bar size the replay does not support. Use 1, 5, 15 or 30-minute, 1 or 4-hour, or daily bars.`);
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
  const stampOf = (cols: string[]) => (iDate >= 0 && iClock >= 0 ? `${cols[iDate]} ${cols[iClock]}` : (cols[iDateTime >= 0 ? iDateTime : iDate] ?? ''));

  // A first pass settles how the whole file writes dates and numbers. Dates with the year last are
  // month/day (US) or day/month (most other places): a first number over 12 settles it, and without
  // one a dotted date (16.01.2024) is day first. Prices settle the decimal mark.
  let dayFirst = false;
  let monthFirstSeen = false;
  let ambiguous = '';
  let dotted = false;
  const marks = new Set<string>();
  const volumeMarks = new Set<string>();
  // The first price that shows a decimal comma, and the first whose mark could also group thousands (2,965 or 24.664).
  let commaExample = '';
  let undecided = '';
  for (let li = 1; li < lines.length; li++) {
    const cols = splitLine(lines[li], delim);
    for (const i of [iOpen, iHigh, iLow, iClose]) {
      const mark = decimalMarkOf(cols[i]);
      if (mark) marks.add(mark);
      if (mark === ',' && !commaExample) commaExample = (cols[i] ?? '').replace(/[$\s"]/g, '');
      else if (!mark && !undecided && /[,.]/.test(cols[i] ?? '')) undecided = cols[i].replace(/[$\s"]/g, '');
    }
    if (iVol >= 0) {
      const mark = decimalMarkOf((cols[iVol] ?? '').replace(/[\s"]/g, '').replace(/[KkMmBb]$/, ''));
      if (mark) volumeMarks.add(mark);
    }
    const m = stampOf(cols).trim().replace(/^"|"$/g, '').match(YEAR_LAST);
    if (!m) continue;
    const [a, b] = [Number(m[1]), Number(m[3])];
    if (a > 12 && b <= 12) dayFirst = true;
    else if (b > 12 && a <= 12) monthFirstSeen = true;
    else if (!ambiguous) ambiguous = m[0].split(/[ T]/)[0];
    if (m[2] === '.') dotted = true;
  }
  if (dayFirst && monthFirstSeen) throw new Error('The dates mix day/month and month/day order (for example 13/01 and 01/13). Export them in one order, ideally YYYY-MM-DD.');
  if (!dayFirst && !monthFirstSeen && ambiguous) {
    dayFirst = dotted;
    warnings.push(`Dates such as ${ambiguous} can be read either way; they were read as ${dayFirst ? 'day/month' : 'month/day (US)'}. Check the date range.`);
  } else if (dayFirst) warnings.push('Dates were read as day/month/year (13/01/2024 is 13 January).');
  if (marks.size > 1) throw new Error('The prices mix decimal commas and decimal points (185,64 and 185.64). Export them in one format.');
  let decimalComma = marks.has(',');
  if (!marks.size && undecided) {
    // Every price with a mark has three digits after it (2,965 or 24.664): the volumes (1.285.508), or
    // a delimiter other than a comma with a semicolon or dotted dates, say the comma is decimal and
    // points group thousands; without any of them a point is decimal and a comma groups thousands.
    decimalComma = volumeMarks.size === 1 ? volumeMarks.has(',') : delim === ';' || (dotted && delim !== ',');
    if (!decimalComma && undecided.includes(',')) warnings.push(`${undecided} was read as ${parseNumber(undecided)}, taking the comma to group thousands. If it is a decimal comma, export the file with decimal points.`);
  }
  if (decimalComma) {
    const example = commaExample || undecided;
    warnings.push(`Numbers were read with a decimal comma and points grouping thousands: ${example} is ${parseNumber(example, true)}.`);
  }

  const bars: Bar[] = [];
  const dates = new Map<Bar, string>();
  let skipped = 0;
  let unreadableVolume = 0;
  let sawDateOnly = false;
  let sawIntraday = false;
  for (let li = 1; li < lines.length; li++) {
    const cols = splitLine(lines[li], delim);
    const ts = parseTimestamp(stampOf(cols), opts.naiveTimezone, dayFirst);
    const o = parseNumber(cols[iOpen], decimalComma);
    const h = parseNumber(cols[iHigh], decimalComma);
    const l = parseNumber(cols[iLow], decimalComma);
    const c = parseNumber(cols[iClose], decimalComma);
    let v = iVol >= 0 ? parseVolume(cols[iVol], decimalComma) : 0;
    if (![ts.t, o, h, l, c].every(Number.isFinite) || o <= 0 || c <= 0 || l <= 0) {
      skipped++;
      continue;
    }
    if (!Number.isFinite(v) || v < 0) {
      if ((cols[iVol] ?? '').trim() !== '') unreadableVolume++;
      v = 0;
    }
    if (h < Math.max(o, c) - 1e-9 || l > Math.min(o, c) + 1e-9) {
      skipped++;
      continue;
    }
    if (ts.dateOnly) sawDateOnly = true;
    else sawIntraday = true;
    const bar: Bar = { time: ts.t, open: o, high: h, low: l, close: c, volume: v };
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
    offDays = daily.offDays.length;
    if (daily.offDays.length) {
      const shown = daily.offDays.slice(0, 5).join(', ');
      warnings.push(`${daily.offDays.length} daily bar(s) dated on a weekend or market holiday were skipped: ${shown}${daily.offDays.length > 5 ? ` and ${daily.offDays.length - 5} more` : ''}.`);
    }
    if (!out.length) throw new Error('No daily bars fall on trading days. Check the date column.');
  } else if (opts.timestampsAreBarClose) for (const b of out) b.time -= TF_SECONDS[tf];
  if (merged) warnings.push(`${merged} duplicate timestamps were merged (last row kept).`);
  // Without volume a bar's volume is 0: no volume pane, no meaningful VWAP, and no cap on fills.
  const noVolume = 'the volume pane is empty, VWAP is not meaningful, and fills are not limited by bar volume';
  if (iVol < 0) warnings.push(`No volume column: ${noVolume}.`);
  else if (out.every((b) => b.volume === 0)) warnings.push(`Every volume is 0 or unreadable: ${noVolume}.`);
  else if (unreadableVolume) warnings.push(`${unreadableVolume} row(s) have an unreadable volume and were kept with volume 0.`);
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
