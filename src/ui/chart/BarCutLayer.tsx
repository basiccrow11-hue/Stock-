/**
 * Bar Replay's select-bar mode on the chart, as in TradingView: a line follows the pointer from candle to
 * candle, everything right of it is shaded (what the replay will hide), and a click on a candle starts a
 * replay with that candle the newest one shown (startBarReplay). On a touch screen a tap puts the line on
 * a candle and a second tap on it starts there, so a finger can check what it picked first. Dragging still
 * pans and zooms the chart. Escape, or anything that ends select-bar mode in the store, cancels.
 *
 * The line, the shade and the hint are moved directly, so following the pointer never re-renders the chart.
 */
import { useEffect, useRef } from 'react';
import type { Logical } from 'lightweight-charts';
import { lastIndexAtOrBefore } from '../../core/util/math';
import type { UnixSeconds } from '../../core/types';
import type { ChartGeometry } from './DrawingLayer';
import { cutWarning, newestBarRefusal, sessionEndNotice, setSelectingBar, startBarReplay, useTrading, type CutNote } from '../state/tradingStore';
import { modalOpen } from '../components/common';

/** A press that moves further than this (pixels) is a drag, which pans the chart, not a click. */
const CLICK_SLOP = 6;
/** How long a refusal (the newest bar, or one nothing follows) stays in the hint after a click on it (milliseconds). */
const REFUSAL_MS = 4000;

const HINT = {
  mouse: 'Click a bar to start the replay there · Esc to cancel',
  touch: 'Tap a bar, then tap it again to start the replay there',
  armed: 'Tap this bar again to start the replay there · Esc to cancel',
  // A phone has no Escape key: Replay pressed again stops.
  armedTouch: 'Tap this bar again to start the replay there',
  // After a warning about the bar (cutWarning), which a second tap still starts at.
  armedAnyway: 'Tap it again to start there anyway.',
};

/**
 * Whether a press on the chart only closes something open over it: a toolbar menu or popover (usePopover
 * closes it on the window's pointerdown, which comes after the chart's own) or a dialog. It picks no bar.
 */
const closesSomething = () => modalOpen() || !!document.querySelector('.popover');

