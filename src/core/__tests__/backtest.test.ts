import { describe, expect, it } from 'vitest';
import { runBacktest, warmupCandlesFrom, warmupTradingDays, type BacktestParams } from '../backtest/Backtester';
import { STRATEGY_PRESETS, computeSeries, evalCondition, seriesWarmup, strategyLabel, strategyWarmup, type SeriesRef, type StrategyDefinition } from '../backtest/strategy';
import { DemoDataProvider } from '../data/demoProvider';
import { ZERO_COST_CONFIG, DEFAULT_EXECUTION_CONFIG } from '../broker/config';
import { bar, et, minuteBars } from './helpers';
import type { Bar } from '../types';
import { aggregateBars } from '../data/aggregate';
import { exchangeDate, marketSession, nextTradingDay, prevTradingDay } from '../time';

const provider = new DemoDataProvider(new Date('2026-10-08T12:00:00Z'));

function demoBars(symbol: string, from: string, to: string): Bar[] {
  return provider.getBarsSync({ symbol, from: et(from, '04:00'), to: et(to, '20:00') });
}

function params(bars: Bar[], strategy: StrategyDefinition, extra: Partial<BacktestParams> = {}): BacktestParams {
  return {
    symbol: 'TEST',
    bars,
    baseTimeframe: '1m',
    timeframe: '5m',
    tradeFrom: et('2025-01-14', '09:30'),
    startingBalance: 100_000,
    config: DEFAULT_EXECUTION_CONFIG,
    strategy,
    source: 'DEMO',
    ...extra,
  };
}

describe('backtester: no look-ahead', () => {
  it('changing the future cannot change any earlier signal, fill, or equity point', () => {
    const bars = demoBars('TSLA', '2025-01-13', '2025-01-17');
    const cut = et('2025-01-16', '11:00');
    const tampered = bars.map((b) => (b.time >= cut ? { ...b, open: b.open * 1.5, high: b.high * 1.9, low: b.low * 0.4, close: b.close * 0.6 } : b));
    let totalSignals = 0;
    for (const strategy of STRATEGY_PRESETS) {
      const a = runBacktest(params(bars, strategy));
      const b = runBacktest(params(tampered, strategy));
      const before = <T extends { time: number }>(xs: T[]) => xs.filter((x) => x.time < cut);
      expect(before(b.signals)).toEqual(before(a.signals));
      expect(before(b.fills)).toEqual(before(a.fills));
      expect(b.equityCurve.filter((x) => x.time <= cut)).toEqual(a.equityCurve.filter((x) => x.time <= cut));
      totalSignals += a.signals.filter((x) => x.time < cut).length;
    }
    expect(totalSignals).toBeGreaterThan(10); // the comparison is meaningful only if trades happened
  });

  it('a signal on a closed candle fills at the OPEN of the next bar, not the signal close', () => {
    // 5m candles: flat at 100 then a jump that pushes close above the EMA(3).
    const d = '2025-01-15';
    const bars: Bar[] = [];
    let t = et(d, '09:30');
    for (let i = 0; i < 40; i++) {
      const px = i < 30 ? 100 : 110 + i; // breakout starting 12:00 candle
      bars.push(bar(t, px, px + 0.2, px - 0.2, px));
      t += 60;
    }
    const strategy: StrategyDefinition = {
      name: 'test',
      rules: [{ id: 'x', logic: 'all', action: 'buy', conditions: [{ left: { kind: 'close' }, op: 'crosses_above', right: { kind: 'ema', period: 3 } }] }],
      sizing: { mode: 'shares', shares: 10 },
      exitAtSessionEnd: false,
      regularHoursOnly: true,
    };
    const r = runBacktest(params(bars, strategy, { config: ZERO_COST_CONFIG, tradeFrom: et(d, '09:30') }));
    // Breakout candle = 10:00-10:05 (bars 30..34). Signal evaluated when the 10:05 bar opens.
    expect(r.signals[0].candleTime).toBe(et(d, '10:00'));
    expect(r.signals[0].time).toBe(et(d, '10:05'));
    expect(r.fills[0].time).toBe(et(d, '10:05'));
    expect(r.fills[0].price).toBe(bars[35].open);
    expect(r.fills[0].price).not.toBe(bars[34].close);
  });
});

