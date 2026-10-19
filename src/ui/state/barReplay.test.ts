// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bar, Timeframe } from '../../core/types';
import { aggregateBars } from '../../core/data/aggregate';
import { barEndTime } from '../../core/replay/ReplayEngine';
import { exchangeDate, exchangeTimeToUnix, nextTradingDay, parseHHMM, prevTradingDay } from '../../core/time';
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

afterEach(async () => {
  const store = await import('./tradingStore');
  await store.endSession();
  store.setBrowseSource('demo');
  store.setActiveSymbol('SPY');
  store.setTimeframe('1m');
  store.dismissError();
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
    { timeout: 20_000 },
  );
  const base = store.getBaseBars(symbol);
  return withHistory(aggregateBars(base, timeframe, store.getBaseTimeframe(symbol)), store.getChartHistory(symbol, timeframe), timeframe).candles;
}

describe('the chart with no session (browsing)', () => {
  it('shows the chosen symbol up to the end of its data, and nothing that means a session runs sees it', async () => {
    const store = await import('./tradingStore');
    const { demoProvider } = await import('./dataRegistry');
    const resets: string[] = [];
    const off = store.onChartEvent((e) => resets.push(e.type));
    const candles = await chartCandles('SPY', '1m');
    off();
    expect(resets).toContain('reset');
    expect(candles.at(-1)!.time).toBe(at(demoProvider.lastDate, '19:59'));
    expect(exchangeDate(candles[0].time)).toBe(back(demoProvider.lastDate, 5));
    const s = store.useTrading.getState();
    expect(s.browse).toMatchObject({ providerId: 'demo', loading: false, error: null, source: 'DEMO' });
    // No session: no quotes, account, positions or orders, no clock, nothing plays and nothing can be traded.
    expect([s.session, s.account, s.quotes, s.positions, s.orders, s.now, s.playing]).toEqual([null, null, {}, [], [], 0, false]);
    store.play();
    expect(store.useTrading.getState().playing).toBe(false);
    expect(store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 1 }).ok).toBe(false);
    expect(store.lastPrice('SPY')).toBeNull();
    expect(store.sessionEndNotice()).toBeNull();
    // While a reload carries its session on, the chart shows none of it, and no bar can be picked from it.
    store.useTrading.setState({ carryingOn: 'a-session' });
    expect(store.getBaseBars('SPY')).toEqual([]);
    expect(store.selectBarBlocked()).not.toBeNull();
    store.useTrading.setState({ carryingOn: null });
    expect(store.getBaseBars('SPY').length).toBeGreaterThan(0);
    expect(store.selectBarBlocked()).toBeNull();
  });

  it('shows any symbol and data source chosen, kept for the next visit, and says why one cannot be shown', async () => {
    const store = await import('./tradingStore');
    const { useSettings } = await import('./settingsStore');
    store.setActiveSymbol('qqq');
    expect(store.useTrading.getState().activeSymbol).toBe('QQQ');
    expect(useSettings.getState().replay.symbol).toBe('QQQ');
    expect((await chartCandles('QQQ', '1m')).length).toBeGreaterThan(0);

    store.setActiveSymbol('ZZZZ');
    await vi.waitFor(() => {
      store.getBaseBars('ZZZZ');
      expect(store.useTrading.getState().browse.error).toMatch(/^The demo data has no ZZZZ\. Choose one of: SPY, /);
    });
    expect(store.getBaseBars('ZZZZ')).toEqual([]);

    // Another data source: while it loads, the demo data's bars are not shown as its own.
    const { csvProvider } = await import('./dataRegistry');
    const bars = Array.from({ length: 390 }, (_, i) => ({ time: at('2024-03-12', '09:30') + i * 60, open: 10, high: 10.1, low: 9.9, close: 10, volume: 1000 }));
    csvProvider.upsert({ symbol: 'QQQ', name: 'QQQ', baseTimeframe: '1m', bars, importedAt: 0, fileName: 'QQQ.csv' });
    try {
      store.setActiveSymbol('QQQ');
      await chartCandles('QQQ', '1m');
      store.setBrowseSource('csv');
      expect(store.getBaseBars('QQQ')).toEqual([]);
      expect(store.useTrading.getState().browse.loading).toBe(true);
      await vi.waitFor(() => expect(store.getBaseBars('QQQ')).toEqual(bars));
    } finally {
      csvProvider.remove('QQQ');
    }

    store.setBrowseSource('polygon');
    expect(useSettings.getState().replay.providerId).toBe('polygon');
    store.setActiveSymbol('AAPL');
    await vi.waitFor(() => {
      store.getBaseBars('AAPL');
      expect(store.useTrading.getState().browse.error).toBe('Add a Polygon API key in Data & Settings.');
    });
    expect(store.getBaseBars('AAPL')).toEqual([]);
    expect(store.selectBarBlocked()).toBe('Add a Polygon API key in Data & Settings.');
  });

  it('drops a load that a newer one overtook', async () => {
    const store = await import('./tradingStore');
    const { ReplaySession } = await import('../../core/replay/ReplaySession');
    const real = ReplaySession.preview.bind(ReplaySession);
    let releaseQqq: () => void = () => undefined;
    const qqqHeld = new Promise<void>((r) => (releaseQqq = r));
    const spy = vi.spyOn(ReplaySession, 'preview').mockImplementation(async (provider, setup, signal) => {
      const s = await real(provider, setup);
      // QQQ's bars come in after AAPL's, though asked for first.
      if (setup.symbol === 'QQQ') await qqqHeld;
      void signal;
      return s;
    });
    try {
      store.setActiveSymbol('QQQ');
      store.getBaseBars('QQQ');
      store.setActiveSymbol('AAPL');
      expect((await chartCandles('AAPL', '1m')).length).toBeGreaterThan(0);
      releaseQqq();
      await new Promise((r) => setTimeout(r, 50));
      expect(store.getBaseBars('AAPL').length).toBeGreaterThan(0);
      expect(store.useTrading.getState()).toMatchObject({ activeSymbol: 'AAPL', browse: { loading: false, error: null } });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Bar Replay: a replay cut at a candle of the chart', () => {
  /** Cuts the browsing chart of SPY on `timeframe` at the candle `pick` chooses, and checks what the replay shows. */
  async function cutAndCheck(timeframe: Timeframe, pick: (candles: Bar[]) => Bar) {
    const store = await import('./tradingStore');
    const { useSettings } = await import('./settingsStore');
    const { demoProvider } = await import('./dataRegistry');
    store.setTimeframe(timeframe);
    const browsed = await chartCandles('SPY', timeframe);
    const candle = pick(browsed);
    expect(await store.startBarReplay(candle.time)).toBe(true);
    const s = store.useTrading.getState();
    const cut = s.now;
    expect(s.session).toMatchObject({ mode: 'replay', blind: false, symbols: ['SPY'], start: cut });
    expect(s.session!.challengeId).toBeUndefined();
    expect(s).toMatchObject({ timeframe, selectingBar: false, playing: false, account: { equity: useSettings.getState().defaultBalance } });

    // Everything the chart, its indicators, the quotes and the broker have seen ends by the cut.
    const base = store.getBaseBars('SPY');
    for (const b of base) expect(b.time + 60).toBeLessThanOrEqual(cut);
    const history = store.getChartHistory('SPY', timeframe);
    for (const b of history?.bars ?? []) expect(barEndTime(b, history!.timeframe)).toBeLessThanOrEqual(cut);
    expect(s.quotes.SPY.time).toBe(base.at(-1)!.time);
    expect(store.lastPrice('SPY')).toBe(base.at(-1)!.close);
    // The newest candle shown is the one clicked, complete: as the chart showed it before the cut.
    const shown = await chartCandles('SPY', timeframe);
    expect(shown.at(-1)).toEqual(candle);

    // The next step shows the first bar after it, which the data has.
    const next = demoProvider.getBarsSync({ symbol: 'SPY', from: cut, to: cut + 7 * 86_400 })[0];
    store.stepForward();
    expect(store.getBaseBars('SPY').at(-1)!.time).toBe(next.time);
    expect(store.getBaseBars('SPY').length).toBe(base.length + 1);
    return { cut, candle };
  }

  it('on a 1-minute chart', async () => {
    const { demoProvider } = await import('./dataRegistry');
    const day = back(demoProvider.lastDate, 2);
    const { cut } = await cutAndCheck('1m', (c) => c.find((x) => x.time === at(day, '10:15'))!);
    expect(cut).toBe(at(day, '10:16'));
  });

  it('on a 5-minute chart, at a pre-market candle', async () => {
    const { demoProvider } = await import('./dataRegistry');
    const day = back(demoProvider.lastDate, 1);
    const { cut } = await cutAndCheck('5m', (c) => c.find((x) => x.time === at(day, '07:00'))!);
    expect(cut).toBe(at(day, '07:05'));
  });

  it('on an hourly chart, at an after-hours candle', async () => {
    const { demoProvider } = await import('./dataRegistry');
    const day = back(demoProvider.lastDate, 3);
    const { cut } = await cutAndCheck('1h', (c) => c.find((x) => x.time === at(day, '18:30'))!);
    expect(cut).toBe(at(day, '19:30'));
  });

  it('on a 4-hour chart, at the pre-market candle, and at the last one of a day', async () => {
    const { demoProvider } = await import('./dataRegistry');
    const store = await import('./tradingStore');
    const day = back(demoProvider.lastDate, 4);
    expect((await cutAndCheck('4h', (c) => c.find((x) => x.time === at(day, '05:30'))!)).cut).toBe(at(day, '09:30'));
    await store.endSession();
    expect((await cutAndCheck('4h', (c) => c.find((x) => x.time === at(day, '17:30'))!)).cut).toBe(at(day, '20:00'));
  });

  it('on a daily chart, at a day weeks back in its history', async () => {
    const { demoProvider } = await import('./dataRegistry');
    const store = await import('./tradingStore');
    const day = back(demoProvider.lastDate, 30);
    const t0 = performance.now();
    const { cut } = await cutAndCheck('1D', (c) => c.find((x) => exchangeDate(x.time) === day)!);
    expect(cut).toBe(at(day, '20:00'));
    // It plays on to the end of the data: about a year of daily candles, never past the data.
    expect(store.useTrading.getState().session!.end).toBe(at(demoProvider.lastDate, '20:00'));
    expect(performance.now() - t0).toBeLessThan(15_000);
  });

  it('plays on for days by timeframe at about a candle a second, and is the next replay’s setup', async () => {
    const store = await import('./tradingStore');
    const { useSettings } = await import('./settingsStore');
    const { demoProvider } = await import('./dataRegistry');
    useSettings.getState().updateReplay({ blind: true, includeWatchlist: true });
    store.setTimeframe('5m');
    const day = back(demoProvider.lastDate, 8);
    const candles = await chartCandles('SPY', '5m');
    const candle = candles.find((c) => c.time === at(day, '11:00'))!;
    expect(await store.startBarReplay(candle.time)).toBe(true);
    let end = day;
    for (let i = 0; i < 5; i++) end = nextTradingDay(end);
    const s = store.useTrading.getState();
    expect(s.session!.end).toBe(at(end, '20:00'));
    expect(s.speed).toBe(300);
    expect(useSettings.getState().replay).toMatchObject({ providerId: 'demo', symbol: 'SPY', date: day, startTime: '11:05', endDate: end, endTime: '20:00', multiDay: true, timeframe: '5m', speed: 300, blind: true, includeWatchlist: true });
    // A speed chosen holds for the session.
    store.setSpeed(60);
    store.setTimeframe('15m');
    expect(store.useTrading.getState().speed).toBe(60);
    useSettings.getState().updateReplay({ blind: false });
  });

  it('will not cut at the newest candle of the data: nothing follows it', async () => {
    const store = await import('./tradingStore');
    store.setTimeframe('1h');
    const candles = await chartCandles('SPY', '1h');
    store.setSelectingBar(true);
    expect(store.useTrading.getState().selectingBar).toBe(true);
    expect(await store.startBarReplay(candles.at(-1)!.time)).toBe(false);
    const s = store.useTrading.getState();
    expect(s.session).toBeNull();
    expect(s.selectingBar).toBe(false);
    expect(s.error).toBe('Nothing follows this bar in the data yet, so there is nothing to replay. Pick an earlier bar.');
    // The one before it can be.
    expect(await store.startBarReplay(candles.at(-2)!.time)).toBe(true);
  });

  it('stops picking a bar on a switch of symbol or timeframe, or once a price is to be picked from the chart; picking one pauses play', async () => {
    const store = await import('./tradingStore');
    const { demoProvider } = await import('./dataRegistry');
    const leave: [string, () => void][] = [
      ['a switch of timeframe', () => store.setTimeframe('5m')],
      ['a switch of symbol', () => store.setActiveSymbol('QQQ')],
      ['a price to pick', () => store.setPickTarget('limit')],
    ];
    for (const [what, go] of leave) {
      const { activeSymbol, timeframe } = store.useTrading.getState();
      await chartCandles(activeSymbol, timeframe);
      store.setSelectingBar(true);
      expect(store.useTrading.getState().selectingBar, what).toBe(true);
      go();
      expect(store.useTrading.getState().selectingBar, what).toBe(false);
    }
    // Picking a bar, no price is picked from the chart.
    store.setSelectingBar(true);
    expect(store.useTrading.getState()).toMatchObject({ selectingBar: true, pickTarget: null });
    store.setSelectingBar(false);
    // During a replay that plays.
    const day = back(demoProvider.lastDate, 3);
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: day, startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false })).toBe(true);
    store.play();
    expect(store.useTrading.getState().playing).toBe(true);
    store.setSelectingBar(true);
    expect(store.useTrading.getState()).toMatchObject({ selectingBar: true, playing: false });
    // Play stops picking.
    store.play();
    expect(store.useTrading.getState()).toMatchObject({ selectingBar: false, playing: true });
    store.pause();
  });

  it('starts afresh from a cut during a replay, ending it as another start does', async () => {
    const store = await import('./tradingStore');
    const { useJournal } = await import('./journalStore');
    const { demoProvider } = await import('./dataRegistry');
    useJournal.setState({ entries: [] });
    const day = back(demoProvider.lastDate, 3);
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: day, startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false })).toBe(true);
    const first = store.useTrading.getState().session!.id;
    store.stepForward();
    expect(store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    store.stepForward();
    expect(store.sessionEndNotice()).toMatch(/^Starting a new session ends this one\. Your open position \(SPY long 10\)/);
    expect(store.sessionEndNotice('exit')).toMatch(/^Exiting ends this session\. Your open position \(SPY long 10\)/);
    // A bar from before the start (its lookback) on the chart.
    const prev = prevTradingDay(day);
    expect(await store.startBarReplay(at(prev, '14:00'))).toBe(true);
    const s = store.useTrading.getState();
    expect(s.session!.id).not.toBe(first);
    expect(s.now).toBe(at(prev, '14:01'));
    expect(s.positions).toEqual([]);
    expect(useJournal.getState().entries.map((e) => [e.sessionId, e.review?.exitReason])).toEqual([[first, 'session_end']]);
  });

  it('is not offered in a blind replay, whose dates it would show, nor in the simulated market', async () => {
    const store = await import('./tradingStore');
    const { useToasts } = await import('./toasts');
    const { demoProvider } = await import('./dataRegistry');
    const day = back(demoProvider.lastDate, 3);
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: day, startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: true })).toBe(true);
    const blind = store.useTrading.getState().session;
    expect(store.selectBarBlocked()).toMatch(/blind replay/);
    store.setSelectingBar(true);
    expect(store.useTrading.getState().selectingBar).toBe(false);
    useToasts.setState({ toasts: [] });
    expect(await store.startBarReplay(at(day, '09:40'))).toBe(false);
    expect(store.useTrading.getState().session).toBe(blind);
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual([`The replay did not start: ${store.selectBarBlocked()}`]);
    expect(await store.startSim({ config: { seed: 3 }, startingBalance: 25_000, speed: 1 })).toBe(true);
    expect(store.selectBarBlocked()).toMatch(/simulated market/);
  });
});

