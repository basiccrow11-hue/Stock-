// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Bar } from '../../core/types';
import { exchangeDate, exchangeMinuteOfDay, exchangeTimeToUnix, regularCloseMinute } from '../../core/time';

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
    scrollToPosition(rightOffset: number) {
      this.rightOffset = rightOffset;
      this.fire();
    }
    options() {
      return { rightOffset: 8 };
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
    coordinateToLogical(x: number) {
      const r = this.getVisibleLogicalRange();
      return r ? r.from + (x * this.span) / this.width() : null;
    }
  }

  class Series {
    points: Point[] = [];
    /** The markers last set on it (lw.markers: those last set on any series). */
    markers: { time: number; text?: string }[] = [];
    removed = false;
    constructor(private chart: Chart) {}
    setData(d: Point[]) {
      if (this.chart.cross) this.chart.crosshairRedone++;
      this.points = d.slice();
      this.chart.dataChanged();
    }
    update(p: Point, historical = false) {
      // The library redoes a shown crosshair, with a hit test over every point, on each change.
      if (this.chart.cross) this.chart.crosshairRedone++;
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
    /** Where the crosshair is shown (none: hidden), and how often a series change made the library redo it. */
    cross: { time: number; price: number } | null = null;
    crosshairRedone = 0;
    /** The spot the library redoes a shown crosshair from: the last mouse move, or the candle setCrosshairPosition chose. */
    origin = { x: 0, y: 0 };
    /** The pane's canvas, which takes mouse moves as the library's does (ignored while a button is held). */
    canvas = document.createElement('canvas');
    pressed = false;
    constructor() {
      this.canvas.addEventListener('mousemove', (e) => {
        if (this.pressed) return;
        this.origin = { x: e.clientX, y: e.clientY };
        this.showCross({ clientX: e.clientX, clientY: e.clientY });
      });
    }
    /** Shows the crosshair at its origin and sends the crosshair event; `sourceEvent` when the user moved. */
    private showCross(sourceEvent?: { clientX: number; clientY: number }) {
      const k = Math.round(this.ts.coordinateToLogical(this.origin.x)!);
      const time = this.ts.points[k];
      this.cross = time === undefined ? null : { time, price: 100 };
      const param = { time, logical: k, point: { ...this.origin }, paneIndex: 0, ...(sourceEvent ? { sourceEvent } : {}) };
      for (const fn of this.crosshair) fn(param);
    }
    /** What the library does on a zoom or a data change while the crosshair is shown: redo it from its origin. */
    redo() {
      if (this.cross) this.showCross();
    }
    clearCrosshairPosition() {
      this.cross = null;
    }
    setCrosshairPosition(price: number, time: number) {
      this.cross = { time, price };
      this.origin = { x: this.ts.logicalToCoordinate(this.ts.points.indexOf(time))!, y: this.origin.y };
    }
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
    createChart: (el: HTMLElement) => {
      const c = lw.lenient(new lw.Chart());
      el.appendChild(c.canvas);
      lw.charts.push(c);
      return c;
    },
    createSeriesMarkers: (series: { markers: unknown }) => lw.lenient({ setMarkers: (m: { time: number }[]) => (series.markers = lw.markers = m) }),
    createTextWatermark: () => lw.lenient({}),
  };
});

