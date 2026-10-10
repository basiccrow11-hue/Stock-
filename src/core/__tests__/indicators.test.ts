import { describe, expect, it } from 'vitest';
import { atr, bollinger, ema, indicatorStream, macd, rsi, sma, vwap, type IndicatorSpec } from '../indicators/indicators';
import type { Bar } from '../types';
import { bar, et, randomBars } from './helpers';

describe('indicator values', () => {
  it('SMA', () => {
    expect(sma([1, 2, 3, 4, 5], 3).slice(2)).toEqual([2, 3, 4]);
    expect(Number.isNaN(sma([1, 2, 3], 3)[1])).toBe(true);
  });

  it('EMA is seeded with the SMA and then smooths with k = 2/(n+1)', () => {
    const e = ema([1, 2, 3, 4, 5, 6], 3);
    expect(e[2]).toBe(2);
    expect(e[3]).toBeCloseTo(3, 10); // 4*0.5 + 2*0.5
    expect(e[4]).toBeCloseTo(4, 10);
  });

  it('RSI matches the classic Wilder/StockCharts worked example', () => {
    // First value by hand: avg gain 3.34/14, avg loss 1.40/14 -> RSI 70.4641. StockCharts' table
    // shows 70.53 because it rounds the averages to 2 decimals; later values stay within 0.5.
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
    const r = rsi(closes, 14);
    expect(Number.isNaN(r[13])).toBe(true);
    expect(r[14]).toBeCloseTo(70.4641, 3);
    expect(Math.abs(r[15] - 66.32)).toBeLessThan(0.5);
    expect(Math.abs(r[19] - 57.97)).toBeLessThan(0.5);
  });

  it('RSI edge cases: only gains = 100, flat = 50', () => {
    expect(rsi([1, 2, 3, 4, 5, 6], 3)[5]).toBe(100);
    expect(rsi([5, 5, 5, 5, 5], 3)[4]).toBe(50);
  });

  it('MACD line = EMA12 - EMA26, histogram = line - signal', () => {
    const closes = randomBars(120).map((b) => b.close);
    const m = macd(closes);
    const e12 = ema(closes, 12);
    const e26 = ema(closes, 26);
    for (let i = 30; i < closes.length; i++) {
      expect(m.macd[i]).toBeCloseTo(e12[i] - e26[i], 10);
      if (!Number.isNaN(m.signal[i])) expect(m.histogram[i]).toBeCloseTo(m.macd[i] - m.signal[i], 10);
    }
    expect(Number.isNaN(m.signal[25 + 7])).toBe(true);
    expect(Number.isNaN(m.signal[25 + 8])).toBe(false);
  });

  it('Bollinger bands are symmetric around the SMA with population stdev', () => {
    const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
    expect(b.middle[7]).toBe(5);
    expect(b.upper[7]).toBe(9); // stdev 2
    expect(b.lower[7]).toBe(1);
  });

  it('ATR of constant-range bars equals the range', () => {
    const t = et('2025-01-15', '09:30');
    const bars = Array.from({ length: 30 }, (_, i) => bar(t + i * 60, 100, 101, 99, 100));
    expect(atr(bars, 14)[29]).toBeCloseTo(2, 10);
  });

  it('VWAP is the volume-weighted typical price and resets each day', () => {
    const d1 = et('2025-01-15', '09:30');
    const d2 = et('2025-01-16', '09:30');
    const bars = [bar(d1, 10, 10, 10, 10, 100), bar(d1 + 60, 20, 20, 20, 20, 300), bar(d2, 50, 50, 50, 50, 10)];
    const v = vwap(bars);
    expect(v[0]).toBe(10);
    expect(v[1]).toBe(17.5);
    expect(v[2]).toBe(50);
  });
});

describe('indicators are causal (no look-ahead)', () => {
  const bars = randomBars(400, 42);
  const closes = bars.map((b) => b.close);
  const cases: [string, (n: number) => number[][]][] = [
    ['sma', (n) => [sma(closes.slice(0, n), 20)]],
    ['ema', (n) => [ema(closes.slice(0, n), 20)]],
    ['rsi', (n) => [rsi(closes.slice(0, n), 14)]],
    ['macd', (n) => Object.values(macd(closes.slice(0, n)))],
    ['bollinger', (n) => Object.values(bollinger(closes.slice(0, n)))],
    ['atr', (n) => [atr(bars.slice(0, n))]],
    ['vwap', (n) => [vwap(bars.slice(0, n))]],
  ];
  for (const [name, fn] of cases) {
    it(`${name}: values on any prefix equal values on the full series`, () => {
      const full = fn(bars.length);
      for (const n of [1, 15, 27, 50, 199, 333, 399]) {
        const part = fn(n);
        part.forEach((series, k) => {
          for (let i = 0; i < n; i++) {
            const a = series[i];
            const b = full[k][i];
            if (Number.isNaN(a)) expect(Number.isNaN(b)).toBe(true);
            else expect(a).toBeCloseTo(b, 9);
          }
        });
      }
    });
  }
});

