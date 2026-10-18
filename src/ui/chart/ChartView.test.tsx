// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Bar, Timeframe } from '../../core/types';
import { exchangeDate, exchangeMinuteOfDay, exchangeTimeToUnix, regularCloseMinute } from '../../core/time';

/**
 * A stand-in for lightweight-charts (jsdom has no canvas). It keeps every series' points and models
 * the time scale the way the library does: the visible range is counted from the newest point (the
 * right offset) and so is kept when the data changes, except that while the newest point is off
 * screen, points added on the right leave the view on the candles it showed. A range or scroll
 * position the app sets is applied on the chart's next frame, as the library draws it, not at once;
 * the user's own drag or zoom (scrollTo) moves the view at once.
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
    /** What the app set since the last frame: a range replaces anything set before it, a scroll position goes after it. */
    private queued: ({ range: Range } | { offset: number })[] = [];
    private frameAsked = false;
    setVisibleLogicalRange(r: Range) {
      this.queued = [{ range: r }];
      this.askFrame();
    }
    scrollToPosition(rightOffset: number) {
      this.queued.push({ offset: rightOffset });
      this.askFrame();
    }
    private askFrame() {
      if (this.frameAsked) return;
      this.frameAsked = true;
      requestAnimationFrame(() => this.drawFrame());
    }
    /** The library's next frame: what was set is applied, on the points the chart holds by then. */
    drawFrame() {
      this.frameAsked = false;
      for (const q of this.queued.splice(0)) {
        if ('range' in q) this.scrollTo(q.range);
        else {
          this.rightOffset = q.offset;
          this.fire();
        }
      }
    }
    /** The user drags or zooms the view to `r`: it moves at once. */
    scrollTo(r: Range) {
      this.span = r.to - r.from;
      this.rightOffset = r.to - (this.points.length - 1);
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

/**
 * Lets the charts draw their next frame, where lightweight-charts applies a range or scroll position the
 * app set. (jsdom runs frames on setInterval, which the tests that play fake, so they are drawn here.)
 */
const nextFrame = () => act(() => lw.charts.forEach((c) => c.ts.drawFrame()));

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
    act(() => ts.scrollTo({ from: main.points.length - 400, to: main.points.length - 300 }));
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
    act(() => ts.scrollTo({ from: held - 300, to: held - 200 }));
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
    act(() => ts.scrollTo({ from: main.points.length + 7 - 100, to: main.points.length + 7 }));
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(main.points.map((p) => p.time)).toEqual(chartTimes().slice(start));
    expect({ span: ts.span, rightOffset: ts.rightOffset }).toEqual({ span: 100, rightOffset: 8 });
    expect(newestButton()).toBeNull();
    second();
    expect(main.points.at(-1)!.time).toBe(chartTimes().at(-1));
    // Far back again, the button scrolls to the newest candle, keeping the zoom.
    act(() => ts.scrollTo({ from: main.points.length - 1000, to: main.points.length - 900 }));
    expect(holds(3)).toBe(true);
    act(() => newestButton()!.click());
    nextFrame();
    all = chartTimes();
    expect(main.points.map((p) => p.time)).toEqual(all.slice(all.length - main.points.length));
    expect({ span: ts.span, rightOffset: ts.rightOffset }).toEqual({ span: 100, rightOffset: 8 });
    expect(newestButton()).toBeNull();

    // Back on the newest candle, zoomed out to 3,000 candles (past the oldest the chart holds, which
    // brings older ones on the next frame, here in the next second of play): play lets go of the older ones again but keeps every candle
    // on screen, and a margin before them.
    act(() => ts.scrollTo({ from: main.points.length + 7 - 3000, to: main.points.length + 7 }));
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
    act(() => ts.scrollTo({ from: main.points.length + 7 - 120, to: main.points.length + 7 }));
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
    act(() => chart.ts.scrollTo({ from: shown.to - 3 * (shown.to - shown.from), to: shown.to }));
    act(() => chart.redo());
    expect(chart.cross?.time).toBe(underPointer().time);
    expect(legend()).toContain(`O ${fmtPrice(underPointer().open)}`);
    expect(legend()).toContain(`C ${fmtPrice(underPointer().close)}`);
    act(() => chart.ts.scrollTo(shown));

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
    act(() => chart.ts.scrollTo({ from: back - 700, to: back - 600 }));
    pointer(true);
    calls.update = 0;
    act(() => store.play());
    second();
    second();
    act(() => store.pause());
    expect(calls.update).toBe(0);
    expect(main.points.length).toBe(back);
    act(() => chart.ts.scrollTo({ from: back - 300, to: back - 200 }));
    pointer(true);
    expect(chart.cross).not.toBeNull();
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(main.points.length).toBeGreaterThan(back + 300);
    expect(chart.crosshairRedone).toBe(0);
    expect(chart.cross?.time).toBe(underPointer().time);
    act(() => a.host.querySelector<HTMLButtonElement>('.chart-newest')!.click());
    nextFrame();
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
    const first = await trade(1, () => act(() => ts.scrollTo({ from: n - 160, to: n - 40 })));
    expect(first).toMatchObject({ snapshotOffscreen: true, snapshotKey: `snap:${first.id}` });
    // Scrolled back far, and a step that holds its candle back from the chart before the close.
    n = main.points.length;
    act(() => ts.scrollTo({ from: n - 800, to: n - 680 }));
    const second = await trade(2, () => act(() => store.stepForward()));
    expect(main.points.at(-1)!.time).toBeLessThan(toChartTime(store.getBaseBars('NVDA').at(-1)!.time));
    expect(second).toMatchObject({ snapshotOffscreen: true, snapshotKey: `snap:${second.id}` });
    // Dragged to the end of what the chart holds, the button still down: the candles held back, the
    // close's among them, are not handed over yet, though no newer candle is off the view.
    n = main.points.length;
    act(() => void chart.canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    act(() => ts.scrollTo({ from: n - 100, to: n + 20 }));
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
    const back = () => act(() => ts.scrollTo({ from: ts.points.length - 300, to: ts.points.length - 200 }));

    // Scrolled back, » is in the corner. Finishing a drawing selects it: Delete comes to the left of ».
    back();
    expect(corner()).toEqual(['»']);
    const bar = store.getBaseBars('TSLA').at(-250)!;
    act(() => useDrawings.getState().add({ id: 'h', type: 'hline', points: [{ time: bar.time, price: bar.close }], color: '#4f8cff' }));
    expect(useDrawings.getState().selectedId).toBe('h');
    expect(corner()).toEqual(['Delete', '»']);
    // Back on the newest candle, » goes but its place is kept: Delete stays where it was.
    act(() => host.querySelector<HTMLButtonElement>('.chart-newest')!.click());
    nextFrame();
    expect(corner()).toEqual(['Delete', '(»)']);
    back();
    expect(corner()).toEqual(['Delete', '»']);
    act(() => useDrawings.getState().select(null));
    expect(corner()).toEqual(['»']);
    act(() => r.unmount());
    await store.endSession();
  });
});

