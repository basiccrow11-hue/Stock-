/**
 * TradingView-style chart built on lightweight-charts (Apache-2.0, by TradingView).
 *
 * Data comes only from getBaseBars() (revealed bars), getChartHistory() (history from before the
 * replay's loaded bars, all complete before its start) and incremental bus events, so the chart can
 * never show a candle that has not happened yet in the replay. Indicators are computed from those
 * candles with the causal streams in core/indicators, which only compute the candles that changed.
 *
 * A long session has hundreds of thousands of candles: the chart is handed the newest few thousand,
 * and older ones as the user scrolls back to them (the window). While play adds candles and the
 * newest are on screen, the oldest are let go again, so redraws and play stay quick.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  LineStyle,
  PriceScaleMode,
  createChart,
  createSeriesMarkers,
  createTextWatermark,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type ITextWatermarkPluginApi,
  type Logical,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Bar, Timeframe } from '../../core/types';
import { lastIndexAtOrBefore, roundToTick } from '../../core/util/math';
import { aggregateBars, candleFor, mergeBars, ownCandles } from '../../core/data/aggregate';
import { indicatorStream, type IndicatorStream } from '../../core/indicators/indicators';
import type { ChartHistory } from '../../core/replay/ReplaySession';
import { REGULAR_OPEN, exchangeDate, exchangeOffsetSeconds, exchangeTimeToUnix, withoutDates } from '../../core/time';
import { describe as describeOrder, isOpen } from '../../core/broker/SimBroker';
import { useSettings, type IndicatorConfig } from '../state/settingsStore';
import { candleStartFor, getBaseBars, getBaseTimeframe, getChartHistory, getSimEventsFor, onChartEvent, pickPrice, registerSnapshotProvider, useTrading, blindDayLabel } from '../state/tradingStore';
import { CHART_LOCALE, price as fmtPrice } from '../services/format';
import { DrawingLayer, type ChartGeometry } from './DrawingLayer';
import { ChartLegend, type LegendEntry, type LegendModel, type LegendSource } from './ChartLegend';
import { useDrawings } from './drawings';
import { OSCILLATORS, addIndicatorSeries, addVolumeSeries, chartMarkers, endsSession, indicatorColors, indicatorName, indicatorPoint as indicatorPointOf, indicatorSpec, timeLabels, toJpeg, volumePoint as volumePointOf, watermarkLines, withHistory } from './chartParts';
import { addMainSeries, chartOptions, lastPriceColor, lastVisibleIndex, mainPoint, mainPriceFormat, mainSeriesOptions, priceScaleMode, valueDecimals, valueFormat, type MainSeries } from './chartTheme';
import { useTheme } from '../theme/useTheme';
import { chartLabelFill, chartLabelText, readable } from '../theme/color';

/** lightweight-charts renders UTC; shift to exchange time so axes read in ET. `shift` moves a blind session's times (blindChartShift). */
export function toChartTime(t: number, shift = 0): UTCTimestamp {
  return (t + exchangeOffsetSeconds(t) + shift) as UTCTimestamp;
}

/** The real time of chart time `chart` given by toChartTime with the same `shift`. */
export function fromChartTime(chart: number, shift = 0): number {
  const t = chart - shift;
  return t - exchangeOffsetSeconds(t);
}

/**
 * How far a blind session's chart times are moved: whole weeks, between one and five years back,
 * depending on the session. lightweight-charts chooses and bolds axis labels by calendar boundaries
 * (year starts first, then month starts), so on real times the labels it picked would give the
 * date away even when they read "Day N". Moved, those boundaries fall on unrelated days. Every time
 * the chart shows is converted back first, so only the choice of labelled ticks changes.
 */
export function blindChartShift(sessionId: string): number {
  let h = 2166136261;
  for (let i = 0; i < sessionId.length; i++) h = Math.imul(h ^ sessionId.charCodeAt(i), 16777619);
  return -(53 + ((h >>> 0) % 209)) * 7 * 86_400;
}

/** What the legend reads from a crosshair move. */
type CrosshairParam = Pick<MouseEventParams<Time>, 'time' | 'logical' | 'point' | 'paneIndex'>;

/** The one-column, page-scrolling terminal layout; the same media query as in styles.css. */
const STACKED_LAYOUT = '(max-width: 820px), (max-width: 1180px) and (max-height: 640px), (max-height: 560px)';

/**
 * Candles handed to the chart at first; older ones follow as the user scrolls back to them. Play adds
 * up to as many again before the oldest are let go (slideWindow).
 */
const WINDOW = 2000;
/** Scrolling to within this many candles of the oldest one handed over brings older ones. */
const WINDOW_MARGIN = 300;
/** Height of a legend row in pixels: past LEGEND_SHARE of the price pane, the legend flows compactly. */
const LEGEND_ROW = 17;
const LEGEND_SHARE = 0.4;
/** Room left of the price axis for the names on indicator value labels ("BB upper"). */
const LABEL_TITLE_ROOM = 76;

interface IndicatorSeries {
  cfg: IndicatorConfig;
  series: ISeriesApi<'Line' | 'Histogram'>[];
  pane: number;
  /** RSI 70/30 guide lines. */
  bands: IPriceLine[];
  /** Label precision of an oscillator pane, from the largest value seen (see valueDecimals). */
  decimals: number;
  maxAbs: number;
  /** Its values on every candle, kept up to date at the newest ones (null for volume). */
  stream: IndicatorStream | null;
}

export interface ChartViewProps {
  symbol: string;
  timeframe: Timeframe;
}