describe('backtester: mechanics', () => {
  it('flattens at the session end when configured, so no position is held overnight', () => {
    const bars = demoBars('NVDA', '2025-01-13', '2025-01-17');
    const r = runBacktest(params(bars, STRATEGY_PRESETS[2]));
    for (const t of r.trades.filter((x) => x.closed)) {
      expect(exchangeDate(t.entryTime)).toBe(exchangeDate(t.exitTime!));
      expect(marketSession(t.exitTime!)).toBe('regular');
    }
  });

  it('flattens before the close on 5-minute and hourly data too, and says it does not apply to daily bars', () => {
    // Always long: buys whenever flat, so only the flatten can close a trade.
    const strategy: StrategyDefinition = {
      name: 'always long',
      rules: [{ id: 'x', logic: 'all', action: 'buy', conditions: [{ left: { kind: 'close' }, op: 'above', right: { kind: 'value', value: 0 } }] }],
      sizing: { mode: 'shares', shares: 10 },
      exitAtSessionEnd: true,
      regularHoursOnly: true,
    };
    const minute = demoBars('AAPL', '2025-01-13', '2025-01-17').filter((b) => marketSession(b.time) === 'regular');
    for (const tf of ['5m', '15m', '30m', '1h'] as const) {
      const bars = aggregateBars(minute, tf);
      const r = runBacktest(params(bars, strategy, { baseTimeframe: tf, timeframe: tf, config: ZERO_COST_CONFIG }));
      const closed = r.trades.filter((t) => t.closed);
      expect(closed.length, tf).toBeGreaterThanOrEqual(3);
      for (const t of closed) expect(exchangeDate(t.exitTime!), tf).toBe(exchangeDate(t.entryTime));
    }
    const daily = aggregateBars(minute, '1D');
    const d = runBacktest(params(daily, strategy, { baseTimeframe: '1D', timeframe: '1D', config: ZERO_COST_CONFIG }));
    expect(d.warnings).toContain('Flatten before the close does not apply to daily bars: each bar is a whole session, so positions are held overnight.');
  });

  it('flattens a session whose data has no bar at the close at the next session’s open, and says so', () => {
    const strategy: StrategyDefinition = {
      name: 'always long',
      rules: [{ id: 'x', logic: 'all', action: 'buy', conditions: [{ left: { kind: 'close' }, op: 'above', right: { kind: 'value', value: 0 } }] }],
      sizing: { mode: 'shares', shares: 10 },
      exitAtSessionEnd: true,
      regularHoursOnly: false,
    };
    // A thin stock: no trade in the last minutes of the 14th and 16th; the 16th has after-hours bars.
    const thin = (b: Bar) => !(['2025-01-14', '2025-01-16'].includes(exchangeDate(b.time)) && b.time >= et(exchangeDate(b.time), '15:55') && b.time < et(exchangeDate(b.time), '16:00'));
    const all = demoBars('AAPL', '2025-01-13', '2025-01-17').filter(thin);
    const keepPost = (b: Bar) => marketSession(b.time) === 'regular' || (exchangeDate(b.time) === '2025-01-16' && marketSession(b.time) === 'post');
    for (const [label, bars] of [['1m', all.filter(keepPost)], ['5m', aggregateBars(all.filter(keepPost), '5m')]] as const) {
      const tf = label;
      const r = runBacktest(params(bars as Bar[], strategy, { baseTimeframe: tf, timeframe: tf, config: ZERO_COST_CONFIG, tradeFrom: et('2025-01-13', '09:30') }));
      const closed = r.trades.filter((t) => t.closed);
      const late = closed.filter((t) => exchangeDate(t.exitTime!) !== exchangeDate(t.entryTime));
      // Closed at the next session's first bar (not in the 16th's after-hours, where a market order cannot trade).
      expect(late.map((t) => [exchangeDate(t.entryTime), t.exitTime]), tf).toEqual([
        ['2025-01-14', et('2025-01-15', '09:30')],
        ['2025-01-16', et('2025-01-17', '09:30')],
      ]);
      expect(r.warnings, tf).toContain(
        "On 2 days (2025-01-14, 2025-01-16) the position could not all be closed in the session's last bar (no bar at the close, or more shares than the volume cap let trade there), so the rest was closed from the next session's open, after the overnight gap.",
      );
      // The rest are flattened the same day, and the strategy is long again after each late flatten.
      expect(closed.length - late.length, tf).toBeGreaterThanOrEqual(2);
      expect(r.trades.some((t) => t.entryTime > et('2025-01-17', '09:30') && t.entryTime < et('2025-01-17', '10:00')), tf).toBe(true);
    }
  });

  it('closes the rest at the next session’s open when the volume cap lets only part of the flatten trade in the last bar', () => {
    const strategy: StrategyDefinition = {
      name: 'always long',
      rules: [{ id: 'x', logic: 'all', action: 'buy', conditions: [{ left: { kind: 'close' }, op: 'above', right: { kind: 'value', value: 0 } }] }],
      sizing: { mode: 'shares', shares: 1000 },
      stopLossPct: 2,
      exitAtSessionEnd: true,
      regularHoursOnly: true,
    };
    // 2,000 shares a minute: the 25% cap trades 500 a bar, so each side of the trade takes two bars.
    const bars: Bar[] = [];
    for (const d of ['2025-01-14', '2025-01-15']) for (let m = 570; m < 960; m++) bars.push(bar(et(d, '00:00') + m * 60, 10, 10, 10, 10, 2000));
    const r = runBacktest(params(bars, strategy, { baseTimeframe: '1m', timeframe: '1m', config: { ...ZERO_COST_CONFIG, maxParticipation: 0.25 }, tradeFrom: et('2025-01-14', '09:30') }));
    const first = r.trades[0];
    expect(r.fills.filter((f) => f.orderId !== undefined && f.time >= et('2025-01-14', '15:59') && f.time < et('2025-01-15', '09:31')).map((f) => [f.action, f.quantity, f.time])).toEqual([
      ['sell', 500, et('2025-01-14', '15:59')],
      ['sell', 500, et('2025-01-15', '09:30')],
    ]);
    expect([first.closed, first.exitTime]).toEqual([true, et('2025-01-15', '09:30')]);
    expect(r.warnings.filter((w) => w.startsWith('On '))).toEqual(["On 1 day (2025-01-14) the position could not all be closed in the session's last bar (no bar at the close, or more shares than the volume cap let trade there), so the rest was closed from the next session's open, after the overnight gap."]);
  });

  it('fills a signal from a day’s last candle at the next open even when the data has no bar at the close', () => {
    // A close crossing above 10.5 on the 14th's last candle (15:58: there is no 15:59 bar). Flatten off.
    const bars: Bar[] = [];
    for (const d of ['2025-01-14', '2025-01-15'])
      for (let m = 570; m < 959; m++) {
        const last = d === '2025-01-14' && m === 958;
        const px = d === '2025-01-15' ? 11 : 10;
        bars.push(bar(et(d, '00:00') + m * 60, px, last ? 11 : px, px, last ? 11 : px, 100_000));
      }
    const strategy: StrategyDefinition = {
      name: 'cross',
      rules: [{ id: 'b', logic: 'all', action: 'buy', conditions: [{ left: { kind: 'close' }, op: 'crosses_above', right: { kind: 'value', value: 10.5 } }] }],
      sizing: { mode: 'shares', shares: 100 },
      exitAtSessionEnd: false,
      regularHoursOnly: true,
    };
    const r = runBacktest(params(bars, strategy, { baseTimeframe: '1m', timeframe: '1m', config: ZERO_COST_CONFIG, tradeFrom: et('2025-01-14', '09:30') }));
    expect(r.signals.map((x) => [x.time, x.action, x.executed])).toEqual([[et('2025-01-15', '09:30'), 'buy', true]]);
    expect(r.fills.map((f) => [f.time, f.action, f.quantity, f.price])).toEqual([[et('2025-01-15', '09:30'), 'buy', 100, 11]]);
  });

  const crossAt100 = (actions: Array<'buy' | 'sell' | 'short' | 'cover'>): StrategyDefinition['rules'] =>
    actions.map((action) => ({ id: action, logic: 'all', action, conditions: [{ left: { kind: 'close' }, op: action === 'buy' || action === 'cover' ? 'crosses_above' : 'crosses_below', right: { kind: 'value', value: 100 } }] }));

  it('sells what the volume cap left of a strategy exit at the next open, instead of holding it with no stop', () => {
    // 2,000 shares a minute (500 a bar at the 25% cap). Long 1000 from 09:41; the close crosses below 100
    // at 15:58, so the exit at 15:59 sells 500 and the rest goes at the 15th's open, 98, before the fall.
    const d1: [number, number, number, number][] = Array.from({ length: 390 }, (_, i) => (i < 10 ? [99, 99.5, 98.8, 99] : i === 10 ? [99, 101.2, 98.9, 101] : i >= 388 ? [101, 101, 99.4, 99.5] : [101, 101.3, 100.8, 101]));
    const d2: [number, number, number, number][] = Array.from({ length: 390 }, (_, i) => [98 - i * 0.02, 98.01 - i * 0.02, 97.97 - i * 0.02, 97.98 - i * 0.02]);
    const bars = [...minuteBars('2025-01-14', '09:30', d1, 2000), ...minuteBars('2025-01-15', '09:30', d2, 2000)];
    const strategy: StrategyDefinition = { name: 'cross', rules: crossAt100(['buy', 'sell']), stopLossPct: 2, sizing: { mode: 'shares', shares: 1000 }, exitAtSessionEnd: false, regularHoursOnly: true };
    const r = runBacktest(params(bars, strategy, { baseTimeframe: '1m', timeframe: '1m', config: { ...ZERO_COST_CONFIG, maxParticipation: 0.25 }, startingBalance: 1_000_000 }));
    expect(r.fills.filter((f) => f.action === 'sell').map((f) => [f.quantity, f.time, f.price])).toEqual([
      [500, et('2025-01-14', '15:59'), 101],
      [500, et('2025-01-15', '09:30'), 98],
    ]);
    expect(r.trades[0].closed).toBe(true);
  });

  it('enters a reversal decided on a thin day’s last bar at the next open, instead of letting it expire', () => {
    // The 14th ends at 15:45 (no bar at the close); the close crosses below 100 on the 15:44 candle, so
    // the long is sold at 15:45 and the short, sent once flat, fills at the 15th's open.
    const d1: [number, number, number, number][] = Array.from({ length: 376 }, (_, i) => (i === 374 ? [101, 101, 98.5, 99] : i === 375 ? [99, 99.2, 98.8, 99] : i < 10 ? [99, 99.5, 98.8, 99] : i === 10 ? [99, 101.2, 98.9, 101] : [101, 101.3, 100.8, 101]));
    const d2: [number, number, number, number][] = Array.from({ length: 390 }, () => [98.5, 98.8, 98.2, 98.5]);
    const bars = [...minuteBars('2025-01-14', '09:30', d1, 50_000), ...minuteBars('2025-01-15', '09:30', d2, 50_000)];
    const strategy: StrategyDefinition = { name: 'reverse', rules: crossAt100(['buy', 'sell', 'short', 'cover']), sizing: { mode: 'shares', shares: 100 }, exitAtSessionEnd: false, regularHoursOnly: true };
    const r = runBacktest(params(bars, strategy, { baseTimeframe: '1m', timeframe: '1m', config: ZERO_COST_CONFIG }));
    expect(r.fills.map((f) => [f.action, f.quantity, f.time])).toEqual([
      ['buy', 100, et('2025-01-14', '09:41')],
      ['sell', 100, et('2025-01-14', '15:45')],
      ['short', 100, et('2025-01-15', '09:30')],
    ]);
  });

  it('risk-percent sizing risks about the requested amount at the stop', () => {
    const bars = demoBars('AAPL', '2025-01-13', '2025-01-17');
    const r = runBacktest(params(bars, STRATEGY_PRESETS[0], { config: ZERO_COST_CONFIG }));
    expect(r.trades.length).toBeGreaterThan(0);
    for (const t of r.trades) {
      const riskDollars = Math.abs(t.avgEntry - t.initialStop!) * t.maxQuantity;
      // Entry is the next open, so risk differs slightly from the 1% computed at the signal price.
      expect(riskDollars).toBeLessThan(100_000 * 0.02 * 1.6);
    }
  });

  it('statistics are consistent with the trade list', () => {
    const bars = demoBars('SPY', '2025-01-06', '2025-01-17');
    const r = runBacktest(params(bars, STRATEGY_PRESETS[0]));
    const closed = r.trades.filter((t) => t.closed);
    expect(r.stats.totalTrades).toBe(closed.length);
    expect(r.stats.winningTrades + r.stats.losingTrades + r.stats.breakevenTrades).toBe(closed.length);
    expect(r.stats.netPnl).toBeCloseTo(closed.reduce((a, t) => a + t.pnl, 0), 6);
    expect(r.stats.maxDrawdownPct).toBeGreaterThanOrEqual(0);
  });

  it('rejects risk sizing without a stop', () => {
    const bad = { ...STRATEGY_PRESETS[0], stopLossPct: undefined };
    expect(() => runBacktest(params(demoBars('SPY', '2025-01-13', '2025-01-14'), bad))).toThrow(/stop loss/);
  });
});

