// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Bar } from '../../core/types';
import { exchangeTimeToUnix } from '../../core/time';
import { mergeBars } from '../../core/data/aggregate';
import type { ChartScene } from '../chart/offscreenSnapshot';

/**
 * Snapshots saved, and the scenes given to the off-screen chart. A real one needs a canvas, so a
 * stand-in draws them (`draw`, when a test sets it, decides what it gives back).
 */
const pictures = vi.hoisted(() => ({
  saved: new Map<string, unknown>(),
  drawn: [] as ChartScene[],
  draw: null as ((scene: ChartScene) => Promise<string | null>) | null,
}));

vi.mock('../chart/offscreenSnapshot', () => ({
  offscreenSnapshot: (scene: ChartScene) => {
    pictures.drawn.push(scene);
    return pictures.draw ? pictures.draw(scene) : Promise.resolve('data:image/jpeg;base64,BB==');
  },
}));

vi.mock('../services/idb', () => ({
  idb: {
    all: async () => [],
    set: async (store: string, key: string, value: unknown) => void (store === 'snapshots' && pictures.saved.set(key, value)),
    delete: async () => undefined,
    get: async () => undefined,
    modify: async (_s: string, _k: string, fn: (v: unknown) => unknown) => fn(undefined),
  },
}));

describe('jumping forward in a replay', () => {
  it('redraws the chart once, moves the clock and journals a trade that closed inside the jump', async () => {
    const store = await import('./tradingStore');
    const { useJournal } = await import('./journalStore');
    const ok = await store.startReplay({
      providerId: 'demo',
      symbol: 'SPY',
      date: '2024-03-12',
      startTime: '10:00',
      endTime: '16:00',
      startingBalance: 25_000,
      lookbackDays: 1,
      timeframe: '1m',
      speed: 1,
      blind: false,
    });
    expect(ok).toBe(true);
    store.stepForward();
    store.stepForward();
    const price = store.lastPrice('SPY')!;
    expect(store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10, stopLoss: price - 0.2, takeProfit: price + 0.2 }).ok).toBe(true);
    store.stepForward();
    expect(store.useTrading.getState().positions).toHaveLength(1);

    // What the chart holds: a reset reloads the revealed bars; an append adds bars after them.
    let chart: Bar[] = store.getBaseBars('SPY');
    const events: string[] = [];
    const off = store.onChartEvent((e) => {
      events.push(e.type);
      if (e.type === 'reset') chart = store.getBaseBars('SPY');
      else if (e.type === 'append' && e.symbol === 'SPY') chart.push(...e.bars);
    });
    const target = exchangeTimeToUnix('2024-03-12', 12 * 60);
    store.jumpTo(target);
    off();
    await vi.waitFor(() => expect(useJournal.getState().entries).toHaveLength(1));

    expect(events).toEqual(['reset']);
    expect(chart.map((b) => b.time)).toEqual(store.getBaseBars('SPY').map((b) => b.time));
    expect(store.useTrading.getState().now).toBe(target);
    expect(store.useTrading.getState().positions).toHaveLength(0);
  });
});

describe('quotes', () => {
  it('measures the day change from the previous regular-session close, not its after-hours print', async () => {
    const store = await import('./tradingStore');
    const ok = await store.startReplay({ providerId: 'demo', symbol: 'TSLA', date: '2024-03-12', startTime: '09:30', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false });
    expect(ok).toBe(true);
    const bars = store.getBaseBars('TSLA');
    const close = bars.find((b) => b.time === exchangeTimeToUnix('2024-03-11', 15 * 60 + 59))!.close;
    const afterHours = bars.find((b) => b.time === exchangeTimeToUnix('2024-03-11', 19 * 60 + 59))!.close;
    expect(afterHours).not.toBe(close);
    expect(store.useTrading.getState().quotes.TSLA.prevClose).toBe(close);
    await store.endSession();
  });
});

