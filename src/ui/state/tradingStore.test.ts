// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Bar } from '../../core/types';
import { exchangeTimeToUnix } from '../../core/time';
import { mergeBars } from '../../core/data/aggregate';

vi.mock('../services/idb', () => ({
  idb: {
    all: async () => [],
    set: async () => undefined,
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
      store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 300 });
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
    // A chart picture that takes a while, as a real one can.
    store.registerSnapshotProvider(() => new Promise((resolve) => setTimeout(() => resolve('data:image/jpeg;base64,AA=='), 30)));
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
    // The picture is of the chart on screen: the active symbol's trade gets it.
    expect(byExit.map((e) => [e.symbol, !!e.snapshotKey]).sort()).toEqual([
      ['QQQ', false],
      ['SPY', true],
    ]);
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
