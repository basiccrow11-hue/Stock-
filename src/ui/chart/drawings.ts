/** Chart drawing model + per-symbol persistence (localStorage). Points are stored in real time/price. */
import { create } from 'zustand';
import { isCalendarTime } from '../../core/time';
import { isHex } from '../theme/color';

export type DrawingTool = 'select' | 'trend' | 'hline' | 'vline' | 'rect' | 'sr' | 'fib';
export type DrawingType = Exclude<DrawingTool, 'select'>;

export interface DrawPoint {
  time: number;
  price: number;
}

export interface Drawing {
  id: string;
  type: DrawingType;
  points: DrawPoint[];
  color: string;
}

export const TOOL_LABELS: Record<DrawingTool, string> = {
  select: 'Select / move',
  trend: 'Trendline',
  hline: 'Horizontal line',
  vline: 'Vertical line',
  rect: 'Rectangle',
  sr: 'Support / resistance zone',
  fib: 'Fibonacci retracement',
};

export const POINTS_NEEDED: Record<DrawingType, number> = { trend: 2, hline: 1, vline: 1, rect: 2, sr: 2, fib: 2 };
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
/** The colour new drawings start with. */
export const DEFAULT_DRAWING_COLOR = '#4f8cff';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * `v` as a drawing the chart can draw (one saved here, or read from a backup file), or null when it is
 * not one: a known kind with its number of points, each a time the calendar has and a price. A colour
 * that is not a hex colour (a hand-edited file's 'red', say) is replaced by the default.
 */
export function readDrawing(v: unknown): Drawing | null {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.type !== 'string' || !Object.hasOwn(POINTS_NEEDED, v.type) || !Array.isArray(v.points)) return null;
  if (v.points.length !== POINTS_NEEDED[v.type as DrawingType] || !v.points.every((p) => isObj(p) && isCalendarTime(p.time) && typeof p.price === 'number' && Number.isFinite(p.price))) return null;
  const d = v as unknown as Drawing;
  return isHex(d.color) ? d : { ...d, color: DEFAULT_DRAWING_COLOR };
}

const key = (symbol: string) => `stock-replay-drawings:${symbol}`;

function load(symbol: string): Drawing[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(key(symbol)) ?? '[]');
    // Only drawings the chart can draw: one restored from a hand-edited file before files were checked
    // so is left out, or drawn in the default colour.
    return Array.isArray(list) ? list.map(readDrawing).filter((d) => d !== null) : [];
  } catch {
    return [];
  }
}

function save(symbol: string, drawings: Drawing[]): void {
  try {
    localStorage.setItem(key(symbol), JSON.stringify(drawings));
  } catch {
    /* storage full or blocked: drawings stay in memory */
  }
}

const PREFIX = key('');

/** Every symbol's saved drawings (for a backup). */
export function allDrawings(): Record<string, Drawing[]> {
  // Collected as entries: `out[symbol] = …` would store nothing for a symbol of "__proto__" (from a restored file).
  const out: [string, Drawing[]][] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX) && k.length > PREFIX.length) {
        const list = load(k.slice(PREFIX.length));
        if (Array.isArray(list) && list.length) out.push([k.slice(PREFIX.length), list]);
      }
    }
  } catch {
    /* storage blocked: nothing saved to back up */
  }
  return Object.fromEntries(out);
}

/** Add a backup's drawings for `symbol` that are not saved already (by id). Returns how many were added. */
export function mergeDrawings(symbol: string, list: Drawing[]): number {
  const have = load(symbol);
  const ids = new Set(have.map((d) => d.id));
  const fresh = list.filter((d) => !ids.has(d.id));
  if (!fresh.length) return 0;
  const next = [...have, ...fresh];
  save(symbol, next);
  if (useDrawings.getState().symbol === symbol) useDrawings.setState({ drawings: next });
  return fresh.length;
}

interface DrawingStore {
  symbol: string;
  tool: DrawingTool;
  color: string;
  drawings: Drawing[];
  selectedId: string | null;
  setSymbol: (s: string) => void;
  setTool: (t: DrawingTool) => void;
  setColor: (c: string) => void;
  add: (d: Drawing) => void;
  update: (id: string, points: DrawPoint[]) => void;
  remove: (id: string) => void;
  select: (id: string | null) => void;
  clear: () => void;
}

export const useDrawings = create<DrawingStore>()((set, get) => ({
  symbol: '',
  tool: 'select',
  color: DEFAULT_DRAWING_COLOR,
  drawings: [],
  selectedId: null,
  setSymbol: (symbol) => {
    if (symbol !== get().symbol) set({ symbol, drawings: load(symbol), selectedId: null });
  },
  setTool: (tool) => set({ tool, selectedId: null }),
  setColor: (color) => set({ color }),
  add: (d) => {
    const drawings = [...get().drawings, d];
    set({ drawings, selectedId: d.id });
    save(get().symbol, drawings);
  },
  update: (id, points) => {
    const drawings = get().drawings.map((d) => (d.id === id ? { ...d, points } : d));
    set({ drawings });
    save(get().symbol, drawings);
  },
  remove: (id) => {
    const drawings = get().drawings.filter((d) => d.id !== id);
    set({ drawings, selectedId: null });
    save(get().symbol, drawings);
  },
  select: (selectedId) => set({ selectedId }),
  clear: () => {
    set({ drawings: [], selectedId: null });
    save(get().symbol, []);
  },
}));

// Every change here saves the shown symbol's whole list, so a change another tab saves to it (a
// drawing, or a restored backup) is taken in as it lands; otherwise the next change here would put
// this tab's older list back over it. Storage cleared there (key null) is taken in too.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    const { symbol, selectedId } = useDrawings.getState();
    if (!symbol || (e.key !== null && e.key !== key(symbol))) return;
    const drawings = load(symbol);
    useDrawings.setState({ drawings, selectedId: drawings.some((d) => d.id === selectedId) ? selectedId : null });
  });
}