describe('the simulated market on the chart', () => {
  it('sends every minute a step covers, so a stalled frame leaves no gap', async () => {
    const store = await import('./tradingStore');
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      expect(await store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 300 })).toBe(true);
      const symbol = store.useTrading.getState().activeSymbol;
      const chart = store.getBaseBars(symbol);
      const off = store.onChartEvent((e) => {
        if (e.type === 'reset' || e.type === 'history') throw new Error(`unexpected ${e.type}`);
        if (e.symbol === symbol) mergeBars(chart, e.bars);
      });
      store.play();
      // A stalled frame: one loop covers a whole second of real time, five simulated minutes.
      for (let i = 0; i < 3; i++) {
        clock += 1000;
        vi.advanceTimersByTime(50);
      }
      off();
      store.pause();
      const truth = store.getBaseBars(symbol);
      expect(chart.length).toBe(truth.length);
      expect(chart).toEqual(truth);
    } finally {
      vi.useRealTimers();
      now.mockRestore();
      await store.endSession();
    }
  });

  it('moves like a live tape at 1x: a new price every second of real time', async () => {
    const store = await import('./tradingStore');
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      expect(await store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 1 })).toBe(true);
      const symbol = store.useTrading.getState().activeSymbol;
      const start = store.useTrading.getState().now;
      const ticks: number[] = [];
      const off = store.onChartEvent((e) => {
        if (e.type === 'tick' && e.symbol === symbol) ticks.push(clock);
      });
      store.play();
      // Three seconds of real time, in the loop's 50 ms frames.
      for (let i = 0; i < 60; i++) {
        clock += 50;
        vi.advanceTimersByTime(50);
      }
      off();
      store.pause();
      expect(ticks).toEqual([1000, 2000, 3000]);
      expect(store.useTrading.getState().now - start).toBe(3);
    } finally {
      vi.useRealTimers();
      now.mockRestore();
      await store.endSession();
    }
  });
});

describe('simulated news', () => {
  it('toasts each new headline, wherever it is, at most one toast every few seconds', async () => {
    const store = await import('./tradingStore');
    const { useToasts } = await import('./toasts');
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    // Every news toast shown, including those that have since timed out.
    const shown = new Map<number, string>();
    const unwatch = useToasts.subscribe((st) => st.toasts.forEach((t) => t.text.startsWith('Simulated news') && shown.set(t.id, t.text)));
    const news = () => [...shown.values()];
    const headlines = () => store.useTrading.getState().simEvents;
    /** Steps the market a minute at a time until `n` more headlines have come. */
    const stepUntil = (n: number) => {
      const target = headlines().length + n;
      for (let i = 0; i < 20_000 && headlines().length < target; i++) store.stepForward();
      expect(headlines().length).toBeGreaterThanOrEqual(target);
    };
    try {
      useToasts.setState({ toasts: [] });
      expect(await store.startSim({ config: { seed: 3, eventFrequency: 3 }, startingBalance: 25_000, speed: 60 })).toBe(true);
      // The warm-up history's headlines are in the News tab, not toasted.
      expect(headlines().length).toBeGreaterThan(0);
      expect(news()).toEqual([]);

      stepUntil(1);
      const first = headlines()[headlines().length - 1];
      expect(news()).toEqual([`Simulated news, ${first.symbol === 'MARKET' ? 'whole market' : first.symbol}: ${first.headline.replace('[SIMULATED] ', '')}`]);

      // Two more within the next few seconds of real time wait, then come as one toast naming the other.
      const before = headlines().length;
      stepUntil(2);
      const held = headlines().length - before;
      expect(news()).toHaveLength(1);
      clock += 4000;
      vi.advanceTimersByTime(4000);
      const latest = headlines()[headlines().length - 1];
      expect(news()).toHaveLength(2);
      expect(news()[1]).toContain(latest.headline.replace('[SIMULATED] ', ''));
      expect(news()[1]).toContain(`(and ${held - 1} more in the News tab)`);

      // A headline still waiting when the session ends is dropped with it.
      clock += 1000;
      stepUntil(1);
      await store.endSession();
      clock += 10_000;
      vi.advanceTimersByTime(10_000);
      expect(news()).toHaveLength(2);
    } finally {
      unwatch();
      vi.useRealTimers();
      now.mockRestore();
      await store.endSession();
    }
  });
});

