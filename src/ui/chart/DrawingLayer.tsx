/**
 * SVG overlay for chart drawings. Drawings are stored in (time, price) space and projected through
 * the chart's own coordinate converters, so they stay anchored while panning, zooming, and as new
 * candles are revealed. Points to the right of the last candle are extrapolated by bar spacing,
 * which reveals nothing about future prices.
 */
import { useEffect, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';
import type { Bar } from '../../core/types';
import { lastIndexAtOrBefore } from '../../core/util/math';
import { FIB_LEVELS, POINTS_NEEDED, useDrawings, type DrawPoint, type Drawing, type DrawingType } from './drawings';
import { newId } from '../../core/util/ids';
import { price as fmtPrice } from '../services/format';
import { useSettings } from '../state/settingsStore';
import { keyBelongsElsewhere } from '../components/common';
import { readable } from '../theme/color';

export interface ChartGeometry {
  chart: IChartApi;
  series: ISeriesApi<SeriesType>;
  candles: () => Bar[];
  tfSeconds: number;
  paneHeight: () => number;
  paneWidth: () => number;
}

interface Projector {
  x: (t: number) => number | null;
  y: (p: number) => number | null;
  t: (x: number) => number | null;
  p: (y: number) => number | null;
}

function projector(g: ChartGeometry): Projector {
  const candles = g.candles();
  const ts = g.chart.timeScale();
  const toLogical = (t: number): number | null => {
    if (!candles.length) return null;
    const i = lastIndexAtOrBefore(candles, t, (c) => c.time);
    const last = candles.length - 1;
    if (i < 0) return (t - candles[0].time) / g.tfSeconds;
    if (i >= last) return last + (t - candles[last].time) / g.tfSeconds;
    const span = candles[i + 1].time - candles[i].time;
    return i + Math.min(1, (t - candles[i].time) / Math.max(1, Math.min(span, g.tfSeconds)));
  };
  return {
    x: (t) => {
      const l = toLogical(t);
      return l === null ? null : ts.logicalToCoordinate(l as never);
    },
    y: (p) => g.series.priceToCoordinate(p),
    t: (x) => {
      const l = ts.coordinateToLogical(x);
      if (l === null || !candles.length) return null;
      const last = candles.length - 1;
      if (l <= 0) return candles[0].time + l * g.tfSeconds;
      if (l >= last) return candles[last].time + (l - last) * g.tfSeconds;
      const i = Math.floor(l);
      return candles[i].time + (l - i) * Math.min(g.tfSeconds, candles[i + 1].time - candles[i].time);
    },
    p: (y) => g.series.coordinateToPrice(y),
  };
}

type DragState = { id: string; pointIndex: number | 'all'; startX: number; startY: number; orig: DrawPoint[] } | null;

export function DrawingLayer({ geometry, version }: { geometry: ChartGeometry; version: number }) {
  const { tool, drawings, selectedId, color, add, update, remove, select, setTool } = useDrawings();
  const [pending, setPending] = useState<DrawPoint[]>([]);
  const [hover, setHover] = useState<DrawPoint | null>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const background = useSettings((s) => s.appearance.colors.background);
  void version;

  const proj = projector(geometry);
  const width = geometry.paneWidth();
  const height = geometry.paneHeight();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never delete a drawing hidden behind a dialog, or reset the tool with the Escape that closed one.
      if (keyBelongsElsewhere(e)) return;
      // The terminal stays mounted on other pages; a drawing that is not on screen is never deleted.
      if (!svgRef.current?.getClientRects().length) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        remove(selectedId);
        e.preventDefault();
      }
      if (e.key === 'Escape') {
        setPending([]);
        select(null);
        if (tool !== 'select') setTool('select');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, remove, select, setTool, tool]);

  useEffect(() => setPending([]), [tool]);

  const pointFromEvent = (e: React.PointerEvent): DrawPoint | null => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const t = proj.t(x);
    const p = proj.p(y);
    return t === null || p === null ? null : { time: t, price: Math.round(p * 100) / 100 };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (tool === 'select') return;
    const pt = pointFromEvent(e);
    if (!pt) return;
    const needed = POINTS_NEEDED[tool as DrawingType];
    const pts = [...pending, pt];
    if (pts.length >= needed) {
      // Back to the select tool first (it clears the selection), then add: a new drawing starts
      // selected, so it can be adjusted or deleted straight away.
      setTool('select');
      add({ id: newId('d'), type: tool as DrawingType, points: pts, color });
      setPending([]);
    } else setPending(pts);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag) {
      const rect = svgRef.current!.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      const shift = (p: DrawPoint, ox: number, oy: number): DrawPoint => {
        const px = proj.x(p.time);
        const py = proj.y(p.price);
        if (px === null || py === null) return p;
        const t = proj.t(px + (dx - ox));
        const pr = proj.p(py + (dy - oy));
        return t === null || pr === null ? p : { time: t, price: Math.round(pr * 100) / 100 };
      };
      const pts = drag.orig.map((p, i) => (drag.pointIndex === 'all' || drag.pointIndex === i ? shift(p, drag.startX, drag.startY) : p));
      update(drag.id, pts);
      return;
    }
    if (tool !== 'select' && pending.length) setHover(pointFromEvent(e));
  };

  const startDrag = (e: React.PointerEvent, d: Drawing, pointIndex: number | 'all') => {
    if (tool !== 'select' || e.button !== 0) return;
    e.stopPropagation();
    select(d.id);
    const rect = svgRef.current!.getBoundingClientRect();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ id: d.id, pointIndex, startX: e.clientX - rect.left, startY: e.clientY - rect.top, orig: d.points });
  };

  const endDrag = () => setDrag(null);

  const preview: Drawing | null =
    tool !== 'select' && pending.length && hover ? { id: 'preview', type: tool as DrawingType, points: [...pending, hover], color } : null;

  return (
    <svg
      ref={svgRef}
      className={`drawing-layer${tool !== 'select' ? ' active' : ''}`}
      width={width}
      height={height}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      // A drag the browser takes over (a touch turned into a scroll) or loses must end too, or the
      // next hover would carry on moving the drawing.
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onPointerLeave={() => setHover(null)}
    >
      {[...drawings, ...(preview ? [preview] : [])].map((d) => (
        <Shape key={d.id} d={d} proj={proj} width={width} height={height} selected={d.id === selectedId} onDragStart={startDrag} background={background} />
      ))}
      {pending.map((p, i) => {
        const x = proj.x(p.time);
        const y = proj.y(p.price);
        return x === null || y === null ? null : <circle key={i} cx={x} cy={y} r={4} fill={color} />;
      })}
    </svg>
  );
}

