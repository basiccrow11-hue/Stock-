import { describe, expect, it } from 'vitest';
import { BarAggregator, aggregateBars, mergeBars } from '../data/aggregate';
import { bar, et, randomBars } from './helpers';

describe('bar aggregation', () => {
  it('aggregates 1m into 5m candles aligned to 09:30', () => {
    const t = et('2025-01-15', '09:30');
    const bars = Array.from({ length: 10 }, (_, i) => bar(t + i * 60, 100 + i, 100.5 + i, 99.5 + i, 100.2 + i, 10));
    const five = aggregateBars(bars, '5m');
    expect(five).toHaveLength(2);
    expect(five[0]).toEqual({ time: t, open: 100, high: 104.5, low: 99.5, close: 104.2, volume: 50 });
    expect(five[1].time).toBe(t + 300);
  });

  it('a partial bucket produces a forming candle from revealed bars only', () => {
    const t = et('2025-01-15', '09:30');
    const bars = Array.from({ length: 7 }, (_, i) => bar(t + i * 60, 100, 101 + i, 99, 100, 1));
    const five = aggregateBars(bars, '5m');
    expect(five[1]).toEqual({ time: t + 300, open: 100, high: 107, low: 99, close: 100, volume: 2 });
  });

  it('daily candles use the regular session (pre-market excluded once the open prints)', () => {
    const d = '2025-01-15';
    const bars = [bar(et(d, '08:00'), 90, 200, 80, 95), bar(et(d, '09:30'), 100, 101, 99, 100.5), bar(et(d, '15:59'), 100.5, 102, 100, 101), bar(et(d, '17:00'), 101, 150, 50, 101)];
    const daily = aggregateBars(bars, '1D');
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({ open: 100, high: 102, low: 99, close: 101, time: et(d, '09:30') });
  });

  it('incremental aggregation equals batch aggregation for every timeframe', () => {
    const bars = randomBars(1500, 3, et('2025-01-15', '04:00'));
    for (const tf of ['5m', '15m', '30m', '1h', '4h', '1D'] as const) {
      const agg = new BarAggregator(tf);
      const inc: typeof bars = [];
      for (const b of bars) {
        const r = agg.push(b)!;
        if (r.isNew) inc.push(r.bar);
        else inc[inc.length - 1] = r.bar;
      }
      expect(inc).toEqual(aggregateBars(bars, tf));
    }
  });
});

describe('merging bars into a chart', () => {
  it('replaces the forming bar, appends later ones and skips older ones', () => {
    const t = et('2025-01-15', '09:30');
    const base = [bar(t, 100, 101, 99, 100, 1), bar(t + 60, 100, 100, 100, 100, 1)];
    const from = mergeBars(base, [bar(t, 1, 1, 1, 1, 1), bar(t + 60, 100, 102, 99, 101, 5), bar(t + 120, 101, 101, 101, 101, 1), bar(t + 180, 101, 103, 101, 102, 2)]);
    expect(from).toBe(1);
    expect(base.map((b) => b.time)).toEqual([t, t + 60, t + 120, t + 180]);
    expect(base[0].close).toBe(100);
    expect(base[1]).toEqual(bar(t + 60, 100, 102, 99, 101, 5));
    expect(mergeBars(base, [bar(t + 60, 1, 1, 1, 1, 1)])).toBe(-1);
    expect(mergeBars([], [bar(t, 1, 1, 1, 1, 1)])).toBe(0);
  });
});
