/**
 * Technical indicators. Every function is CAUSAL: output[i] depends only on inputs[0..i].
 * That property is what makes them safe for replay and backtesting, and it is enforced by tests
 * (computing on a prefix must give identical values to computing on the full series).
 * Warm-up values are NaN.
 */
import type { Bar } from '../types';
import { exchangeDate } from '../time';

export function sma(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values (standard TradingView/TA-Lib behaviour). */
export function ema(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0) return out;
  const k = 2 / (period + 1);
  let prev = NaN;
  let seedSum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(prev)) {
      seedSum += v;
      count++;
      if (count === period) {
        prev = seedSum / period;
        out[i] = prev;
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/** Wilder's smoothing (RMA), seeded with an SMA. */
export function rma(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let prev = NaN;
  let seedSum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(prev)) {
      seedSum += v;
      count++;
      if (count === period) {
        prev = seedSum / period;
        out[i] = prev;
      }
    } else {
      prev = (prev * (period - 1) + v) / period;
      out[i] = prev;
    }
  }
  return out;
}

/** RSI (Wilder). */
export function rsi(closes: readonly number[], period = 14): number[] {
  const gains: number[] = [NaN];
  const losses: number[] = [NaN];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const ag = rma(gains, period);
  const al = rma(losses, period);
  return closes.map((_, i) => {
    if (Number.isNaN(ag[i]) || Number.isNaN(al[i])) return NaN;
    if (al[i] === 0) return ag[i] === 0 ? 50 : 100;
    return 100 - 100 / (1 + ag[i] / al[i]);
  });
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(closes: readonly number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => (Number.isNaN(f[i]) || Number.isNaN(s[i]) ? NaN : f[i] - s[i]));
  const signal = ema(line, signalPeriod);
  const histogram = line.map((v, i) => (Number.isNaN(v) || Number.isNaN(signal[i]) ? NaN : v - signal[i]));
  return { macd: line, signal, histogram };
}

export interface BandsResult {
  middle: number[];
  upper: number[];
  lower: number[];
}

/** Bollinger Bands using population standard deviation (as TradingView does). */
export function bollinger(closes: readonly number[], period = 20, mult = 2): BandsResult {
  const middle = sma(closes, period);
  const upper = new Array<number>(closes.length).fill(NaN);
  const lower = new Array<number>(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    const m = middle[i];
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - m) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { middle, upper, lower };
}

export function trueRange(bars: readonly Bar[]): number[] {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

export function atr(bars: readonly Bar[], period = 14): number[] {
  return rma(trueRange(bars), period);
}

/**
 * Session VWAP: resets at the start of each exchange trading date. Uses typical price (H+L+C)/3.
 * With 1m inputs this is the standard intraday VWAP; on higher timeframes it is approximated
 * from that timeframe's bars (as charting platforms do).
 */
export function vwap(bars: readonly Bar[]): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  let day = '';
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const d = exchangeDate(b.time);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * b.volume;
    vol += b.volume;
    out[i] = vol > 0 ? pv / vol : tp;
  }
  return out;
}

export const closesOf = (bars: readonly Bar[]): number[] => bars.map((b) => b.close);
