/**
 * Market-data abstraction. The UI and engine depend only on these interfaces, so a vendor can be
 * added by implementing HistoricalDataProvider (or StreamingDataProvider) and registering it.
 */
import type { Bar, DataSourceKind, Timeframe, UnixSeconds } from '../types';

export interface SymbolInfo {
  symbol: string;
  name: string;
  kind: 'stock' | 'etf' | 'index';
  /** Short description, e.g. sector or personality for simulated names. */
  description?: string;
}

export interface MarketDataProvider {
  readonly id: string;
  readonly name: string;
  /** What kind of prices this provider produces. Drives the data-integrity badge. */
  readonly source: DataSourceKind;
  /** True if the provider needs credentials configured in Settings before it can be used. */
  readonly requiresCredentials: boolean;
  /** Human-readable explanation when the provider cannot be used right now, else null. */
  unavailableReason(): string | null;
  listSymbols(): Promise<SymbolInfo[]>;
}

export interface BarRequest {
  symbol: string;
  /** Inclusive start. */
  from: UnixSeconds;
  /** Exclusive end. */
  to: UnixSeconds;
}

export interface HistoricalDataProvider extends MarketDataProvider {
  /** Finest resolution the provider returns (bars are aggregated up from this). */
  baseTimeframe(symbol: string): Timeframe;
  /** Chronologically sorted bars with open time in [from, to). */
  getBars(req: BarRequest, signal?: AbortSignal): Promise<Bar[]>;
  /** Earliest/latest data available for a symbol, if known. */
  availableRange(symbol: string): Promise<{ from: UnixSeconds; to: UnixSeconds } | null>;
  /** Trading days (YYYY-MM-DD, exchange time) that have bars, when the data can have gaps between them (imported files). */
  sessionDates?(symbol: string): Promise<string[] | null>;
}

export type Unsubscribe = () => void;

export interface StreamUpdate {
  symbol: string;
  /** The bar being formed (same time as previous update) or a new bar. */
  bar: Bar;
  isNewBar: boolean;
  time: UnixSeconds;
}

export interface StreamingDataProvider extends MarketDataProvider {
  subscribe(symbols: string[], onUpdate: (u: StreamUpdate) => void): Unsubscribe;
  /** Completed + forming bars up to now (never beyond the provider's current clock). */
  getHistory(symbol: string): Bar[];
}

export class DataProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'network' | 'not_found' | 'rate_limit' | 'invalid' | 'unknown' = 'unknown',
  ) {
    super(message);
    this.name = 'DataProviderError';
  }
}

export function isHistorical(p: MarketDataProvider): p is HistoricalDataProvider {
  return typeof (p as HistoricalDataProvider).getBars === 'function';
}