export function ChartView({ symbol, timeframe }: ChartViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<MainSeries | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const indicatorsRef = useRef<IndicatorSeries[]>([]);
  const baseRef = useRef<Bar[]>([]);
  const baseTfRef = useRef<Timeframe>('1m');
  /** Every candle the chart can show, oldest first: those built from the history, then from the revealed bars. */
  const candlesRef = useRef<Bar[]>([]);
  /** Index in candlesRef of the oldest candle handed to the chart: logical index 0 on its time scale. */
  const windowStartRef = useRef(0);
  /** The chart the window was sized on (symbol, timeframe, session): redrawing that chart keeps the size. */
  const windowKeyRef = useRef('');
  /** What the replay has from before its loaded bars, for the legend's note. */
  const historyRef = useRef<ChartHistory | null>(null);
  /** How many of candlesRef's candles, at its start, were built from that history. */
  const historyCountRef = useRef(0);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const watermarkRef = useRef<ITextWatermarkPluginApi<Time> | null>(null);
  const [geometryVersion, setGeometryVersion] = useState(0);
  /** Bumped when the main series is replaced (chart style change) so dependants re-attach. */
  const [seriesVersion, setSeriesVersion] = useState(0);
  /** Bumped when the oldest candle handed to the chart changes, so markers are re-sent for the candles it holds. */
  const [windowVersion, setWindowVersion] = useState(0);
  const windowOldestRef = useRef<number | null>(null);
  const theme = useTheme();
  const pal = theme.chart;
  const palRef = useRef(pal);
  palRef.current = pal;
  const styleRef = useRef(pal.style);
  /** Close of the first visible bar: the 0% line when the price scale shows percent. */
  const percentBaseRef = useRef<number | null>(null);
  /** Direction of the newest bar, for the hollow-candle last-price line. */
  const lastUpRef = useRef(true);
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;
  /** Index in candlesRef of the candle under the crosshair, or null: the legend then shows the newest. */
  const hoverRef = useRef<number | null>(null);
  /** Where the pointer is on the chart (in that pane's coordinates), or null when it is off it: see rebuildTail. */
  const pointerRef = useRef<{ x: number; y: number; pane: number } | null>(null);
  /** Shows the candle at a crosshair position in the legend (the newest when there is none). */
  const showHoverRef = useRef<(param: CrosshairParam) => void>(() => undefined);
  /** Each pane's top, in pixels from the chart's top (the lower panes' titles sit there), and the price pane's height. */
  const paneTopsRef = useRef<number[]>([]);
  const priceHeightRef = useRef(0);
  const paneObserverRef = useRef<ResizeObserver | null>(null);
  const legendState = useRef({ version: 0, listeners: new Set<() => void>() }).current;
  const readLegendRef = useRef<() => LegendModel | null>(() => null);
  const legendSource = useMemo<LegendSource>(
    () => ({
      subscribe: (onChange) => {
        legendState.listeners.add(onChange);
        return () => legendState.listeners.delete(onChange);
      },
      version: () => legendState.version,
      read: () => readLegendRef.current(),
    }),
    [legendState],
  );

  const indicators = useSettings((s) => s.indicators);
  const indicatorsNowRef = useRef(indicators);
  indicatorsNowRef.current = indicators;
  const session = useTrading((s) => s.session);
  const fills = useTrading((s) => s.fills);
  const orders = useTrading((s) => s.orders);
  const positions = useTrading((s) => s.positions);
  const simEventCount = useTrading((s) => s.simEvents.length);
  const pickTarget = useTrading((s) => s.pickTarget);
  const blind = session?.blind ?? false;
  const shift = blind && session ? blindChartShift(session.id) : 0;
  const shiftRef = useRef(shift);
  shiftRef.current = shift;
  /** Chart time of real time `t`. */
  const ct = (t: number) => toChartTime(t, shiftRef.current);

  // ---------------------------------------------------------------- create chart once
  useEffect(() => {
    const el = containerRef.current!;
    const base = chartOptions(palRef.current);
    const chart = createChart(el, {
      ...base,
      autoSize: true,
      layout: { ...base.layout, fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', panes: { ...base.layout?.panes, enableResize: true } },
      timeScale: { ...base.timeScale, timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 7 },
      // No global priceFormatter: it would override every pane, and the main pane may show percent.
      // Each series carries its own price format instead.
      localization: { locale: CHART_LOCALE },
    });
    chartRef.current = chart;
    // The price pane must survive a moment with no series (chart style swaps, indicator rebuilds):
    // lightweight-charts would otherwise delete it, move the price series into the next pane and
    // drop the data-source watermark attached to it.
    chart.panes()[0].setPreserveEmptyPane(true);

    // The legend follows the crosshair on its own: moving it never re-renders the chart.
    const showHover = (param: CrosshairParam) => {
      const candles = candlesRef.current;
      let i = -1;
      if (param.time !== undefined && param.logical !== undefined) {
        // Logical indexes count from the oldest candle handed to the chart; the time confirms it.
        i = windowStartRef.current + Math.round(param.logical);
        if (!candles[i] || ct(candles[i].time) !== param.time) i = lastIndexAtOrBefore(candles, param.time as number, (c) => ct(c.time));
        if (i >= 0 && ct(candles[i].time) !== param.time) i = -1;
      }
      const hover = i >= 0 ? i : null;
      if (hover === hoverRef.current) return;
      hoverRef.current = hover;
      emitLegend();
    };
    showHoverRef.current = showHover;
    chart.subscribeCrosshairMove((param) => {
      if (!param.point) pointerRef.current = null;
      else if (param.sourceEvent) pointerRef.current = { x: param.point.x, y: param.point.y, pane: param.paneIndex ?? 0 };
      else if (pointerRef.current) {
        // lightweight-charts redid the crosshair on its own (a zoom, a scroll, new data, a wider price
        // axis) from where it last put it. After restoreCrosshair that is a candle's centre, not the
        // pointer, so the crosshair would drift off the pointer: put it back under the pointer instead.
        restoreCrosshair(pointerRef.current);
        return;
      }
      showHover(param);
    });
    chart.subscribeClick((param) => {
      const series = candleRef.current;
      if (!param.point || !series || !useTrading.getState().pickTarget) return;
      // point.y is relative to the clicked pane; only the price pane maps to prices.
      if (param.paneIndex !== undefined && param.paneIndex !== 0) return;
      const p = series.coordinateToPrice(param.point.y);
      if (p !== null) pickPrice(roundToTick(p));
    });
    const bump = () => setGeometryVersion((v) => v + 1);
    // Dragging or double-clicking the price axis rescales prices without any chart event: follow
    // pointer drags on the chart (once per frame), and wheel and double-click, so drawings keep up.
    let frame = 0;
    const bumpSoon = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), bump()));
    };
    const onMove = (e: PointerEvent) => e.buttons !== 0 && bumpSoon();
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', bumpSoon);
    el.addEventListener('dblclick', bumpSoon);
    el.addEventListener('wheel', bumpSoon, { passive: true });
    let extendFrame = 0;
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      bump();
      syncPercentBase();
      syncLastDirection();
      // Scrolled back near the oldest candle handed over: hand over older ones. Not from inside this
      // callback, as setData moves the range again.
      if (range && range.from < WINDOW_MARGIN && windowStartRef.current > 0 && !extendFrame) {
        extendFrame = requestAnimationFrame(() => ((extendFrame = 0), extendWindow()));
      }
    });
    // The container, and the price pane itself: dragging a pane separator resizes the price pane
    // (and rescales its prices) without any other event, and drawings must follow.
    const ro = new ResizeObserver(bump);
    ro.observe(el);
    const pricePane = chart.panes()[0].getHTMLElement();
    if (pricePane) ro.observe(pricePane);
    // Every pane (see observePanes): resizing one moves the tops of those below it.
    const paneObserver = new ResizeObserver(measurePanes);
    paneObserverRef.current = paneObserver;
    paneObserver.observe(el);

    // In the one-column layout the page scrolls: a vertical swipe on the chart scrolls the page
    // instead of dragging the price scale (horizontal swipes still pan, pinch still zooms).
    const stacked = window.matchMedia(STACKED_LAYOUT);
    const syncTouch = () => chart.applyOptions({ handleScroll: { vertTouchDrag: !stacked.matches } });
    syncTouch();
    stacked.addEventListener('change', syncTouch);

    registerSnapshotProvider(async () => {
      // Fill markers and order lines follow the store in effects: apply them before the picture.
      flushSync(() => {});
      return snapshot(chart, el);
    });
    return () => {
      registerSnapshotProvider(null);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(extendFrame);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', bumpSoon);
      el.removeEventListener('dblclick', bumpSoon);
      el.removeEventListener('wheel', bumpSoon);
      stacked.removeEventListener('change', syncTouch);
      ro.disconnect();
      paneObserver.disconnect();
      paneObserverRef.current = null;
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      markersRef.current = null;
      priceLinesRef.current = [];
      indicatorsRef.current = [];
      volumeRef.current = null;
      watermarkRef.current = null;
    };
  }, []);

  // ---------------------------------------------------------------- main price series (chart style)
  // Declared before the data effects so the series exists when they first run. Changing the style
  // replaces the series; markers, price lines and drawings re-attach through seriesVersion.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const old = candleRef.current;
    if (old && styleRef.current === pal.style) return;
    // Add the replacement before removing the old series, so the price pane is never empty.
    const series = addMainSeries(chart, palRef.current, lastUp());
    if (old) {
      markersRef.current?.detach();
      chart.removeSeries(old);
      priceLinesRef.current = [];
    }
    // Keep the price series underneath indicator overlays, as when it was first created.
    series.setSeriesOrder(0);
    styleRef.current = pal.style;
    candleRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);
    series.setData(shownCandles().map(candlePoint) as never);
    setSeriesVersion((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pal.style]);

  // ---------------------------------------------------------------- colours, grid, crosshair, scale
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleRef.current;
    if (!chart || !series) return;
    chart.applyOptions(chartOptions(pal));
    lastUpRef.current = lastUp();
    series.applyOptions(mainSeriesOptions(pal, lastUpRef.current));
    applyPriceScale();
    // A Normal/Log switch moves every price on screen without a scroll or resize: redraw drawings now
    // and again once the chart has laid out the new scale.
    setGeometryVersion((v) => v + 1);
    const frame = requestAnimationFrame(() => setGeometryVersion((v) => v + 1));
    restyleIndicators();
    // Volume and MACD histogram colours are per point, so their data is re-sent.
    volumeRef.current?.setData(shownCandles().map(volumePoint));
    for (const ind of indicatorsRef.current) setIndicatorWindow(ind);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pal, seriesVersion]);

  // ---------------------------------------------------------------- axis + crosshair time labels
  // Chart times are ET shifted into UTC. In blind mode the calendar date must never appear: day
  // boundaries read "Day N" and the crosshair label omits the date.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const real = (shifted: number) => fromChartTime(shifted, shift);
    const { timeFormatter, tickMarkFormatter } = timeLabels(timeframe, blind ? (t) => blindDayLabel(real(t)) : null);
    chart.applyOptions({
      localization: { locale: CHART_LOCALE, timeFormatter },
      timeScale: {
        tickMarkFormatter,
        // Labels on calendar boundaries are bold; in blind mode no label stands out.
        allowBoldLabels: !blind,
      },
    });
  }, [blind, timeframe, shift]);

  // A blind session's times are moved on the chart (and back when it ends): every point is re-sent.
  const shownShift = useRef(shift);
  useEffect(() => {
    if (shownShift.current === shift) return;
    shownShift.current = shift;
    fullRedraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shift]);

  // ---------------------------------------------------------------- watermark (data integrity)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    watermarkRef.current?.detach();
    watermarkRef.current = createTextWatermark(chart.panes()[0], {
      horzAlign: 'center',
      vertAlign: 'center',
      lines: session ? watermarkLines(symbol, timeframe, session.source, pal) : [],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, symbol, timeframe, pal.watermark, pal.watermarkSub]);

  // ---------------------------------------------------------------- indicator series setup
  // Rebuilt only when the set of indicators or their parameters change. Colours are applied in place
  // (restyleIndicators), so dragging a colour picker never resets pane heights.
  const indicatorKey = useMemo(() => JSON.stringify(indicators.filter((i) => i.enabled).map(({ color: _color, ...rest }) => rest)), [indicators]);
  const indicatorColorKey = useMemo(() => indicators.map((i) => `${i.id}:${i.color}`).join(','), [indicators]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // Keep the heights the user dragged for panes that survive the rebuild.
    const heights = new Map<string, number>();
    for (const ind of indicatorsRef.current) {
      if (ind.pane > 0) heights.set(ind.cfg.id, chart.panes()[ind.pane]?.getStretchFactor() ?? 0.35);
    }
    const mainHeight = chart.panes()[0].getStretchFactor();
    for (const ind of indicatorsRef.current) for (const s of ind.series) chart.removeSeries(s);
    if (volumeRef.current) chart.removeSeries(volumeRef.current);
    volumeRef.current = null;
    indicatorsRef.current = [];
    // Remove empty panes beyond the main one.
    while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);

    const enabled = indicatorsNowRef.current.filter((i) => i.enabled);
    const overlayFormat = mainPriceFormat(palRef.current.priceScale, () => percentBaseRef.current);
    let nextPane = 1;
    for (const cfg of enabled) {
      if (cfg.type === 'volume') {
        volumeRef.current = addVolumeSeries(chart);
        continue;
      }
      const pane = OSCILLATORS.has(cfg.type) ? nextPane++ : 0;
      // Overlays share the price pane's labels (percent included); oscillators get their own precision.
      const priceFormat = pane === 0 ? overlayFormat : valueFormat(2);
      const { series, bands } = addIndicatorSeries(chart, cfg, pane, priceFormat, palRef.current);
      const spec = indicatorSpec(cfg);
      indicatorsRef.current.push({ cfg, series, pane, bands, decimals: 2, maxAbs: 0, stream: spec ? indicatorStream(spec) : null });
    }
    for (const ind of indicatorsRef.current) if (ind.pane > 0) chart.panes()[ind.pane]?.setStretchFactor(heights.get(ind.cfg.id) ?? 0.35);
    // The price pane's dragged height only means something next to the panes it was dragged
    // against. If none of them survived, new oscillator panes start from the default layout.
    const kept = indicatorsRef.current.some((ind) => ind.pane > 0 && heights.has(ind.cfg.id));
    chart.panes()[0].setStretchFactor(kept ? mainHeight : 1);
    applyPriceScale();
    // The candles are current (bus events keep them so): only the new series need their data.
    computeIndicators(0);
    volumeRef.current?.setData(shownCandles().map(volumePoint));
    for (const ind of indicatorsRef.current) setIndicatorWindow(ind);
    // The panes' elements may only be laid out on the chart's next frame.
    observePanes();
    const frame = requestAnimationFrame(observePanes);
    emitLegend();
    return () => cancelAnimationFrame(frame);
    // These helpers read refs only, so they are the same for the lifetime of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicatorKey]);

  useEffect(() => {
    restyleIndicators();
    emitLegend();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicatorColorKey]);

  /** Apply the current indicator colours and theme to the existing series. */
  function restyleIndicators(): void {
    const p = palRef.current;
    const now = new Map(indicatorsNowRef.current.map((i) => [i.id, i]));
    for (const ind of indicatorsRef.current) {
      ind.cfg = now.get(ind.cfg.id) ?? ind.cfg;
      indicatorColors(ind.cfg, p).forEach((color, k) => color && ind.series[k]?.applyOptions({ color, priceLineColor: chartLabelFill(color) }));
      ind.bands[0]?.applyOptions({ color: p.bandDown });
      ind.bands[1]?.applyOptions({ color: p.bandUp });
    }
  }

  // ---------------------------------------------------------------- legend
  function emitLegend(): void {
    legendState.version++;
    for (const onChange of legendState.listeners) onChange();
  }

  /** Watch every pane's size, after the panes have changed (see measurePanes). */
  function observePanes(): void {
    const chart = chartRef.current;
    const el = containerRef.current;
    const ro = paneObserverRef.current;
    if (!chart || !el || !ro) return;
    ro.disconnect();
    ro.observe(el);
    for (const pane of chart.panes()) {
      const pe = pane.getHTMLElement();
      if (pe) ro.observe(pe);
    }
  }

  /** Re-read the panes' tops; the lower panes' titles follow when one has moved. */
  function measurePanes(): void {
    const chart = chartRef.current;
    const el = containerRef.current;
    if (!chart || !el) return;
    const top = el.getBoundingClientRect().top;
    const tops = chart.panes().map((pane) => Math.round((pane.getHTMLElement()?.getBoundingClientRect().top ?? top) - top));
    const height = chart.panes()[0].getHeight();
    const old = paneTopsRef.current;
    if (height === priceHeightRef.current && tops.length === old.length && tops.every((t, i) => t === old[i])) return;
    paneTopsRef.current = tops;
    priceHeightRef.current = height;
    emitLegend();
  }

  /** What the legend shows: the candle under the crosshair (else the newest) and the indicators' values on it. */
  readLegendRef.current = (): LegendModel | null => {
    const candles = candlesRef.current;
    if (!candles.length) return null;
    const hover = hoverRef.current;
    const i = hover !== null && hover < candles.length ? hover : candles.length - 1;
    const bar = candles[i];
    const p = palRef.current;
    const overlays: LegendEntry[] = [];
    const panes: (LegendEntry & { top: number })[] = [];
    for (const ind of indicatorsRef.current) {
      if (!ind.stream) continue;
      const colors = indicatorColors(ind.cfg, p);
      const format = ind.pane === 0 ? fmtPrice : valueFormat(ind.decimals).formatter;
      const values = ind.stream.lines.map((line, k) => {
        const v = line[i];
        // The MACD histogram is coloured by its sign, like its bars.
        const color = colors[k] ? readable(colors[k], p.background) : v >= 0 ? 'var(--chart-pos)' : 'var(--chart-neg)';
        return { text: v === undefined || Number.isNaN(v) ? '—' : format(v), color };
      });
      const entry = { id: ind.cfg.id, name: indicatorName(ind.cfg), values };
      if (ind.pane === 0) overlays.push(entry);
      else if (paneTopsRef.current[ind.pane] !== undefined) panes.push({ ...entry, top: paneTopsRef.current[ind.pane] });
    }
    const note = historyNote(historyRef.current, candles[0]);
    const rows = 1 + overlays.length + (note ? 1 : 0);
    return {
      symbol,
      timeframe,
      bar,
      prevClose: i > 0 ? candles[i - 1].close : bar.open,
      dayLabel: blind && hover !== null ? blindDayLabel(bar.time) : null,
      overlays,
      panes,
      note,
      compact: priceHeightRef.current > 0 && rows * LEGEND_ROW > priceHeightRef.current * LEGEND_SHARE,
      right: (chartRef.current?.priceScale('right', 0).width() ?? 0) + (indicatorsRef.current.length ? LABEL_TITLE_ROOM : 0) + 8,
    };
  };

  /** The legend's note on the history: loading, failed, or the data has nothing earlier to show. */
  function historyNote(h: ChartHistory | null, first: Bar): string | null {
    if (!h) return null;
    if (h.status === 'loading') return 'Loading earlier history…';
    if (h.status === 'failed') return `Earlier history did not load: ${blind ? withoutDates(h.error ?? '') : h.error}`;
    if (!h.dataStart || exchangeDate(first.time) > h.dataStart) return null;
    const label = blind ? blindDayLabel(exchangeTimeToUnix(h.dataStart, REGULAR_OPEN)) : h.dataStart;
    return `No data before ${label}`;
  }

  // ---------------------------------------------------------------- price scale
  /**
   * Log or linear on the price pane. Oscillator panes always stay linear: applying a mode to pane 0
   * also changes the chart-wide default new panes copy, so the others are pinned explicitly.
   */
  function applyPriceScale(): void {
    const chart = chartRef.current;
    const series = candleRef.current;
    if (!chart || !series) return;
    const p = palRef.current;
    chart.priceScale('right', 0).applyOptions({ mode: priceScaleMode(p.priceScale) });
    for (let i = 1; i < chart.panes().length; i++) chart.priceScale('right', i).applyOptions({ mode: PriceScaleMode.Normal });
    syncPercentBase(true);
  }

  /** Keep the percent labels measured from the first visible bar, as in TradingView. */
  function syncPercentBase(force = false): void {
    const chart = chartRef.current;
    const series = candleRef.current;
    if (!chart || !series) return;
    const percent = palRef.current.priceScale === 'percent';
    const candles = candlesRef.current;
    const start = windowStartRef.current;
    let base: number | null = null;
    if (percent && candles.length > start) {
      const r = chart.timeScale().getVisibleLogicalRange();
      const i = r ? Math.min(candles.length - 1, start + Math.max(0, Math.ceil(r.from))) : start;
      base = candles[i].close;
    }
    if (!force && base === percentBaseRef.current) return;
    percentBaseRef.current = base;
    // Re-applying the format makes the scale re-render its labels with the new base. Overlays on the
    // price pane carry the same format, so their value labels read in percent too.
    const priceFormat = mainPriceFormat(palRef.current.priceScale, () => percentBaseRef.current);
    series.applyOptions({ priceFormat });
    for (const ind of indicatorsRef.current) if (ind.pane === 0) for (const s of ind.series) s.applyOptions({ priceFormat });
  }

  /**
   * Direction of the bar the price-axis label shows. lightweight-charts labels the last bar on
   * screen, not the newest one, so after scrolling back the label still matches the candle beside it.
   */
  function lastUp(): boolean {
    const c = candlesRef.current;
    const start = windowStartRef.current;
    const i = lastVisibleIndex(chartRef.current?.timeScale().getVisibleLogicalRange() ?? null, c.length - start);
    const b = i < 0 ? undefined : c[start + i];
    return !b || b.close >= b.open;
  }

  /** The last-price label (and line, which shares its colour) follows that bar's direction. */
  function syncLastDirection(): void {
    const series = candleRef.current;
    const up = lastUp();
    if (!series || up === lastUpRef.current) return;
    lastUpRef.current = up;
    series.applyOptions({ priceLineColor: lastPriceColor(palRef.current, up) });
  }

  // ---------------------------------------------------------------- data
  /** The candles handed to the chart: those from the window's start on. */
  function shownCandles(): Bar[] {
    return candlesRef.current.slice(windowStartRef.current);
  }

  /** Bring every indicator's values up to date after the candles from index `from` on changed. */
  function computeIndicators(from: number): void {
    const candles = candlesRef.current;
    for (const ind of indicatorsRef.current) {
      if (!ind.stream) continue;
      ind.stream.update(candles, from);
      if (ind.pane > 0) syncDecimals(ind, from);
    }
  }

  /** The point of an indicator's series `k` on candle `i`. */
  function indicatorPoint(ind: IndicatorSeries, k: number, i: number) {
    const candles = candlesRef.current;
    return indicatorPointOf(ind.cfg, k, ind.stream!.lines[k][i], ct(candles[i].time), candles, i, timeframeRef.current, palRef.current);
  }

  /** Hand an indicator's series their values on the window's candles. */
  function setIndicatorWindow(ind: IndicatorSeries): void {
    if (!ind.stream) return;
    const n = candlesRef.current.length;
    ind.series.forEach((s, k) => {
      const points = [];
      for (let i = windowStartRef.current; i < n; i++) points.push(indicatorPoint(ind, k, i));
      s.setData(points as never);
    });
  }

  /** Hand the chart the window's candles, volume and indicator values. */
  function setWindowData(): void {
    const series = candleRef.current;
    if (!series) return;
    const shown = shownCandles();
    series.setData(shown.map(candlePoint) as never);
    volumeRef.current?.setData(shown.map(volumePoint));
    for (const ind of indicatorsRef.current) setIndicatorWindow(ind);
  }

  /** Hands the chart older candles, as many again as it has, once the user scrolls near the oldest. */
  function extendWindow(): void {
    const start = windowStartRef.current;
    const range = chartRef.current?.timeScale().getVisibleLogicalRange();
    if (!range || start === 0 || range.from >= WINDOW_MARGIN) return;
    windowStartRef.current = Math.max(0, start - Math.max(WINDOW, candlesRef.current.length - start));
    // The chart keeps its place counted from the newest candle, so the view does not move.
    setWindowData();
    syncWindowVersion();
    setGeometryVersion((v) => v + 1);
  }

  /**
   * Lets go of the oldest candles handed to the chart while play adds new ones, so the series does not
   * grow without limit: once it holds WINDOW more than it needs (WINDOW, or from a margin before the
   * first candle on screen), which spreads the cost to once per WINDOW new candles. Only while the
   * newest candle is on screen: scrolled back, the window grows until the user comes back.
   */
  function slideWindow(): void {
    const candles = candlesRef.current;
    const held = candles.length - windowStartRef.current;
    if (held < 2 * WINDOW) return;
    const range = chartRef.current?.timeScale().getVisibleLogicalRange();
    if (!range || range.to < held - 1) return;
    const keep = Math.max(WINDOW, held - Math.max(0, Math.floor(range.from)) + WINDOW_MARGIN);
    if (held - keep < WINDOW) return;
    windowStartRef.current = candles.length - keep;
    // As in extendWindow, the chart keeps its place counted from the newest candle: the view does not move.
    setWindowData();
    syncWindowVersion();
    setGeometryVersion((v) => v + 1);
  }

  function syncWindowVersion(): void {
    const oldest = candlesRef.current[windowStartRef.current]?.time ?? null;
    if (oldest === windowOldestRef.current) return;
    windowOldestRef.current = oldest;
    setWindowVersion((v) => v + 1);
  }

  /** Oscillator label precision follows the size of its values (RSI and most MACDs: 2 decimals). */
  function syncDecimals(ind: IndicatorSeries, fromIndex: number): void {
    if (fromIndex <= 0) ind.maxAbs = 0;
    for (const vals of ind.stream?.lines ?? []) for (let i = Math.max(0, fromIndex); i < vals.length; i++) if (Number.isFinite(vals[i])) ind.maxAbs = Math.max(ind.maxAbs, Math.abs(vals[i]));
    const d = valueDecimals(ind.maxAbs);
    if (d === ind.decimals) return;
    ind.decimals = d;
    for (const s of ind.series) s.applyOptions({ priceFormat: valueFormat(d) });
  }

  function volumePoint(c: Bar) {
    return volumePointOf(c, ct(c.time), palRef.current);
  }

  function candlePoint(c: Bar) {
    return mainPoint(styleRef.current, ct(c.time), c);
  }

  /**
   * Rebuild every candle from the revealed bars and the history before them, and hand the chart the
   * newest. `retry` loads the history again if it failed before (a new look at this chart).
   */
  function fullRedraw(retry = false): void {
    if (!candleRef.current) return;
    baseRef.current = getBaseBars(symbol);
    baseTfRef.current = getBaseTimeframe(symbol);
    // At the data's own bar size each bar is a candle: getBaseBars already gave copies.
    const candles = ownCandles(timeframe, baseTfRef.current) ? baseRef.current.slice() : aggregateBars(baseRef.current, timeframe, baseTfRef.current);
    drawCandles(candles, getChartHistory(symbol, timeframe, retry));
  }

  /** The history arrived (or failed): only the candles before those of the revealed bars change. */
  function addHistory(): void {
    if (!candleRef.current) return;
    drawCandles(candlesRef.current.slice(historyCountRef.current), getChartHistory(symbol, timeframe));
  }

  /** Put the history's candles before `candles` (those of the revealed bars) and hand the chart the newest. */
  function drawCandles(candles: Bar[], history: ChartHistory | null): void {
    historyRef.current = history;
    const merged = withHistory(candles, history, timeframe);
    // Redrawing the same chart (new bars after a jump, history arriving) keeps the view where it is,
    // counted from the newest candle: the window keeps as many candles as reach back to the oldest on screen.
    const key = `${symbol}|${timeframe}|${useTrading.getState().session?.id ?? ''}`;
    const range = chartRef.current?.timeScale().getVisibleLogicalRange();
    const onScreen = range ? candlesRef.current.length - windowStartRef.current - Math.max(0, Math.floor(range.from)) + WINDOW_MARGIN : 0;
    const shown = key === windowKeyRef.current ? Math.max(WINDOW, onScreen) : WINDOW;
    windowKeyRef.current = key;
    candlesRef.current = merged.candles;
    historyCountRef.current = merged.fromHistory;
    windowStartRef.current = Math.max(0, candlesRef.current.length - shown);
    hoverRef.current = null;
    computeIndicators(0);
    setWindowData();
    syncLastDirection();
    syncPercentBase();
    setGeometryVersion((v) => v + 1);
    syncWindowVersion();
    emitLegend();
  }

  /**
   * Puts the crosshair back under the pointer after rebuildTail hid it or lightweight-charts redid it from
   * a stale spot, as lightweight-charts would have put it, and shows the candle under it in the legend
   * (setCrosshairPosition sends no crosshair event). Past the newest candle it is hidden until the
   * pointer moves, and the legend shows the newest.
   */
  function restoreCrosshair(p: { x: number; y: number; pane: number }): void {
    const chart = chartRef.current;
    const candles = candlesRef.current;
    const start = windowStartRef.current;
    const series = p.pane === 0 ? candleRef.current : indicatorsRef.current.find((ind) => ind.pane === p.pane)?.series[0];
    const logical = chart?.timeScale().coordinateToLogical(p.x) ?? null;
    const k = logical === null ? -1 : Math.max(0, Math.round(logical));
    const price = series?.coordinateToPrice(p.y) ?? null;
    const point = { x: p.x, y: p.y } as CrosshairParam['point'];
    if (!chart || !series || k < 0 || start + k >= candles.length || price === null) {
      chart?.clearCrosshairPosition();
      showHoverRef.current({ point, paneIndex: p.pane });
      return;
    }
    const time = ct(candles[start + k].time);
    chart.setCrosshairPosition(price, time, series as never);
    showHoverRef.current({ time, logical: k as Logical, point, paneIndex: p.pane });
  }

  /** Re-aggregate from the bucket containing base index `from` and push updates. */
  function rebuildTail(from: number): void {
    const base = baseRef.current;
    const series = candleRef.current;
    if (!series || !base.length) return;
    // While the pointer is on the chart, every change to a series makes lightweight-charts redo the
    // crosshair, with a hit test over every point of every series: at fast play, per candle and series,
    // that froze the page. The crosshair is hidden while the candles go over and put back once.
    const pointer = pointerRef.current;
    if (pointer) chartRef.current?.clearCrosshairPosition();
    const candleOf = (t: number) => candleFor(t, timeframe, baseTfRef.current);
    const key = candleOf(base[Math.min(from, base.length - 1)].time).key;
    let start = Math.min(from, base.length - 1);
    while (start > 0 && candleOf(base[start - 1].time).key === key) start--;
    const bucketStart = candleOf(base[start].time).start;
    const candles = candlesRef.current;
    const before = candles.length;
    // Only the forming (last) candle can change; drop it and rebuild from its first base bar.
    while (candles.length && candles[candles.length - 1].time >= bucketStart) candles.pop();
    const firstChanged = candles.length;
    for (const c of aggregateBars(base.slice(start), timeframe, baseTfRef.current)) candles.push(c);
    computeIndicators(firstChanged);
    const first = Math.max(firstChanged, windowStartRef.current);
    for (let i = first; i < candles.length; i++) {
      series.update(candlePoint(candles[i]) as never);
      volumeRef.current?.update(volumePoint(candles[i]));
    }
    for (const ind of indicatorsRef.current) {
      if (!ind.stream) continue;
      ind.series.forEach((s, k) => {
        // A candle starting a new session changes how the one before it is drawn: update that in place.
        if (first >= before && first > windowStartRef.current && endsSession(ind.cfg, candles, first - 1, timeframeRef.current)) s.update(indicatorPoint(ind, k, first - 1) as never, true);
        for (let i = first; i < candles.length; i++) s.update(indicatorPoint(ind, k, i) as never);
      });
    }
    slideWindow();
    syncLastDirection();
    syncPercentBase();
    if (pointer && pointerRef.current === pointer) restoreCrosshair(pointer);
    emitLegend();
  }

  useEffect(() => {
    fullRedraw(true);
    useDrawings.getState().setSymbol(symbol);
    return onChartEvent((e) => {
      // A symbol or timeframe switch also resets: the chart is about to show the new one (this effect
      // draws it), so the old one is not drawn again first.
      const now = useTrading.getState();
      const shown = now.activeSymbol === symbol && now.timeframe === timeframe;
      if (e.type === 'reset') {
        if (shown) fullRedraw();
        return;
      }
      if (e.symbol !== symbol) return;
      if (e.type === 'history') {
        if (shown) addHistory();
        return;
      }
      // Replay appends new bars; a sim tick re-sends the forming bar with cumulative values. Bars the
      // chart already holds are skipped: the series throws on them ("Cannot update oldest data").
      const from = mergeBars(baseRef.current, e.bars);
      if (from >= 0) rebuildTail(from);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe]);

  // ---------------------------------------------------------------- markers: fills + simulated news
  useEffect(() => {
    const m = markersRef.current;
    if (!m) return;
    // Those before the window are left out (see chartMarkers).
    const oldest = candlesRef.current[windowStartRef.current]?.time ?? Infinity;
    const own = fills.filter((f) => f.symbol === symbol);
    m.setMarkers(chartMarkers(own, getSimEventsFor(symbol), (t) => candleStartFor(symbol, t, timeframe), oldest, ct, pal));
  }, [fills, symbol, timeframe, simEventCount, seriesVersion, windowVersion, shift, pal.markerBuy, pal.markerSell, pal.markerUp, pal.markerDown]);

  // ---------------------------------------------------------------- price lines: position + orders
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    for (const pl of priceLinesRef.current) series.removePriceLine(pl);
    priceLinesRef.current = [];
    const pos = positions.find((p) => p.symbol === symbol);
    if (pos && pos.quantity !== 0) {
      priceLinesRef.current.push(
        series.createPriceLine({
          price: pos.avgPrice,
          color: pal.accent,
          ...axisLabel(pal.accent),
          lineStyle: LineStyle.Solid,
          lineWidth: 1,
          axisLabelVisible: true,
          title: `${pos.quantity > 0 ? 'LONG' : 'SHORT'} ${Math.abs(pos.quantity)}`,
        }),
      );
    }
    for (const o of orders) {
      if (o.symbol !== symbol || !isOpen(o)) continue;
      const px = o.type === 'limit' || (o.type === 'stop_limit' && o.triggered) ? o.limitPrice : o.stopPrice;
      if (px === undefined) continue;
      const isStopLoss = !!o.parentId && o.type === 'stop';
      const isTarget = !!o.parentId && o.type === 'limit';
      const color = isStopLoss ? pal.down : isTarget ? pal.up : pal.warn;
      const title = isStopLoss ? `SL ${o.quantity - o.filledQty}` : isTarget ? `TP ${o.quantity - o.filledQty}` : describeOrder(o).replace(` ${o.symbol}`, '');
      priceLinesRef.current.push(series.createPriceLine({ price: px, color, ...axisLabel(color), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title }));
    }
  }, [orders, positions, symbol, seriesVersion, pal.accent, pal.warn, pal.up, pal.down]);

  // ---------------------------------------------------------------- geometry for drawings
  const geometry: ChartGeometry | null = useMemo(() => {
    const chart = chartRef.current;
    const series = candleRef.current;
    const container = containerRef.current;
    if (!chart || !series || !container) return null;
    return {
      chart,
      series,
      candles: () => candlesRef.current,
      firstIndex: () => windowStartRef.current,
      // The candles' own size: at the data's bar size or finer, each bar of the data is a candle.
      timeframe: ownCandles(timeframe, baseTfRef.current) ? baseTfRef.current : timeframe,
      paneHeight: () => chart.panes()[0]?.getHeight() ?? 0,
      paneWidth: () => chart.timeScale().width(),
      container,
    };
    // geometryVersion forces consumers to re-render on scroll/zoom/resize/data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeframe, geometryVersion, seriesVersion]);

  return (
    <div className={`chart-wrap${pickTarget ? ' picking' : ''}`}>
      <div ref={containerRef} className="chart-canvas" />
      {geometry && <DrawingLayer geometry={geometry} version={geometryVersion} />}
      {geometry && <DeleteDrawingButton left={geometry.paneWidth() - 8} top={geometry.paneHeight() - 8} />}
      <ChartLegend source={legendSource} />
      {pickTarget && <div className="pick-hint">Click the chart to set the {pickTarget === 'stopLoss' ? 'stop loss' : pickTarget === 'takeProfit' ? 'take profit' : `${pickTarget} price`} · Esc to cancel</div>}
    </div>
  );
}

/** Axis-label colours for a price line: the line keeps its colour, the label is made readable. */
function axisLabel(color: string): { axisLabelColor: string; axisLabelTextColor: string } {
  const fill = chartLabelFill(color);
  return { axisLabelColor: fill, axisLabelTextColor: chartLabelText(fill) };
}

/** Chart + drawings as a JPEG data URL (for journal entries). */
/**
 * Deletes the selected drawing. It sits in the price pane's bottom corner (clear of the legend)
 * rather than in the toolbar, where it would re-wrap the toolbar and move the chart under the
 * pointer on every select. It appears the moment a drawing is finished or picked, so the click that
 * ends that same tap can land on it: only a press that starts on it, or the keyboard, deletes.
 */
function DeleteDrawingButton({ left, top }: { left: number; top: number }) {
  const selectedId = useDrawings((s) => s.selectedId);
  const remove = useDrawings((s) => s.remove);
  const pressed = useRef(false);
  useEffect(() => {
    pressed.current = false;
  }, [selectedId]);
  if (!selectedId) return null;
  const release = () => (pressed.current = false);
  return (
    <button
      className="btn sm danger drawing-delete"
      style={{ left, top }}
      onPointerDown={() => (pressed.current = true)}
      onPointerCancel={release}
      onClick={(e) => {
        const intended = pressed.current || e.detail === 0;
        release();
        if (intended) remove(selectedId);
      }}
      title="Delete selected drawing (Del)"
    >
      Delete
    </button>
  );
}

async function snapshot(chart: IChartApi, container: HTMLElement): Promise<string | null> {
  // A chart that is not laid out (e.g. a layout that removes it) collapses to a sliver: no picture
  // rather than a smear saved for good.
  if (container.clientWidth < 100 || container.clientHeight < 60) return null;
  const canvas = chart.takeScreenshot(true, false);
  const svg = container.parentElement?.querySelector('svg.drawing-layer') as SVGSVGElement | null;
  if (svg && svg.childElementCount > 0) {
    const ctx = canvas.getContext('2d');
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    // The image gets none of the page's CSS: leave out the selection handles and the invisible
    // grab targets (they would paint black), and carry the label font over.
    clone.querySelectorAll('.hit, .handle, .handle-hit').forEach((n) => n.remove());
    const font = svg.querySelector('text') ? getComputedStyle(svg.querySelector('text')!).fontFamily : '';
    if (font) clone.querySelectorAll('text').forEach((t) => t.setAttribute('font-family', font));
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('svg render failed'));
        img.src = url;
      });
      const scale = canvas.width / container.clientWidth;
      ctx?.drawImage(img, 0, 0, svg.clientWidth * scale, svg.clientHeight * scale);
    } catch {
      /* drawings are optional in the snapshot */
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return toJpeg(canvas);
}
