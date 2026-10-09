import { describe, expect, it } from 'vitest';
import { runBacktest, type BacktestParams } from '../backtest/Backtester';
import { STRATEGY_PRESETS, evalCondition, type StrategyDefinition } from '../backtest/strategy';
import { DemoDataProvider } from '../data/demoProvider';
import { ZERO_COST_CONFIG, DEFAULT_EXECUTION_CONFIG } from '../broker/config';
import { bar, et } from './helpers';
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
