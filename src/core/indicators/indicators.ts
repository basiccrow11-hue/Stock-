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

/**
 * State of an SMA-seeded exponential smoothing: the EMA, or Wilder's RMA. Shared by the batch
 * functions and the streams below, so both do the same arithmetic in the same order.
 */
interface Smoothing {
  prev: number;
  seedSum: number;
  count: number;
}

const smoothing = (): Smoothing => ({ prev: NaN, seedSum: 0, count: 0 });

/**
 * Feeds `v` to `s` and returns the smoothed value: NaN while the first `period` values seed it, or
 * for a NaN input (which is skipped). `wilder` smooths by 1/period (RMA), else by 2/(period+1) (EMA).
 */
function smooth(s: Smoothing, v: number, period: number, wilder: boolean): number {
  if (Number.isNaN(v)) return NaN;
  if (Number.isNaN(s.prev)) {
    s.seedSum += v;
    s.count++;
    if (s.count !== period) return NaN;
    s.prev = s.seedSum / period;
  } else if (wilder) {
    s.prev = (s.prev * (period - 1) + v) / period;
  } else {
    const k = 2 / (period + 1);
    s.prev = v * k + s.prev * (1 - k);
  }
  return s.prev;
}

/** EMA seeded with the SMA of the first `period` values (standard TradingView/TA-Lib behaviour). */
export function ema(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0) return out;
  const s = smoothing();
  for (let i = 0; i < values.length; i++) out[i] = smooth(s, values[i], period, false);
  return out;
}

/** Wilder's smoothing (RMA), seeded with an SMA. */
export function rma(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0) return out;
  const s = smoothing();
  for (let i = 0; i < values.length; i++) out[i] = smooth(s, values[i], period, true);
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

// ---------------------------------------------------------------- incremental (charts)

/**
 * An indicator kept up to date as a chart's candles change: candles are added at the end, and the
 * newest one may still change (a forming candle) between calls. Each call computes only the candles
 * that are new or changed, and the values are identical to the batch functions above on the same
 * candles (the same arithmetic in the same order).
 */
export interface IndicatorStream {
  /** Output lines, each with one value per candle (NaN while warming up). */
  readonly lines: readonly (readonly number[])[];
  /**
   * Brings the lines up to date with `bars` (oldest first), where the bars before index `from` are
   * the same as at the last call. Anything else (a rewind, another series) is computed from scratch.
   */
  update(bars: readonly Bar[], from: number): void;
}

/**
 * What to compute. Lines, in order: sma, ema, rsi, atr and vwap one; bb the upper band, middle and
 * lower band; macd the histogram, MACD line and signal line.
 */
export type IndicatorSpec =
  | { type: 'sma' | 'ema' | 'rsi' | 'atr'; period: number }
  | { type: 'bb'; period: number; mult: number }
  | { type: 'macd'; fast: number; slow: number; signal: number }
  | { type: 'vwap' };

/**
 * The bookkeeping shared by every stream: the state after the bars whose values are final (all but
 * the newest), and a throwaway copy of it for the newest bar, which may still change.
 */
abstract class Stream<S> implements IndicatorStream {
  readonly lines: number[][];
  private state: S;
  /** Bars the state has taken in. */
  private done = 0;

  constructor(lineCount: number) {
    this.lines = Array.from({ length: lineCount }, () => []);
    this.state = this.initial();
  }

  protected abstract initial(): S;
  protected abstract copy(s: S): S;
  /** Takes bar `i` into `s` and writes its values. */
  protected abstract step(s: S, bars: readonly Bar[], i: number): void;

  update(bars: readonly Bar[], from: number): void {
    if (from < this.done || bars.length < this.done) {
      this.state = this.initial();
      this.done = 0;
    }
    while (this.done < bars.length - 1) this.step(this.state, bars, this.done++);
    if (bars.length > this.done) this.step(this.copy(this.state), bars, bars.length - 1);
    for (const line of this.lines) line.length = bars.length;
  }
}

class SmaStream extends Stream<{ sum: number }> {
  constructor(private period: number) {
    super(1);
  }
  protected initial() {
    return { sum: 0 };
  }
  protected copy(s: { sum: number }) {
    return { ...s };
  }
  protected step(s: { sum: number }, bars: readonly Bar[], i: number): void {
    this.lines[0][i] = smaStep(s, bars, i, this.period);
  }
}

/** The running-sum SMA of closes at bar `i`, as sma() computes it. */
function smaStep(s: { sum: number }, bars: readonly Bar[], i: number, period: number): number {
  if (period <= 0) return NaN;
  s.sum += bars[i].close;
  if (i >= period) s.sum -= bars[i - period].close;
  return i >= period - 1 ? s.sum / period : NaN;
}

class EmaStream extends Stream<Smoothing> {
  constructor(private period: number) {
    super(1);
  }
  protected initial() {
    return smoothing();
  }
  protected copy(s: Smoothing) {
    return { ...s };
  }
  protected step(s: Smoothing, bars: readonly Bar[], i: number): void {
    this.lines[0][i] = this.period <= 0 ? NaN : smooth(s, bars[i].close, this.period, false);
  }
}

