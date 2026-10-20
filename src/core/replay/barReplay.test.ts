import { describe, expect, it } from 'vitest';
import type { Bar, Timeframe } from '../types';
import { exchangeDate, exchangeTimeToUnix, nextTradingDay, parseHHMM, prevTradingDay } from '../time';
import { aggregateBars } from '../data/aggregate';
import { DemoDataProvider } from '../data/demoProvider';
import type { HistoricalDataProvider } from '../data/provider';
import { ReplayEngine, barEnds } from './ReplayEngine';
import { DEFAULT_LOOKBACK, ReplaySession, lastDataDay, loadedDays } from './ReplaySession';
import { PLAY_ON_DAYS, VENDOR_RANDOM_DAYS, candleSpeed, cutTime, hhmm, onlyAfterHoursFollow, playOnEndDate, randomDay, sessionEndMinute, vendorPlayOnDays, vendorRandomFrom } from './barReplay';

const at = (date: string, time: string) => exchangeTimeToUnix(date, parseHHMM(time));
const bar = (time: number): Bar => ({ time, open: 10, high: 11, low: 9, close: 10.5, volume: 100 });

/** Bars every `minutes` from `from` up to (not including) `to` on `date`. */
function bars(date: string, from: string, to: string, minutes = 1): Bar[] {
  const out: Bar[] = [];
  for (let t = at(date, from); t < at(date, to); t += minutes * 60) out.push(bar(t));
  return out;
}

/** cutTime over `data` of `base` bars, for the `timeframe` candle starting at `start`. */
function cut(start: number, timeframe: Timeframe, data: Bar[], base: Timeframe = '1m'): number | null {
  return cutTime(start, timeframe, data, barEnds(data, base), base);
}

const D = '2024-03-12';
const extended = [...bars(prevTradingDay(D), '04:00', '20:00'), ...bars(D, '04:00', '20:00'), ...bars(nextTradingDay(D), '04:00', '20:00')];
const regular = [...bars(prevTradingDay(D), '09:30', '16:00'), ...bars(D, '09:30', '16:00'), ...bars(nextTradingDay(D), '09:30', '16:00')];

describe('where a bar replay cut at a candle starts', () => {
  it('at the end of the candle, so it is the last one shown, complete', () => {
    // A one-minute candle of one-minute data is its own bar.
    expect(cut(at(D, '10:17'), '1m', extended)).toBe(at(D, '10:18'));
    // A five-minute one ends five minutes on, an hourly one an hour on (from 09:30, as the chart draws them).
    expect(cut(at(D, '10:00'), '5m', extended)).toBe(at(D, '10:05'));
    expect(cut(at(D, '11:30'), '1h', extended)).toBe(at(D, '12:30'));
    expect(cut(at(D, '13:30'), '4h', extended)).toBe(at(D, '17:30'));
  });

  it('on a pre-market or after-hours candle, at its end or the end of the day’s data', () => {
    // The first hourly candle of the day runs 03:30 to 04:30, with bars from 04:00.
    expect(cut(at(D, '03:30'), '1h', extended)).toBe(at(D, '04:30'));
    expect(cut(at(D, '05:30'), '4h', extended)).toBe(at(D, '09:30'));
    // The last four-hour candle runs from 17:30, but the after-hours end at 20:00.
    expect(cut(at(D, '17:30'), '4h', extended)).toBe(at(D, '20:00'));
    expect(cut(at(D, '19:59'), '1m', extended)).toBe(at(D, '20:00'));
  });

  it('on an early-close day, never later than its after-hours close', () => {
    // 2024-11-29: the regular session ends at 13:00, the after-hours at 17:00.
    const early = bars('2024-11-29', '04:00', '17:00');
    expect(cut(at('2024-11-29', '13:30'), '4h', early)).toBe(at('2024-11-29', '17:00'));
    expect(cut(at('2024-11-29', '09:30'), '1D', early)).toBe(at('2024-11-29', '17:00'));
  });

  it('on a daily candle, at the end of that day’s data, so the next candle is the next day', () => {
    expect(cut(at(D, '09:30'), '1D', extended)).toBe(at(D, '20:00'));
    expect(cut(at(D, '09:30'), '1D', regular)).toBe(at(D, '20:00'));
    // Daily bars, stamped at their session's open.
    const daily = [D, nextTradingDay(D)].map((d) => bar(at(d, '09:30')));
    expect(cut(at(D, '09:30'), '1D', daily, '1D')).toBe(at(D, '20:00'));
  });

  it('on a candle that is one of the data’s own bars, where that bar ends', () => {
    // Imported hourly bars: a short first bar from 09:30 that ends as the next opens on the hour.
    const hourly = [at(D, '09:30'), at(D, '10:00'), at(D, '11:00'), at(D, '12:00')].map(bar);
    expect(cut(at(D, '09:30'), '1h', hourly, '1h')).toBe(at(D, '10:00'));
    expect(cut(at(D, '10:00'), '1h', hourly, '1h')).toBe(at(D, '11:00'));
    // A one-minute chart of hourly data shows the hourly bars.
    expect(cut(at(D, '11:00'), '1m', hourly, '1h')).toBe(at(D, '12:00'));
  });

  it('at the candle’s end though its last minutes have no bars (a gap in the data)', () => {
    const gappy = [bar(at(D, '10:00')), bar(at(D, '10:01')), bar(at(D, '10:12'))];
    expect(cut(at(D, '10:00'), '5m', gappy)).toBe(at(D, '10:05'));
  });

  it('nowhere when the candle has no bar', () => {
    expect(cut(at(D, '10:00'), '5m', [bar(at(D, '09:55')), bar(at(D, '10:05'))])).toBeNull();
    expect(cut(at(D, '10:00'), '5m', [])).toBeNull();
  });
});

