/**
 * User settings, persisted to localStorage. Contains no secrets (API keys live in credentials.ts).
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Timeframe } from '../../core/types';
import { DEFAULT_EXECUTION_CONFIG, type ExecutionConfig } from '../../core/broker/config';
import { DEFAULT_TRADING_RULES, type TradingRules } from '../../core/learning/review';
import { DEFAULT_SIM_CONFIG, type SimConfig } from '../../core/sim/SimMarket';

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
  { id: 'sma50', type: 'sma', enabled: false, period: 50, color: '#e0e0e0' },
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
};

interface SettingsStore extends Settings {
  update: (patch: Partial<Settings>) => void;
  updateExecution: (patch: Partial<ExecutionConfig>) => void;
  updateRules: (patch: Partial<TradingRules>) => void;
  updateReplay: (patch: Partial<ReplayDefaults>) => void;
  updateIndicator: (id: string, patch: Partial<IndicatorConfig>) => void;
  addIndicator: (ind: IndicatorConfig) => void;
  removeIndicator: (id: string) => void;
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
          indicators: p.indicators?.length ? p.indicators : current.indicators,
        };
      },
    },
  ),
);

export function getSettings(): Settings {
  return useSettings.getState();
}
