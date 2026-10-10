// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * A stand-in for lightweight-charts (jsdom has no canvas). It keeps every series' points and models
 * the time scale the way the library does: the visible range is counted from the newest point (the
 * right offset) and so is kept when the data changes, except that while the newest point is off
 * screen, points added on the right leave the view on the candles it showed.
 */
const lw = vi.hoisted(() => {
  type Point = { time: number };
  type Range = { from: number; to: number };
  /** Any other call: accepted and ignored. */
  const lenient = <T extends object>(o: T): T =>
    new Proxy(o, { get: (t, k) => (k in t ? t[k as keyof T] : k === 'then' ? undefined : () => undefined) });

  class TimeScale {
    points: number[] = [];
    /** Candles across the screen, and how far the right edge is past the newest. */
    span = 120;
    rightOffset = 8;
    private listeners = new Set<(r: Range | null) => void>();
    private shown: Range | null = null;
    getVisibleLogicalRange(): Range | null {
      if (!this.points.length) return null;
      const to = this.points.length - 1 + this.rightOffset;
      return { from: to - this.span, to };
    }
    setVisibleLogicalRange(r: Range) {
      this.span = r.to - r.from;
      this.rightOffset = r.to - (this.points.length - 1);
      this.fire();
    }
    /** The chart's points changed to `next`. */
    change(next: number[]) {
      const r = this.getVisibleLogicalRange();
      const oldBase = this.points.length - 1;
      const newBase = next.length - 1;
      if (r && next.length) {
        const newestShown = Math.floor(r.from) <= oldBase && oldBase <= Math.ceil(r.to);
        const addedRight = newBase > oldBase && !(this.points[0] > next[0]);
        if (addedRight && !newestShown) this.rightOffset -= newBase - oldBase;
      }
      this.points = next;
      this.fire();
    }
    private fire() {
      const r = this.getVisibleLogicalRange();
      if (r?.from === this.shown?.from && r?.to === this.shown?.to) return;
      this.shown = r;
      for (const l of this.listeners) l(r);
    }
    subscribeVisibleLogicalRangeChange(fn: (r: Range | null) => void) {
      this.listeners.add(fn);
    }
    width() {
      return 960;
    }
    logicalToCoordinate(i: number) {
      const r = this.getVisibleLogicalRange();
      return r ? ((i - r.from) * this.width()) / this.span : null;
    }
  }

  class Series {
    points: Point[] = [];
    removed = false;
    constructor(private chart: Chart) {}
    setData(d: Point[]) {
      this.points = d.slice();
      this.chart.dataChanged();
    }
    update(p: Point, historical = false) {
      const pts = this.points;
      const last = pts[pts.length - 1];
      if (last && p.time === last.time) pts[pts.length - 1] = p;
      else if (!last || p.time > last.time) {
        pts.push(p);
        this.chart.appended(p.time);
      } else if (historical) {
        const i = pts.findIndex((q) => q.time === p.time);
        if (i >= 0) pts[i] = p;
      } else throw new Error('Cannot update oldest data');
    }
    data() {
      return this.points;
    }
    priceToCoordinate() {
      return 100;
    }
    coordinateToPrice() {
      return 100;
    }
    createPriceLine() {
      return lenient({});
    }
  }

  class Chart {
    series: Series[] = [];
    ts = new TimeScale();
    panesList = [this.pane()];
    crosshair: ((p: unknown) => void)[] = [];
    pane() {
      return lenient({ getHeight: () => 400, getStretchFactor: () => 1, getHTMLElement: () => null });
    }
    addSeries(_type: unknown, _opts: unknown, pane = 0) {
      while (this.panesList.length <= pane) this.panesList.push(this.pane());
      const s = lenient(new Series(this));
      this.series.push(s);
      return s;
    }
    removeSeries(s: Series) {
      s.removed = true;
      this.series = this.series.filter((x) => x !== s);
      this.dataChanged();
    }
    panes() {
      return this.panesList;
    }
    removePane(i: number) {
      this.panesList.splice(i, 1);
    }
    timeScale() {
      return this.ts;
    }
    priceScale() {
      return lenient({ width: () => 60 });
    }
    subscribeCrosshairMove(fn: (p: unknown) => void) {
      this.crosshair.push(fn);
    }
    /** Every series' points together, as the time scale holds them. */
    dataChanged() {
      const times = new Set<number>();
      for (const s of this.series) for (const p of s.points) times.add(p.time);
      this.ts.change([...times].sort((a, b) => a - b));
    }
    appended(time: number) {
      const pts = this.ts.points;
      if (!pts.length || time > pts[pts.length - 1]) this.ts.change([...pts, time]);
    }
  }

  return { charts: [] as Chart[], markers: [] as { time: number; text?: string }[], Chart, lenient };
});