class BollingerStream extends Stream<{ sum: number }> {
  constructor(
    private period: number,
    private mult: number,
  ) {
    super(3);
  }
  protected initial() {
    return { sum: 0 };
  }
  protected copy(s: { sum: number }) {
    return { ...s };
  }
  protected step(s: { sum: number }, bars: readonly Bar[], i: number): void {
    const p = this.period;
    const m = smaStep(s, bars, i, p);
    let upper = NaN;
    let lower = NaN;
    if (p > 0 && i >= p - 1) {
      let v = 0;
      for (let j = i - p + 1; j <= i; j++) v += (bars[j].close - m) ** 2;
      const sd = Math.sqrt(v / p);
      upper = m + this.mult * sd;
      lower = m - this.mult * sd;
    }
    this.lines[0][i] = upper;
    this.lines[1][i] = m;
    this.lines[2][i] = lower;
  }
}

type RsiState = { gains: Smoothing; losses: Smoothing };

class RsiStream extends Stream<RsiState> {
  constructor(private period: number) {
    super(1);
  }
  protected initial() {
    return { gains: smoothing(), losses: smoothing() };
  }
  protected copy(s: RsiState) {
    return { gains: { ...s.gains }, losses: { ...s.losses } };
  }
  protected step(s: RsiState, bars: readonly Bar[], i: number): void {
    const p = this.period;
    // The first bar has no change: like rsi(), it feeds nothing (NaN is skipped).
    const d = i > 0 ? bars[i].close - bars[i - 1].close : NaN;
    const ag = p <= 0 ? NaN : smooth(s.gains, i > 0 ? Math.max(d, 0) : NaN, p, true);
    const al = p <= 0 ? NaN : smooth(s.losses, i > 0 ? Math.max(-d, 0) : NaN, p, true);
    this.lines[0][i] = Number.isNaN(ag) || Number.isNaN(al) ? NaN : al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al);
  }
}

type MacdState = { fast: Smoothing; slow: Smoothing; signal: Smoothing };

class MacdStream extends Stream<MacdState> {
  constructor(
    private fast: number,
    private slow: number,
    private signal: number,
  ) {
    super(3);
  }
  protected initial() {
    return { fast: smoothing(), slow: smoothing(), signal: smoothing() };
  }
  protected copy(s: MacdState) {
    return { fast: { ...s.fast }, slow: { ...s.slow }, signal: { ...s.signal } };
  }
  protected step(s: MacdState, bars: readonly Bar[], i: number): void {
    const c = bars[i].close;
    const f = this.fast <= 0 ? NaN : smooth(s.fast, c, this.fast, false);
    const sl = this.slow <= 0 ? NaN : smooth(s.slow, c, this.slow, false);
    const line = Number.isNaN(f) || Number.isNaN(sl) ? NaN : f - sl;
    const sig = this.signal <= 0 ? NaN : smooth(s.signal, line, this.signal, false);
    this.lines[0][i] = Number.isNaN(line) || Number.isNaN(sig) ? NaN : line - sig;
    this.lines[1][i] = line;
    this.lines[2][i] = sig;
  }
}

class AtrStream extends Stream<Smoothing> {
  constructor(private period: number) {
    super(1);
  }
  protected initial() {
    return smoothing();
  }
  protected copy(s: Smoothing) {
    return { ...s };
  }
  protected step(s: Smoothing, bars: readonly Bar[], i: number): void {
    const b = bars[i];
    const pc = i > 0 ? bars[i - 1].close : NaN;
    const tr = i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    this.lines[0][i] = this.period <= 0 ? NaN : smooth(s, tr, this.period, true);
  }
}

type VwapState = { day: string; pv: number; vol: number };

class VwapStream extends Stream<VwapState> {
  constructor() {
    super(1);
  }
  protected initial() {
    return { day: '', pv: 0, vol: 0 };
  }
  protected copy(s: VwapState) {
    return { ...s };
  }
  protected step(s: VwapState, bars: readonly Bar[], i: number): void {
    const b = bars[i];
    const d = exchangeDate(b.time);
    if (d !== s.day) {
      s.day = d;
      s.pv = 0;
      s.vol = 0;
    }
    const tp = (b.high + b.low + b.close) / 3;
    s.pv += tp * b.volume;
    s.vol += b.volume;
    this.lines[0][i] = s.vol > 0 ? s.pv / s.vol : tp;
  }
}

export function indicatorStream(spec: IndicatorSpec): IndicatorStream {
  switch (spec.type) {
    case 'sma':
      return new SmaStream(spec.period);
    case 'ema':
      return new EmaStream(spec.period);
    case 'bb':
      return new BollingerStream(spec.period, spec.mult);
    case 'rsi':
      return new RsiStream(spec.period);
    case 'macd':
      return new MacdStream(spec.fast, spec.slow, spec.signal);
    case 'atr':
      return new AtrStream(spec.period);
    case 'vwap':
      return new VwapStream();
  }
}
