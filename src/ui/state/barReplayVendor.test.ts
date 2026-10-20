// @vitest-environment jsdom
/**
 * Bar Replay on a vendor's data (Polygon here), whose free plan answers a handful of requests a minute:
 * how many the chart with no session and a replay cut from it ask for, and Random bar on data whose range
 * the vendor does not say.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bar, Timeframe } from '../../core/types';
import { aggregateBars } from '../../core/data/aggregate';
import { exchangeDate, exchangeTimeToUnix, isTradingDay, lastCompletedTradingDay, nextTradingDay, parseHHMM, prevTradingDay } from '../../core/time';
import { VENDOR_RANDOM_DAYS } from '../../core/replay/barReplay';
import { HISTORY_DAYS } from '../../core/replay/ReplaySession';
import { withHistory } from '../chart/chartParts';

vi.mock('../chart/offscreenSnapshot', () => ({ offscreenSnapshot: () => Promise.resolve('data:image/jpeg;base64,BB==') }));

vi.mock('../services/idb', () => ({
  idb: {
    all: async () => [],
    set: async () => undefined,
    delete: async () => undefined,
    get: async () => undefined,
    modify: async (_s: string, _k: string, fn: (v: unknown) => unknown) => fn(undefined),
  },
}));

const at = (date: string, time: string) => exchangeTimeToUnix(date, parseHHMM(time));
const back = (date: string, days: number) => {
  let d = date;
  for (let i = 0; i < days; i++) d = prevTradingDay(d);
  return d;
};

/** Each request the stand-in Polygon answered: its bar size in minutes, and whether it was a next page. */
let asked: { minutes: number; page: boolean }[] = [];

/**
 * A stand-in for Polygon's aggregates: a bar every so many minutes from 04:00 to 20:00 (or to `close`, in
 * minutes) of each trading day from `listed` on (none before: a ticker listed since), in pages of 50,000 as
 * Polygon sends them.
 */
function polygon(listed = '2000-01-03', close = 1200) {
  return vi.fn((input: string) => {
    const u = new URL(input, 'http://x');
    const [, size, fromMs, toMs] = u.pathname.match(/range\/(\d+)\/minute\/(\d+)\/(\d+)/)!;
    const minutes = Number(size);
    const cursor = u.searchParams.get('cursor');
    const from = cursor ? Number(cursor) : Math.floor(Number(fromMs) / 1000);
    const to = Math.floor(Number(toMs) / 1000);
    asked.push({ minutes, page: !!cursor });
    const results: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
    let next: number | null = null;
    outer: for (let d = exchangeDate(from); exchangeTimeToUnix(d, 0) <= to; d = nextTradingDay(d)) {
      if (!isTradingDay(d) || d < listed) continue;
      for (let m = 240; m < close; m += minutes) {
        const t = exchangeTimeToUnix(d, m);
        if (t < from || t > to) continue;
        if (results.length === 50_000) {
          next = t;
          break outer;
        }
        results.push({ t: t * 1000, o: 100, h: 101, l: 99, c: 100, v: 1000 });
      }
    }
    const body = JSON.stringify({ status: 'OK', results, next_url: next ? `https://api.polygon.io${u.pathname}?cursor=${next}` : undefined });
    return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
  });
}

afterEach(async () => {
  const store = await import('./tradingStore');
  await store.endSession();
  store.setBrowseSource('demo');
  store.setActiveSymbol('SPY');
  store.setTimeframe('1m');
  store.dismissError();
  vi.unstubAllGlobals();
  asked = [];
});

/** The chart's candles of `symbol` on `timeframe` once the browsing chart (or the session) has loaded them, history included. */
async function chartCandles(symbol: string, timeframe: Timeframe): Promise<Bar[]> {
  const store = await import('./tradingStore');
  await vi.waitFor(
    () => {
      expect(store.getBaseBars(symbol).length).toBeGreaterThan(0);
      expect(store.useTrading.getState().browse.loading).toBe(false);
      const h = store.getChartHistory(symbol, timeframe);
      if (h?.wanted) expect(h.status).toBe('ready');
    },
    { timeout: 30_000 },
  );
  const base = store.getBaseBars(symbol);
  return withHistory(aggregateBars(base, timeframe, store.getBaseTimeframe(symbol)), store.getChartHistory(symbol, timeframe), timeframe).candles;
}