describe('conditions', () => {
  it('cross detection uses the previous and current candle only', () => {
    const left = [1, 2, 3, 4];
    const right = [2, 2, 2, 2];
    const c = { left: { kind: 'close' as const }, op: 'crosses_above' as const, right: { kind: 'value' as const, value: 2 } };
    expect([0, 1, 2, 3].map((i) => evalCondition(c, left, right, i))).toEqual([false, false, true, false]);
    const below = { ...c, op: 'below' as const };
    expect(evalCondition(below, left, right, 0)).toBe(true);
    expect(evalCondition(c, [NaN, 3], right, 1)).toBe(false);
  });
});

describe('backtester: sizing and brackets that fit the account and the stock', () => {
  // One session of 1-minute bars at `from`, rising to `to` at 10:00.
  const rise = (from: number, to: number): Bar[] =>
    Array.from({ length: 60 }, (_, i) => {
      const px = i < 30 ? from : to;
      return bar(et('2025-01-15', '09:30') + i * 60, px, px, px, px, 1_000_000);
    });
  const breakout = (level: number, extra: Partial<StrategyDefinition> = {}): StrategyDefinition => ({
    name: 'breakout',
    rules: [{ id: 'b', logic: 'all', action: 'buy', conditions: [{ left: { kind: 'close' }, op: 'crosses_above', right: { kind: 'value', value: level } }] }],
    sizing: { mode: 'percent_equity', percent: 100 },
    exitAtSessionEnd: false,
    regularHoursOnly: true,
    ...extra,
  });
  const run = (bars: Bar[], strategy: StrategyDefinition, marginMultiplier = 1) =>
    runBacktest(params(bars, strategy, { timeframe: '1m', tradeFrom: et('2025-01-15', '09:30'), config: { ...DEFAULT_EXECUTION_CONFIG, marginMultiplier } }));

  it('sizes a % of equity entry to the buying power left, where it would have been refused', () => {
    // 100% of $100,000 at 5.10 is 19,607 shares, which cost more than the cash once the 5.105 ask is paid.
    const r = run(rise(5, 5.1), breakout(5.05));
    const signal = r.signals.find((s) => s.action === 'buy')!;
    expect(signal).toMatchObject({ executed: true, note: '19490 sh, capped by buying power' });
    expect(r.fills[0].quantity).toBe(19490);
    // A fixed share count is the user's own: refused when it does not fit.
    const fixed = run(rise(5, 5.1), breakout(5.05, { sizing: { mode: 'shares', shares: 19_607 } }));
    expect(fixed.signals.find((s) => s.action === 'buy')).toMatchObject({ executed: false, note: 'Insufficient buying power: need $100093.73, have $100000.00.' });
  });

  it('places % stops and targets on the sub-dollar tick', () => {
    const r = run(rise(0.36, 0.3642), breakout(0.362, { sizing: { mode: 'shares', shares: 1000 }, stopLossPct: 1, takeProfitPct: 2 }), 2);
    const trip = r.trades[0];
    expect(r.fills[0].quantity).toBe(1000);
    // 0.3642 less 1% and plus 2%, to the 0.0001 tick rather than to whole cents (0.36 and 0.37).
    const entry = r.signals.find((s) => s.action === 'buy')!.price;
    expect(entry).toBe(0.3642);
    expect(trip.initialStop).toBe(0.3606);
    expect(trip.initialTarget).toBe(0.3715);
  });
});

