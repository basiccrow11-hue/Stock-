/**
 * TradingView-style chart built on lightweight-charts (Apache-2.0, by TradingView).
 *
 * Data comes only from getBaseBars() (revealed bars) and incremental bus events, so the chart can
 * never show a candle that has not happened yet in the replay. Indicators are recomputed from the
 * revealed candles with the causal functions in core/indicators.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  HistogramSeries,
  LineSeries,
  LineStyle,
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
import { TIMEFRAME_MINUTES } from '../../core/types';
import { aggregateBars, bucketFor } from '../../core/data/aggregate';
import { atr, bollinger, ema, macd, rsi, sma, vwap } from '../../core/indicators/indicators';
import { exchangeDate, exchangeOffsetSeconds } from '../../core/time';
import { describe as describeOrder, isOpen } from '../../core/broker/SimBroker';
import { useSettings, type IndicatorConfig } from '../state/settingsStore';
import { getBaseBars, getSimEventsFor, onChartEvent, pickPrice, registerSnapshotProvider, useTrading, blindDayLabel } from '../state/tradingStore';
import { CHART_LOCALE, compactVolume, price as fmtPrice } from '../services/format';
import { DrawingLayer, type ChartGeometry } from './DrawingLayer';
import { useDrawings } from './drawings';
import { addMainSeries, chartOptions, mainPoint, mainSeriesOptions, priceScaleMode, type MainSeries } from './chartTheme';
import { useTheme } from '../theme/useTheme';

/** lightweight-charts renders UTC; shift to exchange time so axes read in ET. */
export function toChartTime(t: number): UTCTimestamp {
  return (t + exchangeOffsetSeconds(t)) as UTCTimestamp;
}

interface IndicatorSeries {
  cfg: IndicatorConfig;
  series: ISeriesApi<'Line' | 'Histogram'>[];
  pane: number;
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
  const [legend, setLegend] = useState<{ bar: Bar; change: number } | null>(null);

  const indicators = useSettings((s) => s.indicators);
  const session = useTrading((s) => s.session);
  const fills = useTrading((s) => s.fills);
  const orders = useTrading((s) => s.orders);
  const positions = useTrading((s) => s.positions);
  const simEventCount = useTrading((s) => s.simEvents.length);
  const pickTarget = useTrading((s) => s.pickTarget);
  const blind = session?.blind ?? false;
  const tfSeconds = TIMEFRAME_MINUTES[timeframe] * 60;

  // ---------------------------------------------------------------- create chart once
  useEffect(() => {
    const el = containerRef.current!;
    const base = chartOptions(palRef.current);
    const chart = createChart(el, {
      ...base,
      autoSize: true,
      layout: { ...base.layout, fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', panes: { ...base.layout?.panes, enableResize: true } },
      timeScale: { ...base.timeScale, timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 7 },
      localization: { locale: CHART_LOCALE, priceFormatter: (p: number) => fmtPrice(p) },
    });
    chartRef.current = chart;

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData) {
        setLegend(null);
        return;
      }
      const idx = candlesRef.current.findIndex((c) => toChartTime(c.time) === param.time);
      if (idx < 0) return;
      const bar = candlesRef.current[idx];
      const prev = idx > 0 ? candlesRef.current[idx - 1].close : bar.open;
      setLegend({ bar, change: ((bar.close - prev) / prev) * 100 });
    });
    chart.subscribeClick((param) => {
      const series = candleRef.current;
      if (!param.point || !series || !useTrading.getState().pickTarget) return;
      const p = series.coordinateToPrice(param.point.y);
      if (p !== null) pickPrice(Math.round(p * 100) / 100);
    });
    const bump = () => setGeometryVersion((v) => v + 1);
    chart.timeScale().subscribeVisibleLogicalRangeChange(bump);
    const ro = new ResizeObserver(bump);
    ro.observe(el);

