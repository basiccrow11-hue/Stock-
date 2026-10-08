/** Chart drawing model + per-symbol persistence (localStorage). Points are stored in real time/price. */
import { create } from 'zustand';

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

const key = (symbol: string) => `stock-replay-drawings:${symbol}`;

function load(symbol: string): Drawing[] {
  try {
    return JSON.parse(localStorage.getItem(key(symbol)) ?? '[]') as Drawing[];
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
  color: '#4f8cff',
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
