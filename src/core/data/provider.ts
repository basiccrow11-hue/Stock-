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
  /**
   * Chronologically sorted bars of `timeframe` (coarser than the base timeframe) with open time in
   * [from, to), covering the same minutes as the app's own aggregation of the base bars (intraday
   * candles start from the 09:30 open), so a chart builds the same candles from either. Replays load
   * a higher timeframe's months of history this way instead of as 1-minute bars; without it they
   * aggregate getBars.
   */
  getCoarseBars?(req: BarRequest, timeframe: Timeframe, signal?: AbortSignal): Promise<Bar[]>;
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
  /** What traded since the symbol's previous update, as a bar lasting the stream's tickSeconds: orders fill against it. */
  tick: Bar;
}

/** News a stream reports alongside its prices (shown on the chart and in the News tab). */
export interface StreamEvent {
  id: string;
  time: UnixSeconds;
  /** Ticker, or 'MARKET' for market-wide news. */
  symbol: string;
  type: string;
  headline: string;
  /** Expected price impact in %. */
  impactPct: number;
  simulated: boolean;
}

/**
 * A source of prices as they happen. A trading session needs only this: its symbols, its clock,
 * updates as they come (subscribe), the bars so far and its news, so any stream can take the
 * simulated market's place.
 */
export interface StreamingDataProvider<E extends StreamEvent = StreamEvent> extends MarketDataProvider {
  /** The symbols it streams, in the order to list them. */
  readonly symbols: readonly string[];
  /** The time of its latest update. */
  readonly clock: UnixSeconds;
  /** Seconds each update covers (the length of its tick bar). */
  readonly tickSeconds: number;
  subscribe(symbols: readonly string[], onUpdate: (u: StreamUpdate) => void): Unsubscribe;
  /** Completed + forming bars up to now (never beyond the provider's current clock). */
  getHistory(symbol: string): Bar[];
  /** Its news so far, oldest first. */
  events(): readonly E[];
}

/** A stream whose clock the app moves (the simulated market, played at any speed), rather than one that runs on real time. */
export interface DrivenStreamingProvider<E extends StreamEvent = StreamEvent> extends StreamingDataProvider<E> {
  /** Moves the clock on by `seconds`, delivering every update in between to subscribers, in time order. */
  advance(seconds: number): void;
}

export function isDriven<E extends StreamEvent>(p: StreamingDataProvider<E>): p is DrivenStreamingProvider<E> {
  return typeof (p as DrivenStreamingProvider<E>).advance === 'function';
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
