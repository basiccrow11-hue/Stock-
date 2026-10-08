import { describe, expect, it } from 'vitest';
import { mainPriceFormat, percentLabel, percentTickLabels, valueDecimals, valueFormat } from './chartTheme';
import { price } from '../services/format';

describe('percent price scale labels', () => {
  it('labels a price as change from the base', () => {
    expect(percentLabel(101.25, 100)).toBe('+1.25%');
    expect(percentLabel(98, 100)).toBe('-2.00%');
    expect(percentLabel(100.0001, 100)).toBe('0.00%');
    expect(percentLabel(99.9999, 100)).toBe('0.00%');
  });

  it('never gives two grid lines the same label, however close the ticks are', () => {
    const base = 387.52;
    for (const step of [5, 0.5, 0.05, 0.01]) {
      const ticks = Array.from({ length: 6 }, (_, i) => 387 + i * step);
      const labels = percentTickLabels(ticks, base);
      expect(new Set(labels).size, `step ${step}: ${labels.join(' ')}`).toBe(labels.length);
    }
    // Normal zoom keeps the usual two decimals.
    expect(percentTickLabels([380, 385, 390, 395], base)).toEqual(['-1.94%', '-0.65%', '+0.64%', '+1.93%']);
  });

  it('uses the tick formatter only in percent mode', () => {
    const pct = mainPriceFormat('percent', () => 100) as { tickmarksFormatter?: (p: number[]) => string[]; formatter: (p: number) => string };
    expect(pct.formatter(110)).toBe('+10.00%');
    expect(pct.tickmarksFormatter?.([99, 100, 101])).toEqual(['-1.00%', '0.00%', '+1.00%']);
    const plain = mainPriceFormat('normal', () => 100) as { tickmarksFormatter?: unknown; formatter: (p: number) => string };
    expect(plain.tickmarksFormatter).toBeUndefined();
    expect(plain.formatter(110)).toBe('110.00');
    // Without a base yet, percent mode shows prices rather than nonsense.
    expect((mainPriceFormat('percent', () => null) as { formatter: (p: number) => string }).formatter(110)).toBe('110.00');
  });
});

describe('indicator pane labels', () => {
  it('uses one precision for a whole pane, positive and negative alike', () => {
    const f = valueFormat(valueDecimals(4.2)).formatter;
    expect([4, 0, -4, -0.001].map(f)).toEqual(['4.00', '0.00', '-4.00', '0.00']);
  });

  it('adds decimals only for small values', () => {
    expect(valueDecimals(70)).toBe(2);
    expect(valueDecimals(1)).toBe(2);
    expect(valueDecimals(0)).toBe(2);
    expect(valueDecimals(0.5)).toBe(3);
    expect(valueDecimals(0.05)).toBe(4);
    expect(valueDecimals(0.0004)).toBe(6);
    expect(valueFormat(4).formatter(-0.01234)).toBe('-0.0123');
  });

  it('formats negative prices with the same rule as positive ones', () => {
    expect(price(-4)).toBe('-4.00');
    expect(price(-0.5)).toBe('-0.5000');
    expect(price(4)).toBe('4.00');
  });
});
