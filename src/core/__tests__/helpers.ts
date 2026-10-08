import type { Bar } from '../types';
import { exchangeTimeToUnix, parseHHMM } from '../time';

/** Unix time for an exchange-local date and HH:MM. */
export function et(date: string, hhmm: string): number {
  return exchangeTimeToUnix(date, parseHHMM(hhmm));
}

export function bar(time: number, open: number, high: number, low: number, close: number, volume = 1_000_000): Bar {
  return { time, open, high, low, close, volume };
}

/** Consecutive 1m bars starting at `date hhmm` from [o,h,l,c] tuples. */
export function minuteBars(date: string, hhmm: string, ohlc: [number, number, number, number][], volume = 1_000_000): Bar[] {
  const t0 = et(date, hhmm);
  return ohlc.map(([o, h, l, c], i) => bar(t0 + i * 60, o, h, l, c, volume));
}

/** Deterministic random-walk bars for property tests. */
export function randomBars(n: number, seed = 1, startTime = et('2025-01-15', '09:30'), start = 100): Bar[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const out: Bar[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = Math.max(1, o + (rand() - 0.5) * 2);
    const h = Math.max(o, c) + rand() * 0.5;
    const l = Math.min(o, c) - rand() * 0.5;
    out.push({ time: startTime + i * 60, open: o, high: h, low: l, close: c, volume: Math.round(1000 + rand() * 10000) });
    price = c;
  }
  return out;
}