    registerSnapshotProvider(async () => snapshot(chart, el));
    return () => {
      registerSnapshotProvider(null);
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
    if (old) {
      markersRef.current?.detach();
      chart.removeSeries(old);
      priceLinesRef.current = [];
    }
    const series = addMainSeries(chart, palRef.current);
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
    series.applyOptions(mainSeriesOptions(pal));
    chart.priceScale('right', 0).applyOptions({ mode: priceScaleMode(pal.priceScale) });
    // Volume and MACD histogram colours are per point, so their data is re-sent.
    volumeRef.current?.setData(candlesRef.current.map(volumePoint));
    setIndicatorData(0);
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
    const real = (shifted: number) => shifted - exchangeOffsetSeconds(shifted);
    chart.applyOptions({
      localization: {
        locale: CHART_LOCALE,
        priceFormatter: (p: number) => fmtPrice(p),
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
      },
    });
  }, [blind, timeframe]);

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
  const indicatorKey = useMemo(() => JSON.stringify(indicators.filter((i) => i.enabled)), [indicators]);
  // Colours baked into indicator series at creation (MACD lines, RSI bands).
  const indicatorPalette = `${pal.up}|${pal.down}|${pal.accent}|${pal.warn}`;

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const ind of indicatorsRef.current) for (const s of ind.series) chart.removeSeries(s);
    if (volumeRef.current) chart.removeSeries(volumeRef.current);
    volumeRef.current = null;
    indicatorsRef.current = [];
    // Remove empty panes beyond the main one.
    while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);

    const enabled: IndicatorConfig[] = JSON.parse(indicatorKey);
    let nextPane = 1;
    for (const cfg of enabled) {
      if (cfg.type === 'volume') {
        const v = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
        chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
        volumeRef.current = v;
        continue;
      }
      const pane = OSCILLATORS.has(cfg.type) ? nextPane++ : 0;
      const line = (color: string, width: 1 | 2 = 1, style = LineStyle.Solid) =>
        chart.addSeries(LineSeries, { color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false }, pane);
      let series: ISeriesApi<'Line' | 'Histogram'>[] = [];
      if (cfg.type === 'bb') series = [line(cfg.color, 1, LineStyle.Dashed), line(cfg.color, 1), line(cfg.color, 1, LineStyle.Dashed)];
      else if (cfg.type === 'macd') {
        series = [
          chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane),
          line(pal.accent, 2),
          line(pal.warn, 1),
        ];
      } else series = [line(cfg.color, cfg.type === 'vwap' ? 2 : 1)];
      if (cfg.type === 'rsi') {
        series[0].createPriceLine({ price: 70, color: pal.bandDown, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
        series[0].createPriceLine({ price: 30, color: pal.bandUp, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
      }
      indicatorsRef.current.push({ cfg, series, pane });
    }
    for (let p = 1; p < chart.panes().length; p++) chart.panes()[p].setStretchFactor(0.35);
    chart.panes()[0].setStretchFactor(1);
    fullRedraw();
    // fullRedraw is stable for the lifetime of the component (uses refs only).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indicatorKey, indicatorPalette]);

  // ---------------------------------------------------------------- data
  function setIndicatorData(fromIndex: number): void {
    const candles = candlesRef.current;
    for (const ind of indicatorsRef.current) {
      const values = computeIndicator(ind.cfg, candles);
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
            ? { time: toChartTime(candles[i].time) }
            : isHist
              ? { time: toChartTime(candles[i].time), value: vals[i], color: vals[i] >= 0 ? palRef.current.histUp : palRef.current.histDown }
              : endsSession(i)
                ? { time: toChartTime(candles[i].time), value: vals[i], color: 'rgba(0,0,0,0)' }
                : { time: toChartTime(candles[i].time), value: vals[i] };
        // update() can only touch the newest point, so when a new session starts (which changes how
        // the previous point is drawn) the series is reset instead. That happens once per day.
        if (fromIndex <= 0 || endsSession(fromIndex - 1)) s.setData(candles.map((_, i) => point(i)) as never);
        else for (let i = fromIndex; i < candles.length; i++) s.update(point(i) as never);
      });
    }
  }

  function volumePoint(c: Bar) {
    return { time: toChartTime(c.time), value: c.volume, color: c.close >= c.open ? palRef.current.volumeUp : palRef.current.volumeDown };
  }

  function candlePoint(c: Bar) {
    return mainPoint(styleRef.current, toChartTime(c.time), c);
  }

  function fullRedraw(): void {
    const series = candleRef.current;
    if (!series) return;
    baseRef.current = getBaseBars(symbol);
    candlesRef.current = aggregateBars(baseRef.current, timeframe);
    series.setData(candlesRef.current.map(candlePoint) as never);
    volumeRef.current?.setData(candlesRef.current.map(volumePoint));
    setIndicatorData(0);
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
      const base = baseRef.current;
      if (e.type === 'append') {
        const from = base.length;
        for (const b of e.bars) base.push(b);
        rebuildTail(from);
      } else {
        // Sim tick: the forming 1m bar is re-sent with cumulative values; replace, don't add.
        const last = base[base.length - 1];
        if (last && last.time === e.bar.time) base[base.length - 1] = { ...e.bar };
        else base.push({ ...e.bar });
        rebuildTail(base.length - 1);
      }
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
        time: toChartTime(bucketFor(f.time, timeframe).start),
        position: buy ? 'belowBar' : 'aboveBar',
        shape: buy ? 'arrowUp' : 'arrowDown',
        color: buy ? pal.accent : pal.warn,
        text: `${f.action.toUpperCase()} ${f.quantity} @ ${fmtPrice(f.price)}`,
      });
    }
    for (const ev of getSimEventsFor(symbol)) {
      markers.push({
        time: toChartTime(bucketFor(ev.time, timeframe).start),
        position: 'aboveBar',
        shape: 'circle',
        color: ev.impactPct >= 0 ? pal.up : pal.down,
        text: `SIM NEWS: ${ev.headline.replace('[SIMULATED] ', '').slice(0, 40)}`,
      });
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    m.setMarkers(markers);
  }, [fills, symbol, timeframe, simEventCount, seriesVersion, pal.accent, pal.warn, pal.up, pal.down]);

  // ---------------------------------------------------------------- price lines: position + orders
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    for (const pl of priceLinesRef.current) series.removePriceLine(pl);
    priceLinesRef.current = [];
    const pos = positions.find((p) => p.symbol === symbol);
    if (pos && pos.quantity !== 0) {
      priceLinesRef.current.push(
        series.createPriceLine({ price: pos.avgPrice, color: pal.accent, lineStyle: LineStyle.Solid, lineWidth: 1, axisLabelVisible: true, title: `${pos.quantity > 0 ? 'LONG' : 'SHORT'} ${Math.abs(pos.quantity)}` }),
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
      priceLinesRef.current.push(series.createPriceLine({ price: px, color, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title }));
    }
  }, [orders, positions, symbol, seriesVersion, pal.accent, pal.warn, pal.up, pal.down]);

  // ---------------------------------------------------------------- geometry for drawings
  const geometry: ChartGeometry | null = useMemo(() => {
    const chart = chartRef.current;
    const series = candleRef.current;
    if (!chart || !series) return null;
    return {
      chart,
      series,
      candles: () => candlesRef.current,
      tfSeconds,
      paneHeight: () => chart.panes()[0]?.getHeight() ?? 0,
      paneWidth: () => chart.timeScale().width(),
    };
    // geometryVersion forces consumers to re-render on scroll/zoom/resize/data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tfSeconds, geometryVersion, seriesVersion]);

  const lb = legend?.bar ?? candlesRef.current[candlesRef.current.length - 1];
  return (
    <div className={`chart-wrap${pickTarget ? ' picking' : ''}`}>
      <div ref={containerRef} className="chart-canvas" />
      {geometry && <DrawingLayer geometry={geometry} version={geometryVersion} />}
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

/** Chart + drawings as a JPEG data URL (for journal entries). */
async function snapshot(chart: IChartApi, container: HTMLElement): Promise<string | null> {
  const canvas = chart.takeScreenshot(true, false);
  const svg = container.parentElement?.querySelector('svg.drawing-layer') as SVGSVGElement | null;
  if (svg && svg.childElementCount > 0) {
    const ctx = canvas.getContext('2d');
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
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