describe('Bar Replay: other ways to start', () => {
  it('Select date starts at that moment', async () => {
    const store = await import('./tradingStore');
    const { demoProvider } = await import('./dataRegistry');
    await chartCandles('SPY', '1m');
    const day = back(demoProvider.lastDate, 20);
    expect(await store.startReplayAt(day, '09:30')).toBe(true);
    const s = store.useTrading.getState();
    expect(s.now).toBe(at(day, '09:30'));
    expect(store.getBaseBars('SPY').at(-1)!.time).toBe(at(day, '09:29'));
  });

  it('Random bar starts at the open of a day of the data picked at random', async () => {
    const store = await import('./tradingStore');
    const { demoProvider } = await import('./dataRegistry');
    expect(await store.startRandomBar(() => 0.999999)).toBe(true);
    expect(store.useTrading.getState().now).toBe(at(demoProvider.lastDate, '09:30'));
    expect(await store.startRandomBar(() => 0)).toBe(true);
    expect(store.useTrading.getState().now).toBe(at('2019-01-02', '09:30'));
  });

  it('never plays across a day an imported file has no bars for, nor hours it has none in', async () => {
    const store = await import('./tradingStore');
    const { csvProvider } = await import('./dataRegistry');
    const days = ['2024-03-11', '2024-03-12', '2024-03-14'];
    const bars: Bar[] = [];
    for (const d of days) for (let m = 570; m < 960; m++) bars.push({ time: exchangeTimeToUnix(d, m), open: 10, high: 10.1, low: 9.9, close: 10, volume: 100 });
    csvProvider.upsert({ symbol: 'GAPS', name: 'GAPS', baseTimeframe: '1m', bars, importedAt: 0, fileName: 'GAPS.csv' });
    try {
      store.setBrowseSource('csv');
      store.setActiveSymbol('GAPS');
      const candles = await chartCandles('GAPS', '1m');
      expect(candles.at(-1)!.time).toBe(at('2024-03-14', '15:59'));
      expect(await store.startBarReplay(at('2024-03-11', '11:00'))).toBe(true);
      // To the end of the 12th's regular session: the 13th has no bars, and the data has no after-hours.
      expect(store.useTrading.getState().session!.end).toBe(at('2024-03-12', '16:00'));
    } finally {
      csvProvider.remove('GAPS');
    }
  });
});

