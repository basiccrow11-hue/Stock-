/**
 * The bottom panel's height and whether it is collapsed, remembered per browser. Until the user
 * collapses or expands it, it follows the window: collapsed on short screens (a laptop), where the
 * chart needs the room, and open on taller ones. Storage that is blocked or full only means the
 * choice lasts until the page is reloaded.
 */
import { useCallback, useState, useSyncExternalStore } from 'react';

export const DOCK_KEY = 'stock-replay-bottom-panel';
/**
 * The smallest height it can be dragged to: its tabs and about two rows of a table (a table's header
 * row on a touch screen, where the resize edge above the tabs is taller).
 */
export const DOCK_MIN = 96;
/**
 * What the chart column keeps when the panel is dragged up: the top bar, the chart's toolbar and
 * replay controls, and about 200px of chart (the same limit as .area-bottom in styles.css).
 */
const CHART_KEEPS = 340;
/**
 * Windows shorter than this start with the panel collapsed. It is where styles.css's default height,
 * clamp(140px, 100vh - 610px, 250px), reaches its 140px floor: below it the panel would take room
 * the chart needs (a 1366x768 laptop's window is about 657px tall).
 */
export const SHORT_SCREEN = '(max-height: 749px)';
/** The one-column layout of phones and small tablets (styles.css, and STACKED_LAYOUT in ChartView): the page scrolls there. */
export const STACKED = '(max-width: 820px), (max-width: 1180px) and (max-height: 640px), (max-height: 560px)';

interface DockPrefs {
  /** Height in px, once the user has resized the panel. */
  height?: number;
  /** Set once the user has collapsed or expanded it. */
  collapsed?: boolean;
}

/** The stored choices, ignoring anything malformed (an older version's or a hand-edited value). */
export function readDock(): DockPrefs {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(DOCK_KEY) ?? '{}');
    if (!v || typeof v !== 'object') return {};
    const { height, collapsed } = v as Record<string, unknown>;
    return {
      ...(typeof height === 'number' && Number.isFinite(height) && height > 0 ? { height } : {}),
      ...(typeof collapsed === 'boolean' ? { collapsed } : {}),
    };
  } catch {
    return {};
  }
}

function writeDock(p: DockPrefs): void {
  try {
    localStorage.setItem(DOCK_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked or full: the choice still applies until the page is reloaded */
  }
}

/** Whether a media query matches, kept up to date. False where matchMedia is missing (tests). */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );
}

/** The tallest the panel may be in the current window, as styles.css caps it. */
export function dockMax(): number {
  return Math.max(DOCK_MIN, window.innerHeight - CHART_KEEPS);
}

export function useBottomDock() {
  const [prefs, setPrefs] = useState<DockPrefs>(readDock);
  const short = useMedia(SHORT_SCREEN);
  const stacked = useMedia(STACKED);
  const collapsed = prefs.collapsed ?? (short && !stacked);
  const update = useCallback((change: DockPrefs) => {
    setPrefs((p) => {
      const next = { ...p, ...change };
      writeDock(next);
      return next;
    });
  }, []);
  return {
    collapsed,
    /** The height the user chose, if any (otherwise styles.css sizes the panel to the window). */
    height: prefs.height,
    /** In the one-column layout the panel has a fixed height and the page scrolls, so it is not resized. */
    resizable: !stacked,
    setCollapsed: (c: boolean) => update({ collapsed: c }),
    setHeight: (h: number) => update({ height: Math.round(Math.min(dockMax(), Math.max(DOCK_MIN, h))) }),
  };
}