describe('blind replays', () => {
  it('hide the date in every open tab while running and give it back at the end', async () => {
    const store = await import('./tradingStore');
    const { useLiveBlind } = await import('./liveBlind');
    const ok = await store.startReplay({
      providerId: 'demo',
      symbol: 'SPY',
      date: '2024-03-12',
      startTime: '10:00',
      endTime: '10:30',
      startingBalance: 25_000,
      lookbackDays: 1,
      timeframe: '1m',
      speed: 1,
      blind: true,
    });
    expect(ok).toBe(true);
    const id = store.useTrading.getState().session!.id;
    expect(useLiveBlind.getState().sessions).toEqual({ [id]: '2024-03-12' });
    expect(JSON.parse(localStorage.getItem('stock-replay-live-blind')!)[id].start).toBe('2024-03-12');

    store.jumpTo(exchangeTimeToUnix('2024-03-12', 10 * 60 + 30));
    const s = store.useTrading.getState();
    expect(s.finished).toBe(true);
    expect(s.session).toMatchObject({ id, blind: false, label: 'SPY · 2024-03-12' });
    expect(useLiveBlind.getState().sessions).toEqual({});
    expect(localStorage.getItem('stock-replay-live-blind')).toBeNull();
  });
});

describe('what the store publishes', () => {
  it('a new equity curve whenever it changes, so charts of it keep up while the replay plays', async () => {
    const store = await import('./tradingStore');
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false })).toBe(true);
    store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 });
    const before = store.useTrading.getState().equityCurve;
    const last = before.at(-1)!;
    const lastEquity = last.equity;
    store.stepForward();
    store.jumpTo(store.useTrading.getState().now + 120);
    const after = store.useTrading.getState().equityCurve;
    expect(after).not.toBe(before);
    expect(after.length).toBeGreaterThan(before.length);
    // What was published before is left as it was.
    expect(last.equity).toBe(lastEquity);
    await store.endSession();
  });

  it('says once when a working order is cancelled because a position the other way opened first', async () => {
    const store = await import('./tradingStore');
    const { useToasts } = await import('./toasts');
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false })).toBe(true);
    const px = store.lastPrice('SPY')!;
    const at = (v: number) => Math.round(v * 100) / 100;
    // Two-sided entries around the price while flat: once one fills, the other meets a position the other way.
    expect(store.submitOrder({ symbol: 'SPY', action: 'short', type: 'limit', quantity: 10, limitPrice: at(px + 0.3), tif: 'gtc' }).ok).toBe(true);
    expect(store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'limit', quantity: 5, limitPrice: at(px - 0.3), tif: 'gtc' }).ok).toBe(true);
    const notices = () => useToasts.getState().toasts.filter((t) => t.text.includes('when it would have filled'));
    // Forward jumps publish at once (steps are throttled to the screen's pace).
    const minute = () => store.jumpTo(store.useTrading.getState().now + 60);
    for (let i = 0; i < 360 && !store.useTrading.getState().orders.some((o) => o.conflict); i++) minute();
    const cancelled = store.useTrading.getState().orders.find((o) => o.conflict)!;
    expect(cancelled.status).toBe('cancelled');
    const held = store.useTrading.getState().positions[0];
    expect(Math.sign(held.quantity)).toBe(cancelled.action === 'short' ? 1 : -1);
    expect(notices().map((t) => t.text)).toEqual([`${cancelled.action.toUpperCase()} ${cancelled.quantity} SPY LMT ${cancelled.limitPrice!.toFixed(2)} cancelled. ${cancelled.rejectReason}`]);
    // Stepping back over a later bar replays the cancellation, but it is not announced again.
    minute();
    store.stepBack();
    await vi.waitFor(() => expect(store.useTrading.getState().orders.find((o) => o.id === cancelled.id)!.status).toBe('cancelled'));
    expect(notices()).toHaveLength(1);
    expect(store.useTrading.getState().positions[0]).toMatchObject({ quantity: held.quantity, avgPrice: held.avgPrice });
    await store.endSession();
  });
});