/** Journal pictures drawn off screen: a real one needs a canvas, so a stand-in records the trades' symbols. */
const offscreen = vi.hoisted(() => ({ drawn: [] as string[] }));
vi.mock('./offscreenSnapshot', () => ({
  offscreenSnapshot: async (scene: { symbol: string }) => (offscreen.drawn.push(scene.symbol), 'data:image/jpeg;base64,BB=='),
}));

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

    // Scrolled back off the newest candle, well inside the window: the view stays on its candles, and
    // once it is more than 500 candles back the chart is left as it is (every new candle would cost
    // more than the last). A fill on a candle held back gets no marker yet.
    for (let i = 0; i < 30 && main.points.length < 3_000; i++) second();
    expect(main.points.length).toBeGreaterThanOrEqual(3_000);
    act(() => ts.setVisibleLogicalRange({ from: main.points.length - 400, to: main.points.length - 300 }));
    const atEdges = () => [main.points[Math.ceil(ts.getVisibleLogicalRange()!.from)].time, main.points[Math.floor(ts.getVisibleLogicalRange()!.to)].time];
    const edges = atEdges();
    const oldest = main.points[0].time;
    const sizes: number[] = [];
    for (let i = 0; i < 15; i++) {
      if (i === 5) expect(store.submitOrder({ symbol: 'AAPL', action: 'sell', type: 'market', quantity: 10 }).ok).toBe(true);
      second();
      sizes.push(main.points.length);
    }
    expect(main.points[0].time).toBe(oldest);
    expect(atEdges()).toEqual(edges);
    expect(new Set(sizes.slice(2)).size).toBe(1);
    // Every series holds the same candles, the oldest of them in order; far more have played since.
    let all = chartTimes();
    const start = all.indexOf(oldest);
    expect(main.points.map((p) => p.time)).toEqual(all.slice(start, start + main.points.length));
    for (const s of chart.series) expect(s.points.length).toBe(main.points.length);
    expect(all.length - start - main.points.length).toBeGreaterThan(2_000);
    await act(async () => {});
    const sold = store.useTrading.getState().fills.at(-1)!;
    expect(sold.side).toBe('sell');
    expect(lw.markers).toEqual([]);

    // Scrolled to within 500 candles of the newest it holds, the chart takes the rest once the view
    // rests with no button down on it, and the view stays on its candles.
    const held = main.points.length;
    act(() => ts.setVisibleLogicalRange({ from: held - 300, to: held - 200 }));
    const shownEdges = atEdges();
    act(() => void chart.canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(main.points.length).toBe(held);
    act(() => void window.dispatchEvent(new MouseEvent('pointerup')));
    await act(() => new Promise((r) => setTimeout(r, 300)));
    all = chartTimes();
    expect(main.points.map((p) => p.time)).toEqual(all.slice(start));
    for (const s of chart.series) expect(s.points.length).toBe(main.points.length);
    expect(atEdges()).toEqual(shownEdges);
    expect(lw.markers.map((m) => m.time)).toEqual([toChartTime(store.candleStarts('AAPL', '1m')(sold.time))]);

    // Still far back from the newest, play holds candles back again, and a button offers the way back.
    const newestButton = () => host.querySelector<HTMLButtonElement>('.chart-newest');
    const holds = (n: number) => {
      const sizes: number[] = [];
      for (let i = 0; i < n; i++) (second(), sizes.push(main.points.length));
      return new Set(sizes).size === 1 && chartTimes().length - start > main.points.length;
    };
    expect(holds(3)).toBe(true);
    expect(newestButton()).not.toBeNull();
    // Gone to the end of what the chart holds (as a double-click on the time axis does), the chart
    // moves on to the newest candle, and follows it.
    act(() => ts.setVisibleLogicalRange({ from: main.points.length + 7 - 100, to: main.points.length + 7 }));
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(main.points.map((p) => p.time)).toEqual(chartTimes().slice(start));
    expect({ span: ts.span, rightOffset: ts.rightOffset }).toEqual({ span: 100, rightOffset: 8 });
    expect(newestButton()).toBeNull();
    second();
    expect(main.points.at(-1)!.time).toBe(chartTimes().at(-1));
    // Far back again, the button scrolls to the newest candle, keeping the zoom.
    act(() => ts.setVisibleLogicalRange({ from: main.points.length - 1000, to: main.points.length - 900 }));
    expect(holds(3)).toBe(true);
    act(() => newestButton()!.click());
    all = chartTimes();
    expect(main.points.map((p) => p.time)).toEqual(all.slice(all.length - main.points.length));
    expect({ span: ts.span, rightOffset: ts.rightOffset }).toEqual({ span: 100, rightOffset: 8 });
    expect(newestButton()).toBeNull();

    // Back on the newest candle, zoomed out to 3,000 candles (past the oldest the chart holds, which
    // brings older ones on the next frame, here in the next second of play): play lets go of the older ones again but keeps every candle
    // on screen, and a margin before them.
    act(() => ts.setVisibleLogicalRange({ from: main.points.length + 7 - 3000, to: main.points.length + 7 }));
    second();
    expect(ts.getVisibleLogicalRange()!.from).toBeGreaterThanOrEqual(300);
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

describe('the chart during fast play with the pointer on it', () => {
  it('hides the crosshair while candles go over, puts it back under the pointer, and draws what a fresh chart draws', async () => {
    const store = await import('../state/tradingStore');
    const { useSettings, DEFAULT_INDICATORS } = await import('../state/settingsStore');
    const { ChartView, toChartTime } = await import('./ChartView');
    const { exchangeDate } = await import('../../core/time');
    // VWAP's line breaks between sessions, and MACD colours each histogram bar: both on.
    useSettings.getState().update({ learningMode: false, autoSnapshot: false, indicators: DEFAULT_INDICATORS.map((i) => (i.type === 'macd' ? { ...i, enabled: true } : i)) });
    const ok = await store.startReplay({
      providerId: 'demo',
      symbol: 'MSFT',
      date: '2025-01-06',
      endDate: '2025-01-17',
      startTime: '09:30',
      endTime: '16:00',
      startingBalance: 100_000,
      lookbackDays: 5,
      timeframe: '1m',
      speed: 23_400,
      blind: false,
    });
    expect(ok).toBe(true);
    const render = async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const r = createRoot(host);
      await act(async () => r.render(createElement(ChartView, { symbol: 'MSFT', timeframe: '1m' })));
      return { chart: lw.charts.at(-1)!, root: r, host };
    };
    const a = await render();
    const chart = a.chart;
    const main = chart.series[0];
    expect(chart.series.length).toBeGreaterThanOrEqual(8);
    const calls = { update: 0 };
    for (const s of chart.series) {
      const update = s.update.bind(s);
      Object.assign(s, { update: (...args: Parameters<typeof update>) => (calls.update++, update(...args)) });
    }
    // The pane's canvas is what lies under the pointer (jsdom lays nothing out: it sits at 0, 0).
    document.elementsFromPoint ??= () => [];
    vi.spyOn(document, 'elementsFromPoint').mockImplementation(() => lw.charts.map((c) => c.canvas));
    /** The pointer moves to x = 300 on the price pane, or leaves the chart; the library shows or hides the crosshair. */
    const pointer = (on: boolean) =>
      act(() => {
        if (on) chart.canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 100 }));
        else {
          chart.cross = null;
          chart.crosshair.forEach((fn) => fn({}));
        }
      });
    /** The candle under the pointer, and the legend's first row. */
    const underPointer = () => main.points[Math.round(chart.ts.coordinateToLogical(300)!)] as unknown as { time: number; open: number; close: number };
    const legend = () => a.host.querySelector('.chart-legend .legend-row')?.textContent ?? '';
    const { price: fmtPrice } = await import('../services/format');
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const second = () =>
      act(() => {
        clock += 1000;
        vi.advanceTimersByTime(50);
      });
    const count = () => store.getBaseBars('MSFT').length;

    // Pointer on the chart: a second of play brings a day of candles with the crosshair hidden, then
    // puts it back on the candle now under the pointer, which the legend shows.
    pointer(true);
    act(() => store.play());
    let n = count();
    second();
    expect(count() - n).toBeGreaterThan(300);
    expect(calls.update).toBeGreaterThan(300 * chart.series.length);
    expect(chart.crosshairRedone).toBe(0);
    const c = underPointer();
    expect(chart.cross).toEqual({ time: c.time, price: 100 });
    expect(legend()).toContain(`O ${fmtPrice(c.open)}`);
    expect(legend()).toContain(`C ${fmtPrice(c.close)}`);

    // Pointer off the chart: nothing to hide or put back.
    pointer(false);
    calls.update = 0;
    n = count();
    second();
    const added = count() - n;
    expect(added).toBeGreaterThan(100);
    expect(calls.update).toBeGreaterThanOrEqual(added * chart.series.length);
    expect(chart.cross).toBeNull();

    // Pointer on again, one candle at a time, into the next session (where VWAP's line breaks): still updates.
    act(() => store.pause());
    pointer(true);
    calls.update = 0;
    n = main.points.length;
    const day = () => exchangeDate(store.getBaseBars('MSFT').at(-1)!.time);
    const startDay = day();
    let steps = 0;
    while (day() === startDay && steps < 400) {
      act(() => store.stepForward());
      steps++;
    }
    for (let i = 0; i < 2; i++, steps++) act(() => store.stepForward());
    expect(day()).not.toBe(startDay);
    await vi.waitFor(() => expect(main.points.length).toBe(n + steps));
    expect(calls.update).toBeGreaterThanOrEqual(steps * chart.series.length);
    expect(chart.crosshairRedone).toBe(0);
    expect(chart.cross?.time).toBe(underPointer().time);

    // It was put back by a mouse move where the pointer rests, which the library takes as the user's own,
    // so the spot it redoes the crosshair from is the pointer, not a candle's centre: after a zoom (3x
    // out) the crosshair and the legend are still on the candle under the pointer.
    expect(chart.origin.x).toBe(300);
    const shown = chart.ts.getVisibleLogicalRange()!;
    act(() => chart.ts.setVisibleLogicalRange({ from: shown.to - 3 * (shown.to - shown.from), to: shown.to }));
    act(() => chart.redo());
    expect(chart.cross?.time).toBe(underPointer().time);
    expect(legend()).toContain(`O ${fmtPrice(underPointer().open)}`);
    expect(legend()).toContain(`C ${fmtPrice(underPointer().close)}`);
    act(() => chart.ts.setVisibleLogicalRange(shown));

    // With a mouse button held (a drag) the library ignores that move: the crosshair is set on the candle
    // under the pointer instead and the legend shows it. Past the newest candle it is hidden, and the
    // legend shows the newest.
    chart.pressed = true;
    n = main.points.length;
    act(() => store.stepForward());
    await vi.waitFor(() => expect(main.points.length).toBe(n + 1));
    expect(chart.cross?.time).toBe(underPointer().time);
    expect(legend()).toContain(`C ${fmtPrice(underPointer().close)}`);
    chart.pressed = false;
    act(() => chart.canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 950, clientY: 100 })));
    chart.pressed = true;
    act(() => store.stepForward());
    await vi.waitFor(() => expect(main.points.length).toBe(n + 2));
    const newest = main.points.at(-1) as unknown as { close: number };
    expect(chart.cross).toBeNull();
    expect(legend()).toContain(`C ${fmtPrice(newest.close)}`);
    chart.pressed = false;
    pointer(true);

    // Scrolled far back with the pointer resting on the chart, play leaves the chart as it is. Scrolled
    // to within 500 candles of the newest it holds, the chart takes the rest with the crosshair hidden,
    // then puts it back under the pointer; the button goes back to the newest candle.
    const back = main.points.length;
    act(() => chart.ts.setVisibleLogicalRange({ from: back - 700, to: back - 600 }));
    pointer(true);
    calls.update = 0;
    act(() => store.play());
    second();
    second();
    act(() => store.pause());
    expect(calls.update).toBe(0);
    expect(main.points.length).toBe(back);
    act(() => chart.ts.setVisibleLogicalRange({ from: back - 300, to: back - 200 }));
    pointer(true);
    expect(chart.cross).not.toBeNull();
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(main.points.length).toBeGreaterThan(back + 300);
    expect(chart.crosshairRedone).toBe(0);
    expect(chart.cross?.time).toBe(underPointer().time);
    act(() => a.host.querySelector<HTMLButtonElement>('.chart-newest')!.click());
    expect(main.points.at(-1)!.time).toBe(toChartTime(store.getBaseBars('MSFT').at(-1)!.time));
    expect(chart.ts.rightOffset).toBe(8);

    /** Every series holds what a chart drawn afresh holds, on the candles that one holds. */
    const matchesFresh = async () => {
      const b = await render();
      expect(b.chart.series.length).toBe(chart.series.length);
      chart.series.forEach((s, j) => {
        const fresh = b.chart.series[j].points;
        expect(fresh.length).toBe(2000);
        expect(s.points.slice(-fresh.length)).toEqual(fresh);
      });
      act(() => b.root.unmount());
    };
    await matchesFresh();
    // And after one more fast second with the pointer on it.
    act(() => store.play());
    second();
    act(() => store.pause());
    await matchesFresh();
    act(() => a.root.unmount());
  }, 60_000);
});