function Shape({
  d,
  proj,
  width,
  height,
  selected,
  onDragStart,
  background,
}: {
  /** Chart background: handle fill, and what label text must stay readable on. */
  background: string;
  d: Drawing;
  proj: Projector;
  width: number;
  height: number;
  selected: boolean;
  onDragStart: (e: React.PointerEvent, d: Drawing, idx: number | 'all') => void;
}) {
  const xy = d.points.map((p) => ({ x: proj.x(p.time), y: proj.y(p.price) }));
  if (xy.some((p) => p.x === null || p.y === null)) {
    // Horizontal tools only need a price, vertical only a time.
    if (!((d.type === 'hline' || d.type === 'sr') && xy.every((p) => p.y !== null)) && !(d.type === 'vline' && xy[0].x !== null)) return null;
  }
  const sw = selected ? 2 : 1.25;
  const common = { stroke: d.color, strokeWidth: sw, fill: 'none', className: 'shape', onPointerDown: (e: React.PointerEvent) => onDragStart(e, d, 'all') };
  // Filled shapes are grabbed by their outline only: the inside lets hover, wheel zoom and panning
  // reach the chart, so the crosshair and legend keep working over a box or zone.
  const fill = { stroke: d.color, strokeWidth: sw, className: 'shape-fill' };
  const handles = selected
    ? xy.map((p, i) =>
        p.x !== null && p.y !== null ? <circle key={`h${i}`} className="handle" cx={p.x} cy={p.y} r={5} fill={background} stroke={d.color} strokeWidth={2} onPointerDown={(e) => onDragStart(e, d, i)} /> : null,
      )
    : null;
  // Lines keep the picked colour (3:1 is enough for a line); small label text needs 4.5:1.
  const textColor = readable(d.color, background, 4.5);
  const label = (x: number, y: number, text: string) => (
    <text x={x} y={y} fill={textColor} fontSize={10} className="shape-label">
      {text}
    </text>
  );

  switch (d.type) {
    case 'trend': {
      const [a, b] = xy as { x: number; y: number }[];
      return (
        <g>
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...common} />
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="hit" onPointerDown={(e) => onDragStart(e, d, 'all')} />
          {handles}
        </g>
      );
    }
    case 'hline': {
      const y = xy[0].y!;
      return (
        <g>
          <line x1={0} x2={width} y1={y} y2={y} {...common} />
          <line x1={0} x2={width} y1={y} y2={y} className="hit" onPointerDown={(e) => onDragStart(e, d, 'all')} />
          {label(4, y - 4, fmtPrice(d.points[0].price))}
        </g>
      );
    }
    case 'vline': {
      const x = xy[0].x!;
      return (
        <g>
          <line x1={x} x2={x} y1={0} y2={height} {...common} />
          <line x1={x} x2={x} y1={0} y2={height} className="hit" onPointerDown={(e) => onDragStart(e, d, 'all')} />
        </g>
      );
    }
    case 'rect': {
      const [a, b] = xy as { x: number; y: number }[];
      const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
      return (
        <g>
          <rect {...box} {...fill} fill={`${d.color}22`} />
          <rect {...box} className="hit" fill="none" onPointerDown={(e) => onDragStart(e, d, 'all')} />
          {handles}
        </g>
      );
    }
    case 'sr': {
      const y1 = xy[0].y!;
      const y2 = xy[1].y!;
      const [lo, hi] = [Math.min(d.points[0].price, d.points[1].price), Math.max(d.points[0].price, d.points[1].price)];
      const band = { x: 0, y: Math.min(y1, y2), width, height: Math.max(2, Math.abs(y2 - y1)) };
      return (
        <g>
          <rect {...band} {...fill} fill={`${d.color}26`} strokeDasharray="4 3" />
          <rect {...band} className="hit" fill="none" onPointerDown={(e) => onDragStart(e, d, 'all')} />
          {label(4, Math.min(y1, y2) - 4, `S/R zone ${fmtPrice(lo)} – ${fmtPrice(hi)}`)}
        </g>
      );
    }
    case 'fib': {
      const [a, b] = xy as { x: number; y: number }[];
      const [p0, p1] = [d.points[0].price, d.points[1].price];
      const left = Math.min(a.x, b.x);
      const right = Math.max(a.x, b.x, left + 60);
      return (
        <g>
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={d.color} strokeDasharray="3 3" strokeWidth={1} className="shape" onPointerDown={(e) => onDragStart(e, d, 'all')} />
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="hit" onPointerDown={(e) => onDragStart(e, d, 'all')} />
          {FIB_LEVELS.map((lvl) => {
            const pr = p1 - (p1 - p0) * lvl;
            const y = proj.y(pr);
            if (y === null) return null;
            return (
              <g key={lvl}>
                <line x1={left} x2={right} y1={y} y2={y} stroke={d.color} strokeWidth={lvl === 0.5 || lvl === 0.618 ? 1.25 : 0.75} opacity={0.9} />
                <line x1={left} x2={right} y1={y} y2={y} className="hit" onPointerDown={(e) => onDragStart(e, d, 'all')} />
                {label(right + 4, y + 3, `${(lvl * 100).toFixed(1)}%  ${fmtPrice(pr)}`)}
              </g>
            );
          })}
          {handles}
        </g>
      );
    }
  }
}