describe('Exit replay', () => {
  it('goes back to the chart with no session, on the replay’s symbol, timeframe and data source', async () => {
    const store = await import('./tradingStore');
    const { useSettings } = await import('./settingsStore');
    const { demoProvider } = await import('./dataRegistry');
    store.setBrowseSource('polygon');
    expect(await store.startReplay({ providerId: 'demo', symbol: 'QQQ', date: back(demoProvider.lastDate, 3), startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '15m', speed: 1, blind: false })).toBe(true);
    await store.endSession();
    const s = store.useTrading.getState();
    expect(s).toMatchObject({ session: null, activeSymbol: 'QQQ', timeframe: '15m', browse: { providerId: 'demo' } });
    expect(useSettings.getState().replay).toMatchObject({ providerId: 'demo', symbol: 'QQQ', timeframe: '15m' });
    const candles = await chartCandles('QQQ', '15m');
    expect(candles.at(-1)!.time).toBe(at(demoProvider.lastDate, '19:45'));
  });

  it('after the simulated market, whose stocks are made up, goes back to the symbol browsed before it', async () => {
    const store = await import('./tradingStore');
    store.setActiveSymbol('MSFT');
    expect(await store.startSim({ config: { seed: 3 }, startingBalance: 25_000, speed: 1 })).toBe(true);
    expect(store.useTrading.getState().activeSymbol).not.toBe('MSFT');
    await store.endSession();
    expect(store.useTrading.getState().activeSymbol).toBe('MSFT');
  });
});