describe('Learning Mode', () => {
  it('pauses as soon as trades close, before the chart picture and the journal are written, and reviews them in exit order', async () => {
    const store = await import('./tradingStore');
    const { useJournal } = await import('./journalStore');
    const { getSettings } = await import('./settingsStore');
    expect([getSettings().learningMode, getSettings().autoSnapshot]).toEqual([true, true]);
    // Chart pictures that take a while, as real ones can.
    store.registerSnapshotProvider(() => new Promise((resolve) => setTimeout(() => resolve('data:image/jpeg;base64,AA=='), 30)));
    pictures.draw = () => new Promise((resolve) => setTimeout(() => resolve('data:image/jpeg;base64,BB=='), 30));
    expect(
      await store.startReplay({ providerId: 'demo', symbol: 'SPY', extraSymbols: ['QQQ'], date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 100_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false }),
    ).toBe(true);
    const at = (v: number) => Math.round(v * 100) / 100;
    for (const sym of ['SPY', 'QQQ']) {
      const px = store.lastPrice(sym)!;
      expect(store.submitOrder({ symbol: sym, action: 'buy', type: 'market', quantity: 10, stopLoss: at(px - 0.3), takeProfit: at(px + 0.3) }).ok).toBe(true);
    }
    const sessionId = store.useTrading.getState().session!.id;
    const mine = () => useJournal.getState().entries.filter((e) => e.sessionId === sessionId);
    store.play();
    store.jumpTo(exchangeTimeToUnix('2024-03-12', 15 * 60));
    // Paused already, while the picture is still being taken.
    expect(store.useTrading.getState().playing).toBe(false);
    expect(mine()).toEqual([]);
    await vi.waitFor(() => expect(mine().length).toBe(2));
    const byExit = [...mine()].sort((a, b) => a.trip.exitTime! - b.trip.exitTime!);
    expect(byExit[0].trip.exitTime).toBeLessThan(byExit[1].trip.exitTime!);
    expect(store.useTrading.getState().reviewId).toBe(byExit[0].id);
    expect(store.useTrading.getState().reviewQueue).toEqual([byExit[1].id]);
    // Both get a picture. The jump went past both closes, so the chart on screen (on SPY) shows
    // neither moment: each is drawn off screen from what its symbol showed when it closed.
    expect(byExit.map((e) => [e.symbol, e.snapshotKey, e.snapshotOffscreen]).sort()).toEqual([
      ['QQQ', `snap:${sessionId}:${byExit.find((e) => e.symbol === 'QQQ')!.trip.id}`, true],
      ['SPY', `snap:${sessionId}:${byExit.find((e) => e.symbol === 'SPY')!.trip.id}`, true],
    ]);
    pictures.draw = null;
    store.registerSnapshotProvider(null);
    await store.endSession();
  });

  it('settles a review waiting on price after the exit by the rules in force when the trade closed', async () => {
    const store = await import('./tradingStore');
    const { useJournal } = await import('./journalStore');
    const { getSettings, useSettings } = await import('./settingsStore');
    const rule = getSettings().rules.maxRiskPctPerTrade;
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 100_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false })).toBe(true);
    const px = store.lastPrice('SPY')!;
    expect(store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10, stopLoss: Math.round((px - 0.3) * 100) / 100, takeProfit: Math.round((px + 0.3) * 100) / 100 }).ok).toBe(true);
    const sessionId = store.useTrading.getState().session!.id;
    const mine = () => useJournal.getState().entries.filter((e) => e.sessionId === sessionId);
    // Learning Mode counts a closed trade's review as pending the moment the trade is claimed.
    for (let i = 0; i < 300 && store.useTrading.getState().reviewsPending === 0; i++) store.stepForward();
    await vi.waitFor(() => expect(mine().length).toBe(1));
    const risked = () => mine()[0].review!.findings.find((f) => f.title.startsWith('Risked'))!;
    expect(mine()[0].review!.afterExitUntil).toBeDefined();
    const atClose = risked();
    expect(atClose.detail).toContain(`Your rule is ${rule}% or less.`);
    // Tightened right after reading the review, before the after-exit window has passed.
    useSettings.getState().updateRules({ maxRiskPctPerTrade: 0.001 });
    for (let i = 0; i < 40 && mine()[0].review!.afterExitUntil !== undefined; i++) {
      store.stepForward();
      await Promise.resolve();
    }
    await vi.waitFor(() => expect(mine()[0].review!.afterExitUntil).toBeUndefined());
    expect(risked()).toEqual(atClose);
    useSettings.getState().updateRules({ maxRiskPctPerTrade: rule });
    await store.endSession();
  });
});

