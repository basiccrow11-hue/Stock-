/**
 * Rule-based strategy definitions for the backtester.
 *
 *   IF <conditions> (ALL / ANY)  THEN <buy | sell | short | cover>
 *
 * Conditions compare two series (price, indicator, or a constant). Every series is computed with the
 * causal indicator functions, and a condition at candle i reads only values at i and i-1.
 */
import type { Bar, OrderAction } from '../types';
import { atr, bollinger, ema, macd, rsi, sma, vwap } from '../indicators/indicators';

export type SeriesRef =
  | { kind: 'close' | 'open' | 'high' | 'low' }
  | { kind: 'sma' | 'ema'; period: number }
  | { kind: 'vwap' }
  | { kind: 'rsi'; period: number }
  | { kind: 'macd' | 'macd_signal' | 'macd_hist'; fast: number; slow: number; signal: number }
  | { kind: 'bb_upper' | 'bb_middle' | 'bb_lower'; period: number; mult: number }
  | { kind: 'atr'; period: number }
  | { kind: 'value'; value: number };

export type Operator = 'crosses_above' | 'crosses_below' | 'above' | 'below';

export interface Condition {
  left: SeriesRef;
  op: Operator;
  right: SeriesRef;
}

export interface Rule {
  id: string;
  conditions: Condition[];
  logic: 'all' | 'any';
  action: OrderAction;
}

export type Sizing = { mode: 'shares'; shares: number } | { mode: 'percent_equity'; percent: number } | { mode: 'risk_percent'; percent: number };

export interface StrategyDefinition {
  name: string;
  rules: Rule[];
  /** Protective stop as % from the signal price (placed as a bracket on entry). */
  stopLossPct?: number;
  takeProfitPct?: number;
  sizing: Sizing;
  /** Flatten in the last minute of each regular session (day-trading style). */
  exitAtSessionEnd: boolean;
  /** Ignore pre/post-market bars entirely. */
  regularHoursOnly: boolean;
}

export function seriesKey(s: SeriesRef): string {
  switch (s.kind) {
    case 'sma':
    case 'ema':
      return `${s.kind}(${s.period})`;
    case 'rsi':
    case 'atr':
      return `${s.kind}(${s.period})`;
    case 'macd':
    case 'macd_signal':
    case 'macd_hist':
      return `${s.kind}(${s.fast},${s.slow},${s.signal})`;
    case 'bb_upper':
    case 'bb_middle':
    case 'bb_lower':
      return `${s.kind}(${s.period},${s.mult})`;
    case 'value':
      return `${s.value}`;
    default:
      return s.kind;
  }
}

export function seriesLabel(s: SeriesRef): string {
  switch (s.kind) {
    case 'close':
    case 'open':
    case 'high':
    case 'low':
      return `Price (${s.kind})`;
    case 'sma':
      return `SMA ${s.period}`;
    case 'ema':
      return `EMA ${s.period}`;
    case 'vwap':
      return 'VWAP';
    case 'rsi':
      return `RSI ${s.period}`;
    case 'macd':
      return `MACD (${s.fast},${s.slow})`;
    case 'macd_signal':
      return `MACD signal (${s.signal})`;
    case 'macd_hist':
      return 'MACD histogram';
    case 'bb_upper':
      return `Upper BB ${s.period}`;
    case 'bb_middle':
      return `Middle BB ${s.period}`;
    case 'bb_lower':
      return `Lower BB ${s.period}`;
    case 'atr':
      return `ATR ${s.period}`;
    case 'value':
      return String(s.value);
  }
}

export const OPERATOR_LABELS: Record<Operator, string> = {
  crosses_above: 'crosses above',
  crosses_below: 'crosses below',
  above: 'is above',
  below: 'is below',
};

/** Compute a series over completed candles. Causal: value[i] uses candles[0..i] only. */
export function computeSeries(s: SeriesRef, bars: readonly Bar[]): number[] {
  const closes = bars.map((b) => b.close);
  switch (s.kind) {
    case 'close':
    case 'open':
    case 'high':
    case 'low':
      return bars.map((b) => b[s.kind]);
    case 'sma':
      return sma(closes, s.period);
    case 'ema':
      return ema(closes, s.period);
    case 'vwap':
      return vwap(bars);
    case 'rsi':
      return rsi(closes, s.period);
    case 'macd':
      return macd(closes, s.fast, s.slow, s.signal).macd;
    case 'macd_signal':
      return macd(closes, s.fast, s.slow, s.signal).signal;
    case 'macd_hist':
      return macd(closes, s.fast, s.slow, s.signal).histogram;
    case 'bb_upper':
      return bollinger(closes, s.period, s.mult).upper;
    case 'bb_middle':
      return bollinger(closes, s.period, s.mult).middle;
    case 'bb_lower':
      return bollinger(closes, s.period, s.mult).lower;
    case 'atr':
      return atr(bars, s.period);
    case 'value':
      return bars.map(() => s.value);
  }
}

