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
import { useTrading } from '../state/tradingStore';

export interface ChartGeometry {
  chart: IChartApi;
  series: ISeriesApi<SeriesType>;
  candles: () => Bar[];
  tfSeconds: number;
  paneHeight: () => number;
  paneWidth: () => number;
  /** The chart's own element: clicks and taps that miss every drawing land here. */
  container: HTMLElement;
}

export interface Projector {
  x: (t: number) => number | null;
  y: (p: number) => number | null;
  /** Time of the candle under x: drawn points snap to candles. */
  t: (x: number) => number | null;
  p: (y: number) => number | null;
  /** t moved by the whole number of candles nearest to dx pixels, keeping its place within its candle. */
  shiftT: (t: number, dx: number) => number | null;
}

export function projector(g: ChartGeometry): Projector {
  const candles = g.candles();
  const ts = g.chart.timeScale();
  // lightweight-charts converts whole bar indexes only (it returns 0 for a fractional one), and a
  // point drawn on another timeframe usually falls inside a candle. The time scale is linear in the
  // index, so every position is read off the first two indexes.
  const x0 = candles.length ? ts.logicalToCoordinate(0 as never) : null;
  const x1 = candles.length ? ts.logicalToCoordinate(1 as never) : null;
  const spacing = x0 === null || x1 === null ? 0 : x1 - x0;
  const ready = spacing > 0;
  const toLogical = (t: number): number => {
    const i = lastIndexAtOrBefore(candles, t, (c) => c.time);
    const last = candles.length - 1;
    if (i < 0) return (t - candles[0].time) / g.tfSeconds;
    if (i >= last) return last + (t - candles[last].time) / g.tfSeconds;
    const span = candles[i + 1].time - candles[i].time;
    return i + Math.min(1, (t - candles[i].time) / Math.max(1, Math.min(span, g.tfSeconds)));
  };
  const fromLogical = (l: number): number => {
    const last = candles.length - 1;
    if (l <= 0) return candles[0].time + l * g.tfSeconds;
    if (l >= last) return candles[last].time + (l - last) * g.tfSeconds;
    const i = Math.floor(l);
    return candles[i].time + (l - i) * Math.min(g.tfSeconds, candles[i + 1].time - candles[i].time);
  };
  return {
    x: (t) => (ready ? x0! + toLogical(t) * spacing : null),
    y: (p) => g.series.priceToCoordinate(p),
    t: (x) => (ready ? fromLogical(Math.round((x - x0!) / spacing)) : null),
    p: (y) => g.series.coordinateToPrice(y),
    shiftT: (t, dx) => (ready ? fromLogical(toLogical(t) + Math.round(dx / spacing)) : null),
  };
}

type DragState = { id: string; pointerId: number; pointIndex: number | 'all'; startX: number; startY: number; orig: DrawPoint[] } | null;

type Seg = [number, number, number, number];

/** Left and right ends of a retracement's level lines. */
function fibSpan(ax: number, bx: number): [number, number] {
  const left = Math.min(ax, bx);
  return [left, Math.max(ax, bx, left + 60)];
}

/** The lines a drawing is grabbed by, in pixels: its strokes and outlines, never the inside of a box. */
function segments(d: Drawing, proj: Projector, width: number, height: number): Seg[] {
  const xy = d.points.map((p) => ({ x: proj.x(p.time), y: proj.y(p.price) }));
  const [a, b] = xy;
  if (d.type === 'hline') return a.y === null ? [] : [[0, a.y, width, a.y]];
  if (d.type === 'vline') return a.x === null ? [] : [[a.x, 0, a.x, height]];
  if (d.type === 'sr') return a.y === null || b.y === null ? [] : [[0, a.y, width, a.y], [0, b.y, width, b.y]];
  if (xy.some((p) => p.x === null || p.y === null)) return [];
  const [ax, ay, bx, by] = [a.x!, a.y!, b.x!, b.y!];
  if (d.type === 'trend') return [[ax, ay, bx, by]];
  if (d.type === 'rect') return [[ax, ay, bx, ay], [bx, ay, bx, by], [bx, by, ax, by], [ax, by, ax, ay]];
  const [left, right] = fibSpan(ax, bx);
  const levels = FIB_LEVELS.map((lvl) => proj.y(d.points[1].price - (d.points[1].price - d.points[0].price) * lvl));
  return [[ax, ay, bx, by], ...levels.filter((y) => y !== null).map((y): Seg => [left, y!, right, y!])];
}

function distanceToSegment(px: number, py: number, [x1, y1, x2, y2]: Seg): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const k = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + k * dx), py - (y1 + k * dy));
}

