import { describe, expect, it } from 'vitest';
import { blindChartShift, fromChartTime, toChartTime } from './ChartView';
import { et } from '../../core/__tests__/helpers';

describe('chart time', () => {
  it('reads in exchange time and converts back, with or without a blind shift', () => {
    const t = et('2024-03-05', '10:15');
    const d = new Date(toChartTime(t) * 1000);
    expect([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()]).toEqual([2024, 3, 5, 10, 15]);
    const shift = blindChartShift('session-1');
    expect(fromChartTime(toChartTime(t))).toBe(t);
    expect(fromChartTime(toChartTime(t, shift), shift)).toBe(t);
    // The clock time stays; only the calendar moves.
    expect(new Date(toChartTime(t, shift) * 1000).getUTCHours()).toBe(10);
  });

  it('moves a blind session by whole weeks, one to five years, differently per session', () => {
    const shifts = ['a', 'b', 'c', 'session-1', 'session-2', 'r_8f2k'].map(blindChartShift);
    const week = 7 * 86_400;
    for (const s of shifts) {
      expect(Math.abs(s % week)).toBe(0);
      expect(-s / week).toBeGreaterThanOrEqual(53);
      expect(-s / week).toBeLessThanOrEqual(261);
    }
    expect(new Set(shifts).size).toBeGreaterThan(3);
    expect(blindChartShift('session-1')).toBe(blindChartShift('session-1'));
  });
});
