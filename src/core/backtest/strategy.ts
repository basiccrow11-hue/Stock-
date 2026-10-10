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

/**
 * How many completed candles a series needs before its values can be used: up to and including its
 * first value, and for indicators that carry their past forward (EMA, MACD, RSI, ATR), enough more
 * that the starting value they were seeded with weighs under 2% of today's. That is three times the
 * period for an EMA or the MACD line (the signal line needs three times its own period on top), and
 * five times for RSI and ATR, whose Wilder smoothing forgets more slowly. Prices, numbers and VWAP
 * (which restarts every session) need only the candle itself.
 */
export function seriesWarmup(s: SeriesRef): number {
  switch (s.kind) {
    case 'sma':
    case 'bb_upper':
    case 'bb_middle':
    case 'bb_lower':
      return s.period;
    case 'ema':
      return 3 * s.period;
    case 'rsi':
      // The first change needs a previous close.
      return 5 * s.period + 1;
    case 'atr':
      return 5 * s.period;
    case 'macd':
      return 3 * Math.max(s.fast, s.slow);
    case 'macd_signal':
    case 'macd_hist':
      return 3 * Math.max(s.fast, s.slow) + 3 * s.signal;
    default:
      return 1;
  }
}

/** Candles of history the rules need before they are first evaluated: the longest series warm-up, plus the previous candle a cross compares with. */
export function strategyWarmup(strategy: StrategyDefinition): number {
  let n = 1;
  for (const rule of strategy.rules) {
    for (const c of rule.conditions) {
      const cross = c.op === 'crosses_above' || c.op === 'crosses_below' ? 1 : 0;
      n = Math.max(n, Math.max(seriesWarmup(c.left), seriesWarmup(c.right)) + cross);
    }
  }
  return n;
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

/** A rule as text, without its id, and without ALL or ANY when it has one condition (both mean the same then). */
function ruleKey(r: Rule): string {
  const conditions = r.conditions.map((c) => `${seriesKey(c.left)} ${c.op} ${seriesKey(c.right)}`).join(' ; ');
  return `${r.conditions.length > 1 ? r.logic : ''} ${conditions} => ${r.action}`;
}

/**
 * What results call a strategy. A preset's name is used only while the strategy still is that preset:
 * edited rules are "Custom rules based on" it, and its rules with another stop, target, size or
 * session setting are the preset "with edited settings". A name the user typed is used as typed.
 */
export function strategyLabel(s: StrategyDefinition): string {
  const name = s.name.trim();
  const preset = STRATEGY_PRESETS.find((p) => p.name === name);
  if (!preset) return name || 'Unnamed strategy';
  if (s.rules.length !== preset.rules.length || s.rules.some((r, i) => ruleKey(r) !== ruleKey(preset.rules[i]))) return `Custom rules based on ${preset.name}`;
  const settings = (x: StrategyDefinition) =>
    JSON.stringify([x.stopLossPct ?? null, x.takeProfitPct ?? null, x.sizing.mode, x.sizing.mode === 'shares' ? x.sizing.shares : x.sizing.percent, x.exitAtSessionEnd, x.regularHoursOnly]);
  if (settings(s) !== settings(preset)) return `${preset.name} with edited settings`;
  return preset.name;
}