describe('indicator streams (charts) match the batch functions exactly', () => {
  /** The batch values a stream's lines must equal, in the stream's line order. */
  function batch(spec: IndicatorSpec, bars: Bar[]): number[][] {
    const closes = bars.map((b) => b.close);
    switch (spec.type) {
      case 'sma':
        return [sma(closes, spec.period)];
      case 'ema':
        return [ema(closes, spec.period)];
      case 'rsi':
        return [rsi(closes, spec.period)];
      case 'atr':
        return [atr(bars, spec.period)];
      case 'vwap':
        return [vwap(bars)];
      case 'bb': {
        const b = bollinger(closes, spec.period, spec.mult);
        return [b.upper, b.middle, b.lower];
      }
      case 'macd': {
        const m = macd(closes, spec.fast, spec.slow, spec.signal);
        return [m.histogram, m.macd, m.signal];
      }
    }
  }

  const specs: IndicatorSpec[] = [
    { type: 'sma', period: 20 },
    { type: 'sma', period: 1 },
    { type: 'ema', period: 9 },
    { type: 'ema', period: 21 },
    { type: 'ema', period: 0 },
    { type: 'bb', period: 20, mult: 2 },
    { type: 'bb', period: 5, mult: 1.5 },
    { type: 'rsi', period: 14 },
    { type: 'rsi', period: 2 },
    { type: 'macd', fast: 12, slow: 26, signal: 9 },
    { type: 'macd', fast: 3, slow: 7, signal: 4 },
    { type: 'atr', period: 14 },
    { type: 'vwap' },
  ];

  /** A random chart session: new candles, a forming candle that keeps changing, rewinds and resets. */
  function* session(seed: number): Generator<{ bars: Bar[]; from: number }> {
    // 1m bars over several days, so VWAP crosses sessions.
    const source = randomBars(1000, seed, et('2025-01-15', '09:30'));
    let s = seed;
    const rand = () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
    const bars: Bar[] = [];
    let next = 0;
    while (next < source.length) {
      const r = rand();
      if (r < 0.45) {
        // New candles: the forming one is final now, one to three more arrive.
        const from = bars.length;
        for (let k = 1 + Math.floor(rand() * 3); k > 0 && next < source.length; k--) bars.push({ ...source[next++] });
        yield { bars, from };
      } else if (r < 0.85 && bars.length) {
        // The forming candle changes (a new base bar inside it, or a simulated tick).
        const last = bars[bars.length - 1];
        const close = last.close + (rand() - 0.5);
        bars[bars.length - 1] = { ...last, close, high: Math.max(last.high, close), low: Math.min(last.low, close), volume: last.volume + Math.round(rand() * 500) };
        yield { bars, from: bars.length - 1 };
      } else if (r < 0.9) {
        yield { bars, from: bars.length };
      } else if (r < 0.95 && bars.length > 5) {
        // Step back: the newest candles go.
        bars.length -= 1 + Math.floor(rand() * 4);
        next = bars.length;
        yield { bars, from: bars.length };
      } else {
        // Anything else is redrawn from scratch.
        yield { bars, from: 0 };
      }
    }
  }

  for (const spec of specs) {
    it(`${JSON.stringify(spec)}: every update equals a full recomputation, bit for bit`, () => {
      for (const seed of [3, 17]) {
        const stream = indicatorStream(spec);
        let updates = 0;
        for (const { bars, from } of session(seed)) {
          stream.update(bars, from);
          updates++;
          const full = batch(spec, bars);
          expect(stream.lines.length).toBe(full.length);
          full.forEach((line, k) => {
            expect(stream.lines[k].length).toBe(bars.length);
            // Only the tail can have changed, but the whole line is compared every time.
            for (let i = 0; i < line.length; i++) if (!Object.is(stream.lines[k][i], line[i])) expect.fail(`line ${k} index ${i} after update ${updates}: ${stream.lines[k][i]} != ${line[i]}`);
          });
        }
        expect(updates).toBeGreaterThan(500);
      }
    });
  }
});
