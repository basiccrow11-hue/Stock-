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
import { withAlpha } from '../theme/color';
import type { ChartPalette, ChartStyle, PanelChartPalette, PriceScaleKind } from '../theme/themes';

export type MainSeries = ISeriesApi<SeriesType>;

export function chartOptions(p: ChartPalette): DeepPartial<ChartOptions> {
  return {
    layout: {
      background: { type: ColorType.Solid, color: p.background },
      textColor: p.text,
      fontSize: p.fontSize,
      panes: { separatorColor: p.scaleBorder, separatorHoverColor: withAlpha(p.text, 0.25) },
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

export function priceScaleMode(k: PriceScaleKind): PriceScaleMode {
  return k === 'log' ? PriceScaleMode.Logarithmic : k === 'percent' ? PriceScaleMode.Percentage : PriceScaleMode.Normal;
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

/** Style-specific options for the main price series; safe to apply to a series of that style. */
export function mainSeriesOptions(p: ChartPalette): Record<string, unknown> {
  const common = { priceLineVisible: p.lastPriceLine, lastValueVisible: true };
  switch (p.style) {
    case 'candles':
      return { ...common, ...candleOptions(p) };
    case 'hollow':
      return { ...common, ...candleOptions(p, true) };
    case 'bars':
      return { ...common, upColor: p.up, downColor: p.down, openVisible: true, thinBars: false };
    case 'line':
      return { ...common, color: p.line, lineWidth: 2 };
    case 'area':
      return { ...common, lineColor: p.line, topColor: p.areaTop, bottomColor: p.areaBottom, lineWidth: 2 };
  }
}

export function addMainSeries(chart: IChartApi, p: ChartPalette): MainSeries {
  const opts = mainSeriesOptions(p);
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
