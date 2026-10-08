/** Applies the user's appearance settings to lightweight-charts instances. */
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  PriceScaleMode,
  type ChartOptions,
  type DeepPartial,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Bar } from '../../core/types';
import { price as fmtPrice } from '../services/format';
import { withAlpha } from '../theme/color';
import type { ChartPalette, ChartStyle, PanelChartPalette, PriceScaleKind } from '../theme/themes';

export type MainSeries = ISeriesApi<SeriesType>;

export function chartOptions(p: ChartPalette): DeepPartial<ChartOptions> {
  return {
    layout: {
      background: { type: ColorType.Solid, color: p.background },
      textColor: p.axisText,
      fontSize: p.fontSize,
      panes: { separatorColor: p.scaleBorder, separatorHoverColor: withAlpha(p.axisText, 0.25) },
    },
    grid: { vertLines: { color: p.grid, visible: p.vertGrid }, horzLines: { color: p.grid, visible: p.horzGrid } },
    crosshair: {
      mode: p.magnet ? CrosshairMode.Magnet : CrosshairMode.Normal,
      vertLine: { color: p.crosshair, labelBackgroundColor: p.crosshairLabel },
      horzLine: { color: p.crosshair, labelBackgroundColor: p.crosshairLabel },
    },
    rightPriceScale: { borderColor: p.scaleBorder },
    timeScale: { borderColor: p.scaleBorder },
  };
}

/** Options for small charts on app panels (transparent background, theme text). */
export function panelChartOptions(p: PanelChartPalette): DeepPartial<ChartOptions> {
  return {
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: p.text },
    grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
    rightPriceScale: { borderColor: p.border },
    timeScale: { borderColor: p.border },
  };
}

/**
 * Price scale mode for the main pane. '%' is not lightweight-charts' Percentage mode: that mode
 * measures every series from its own first visible value, so indicator overlays (EMA, VWAP) drift
 * away from price. The scale stays linear and only the labels show percent (see percentFormat).
 */
export function priceScaleMode(k: PriceScaleKind): PriceScaleMode {
  return k === 'log' ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal;
}

/** Plain price labels (used by every series; the chart has no global price formatter). */
export const PRICE_FORMAT = { type: 'custom' as const, minMove: 0.01, formatter: (p: number) => fmtPrice(p) };

/** Change from `base` in percent, e.g. "+1.25%". */
export function percentLabel(p: number, base: number): string {
  const v = Math.round((p / base - 1) * 10_000) / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/**
 * Price format for the main series: plain prices, or percent change from `base()` (the first
 * visible bar's close, like TradingView). Every series on the main pane shares one linear scale,
 * so overlays, price lines and drawings stay exactly where they belong.
 */
export function mainPriceFormat(k: PriceScaleKind, base: () => number | null) {
  if (k !== 'percent') return PRICE_FORMAT;
  return {
    type: 'custom' as const,
    minMove: 0.01,
    formatter: (p: number) => {
      const b = base();
      return b ? percentLabel(p, b) : fmtPrice(p);
    },
  };
}

export function candleOptions(p: Pick<ChartPalette, 'up' | 'down' | 'wickUp' | 'wickDown' | 'borderUp' | 'borderDown'>, hollow = false) {
  return {
    upColor: hollow ? 'rgba(0,0,0,0)' : p.up,
    downColor: p.down,
    borderVisible: true,
    borderUpColor: p.borderUp,
    borderDownColor: p.borderDown,
    wickVisible: true,
    wickUpColor: p.wickUp,
    wickDownColor: p.wickDown,
  };
}

/**
 * Style-specific options for the main price series; safe to apply to a series of that style.
 * `lastUp` is the direction of the newest bar: hollow candles have a transparent up body, and
 * lightweight-charts colours the last-price line and label with the body colour, so hollow mode
 * sets the line colour explicitly.
 */
export function mainSeriesOptions(p: ChartPalette, lastUp = true): Record<string, unknown> {
  const common = { priceLineVisible: p.lastPriceLine, lastValueVisible: true };
  switch (p.style) {
    case 'candles':
      return { ...common, ...candleOptions(p) };
    case 'hollow':
      return { ...common, ...candleOptions(p, true), priceLineColor: lastUp ? p.borderUp : p.borderDown };
    case 'bars':
      return { ...common, upColor: p.up, downColor: p.down, openVisible: true, thinBars: false };
    case 'line':
      return { ...common, color: p.line, lineWidth: 2 };
    case 'area':
      return { ...common, lineColor: p.line, topColor: p.areaTop, bottomColor: p.areaBottom, lineWidth: 2 };
  }
}

export function addMainSeries(chart: IChartApi, p: ChartPalette, lastUp = true): MainSeries {
  const opts = { ...mainSeriesOptions(p, lastUp), priceFormat: PRICE_FORMAT };
  switch (p.style) {
    case 'candles':
    case 'hollow':
      return chart.addSeries(CandlestickSeries, opts) as MainSeries;
    case 'bars':
      return chart.addSeries(BarSeries, opts) as MainSeries;
    case 'line':
      return chart.addSeries(LineSeries, opts) as MainSeries;
    case 'area':
      return chart.addSeries(AreaSeries, opts) as MainSeries;
  }
}

/** A bar in the shape the main series expects for the given style. */
export function mainPoint(style: ChartStyle, time: UTCTimestamp, c: Bar) {
  return style === 'line' || style === 'area' ? { time, value: c.close } : { time, open: c.open, high: c.high, low: c.low, close: c.close };
}
