import { describe, expect, it } from 'vitest';
import type { ChartGeometry } from './DrawingLayer';
import { hitTest, projector } from './DrawingLayer';
import type { Drawing } from './drawings';

const T0 = 1_736_947_800;
const candles = Array.from({ length: 10 }, (_, i) => ({ time: T0 + i * 300, open: 1, high: 1, low: 1, close: 1, volume: 0 }));

/** Behaves like lightweight-charts 5: bar 0 is centred at x=100, 10px apart, and a fractional index converts to 0. */
function geometry(): ChartGeometry {
  const timeScale = { logicalToCoordinate: (l: number) => (Number.isInteger(l) ? 100 + l * 10 : 0) };
  return {
    chart: { timeScale: () => timeScale } as never,
    series: { priceToCoordinate: (p: number) => 500 - p, coordinateToPrice: (y: number) => 500 - y } as never,
    candles: () => candles,
    tfSeconds: 300,
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

  it('prefers the drawing painted on top when two are equally close', () => {
    const again: Drawing = { ...hline, id: 'h2' };
    expect(hitTest([hline, again], proj, 800, 400, 300, 400, 6)).toBe('h2');
  });
});