describe('journal snapshots', () => {
  const at = (v: number) => Math.round(v * 100) / 100;
  const replay = { providerId: 'demo', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 100_000, lookbackDays: 1, speed: 1 } as const;

  /** The store, the journal entries of the session that has just started, and a fresh record of pictures. */
  async function begin() {
    const store = await import('./tradingStore');
    const { useJournal } = await import('./journalStore');
    pictures.saved.clear();
    pictures.drawn.length = 0;
    pictures.draw = null;
    const sessionId = store.useTrading.getState().session!.id;
    return { store, mine: () => useJournal.getState().entries.filter((e) => e.sessionId === sessionId) };
  }

  it('draws a trade on a symbol the chart is not showing off screen, from the bars shown up to its close and none after', async () => {
    const store = await import('./tradingStore');
    const onScreen = vi.fn(async () => 'data:image/jpeg;base64,AA==');
    store.registerSnapshotProvider(onScreen);
    expect(await store.startReplay({ ...replay, symbol: 'SPY', extraSymbols: ['QQQ'], timeframe: '5m', blind: false })).toBe(true);
    const { mine } = await begin();
    const px = store.lastPrice('QQQ')!;
    expect(store.submitOrder({ symbol: 'QQQ', action: 'buy', type: 'market', quantity: 10, stopLoss: at(px - 0.3), takeProfit: at(px + 0.3) }).ok).toBe(true);
    store.jumpTo(exchangeTimeToUnix('2024-03-12', 15 * 60));
    await vi.waitFor(() => expect(mine()).toHaveLength(1));
    const entry = mine()[0];
    expect(entry).toMatchObject({ symbol: 'QQQ', snapshotKey: `snap:${entry.id}`, snapshotOffscreen: true });
    expect(entry.snapshotMissing).toBeUndefined();
    expect(pictures.saved.get(entry.snapshotKey!)).toBe('data:image/jpeg;base64,BB==');
    expect(onScreen).not.toHaveBeenCalled();
    expect(pictures.drawn).toHaveLength(1);
    const scene = pictures.drawn[0];
    expect(scene).toMatchObject({ symbol: 'QQQ', timeframe: '5m', baseTimeframe: '1m', source: 'DEMO', entryTime: entry.entryTime, blind: null });
    // The exit became known as its 1-minute bar ended: that bar is the last one drawn.
    const exit = store.useTrading.getState().fills.find((f) => f.id === entry.trip.fills[entry.trip.fills.length - 1])!;
    const last = scene.bars[scene.bars.length - 1];
    expect(last.time + 60).toBe(exit.knownAt);
    expect(last.time <= entry.exitTime && entry.exitTime < last.time + 60).toBe(true);
    // The jump showed more of QQQ after the close: none of it is in the picture.
    const now = store.getBaseBars('QQQ');
    expect(now.length).toBeGreaterThan(scene.bars.length);
    expect(scene.bars).toEqual(now.slice(0, scene.bars.length));
    expect(scene.fills.map((f) => f.id)).toEqual(entry.trip.fills);
    store.registerSnapshotProvider(null);
    await store.endSession();
  });

  it('draws a daily chart off screen with the history the chart had loaded, all from before the replay', async () => {
    const store = await import('./tradingStore');
    store.registerSnapshotProvider(vi.fn(async () => 'data:image/jpeg;base64,AA=='));
    expect(await store.startReplay({ ...replay, symbol: 'SPY', extraSymbols: ['QQQ'], timeframe: '1D', blind: false })).toBe(true);
    const { mine } = await begin();
    // The chart asks for QQQ's history as the user looks at it on 1D.
    store.getChartHistory('QQQ', '1D');
    await vi.waitFor(() => expect(store.getChartHistory('QQQ', '1D')?.status).toBe('ready'), { timeout: 10_000 });
    const px = store.lastPrice('QQQ')!;
    expect(store.submitOrder({ symbol: 'QQQ', action: 'buy', type: 'market', quantity: 10, stopLoss: at(px - 0.3), takeProfit: at(px + 0.3) }).ok).toBe(true);
    store.jumpTo(exchangeTimeToUnix('2024-03-12', 15 * 60));
    await vi.waitFor(() => expect(mine()).toHaveLength(1));
    const scene = pictures.drawn[0];
    expect(scene.history!.timeframe).toBe('30m');
    expect(scene.history!.bars.length).toBeGreaterThan(150 * 13);
    expect(scene.history!.bars[scene.history!.bars.length - 1].time).toBeLessThan(scene.bars[0].time);
    store.registerSnapshotProvider(null);
    await store.endSession();
  });

  it('takes the chart on screen when it shows the close, and draws one off screen when it gives none or has moved on', async () => {
    const store = await import('./tradingStore');
    let screen: string | null = 'data:image/jpeg;base64,AA==';
    const onScreen = vi.fn(async () => screen);
    store.registerSnapshotProvider(onScreen);
    expect(await store.startReplay({ ...replay, symbol: 'SPY', timeframe: '1m', blind: false })).toBe(true);
    const { mine } = await begin();
    /** Opens a trade on SPY and steps one bar at a time until it closes (Learning Mode then counts its review as pending). */
    const trade = async (n: number) => {
      const px = store.lastPrice('SPY')!;
      expect(store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10, stopLoss: at(px - 0.2), takeProfit: at(px + 0.2) }).ok).toBe(true);
      for (let i = 0; i < 300 && store.useTrading.getState().reviewsPending === 0; i++) store.stepForward();
      await vi.waitFor(() => expect(mine()).toHaveLength(n));
      return [...mine()].sort((a, b) => b.exitTime - a.exitTime)[0];
    };
    // The step that closed it revealed nothing after it: the chart on screen is the picture.
    const first = await trade(1);
    expect(onScreen).toHaveBeenCalledTimes(1);
    expect(first.snapshotOffscreen).toBeUndefined();
    expect(pictures.saved.get(first.snapshotKey!)).toBe('data:image/jpeg;base64,AA==');
    expect(pictures.drawn).toEqual([]);
    // A chart that is not laid out gives no picture: it is drawn off screen instead.
    screen = null;
    const second = await trade(2);
    expect(onScreen).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ snapshotOffscreen: true, snapshotKey: `snap:${second.id}` });
    expect(pictures.drawn.map((s) => s.symbol)).toEqual(['SPY']);
    store.registerSnapshotProvider(null);
    await store.endSession();
  });

  it('says why an entry has no picture: snapshots turned off, or one that could not be drawn', async () => {
    const store = await import('./tradingStore');
    const { useSettings } = await import('./settingsStore');
    expect(await store.startReplay({ ...replay, symbol: 'SPY', timeframe: '1m', blind: false })).toBe(true);
    const { mine } = await begin();
    const closeOne = async (n: number) => {
      const px = store.lastPrice('SPY')!;
      expect(store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10, stopLoss: at(px - 0.2), takeProfit: at(px + 0.2) }).ok).toBe(true);
      store.jumpTo(store.useTrading.getState().now + 3 * 3600);
      await vi.waitFor(() => expect(mine()).toHaveLength(n));
      return [...mine()].sort((a, b) => b.exitTime - a.exitTime)[0];
    };
    useSettings.getState().update({ autoSnapshot: false });
    try {
      const off = await closeOne(1);
      expect(off.snapshotMissing).toBe('off');
      expect(off.snapshotKey).toBeUndefined();
      expect(pictures.drawn).toEqual([]);
    } finally {
      useSettings.getState().update({ autoSnapshot: true });
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    pictures.draw = async () => {
      throw new Error('no canvas');
    };
    try {
      const failed = await closeOne(2);
      expect(failed.snapshotMissing).toBe('failed');
      expect(failed.snapshotKey).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      pictures.draw = null;
    }
    await store.endSession();
  });

  it('keeps a blind replay blind in a picture drawn off screen', async () => {
    const store = await import('./tradingStore');
    expect(await store.startReplay({ ...replay, symbol: 'SPY', timeframe: '1m', blind: true })).toBe(true);
    const { mine } = await begin();
    const px = store.lastPrice('SPY')!;
    expect(store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10, stopLoss: at(px - 0.3), takeProfit: at(px + 0.3) }).ok).toBe(true);
    store.jumpTo(exchangeTimeToUnix('2024-03-12', 15 * 60));
    await vi.waitFor(() => expect(mine()).toHaveLength(1));
    const session = store.useTrading.getState().session!;
    expect(session.blind).toBe(true);
    expect(pictures.drawn.map((s) => s.blind)).toEqual([{ sessionId: session.id, startDate: '2024-03-12' }]);
    await store.endSession();
  });

  it('draws a simulated-market trade on another symbol from the minutes up to its close', async () => {
    const store = await import('./tradingStore');
    expect(await store.startSim({ config: { seed: 11 }, startingBalance: 100_000, speed: 10 })).toBe(true);
    const { mine } = await begin();
    const symbols = store.useTrading.getState().session!.symbols;
    const symbol = symbols[1];
    expect(store.useTrading.getState().activeSymbol).not.toBe(symbol);
    const px = store.lastPrice(symbol)!;
    expect(store.submitOrder({ symbol, action: 'buy', type: 'market', quantity: 10, stopLoss: at(px * 0.998), takeProfit: at(px * 1.002) }).ok).toBe(true);
    for (let i = 0; i < 300 && store.useTrading.getState().reviewsPending === 0; i++) store.stepForward();
    await vi.waitFor(() => expect(mine()).toHaveLength(1));
    const entry = mine()[0];
    expect(entry).toMatchObject({ symbol, snapshotOffscreen: true, snapshotKey: `snap:${entry.id}` });
    const scene = pictures.drawn[0];
    expect(scene).toMatchObject({ symbol, source: 'SIMULATED', baseTimeframe: '1m', blind: null });
    // The minute holding the exit is the last one drawn.
    const last = scene.bars[scene.bars.length - 1];
    expect(last.time <= entry.exitTime && entry.exitTime < last.time + 60).toBe(true);
    expect(scene.bars).toEqual(store.getBaseBars(symbol).filter((b) => b.time <= entry.exitTime));
    const exit = store.useTrading.getState().fills.find((f) => f.id === entry.trip.fills[entry.trip.fills.length - 1])!;
    expect(scene.fills.every((f) => f.symbol === symbol && f.knownAt! <= exit.knownAt!)).toBe(true);
    expect(scene.news.every((n) => n.time <= exit.knownAt!)).toBe(true);
    await store.endSession();
  });
});

