/**
 * The parts of a price chart that the chart on screen (ChartView) and journal snapshots drawn off
 * screen (offscreenSnapshot) build the same way: indicator series and their colours, names and
 * values, the source watermark, axis time labels, fill and news markers, and the saved picture.
 */
import { HistogramSeries, LineSeries, LineStyle, TickMarkType, type IChartApi, type IPriceLine, type ISeriesApi, type PriceFormat, type SeriesMarker, type Time } from 'lightweight-charts';
import type { Bar, DataSourceKind, Fill, Timeframe } from '../../core/types';
import type { SimEvent } from '../../core/sim/SimMarket';
import type { IndicatorSpec } from '../../core/indicators/indicators';
import { aggregateBars } from '../../core/data/aggregate';
import { exchangeDate } from '../../core/time';
import type { IndicatorConfig } from '../state/settingsStore';
import { price as fmtPrice } from '../services/format';
import { onChart, type ChartPalette } from '../theme/themes';
import { chartLabelFill } from '../theme/color';

/**
 * A chart's candles: `candles` from the revealed bars, after `history`'s bars (from before them, each
 * complete before the replay's start) built into the same timeframe. `fromHistory` of them come from
 * the history; a history candle that would overlap the revealed ones is left out.
 */
export function withHistory(candles: Bar[], history: { bars: readonly Bar[]; timeframe: Timeframe } | null | undefined, timeframe: Timeframe): { candles: Bar[]; fromHistory: number } {
  const earlier = history?.bars.length ? aggregateBars(history.bars, timeframe, history.timeframe) : [];
  let n = earlier.length;
  while (n > 0 && candles.length && earlier[n - 1].time >= candles[0].time) n--;
  return { candles: n ? earlier.slice(0, n).concat(candles) : candles, fromHistory: n };
}

/** Indicators drawn in a pane of their own below the price. */
export const OSCILLATORS = new Set(['rsi', 'macd', 'atr']);

/** Line colour per series of an indicator (null for the MACD histogram, coloured per bar). */
export function indicatorColors(cfg: IndicatorConfig, p: ChartPalette): (string | null)[] {
  if (cfg.type === 'macd') return [null, p.accent, p.warn];
  const c = onChart(cfg.color, p.background);
  return cfg.type === 'bb' ? [c, c, c] : [c];
}

/** What to compute for an indicator; its lines come in the order of its series. */
export function indicatorSpec(cfg: IndicatorConfig): IndicatorSpec | null {
  switch (cfg.type) {
    case 'sma':
    case 'ema':
      return { type: cfg.type, period: cfg.period ?? 20 };
    case 'rsi':
    case 'atr':
      return { type: cfg.type, period: cfg.period ?? 14 };
    case 'vwap':
      return { type: 'vwap' };
    case 'bb':
      return { type: 'bb', period: cfg.period ?? 20, mult: cfg.mult ?? 2 };
    case 'macd':
      return { type: 'macd', fast: cfg.fast ?? 12, slow: cfg.slow ?? 26, signal: cfg.signal ?? 9 };
    case 'volume':
      return null;
  }
}

/** An indicator's name with its parameters, as the legend shows it ("EMA 9", "MACD 12 26 9"). */
export function indicatorName(cfg: IndicatorConfig): string {
  const spec = indicatorSpec(cfg);
  if (!spec) return cfg.type === 'volume' ? 'Volume' : String(cfg.type).toUpperCase();
  const params = spec.type === 'bb' ? [spec.period, spec.mult] : spec.type === 'macd' ? [spec.fast, spec.slow, spec.signal] : spec.type === 'vwap' ? [] : [spec.period];
  return [spec.type.toUpperCase(), ...params].join(' ');
}

/** The names on an indicator's value labels on the price axis, per series (none for the MACD histogram). */
export function seriesTitles(cfg: IndicatorConfig): string[] {
  if (cfg.type === 'bb') return ['BB upper', 'BB basis', 'BB lower'];
  if (cfg.type === 'macd') return ['', 'MACD', 'Signal'];
  return [indicatorName(cfg)];
}

/**
 * Adds the series of indicator `cfg` (not volume) to `pane` of `chart`, coloured and named as on
 * screen, with the RSI's 70/30 guide lines.
 */
