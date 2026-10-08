/**
 * TradingView-style chart built on lightweight-charts (Apache-2.0, by TradingView).
 *
 * Data comes only from getBaseBars() (revealed bars) and incremental bus events, so the chart can
 * never show a candle that has not happened yet in the replay. Indicators are recomputed from the
 * revealed candles with the causal functions in core/indicators.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  HistogramSeries,
  LineSeries,
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
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
  TickMarkType,
} from 'lightweight-charts';
import type { Bar, Timeframe } from '../../core/types';
import { aggregateBars, bucketFor, mergeBars } from '../../core/data/aggregate';
import { atr, bollinger, ema, macd, rsi, sma, vwap } from '../../core/indicators/indicators';
import { exchangeDate, exchangeOffsetSeconds } from '../../core/time';
import { describe as describeOrder, isOpen } from '../../core/broker/SimBroker';
import { useSettings, type IndicatorConfig } from '../state/settingsStore';
import { getBaseBars, getSimEventsFor, onChartEvent, pickPrice, registerSnapshotProvider, useTrading, blindDayLabel } from '../state/tradingStore';
import { CHART_LOCALE, compactVolume, price as fmtPrice } from '../services/format';
import { DrawingLayer, type ChartGeometry } from './DrawingLayer';
import { useDrawings } from './drawings';
import { addMainSeries, chartOptions, lastPriceColor, lastVisibleIndex, mainPoint, mainPriceFormat, mainSeriesOptions, priceScaleMode, valueDecimals, valueFormat, type MainSeries } from './chartTheme';
import { useTheme } from '../theme/useTheme';
import { onChart, type ChartPalette } from '../theme/themes';
import { chartLabelFill, chartLabelText } from '../theme/color';

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

/** The one-column, page-scrolling terminal layout; the same media query as in styles.css. */
const STACKED_LAYOUT = '(max-width: 820px), (max-width: 1180px) and (max-height: 640px), (max-height: 560px)';

interface IndicatorSeries {
  cfg: IndicatorConfig;
  series: ISeriesApi<'Line' | 'Histogram'>[];
  pane: number;
  /** RSI 70/30 guide lines. */
  bands: IPriceLine[];
  /** Label precision of an oscillator pane, from the largest value seen (see valueDecimals). */
  decimals: number;
  maxAbs: number;
}

/** Line colour per series of an indicator (null for the MACD histogram, coloured per bar). */
function indicatorColors(cfg: IndicatorConfig, p: ChartPalette): (string | null)[] {
  if (cfg.type === 'macd') return [null, p.accent, p.warn];
  const c = onChart(cfg.color, p.background);
  return cfg.type === 'bb' ? [c, c, c] : [c];
}

function computeIndicator(cfg: IndicatorConfig, candles: Bar[]): number[][] {
  const closes = candles.map((c) => c.close);
  switch (cfg.type) {
    case 'sma':
      return [sma(closes, cfg.period ?? 20)];
    case 'ema':
      return [ema(closes, cfg.period ?? 20)];
    case 'vwap':
      return [vwap(candles)];
    case 'bb': {
      const b = bollinger(closes, cfg.period ?? 20, cfg.mult ?? 2);
      return [b.upper, b.middle, b.lower];
    }
    case 'rsi':
      return [rsi(closes, cfg.period ?? 14)];
    case 'macd': {
      const m = macd(closes, cfg.fast ?? 12, cfg.slow ?? 26, cfg.signal ?? 9);
      return [m.histogram, m.macd, m.signal];
    }
    case 'atr':
      return [atr(candles, cfg.period ?? 14)];
    case 'volume':
      return [];
  }
}

