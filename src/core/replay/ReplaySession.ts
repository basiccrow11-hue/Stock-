/**
 * A replay trading session: one shared replay clock over one or more symbols, a simulated broker,
 * and undo checkpoints.
 *
 * Revealed bars flow one way: engines → broker, merged in time order. The broker can therefore only
 * fill orders against prices that have already "happened" in the replay, for every symbol.
 *
 * Stepping backward / restarting / jumping back restores the account to exactly what it was at that
 * moment, and is recorded (`rewinds`) because after a rewind you have seen the future. Challenges
 * and the journal use that flag so rewound results are never presented as clean, blind results.
 *
 * The broker is deterministic: the same bars, orders and settings give the same fills. So undo keeps
 * a checkpoint at every trading action, settings change and every few hundred bars, and a rewind
 * goes back to the newest checkpoint at or before the target and feeds the broker the bars from
 * there to the target again. Whatever is left on the chart is exactly what the account has seen.
 */
import type { Bar, OrderRequest, Timeframe, UnixSeconds } from '../types';
import type { HistoricalDataProvider } from '../data/provider';
import type { ExecutionConfig } from '../broker/config';
import { SimBroker, type BrokerCheckpoint, type SubmitResult } from '../broker/SimBroker';
import { ReplayEngine, barEndTime } from './ReplayEngine';
import {
  AFTERHOURS_CLOSE,
  PREMARKET_OPEN,
  exchangeTimeToUnix,
  formatExchangeTime,
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

interface Checkpoint {
  /** Bars revealed by each engine (engine order) when it was taken. */
  cursors: number[];
  /** Their sum. */
  revealed: number;
  broker: BrokerCheckpoint;
  /** The execution settings the bars after it were processed with. */
  config: ExecutionConfig;
}

/** Most bars fed between checkpoints, so a rewind replays at most this many. */
const CHECKPOINT_BARS = 256;

export class ReplaySession {
  readonly broker: SimBroker;
  readonly engines: ReadonlyMap<string, ReplayEngine>;
  rewinds = 0;
  /** Oldest first. The first is the clean start, which Restart returns to. */
  private checkpoints: Checkpoint[] = [];

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
      if (last) this.broker.onBar(e.symbol, last, e.barSeconds(last));
    }
    this.checkpoint();
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

  /** Bars processed after this use `config`. */
  setConfig(config: ExecutionConfig): void {
    if (config === this.broker.cfg) return;
    this.broker.cfg = config;
    this.checkpoint();
  }

  private cursors(): number[] {
    return [...this.engines.values()].map((e) => e.revealedCount);
  }

  /** A checkpoint at the current reveal point. A later one at the same point replaces it (not the start's). */
  private checkpoint(): void {
    const cursors = this.cursors();
    const last = this.checkpoints[this.checkpoints.length - 1];
    if (this.checkpoints.length > 1 && last.cursors.every((c, i) => c === cursors[i])) this.checkpoints.pop();
    this.checkpoints.push({ cursors, revealed: cursors.reduce((a, b) => a + b, 0), broker: this.broker.checkpoint(), config: this.broker.cfg });
  }

  /**
   * Feed bars to `broker` in the order they completed (then by open time, then engine order, primary
   * first). Every reveal hands over all bars completed by the new time, so feeding a replay range at
   * once gives the same order as revealing it step by step did.
   */
  private process(broker: SimBroker, bars: RevealedBar[]): RevealedBar[] {
    const rank = new Map(this.symbols.map((s, i) => [s, i]));
    const keyed = bars.map((r) => ({ r, end: barEndTime(r.bar, this.engines.get(r.symbol)!.baseTimeframe), rank: rank.get(r.symbol)! }));
    keyed.sort((a, b) => a.end - b.end || a.r.bar.time - b.r.bar.time || a.rank - b.rank);
    for (const { r } of keyed) broker.onBar(r.symbol, r.bar, this.engines.get(r.symbol)!.barSeconds(r.bar));
    return keyed.map((k) => k.r);
  }

  /** Feed newly revealed bars to the broker. */
  private feed(revealed: RevealedBar[]): RevealedBar[] {
    const out = this.process(this.broker, revealed);
    const revealedNow = this.cursors().reduce((a, b) => a + b, 0);
    if (revealedNow - this.checkpoints[this.checkpoints.length - 1].revealed >= CHECKPOINT_BARS) this.checkpoint();
    return out;
  }

  /** The newest checkpoint at or before the reveal point `cursors`. */
  private checkpointAt(cursors: number[]): number {
    for (let i = this.checkpoints.length - 1; i > 0; i--) if (this.checkpoints[i].cursors.every((c, k) => c <= cursors[k])) return i;
    return 0;
  }

  /** Bring `broker`, rolled back to `cp`, up to the reveal point `cursors` with the bars in between. */
  private replayFrom(broker: SimBroker, cp: Checkpoint, cursors: number[]): void {
    const bars: RevealedBar[] = [];
    let k = 0;
    for (const e of this.engines.values()) {
      for (const bar of e.revealedBars(cp.cursors[k], cursors[k])) bars.push({ symbol: e.symbol, bar });
      k++;
    }
    const config = broker.cfg;
    broker.cfg = cp.config;
    this.process(broker, bars);
    broker.cfg = config;
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
    // A stretch with no bar trading that is longer than 30 minutes (a night, a weekend, a halt) is
    // skipped to the next bar's open. While a bar trades, time passes at the chosen speed, whatever
    // the base timeframe: an hourly or daily bar takes its hour or session.
    let open: UnixSeconds | null = null;
    for (const e of this.engines.values()) {
      const t = e.nextBarTime();
      if (t !== null && (open === null || t < open)) open = t;
    }
    if (open !== null && open > target && open - this.now > 30 * 60) target = open;
    return this.advanceAll(target);
  }

  /** Jump to an exchange time. Forward jumps process every skipped bar (orders can fill). */
  jumpTo(time: UnixSeconds): RevealedBar[] {
    if (time >= this.now) return this.advanceAll(time);
    this.rewindTo(time);
    return [];
  }

  /** Where Step back goes: the open of the primary symbol's last revealed bar (null before the start). */
  stepBackTarget(): UnixSeconds | null {
    const last = this.engine.lastBar();
    return last && this.engine.started ? last.time : null;
  }

  /** Step back one base bar of the primary symbol. */
  stepBack(): void {
    const target = this.stepBackTarget();
    if (target !== null) this.rewindTo(target);
  }

  /**
   * What a rewind to `time` (or Restart, with `restart`) would undo, worked out on a copy of the
   * account: trades opened since (`open`: still open now) and trades closed since (`closed`: their
   * journal entries go). `hides` says whether any bar seen so far would be hidden again, which is
   * what makes it a rewind.
   */
  undoneBy(time: UnixSeconds, restart = false): { open: number; closed: number; hides: boolean } {
    const target = restart ? this.checkpoints[0].cursors : [...this.engines.values()].map((e) => Math.min(e.revealedCount, e.revealedCountAt(time)));
    const hides = this.cursors().some((c, k) => target[k] < c);
    const cp = this.checkpoints[restart ? 0 : this.checkpointAt(target)];
    const after = this.broker.fork(cp.broker);
    this.replayFrom(after, cp, target);
    const then = new Map(after.state.roundTrips.map((t) => [t.id, t.closed]));
    let open = 0;
    let closed = 0;
    for (const t of this.broker.state.roundTrips) {
      if (t.closed && then.get(t.id) !== true) closed++;
      else if (!t.closed && !then.has(t.id)) open++;
    }
    return { open, closed, hides };
  }

  /** Back to the start with the starting account: no orders, even ones placed before the first bar. */
  restart(): void {
    this.rewindTo(this.start, true);
  }

  /** Rewind to `time`: the account as it was then, including orders placed at that moment (not with `restart`). */
  private rewindTo(time: UnixSeconds, restart = false): void {
    // It is a rewind only if bars already seen are hidden again. Before the first new bar (Restart
    // at the start, or Play stopped within the first minute) nothing has been seen.
    const before = this.cursors();
    for (const e of this.engines.values()) e.rewindTo(time);
    const cursors = this.cursors();
    const back = cursors.some((c, k) => c < before[k]);
    const i = restart ? 0 : this.checkpointAt(cursors);
    const cp = this.checkpoints[i];
    this.checkpoints.length = i + 1;
    this.broker.rollback(cp.broker);
    this.replayFrom(this.broker, cp, cursors);
    // Settings changed since `cp` apply from here on, so a later rewind past here must know it.
    if (this.broker.cfg !== cp.config) this.checkpoint();
    if (!back) {
      if (restart) this.broker.logInfo('Back to the start: orders and trades cleared.');
      return;
    }
    // No date: the log's time column already gives the day, and hides it in blind mode.
    this.broker.logInfo(`Rewound to ${formatExchangeTime(time)} ET. Results after a rewind are not blind.`);
    this.rewinds += 1;
  }

  // Order actions happen at the replay's time, which can be past the last bar (a new day before its first bar).
  submit(req: OrderRequest): SubmitResult {
    this.broker.syncClock(this.now);
    const r = this.broker.submit(req);
    this.checkpoint();
    return r;
  }

  cancel(orderId: string): boolean {
    const ok = this.broker.cancel(orderId);
    this.checkpoint();
    return ok;
  }

  modify(orderId: string, changes: { limitPrice?: number; stopPrice?: number; quantity?: number }) {
    this.broker.syncClock(this.now);
    const r = this.broker.modify(orderId, changes);
    this.checkpoint();
    return r;
  }

  closePosition(symbol: string): SubmitResult {
    this.broker.syncClock(this.now);
    const r = this.broker.closePosition(symbol);
    this.checkpoint();
    return r;
  }
}