describe('the view when the chart is redrawn', () => {
  /** Makes the charts' frames come only when the test lets one go by; returns the way to let one go by. */
  function controlFrames() {
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (frames.set(++frameId, cb), frameId));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => void frames.delete(id));
    return () =>
      act(() => {
        const due = [...frames.values()];
        frames.clear();
        for (const cb of due) cb(0);
      });
  }
  afterEach(() => vi.unstubAllGlobals());

  async function mount(symbol: string) {
    const { ChartView } = await import('./ChartView');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(ChartView, { symbol, timeframe: '1m' })));
    return { root, chart: lw.charts.at(-1)!, host };
  }
  type Shown = Awaited<ReturnType<typeof mount>>;
  /** The times of the candles at the left and right edges of the view. */
  const edges = ({ chart }: Shown) => {
    const r = chart.ts.getVisibleLogicalRange()!;
    const points = chart.series[0].points;
    return [points[Math.ceil(r.from)]?.time, points[Math.floor(r.to)]?.time];
  };

  it('stays on its candles through a step back, a jump either way and a restart with candles held back, as on a chart holding none back', async () => {
    const store = await import('../state/tradingStore');
    const { useSettings } = await import('../state/settingsStore');
    const { toChartTime } = await import('./ChartView');
    useSettings.getState().update({ learningMode: false, autoSnapshot: false });
    const frame = controlFrames();
    const ok = await store.startReplay({
      providerId: 'demo',
      symbol: 'AMZN',
      date: '2025-02-03',
      endDate: '2025-02-14',
      startTime: '09:30',
      endTime: '16:00',
      startingBalance: 100_000,
      lookbackDays: 5,
      timeframe: '1m',
      speed: 1,
      blind: false,
    });
    expect(ok).toBe(true);
    /** Every candle's chart time, oldest first. */
    const times = () => store.getBaseBars('AMZN').map((b): number => toChartTime(b.time));
    const newest = () => store.getBaseBars('AMZN').at(-1)!.time;

    const a = await mount('AMZN');
    const n = a.chart.series[0].points.length;
    act(() => a.chart.ts.scrollTo({ from: n - 1100, to: n - 1000 }));
    const actions: [string, () => void][] = [
      ['step back', () => store.stepBack()],
      ['jump forward', () => store.jumpTo(newest() + 60 + 30 * 60)],
      ['jump back', () => store.jumpTo(newest() + 60 - 60 * 60)],
      ['restart', () => store.restart()],
    ];
    for (const [what, action] of actions) {
      // Play adds 150 candles while the view is far back: the chart holds them back.
      for (let i = 0; i < 150; i++) act(() => store.stepForward());
      await frame();
      expect(a.chart.series[0].points.at(-1)!.time, what).toBeLessThan(toChartTime(newest()));
      // A chart opened now holds them all; it is put on the same candles.
      const b = await mount('AMZN');
      const at = (t: number | undefined) => b.chart.series[0].points.findIndex((p) => p.time === t);
      const [from, to] = edges(a);
      act(() => b.chart.ts.scrollTo({ from: at(from), to: at(to) }));
      await frame();
      const before = edges(a);
      expect(edges(b), what).toEqual(before);
      // How far back from the newest candle the view's right edge is.
      const back = times().length - 1 - times().indexOf(before[1]!);

      await act(async () => action());
      const drawn = toChartTime(newest());
      await vi.waitFor(() => expect([a, b].map(({ chart }) => chart.series[0].points.at(-1)!.time)).toEqual([drawn, drawn]));
      const redrawn = [edges(a), edges(b)];
      await frame();
      await frame();
      // Nothing moves on the next frames, and both charts show the same candles: the same ones as before
      // a jump forward, else as far back from the newest candle as before.
      expect([edges(a), edges(b)], what).toEqual(redrawn);
      expect(edges(a), what).toEqual(edges(b));
      if (what === 'jump forward') expect(edges(a)).toEqual(before);
      else expect(edges(a)[1], what).toBe(times()[times().length - 1 - back]);
      act(() => b.root.unmount());
    }
    act(() => a.root.unmount());
    await store.endSession();
  }, 60_000);

  it('stays on its candles when a blind replay reaches its end and shows its real dates, with candles held back or not', async () => {
    const store = await import('../state/tradingStore');
    const { useSettings } = await import('../state/settingsStore');
    const { toChartTime, fromChartTime, blindChartShift } = await import('./ChartView');
    useSettings.getState().update({ learningMode: false, autoSnapshot: false });
    const frame = controlFrames();
    for (const back of [1000, 300]) {
      const ok = await store.startReplay({
        providerId: 'demo',
        symbol: 'AMZN',
        date: '2025-02-03',
        endDate: '2025-02-07',
        startTime: '09:30',
        endTime: '16:00',
        startingBalance: 100_000,
        lookbackDays: 5,
        timeframe: '1m',
        speed: 1,
        blind: true,
      });
      expect(ok).toBe(true);
      const shift = blindChartShift(store.useTrading.getState().session!.id);
      /** The real times of the candles at the view's edges. */
      const real = (a: Shown) => edges(a).map((t) => (t === undefined ? undefined : fromChartTime(t, store.useTrading.getState().session!.blind ? shift : 0)));
      act(() => store.jumpTo(exchangeTimeToUnix('2025-02-07', 15 * 60)));
      const a = await mount('AMZN');
      const n = a.chart.series[0].points.length;
      act(() => a.chart.ts.scrollTo({ from: n - back - 100, to: n - back }));
      await frame();
      const before = real(a);
      // The last hour plays: 1,000 candles back the chart holds its candles back, 300 back it takes them.
      for (let i = 0; i < 59; i++) act(() => store.stepForward());
      const held = a.chart.series[0].points.at(-1)!.time < toChartTime(store.getBaseBars('AMZN').at(-1)!.time, shift);
      expect(held, `${back} back`).toBe(back === 1000);
      act(() => store.stepForward());
      await vi.waitFor(() => expect(a.chart.series[0].points.at(-1)!.time).toBe(toChartTime(store.getBaseBars('AMZN').at(-1)!.time)));
      expect(store.useTrading.getState().session!.blind).toBe(false);
      await frame();
      await frame();
      expect(real(a), `${back} back`).toEqual(before);
      act(() => a.root.unmount());
      await store.endSession();
    }
  }, 60_000);

  it('keeps the moment at the right edge through a switch of timeframe or symbol, or the newest candle when that was on screen', async () => {
    const store = await import('../state/tradingStore');
    const { useSettings } = await import('../state/settingsStore');
    const { ChartView, fromChartTime, blindChartShift } = await import('./ChartView');
    useSettings.getState().update({ learningMode: false, autoSnapshot: false });
    const frame = controlFrames();
    for (const blind of [false, true]) {
      const ok = await store.startReplay({
        providerId: 'demo',
        symbol: 'AMZN',
        extraSymbols: ['MSFT'],
        date: '2025-02-03',
        endDate: '2025-02-14',
        startTime: '09:30',
        endTime: '16:00',
        startingBalance: 100_000,
        lookbackDays: 5,
        timeframe: '1m',
        speed: 1,
        blind,
      });
      expect(ok).toBe(true);
      act(() => store.jumpTo(exchangeTimeToUnix('2025-02-05', 11 * 60)));
      // A blind session's chart shows moved times: the moment kept is the real one.
      const shift = blind ? blindChartShift(store.useTrading.getState().session!.id) : 0;
      const a = await mount('AMZN');
      await frame();
      const main = () => a.chart.series[0];
      /** The chart of `symbol` on `timeframe`, as the chart panel shows it once the store has switched. */
      const show = async (symbol: string, timeframe: Timeframe) => {
        act(() => {
          store.setActiveSymbol(symbol);
          store.setTimeframe(timeframe);
          a.root.render(createElement(ChartView, { symbol, timeframe }));
        });
        await frame();
      };
      /** The real time of the candle at the view's right edge. */
      const right = () => fromChartTime(edges(a)[1]!, shift);
      /** The real time of the last bar of `symbol` in the 5-minute candle from `t`. */
      const lastBarIn5m = (symbol: string, t: number) => store.getBaseBars(symbol).filter((b) => b.time >= t && b.time < t + 300).at(-1)!.time;
      const newestButton = () => a.host.querySelector<HTMLButtonElement>('.chart-newest');
      const onNewest = () => {
        expect(a.chart.ts.rightOffset, `${blind}`).toBe(8);
        expect(newestButton(), `${blind}`).toBeNull();
      };

      // Scrolled back on the 1m chart: on 5m the right edge is the candle holding that minute, and back on
      // 1m the last minute of that candle. Nothing moves on the frames after.
      const n = main().points.length;
      act(() => a.chart.ts.scrollTo({ from: n - 400, to: n - 300 }));
      const t1 = right();
      await show('AMZN', '5m');
      const t5 = right();
      expect(t1 - t5, `${blind}`).toBeGreaterThanOrEqual(0);
      expect(t1 - t5, `${blind}`).toBeLessThan(300);
      await frame();
      expect(right()).toBe(t5);
      expect(newestButton()).not.toBeNull();
      await show('AMZN', '1m');
      expect(right(), `${blind}`).toBe(lastBarIn5m('AMZN', t5));
      // Another symbol of the session keeps the moment too.
      await show('MSFT', '1m');
      expect(right(), `${blind}`).toBe(lastBarIn5m('MSFT', t5));
      await frame();
      expect(right()).toBe(lastBarIn5m('MSFT', t5));
      // An hourly chart, months of history back: on 5m, which begins later, the view starts at its first candle.
      await show('AMZN', '1h');
      await vi.waitFor(() => expect(main().points.length).toBeGreaterThan(1000));
      act(() => a.chart.ts.scrollTo({ from: 200, to: 300 }));
      await show('AMZN', '5m');
      expect(edges(a), `${blind}`).toEqual([main().points[0].time, main().points[100].time]);
      expect(fromChartTime(main().points[0].time, shift)).toBe(store.candleStarts('AMZN', '5m')(store.getBaseBars('AMZN')[0].time));

      // On the newest candle, or within a candle of it, a switch stays on the newest.
      act(() => newestButton()!.click());
      await frame();
      onNewest();
      await show('MSFT', '15m');
      onNewest();
      expect(fromChartTime(main().points.at(-1)!.time, shift)).toBe(store.candleStarts('MSFT', '15m')(store.getBaseBars('MSFT').at(-1)!.time));
      // The newest minute, 11:00, begins a 5-minute candle; the view ends on the minute before it.
      await show('AMZN', '1m');
      act(() => store.stepForward());
      expect(store.getBaseBars('AMZN').at(-1)!.time).toBe(exchangeTimeToUnix('2025-02-05', 11 * 60));
      const m = main().points.length;
      act(() => a.chart.ts.scrollTo({ from: m - 102, to: m - 2 }));
      await show('AMZN', '5m');
      onNewest();
      store.setTimeframe('1m');
      act(() => a.root.unmount());
      await store.endSession();
    }
  }, 60_000);

  it('opens a new session on its newest candle however far back the last one was scrolled, and play moves it on', async () => {
    const store = await import('../state/tradingStore');
    const { useSettings } = await import('../state/settingsStore');
    const { ChartView, toChartTime, blindChartShift } = await import('./ChartView');
    useSettings.getState().update({ learningMode: false, autoSnapshot: false });
    const frame = controlFrames();
    const replay = (symbol: string, date: string, blind: boolean) =>
      store.startReplay({ providerId: 'demo', symbol, date, endDate: '2025-02-28', startTime: '09:30', endTime: '16:00', startingBalance: 100_000, lookbackDays: 5, timeframe: '1m', speed: 23_400, blind });
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    /** Each way to a new session, given the way to show the chart the store now has, as the chart panel does. */
    const variants: [string, boolean, (show: () => Promise<void>) => Promise<boolean>][] = [
      ['a replay of the same symbol', false, () => replay('AMZN', '2025-02-18', false)],
      ['a replay of another symbol', false, () => replay('MSFT', '2025-02-18', false)],
      ['a blind replay after a blind one', true, () => replay('AMZN', '2025-02-18', true)],
      ['the simulated market', false, () => store.startSim({ config: { seed: 5 }, startingBalance: 100_000, speed: 300 })],
      // An empty chart in between.
      ['a replay once the last session has ended', false, async (show) => (await store.endSession(), await show(), await frame(), replay('AMZN', '2025-02-18', false))],
    ];
    for (const [what, blind, start] of variants) {
      expect(await replay('AMZN', '2025-02-10', blind), what).toBe(true);
      const a = await mount('AMZN');
      await frame();
      const main = a.chart.series[0];
      const show = async () => {
        const { activeSymbol: symbol, timeframe } = store.useTrading.getState();
        await act(async () => a.root.render(createElement(ChartView, { symbol, timeframe })));
      };
      const n = main.points.length;
      act(() => a.chart.ts.scrollTo({ from: n - 1100, to: n - 1000 }));
      await frame();

      expect(await start(show), what).toBe(true);
      await show();
      await frame();
      const { activeSymbol: symbol, session } = store.useTrading.getState();
      const shift = session!.blind ? blindChartShift(session!.id) : 0;
      const newest = () => toChartTime(store.getBaseBars(symbol).at(-1)!.time, shift);
      expect(a.chart.ts.rightOffset, what).toBe(8);
      expect(main.points.at(-1)!.time, what).toBe(newest());
      expect(a.host.querySelector('.chart-newest'), what).toBeNull();
      // Play moves the chart on with the newest candle: none is held back.
      const before = main.points.at(-1)!.time;
      act(() => store.play());
      act(() => {
        clock += 1000;
        vi.advanceTimersByTime(50);
      });
      act(() => store.pause());
      await frame();
      expect(main.points.at(-1)!.time, what).toBeGreaterThan(before);
      expect(main.points.at(-1)!.time, what).toBe(newest());
      expect(a.chart.ts.rightOffset, what).toBe(8);
      act(() => a.root.unmount());
      await store.endSession();
    }
    vi.useRealTimers();
    now.mockRestore();
  }, 60_000);

  it('draws the picture of a trade off screen while the chart has a scroll position still to draw, and from the screen once it has', async () => {
    const store = await import('../state/tradingStore');
    const { useSettings } = await import('../state/settingsStore');
    const { useJournal } = await import('../state/journalStore');
    const { ChartView } = await import('./ChartView');
    useSettings.getState().update({ learningMode: false, autoSnapshot: false });
    const frame = controlFrames();
    const replay = (date: string) =>
      store.startReplay({ providerId: 'demo', symbol: 'AMZN', date, endDate: '2025-02-28', startTime: '09:30', endTime: '16:00', startingBalance: 100_000, lookbackDays: 5, timeframe: '1m', speed: 60, blind: false });
    expect(await replay('2025-02-10')).toBe(true);
    const a = await mount('AMZN');
    await frame();
    const el = a.host.querySelector<HTMLElement>('.chart-canvas')!;
    Object.defineProperties(el, { clientWidth: { value: 960 }, clientHeight: { value: 480 } });
    // lightweight-charts' takeScreenshot with a scroll position waiting for its frame, after new data,
    // never returns (scrollsWaiting): here it throws instead.
    const ts = a.chart.ts as unknown as { queued: unknown[] };
    let shots = 0;
    let hung = 0;
    Object.assign(a.chart, {
      takeScreenshot: () => {
        if (ts.queued.length) {
          hung++;
          throw new Error('takeScreenshot with a scroll position waiting would never return');
        }
        shots++;
        const canvas = document.createElement('canvas');
        canvas.toDataURL = () => 'data:image/jpeg;base64,AA==';
        return canvas;
      },
    });
    offscreen.drawn.length = 0;
    useSettings.getState().update({ autoSnapshot: true });
    /** A round trip closed now: its journal entry, once it is in. */
    const trade = async () => {
      act(() => void expect(store.submitOrder({ symbol: 'AMZN', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true));
      act(() => store.stepForward());
      act(() => void expect(store.closePosition('AMZN').ok).toBe(true));
      const id = store.useTrading.getState().session!.id;
      await vi.waitFor(() => expect(useJournal.getState().entries.filter((e) => e.sessionId === id).length).toBeGreaterThan(0));
      return useJournal.getState().entries.find((e) => e.sessionId === id)!;
    };

    // Another session is put on its newest candle by a scroll position, drawn on the next frame. A trade
    // closed before that frame gets its picture drawn off screen.
    expect(await replay('2025-02-18')).toBe(true);
    await act(async () => a.root.render(createElement(ChartView, { symbol: 'AMZN', timeframe: '1m' })));
    expect(ts.queued.length).toBeGreaterThan(0);
    act(() => store.stepForward());
    const before = await trade();
    expect(hung).toBe(0);
    expect(shots).toBe(0);
    expect(offscreen.drawn).toEqual(['AMZN']);
    expect(before).toMatchObject({ snapshotOffscreen: true });
    expect(before.snapshotMissing).toBeUndefined();

    // Once it has drawn, the picture is the chart on screen.
    await frame();
    await useJournal.getState().removeWhere(() => true);
    const after = await trade();
    expect(hung).toBe(0);
    expect(shots).toBe(1);
    expect(offscreen.drawn).toEqual(['AMZN']);
    expect(after.snapshotOffscreen).toBeUndefined();
    expect(after.snapshotKey).toBeDefined();
    useSettings.getState().update({ autoSnapshot: false });
    act(() => a.root.unmount());
    await store.endSession();
  }, 30_000);
});

