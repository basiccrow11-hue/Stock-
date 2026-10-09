import { describe, expect, it } from 'vitest';
import { runBacktest, type BacktestParams } from '../backtest/Backtester';
import { STRATEGY_PRESETS, evalCondition, type StrategyDefinition } from '../backtest/strategy';
import { DemoDataProvider } from '../data/demoProvider';
import { ZERO_COST_CONFIG, DEFAULT_EXECUTION_CONFIG } from '../broker/config';
import { bar, et, minuteBars } from './helpers';
import type { Bar } from '../types';
import { aggregateBars } from '../data/aggregate';
import { exchangeDate, marketSession } from '../time';

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