const OSCILLATORS = new Set(['rsi', 'macd', 'atr']);

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
  const candlesRef = useRef<Bar[]>([]);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const watermarkRef = useRef<ITextWatermarkPluginApi<Time> | null>(null);
  const [geometryVersion, setGeometryVersion] = useState(0);
  /** Bumped when the main series is replaced (chart style change) so dependants re-attach. */
  const [seriesVersion, setSeriesVersion] = useState(0);
  const theme = useTheme();
  const pal = theme.chart;
  const palRef = useRef(pal);
  palRef.current = pal;
  const styleRef = useRef(pal.style);
  /** Close of the first visible bar: the 0% line when the price scale shows percent. */
  const percentBaseRef = useRef<number | null>(null);
  /** Direction of the newest bar, for the hollow-candle last-price line. */
  const lastUpRef = useRef(true);
  const [legend, setLegend] = useState<{ bar: Bar; change: number } | null>(null);

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

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData) {
        setLegend(null);
        return;
      }
      const idx = candlesRef.current.findIndex((c) => ct(c.time) === param.time);
      if (idx < 0) return;
      const bar = candlesRef.current[idx];
      const prev = idx > 0 ? candlesRef.current[idx - 1].close : bar.open;
      setLegend({ bar, change: ((bar.close - prev) / prev) * 100 });
    });
    chart.subscribeClick((param) => {
      const series = candleRef.current;
      if (!param.point || !series || !useTrading.getState().pickTarget) return;
      // point.y is relative to the clicked pane; only the price pane maps to prices.
      if (param.paneIndex !== undefined && param.paneIndex !== 0) return;
      const p = series.coordinateToPrice(param.point.y);
      if (p !== null) pickPrice(Math.round(p * 100) / 100);
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
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      bump();
      syncPercentBase();
      syncLastDirection();
    });
    // The container, and the price pane itself: dragging a pane separator resizes the price pane
    // (and rescales its prices) without any other event, and drawings must follow.
    const ro = new ResizeObserver(bump);
    ro.observe(el);
    const pricePane = chart.panes()[0].getHTMLElement();
    if (pricePane) ro.observe(pricePane);

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
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', bumpSoon);
      el.removeEventListener('dblclick', bumpSoon);
      el.removeEventListener('wheel', bumpSoon);
      stacked.removeEventListener('change', syncTouch);
      ro.disconnect();
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
    series.setData(candlesRef.current.map(candlePoint) as never);
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
    volumeRef.current?.setData(candlesRef.current.map(volumePoint));
    setIndicatorData(0);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pal, seriesVersion]);

  // ---------------------------------------------------------------- axis + crosshair time labels
  // Chart times are ET shifted into UTC. In blind mode the calendar date must never appear: day
  // boundaries read "Day N" and the crosshair label omits the date.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const pad = (n: number) => String(n).padStart(2, '0');
    const parts = (shifted: number) => {
      const d = new Date(shifted * 1000);
      return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, hm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
    };
    const real = (shifted: number) => fromChartTime(shifted, shift);
    chart.applyOptions({
      localization: {
        locale: CHART_LOCALE,
        timeFormatter: (t: Time) => {
          const p = parts(t as number);
          const label = blind ? blindDayLabel(real(t as number)) : p.date;
          return timeframe === '1D' ? label : `${label} ${p.hm}`;
        },
      },
      timeScale: {
        tickMarkFormatter: (t: Time, type: TickMarkType) => {
          const p = parts(t as number);
          if (type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds) return p.hm;
          if (blind) return blindDayLabel(real(t as number));
          if (type === TickMarkType.Year) return p.date.slice(0, 4);
          if (type === TickMarkType.Month) return p.date.slice(0, 7);
          return p.date.slice(5);
        },
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
    const label = !session ? '' : session.source === 'DEMO' ? 'DEMO DATA · SYNTHETIC' : session.source === 'SIMULATED' ? 'SIMULATED MARKET · FICTIONAL' : session.source === 'HISTORICAL' ? 'HISTORICAL DATA · REPLAY' : 'LIVE';
    watermarkRef.current = createTextWatermark(chart.panes()[0], {
      horzAlign: 'center',
      vertAlign: 'center',
      lines: session
        ? [
            { text: `${symbol} · ${timeframe}`, color: pal.watermark, fontSize: 42, fontStyle: 'bold' },
            { text: label, color: pal.watermarkSub, fontSize: 16 },
          ]
        : [],
    });
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
        const v = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
        chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
        volumeRef.current = v;
        continue;
      }
      const pane = OSCILLATORS.has(cfg.type) ? nextPane++ : 0;
      // Overlays share the price pane's labels (percent included); oscillators get their own precision.
      const priceFormat = pane === 0 ? overlayFormat : valueFormat(2);
      const p = palRef.current;
      const colors = indicatorColors(cfg, p);
      const line = (k: number, width: 1 | 2 = 1, style = LineStyle.Solid) =>
        chart.addSeries(
          LineSeries,
          {
            color: colors[k] ?? undefined,
            // Only the value label uses this colour (the line itself is hidden): adjusted for its text.
            priceLineColor: colors[k] ? chartLabelFill(colors[k]) : undefined,
            lineWidth: width,
            lineStyle: style,
            priceLineVisible: false,
            lastValueVisible: true,
            crosshairMarkerVisible: false,
            priceFormat,
          },
          pane,
        );
      let series: ISeriesApi<'Line' | 'Histogram'>[] = [];
      if (cfg.type === 'bb') series = [line(0, 1, LineStyle.Dashed), line(1, 1), line(2, 1, LineStyle.Dashed)];
      else if (cfg.type === 'macd') {
        series = [chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat }, pane), line(1, 2), line(2, 1)];
      } else series = [line(0, cfg.type === 'vwap' ? 2 : 1)];
      const bands: IPriceLine[] = [];
      if (cfg.type === 'rsi') {
        bands.push(series[0].createPriceLine({ price: 70, color: p.bandDown, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' }));
        bands.push(series[0].createPriceLine({ price: 30, color: p.bandUp, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' }));
      }
      indicatorsRef.current.push({ cfg, series, pane, bands, decimals: 2, maxAbs: 0 });
    }
    for (const ind of indicatorsRef.current) if (ind.pane > 0) chart.panes()[ind.pane]?.setStretchFactor(heights.get(ind.cfg.id) ?? 0.35);
    // The price pane's dragged height only means something next to the panes it was dragged
    // against. If none of them survived, new oscillator panes start from the default layout.
    const kept = indicatorsRef.current.some((ind) => ind.pane > 0 && heights.has(ind.cfg.id));
    chart.panes()[0].setStretchFactor(kept ? mainHeight : 1);
    applyPriceScale();
    fullRedraw();
    // fullRedraw and applyPriceScale are stable for the lifetime of the component (refs only).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicatorKey]);

  useEffect(() => {
    restyleIndicators();
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
    let base: number | null = null;
    if (percent && candles.length) {
      const r = chart.timeScale().getVisibleLogicalRange();
      const i = r ? Math.min(candles.length - 1, Math.max(0, Math.ceil(r.from))) : 0;
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
    const b = c[lastVisibleIndex(chartRef.current?.timeScale().getVisibleLogicalRange() ?? null, c.length)];
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
  function setIndicatorData(fromIndex: number): void {
    const candles = candlesRef.current;
    for (const ind of indicatorsRef.current) {
      const values = computeIndicator(ind.cfg, candles);
      if (ind.pane > 0) syncDecimals(ind, values, fromIndex);
      ind.series.forEach((s, k) => {
        const vals = values[k];
        if (!vals) return;
        const isHist = ind.cfg.type === 'macd' && k === 0;
        // VWAP resets each session. lightweight-charts colours the segment from point i to i+1 with
        // point i's colour (whitespace does not break a line), so the last point of a session gets a
        // transparent colour to avoid drawing a jump into the next session.
        const endsSession = (i: number) =>
          ind.cfg.type === 'vwap' && timeframe !== '1D' && i + 1 < candles.length && exchangeDate(candles[i + 1].time) !== exchangeDate(candles[i].time);
        const point = (i: number) =>
          Number.isNaN(vals[i])
            ? { time: ct(candles[i].time) }
            : isHist
              ? { time: ct(candles[i].time), value: vals[i], color: vals[i] >= 0 ? palRef.current.histUp : palRef.current.histDown }
              : endsSession(i)
                ? { time: ct(candles[i].time), value: vals[i], color: 'rgba(0,0,0,0)' }
                : { time: ct(candles[i].time), value: vals[i] };
        // update() can only touch the newest point, so when a new session starts (which changes how
        // the previous point is drawn) the series is reset instead. That happens once per day.
        if (fromIndex <= 0 || endsSession(fromIndex - 1)) s.setData(candles.map((_, i) => point(i)) as never);
        else for (let i = fromIndex; i < candles.length; i++) s.update(point(i) as never);
      });
    }
  }

  /** Oscillator label precision follows the size of its values (RSI and most MACDs: 2 decimals). */
  function syncDecimals(ind: IndicatorSeries, values: number[][], fromIndex: number): void {
    if (fromIndex <= 0) ind.maxAbs = 0;
    for (const vals of values) for (let i = Math.max(0, fromIndex); i < vals.length; i++) if (Number.isFinite(vals[i])) ind.maxAbs = Math.max(ind.maxAbs, Math.abs(vals[i]));
    const d = valueDecimals(ind.maxAbs);
    if (d === ind.decimals) return;
    ind.decimals = d;
    for (const s of ind.series) s.applyOptions({ priceFormat: valueFormat(d) });
  }

  function volumePoint(c: Bar) {
    return { time: ct(c.time), value: c.volume, color: c.close >= c.open ? palRef.current.volumeUp : palRef.current.volumeDown };
  }

  function candlePoint(c: Bar) {
    return mainPoint(styleRef.current, ct(c.time), c);
  }

  function fullRedraw(): void {
    const series = candleRef.current;
    if (!series) return;
    baseRef.current = getBaseBars(symbol);
    candlesRef.current = aggregateBars(baseRef.current, timeframe);
    series.setData(candlesRef.current.map(candlePoint) as never);
    volumeRef.current?.setData(candlesRef.current.map(volumePoint));
    setIndicatorData(0);
    syncLastDirection();
    syncPercentBase();
    setGeometryVersion((v) => v + 1);
  }

  /** Re-aggregate from the bucket containing base index `from` and push updates. */
  function rebuildTail(from: number): void {
    const base = baseRef.current;
    const series = candleRef.current;
    if (!series || !base.length) return;
    const key = bucketFor(base[Math.min(from, base.length - 1)].time, timeframe).key;
    let start = Math.min(from, base.length - 1);
    while (start > 0 && bucketFor(base[start - 1].time, timeframe).key === key) start--;
    const bucketStart = bucketFor(base[start].time, timeframe).start;
    const candles = candlesRef.current;
    // Only the forming (last) candle can change; drop it and rebuild from its first base bar.
    while (candles.length && candles[candles.length - 1].time >= bucketStart) candles.pop();
    const firstChanged = candles.length;
    const tail = aggregateBars(base.slice(start), timeframe);
    for (const c of tail) {
      candles.push(c);
      series.update(candlePoint(c) as never);
      volumeRef.current?.update(volumePoint(c));
    }
    setIndicatorData(firstChanged);
    syncLastDirection();
    syncPercentBase();
  }

  useEffect(() => {
    fullRedraw();
    useDrawings.getState().setSymbol(symbol);
    return onChartEvent((e) => {
      if (e.type === 'reset') {
        fullRedraw();
        return;
      }
      if (e.symbol !== symbol) return;
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
    const markers: SeriesMarker<Time>[] = [];
    for (const f of fills) {
      if (f.symbol !== symbol) continue;
      const buy = f.side === 'buy';
      markers.push({
        time: ct(bucketFor(f.time, timeframe).start),
        position: buy ? 'belowBar' : 'aboveBar',
        shape: buy ? 'arrowUp' : 'arrowDown',
        color: buy ? pal.markerBuy : pal.markerSell,
        text: `${f.action.toUpperCase()} ${f.quantity} @ ${fmtPrice(f.price)}`,
      });
    }
    for (const ev of getSimEventsFor(symbol)) {
      markers.push({
        time: ct(bucketFor(ev.time, timeframe).start),
        position: 'aboveBar',
        shape: 'circle',
        color: ev.impactPct >= 0 ? pal.markerUp : pal.markerDown,
        text: `SIM NEWS: ${ev.headline.replace('[SIMULATED] ', '').slice(0, 40)}`,
      });
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    m.setMarkers(markers);
  }, [fills, symbol, timeframe, simEventCount, seriesVersion, shift, pal.markerBuy, pal.markerSell, pal.markerUp, pal.markerDown]);

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
      timeframe,
      paneHeight: () => chart.panes()[0]?.getHeight() ?? 0,
      paneWidth: () => chart.timeScale().width(),
      container,
    };
    // geometryVersion forces consumers to re-render on scroll/zoom/resize/data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeframe, geometryVersion, seriesVersion]);

  const lb = legend?.bar ?? candlesRef.current[candlesRef.current.length - 1];
  return (
    <div className={`chart-wrap${pickTarget ? ' picking' : ''}`}>
      <div ref={containerRef} className="chart-canvas" />
      {geometry && <DrawingLayer geometry={geometry} version={geometryVersion} />}
      {geometry && <DeleteDrawingButton left={geometry.paneWidth() - 8} top={geometry.paneHeight() - 8} />}
      {lb && (
        <div className="chart-legend">
          <span className="legend-sym">{symbol}</span>
          <span className="muted">{timeframe}</span>
          {legend && <span className="muted">{blind ? blindDayLabel(lb.time) : ''}</span>}
          <span>O <b>{fmtPrice(lb.open)}</b></span>
          <span>H <b>{fmtPrice(lb.high)}</b></span>
          <span>L <b>{fmtPrice(lb.low)}</b></span>
          <span>C <b className={lb.close >= lb.open ? 'pos' : 'neg'}>{fmtPrice(lb.close)}</b></span>
          <span>V <b>{compactVolume(lb.volume)}</b></span>
          {legend && <span className={legend.change >= 0 ? 'pos' : 'neg'}>{legend.change >= 0 ? '+' : ''}{legend.change.toFixed(2)}%</span>}
        </div>
      )}
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
  const maxW = 1200;
  if (canvas.width > maxW) {
    const c2 = document.createElement('canvas');
    c2.width = maxW;
    c2.height = Math.round((canvas.height * maxW) / canvas.width);
    c2.getContext('2d')?.drawImage(canvas, 0, 0, c2.width, c2.height);
    return c2.toDataURL('image/jpeg', 0.82);
  }
  return canvas.toDataURL('image/jpeg', 0.82);
}