export function BarCutLayer({ geometry, version }: { geometry: ChartGeometry; version: number }) {
  const shadeRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  /** Where the mouse rests on the chart (container coordinates), or null. */
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  /** The candle a first tap picked (its start time), waiting for a second tap. */
  const armedRef = useRef<UnixSeconds | null>(null);
  const refusedUntil = useRef(0);
  /** What cutWarning said of the candle last asked about (by its start), so a pointer resting on it asks once. */
  const warnedRef = useRef<{ time: UnixSeconds; note: CutNote | null } | null>(null);
  const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

  /**
   * Where the chart puts its candles: the x of the middle of the oldest one it was handed (logical index 0)
   * and the distance between two. Whole indexes convert exactly, and the time scale is linear in them (see
   * DrawingLayer's projector). Null while it shows none.
   */
  const scale = (): { x0: number; spacing: number; first: number; count: number } | null => {
    const g = geometryRef.current;
    const count = g.candles().length;
    const first = g.firstIndex?.() ?? 0;
    const ts = g.chart.timeScale();
    const x0 = ts.logicalToCoordinate(0 as Logical);
    const x1 = ts.logicalToCoordinate(1 as Logical);
    if (count <= first || x0 === null || x1 === null || x1 <= x0) return null;
    return { x0, spacing: x1 - x0, first, count };
  };

  /** The chart's candle at container x (the nearest it shows), with the x of its middle. */
  const candleAt = (x: number): { index: number; x: number } | null => {
    const s = scale();
    if (!s) return null;
    const index = Math.max(s.first, Math.min(s.count - 1, s.first + Math.round((x - s.x0) / s.spacing)));
    return { index, x: s.x0 + (index - s.first) * s.spacing };
  };

  /** The candle at `index`, with the x of its middle. */
  const candleAtIndex = (index: number): { index: number; x: number } | null => {
    const s = scale();
    return s && index >= s.first ? { index, x: s.x0 + (index - s.first) * s.spacing } : null;
  };

  /** Whether the candle at `index` is the newest of the data, which nothing follows (only known with no session). */
  const isNewest = (index: number) => !useTrading.getState().session && index === geometryRef.current.candles().length - 1;

  /** What select-bar mode says of the candle starting at `time` (cutWarning), asked once while it stays the one asked about. */
  const noteOn = (time: UnixSeconds): CutNote | null => {
    if (warnedRef.current?.time !== time) warnedRef.current = { time, note: cutWarning(time) };
    return warnedRef.current.note;
  };

  /** Puts the line and the shade on the candle under the mouse, or the one a tap picked, and says what a click does there. */
  const place = () => {
    const g = geometryRef.current;
    const shade = shadeRef.current;
    const line = lineRef.current;
    const hint = hintRef.current;
    if (!shade || !line || !hint) return;
    const candles = g.candles();
    const armed = armedRef.current;
    let at: { index: number; x: number } | null = null;
    if (armed !== null) {
      const i = lastIndexAtOrBefore(candles, armed, (c) => c.time);
      if (i >= 0 && candles[i].time === armed) at = candleAtIndex(i);
    } else if (pointerRef.current) at = candleAt(pointerRef.current.x);
    const width = g.paneWidth();
    const height = plotHeight(g);
    if (!at || at.x < 0 || at.x > width) {
      line.style.display = 'none';
      shade.style.display = 'none';
    } else {
      const from = Math.min(width, at.x + (scale()?.spacing ?? 0) / 2);
      line.style.display = '';
      line.style.left = `${at.x}px`;
      line.style.height = `${height}px`;
      shade.style.display = from < width ? '' : 'none';
      shade.style.left = `${from}px`;
      shade.style.width = `${Math.max(0, width - from)}px`;
      shade.style.height = `${height}px`;
    }
    const newest = !!at && isNewest(at.index);
    // Said of a candle before it is picked (cutWarning): that nothing follows it before the replay would end,
    // which refuses it as the newest is refused, or that only after-hours trading would follow it.
    const note = at && !newest && (armed !== null || !coarse) ? noteOn(candles[at.index].time) : null;
    line.classList.toggle('refused', newest || !!note?.refused);
    const refusal = (newest && (armed !== null || performance.now() < refusedUntil.current || !coarse)) || !!note?.refused;
    const warning = note && !note.refused ? note.text : null;
    const text = refusal ? (newest ? newestBarRefusal() : note!.text) : warning ? (armed !== null ? `${warning} ${HINT.armedAnyway}` : warning) : armed !== null ? (coarse ? HINT.armedTouch : HINT.armed) : coarse ? HINT.touch : HINT.mouse;
    if (hint.textContent !== text) hint.textContent = text;
    hint.classList.toggle('refused', refusal);
    hint.classList.toggle('warned', !refusal && !!warning);
  };

  // The chart moved (a scroll, a zoom, a resize, new candles): the line stays on its candle.
  useEffect(place);

  useEffect(() => {
    const el = geometry.container;
    let frame = 0;
    let down: { id: number; x: number; y: number } | null = null;
    const local = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const inPlot = (p: { x: number; y: number }) => p.x >= 0 && p.x <= geometryRef.current.paneWidth() && p.y >= 0 && p.y <= plotHeight(geometryRef.current);
    const placeSoon = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), place()));
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const p = local(e);
      pointerRef.current = inPlot(p) ? p : null;
      placeSoon();
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      pointerRef.current = null;
      placeSoon();
    };
    const onDown = (e: PointerEvent) => {
      // A press that only closes a menu or a dialog neither starts a replay nor picks a bar with a finger.
      down = e.button === 0 && e.isPrimary && !closesSomething() ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
    };
    const onUp = (e: PointerEvent) => {
      const still = down?.id === e.pointerId && Math.hypot(e.clientX - down.x, e.clientY - down.y) < CLICK_SLOP;
      down = null;
      const p = local(e);
      if (!still || !inPlot(p)) return;
      const at = candleAt(p.x);
      if (!at) return;
      const candle = geometryRef.current.candles()[at.index];
      // A finger first picks the candle, and starts there with a second tap on it.
      if (e.pointerType !== 'mouse' && armedRef.current !== candle.time) {
        armedRef.current = candle.time;
        place();
        return;
      }
      // The newest candle, or one nothing follows before the replay would end: it says why, and does not start.
      if (isNewest(at.index) || noteOn(candle.time)?.refused) {
        refusedUntil.current = performance.now() + REFUSAL_MS;
        place();
        return;
      }
      const notice = sessionEndNotice();
      if (notice && !window.confirm(notice)) return;
      void startBarReplay(candle.time);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
    };
    // place and candleAt read refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry.container]);

  useEffect(() => {
    // Only an Escape that closed a dialog or a menu is left alone.
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !modalOpen() && !e.defaultPrevented && setSelectingBar(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <div className="bar-cut" aria-hidden="true" data-version={version}>
        <div ref={shadeRef} className="bar-cut-shade" style={{ display: 'none' }} />
        <div ref={lineRef} className="bar-cut-line" style={{ display: 'none' }} />
      </div>
      <div ref={hintRef} className="bar-cut-hint" role="status">
        {coarse ? HINT.touch : HINT.mouse}
      </div>
    </>
  );
}

/** The height of the chart's panes, above its time axis. */
function plotHeight(g: ChartGeometry): number {
  return Math.max(0, g.container.clientHeight - (g.chart.timeScale().height?.() ?? 0));
}

