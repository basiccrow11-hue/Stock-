/** Small line/area chart for equity curves and drawdowns (lightweight-charts). */
import { useEffect, useRef } from 'react';
import { AreaSeries, ColorType, createChart, LineSeries, TickMarkType, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp } from 'lightweight-charts';
import { toChartTime } from './ChartView';
import { exchangeOffsetSeconds } from '../../core/time';
import { CHART_LOCALE } from '../services/format';

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
  // Recreate the chart only when the set of lines or the formatting changes, not on every data update.
  const shape = lines.map((l) => `${l.name}|${l.color}|${l.area ? 1 : 0}|${l.dashed ? 1 : 0}`).join(';');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8b97a8', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: '#1a2130' }, horzLines: { color: '#1a2130' } },
      rightPriceScale: { borderColor: '#1f2633' },
      timeScale: {
        borderColor: '#1f2633',
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
      handleScroll: true,
      handleScale: true,
    });
    chartRef.current = chart;
    fittedRef.current = false;
    seriesRef.current = shape.split(';').map((_, k) => {
      const l = linesRef.current[k];
      return l.area
        ? chart.addSeries(AreaSeries, { lineColor: l.color, topColor: `${l.color}55`, bottomColor: `${l.color}05`, lineWidth: 2, title: l.name })
        : chart.addSeries(LineSeries, { color: l.color, lineWidth: 2, lineStyle: l.dashed ? 2 : 0, title: l.name });
    });
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = [];
    };
  }, [shape, format, hideDates, hasXLabel]);


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
