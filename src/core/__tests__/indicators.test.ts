import { describe, expect, it } from 'vitest';
import { atr, bollinger, ema, macd, rsi, sma, vwap } from '../indicators/indicators';
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
