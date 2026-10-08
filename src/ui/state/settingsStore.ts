/**
 * User settings, persisted to localStorage. Contains no secrets (API keys live in credentials.ts).
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Timeframe } from '../../core/types';
import { DEFAULT_EXECUTION_CONFIG, type ExecutionConfig } from '../../core/broker/config';
import { DEFAULT_TRADING_RULES, type TradingRules } from '../../core/learning/review';
import { DEFAULT_SIM_CONFIG, type SimConfig } from '../../core/sim/SimMarket';
import {
  DEFAULT_APPEARANCE,
  THEMES,
  candlePresets,
  defaultLineColor,
  sanitizeAppearance,
  holdPnl,
  themeChartSurface,
  type Appearance,
  type ChartColors,
  type ThemeId,
} from '../theme/themes';

export type IndicatorType = 'sma' | 'ema' | 'vwap' | 'bb' | 'rsi' | 'macd' | 'atr' | 'volume';

export interface IndicatorConfig {
  id: string;
  type: IndicatorType;
  enabled: boolean;
  period?: number;
  mult?: number;
  fast?: number;
  slow?: number;
  signal?: number;
  color: string;
}

export const DEFAULT_INDICATORS: IndicatorConfig[] = [
  { id: 'vol', type: 'volume', enabled: true, color: '#5d6b82' },
  { id: 'ema9', type: 'ema', enabled: true, period: 9, color: '#f5a623' },
  { id: 'ema21', type: 'ema', enabled: true, period: 21, color: '#4f8cff' },
  { id: 'vwap', type: 'vwap', enabled: true, color: '#c77dff' },
  { id: 'sma50', type: 'sma', enabled: false, period: 50, color: '#9e9e9e' },
  { id: 'bb', type: 'bb', enabled: false, period: 20, mult: 2, color: '#26a69a' },
  { id: 'rsi', type: 'rsi', enabled: true, period: 14, color: '#b39ddb' },
  { id: 'macd', type: 'macd', enabled: false, fast: 12, slow: 26, signal: 9, color: '#4f8cff' },
  { id: 'atr', type: 'atr', enabled: false, period: 14, color: '#ffb74d' },
];

export interface ReplayDefaults {
  providerId: string;
  symbol: string;
  date: string;
  startTime: string;
  endTime: string;
  multiDay: boolean;
  endDate: string;
  timeframe: Timeframe;
  speed: number;
  includeWatchlist: boolean;
  blind: boolean;
}

export interface Settings {
  execution: ExecutionConfig;
  rules: TradingRules;
  learningMode: boolean;
  autoSnapshot: boolean;
  defaultBalance: number;
  replay: ReplayDefaults;
  watchlist: string[];
  indicators: IndicatorConfig[];
  sim: SimConfig & { speed: number; startingBalance: number };
  alpacaFeed: 'iex' | 'sip';
  appearance: Appearance;
}

export const DEFAULT_SETTINGS: Settings = {
  execution: DEFAULT_EXECUTION_CONFIG,
  rules: DEFAULT_TRADING_RULES,
  learningMode: true,
  autoSnapshot: true,
  defaultBalance: 25_000,
  replay: {
    providerId: 'demo',
    symbol: 'SPY',
    date: '2025-01-15',
    startTime: '09:30',
    endTime: '16:00',
    multiDay: false,
    endDate: '2025-01-17',
    timeframe: '1m',
    speed: 60,
    includeWatchlist: true,
    blind: false,
  },
  watchlist: ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META'],
  indicators: DEFAULT_INDICATORS,
  sim: { ...DEFAULT_SIM_CONFIG, speed: 10, startingBalance: 25_000 },
  alpacaFeed: 'iex',
  appearance: DEFAULT_APPEARANCE,
};

interface SettingsStore extends Settings {
  update: (patch: Partial<Settings>) => void;
  updateExecution: (patch: Partial<ExecutionConfig>) => void;
  updateRules: (patch: Partial<TradingRules>) => void;
  updateReplay: (patch: Partial<ReplayDefaults>) => void;
  updateIndicator: (id: string, patch: Partial<IndicatorConfig>) => void;
  addIndicator: (ind: IndicatorConfig) => void;
  removeIndicator: (id: string) => void;
  updateAppearance: (patch: Partial<Omit<Appearance, 'colors'>>) => void;
  /** Set one chart colour. With linked candle parts, body colours also set wick and border. */
  setChartColor: (key: keyof ChartColors, value: string) => void;
  /** Switch app theme and the chart surface colours that belong to it (candle colours are kept). */
  applyTheme: (theme: ThemeId) => void;
  applyCandlePreset: (presetId: string) => void;
  resetAppearance: () => void;
  reset: () => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      update: (patch) => set(patch),
      updateExecution: (patch) => set((s) => ({ execution: { ...s.execution, ...patch } })),
      updateRules: (patch) => set((s) => ({ rules: { ...s.rules, ...patch } })),
      updateReplay: (patch) => set((s) => ({ replay: { ...s.replay, ...patch } })),
      updateIndicator: (id, patch) => set((s) => ({ indicators: s.indicators.map((i) => (i.id === id ? { ...i, ...patch } : i)) })),
      addIndicator: (ind) => set((s) => ({ indicators: [...s.indicators, ind] })),
      removeIndicator: (id) => set((s) => ({ indicators: s.indicators.filter((i) => i.id !== id) })),
      updateAppearance: (patch) =>
        set((s) => {
          const next = { ...s.appearance, ...patch };
          // Turning the link on makes wick and border match the body again.
          if (patch.linkCandleParts && !s.appearance.linkCandleParts) {
            const c = s.appearance.colors;
            next.colors = { ...c, wickUp: c.up, borderUp: c.up, wickDown: c.down, borderDown: c.down };
          }
          return { appearance: holdPnl(s.appearance, sanitizeAppearance(next)) };
        }),
      setChartColor: (key, value) =>
        set((s) => {
          const a = s.appearance;
          const colors = { ...a.colors, [key]: value };
          if (a.linkCandleParts && key === 'up') Object.assign(colors, { wickUp: value, borderUp: value });
          if (a.linkCandleParts && key === 'down') Object.assign(colors, { wickDown: value, borderDown: value });
          return { appearance: holdPnl(a, sanitizeAppearance({ ...a, colors })) };
        }),
      applyTheme: (theme) =>
        set((s) => {
          const a = s.appearance;
          const colors = { ...a.colors, ...themeChartSurface(theme) };
          // A preset that adapts to light/dark (monochrome) follows the theme.
          const was = candlePresets(THEMES[a.theme].scheme).find((p) => p.up === a.colors.up && p.down === a.colors.down);
          const now = was && candlePresets(THEMES[theme].scheme).find((p) => p.id === was.id);
          if (now && a.linkCandleParts) Object.assign(colors, { up: now.up, down: now.down, wickUp: now.up, wickDown: now.down, borderUp: now.up, borderDown: now.down });
          if (a.colors.line === defaultLineColor(THEMES[a.theme].scheme)) colors.line = defaultLineColor(THEMES[theme].scheme);
          return { appearance: holdPnl(a, sanitizeAppearance({ ...a, theme, colors })) };
        }),
      applyCandlePreset: (presetId) =>
        set((s) => {
          const p = candlePresets(THEMES[s.appearance.theme].scheme).find((x) => x.id === presetId);
          if (!p) return {};
          const colors = { ...s.appearance.colors, up: p.up, down: p.down, wickUp: p.up, wickDown: p.down, borderUp: p.up, borderDown: p.down };
          return { appearance: holdPnl(s.appearance, sanitizeAppearance({ ...s.appearance, colors, linkCandleParts: true })) };
        }),
      resetAppearance: () => set({ appearance: DEFAULT_APPEARANCE }),
      reset: () => set({ ...DEFAULT_SETTINGS }),
    }),
    {
      name: 'stock-replay-settings',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Deep-merge so new settings fields added in later versions get their defaults.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Settings>;
        return {
          ...current,
          ...p,
          execution: { ...current.execution, ...p.execution, strictRisk: { ...current.execution.strictRisk, ...p.execution?.strictRisk } },
          rules: { ...current.rules, ...p.rules },
          replay: { ...current.replay, ...p.replay },
          sim: { ...current.sim, ...p.sim },
          // An empty list is a choice (a price-only chart), not a missing value.
          indicators: Array.isArray(p.indicators) ? p.indicators : current.indicators,
          appearance: sanitizeAppearance(p.appearance),
        };
      },
    },
  ),
);

// Every open tab saves the whole settings object, so each takes the others' saves as they land;
// otherwise a tab's next write (even starting a replay) would put back its stale copy over them.
// A cleared key (another tab cleared site data) is not a save, and this tab keeps what it has.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'stock-replay-settings' && e.newValue !== null) void useSettings.persist.rehydrate();
  });
}

export function getSettings(): Settings {
  return useSettings.getState();
}