describe('how long a bar replay plays on', () => {
  it('about a week of minute candles, a year of daily ones', () => {
    expect(PLAY_ON_DAYS['1m']).toBe(5);
    expect(PLAY_ON_DAYS['1D']).toBeGreaterThanOrEqual(250);
    let d = D;
    for (let i = 0; i < 5; i++) d = nextTradingDay(d);
    expect(playOnEndDate(D, '1m', '2030-01-02')).toBe(d);
  });

  it('never past the end of the data, nor across a day an imported file has no bars for', () => {
    expect(playOnEndDate(D, '1D', nextTradingDay(D))).toBe(nextTradingDay(D));
    expect(playOnEndDate(D, '5m', D)).toBe(D);
    const day2 = nextTradingDay(D);
    const day3 = nextTradingDay(day2);
    expect(playOnEndDate(D, '1h', '2030-01-02', [D, day2, nextTradingDay(day3)])).toBe(day2);
  });

  it('on a vendor, no further than one page of 1-minute bars reaches with the days loaded before it', () => {
    // 52 days of 04:00-20:00 minutes fit in Polygon's 50,000: 15 before the start, its day, and 36 on.
    expect(vendorPlayOnDays(loadedDays('1m', DEFAULT_LOOKBACK['1D']))).toBe(36);
    expect((loadedDays('1m', 200) + 1 + vendorPlayOnDays(loadedDays('1m', 200))) * 16 * 60).toBeLessThanOrEqual(50_000);
    expect(vendorPlayOnDays(60)).toBe(1);
    let d = D;
    for (let i = 0; i < 36; i++) d = nextTradingDay(d);
    expect(playOnEndDate(D, '1D', '2030-01-02', null, 36)).toBe(d);
    // Fewer days than that are not stretched.
    expect(playOnEndDate(D, '1m', '2030-01-02', null, 36)).toBe(playOnEndDate(D, '1m', '2030-01-02'));
  });

  it('to the end of the data’s sessions on its last day, read from the bars around it', () => {
    expect(sessionEndMinute(extended, barEnds(extended, '1m'), D)).toBe(20 * 60);
    expect(sessionEndMinute(regular, barEnds(regular, '1m'), D)).toBe(16 * 60);
    const daily = [D].map((d) => bar(at(d, '09:30')));
    expect(sessionEndMinute(daily, barEnds(daily, '1D'), D)).toBe(16 * 60);
    expect(sessionEndMinute(regular, barEnds(regular, '1m'), '2024-06-03')).toBeNull();
    expect(hhmm(20 * 60)).toBe('20:00');
    expect(hhmm(24 * 60)).toBe('23:59');
  });

  it('at about one candle a second', () => {
    const speeds = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 23400];
    expect(candleSpeed('1m', speeds)).toBe(60);
    expect(candleSpeed('5m', speeds)).toBe(300);
    expect(candleSpeed('15m', speeds)).toBe(600);
    expect(candleSpeed('1h', speeds)).toBe(3600);
    expect(candleSpeed('4h', speeds)).toBe(23400);
    expect(candleSpeed('1D', speeds)).toBe(23400);
  });
});

describe('a random day to replay', () => {
  it('is any trading day of the data, each as likely, and only a day with bars when the data has gaps', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(randomDay('2024-03-11', '2024-03-15', null, () => i / 20)!);
    expect([...seen].sort()).toEqual(['2024-03-11', '2024-03-12', '2024-03-13', '2024-03-14', '2024-03-15']);
    // Weekends and holidays are never picked: 2024-03-29 is Good Friday.
    expect(randomDay('2024-03-29', '2024-03-31', null, () => 0)).toBeNull();
    expect(randomDay('2024-03-28', '2024-04-01', null, () => 0.99)).toBe('2024-04-01');
    expect(randomDay('2024-03-11', '2024-03-15', ['2024-03-08', '2024-03-13', '2024-03-20'], () => 0.5)).toBe('2024-03-13');
    expect(randomDay('2024-03-11', '2024-03-15', ['2024-03-20'])).toBeNull();
  });

  it('is not a day tried already', () => {
    const tried = new Set(['2024-03-11', '2024-03-12']);
    expect(randomDay('2024-03-11', '2024-03-15', null, () => 0, tried)).toBe('2024-03-13');
    expect(randomDay('2024-03-11', '2024-03-12', null, () => 0, tried)).toBeNull();
    expect(randomDay('2024-03-11', '2024-03-15', ['2024-03-11', '2024-03-14'], () => 0, tried)).toBe('2024-03-14');
  });

  it('on a vendor, whose data has no known start, is one of the last two years or so of trading days', () => {
    const from = vendorRandomFrom('2026-10-19');
    let d = from;
    let n = 0;
    while (d < '2026-10-19') {
      d = nextTradingDay(d);
      n++;
    }
    expect(n).toBe(VENDOR_RANDOM_DAYS);
    expect(from > '2024-10-18').toBe(true);
  });
});

