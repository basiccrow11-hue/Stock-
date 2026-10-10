/**
 * Journal snapshots drawn off screen: a picture of one symbol's chart as it stood when a trade on it
 * closed, for a trade the chart on screen could not show at that moment (another symbol of a
 * watchlist replay or the simulated market, or the charted symbol after the replay had already moved
 * past the close in the same step).
 *
 * The chart is built the way the one on screen is (ChartView): the same theme, chart style, price
 * scale, enabled indicators, fill markers, simulated news markers and data-source watermark, on the
 * timeframe the chart was on. It is drawn only from the bars the replay had shown by the moment the
 * exit became known, so it never holds a bar from after the close. It has none of the chart's
 * drawings, and instead of the screen's scroll and zoom it shows the trade from shortly before its
 * entry to the close.
 */
import { HistogramSeries, LineSeries, LineStyle, PriceScaleMode, TickMarkType, createChart, createSeriesMarkers, createTextWatermark, type IChartApi, type SeriesMarker, type Time } from 'lightweight-charts';
import type { Bar, DataSourceKind, Fill, Timeframe, UnixSeconds } from '../../core/types';
import type { SimEvent } from '../../core/sim/SimMarket';
import { aggregateBars, bucketFor, ownCandles } from '../../core/data/aggregate';
import { atr, bollinger, ema, macd, rsi, sma, vwap } from '../../core/indicators/indicators';
import { exchangeDate } from '../../core/time';
import { lastIndexAtOrBefore } from '../../core/util/math';
import { getSettings, type IndicatorConfig } from '../state/settingsStore';
import { blindDayLabel } from '../state/tradingStore';
import { resolved } from '../theme/useTheme';
import { onChart, type ChartPalette } from '../theme/themes';
import { chartLabelFill } from '../theme/color';
import { CHART_LOCALE, price as fmtPrice } from '../services/format';
import { addMainSeries, chartOptions, mainPoint, mainPriceFormat, priceScaleMode, valueDecimals, valueFormat } from './chartTheme';
import { blindChartShift, fromChartTime, toChartTime } from './ChartView';

/** Everything the picture shows, taken when the trade closed: later changes to the session do not reach it. */
export interface ChartScene {
  symbol: string;
  /** The timeframe the chart was on. */
  timeframe: Timeframe;
  /** The size of the symbol's own bars. */
  baseTimeframe: Timeframe;
  /** The symbol's bars shown by the moment the exit became known, oldest first. */
  bars: Bar[];
  /** The symbol's fills known by then (the chart's buy and sell markers). */
  fills: Fill[];
  /** Simulated news on the symbol or the whole market by then. */
  news: SimEvent[];
  /** When the trade opened: the picture starts a little before it. */
  entryTime: UnixSeconds;
  source: DataSourceKind;
  /** A blind session's id and first day: its chart moves times and labels days "Day N", as on screen. */
  blind: { sessionId: string; startDate: string } | null;
}

/** The picture's size in CSS pixels; drawn at the screen's pixel ratio and saved at most 1200 pixels wide, like the chart's own. */
const WIDTH = 960;
const HEIGHT = 480;
/** Candles shown before the entry's, and the fewest shown in all (a trade inside one candle still gets context). */
const BEFORE_ENTRY = 30;
const MIN_CANDLES = 100;
/** Empty space after the last candle, as on screen. */
const RIGHT_OFFSET = 8;

const OSCILLATORS = new Set(['rsi', 'macd', 'atr']);

/** Line colour per series of an indicator (null for the MACD histogram, coloured per bar), as on screen. */
function indicatorColors(cfg: IndicatorConfig, p: ChartPalette): (string | null)[] {
  if (cfg.type === 'macd') return [null, p.accent, p.warn];
  const c = onChart(cfg.color, p.background);
  return cfg.type === 'bb' ? [c, c, c] : [c];
}