describe('starting another session', () => {
  it('closes open positions at the last price and journals them as "Session ended", without stopping for a review', async () => {
    const store = await import('./tradingStore');
    const { useJournal } = await import('./journalStore');
    const { useSettings } = await import('./settingsStore');
    useSettings.getState().update({ learningMode: true });
    useJournal.setState({ entries: [] });
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false })).toBe(true);
    store.stepForward();
    const price = store.lastPrice('SPY')!;
    expect(store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    expect(store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'limit', limitPrice: price - 5, quantity: 10 }).ok).toBe(true);
    store.stepForward();
    expect(store.sessionEndNotice()).toBe(
      'Starting a new session ends this one. Your open position (SPY long 10) will be closed at the last price, as a market order would close it, and journaled with the exit reason "Session ended". Working orders are cancelled.',
    );
    // Where a market sell would fill now: the last price less half the spread and slippage.
    const market = store.estimateFill({ symbol: 'SPY', action: 'sell', type: 'market', quantity: 10 })!;
    expect(market).toBeLessThan(store.lastPrice('SPY')!);
    const old = store.useTrading.getState().session!.id;

    expect(await store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 60 })).toBe(true);
    const entries = useJournal.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sessionId: old, symbol: 'SPY', quantity: 10 });
    expect(entries[0].review?.exitReason).toBe('session_end');
    expect(entries[0].avgExit).toBeCloseTo(market, 6);
    expect(store.useTrading.getState().session?.mode).toBe('sim');
    expect(store.useTrading.getState().reviewId).toBeNull();
    expect(store.sessionEndNotice()).toBeNull();
    await store.endSession();
    useSettings.getState().update({ learningMode: false });
  });

  it('keeps the running session, paused and as it was, when the new one fails to load', async () => {
    const store = await import('./tradingStore');
    const { demoProvider } = await import('./dataRegistry');
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false })).toBe(true);
    store.stepForward();
    expect(store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    store.stepForward();
    store.play();
    const before = store.useTrading.getState().session;
    const down = vi.spyOn(demoProvider, 'getBars').mockRejectedValue(new Error('The data service is down.'));
    expect(await store.startReplay({ providerId: 'demo', symbol: 'QQQ', date: '2024-03-13', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false })).toBe(false);
    down.mockRestore();
    const s = store.useTrading.getState();
    expect(s.session).toBe(before);
    expect(s.positions.map((p) => [p.symbol, p.quantity])).toEqual([['SPY', 10]]);
    expect(s.playing).toBe(false);
    expect(s.loading).toBe(false);
    expect(s.error).toBe('The data service is down.');
    await store.endSession();
  });
});