describe('fill markers and journal pictures', () => {
  /**
   * A replay of 1-minute bars on a chart of `timeframe`, with snapshots on, and the chart on screen; on a
   * symbol with no drawings, as jsdom never loads the image a picture draws them from. The demo's NVDA,
   * with extended hours, unless `data` names other bars.
   */
  async function begin(timeframe: '1m' | '5m' | '1h', data = { providerId: 'demo', symbol: 'NVDA', date: '2025-01-06', endDate: '2025-01-17' }) {
    const store = await import('../state/tradingStore');
    const { useSettings } = await import('../state/settingsStore');
    const { useJournal } = await import('../state/journalStore');
    const { ChartView, toChartTime } = await import('./ChartView');
    useSettings.getState().update({ learningMode: false, autoSnapshot: true });
    const { symbol } = data;
    const ok = await store.startReplay({
      ...data,
      startTime: '09:30',
      endTime: '16:00',
      startingBalance: 100_000,
      lookbackDays: 5,
      timeframe,
      speed: 1,
      blind: false,
    });
    expect(ok).toBe(true);
    const sessionId = store.useTrading.getState().session!.id;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r = createRoot(host);
    await act(async () => r.render(createElement(ChartView, { symbol, timeframe })));
    const chart = lw.charts.at(-1)!;
    // Laid out (jsdom lays nothing out), and the markers on the chart whenever a picture is taken of it.
    const el = host.querySelector<HTMLElement>('.chart-canvas')!;
    Object.defineProperties(el, { clientWidth: { value: 960 }, clientHeight: { value: 480 } });
    const shots: number[][] = [];
    Object.assign(chart, {
      takeScreenshot: () => {
        shots.push(chart.series[0].markers.map((m) => m.time));
        const canvas = document.createElement('canvas');
        canvas.toDataURL = () => 'data:image/jpeg;base64,AA==';
        return canvas;
      },
    });
    offscreen.drawn.length = 0;
    return {
      store,
      host,
      chart,
      shots,
      /** The chart time of the candle holding the newest fill, and that fill. */
      lastFill: () => {
        const f = store.useTrading.getState().fills.at(-1)!;
        return { fill: f, candle: toChartTime(store.candleStarts(symbol, timeframe)(f.time)) };
      },
      mine: () => useJournal.getState().entries.filter((e) => e.sessionId === sessionId),
      end: async () => {
        act(() => r.unmount());
        useSettings.getState().update({ autoSnapshot: false });
        await store.endSession();
      },
    };
  }

  /** Unix time of `hhmm` ET on `date`. */
  const et = (date: string, hhmm: string) => exchangeTimeToUnix(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
  /**
   * The times of the chart's fill markers (`fills`) or all its markers, each checked to be on a candle
   * the chart holds: lightweight-charts moves any other onto a neighbour.
   */
  const marked = (chart: (typeof lw.charts)[number], fills = false) => {
    const { points, markers } = chart.series[0];
    const candles = new Set(points.map((p) => p.time));
    for (const m of markers) expect(candles).toContain(m.time);
    return markers.filter((m) => !fills || /^(BUY|SELL) /.test(m.text ?? '')).map((m) => m.time);
  };

  it("marks a fill at a candle's end on the newest candle until the next one forms, and the exit is in the picture taken from the screen", async () => {
    const { store, chart, shots, lastFill, mine, end } = await begin('5m');
    const main = chart.series[0];
    // Three candles on, the clock is at the end of the newest candle: a market order fills at the start
    // of the next, which has no bars yet. Its marker is on the newest candle, the one it came after.
    for (let i = 0; i < 3; i++) act(() => store.stepCandle());
    act(() => void expect(store.submitOrder({ symbol: 'NVDA', action: 'buy', type: 'market', quantity: 100 }).ok).toBe(true));
    const buy = lastFill();
    expect(buy.fill.side).toBe('buy');
    expect(buy.candle).toBe(main.points.at(-1)!.time);
    expect(marked(chart)).toEqual([buy.candle]);

    // Once the next candle has formed, from bars at and after the fill's time, the marker is on it.
    // Closed at the next boundary, the trade's picture is the chart on screen, with its exit marker.
    for (let i = 0; i < 2; i++) act(() => store.stepCandle());
    act(() => void expect(store.closePosition('NVDA').ok).toBe(true));
    const sell = lastFill();
    expect(sell.fill.side).toBe('sell');
    expect(sell.candle).toBe(main.points.at(-1)!.time);
    expect(shots).toEqual([[buy.candle + 5 * 60, sell.candle]]);
    await vi.waitFor(() => expect(mine()).toHaveLength(1));
    expect(mine()[0].snapshotKey).toBeDefined();
    expect(mine()[0].snapshotOffscreen).toBeUndefined();
    expect(offscreen.drawn).toEqual([]);
    await end();
  });

  it('keeps a fill on the candle it came after when the next candle forms later or never: at the close, before a gap', async () => {
    const { csvProvider } = await import('../state/dataRegistry');
    const { toChartTime } = await import('./ChartView');
    const ct = (date: string, hhmm: string) => toChartTime(et(date, hhmm));
    // GAPPY trades in the regular session only, and not at all on January 6 from 14:30 to 15:34.
    const bars: Bar[] = [];
    for (const d of ['2025-01-02', '2025-01-03', '2025-01-06', '2025-01-07']) {
      for (let m = 9 * 60 + 30; m < 16 * 60; m++) {
        if (d === '2025-01-06' && m >= 14 * 60 + 30 && m < 15 * 60 + 35) continue;
        const p = 50 + Math.sin(m / 7);
        bars.push({ time: exchangeTimeToUnix(d, m), open: p, high: p + 0.05, low: p - 0.05, close: p + 0.01, volume: 10_000 });
      }
    }
    csvProvider.upsert({ symbol: 'GAPPY', name: 'GAPPY', baseTimeframe: '1m', bars, importedAt: 0, fileName: 'GAPPY.csv' });
    try {
      for (const [timeframe, beforeGap, atClose] of [
        ['5m', '14:25', '15:55'],
        ['1h', '13:30', '15:30'],
      ] as const) {
        const { store, chart, shots, mine, end } = await begin(timeframe, { providerId: 'csv', symbol: 'GAPPY', date: '2025-01-06', endDate: '2025-01-07' });
        const main = chart.series[0];
        const buy = () => act(() => void expect(store.submitOrder({ symbol: 'GAPPY', action: 'buy', type: 'market', quantity: 100 }).ok).toBe(true));
        // Bought at 14:30 as the gap begins: the candle from 14:30 never forms, so the marker stays on
        // the one before, also once the candles after the gap have formed.
        act(() => store.jumpTo(et('2025-01-06', '14:30')));
        buy();
        expect(store.useTrading.getState().fills.at(-1)!.time).toBe(et('2025-01-06', '14:30'));
        expect(marked(chart)).toEqual([ct('2025-01-06', beforeGap)]);
        act(() => store.jumpTo(et('2025-01-06', '15:40')));
        expect(main.points.at(-1)!.time).toBeGreaterThan(ct('2025-01-06', '15:00'));
        expect(marked(chart)).toEqual([ct('2025-01-06', beforeGap)]);
        // Sold at 16:00, after the day's last bar, and bought again: on the last candle, in the picture
        // taken from the screen too, and still there once the next morning's candles have formed.
        act(() => store.jumpTo(et('2025-01-06', '16:00')));
        act(() => void expect(store.closePosition('GAPPY').ok).toBe(true));
        buy();
        const expected = [ct('2025-01-06', beforeGap), ct('2025-01-06', atClose), ct('2025-01-06', atClose)];
        expect(marked(chart)).toEqual(expected);
        expect(shots).toEqual([expected.slice(0, 2)]);
        for (let i = 0; i < 3; i++) act(() => store.stepForward());
        expect(main.points.at(-1)!.time).toBe(ct('2025-01-07', '09:30'));
        expect(marked(chart)).toEqual(expected);
        await vi.waitFor(() => expect(mine()).toHaveLength(1));
        await end();
      }
    } finally {
      csvProvider.remove('GAPPY');
    }
  });

  it("keeps an after-hours fill at 20:00 on the day's last candle, before and after the next pre-market forms", async () => {
    const { toChartTime } = await import('./ChartView');
    const ct = (date: string, hhmm: string) => toChartTime(et(date, hhmm));
    for (const [timeframe, atEnd, nextOpen] of [
      ['5m', '19:55', '04:00'],
      ['1h', '19:30', '03:30'],
    ] as const) {
      const { store, chart, end } = await begin(timeframe);
      const main = chart.series[0];
      act(() => store.jumpTo(et('2025-01-06', '20:00')));
      const limitPrice = Math.round(store.lastPrice('NVDA')! * 101) / 100;
      act(() => void expect(store.submitOrder({ symbol: 'NVDA', action: 'buy', type: 'limit', limitPrice, quantity: 100, extendedHours: true }).ok).toBe(true));
      expect(store.useTrading.getState().fills.at(-1)!.time).toBe(et('2025-01-06', '20:00'));
      expect(marked(chart)).toEqual([ct('2025-01-06', atEnd)]);
      for (let i = 0; i < 3; i++) act(() => store.stepForward());
      expect(main.points.at(-1)!.time).toBe(ct('2025-01-07', nextOpen));
      expect(marked(chart)).toEqual([ct('2025-01-06', atEnd)]);
      await end();
    }
  });

  it("keeps a simulated-market fill at the close on the session's last candle, also once the next session has begun", async () => {
    const store = await import('../state/tradingStore');
    const { ChartView, toChartTime } = await import('./ChartView');
    expect(await store.startSim({ config: { seed: 5, eventFrequency: 3 }, startingBalance: 100_000, speed: 1 })).toBe(true);
    const symbol = store.useTrading.getState().activeSymbol;
    // Stepped a minute at a time to the close.
    const now = () => store.useTrading.getState().now;
    const atClose = () => exchangeMinuteOfDay(now()) === regularCloseMinute(exchangeDate(now()));
    for (let i = 0; i < 400 && !atClose(); i++) store.stepForward();
    expect(atClose()).toBe(true);
    const close = now();
    store.setTimeframe('5m');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r = createRoot(host);
    await act(async () => r.render(createElement(ChartView, { symbol, timeframe: '5m' })));
    const chart = lw.charts.at(-1)!;
    const main = chart.series[0];
    act(() => void expect(store.submitOrder({ symbol, action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true));
    expect(store.useTrading.getState().fills.at(-1)!.time).toBe(close);
    // Its headlines are marked too, each on a candle.
    expect(marked(chart).length).toBeGreaterThan(1);
    expect(marked(chart, true)).toEqual([toChartTime(close - 5 * 60)]);
    act(() => store.stepForward());
    expect(main.points.at(-1)!.time).toBe(toChartTime(exchangeTimeToUnix(exchangeDate(now()), 9 * 60 + 30)));
    expect(marked(chart, true)).toEqual([toChartTime(close - 5 * 60)]);
    act(() => r.unmount());
    store.setTimeframe('1m');
    await store.endSession();
  });

  it('draws the picture off screen when the chart on screen is scrolled back from the close', async () => {
    const { store, host, chart, shots, mine, end } = await begin('1m');
    const { toChartTime } = await import('./ChartView');
    const main = chart.series[0];
    const ts = chart.ts;
    /** Buys, runs `meanwhile`, then closes the position, and gives the trade's journal entry. */
    const trade = async (n: number, meanwhile: () => void) => {
      act(() => void expect(store.submitOrder({ symbol: 'NVDA', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true));
      act(() => store.stepForward());
      meanwhile();
      act(() => void expect(store.closePosition('NVDA').ok).toBe(true));
      await vi.waitFor(() => expect(mine()).toHaveLength(n));
      return [...mine()].sort((a, b) => b.exitTime - a.exitTime)[0];
    };

    // Scrolled back a little: the newest candle, where the trade closed, is off the right of the view.
    let n = main.points.length;
    const first = await trade(1, () => act(() => ts.setVisibleLogicalRange({ from: n - 160, to: n - 40 })));
    expect(first).toMatchObject({ snapshotOffscreen: true, snapshotKey: `snap:${first.id}` });
    // Scrolled back far, and a step that holds its candle back from the chart before the close.
    n = main.points.length;
    act(() => ts.setVisibleLogicalRange({ from: n - 800, to: n - 680 }));
    const second = await trade(2, () => act(() => store.stepForward()));
    expect(main.points.at(-1)!.time).toBeLessThan(toChartTime(store.getBaseBars('NVDA').at(-1)!.time));
    expect(second).toMatchObject({ snapshotOffscreen: true, snapshotKey: `snap:${second.id}` });
    // Dragged to the end of what the chart holds, the button still down: the candles held back, the
    // close's among them, are not handed over yet, though no newer candle is off the view.
    n = main.points.length;
    act(() => void chart.canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    act(() => ts.setVisibleLogicalRange({ from: n - 100, to: n + 20 }));
    const third = await trade(3, () => undefined);
    expect(main.points.length).toBe(n);
    expect(host.querySelector('.chart-newest')).toBeNull();
    expect(third).toMatchObject({ snapshotOffscreen: true, snapshotKey: `snap:${third.id}` });
    expect(shots).toEqual([]);
    expect(offscreen.drawn).toEqual(['NVDA', 'NVDA', 'NVDA']);

    // Let go, the chart takes the candles held back: on the newest candle, the screen is the picture again.
    act(() => void window.dispatchEvent(new MouseEvent('pointerup')));
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(main.points.at(-1)!.time).toBe(toChartTime(store.getBaseBars('NVDA').at(-1)!.time));
    const fourth = await trade(4, () => undefined);
    expect(shots).toHaveLength(1);
    expect(fourth.snapshotOffscreen).toBeUndefined();
    expect(offscreen.drawn).toHaveLength(3);
    await end();
  });
});

describe('the buttons in the chart corner', () => {
  it('keeps » in the corner and Delete to its left, so neither moves when the other comes or goes', async () => {
    const store = await import('../state/tradingStore');
    const { useSettings } = await import('../state/settingsStore');
    const { useDrawings } = await import('./drawings');
    const { ChartView } = await import('./ChartView');
    useSettings.getState().update({ learningMode: false, autoSnapshot: false });
    const ok = await store.startReplay({
      providerId: 'demo',
      symbol: 'TSLA',
      date: '2025-01-06',
      endDate: '2025-01-10',
      startTime: '09:30',
      endTime: '16:00',
      startingBalance: 100_000,
      lookbackDays: 2,
      timeframe: '1m',
      speed: 1,
      blind: false,
    });
    expect(ok).toBe(true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r = createRoot(host);
    await act(async () => r.render(createElement(ChartView, { symbol: 'TSLA', timeframe: '1m' })));
    const ts = lw.charts.at(-1)!.ts;
    /** The corner's buttons from left to right; one in brackets is not shown but keeps its place. */
    const corner = () => [...host.querySelectorAll('.chart-corner > *')].map((e) => (e.getAttribute('aria-hidden') === 'true' ? `(${e.textContent})` : e.textContent));
    const back = () => act(() => ts.setVisibleLogicalRange({ from: ts.points.length - 300, to: ts.points.length - 200 }));

    // Scrolled back, » is in the corner. Finishing a drawing selects it: Delete comes to the left of ».
    back();
    expect(corner()).toEqual(['»']);
    const bar = store.getBaseBars('TSLA').at(-250)!;
    act(() => useDrawings.getState().add({ id: 'h', type: 'hline', points: [{ time: bar.time, price: bar.close }], color: '#4f8cff' }));
    expect(useDrawings.getState().selectedId).toBe('h');
    expect(corner()).toEqual(['Delete', '»']);
    // Back on the newest candle, » goes but its place is kept: Delete stays where it was.
    act(() => host.querySelector<HTMLButtonElement>('.chart-newest')!.click());
    expect(corner()).toEqual(['Delete', '(»)']);
    back();
    expect(corner()).toEqual(['Delete', '»']);
    act(() => useDrawings.getState().select(null));
    expect(corner()).toEqual(['»']);
    act(() => r.unmount());
    await store.endSession();
  });
});
