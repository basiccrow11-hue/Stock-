/**
 * A replay trading session: one shared replay clock over one or more symbols, a simulated broker,
 * and undo snapshots.
 *
 * Revealed bars flow one way: engines → broker, merged in time order. The broker can therefore only
 * fill orders against prices that have already "happened" in the replay, for every symbol.
 *
 * Stepping backward / restarting / jumping back restores the account to exactly what it was at that
 * moment, and is recorded (`rewinds`) because after a rewind you have seen the future. Challenges
 * and the journal use that flag so rewound results are never presented as clean, blind results.
 */
import type { Bar, OrderRequest, Timeframe, UnixSeconds } from '../types';
import type { HistoricalDataProvider } from '../data/provider';
import type { ExecutionConfig } from '../broker/config';
import { SimBroker, type BrokerState, type SubmitResult } from '../broker/SimBroker';
import { ReplayEngine } from './ReplayEngine';
import {
  AFTERHOURS_CLOSE,
  PREMARKET_OPEN,
  exchangeTimeToUnix,
  formatExchangeDateTime,
  parseHHMM,
  prevTradingDay,
  tradingDayOnOrBefore,
} from '../time';

export interface ReplaySetup {
  /** Primary symbol (shown first on the chart). */
  symbol: string;
  /** Additional symbols replayed on the same clock (watchlist). */
  extraSymbols?: string[];
  /** Exchange-local date YYYY-MM-DD. */
  date: string;
  /** HH:MM exchange time. */
  startTime: string;
  endDate?: string;
  endTime: string;
  startingBalance: number;
  /** Trading days of history loaded before the start for chart context and indicator warm-up. */
  lookbackDays: number;
}

export const DEFAULT_LOOKBACK: Record<Timeframe, number> = {
  '1m': 5,
  '5m': 10,
  '15m': 15,
  '30m': 25,
  '1h': 40,
  '4h': 80,
  '1D': 200,
};

/** A revealed bar tagged with its symbol. */
export interface RevealedBar {
  symbol: string;
  bar: Bar;
}

interface Snapshot {
  /** Total bars revealed across all engines (monotonic while moving forward). */
  revealed: number;
  now: UnixSeconds;
  state: BrokerState;
}

export class ReplaySession {
  readonly broker: SimBroker;
  readonly engines: ReadonlyMap<string, ReplayEngine>;
  rewinds = 0;
  private snapshots: Snapshot[] = [];
  private lastSnapshotVersion = -1;

  constructor(
    engines: ReplayEngine | ReplayEngine[],
    readonly setup: ReplaySetup,
    config: ExecutionConfig,
    readonly sessionId: string,
    source: 'HISTORICAL' | 'DEMO',
  ) {
    const list = Array.isArray(engines) ? engines : [engines];
    if (!list.length) throw new Error('At least one symbol is required.');
    this.engines = new Map(list.map((e) => [e.symbol, e]));
    this.broker = new SimBroker({ startingBalance: setup.startingBalance, config, idPrefix: sessionId, source });
    // Prime the broker with each symbol's last known price before the start (no orders exist yet).
    for (const e of list) {
      const last = e.lastBar();
      if (last) this.broker.onBar(e.symbol, last, e.baseSeconds);
    }
    this.snapshot(true);
  }

  /**
   * Loads bars for the primary symbol and any extra symbols. Extra symbols that fail to load are
   * skipped and reported in `warnings` rather than failing the whole session.
   */
  static async load(
    provider: HistoricalDataProvider,
    setup: ReplaySetup,
    config: ExecutionConfig,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ session: ReplaySession; warnings: string[] }> {
    const symbol = setup.symbol.toUpperCase();
    const date = tradingDayOnOrBefore(setup.date);
    let from = date;
    for (let i = 0; i < setup.lookbackDays; i++) from = prevTradingDay(from);
    const start = exchangeTimeToUnix(date, parseHHMM(setup.startTime));
    const endDate = setup.endDate && setup.endDate >= date ? setup.endDate : date;
    const end = exchangeTimeToUnix(endDate, parseHHMM(setup.endTime));
    if (end <= start) throw new Error('End time must be after the start time.');
    const range = { from: exchangeTimeToUnix(from, PREMARKET_OPEN), to: Math.max(end, exchangeTimeToUnix(endDate, AFTERHOURS_CLOSE)) };

    const symbols = [symbol, ...(setup.extraSymbols ?? []).map((s) => s.toUpperCase()).filter((s) => s !== symbol)];
    const warnings: string[] = [];
    const engines: ReplayEngine[] = [];
    for (const sym of symbols) {
      try {
        const bars = await provider.getBars({ symbol: sym, ...range }, signal);
        if (bars.length === 0) throw new Error(`No ${sym} data for ${date}. Pick another date or data source.`);
        engines.push(new ReplayEngine({ symbol: sym, start, end, baseTimeframe: provider.baseTimeframe(sym) }, bars));
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        if (sym === symbol) throw e;
        warnings.push(`${sym} skipped: ${(e as Error).message}`);
      }
    }
    const source = provider.source === 'DEMO' ? 'DEMO' : 'HISTORICAL';
    const session = new ReplaySession(engines, { ...setup, symbol, date, endDate }, config, sessionId, source);
    return { session, warnings };
  }

  /** The primary symbol's engine. */
  get engine(): ReplayEngine {
    return this.engines.values().next().value!;
  }

  engineFor(symbol: string): ReplayEngine | undefined {
    return this.engines.get(symbol.toUpperCase());
  }

  get symbols(): string[] {
    return [...this.engines.keys()];
  }

  get symbol(): string {
    return this.engine.symbol;
  }

