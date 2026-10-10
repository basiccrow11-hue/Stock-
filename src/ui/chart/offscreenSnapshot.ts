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
import { PriceScaleMode, createChart, createSeriesMarkers, createTextWatermark, type IChartApi } from 'lightweight-charts';
import type { Bar, DataSourceKind, Fill, Timeframe, UnixSeconds } from '../../core/types';
import type { SimEvent } from '../../core/sim/SimMarket';
import { aggregateBars, bucketFor, ownCandles } from '../../core/data/aggregate';
import { indicatorStream } from '../../core/indicators/indicators';
import { lastIndexAtOrBefore } from '../../core/util/math';
import { getSettings } from '../state/settingsStore';
import { blindDayLabel } from '../state/tradingStore';
import { resolved } from '../theme/useTheme';
import { CHART_LOCALE } from '../services/format';
import { addMainSeries, chartOptions, mainPoint, mainPriceFormat, priceScaleMode, valueDecimals, valueFormat } from './chartTheme';
import { OSCILLATORS, addIndicatorSeries, addVolumeSeries, chartMarkers, indicatorPoint, indicatorSpec, timeLabels, toJpeg, volumePoint, watermarkLines, withHistory } from './chartParts';
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
  /** The chart's history from before those bars (see ChartHistory), when it had loaded any. */
  history?: { bars: readonly Bar[]; timeframe: Timeframe };
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
  const all = withHistory(aggregateBars(scene.bars, timeframe, baseTimeframe), scene.history, timeframe).candles;
  const entryIndex = Math.max(0, lastIndexAtOrBefore(all, candleStart(scene.entryTime), (c) => c.time));
  const first = Math.max(0, Math.min(entryIndex - BEFORE_ENTRY, all.length - 1 - MIN_CANDLES));
  const candles = all.slice(first);

  const base = chartOptions(pal);
  // In a blind session no calendar date may appear: day boundaries read "Day N", as on screen.
  const { tickMarkFormatter } = timeLabels(timeframe, blind ? (t) => blindDayLabel(fromChartTime(t, shift), blind.startDate) : null);

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
        tickMarkFormatter,
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
        addVolumeSeries(chart).setData(candles.map((c) => volumePoint(c, ct(c.time), pal)));
        continue;
      }
      const spec = indicatorSpec(cfg);
      if (!spec) continue;
      // Worked out on every candle, as on screen; the chart is handed those from `first`.
      const stream = indicatorStream(spec);
      stream.update(all, 0);
      const pane = OSCILLATORS.has(cfg.type) ? nextPane++ : 0;
      let maxAbs = 0;
      if (pane > 0) for (const vals of stream.lines) for (let i = first; i < vals.length; i++) if (Number.isFinite(vals[i])) maxAbs = Math.max(maxAbs, Math.abs(vals[i]));
      const priceFormat = pane === 0 ? overlayFormat : valueFormat(valueDecimals(maxAbs));
      const { series: lines } = addIndicatorSeries(chart, cfg, pane, priceFormat, pal);
      lines.forEach((s, k) => s.setData(candles.map((c, i) => indicatorPoint(cfg, k, stream.lines[k][first + i], ct(c.time), all, first + i, timeframe, pal)) as never));
      if (pane > 0) {
        chart.panes()[pane]?.setStretchFactor(0.35);
        chart.priceScale('right', pane).applyOptions({ mode: PriceScaleMode.Normal });
      }
    }
    chart.panes()[0].setStretchFactor(1);

    // An earlier trade's fills and earlier news, from before the first candle, are left out, as on screen.
    createSeriesMarkers(series, chartMarkers(scene.fills, scene.news, candleStart, candles[0].time, ct, pal));

    // Set once every series has its data, so nothing moves it afterwards; the screen's room after the last candle.
    chart.timeScale().setVisibleLogicalRange({ from: 0, to: candles.length - 1 + RIGHT_OFFSET });
    createTextWatermark(chart.panes()[0], {
      horzAlign: 'center',
      vertAlign: 'center',
      lines: watermarkLines(scene.symbol, timeframe, scene.source, pal),
    });

    return toJpeg(chart.takeScreenshot(true, false));
  } finally {
    chart.remove();
    host.remove();
  }
}