vi.mock('lightweight-charts', async (original) => {
  const actual = await original<typeof import('lightweight-charts')>();
  return {
    ...actual,
    createChart: () => {
      const c = lw.lenient(new lw.Chart());
      lw.charts.push(c);
      return c;
    },
    createSeriesMarkers: () => lw.lenient({ setMarkers: (m: { time: number }[]) => (lw.markers = m) }),
    createTextWatermark: () => lw.lenient({}),
  };
});

vi.mock('../services/idb', () => ({
  idb: {
    all: async () => [],
    set: async () => undefined,
    delete: async () => undefined,
    get: async () => undefined,
    modify: async (_s: string, _k: string, fn: (v: unknown) => unknown) => fn(undefined),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

let root: Root | null = null;
afterAll(() => {
  act(() => root?.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the chart during a long replay', () => {
  it('lets go of its oldest candles while play shows the newest, without moving the view', async () => {
    const store = await import('../state/tradingStore');
    const { useSettings } = await import('../state/settingsStore');
    const { useDrawings } = await import('./drawings');
    const { ChartView, toChartTime } = await import('./ChartView');
    const { price: fmtPrice } = await import('../services/format');
    useSettings.getState().update({ learningMode: false, autoSnapshot: false });
    const ok = await store.startReplay({
      providerId: 'demo',
      symbol: 'AAPL',
      date: '2025-01-06',
      endDate: '2025-03-28',
      startTime: '09:30',
      endTime: '16:00',
      startingBalance: 100_000,
      lookbackDays: 5,
      timeframe: '1m',
      speed: 23_400,
      blind: false,
    });
    expect(ok).toBe(true);
    // A fill on the first candle played, and a vertical line drawn at it.
    expect(store.submitOrder({ symbol: 'AAPL', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    store.stepForward();
    // The store is published at most every 90 ms.
    await vi.waitFor(() => expect(store.useTrading.getState().fills).toHaveLength(1));
    const fillCandle = store.getBaseBars('AAPL').at(-1)!.time;

    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(ChartView, { symbol: 'AAPL', timeframe: '1m' })));
    act(() => useDrawings.getState().add({ id: 'v', type: 'vline', points: [{ time: fillCandle, price: 0 }], color: '#4f8cff' }));

    const chart = lw.charts.at(-1)!;
    const main = chart.series[0];
    const ts = chart.ts;
    const chartTimes = (): number[] => store.getBaseBars('AAPL').map((b) => toChartTime(b.time));
    expect(main.points.length).toBe(2000);
    expect(lw.markers.map((m) => m.time)).toEqual([toChartTime(fillCandle)]);

    /** Index among all candles of the first one the chart holds. */
    const firstIndex = () => chartTimes().indexOf(main.points[0].time);
    /** The vertical line's x, and where the chart puts that candle. */
    const lineX = () => Number(host.querySelector('svg.drawing-layer line')!.getAttribute('x1'));
    const candleX = () => {
      const all = chartTimes();
      // Counted from the chart's first candle, which may now be after it.
      return ts.logicalToCoordinate(all.indexOf(toChartTime(fillCandle)) - (all.length - main.points.length));
    };

    // Play at the top speed: each loop below is a second of play.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    act(() => store.play());
    const second = () =>
      act(() => {
        clock += 1000;
        vi.advanceTimersByTime(50);
      });

    let most = 0;
    let slides = 0;
    while (store.getBaseBars('AAPL').length < 20_000) {
      const firstBefore = main.points[0].time;
      const indexBefore = firstIndex();
      const viewBefore = { span: ts.span, rightOffset: ts.rightOffset };
      second();
      most = Math.max(most, main.points.length);
      // The view keeps its size and stays on the newest candle.
      expect({ span: ts.span, rightOffset: ts.rightOffset }).toEqual(viewBefore);
      // The chart holds the newest candles, every one of them, in order.
      const all = chartTimes();
      expect(main.points.map((p) => p.time)).toEqual(all.slice(all.length - main.points.length));
      for (const s of chart.series) expect(s.points.length).toBe(main.points.length);
      if (main.points[0].time !== firstBefore) {
        slides++;
        // At most once per 2,000 new candles.
        expect(firstIndex() - indexBefore).toBeGreaterThanOrEqual(2_000);
        // Markers before the chart's first candle are left out; the line stays on its candle.
        expect(lw.markers.every((m) => m.time >= main.points[0].time)).toBe(true);
        expect(lineX()).toBeCloseTo(candleX()!, 6);
        // The legend shows the candle under the crosshair.
        const k = main.points.length - 50;
        act(() => chart.crosshair.forEach((fn) => fn({ time: main.points[k].time, logical: k, point: { x: 100, y: 100 } })));
        const bar = store.getBaseBars('AAPL').find((b) => toChartTime(b.time) === main.points[k].time)!;
        const row = [...host.querySelectorAll('.chart-legend .legend-row span')].map((e) => e.textContent);
        expect(row).toEqual(expect.arrayContaining([`O ${fmtPrice(bar.open)}`, `H ${fmtPrice(bar.high)}`, `L ${fmtPrice(bar.low)}`, `C ${fmtPrice(bar.close)}`]));
        act(() => chart.crosshair.forEach((fn) => fn({})));
      }
    }
    expect(slides).toBeGreaterThan(3);
    // At most a second of play past twice the window.
    expect(most).toBeLessThan(4_500);
    expect(lw.markers).toEqual([]);

    // Scrolled back off the newest candle, well inside the window: the window grows, and the view
    // stays on its candles.
    for (let i = 0; i < 30 && main.points.length < 3_000; i++) second();
    expect(main.points.length).toBeGreaterThanOrEqual(3_000);
    act(() => ts.setVisibleLogicalRange({ from: main.points.length - 400, to: main.points.length - 300 }));
    const atEdges = () => [main.points[Math.ceil(ts.getVisibleLogicalRange()!.from)].time, main.points[Math.floor(ts.getVisibleLogicalRange()!.to)].time];
    const edges = atEdges();
    const oldest = main.points[0].time;
    for (let i = 0; i < 15; i++) second();
    expect(main.points[0].time).toBe(oldest);
    expect(main.points.length).toBeGreaterThan(5_000);
    expect(atEdges()).toEqual(edges);

    // Back on the newest candle, zoomed out to 3,000 candles: play lets go of the older ones again but
    // keeps every candle on screen, and a margin before them.
    act(() => ts.setVisibleLogicalRange({ from: main.points.length + 7 - 3000, to: main.points.length + 7 }));
    for (let i = 0; i < 10; i++) {
      const indexBefore = firstIndex();
      second();
      if (firstIndex() !== indexBefore) expect(firstIndex() - indexBefore).toBeGreaterThanOrEqual(2_000);
      expect({ span: ts.span, rightOffset: ts.rightOffset }).toEqual({ span: 3000, rightOffset: 8 });
      expect(ts.getVisibleLogicalRange()!.from).toBeGreaterThanOrEqual(300);
    }
    expect(main.points[0].time).not.toBe(oldest);

    // Zoomed back in, the next slide leaves the newest 2,000.
    act(() => ts.setVisibleLogicalRange({ from: main.points.length + 7 - 120, to: main.points.length + 7 }));
    for (let i = 0; i < 10 && main.points.length !== 2_000; i++) second();
    expect(main.points.length).toBe(2_000);
    expect({ span: ts.span, rightOffset: ts.rightOffset }).toEqual({ span: 120, rightOffset: 8 });
    act(() => store.pause());
  }, 60_000);
});