  get now(): UnixSeconds {
    return this.engine.now;
  }

  get start(): UnixSeconds {
    return this.engine.start;
  }

  get end(): UnixSeconds {
    return this.engine.end;
  }

  get finished(): boolean {
    return [...this.engines.values()].every((e) => e.finished);
  }

  get rewound(): boolean {
    return this.rewinds > 0;
  }

  setConfig(config: ExecutionConfig): void {
    this.broker.cfg = config;
  }

  private totalRevealed(): number {
    let n = 0;
    for (const e of this.engines.values()) n += e.revealedCount;
    return n;
  }

  /** Feed revealed bars to the broker in time order (ties: engine order, i.e. primary first). */
  private feed(revealed: RevealedBar[]): RevealedBar[] {
    revealed.sort((a, b) => a.bar.time - b.bar.time);
    for (const r of revealed) this.broker.onBar(r.symbol, r.bar, this.engines.get(r.symbol)!.baseSeconds);
    if (revealed.length) this.snapshot();
    return revealed;
  }

  private snapshot(force = false): void {
    if (!force && this.broker.version === this.lastSnapshotVersion) return;
    const revealed = this.totalRevealed();
    // Replace a snapshot taken at the same reveal point (e.g. several orders between two bars).
    while (this.snapshots.length && this.snapshots[this.snapshots.length - 1].revealed === revealed) this.snapshots.pop();
    // The equity curve and event log are append-only and can be long; keep them out of snapshots
    // and truncate them on restore instead (keeps memory linear in replay length).
    const { equityCurve, events, ...rest } = this.broker.state;
    void equityCurve;
    void events;
    this.snapshots.push({ revealed, now: this.now, state: structuredClone({ ...rest, equityCurve: [], events: [] }) });
    this.lastSnapshotVersion = this.broker.version;
  }

  /** Move every engine's clock to `target`, revealing completed bars. */
  private advanceAll(target: UnixSeconds): RevealedBar[] {
    const out: RevealedBar[] = [];
    for (const e of this.engines.values()) for (const bar of e.advanceTo(target)) out.push({ symbol: e.symbol, bar });
    return this.feed(out);
  }

  private nextRevealTime(): UnixSeconds | null {
    let t: UnixSeconds | null = null;
    for (const e of this.engines.values()) {
      const n = e.nextRevealTime();
      if (n !== null && (t === null || n < t)) t = n;
    }
    return t;
  }

  /** Reveal the next base bar (the earliest across symbols, e.g. one minute). */
  step(): RevealedBar[] {
    const t = this.nextRevealTime();
    return t === null ? [] : this.advanceAll(t);
  }

  /** Reveal one full candle of `timeframe` on `symbol` (default: primary); others follow the clock. */
  stepCandle(timeframe: Timeframe, symbol = this.symbol): RevealedBar[] {
    const e = this.engineFor(symbol) ?? this.engine;
    const own = e.stepCandle(timeframe).map((bar) => ({ symbol: e.symbol, bar }));
    const rest: RevealedBar[] = [];
    for (const other of this.engines.values()) {
      if (other === e) continue;
      for (const bar of other.advanceTo(e.now)) rest.push({ symbol: other.symbol, bar });
    }
    return this.feed([...own, ...rest]);
  }

  /**
   * Advance simulated time by `seconds` (used by Play). Closed-market gaps (overnight, weekends)
   * are skipped so multi-day replays don't sit on an empty chart.
   */
  advance(seconds: number): RevealedBar[] {
    let target = this.now + seconds;
    const next = this.nextRevealTime();
    if (next !== null && next > target && next - this.now > 30 * 60) target = next;
    return this.advanceAll(target);
  }

  /** Jump to an exchange time. Forward jumps process every skipped bar (orders can fill). */
  jumpTo(time: UnixSeconds): RevealedBar[] {
    if (time >= this.now) return this.advanceAll(time);
    this.rewindTo(time);
    return [];
  }

  /** Step back one base bar of the primary symbol. */
  stepBack(): void {
    const last = this.engine.lastBar();
    if (!last || !this.engine.started) return;
    this.rewindTo(last.time);
  }

  restart(): void {
    this.rewindTo(this.start);
  }

  private rewindTo(time: UnixSeconds): void {
    for (const e of this.engines.values()) e.rewindTo(time);
    const revealed = this.totalRevealed();
    let snap = this.snapshots[0];
    for (const s of this.snapshots) {
      if (s.revealed <= revealed) snap = s;
      else break;
    }
    this.snapshots = this.snapshots.filter((s) => s.revealed <= snap.revealed);
    const cutoff = snap.state.clock;
    const curve = this.broker.state.equityCurve.filter((p) => p.time <= cutoff);
    const events = this.broker.state.events.filter((e) => e.time <= cutoff);
    this.broker.restore({ ...snap.state, equityCurve: curve, events });
    this.broker.logInfo(`Rewound to ${formatExchangeDateTime(time)}. Results after a rewind are not blind.`);
    this.lastSnapshotVersion = this.broker.version;
    this.rewinds += 1;
  }

  submit(req: OrderRequest): SubmitResult {
    const r = this.broker.submit(req);
    this.snapshot();
    return r;
  }

  cancel(orderId: string): boolean {
    const ok = this.broker.cancel(orderId);
    this.snapshot();
    return ok;
  }

  modify(orderId: string, changes: { limitPrice?: number; stopPrice?: number; quantity?: number }) {
    const r = this.broker.modify(orderId, changes);
    this.snapshot();
    return r;
  }

  closePosition(symbol: string): SubmitResult {
    const r = this.broker.closePosition(symbol);
    this.snapshot();
    return r;
  }
}