describe('letting go of the chart', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('hands over the candles held back only once no finger or button is on the chart: not when one finger of a pinch lifts', async () => {
    const store = await import('../state/tradingStore');
    const { useSettings } = await import('../state/settingsStore');
    const { ChartView, toChartTime } = await import('./ChartView');
    useSettings.getState().update({ learningMode: false, autoSnapshot: false });
    // The chart's frames come only when one is let go by (none is needed here).
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const ok = await store.startReplay({
      providerId: 'demo',
      symbol: 'AMZN',
      date: '2025-02-03',
      endDate: '2025-02-14',
      startTime: '09:30',
      endTime: '16:00',
      startingBalance: 100_000,
      lookbackDays: 5,
      timeframe: '1m',
      speed: 1,
      blind: false,
    });
    expect(ok).toBe(true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const r = createRoot(host);
    await act(async () => r.render(createElement(ChartView, { symbol: 'AMZN', timeframe: '1m' })));
    const chart = lw.charts.at(-1)!;
    const main = chart.series[0];
    const newest = () => toChartTime(store.getBaseBars('AMZN').at(-1)!.time);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    /** The view rests for longer than the catch-up delay. */
    const rest = () => act(() => void vi.advanceTimersByTime(300));
    const pointer = (type: string, pointerId: number, buttons = 0, target: EventTarget = window) =>
      act(() => void target.dispatchEvent(new PointerEvent(type, { pointerId, buttons, bubbles: true })));
    /** Scrolled far back, play adds 150 candles: the chart holds them back. Then the user brings the view to within 500 candles of the newest it holds. */
    const holdThenComeBack = () => {
      const n = main.points.length;
      act(() => chart.ts.scrollTo({ from: n - 1100, to: n - 1000 }));
      for (let i = 0; i < 150; i++) act(() => store.stepForward());
      expect(main.points.length).toBe(n);
      return n;
    };
    const comeBack = (n: number) => act(() => chart.ts.scrollTo({ from: n - 400, to: n - 300 }));

    // Two fingers go down and pinch the view to within 500 candles of the newest the chart holds.
    let n = holdThenComeBack();
    pointer('pointerdown', 1, 1, chart.canvas);
    pointer('pointerdown', 2, 1, chart.canvas);
    comeBack(n);
    rest();
    expect(main.points.length).toBe(n);
    // The second finger lifts; the first pans on, then rests on the chart: nothing is handed over.
    pointer('pointerup', 2);
    pointer('pointermove', 1, 1, chart.canvas);
    act(() => chart.ts.scrollTo({ from: n - 390, to: n - 290 }));
    rest();
    expect(main.points.length).toBe(n);
    // The last finger lifts: the chart takes the candles once the view rests.
    pointer('pointerup', 1);
    rest();
    expect(main.points.length).toBe(n + 150);
    expect(main.points.at(-1)!.time).toBe(newest());

    // A finger the browser takes over (pointercancel) is off the chart; a button still down keeps the
    // candles back until a move over the chart shows it is not (it was let go outside the window).
    n = holdThenComeBack();
    pointer('pointerdown', 3, 1, chart.canvas);
    pointer('pointerdown', 4, 1, chart.canvas);
    comeBack(n);
    pointer('pointercancel', 4);
    rest();
    expect(main.points.length).toBe(n);
    pointer('pointermove', 3, 0, chart.canvas);
    rest();
    expect(main.points.length).toBe(n + 150);

    // The window losing focus lets go of every pointer.
    n = holdThenComeBack();
    pointer('pointerdown', 5, 1, chart.canvas);
    pointer('pointerdown', 6, 1, chart.canvas);
    comeBack(n);
    rest();
    expect(main.points.length).toBe(n);
    act(() => void window.dispatchEvent(new FocusEvent('blur')));
    rest();
    expect(main.points.length).toBe(n + 150);

    vi.useRealTimers();
    act(() => r.unmount());
    await store.endSession();
  }, 60_000);
});