export function addIndicatorSeries(
  chart: IChartApi,
  cfg: IndicatorConfig,
  pane: number,
  priceFormat: PriceFormat,
  p: ChartPalette,
): { series: ISeriesApi<'Line' | 'Histogram'>[]; bands: IPriceLine[] } {
  const colors = indicatorColors(cfg, p);
  const titles = seriesTitles(cfg);
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
        // Names the value label on the price axis, as in TradingView.
        title: titles[k] ?? '',
        crosshairMarkerVisible: false,
        priceFormat,
      },
      pane,
    );
  let series: ISeriesApi<'Line' | 'Histogram'>[];
  if (cfg.type === 'bb') series = [line(0, 1, LineStyle.Dashed), line(1, 1), line(2, 1, LineStyle.Dashed)];
  else if (cfg.type === 'macd') series = [chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat }, pane), line(1, 2), line(2, 1)];
  else series = [line(0, cfg.type === 'vwap' ? 2 : 1)];
  const bands: IPriceLine[] = [];
  if (cfg.type === 'rsi') {
    bands.push(series[0].createPriceLine({ price: 70, color: p.bandDown, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' }));
    bands.push(series[0].createPriceLine({ price: 30, color: p.bandUp, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' }));
  }
  return { series, bands };
}

/** Adds the volume histogram, along the bottom fifth of the price pane. */
export function addVolumeSeries(chart: IChartApi): ISeriesApi<'Histogram'> {
  const v = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  return v;
}

/** Candle `c`'s volume bar at chart time `time`, coloured by the candle's direction. */
export function volumePoint(c: Bar, time: Time, p: ChartPalette) {
  return { time, value: c.volume, color: c.close >= c.open ? p.volumeUp : p.volumeDown };
}

/**
 * VWAP resets each session. lightweight-charts colours the segment from point i to i+1 with point i's
 * colour (whitespace does not break a line), so the last point of a session gets a transparent colour
 * to avoid drawing a jump into the next session: true for that point, candle `i` of `candles`.
 */
export function endsSession(cfg: IndicatorConfig, candles: readonly Bar[], i: number, timeframe: Timeframe): boolean {
  return cfg.type === 'vwap' && timeframe !== '1D' && i + 1 < candles.length && exchangeDate(candles[i + 1].time) !== exchangeDate(candles[i].time);
}

/** The point of an indicator's series `k` with value `v` on candle `i` of `candles`, at chart time `time`. */
export function indicatorPoint(cfg: IndicatorConfig, k: number, v: number, time: Time, candles: readonly Bar[], i: number, timeframe: Timeframe, p: ChartPalette) {
  if (Number.isNaN(v)) return { time };
  if (cfg.type === 'macd' && k === 0) return { time, value: v, color: v >= 0 ? p.histUp : p.histDown };
  if (endsSession(cfg, candles, i, timeframe)) return { time, value: v, color: 'rgba(0,0,0,0)' };
  return { time, value: v };
}

/** The data-source line of the chart's watermark, so a picture of it says where its prices came from. */
export function sourceWatermark(source: DataSourceKind): string {
  return source === 'DEMO' ? 'DEMO DATA · SYNTHETIC' : source === 'SIMULATED' ? 'SIMULATED MARKET · FICTIONAL' : source === 'HISTORICAL' ? 'HISTORICAL DATA · REPLAY' : 'LIVE';
}

/** The watermark's lines: symbol and timeframe, then the data source. */
export function watermarkLines(symbol: string, timeframe: Timeframe, source: DataSourceKind, p: ChartPalette) {
  return [
    { text: `${symbol} · ${timeframe}`, color: p.watermark, fontSize: 42, fontStyle: 'bold' },
    { text: sourceWatermark(source), color: p.watermarkSub, fontSize: 16 },
  ];
}

/**
 * Time labels for chart times (ET shifted into UTC, see toChartTime): the crosshair's and the axis
 * ticks'. `blindDay` labels a day boundary in a blind session ("Day N", from the chart time), where
 * the calendar date must never appear; null outside one.
 */
export function timeLabels(timeframe: Timeframe, blindDay: ((t: number) => string) | null) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const parts = (shifted: number) => {
    const d = new Date(shifted * 1000);
    return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, hm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
  };
  return {
    timeFormatter: (t: Time) => {
      const p = parts(t as number);
      const label = blindDay ? blindDay(t as number) : p.date;
      return timeframe === '1D' ? label : `${label} ${p.hm}`;
    },
    tickMarkFormatter: (t: Time, type: TickMarkType) => {
      const p = parts(t as number);
      if (type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds) return p.hm;
      if (blindDay) return blindDay(t as number);
      if (type === TickMarkType.Year) return p.date.slice(0, 4);
      if (type === TickMarkType.Month) return p.date.slice(0, 7);
      return p.date.slice(5);
    },
  };
}

/** A fill's BUY or SELL marker, on the candle at chart time `time`. */
export function fillMarker(f: Fill, time: Time, p: ChartPalette): SeriesMarker<Time> {
  const buy = f.side === 'buy';
  return {
    time,
    position: buy ? 'belowBar' : 'aboveBar',
    shape: buy ? 'arrowUp' : 'arrowDown',
    color: buy ? p.markerBuy : p.markerSell,
    text: `${f.action.toUpperCase()} ${f.quantity} @ ${fmtPrice(f.price)}`,
  };
}

/** A simulated news event's marker, on the candle at chart time `time`. */
export function newsMarker(ev: SimEvent, time: Time, p: ChartPalette): SeriesMarker<Time> {
  return {
    time,
    position: 'aboveBar',
    shape: 'circle',
    color: ev.impactPct >= 0 ? p.markerUp : p.markerDown,
    text: `SIM NEWS: ${ev.headline.replace('[SIMULATED] ', '').slice(0, 40)}`,
  };
}

/** A chart picture as a JPEG data URL, at most 1200 pixels wide, as journal snapshots are saved. */
export function toJpeg(canvas: HTMLCanvasElement): string {
  const maxW = 1200;
  if (canvas.width <= maxW) return canvas.toDataURL('image/jpeg', 0.82);
  const c2 = document.createElement('canvas');
  c2.width = maxW;
  c2.height = Math.round((canvas.height * maxW) / canvas.width);
  c2.getContext('2d')?.drawImage(canvas, 0, 0, c2.width, c2.height);
  return c2.toDataURL('image/jpeg', 0.82);
}