/** The topmost drawing with a line within `tolerance` pixels of (x, y), or null. */
export function hitTest(drawings: Drawing[], proj: Projector, width: number, height: number, x: number, y: number, tolerance: number): string | null {
  let best: string | null = null;
  let bestDistance = tolerance;
  for (const d of drawings) {
    for (const seg of segments(d, proj, width, height)) {
      const dist = distanceToSegment(x, y, seg);
      // Later drawings are painted on top, so they win a tie.
      if (dist <= bestDistance) {
        best = d.id;
        bestDistance = dist;
      }
    }
  }
  return best;
}

/** How far from a line a still click or tap may land and still pick that drawing. */
const TAP_TOLERANCE: Record<string, number> = { touch: 16, pen: 10, mouse: 6 };

const COARSE = '(pointer: coarse)';
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(COARSE).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(COARSE);
    if (!mq) return;
    const sync = () => setCoarse(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return coarse;
}

export function DrawingLayer({ geometry, version }: { geometry: ChartGeometry; version: number }) {
  const { tool, drawings, selectedId, color, add, update, remove, select, setTool, symbol } = useDrawings();
  const [pending, setPending] = useState<DrawPoint[]>([]);
  const [hover, setHover] = useState<DrawPoint | null>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  /** A finger or pen down on a drawing that is not selected: a tap (lifted in place) selects it. */
  const tapRef = useRef<{ id: string; pointerId: number; x: number; y: number } | null>(null);
  /** Whether the current drag has gone past the click threshold. */
  const movedRef = useRef(false);
  const background = useSettings((s) => s.appearance.colors.background);
  const coarse = useCoarsePointer();
  void version;

  const proj = projector(geometry);
  const width = geometry.paneWidth();
  const height = geometry.paneHeight();
  const latest = useRef({ proj, width, height });
  latest.current = { proj, width, height };
  const container = geometry.container;

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

  // A half-placed drawing belongs to the tool and symbol it was started on.
  useEffect(() => {
    setPending([]);
    setHover(null);
  }, [tool, symbol]);

  // A still click or tap on the chart picks the drawing whose line it lands near, or lets go of the
  // selected one. On touch screens drawings that are not selected take no touches at all (see
  // .drawing-layer in styles.css), so pans, pinches and page scrolls work over them and a tap is
  // the way to pick one. Read from pointer events: the chart's own click event skips a second
  // click within half a second, and a tap fires no DOM click.
  useEffect(() => {
    let down: { id: number; x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (down = e.button === 0 && e.isPrimary ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null);
    const onUp = (e: PointerEvent) => {
      const still = down?.id === e.pointerId && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6;
      down = null;
      const rect = svgRef.current?.getBoundingClientRect();
      const s = useDrawings.getState();
      if (!still || !rect || s.tool !== 'select' || useTrading.getState().pickTarget) return;
      const { proj, width, height } = latest.current;
      const id = hitTest(s.drawings, proj, width, height, e.clientX - rect.left, e.clientY - rect.top, TAP_TOLERANCE[e.pointerType] ?? 6);
      if (id !== s.selectedId) s.select(id);
    };
    container.addEventListener('pointerdown', onDown);
    container.addEventListener('pointerup', onUp);
    return () => {
      container.removeEventListener('pointerdown', onDown);
      container.removeEventListener('pointerup', onUp);
    };
  }, [container]);

  const pointFromEvent = (e: React.PointerEvent): DrawPoint | null => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const t = proj.t(x);
    const p = proj.p(y);
    return t === null || p === null ? null : { time: t, price: Math.round(p * 100) / 100 };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // Only the main button or first finger places points: not a right-click, nor the second finger of a pinch.
    if (tool === 'select' || e.button !== 0 || !e.isPrimary) return;
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
      if (e.pointerId !== drag.pointerId) return;
      // Measured from where the press started on screen, so nothing that moves the chart during
      // the press can make the drawing jump; and a press that barely moves only selects.
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!movedRef.current && Math.hypot(dx, dy) < 3) return;
      movedRef.current = true;
      const shift = (p: DrawPoint, whole: boolean): DrawPoint => {
        const px = proj.x(p.time);
        const py = proj.y(p.price);
        if (px === null || py === null) return p;
        // Moving a whole drawing shifts every point by the same number of candles, so its shape
        // holds even on a timeframe it was not drawn on; a handle snaps to the candle under it.
        const t = whole ? proj.shiftT(p.time, dx) : proj.t(px + dx);
        const pr = proj.p(py + dy);
        return t === null || pr === null ? p : { time: t, price: Math.round(pr * 100) / 100 };
      };
      const pts = drag.orig.map((p, i) => (drag.pointIndex === 'all' ? shift(p, true) : drag.pointIndex === i ? shift(p, false) : p));
      update(drag.id, pts);
      return;
    }
    if (tool !== 'select' && pending.length) setHover(pointFromEvent(e));
  };

  const startDrag = (e: React.PointerEvent, d: Drawing, pointIndex: number | 'all') => {
    if (tool !== 'select' || e.button !== 0 || !e.isPrimary || drag) return;
    e.stopPropagation();
    // A finger or pen that lands on a drawing that is not selected (possible where a mouse is the
    // main pointer; on touch screens such drawings take no touches) selects it with a tap and only
    // moves a selected one, so a swipe that starts on it scrolls instead (see .drawing-layer.editing).
    if (e.pointerType !== 'mouse' && d.id !== selectedId) {
      tapRef.current = { id: d.id, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }
    select(d.id);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    movedRef.current = false;
    setDrag({ id: d.id, pointerId: e.pointerId, pointIndex, startX: e.clientX, startY: e.clientY, orig: d.points });
  };

  const endDrag = (e: React.PointerEvent) => {
    const tap = tapRef.current;
    if (tap && tap.pointerId === e.pointerId) {
      tapRef.current = null;
      if (e.type === 'pointerup' && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 10) select(tap.id);
    }
    setDrag((cur) => (cur && cur.pointerId === e.pointerId ? null : cur));
  };

  const preview: Drawing | null =
    tool !== 'select' && pending.length && hover ? { id: 'preview', type: tool as DrawingType, points: [...pending, hover], color } : null;

  return (
    <svg
      ref={svgRef}
      className={`drawing-layer${tool !== 'select' ? ' active' : ''}${selectedId ? ' editing' : ''}`}
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
        <Shape key={d.id} d={d} proj={proj} width={width} height={height} selected={d.id === selectedId} onDragStart={startDrag} background={background} coarse={coarse} />
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
  coarse,
}: {
  /** Touch screen: bigger handles to grab. */
  coarse: boolean;
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
  // Each handle is grabbed by a larger invisible circle: a fingertip needs about 28px.
  const handles = selected
    ? xy.map((p, i) =>
        p.x !== null && p.y !== null ? (
          <g key={`h${i}`}>
            <circle className="handle" cx={p.x} cy={p.y} r={5} fill={background} stroke={d.color} strokeWidth={2} />
            <circle className="handle-hit" cx={p.x} cy={p.y} r={coarse ? 14 : 7} onPointerDown={(e) => onDragStart(e, d, i)} />
          </g>
        ) : null,
      )
    : null;
  const g = `drawing${selected ? ' selected' : ''}`;
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
        <g className={g}>
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...common} />
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="hit" onPointerDown={(e) => onDragStart(e, d, 'all')} />
          {handles}
        </g>
      );
    }
    case 'hline': {
      const y = xy[0].y!;
      return (
        <g className={g}>
          <line x1={0} x2={width} y1={y} y2={y} {...common} />
          <line x1={0} x2={width} y1={y} y2={y} className="hit" onPointerDown={(e) => onDragStart(e, d, 'all')} />
          {label(4, y - 4, fmtPrice(d.points[0].price))}
        </g>
      );
    }
    case 'vline': {
      const x = xy[0].x!;
      return (
        <g className={g}>
          <line x1={x} x2={x} y1={0} y2={height} {...common} />
          <line x1={x} x2={x} y1={0} y2={height} className="hit" onPointerDown={(e) => onDragStart(e, d, 'all')} />
        </g>
      );
    }
    case 'rect': {
      const [a, b] = xy as { x: number; y: number }[];
      const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
      return (
        <g className={g}>
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
        <g className={g}>
          <rect {...band} {...fill} fill={`${d.color}26`} strokeDasharray="4 3" />
          <rect {...band} className="hit" fill="none" onPointerDown={(e) => onDragStart(e, d, 'all')} />
          {label(4, Math.min(y1, y2) - 4, `S/R zone ${fmtPrice(lo)} – ${fmtPrice(hi)}`)}
        </g>
      );
    }
    case 'fib': {
      const [a, b] = xy as { x: number; y: number }[];
      const [p0, p1] = [d.points[0].price, d.points[1].price];
      const [left, right] = fibSpan(a.x, b.x);
      return (
        <g className={g}>
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={d.color} strokeDasharray="3 3" strokeWidth={1} className="shape" onPointerDown={(e) => onDragStart(e, d, 'all')} />
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="hit" onPointerDown={(e) => onDragStart(e, d, 'all')} />
          {FIB_LEVELS.map((lvl) => {
            const pr = p1 - (p1 - p0) * lvl;
            const y = proj.y(pr);
            if (y === null) return null;
            return (
              <g key={lvl}>
                <line x1={left} x2={right} y1={y} y2={y} stroke={d.color} strokeWidth={lvl === 0.5 || lvl === 0.618 ? 1.25 : 0.75} opacity={0.9} />
                {/* Levels are grabbable only once selected: until then the crosshair, legend and
                    wheel zoom keep working where prices are read. */}
                {selected && <line x1={left} x2={right} y1={y} y2={y} className="hit" onPointerDown={(e) => onDragStart(e, d, 'all')} />}
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