describe('a challenge attempt', () => {
  it('records where its prices came from, and is scored on the rules it started with', async () => {
    const store = await import('./tradingStore');
    const { useChallenges } = await import('./challengeStore');
    const { useSettings } = await import('./settingsStore');
    const rules = useSettings.getState().rules;
    useSettings.getState().update({ rules: { ...rules, maxTradesPerDay: 5 } });
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false, challengeId: 'rules-20' })).toBe(true);
    expect(useChallenges.getState().active).toMatchObject({ challengeId: 'rules-20', source: 'DEMO', rules: { maxTradesPerDay: 5 } });
    // Tightened in Settings mid-challenge: the two trades below would break a limit of 1 a day.
    useSettings.getState().update({ rules: { ...rules, maxTradesPerDay: 1 } });
    for (let i = 0; i < 2; i++) {
      store.stepForward();
      const price = store.lastPrice('SPY')!;
      expect(store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 1, stopLoss: price - 1, takeProfit: price + 2 }).ok).toBe(true);
      store.stepForward();
      expect(store.closePosition('SPY').ok).toBe(true);
      store.stepForward();
    }
    expect(store.useTrading.getState().trips.filter((t) => t.closed)).toHaveLength(2);
    expect(useChallenges.getState().active?.result.status).toBe('in_progress');
    useSettings.getState().update({ rules });
    await store.endSession();
  });

  it('reviews trades against the own rules it started with, and fails as soon as you mark one broken', async () => {
    const store = await import('./tradingStore');
    const { useChallenges } = await import('./challengeStore');
    const { useSettings } = await import('./settingsStore');
    const { useJournal } = await import('./journalStore');
    const rules = useSettings.getState().rules;
    useSettings.getState().update({ rules: { ...rules, custom: ['Trade with the trend'] } });
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false, challengeId: 'rules-20' })).toBe(true);
    const sessionId = store.useTrading.getState().session!.id;
    // Removed in Settings mid-challenge: the challenge still checks it, so the review still asks.
    useSettings.getState().update({ rules: { ...rules, custom: [] } });
    store.stepForward();
    const price = store.lastPrice('SPY')!;
    expect(store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 1, stopLoss: price - 1, takeProfit: price + 2 }).ok).toBe(true);
    store.stepForward();
    expect(store.closePosition('SPY').ok).toBe(true);
    store.stepForward();
    await vi.waitFor(() => expect(useJournal.getState().entries.filter((e) => e.sessionId === sessionId)).toHaveLength(1));
    const entry = useJournal.getState().entries.find((e) => e.sessionId === sessionId)!;
    expect(entry.review!.rules.filter((c) => c.own).map((c) => c.rule)).toEqual(['Trade with the trend']);
    expect(useChallenges.getState().active?.result).toMatchObject({
      status: 'in_progress',
      detail: '0/20 trades, all rules followed so far. 1 more trade counts once you mark your own rules on its review (in the Journal).',
    });
    await useJournal.getState().updateRuleCheck(entry.id, 'Trade with the trend', true);
    expect(useChallenges.getState().active?.result).toMatchObject({ status: 'in_progress', detail: '1/20 trades, all rules followed so far.' });
    // Marked broken while the review is open: the challenge ends at once.
    const attempt = useChallenges.getState().active!.id;
    await useJournal.getState().updateRuleCheck(entry.id, 'Trade with the trend', false);
    await vi.waitFor(() => expect(useChallenges.getState().active).toBeNull());
    expect(useChallenges.getState().attempts.find((a) => a.id === attempt)?.result).toMatchObject({ status: 'failed', detail: 'Rule broken on a SPY trade: Trade with the trend.' });
    useSettings.getState().update({ rules });
    await store.endSession();
  });
});

describe('history for higher timeframes on the chart', () => {
  it('starts loading when a chart wants it and tells the chart when it arrives', async () => {
    const store = await import('./tradingStore');
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false })).toBe(true);
    // A 5-minute chart cannot be drawn from 30-minute bars: it asks for nothing.
    expect(store.getChartHistory('SPY', '5m')).toMatchObject({ status: 'idle', wanted: false, bars: [] });
    const events: string[] = [];
    const off = store.onChartEvent((e) => events.push(e.type));
    expect(store.getChartHistory('SPY', '1D')).toMatchObject({ status: 'loading', wanted: true });
    await vi.waitFor(() => expect(events).toEqual(['history']), { timeout: 10_000 });
    off();
    const h = store.getChartHistory('SPY', '1D')!;
    expect(h.status).toBe('ready');
    expect(h.bars.length).toBeGreaterThan(150 * 13);
    // All of it from before the replay's loaded bars, which the chart draws after it.
    expect(h.bars[h.bars.length - 1].time).toBeLessThan(store.getBaseBars('SPY')[0].time);
  });
});
