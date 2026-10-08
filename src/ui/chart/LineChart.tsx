/** Small line/area chart for equity curves and drawdowns (lightweight-charts). */
import { useEffect, useRef } from 'react';
import { AreaSeries, createChart, LineSeries, PriceLineSource, TickMarkType, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp } from 'lightweight-charts';
import { toChartTime } from './ChartView';
import { exchangeOffsetSeconds } from '../../core/time';
import { CHART_LOCALE } from '../services/format';
import { useTheme } from '../theme/useTheme';
import { chartLabelFill, withAlpha } from '../theme/color';
import { panelChartOptions } from './chartTheme';

export interface LineSpec {
  name: string;
  color: string;
  points: { time: number; value: number }[];
  area?: boolean;
  dashed?: boolean;
}

function unshift(shifted: number): number {
  return shifted - exchangeOffsetSeconds(shifted);
}

function hm(shifted: number): string {
  const d = new Date(shifted * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** lightweight-charts needs strictly increasing times; keep the last value per timestamp. */
function clean(points: { time: number; value: number }[]): { time: UTCTimestamp; value: number }[] {
  const sorted = points.filter((p) => Number.isFinite(p.value)).sort((a, b) => a.time - b.time);
  const out: { time: UTCTimestamp; value: number }[] = [];
  for (const p of sorted) {
    const t = toChartTime(p.time);
    if (out.length && out[out.length - 1].time === t) out[out.length - 1].value = p.value;
    else if (!out.length || t > out[out.length - 1].time) out.push({ time: t, value: p.value });
  }
  // Keep the chart readable and fully visible: at most ~1500 points, always keeping the last one.
  const MAX = 1500;
  if (out.length <= MAX) return out;
  const stride = Math.ceil(out.length / MAX);
  const thin = out.filter((_, i) => i % stride === 0);
  if (thin[thin.length - 1] !== out[out.length - 1]) thin.push(out[out.length - 1]);
  return thin;
}

export function LineChart({
  lines,
  height = 260,
  format,
  hideDates,
  xLabel,
}: {
  lines: LineSpec[];
  height?: number;
  format?: (v: number) => string;
  hideDates?: boolean;
  /** Custom x-axis label from the original (unshifted) point time, e.g. a trade number. */
  xLabel?: (t: number) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area' | 'Line'>[]>([]);
  const fittedRef = useRef(false);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const xLabelRef = useRef(xLabel);
  xLabelRef.current = xLabel;
  const hasXLabel = !!xLabel;
  const panel = useTheme().panel;
  const panelRef = useRef(panel);
  panelRef.current = panel;
  // Recreate the chart only when the set of lines or the formatting changes, not on every data update.
  const shape = lines.map((l) => `${l.name}|${l.color}|${l.area ? 1 : 0}|${l.dashed ? 1 : 0}`).join(';');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const themed = panelChartOptions(panelRef.current);
    const chart = createChart(el, {
      ...themed,
      autoSize: true,
      layout: { ...themed.layout, fontSize: 11, attributionLogo: false },
      timeScale: {
        ...themed.timeScale,
        timeVisible: true,
        tickMarkFormatter: xLabelRef.current
          ? (t: Time) => xLabelRef.current!(unshift(t as number))
          : // Blind sessions: show clock times only, never calendar dates.
            hideDates
            ? (t: Time, type: TickMarkType) => (type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds ? hm(t as number) : '')
            : undefined,
      },
      localization: {
        locale: CHART_LOCALE,
        ...(format && { priceFormatter: format }),
        ...(xLabelRef.current ? { timeFormatter: (t: Time) => xLabelRef.current!(unshift(t as number)) } : hideDates ? { timeFormatter: (t: Time) => hm(t as number) } : {}),
      },
      // On a scrolling page a vertical swipe scrolls the page.
      handleScroll: { vertTouchDrag: false },
      handleScale: true,
    });
    chartRef.current = chart;
    fittedRef.current = false;
    seriesRef.current = shape.split(';').map((_, k) => {
      const l = linesRef.current[k];
      // The value label (and its title) is filled with priceLineColor: adjusted so its text stays
      // readable. The line marks the same point as the label: the last one on screen.
      const label = { title: l.name, priceLineColor: chartLabelFill(l.color), priceLineSource: PriceLineSource.LastVisible };
      return l.area
        ? chart.addSeries(AreaSeries, { lineColor: l.color, topColor: withAlpha(l.color, 0.33), bottomColor: withAlpha(l.color, 0.02), lineWidth: 2, ...label })
        : chart.addSeries(LineSeries, { color: l.color, lineWidth: 2, lineStyle: l.dashed ? 2 : 0, ...label });
    });
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = [];
    };
  }, [shape, format, hideDates, hasXLabel]);


  // Theme changes restyle the existing chart in place.
  useEffect(() => {
    chartRef.current?.applyOptions(panelChartOptions(panel));
  }, [panel, shape, format, hideDates, hasXLabel]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    lines.forEach((l, k) => seriesRef.current[k]?.setData(clean(l.points)));
    if (!fittedRef.current && lines.some((l) => l.points.length > 1)) {
      chart.timeScale().fitContent();
      fittedRef.current = true;
    }
  }, [lines, shape, format, hideDates]);

  return <div ref={ref} style={{ height, position: 'relative' }} />;
}