/** An indicator's values on every candle, one array per series, with the chart's default periods. */
function indicatorValues(cfg: IndicatorConfig, candles: Bar[]): number[][] {
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

/** The data-source line of the watermark, as on screen. */
const SOURCE_WATERMARK: Record<DataSourceKind, string> = {
  DEMO: 'DEMO DATA · SYNTHETIC',
  SIMULATED: 'SIMULATED MARKET · FICTIONAL',
  HISTORICAL: 'HISTORICAL DATA · REPLAY',
  LIVE: 'LIVE',
};

/**
 * Draws `scene` on a chart outside the page and returns it as a JPEG data URL, or null when there is
 * nothing to draw. The chart and its element are removed again before it returns.
 */
export async function offscreenSnapshot(scene: ChartScene): Promise<string | null> {
  if (!scene.bars.length) return null;
  const settings = getSettings();
  const pal = resolved(settings.appearance).chart;
  const { timeframe, baseTimeframe, blind } = scene;
  const shift = blind ? blindChartShift(blind.sessionId) : 0;
  const ct = (t: number) => toChartTime(t, shift);
  // Markers sit on the candle holding their time: at the data's own bar size, the bar holding it.
  const own = ownCandles(timeframe, baseTimeframe);
  const candleStart = (t: number) => (own ? (scene.bars[lastIndexAtOrBefore(scene.bars, t, (b) => b.time)]?.time ?? t) : bucketFor(t, timeframe).start);
  // Shown from a little before the entry to the close. The chart is handed only those candles; the
  // earlier ones count for the indicators, which are worked out on every candle as on screen.
  const all = aggregateBars(scene.bars, timeframe, baseTimeframe);
  const entryIndex = Math.max(0, lastIndexAtOrBefore(all, candleStart(scene.entryTime), (c) => c.time));
  const first = Math.max(0, Math.min(entryIndex - BEFORE_ENTRY, all.length - 1 - MIN_CANDLES));
  const candles = all.slice(first);

  const base = chartOptions(pal);
  const pad = (n: number) => String(n).padStart(2, '0');
  const parts = (shifted: number) => {
    const d = new Date(shifted * 1000);
    return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, hm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
  };
  // In a blind session no calendar date may appear: day boundaries read "Day N", as on screen.
  const dayLabel = (shifted: number) => blindDayLabel(fromChartTime(shifted, shift), blind!.startDate);

  // Laid out (so the chart can size itself) but out of sight and out of the accessibility tree.
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = `position:fixed;left:${-2 * WIDTH}px;top:0;width:${WIDTH}px;height:${HEIGHT}px;visibility:hidden;pointer-events:none;contain:strict`;
  document.body.appendChild(host);
  let chart: IChartApi;
  try {
    chart = createChart(host, {
      ...base,
      autoSize: false,
      width: WIDTH,
      height: HEIGHT,
      handleScroll: false,
      handleScale: false,
      layout: { ...base.layout, fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' },
      timeScale: {
        ...base.timeScale,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: RIGHT_OFFSET,
        allowBoldLabels: !blind,
        tickMarkFormatter: (t: Time, type: TickMarkType) => {
          const p = parts(t as number);
          if (type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds) return p.hm;
          if (blind) return dayLabel(t as number);
          if (type === TickMarkType.Year) return p.date.slice(0, 4);
          if (type === TickMarkType.Month) return p.date.slice(0, 7);
          return p.date.slice(5);
        },
      },
      localization: { locale: CHART_LOCALE },
    });
  } catch (e) {
    host.remove();
    throw e;
  }
  try {
    // Keeps the price pane (and its watermark) first while oscillator panes are added, as on screen.
    chart.panes()[0].setPreserveEmptyPane(true);
    const last = candles[candles.length - 1];
    const series = addMainSeries(chart, pal, last.close >= last.open);
    series.setData(candles.map((c) => mainPoint(pal.style, ct(c.time), c)) as never);

    // Percent labels measure from the first candle on screen, as on screen.
    const percentBase = candles[0].close;
    const overlayFormat = mainPriceFormat(pal.priceScale, () => percentBase);
    series.applyOptions({ priceFormat: overlayFormat });
    chart.priceScale('right', 0).applyOptions({ mode: priceScaleMode(pal.priceScale) });

    let nextPane = 1;
    for (const cfg of settings.indicators.filter((i) => i.enabled)) {
      if (cfg.type === 'volume') {
        const v = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
        chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
        v.setData(candles.map((c) => ({ time: ct(c.time), value: c.volume, color: c.close >= c.open ? pal.volumeUp : pal.volumeDown })));
        continue;
      }
      const values = indicatorValues(cfg, all).map((vals) => vals.slice(first));
      const pane = OSCILLATORS.has(cfg.type) ? nextPane++ : 0;
      let maxAbs = 0;
      if (pane > 0) for (const vals of values) for (const v of vals) if (Number.isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v));
      const priceFormat = pane === 0 ? overlayFormat : valueFormat(valueDecimals(maxAbs));
      const colors = indicatorColors(cfg, pal);
      const line = (k: number, width: 1 | 2 = 1, style = LineStyle.Solid) =>
        chart.addSeries(
          LineSeries,
          {
            color: colors[k] ?? undefined,
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
      const lines =
        cfg.type === 'bb'
          ? [line(0, 1, LineStyle.Dashed), line(1, 1), line(2, 1, LineStyle.Dashed)]
          : cfg.type === 'macd'
            ? [chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat }, pane), line(1, 2), line(2, 1)]
            : [line(0, cfg.type === 'vwap' ? 2 : 1)];
      if (cfg.type === 'rsi') {
        lines[0].createPriceLine({ price: 70, color: pal.bandDown, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
        lines[0].createPriceLine({ price: 30, color: pal.bandUp, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
      }
      lines.forEach((s, k) => {
        const vals = values[k];
        if (!vals) return;
        const hist = cfg.type === 'macd' && k === 0;
        // VWAP restarts each session: the last point of a session is transparent, so no line jumps to the next.
        const endsSession = (i: number) => cfg.type === 'vwap' && timeframe !== '1D' && i + 1 < candles.length && exchangeDate(candles[i + 1].time) !== exchangeDate(candles[i].time);
        s.setData(
          candles.map((c, i) =>
            Number.isNaN(vals[i])
              ? { time: ct(c.time) }
              : hist
                ? { time: ct(c.time), value: vals[i], color: vals[i] >= 0 ? pal.histUp : pal.histDown }
                : endsSession(i)
                  ? { time: ct(c.time), value: vals[i], color: 'rgba(0,0,0,0)' }
                  : { time: ct(c.time), value: vals[i] },
          ) as never,
        );
      });
      if (pane > 0) {
        chart.panes()[pane]?.setStretchFactor(0.35);
        chart.priceScale('right', pane).applyOptions({ mode: PriceScaleMode.Normal });
      }
    }
    chart.panes()[0].setStretchFactor(1);

    const markers: SeriesMarker<Time>[] = [];
    for (const f of scene.fills) {
      const buy = f.side === 'buy';
      markers.push({
        time: ct(candleStart(f.time)),
        position: buy ? 'belowBar' : 'aboveBar',
        shape: buy ? 'arrowUp' : 'arrowDown',
        color: buy ? pal.markerBuy : pal.markerSell,
        text: `${f.action.toUpperCase()} ${f.quantity} @ ${fmtPrice(f.price)}`,
      });
    }
    for (const ev of scene.news) {
      markers.push({
        time: ct(candleStart(ev.time)),
        position: 'aboveBar',
        shape: 'circle',
        color: ev.impactPct >= 0 ? pal.markerUp : pal.markerDown,
        text: `SIM NEWS: ${ev.headline.replace('[SIMULATED] ', '').slice(0, 40)}`,
      });
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    createSeriesMarkers(series, markers);

    // Set once every series has its data, so nothing moves it afterwards; the screen's room after the last candle.
    chart.timeScale().setVisibleLogicalRange({ from: 0, to: candles.length - 1 + RIGHT_OFFSET });
    createTextWatermark(chart.panes()[0], {
      horzAlign: 'center',
      vertAlign: 'center',
      lines: [
        { text: `${scene.symbol} · ${timeframe}`, color: pal.watermark, fontSize: 42, fontStyle: 'bold' },
        { text: SOURCE_WATERMARK[scene.source] ?? '', color: pal.watermarkSub, fontSize: 16 },
      ],
    });

    return toJpeg(chart.takeScreenshot(true, false));
  } finally {
    chart.remove();
    host.remove();
  }
}

/** A chart picture as a JPEG data URL, at most 1200 pixels wide (the chart's own snapshots are saved so too). */
function toJpeg(canvas: HTMLCanvasElement): string {
  const maxW = 1200;
  if (canvas.width <= maxW) return canvas.toDataURL('image/jpeg', 0.82);
  const c2 = document.createElement('canvas');
  c2.width = maxW;
  c2.height = Math.round((canvas.height * maxW) / canvas.width);
  c2.getContext('2d')?.drawImage(canvas, 0, 0, c2.width, c2.height);
  return c2.toDataURL('image/jpeg', 0.82);
}