describe('Bar Replay on Polygon or Alpaca', () => {
  it('asks the vendor for a ticker once for every timeframe, and for a cut a year back in one more page', async () => {
    vi.stubGlobal('fetch', polygon());
    const store = await import('./tradingStore');
    const { useCredentials } = await import('./credentials');
    useCredentials.getState().set({ polygonApiKey: 'k' });
    store.setTimeframe('1m');
    store.browseSymbol('polygon', 'MSFT');
    await chartCandles('MSFT', '1m');
    // Fifteen days of 1-minute bars, in one request.
    expect(asked).toEqual([{ minutes: 1, page: false }]);
    for (const tf of ['5m', '15m', '1h', '1D', '1m', '1h'] as Timeframe[]) {
      store.setTimeframe(tf);
      // What the chart asks for as it redraws.
      store.getBaseBars('MSFT');
      store.getChartHistory('MSFT', tf);
      await chartCandles('MSFT', tf);
      await new Promise((r) => setTimeout(r, 20));
    }
    // The same bars serve every timeframe; the longer past of hourly and daily candles comes once, for both.
    expect(asked.length).toBe(2);
    expect(asked.every((a) => !a.page)).toBe(true);

    // A cut at a daily candle most of a year back: its 1-minute bars from 15 days before it to 36 days after it
    // come in one page, and the daily chart's past in one more request.
    store.setTimeframe('1D');
    const candles = await chartCandles('MSFT', '1D');
    expect(candles.length).toBeGreaterThan(180);
    const pick = candles[candles.length - 180];
    const before = asked.length;
    expect(await store.startBarReplay(pick.time)).toBe(true);
    await chartCandles('MSFT', '1D');
    const cut = asked.slice(before);
    expect(cut.filter((a) => a.minutes === 1)).toEqual([{ minutes: 1, page: false }]);
    expect(asked.length).toBeLessThanOrEqual(5);
    const s = store.useTrading.getState();
    let end = exchangeDate(pick.time);
    for (let i = 0; i < 36; i++) end = nextTradingDay(end);
    expect(exchangeDate(s.session!.end!)).toBe(end);
    expect(s.speed).toBe(23_400);
  }, 120_000);

  it('Random bar picks from the last two years or so, never looking at the bars, and tries one other day when the vendor has none on the first', async () => {
    const last = lastCompletedTradingDay(new Date());
    // Listed 100 trading days ago: nothing before that.
    const listed = back(last, 100);
    vi.stubGlobal('fetch', polygon(listed));
    const store = await import('./tradingStore');
    const { useCredentials } = await import('./credentials');
    useCredentials.getState().set({ polygonApiKey: 'k' });
    store.browseSymbol('polygon', 'NEWCO');
    await chartCandles('NEWCO', '1m');
    // The first day picked is before the ticker was listed, the second after it.
    const picks = [0, 0.99];
    const before = asked.length;
    expect(await store.startRandomBar(() => picks.shift() ?? 0.99)).toBe(true);
    const s = store.useTrading.getState();
    expect(exchangeDate(s.now) > listed).toBe(true);
    expect(s.now).toBe(at(exchangeDate(s.now), '09:30'));
    expect(s.error).toBeNull();
    // For the day with no bars, the replay's bars, of which there are none; then the other day's replay: one
    // request each, the data's hours read from the replay's own bars (or, on the chart's last day, the chart's).
    expect(asked.slice(before).filter((a) => a.minutes === 1)).toHaveLength(2);
    await store.endSession();

    // Both days before the listing: it says so, once, and loads no more. The ticker is on the chart, so not
    // "check the ticker": most likely it had not traded yet. The setup a failed start leaves is the last one's.
    const { useSettings } = await import('./settingsStore');
    const setup = useSettings.getState().replay;
    asked = [];
    expect(await store.startRandomBar(() => 0)).toBe(false);
    expect(store.useTrading.getState()).toMatchObject({ session: null, loading: false });
    expect(store.useTrading.getState().error).toMatch(
      /^Polygon has no NEWCO bars around \d{4}-\d\d-\d\d; it may not have traded then\. Press Random bar again, or use Select date… for a later day\.$/,
    );
    expect(useSettings.getState().replay).toEqual(setup);
    // Two days tried, one request each: no more.
    expect(asked.filter((a) => a.minutes === 1)).toHaveLength(2);
  }, 120_000);

  it('asks the vendor once for each day Random bar or Select date tries, reading the data\'s hours from the replay\'s own bars', async () => {
    // Polygon's free plan answers five requests a minute: the chart, a cut from it and two Random bars fit.
    vi.stubGlobal('fetch', polygon());
    const store = await import('./tradingStore');
    const { useCredentials } = await import('./credentials');
    const { useSettings } = await import('./settingsStore');
    useCredentials.getState().set({ polygonApiKey: 'k' });
    store.browseSymbol('polygon', 'PLTR');
    const candles = await chartCandles('PLTR', '1m');
    expect(await store.startBarReplay(candles[candles.length - 1000].time)).toBe(true);
    await store.endSession();
    const ends = () => {
      const s = store.useTrading.getState().session!;
      return [s.end, useSettings.getState().replay.endTime];
    };
    for (const pick of [0.3, 0.6]) {
      expect(await store.startRandomBar(() => pick)).toBe(true);
      const { session, error } = store.useTrading.getState();
      expect(error).toBeNull();
      // It ends when the data's sessions do, as it would with the hours known before: 20:00 with after-hours bars.
      expect(ends()).toEqual([at(exchangeDate(session!.end!), '20:00'), '20:00']);
      await store.endSession();
    }
    expect(asked).toHaveLength(4);
    // Select date on a day the chart does not show: one request too.
    const day = back(lastCompletedTradingDay(new Date()), 200);
    expect(await store.startReplayAt(day, '10:00')).toBe(true);
    expect(store.useTrading.getState().now).toBe(at(day, '10:00'));
    expect(asked).toHaveLength(5);
    // The vendor has no bars after 4 p.m. here: the replay ends then, and that is the setup it leaves.
    await store.endSession();
    asked = [];
    vi.stubGlobal('fetch', polygon(undefined, 960));
    expect(await store.startReplayAt(day, '10:00')).toBe(true);
    expect(ends()).toEqual([at(exchangeDate(store.useTrading.getState().session!.end!), '16:00'), '16:00']);
    expect(asked).toHaveLength(1);
    // A moment after the latest the data's sessions can end has nothing after it, said without asking.
    await store.endSession();
    expect(await store.startReplayAt(lastCompletedTradingDay(new Date()), '20:00')).toBe(false);
    expect(store.useTrading.getState().error).toBe('Nothing follows that moment in the data, so there is nothing to replay. Pick an earlier date or time.');
    expect(asked).toHaveLength(1);
  }, 120_000);

  it('Random bar tries a later day after one the vendor has no bars on, as a ticker has none before it was listed', async () => {
    const last = lastCompletedTradingDay(new Date());
    vi.stubGlobal('fetch', polygon(back(last, 100)));
    const store = await import('./tradingStore');
    const { useCredentials } = await import('./credentials');
    useCredentials.getState().set({ polygonApiKey: 'k' });
    store.browseSymbol('polygon', 'NEWCO');
    await chartCandles('NEWCO', '1m');
    // The middle of the days it picks from (481 of them: 240 back), then the first it has left: the day after it,
    // not one before the day already found to be before the listing.
    const picks = [0.5, 0];
    expect(await store.startRandomBar(() => picks.shift() ?? 0)).toBe(false);
    expect(store.useTrading.getState().error).toContain(`Polygon has no NEWCO bars around ${back(last, 239)};`);
  }, 120_000);

  it('Random bar on a chart that loads the longer past picks from that many fewer days, so the past is within reach too', async () => {
    vi.stubGlobal('fetch', polygon());
    const store = await import('./tradingStore');
    const { useCredentials } = await import('./credentials');
    useCredentials.getState().set({ polygonApiKey: 'k' });
    store.setTimeframe('1h');
    store.browseSymbol('polygon', 'MSFT');
    await chartCandles('MSFT', '1h');
    expect(await store.startRandomBar(() => 0)).toBe(true);
    const last = lastCompletedTradingDay(new Date());
    expect(store.useTrading.getState().now).toBe(at(back(last, VENDOR_RANDOM_DAYS - HISTORY_DAYS), '09:30'));
    expect(VENDOR_RANDOM_DAYS - HISTORY_DAYS).toBe(280);
  }, 120_000);

  it('Random bar starts no earlier than about two years back on a vendor', async () => {
    vi.stubGlobal('fetch', polygon());
    const store = await import('./tradingStore');
    const { useCredentials } = await import('./credentials');
    useCredentials.getState().set({ polygonApiKey: 'k' });
    store.browseSymbol('polygon', 'MSFT');
    await chartCandles('MSFT', '1m');
    expect(await store.startRandomBar(() => 0)).toBe(true);
    const last = lastCompletedTradingDay(new Date());
    expect(store.useTrading.getState().now).toBe(at(back(last, VENDOR_RANDOM_DAYS), '09:30'));
  }, 120_000);
});
