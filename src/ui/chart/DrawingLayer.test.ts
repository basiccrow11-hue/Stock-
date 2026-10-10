import { describe, expect, it } from 'vitest';
import type { ChartGeometry } from './DrawingLayer';
import { hitTest, projector } from './DrawingLayer';
import type { Drawing } from './drawings';
import type { Bar } from '../../core/types';
import { exchangeDate, exchangeTimeToUnix } from '../../core/time';

const T0 = 1_736_947_800;
const candles = Array.from({ length: 10 }, (_, i) => ({ time: T0 + i * 300, open: 1, high: 1, low: 1, close: 1, volume: 0 }));

/** Behaves like lightweight-charts 5: bar 0 is centred at x=100, 10px apart, and a fractional index converts to 0. */
function geometry(): ChartGeometry {
  const timeScale = { logicalToCoordinate: (l: number) => (Number.isInteger(l) ? 100 + l * 10 : 0) };
  return {
    chart: { timeScale: () => timeScale } as never,
    series: { priceToCoordinate: (p: number) => 500 - p, coordinateToPrice: (y: number) => 500 - y } as never,
    candles: () => candles,
    timeframe: '5m',
    paneHeight: () => 400,
    paneWidth: () => 800,
    container: null as never,
  };
}

describe('drawing projector', () => {
  const proj = projector(geometry());

  it('places a time inside a candle between candle centres, not at the left edge', () => {
    // Drawn on 1m, shown on 5m: 2.5 minutes into the fourth candle.
    expect(proj.x(T0 + 3 * 300 + 150)).toBe(135);
    expect(proj.x(T0 + 3 * 300)).toBe(130);
    // Past the last candle, extrapolated by the timeframe.
    expect(proj.x(T0 + 9 * 300 + 450)).toBe(205);
    // Before the first candle.
    expect(proj.x(T0 - 600)).toBe(80);
  });

  it('snaps a pointer to the candle under it', () => {
    expect(proj.t(134)).toBe(T0 + 3 * 300);
    expect(proj.t(136)).toBe(T0 + 4 * 300);
    expect(proj.t(100)).toBe(T0);
  });

  it('moves a time by whole candles and keeps its place inside its candle', () => {
    expect(proj.shiftT(T0 + 3 * 300 + 150, 21)).toBe(T0 + 5 * 300 + 150);
    expect(proj.shiftT(T0 + 3 * 300 + 150, 4)).toBe(T0 + 3 * 300 + 150);
    expect(proj.shiftT(T0 + 3 * 300 + 150, -30)).toBe(T0 + 150);
  });

  it('stays on the same candles when the chart was handed only the newest ones', () => {
    // The chart holds the candles from the fifth on: its logical index 0 (x = 100) is candle 4.
    const windowed = projector({ ...geometry(), firstIndex: () => 4 });
    expect(windowed.x(T0 + 4 * 300)).toBe(100);
    expect(windowed.x(T0 + 3 * 300 + 150)).toBe(95);
    expect(windowed.t(110)).toBe(T0 + 5 * 300);
    expect(windowed.t(80)).toBe(T0 + 2 * 300);
  });
});

describe('drawing points past the last candle', () => {
  it('keep their slot as the replay reveals candles across a weekend', () => {
    const daily = (date: string) => ({ time: exchangeTimeToUnix(date, 9 * 60 + 30), open: 1, high: 1, low: 1, close: 1, volume: 0 });
    const shown = ['2024-03-11', '2024-03-12', '2024-03-13'].map(daily);
    const g: ChartGeometry = { ...geometry(), candles: () => shown, timeframe: '1D' };
    // Five slots right of Wednesday's candle: Thu, Fri, Mon, Tue, Wed.
    const t = projector(g).t(100 + 7 * 10)!;
    expect(exchangeDate(t)).toBe('2024-03-20');
    for (const date of ['2024-03-14', '2024-03-15', '2024-03-18']) {
      shown.push(daily(date));
      expect(projector(g).x(t)).toBe(170);
    }
  });

  it('skip the night on intraday timeframes', () => {
    const at = (date: string, min: number) => exchangeTimeToUnix(date, min);
    const shown: Bar[] = [];
    for (const date of ['2024-03-11', '2024-03-12']) for (let m = 4 * 60; m < 20 * 60; m += 5) if (date === '2024-03-11' || m <= 19 * 60 + 40) shown.push({ time: at(date, m), open: 1, high: 1, low: 1, close: 1, volume: 0 });
    const g: ChartGeometry = { ...geometry(), candles: () => shown };
    const last = shown.length - 1;
    // Seven slots right of 19:40: 19:45, 19:50, 19:55, then 04:00, 04:05, 04:10, 04:15 the next day.
    const t = projector(g).t(100 + (last + 7) * 10)!;
    expect(t).toBe(at('2024-03-13', 4 * 60 + 15));
    for (let m = 19 * 60 + 45; m < 20 * 60; m += 5) shown.push({ time: at('2024-03-12', m), open: 1, high: 1, low: 1, close: 1, volume: 0 });
    for (let m = 4 * 60; m <= 4 * 60 + 10; m += 5) shown.push({ time: at('2024-03-13', m), open: 1, high: 1, low: 1, close: 1, volume: 0 });
    expect(projector(g).x(t)).toBe(100 + (last + 7) * 10);
  });
});

describe('drawing hit test', () => {
  const proj = projector(geometry());
  const hline: Drawing = { id: 'h', type: 'hline', points: [{ time: T0, price: 100 }], color: '#fff' };
  const trend: Drawing = { id: 't', type: 'trend', points: [{ time: T0 + 300, price: 200 }, { time: T0 + 5 * 300, price: 240 }], color: '#fff' };
  const rect: Drawing = { id: 'r', type: 'rect', points: [{ time: T0, price: 300 }, { time: T0 + 6 * 300, price: 250 }], color: '#fff' };
  const all = [hline, trend, rect];

  it('picks the drawing whose line a tap lands near', () => {
    expect(hitTest(all, proj, 800, 400, 400, 410, 16)).toBe('h');
    expect(hitTest(all, proj, 800, 400, 400, 410, 6)).toBeNull();
    // Halfway along the trend line (x 110 -> 150, y 300 -> 260).
    expect(hitTest(all, proj, 800, 400, 130, 282, 6)).toBe('t');
  });

  it('picks a box by its outline only', () => {
    expect(hitTest(all, proj, 800, 400, 130, 202, 6)).toBe('r');
    expect(hitTest(all, proj, 800, 400, 130, 225, 6)).toBeNull();
  });

  it('never picks the part of a line outside the price pane', () => {
    // Price 95 sits at y 405, below the 400px pane: clipped away, so a tap just inside misses it.
    const low: Drawing = { id: 'low', type: 'hline', points: [{ time: T0, price: 95 }], color: '#fff' };
    expect(hitTest([low], proj, 800, 400, 300, 398, 16)).toBeNull();
    expect(hitTest([low], proj, 800, 400, 300, 410, 16)).toBeNull();
    // A trend line leaving the pane is still picked by its visible part.
    const steep: Drawing = { id: 's', type: 'trend', points: [{ time: T0, price: 150 }, { time: T0 + 300, price: 50 }], color: '#fff' };
    expect(hitTest([steep], proj, 800, 400, 104, 390, 6)).toBe('s');
  });

  it('prefers the drawing painted on top when two are equally close', () => {
    const again: Drawing = { ...hline, id: 'h2' };
    expect(hitTest([hline, again], proj, 800, 400, 300, 400, 6)).toBe('h2');
  });
});