describe("signals on data at its own bar size", () => {
  // Price is 99 until the named bar and 101 from it on; the rule buys when the close crosses 100.
  const run = (times: string[], crossAt: string) => {
    const days = ['2024-03-04', '2024-03-05', '2024-03-06'];
    const bars = days.flatMap((d, i) => times.map((t) => {
      const px = i < 2 || et(d, t) < et(d, crossAt) ? 99 : 101;
      return bar(et(d, t), px, px + 0.2, px - 0.2, px, 100_000);
    }));
    const strategy: StrategyDefinition = {
      name: 'cross',
      rules: [{ id: 'r', conditions: [{ left: { kind: 'close' }, op: 'crosses_above', right: { kind: 'value', value: 100 } }], logic: 'all', action: 'buy' }],
      sizing: { mode: 'shares', shares: 10 },
      exitAtSessionEnd: false,
      regularHoursOnly: false,
    } as StrategyDefinition;
    const r = runBacktest(params(bars, strategy, { baseTimeframe: '1h', timeframe: '1h', tradeFrom: bars[0].time, config: ZERO_COST_CONFIG }));
    return r.signals.map((x) => x.candleTime);
  };

  it('evaluates every hourly bar, where a vendor places it', () => {
    // Clock-hour bars after a 09:30-10:00 first bar: the cross on the 09:30 bar fires on it.
    expect(run(['09:30', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00'], '09:30')).toEqual([et('2024-03-06', '09:30')]);
    // yfinance's hourly bars with extended hours: 15:30 is followed by the 16:00 after-hours bar.
    const yf = ['04:00', '05:00', '06:00', '07:00', '08:00', '09:00', '09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:30', '16:00', '17:00', '18:00', '19:00'];
    expect(run(yf, '15:30')).toEqual([et('2024-03-06', '15:30')]);
  });

  it("fills a signal on a 09:30-10:00 first bar at the 10:00 bar's open", () => {
    const times = ['09:30', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00'];
    // Each bar of the last day opens a dollar higher, so the fill names the bar it came from.
    const bars = ['2024-03-04', '2024-03-05', '2024-03-06'].flatMap((d, i) =>
      times.map((t, k) => {
        const px = i < 2 ? 99 : 101 + k;
        return bar(et(d, t), px, px + 0.2, px - 0.2, px, 100_000);
      }),
    );
    const strategy = {
      name: 'cross',
      rules: [{ id: 'r', conditions: [{ left: { kind: 'close' }, op: 'crosses_above', right: { kind: 'value', value: 100 } }], logic: 'all', action: 'buy' }],
      sizing: { mode: 'shares', shares: 10 },
      exitAtSessionEnd: false,
      regularHoursOnly: false,
    } as StrategyDefinition;
    const r = runBacktest(params(bars, strategy, { baseTimeframe: '1h', timeframe: '1h', tradeFrom: bars[0].time, config: ZERO_COST_CONFIG }));
    expect(r.fills.map((f) => [f.time, f.price])).toEqual([[et('2024-03-06', '10:00'), 102]]);
  });
});


describe('backtester: indicator warm-up', () => {
  const smaCross = (period: number): StrategyDefinition => ({
    name: 'SMA cross',
    rules: [
      { id: 'b', logic: 'all', action: 'buy', conditions: [{ left: { kind: 'close' }, op: 'crosses_above', right: { kind: 'sma', period } }] },
      { id: 's', logic: 'all', action: 'sell', conditions: [{ left: { kind: 'close' }, op: 'crosses_below', right: { kind: 'sma', period } }] },
    ],
    sizing: { mode: 'percent_equity', percent: 100 },
    exitAtSessionEnd: false,
    regularHoursOnly: true,
  });

  it('asks for enough history for the longest indicator on the signal timeframe, with room for EMA, MACD, RSI and ATR to settle', () => {
    // SMA 200 crossing on daily candles: 200 candles for its first value and one more for the cross.
    expect(strategyWarmup(smaCross(200))).toBe(201);
    expect(warmupTradingDays(smaCross(200), '1D')).toBe(202);
    expect(seriesWarmup({ kind: 'ema', period: 200 })).toBe(600);
    expect(seriesWarmup({ kind: 'rsi', period: 14 })).toBe(71);
    expect(seriesWarmup({ kind: 'atr', period: 14 })).toBe(70);
    expect(seriesWarmup({ kind: 'macd_signal', fast: 12, slow: 26, signal: 9 })).toBe(105);
    expect(seriesWarmup({ kind: 'vwap' })).toBe(1);
    // The day-trading presets need less than a day of 5-minute candles; the MACD preset 107 daily candles.
    expect(warmupTradingDays(STRATEGY_PRESETS[0], '5m')).toBe(2);
    expect(warmupTradingDays(STRATEGY_PRESETS[3], '1D')).toBe(107);
    // Never fewer candles than the series needs for its first value.
    const candles = demoBars('SPY', '2025-01-13', '2025-01-17').filter((b) => marketSession(b.time) === 'regular');
    const refs: SeriesRef[] = [
      { kind: 'sma', period: 30 },
      { kind: 'ema', period: 30 },
      { kind: 'rsi', period: 30 },
      { kind: 'atr', period: 30 },
      { kind: 'macd', fast: 12, slow: 26, signal: 9 },
      { kind: 'macd_signal', fast: 26, slow: 12, signal: 9 },
      { kind: 'macd_hist', fast: 12, slow: 26, signal: 9 },
      { kind: 'bb_lower', period: 30, mult: 2 },
      { kind: 'vwap' },
    ];
    for (const ref of refs) expect(computeSeries(ref, candles).findIndex((v) => !Number.isNaN(v)) + 1, ref.kind).toBeLessThanOrEqual(seriesWarmup(ref));
    // The seed's remaining weight after the extra history is under 2%: EMA forgets at 2/(p+1) a candle, Wilder's smoothing at 1/p.
    for (const period of [2, 9, 14, 50, 200]) {
      expect((1 - 2 / (period + 1)) ** (seriesWarmup({ kind: 'ema', period }) - period)).toBeLessThan(0.02);
      expect((1 - 1 / period) ** (seriesWarmup({ kind: 'atr', period }) - period)).toBeLessThan(0.02);
    }
  });

  it('gives the same results from warm-up candles built a few days at a time as from every warm-up bar', () => {
    const all = demoBars('AAPL', '2024-12-02', '2025-01-24');
    const tradeFrom = et('2025-01-14', '00:00');
    const cases: [StrategyDefinition, BacktestParams['timeframe']][] = [
      [STRATEGY_PRESETS[0], '5m'],
      [{ ...STRATEGY_PRESETS[2], regularHoursOnly: false }, '15m'],
      [STRATEGY_PRESETS[3], '1h'],
      [{ ...STRATEGY_PRESETS[4], exitAtSessionEnd: true }, '4h'],
      [smaCross(10), '1D'],
    ];
    for (const [strategy, timeframe] of cases) {
      const whole = runBacktest(params(all, strategy, { timeframe, tradeFrom }));
      // Seven trading days at a time, the way the backtest page loads a long warm-up.
      const warmupCandles = [];
      for (let d = '2024-12-02'; d < '2025-01-14'; ) {
        let next = d;
        for (let i = 0; i < 7 && next < '2025-01-14'; i++) next = nextTradingDay(next);
        const piece = all.filter((b) => b.time >= et(d, '00:00') && b.time < et(next, '00:00'));
        warmupCandles.push(...warmupCandlesFrom(piece, strategy, timeframe, '1m'));
        d = next;
      }
      const split = runBacktest(params(all.filter((b) => b.time >= tradeFrom), strategy, { timeframe, tradeFrom, warmupCandles }));
      expect(whole.signals.length, timeframe).toBeGreaterThan(0);
      expect(split.candles, timeframe).toEqual(whole.candles);
      expect(split.signals, timeframe).toEqual(whole.signals);
      expect(split.fills, timeframe).toEqual(whole.fills);
      expect(split.trades, timeframe).toEqual(whole.trades);
      expect(split.equityCurve, timeframe).toEqual(whole.equityCurve);
      expect(split.warnings, timeframe).toEqual(whole.warnings);
    }
  });

  it('warms up SMA 200 on daily candles from the history before the test, and says when the history was too short', () => {
    // Daily bars (stamped at the open, as imported daily files are) on a slow wave that crosses its SMA 200 every few months.
    const days: string[] = [];
    for (let d = '2024-01-02'; d <= '2026-06-30'; d = nextTradingDay(d)) days.push(d);
    const daily = days.map((d, i) => {
      const px = 100 + 15 * Math.sin((2 * Math.PI * i) / 130) + i * 0.01;
      return bar(et(d, '09:30'), px, px + 0.5, px - 0.5, px, 1_000_000);
    });
    const start = '2025-10-01';
    const run = (warmDays: number) => {
      let warm = start;
      for (let i = 0; i < warmDays; i++) warm = prevTradingDay(warm);
      const warmupCandles = warmupCandlesFrom(daily.filter((b) => b.time >= et(warm, '00:00') && b.time < et(start, '00:00')), smaCross(200), '1D', '1D');
      return runBacktest(params(daily.filter((b) => b.time >= et(start, '00:00')), smaCross(200), { baseTimeframe: '1D', timeframe: '1D', tradeFrom: et(start, '00:00'), config: ZERO_COST_CONFIG, warmupCandles }));
    };
    // The page used to load 60 days at most: SMA 200 had no value until its 200th candle, 140 into the test.
    const short = run(60);
    const firstValue = exchangeDate(daily[days.indexOf(start) - 60 + 199].time);
    expect(short.warnings).toEqual([
      `Not enough history before ${start} to warm up the indicators: the data had 60 1D candles before it. SMA 200 (needs 200) first had a value on the ${firstValue} candle, so rules using it could not fire before then.`,
    ]);
    expect(short.signals.every((x) => exchangeDate(x.candleTime) >= firstValue)).toBe(true);
    // With the warm-up the rules ask for, the indicator has a value from the start, and signals come before that date.
    const full = run(warmupTradingDays(smaCross(200), '1D'));
    expect(full.warnings).toEqual([]);
    expect(full.signals.some((x) => exchangeDate(x.candleTime) < firstValue)).toBe(true);
    // Values still settling are named too: an EMA 50 has a value after 50 candles but needs 150.
    const ema: StrategyDefinition = { ...smaCross(200), rules: [{ id: 'e', logic: 'all', action: 'buy', conditions: [{ left: { kind: 'close' }, op: 'above', right: { kind: 'ema', period: 50 } }] }] };
    const warmupCandles = warmupCandlesFrom(daily.filter((b) => b.time < et(start, '00:00')).slice(-100), ema, '1D', '1D');
    const settling = runBacktest(params(daily.filter((b) => b.time >= et(start, '00:00')), ema, { baseTimeframe: '1D', timeframe: '1D', tradeFrom: et(start, '00:00'), config: ZERO_COST_CONFIG, warmupCandles }));
    expect(settling.warnings.filter((w) => w.startsWith('Not enough history'))).toEqual([
      `Not enough history before ${start} to warm up the indicators: the data had 100 1D candles before it. EMA 50 (needs 150) had values from the start, but they were still settling, so early signals may differ from a chart with more history.`,
    ]);
  });
});

describe('backtester: flatten before the close with daily candles', () => {
  const alwaysLong = (exitAtSessionEnd: boolean): StrategyDefinition => ({
    name: 'always long',
    rules: [{ id: 'x', logic: 'all', action: 'buy', conditions: [{ left: { kind: 'close' }, op: 'above', right: { kind: 'value', value: 0 } }] }],
    sizing: { mode: 'shares', shares: 10 },
    exitAtSessionEnd,
    regularHoursOnly: true,
  });
  const minute = demoBars('AAPL', '2025-01-13', '2025-01-17');

  it('holds overnight with a 1D signal timeframe on minute data, as on daily bars, and says so', () => {
    const r = runBacktest(params(minute, alwaysLong(true), { timeframe: '1D', config: ZERO_COST_CONFIG, tradeFrom: et('2025-01-13', '00:00') }));
    // Bought at the 14th's open after the 13th's candle closed, and still held at the end.
    expect(r.trades.map((t) => [t.entryTime, t.closed])).toEqual([[et('2025-01-14', '09:30'), false]]);
    expect(r.fills).toEqual(runBacktest(params(minute, alwaysLong(false), { timeframe: '1D', config: ZERO_COST_CONFIG, tradeFrom: et('2025-01-13', '00:00') })).fills);
    expect(r.warnings).toContain('Flatten before the close does not apply to the 1D signal timeframe: each candle is a whole session, so positions are held overnight, as on daily bars.');
    // The same strategy on daily bars holds just the same.
    const daily = runBacktest(params(aggregateBars(minute.filter((b) => marketSession(b.time) === 'regular'), '1D'), alwaysLong(true), { baseTimeframe: '1D', timeframe: '1D', config: ZERO_COST_CONFIG, tradeFrom: et('2025-01-13', '00:00') }));
    expect(daily.trades.map((t) => [t.entryTime, t.closed])).toEqual([[et('2025-01-14', '09:30'), false]]);
  });

  it('still flattens every day with 4-hour candles on minute data', () => {
    const r = runBacktest(params(minute, alwaysLong(true), { timeframe: '4h', config: ZERO_COST_CONFIG, tradeFrom: et('2025-01-13', '00:00') }));
    const closed = r.trades.filter((t) => t.closed);
    expect(closed.length).toBeGreaterThanOrEqual(3);
    for (const t of closed) expect(exchangeDate(t.exitTime!)).toBe(exchangeDate(t.entryTime));
    expect(r.warnings.some((w) => w.startsWith('Flatten before the close'))).toBe(false);
  });
});

describe('the name results give a strategy', () => {
  const preset = STRATEGY_PRESETS[0];
  const copy = (): StrategyDefinition => JSON.parse(JSON.stringify(preset));

  it("keeps a preset's name only while its rules and settings are the preset's", () => {
    expect(strategyLabel(copy())).toBe(preset.name);
    const period = copy();
    period.rules[0].conditions[0].right = { kind: 'ema', period: 30 };
    expect(strategyLabel(period)).toBe(`Custom rules based on ${preset.name}`);
    const added = copy();
    added.rules.push({ id: 'new', logic: 'all', action: 'short', conditions: [{ left: { kind: 'close' }, op: 'below', right: { kind: 'vwap' } }] });
    expect(strategyLabel(added)).toBe(`Custom rules based on ${preset.name}`);
    const stop = { ...copy(), stopLossPct: 2 };
    expect(strategyLabel(stop)).toBe(`${preset.name} with edited settings`);
    expect(strategyLabel({ ...copy(), exitAtSessionEnd: false })).toBe(`${preset.name} with edited settings`);
    expect(strategyLabel({ ...copy(), sizing: { mode: 'risk_percent', percent: 2 } })).toBe(`${preset.name} with edited settings`);
  });

  it('does not count a new rule id, or ALL and ANY on a single condition, as an edit', () => {
    const same = copy();
    same.rules = same.rules.map((r, i) => ({ ...r, id: `again${i}`, logic: 'any' }));
    expect(strategyLabel(same)).toBe(preset.name);
  });

  it('uses a name the user typed as it is', () => {
    expect(strategyLabel({ ...copy(), name: '  My breakout ' })).toBe('My breakout');
    expect(strategyLabel({ ...copy(), name: ' ' })).toBe('Unnamed strategy');
  });
});