describe('whether only after-hours trading follows a bar replay’s start', () => {
  it('when it starts at or after the regular close of its last day', () => {
    expect(onlyAfterHoursFollow(at(D, '16:00'), D)).toBe(true);
    expect(onlyAfterHoursFollow(at(D, '19:30'), D)).toBe(true);
    expect(onlyAfterHoursFollow(at(D, '15:59'), D)).toBe(false);
    // A day it plays on into has a regular session.
    expect(onlyAfterHoursFollow(at(D, '19:30'), nextTradingDay(D))).toBe(false);
    // An early close: 13:00 the day after Thanksgiving.
    expect(onlyAfterHoursFollow(at('2024-11-29', '13:00'), '2024-11-29')).toBe(true);
    expect(onlyAfterHoursFollow(at('2024-11-29', '12:59'), '2024-11-29')).toBe(false);
  });
});

describe('a chart to look at before any replay (ReplaySession.preview)', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const p = new DemoDataProvider(now);

  it('shows the data up to its end, every bar complete, with the days a replay loads before its start', async () => {
    expect(await lastDataDay(p, 'SPY', now)).toBe(p.lastDate);
    const days = loadedDays('1m', DEFAULT_LOOKBACK['5m']);
    const s = await ReplaySession.preview(p, { symbol: 'spy', lookbackDays: days }, undefined, now);
    const shown = s.engine.visibleBaseBars();
    let first = p.lastDate;
    for (let i = 0; i < days; i++) first = prevTradingDay(first);
    expect(exchangeDate(shown[0].time)).toBe(first);
    expect(shown.at(-1)!.time).toBe(at(p.lastDate, '19:59'));
    expect(shown).toEqual(p.getBarsSync({ symbol: 'SPY', from: shown[0].time, to: at(p.lastDate, '20:00') }));
    expect(s.now).toBeGreaterThanOrEqual(at(p.lastDate, '20:00'));
    // Nothing plays in it, and it holds no money.
    expect(s.step()).toEqual([]);
    expect(s.broker.account().equity).toBe(0);
  });

  it('loads the coarse history a replay’s daily chart has, all before its own bars', async () => {
    const s = await ReplaySession.preview(p, { symbol: 'QQQ', lookbackDays: loadedDays('1m', DEFAULT_LOOKBACK['1D']) }, undefined, now);
    expect(s.chartHistory('QQQ', '1D')).toMatchObject({ wanted: true, status: 'idle' });
    await s.loadHistory('QQQ');
    const h = s.chartHistory('QQQ', '1D')!;
    const own = s.engine.visibleBaseBars();
    const daily = aggregateBars(h.bars, '1D', h.timeframe);
    expect(daily.length + new Set(own.map((b) => exchangeDate(b.time))).size).toBe(DEFAULT_LOOKBACK['1D'] + 1);
    expect(Math.max(...h.bars.map((b) => b.time + 30 * 60))).toBeLessThanOrEqual(own[0].time);
  });

  it('ends a data source that does not say where its data ends at the last trading day that has ended', async () => {
    const vendor: HistoricalDataProvider = { ...p, id: 'v', name: 'v', source: 'HISTORICAL', requiresCredentials: false, unavailableReason: () => null, listSymbols: async () => [], baseTimeframe: () => '1m', availableRange: async () => null, getBars: (r, sig) => p.getBars(r, sig) };
    // Thursday 2026-10-08 at 08:00 ET: Wednesday is the last day whose after-hours are over.
    expect(await lastDataDay(vendor, 'SPY', now)).toBe('2026-10-07');
    expect(await lastDataDay(vendor, 'SPY', new Date('2026-10-09T00:30:00Z'))).toBe('2026-10-08');
  });

  it('is the only engine whose start may come after all of its bars', () => {
    const data = bars(D, '09:30', '10:00');
    const window = { symbol: 'X', start: at(D, '20:00'), end: at(D, '20:00'), baseTimeframe: '1m' as const };
    expect(() => new ReplayEngine(window, data)).toThrow('No data between the selected start and end times.');
    expect(new ReplayEngine({ ...window, preview: true }, data).visibleBaseBars()).toHaveLength(30);
  });
});