/** Evaluate a condition at candle i using only values at i and i-1. */
export function evalCondition(c: Condition, left: readonly number[], right: readonly number[], i: number): boolean {
  const l = left[i];
  const r = right[i];
  if (Number.isNaN(l) || Number.isNaN(r)) return false;
  switch (c.op) {
    case 'above':
      return l > r;
    case 'below':
      return l < r;
    case 'crosses_above':
    case 'crosses_below': {
      if (i < 1) return false;
      const lp = left[i - 1];
      const rp = right[i - 1];
      if (Number.isNaN(lp) || Number.isNaN(rp)) return false;
      return c.op === 'crosses_above' ? lp <= rp && l > r : lp >= rp && l < r;
    }
  }
}

let ruleSeq = 0;
const rid = () => `r${++ruleSeq}`;

/** Ready-made strategies matching common rule sets. */
export const STRATEGY_PRESETS: StrategyDefinition[] = [
  {
    name: 'EMA 9/21 crossover (long only)',
    rules: [
      { id: rid(), logic: 'all', action: 'buy', conditions: [{ left: { kind: 'ema', period: 9 }, op: 'crosses_above', right: { kind: 'ema', period: 21 } }] },
      { id: rid(), logic: 'all', action: 'sell', conditions: [{ left: { kind: 'ema', period: 9 }, op: 'crosses_below', right: { kind: 'ema', period: 21 } }] },
    ],
    stopLossPct: 1,
    takeProfitPct: 2,
    sizing: { mode: 'risk_percent', percent: 1 },
    exitAtSessionEnd: true,
    regularHoursOnly: true,
  },
  {
    name: 'RSI oversold bounce above VWAP',
    rules: [
      {
        id: rid(),
        logic: 'all',
        action: 'buy',
        conditions: [
          { left: { kind: 'rsi', period: 14 }, op: 'crosses_above', right: { kind: 'value', value: 30 } },
          { left: { kind: 'close' }, op: 'above', right: { kind: 'vwap' } },
        ],
      },
      { id: rid(), logic: 'any', action: 'sell', conditions: [{ left: { kind: 'rsi', period: 14 }, op: 'above', right: { kind: 'value', value: 70 } }] },
    ],
    stopLossPct: 0.75,
    takeProfitPct: 1.5,
    sizing: { mode: 'risk_percent', percent: 1 },
    exitAtSessionEnd: true,
    regularHoursOnly: true,
  },
  {
    name: 'VWAP cross long/short',
    rules: [
      { id: rid(), logic: 'all', action: 'buy', conditions: [{ left: { kind: 'close' }, op: 'crosses_above', right: { kind: 'vwap' } }] },
      { id: rid(), logic: 'all', action: 'sell', conditions: [{ left: { kind: 'close' }, op: 'crosses_below', right: { kind: 'vwap' } }] },
      { id: rid(), logic: 'all', action: 'short', conditions: [{ left: { kind: 'close' }, op: 'crosses_below', right: { kind: 'vwap' } }] },
      { id: rid(), logic: 'all', action: 'cover', conditions: [{ left: { kind: 'close' }, op: 'crosses_above', right: { kind: 'vwap' } }] },
    ],
    stopLossPct: 0.5,
    sizing: { mode: 'percent_equity', percent: 50 },
    exitAtSessionEnd: true,
    regularHoursOnly: true,
  },
  {
    name: 'MACD signal-line cross',
    rules: [
      {
        id: rid(),
        logic: 'all',
        action: 'buy',
        conditions: [{ left: { kind: 'macd', fast: 12, slow: 26, signal: 9 }, op: 'crosses_above', right: { kind: 'macd_signal', fast: 12, slow: 26, signal: 9 } }],
      },
      {
        id: rid(),
        logic: 'all',
        action: 'sell',
        conditions: [{ left: { kind: 'macd', fast: 12, slow: 26, signal: 9 }, op: 'crosses_below', right: { kind: 'macd_signal', fast: 12, slow: 26, signal: 9 } }],
      },
    ],
    stopLossPct: 1,
    sizing: { mode: 'percent_equity', percent: 100 },
    exitAtSessionEnd: false,
    regularHoursOnly: true,
  },
  {
    name: 'Price crosses above EMA 20, RSI filter',
    rules: [
      {
        id: rid(),
        logic: 'all',
        action: 'buy',
        conditions: [
          { left: { kind: 'close' }, op: 'crosses_above', right: { kind: 'ema', period: 20 } },
          { left: { kind: 'rsi', period: 14 }, op: 'below', right: { kind: 'value', value: 65 } },
        ],
      },
      { id: rid(), logic: 'all', action: 'sell', conditions: [{ left: { kind: 'close' }, op: 'crosses_below', right: { kind: 'ema', period: 20 } }] },
    ],
    stopLossPct: 1,
    takeProfitPct: 3,
    sizing: { mode: 'risk_percent', percent: 1 },
    exitAtSessionEnd: false,
    regularHoursOnly: true,
  },
];
