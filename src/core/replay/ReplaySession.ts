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
import { TIMEFRAMES, type Bar, type OrderRequest, type Timeframe, type UnixSeconds } from '../types';
import type { BarRequest, HistoricalDataProvider } from '../data/provider';
import { aggregateBars } from '../data/aggregate';
import type { ExecutionConfig } from '../broker/config';
import { SimBroker, type BrokerCheckpoint, type SubmitResult } from '../broker/SimBroker';
import { ReplayEngine, barEndTime } from './ReplayEngine';
import {
  AFTERHOURS_CLOSE,
  PREMARKET_OPEN,
  REGULAR_CLOSE,
  afterHoursCloseMinute,
  exchangeDate,
  exchangeMinuteOfDay,
  exchangeTimeToUnix,
  formatExchangeTime,
  isTradingDay,
  nextTradingDay,
  parseHHMM,
  prevTradingDay,
  regularCloseMinute,
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
  /**
   * Trading days of history loaded before the start for chart context and indicator warm-up. Data
   * finer than 30 minutes is loaded at its own resolution for at most BASE_LOOKBACK_LIMIT of them;
   * charts of higher timeframes get their longer history from loadHistory.
   */
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

/**
 * The bar size of the history loaded for higher timeframes (ReplaySession.loadHistory): 30 minutes,
 * or the data's own bars when those are coarser. 30-minute bars build every candle from 30m to 1D just
 * as the 1-minute bars would (intraday candles start from the 09:30 open), with a thirtieth of the bars.
 */
export function historyTimeframe(base: Timeframe): Timeframe {
  return TIMEFRAMES.indexOf(base) > TIMEFRAMES.indexOf('30m') ? base : '30m';
}

/**
 * Most trading days loaded before the start at the data's own resolution when it is finer than the
 * history's: enough for 1m to 15m charts. Longer lookbacks come from the history.
 */
export const BASE_LOOKBACK_LIMIT = DEFAULT_LOOKBACK['15m'];

/** Trading days before the start the history reaches back (a daily chart's lookback, or a longer one asked for). */
const HISTORY_DAYS = DEFAULT_LOOKBACK['1D'];

/** What a chart can draw from before a symbol's loaded bars (ReplaySession.chartHistory). */
export interface ChartHistory {
  /**
   * Bars from before the symbol's loaded bars, oldest first, each complete before the replay's start:
   * empty until loaded, and when the chart's candles cannot be built from them (a 5m chart of 30m bars).
   */
  bars: readonly Bar[];
  /** Their bar size (historyTimeframe). */
  timeframe: Timeframe;
  /** 'idle' until a chart asks for it (loadHistory), then 'loading', then 'ready' or 'failed' (see `error`). */
  status: 'idle' | 'loading' | 'ready' | 'failed';
  error: string | null;
  /** Whether the chart wants more history than the loaded bars cover (its timeframe's DEFAULT_LOOKBACK) and can use it. */
  wanted: boolean;
  /** The trading day the data begins on, when the chart wants history from before it and the data has none. */
  dataStart: string | null;
}

interface SymbolHistory {
  bars: readonly Bar[];
  timeframe: Timeframe;
  status: ChartHistory['status'];
  error: string | null;
  /** The trading day the loaded bars were asked from (their range starts at its pre-market). */
  baseFrom: string;
  /** Trading days before the start the loaded bars were asked to cover. */
  baseDays: number;
  /** The trading day of the first loaded bar. */
  baseStart: string;
  /** The trading day the data begins on, once a request for earlier days came back without them. */
  dataStart: string | null;
  loading: Promise<void> | null;
}

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

/** How many recent sessions of revealed bars tell the hours of the day the data trades in. */
const HOURS_SESSIONS = 5;

export class ReplaySession {
  readonly broker: SimBroker;
  readonly engines: ReadonlyMap<string, ReplayEngine>;
  rewinds = 0;
  /** Oldest first. The first is the clean start, which Restart returns to. */
  private checkpoints: Checkpoint[] = [];
  /** The data's trading hours (tradingHours), as worked out on the exchange day `date`. */
  private hours: { date: string; open: number; close: number } | null = null;
  /** Where history for higher timeframes comes from (set by load; sessions built from bars have none). */
  private provider: HistoricalDataProvider | null = null;
  private histories = new Map<string, SymbolHistory>();

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
    const start = exchangeTimeToUnix(date, parseHHMM(setup.startTime));
    const endDate = setup.endDate && setup.endDate >= date ? setup.endDate : date;
    const end = exchangeTimeToUnix(endDate, parseHHMM(setup.endTime));
    if (end <= start) throw new Error('End time must be after the start time.');
    const to = Math.max(end, exchangeTimeToUnix(endDate, AFTERHOURS_CLOSE));

    const symbols = [symbol, ...(setup.extraSymbols ?? []).map((s) => s.toUpperCase()).filter((s) => s !== symbol)];
    const warnings: string[] = [];
    const engines: ReplayEngine[] = [];
    const histories = new Map<string, SymbolHistory>();
    for (const sym of symbols) {
      try {
        const base = provider.baseTimeframe(sym);
        const timeframe = historyTimeframe(base);
        // Months of 1-minute bars would take long to load and chart: past a few weeks, history comes coarser.
        const baseDays = timeframe === base ? setup.lookbackDays : Math.min(setup.lookbackDays, BASE_LOOKBACK_LIMIT);
        let from = date;
        for (let i = 0; i < baseDays; i++) from = prevTradingDay(from);
        const bars = await provider.getBars({ symbol: sym, from: exchangeTimeToUnix(from, PREMARKET_OPEN), to }, signal);
        if (bars.length === 0) throw new Error(`No ${sym} data for ${date}. Pick another date or data source.`);
        engines.push(new ReplayEngine({ symbol: sym, start, end, baseTimeframe: base }, bars));
        const baseStart = exchangeDate(bars.reduce((t, b) => Math.min(t, b.time), Infinity));
        // Data that begins after the first day asked for has nothing earlier to load either.
        const dataStart = baseStart > from ? baseStart : null;
        histories.set(sym, { bars: [], timeframe, status: dataStart ? 'ready' : 'idle', error: null, baseFrom: from, baseDays, baseStart, dataStart, loading: null });
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        if (sym === symbol) throw e;
        warnings.push(`${sym} skipped: ${(e as Error).message}`);
      }
    }
    const source = provider.source === 'DEMO' ? 'DEMO' : 'HISTORICAL';
    const session = new ReplaySession(engines, { ...setup, symbol, date, endDate }, config, sessionId, source);
    session.provider = provider;
    session.histories = histories;
    return { session, warnings };
  }

  /** Trading days before the start the history reaches back. */
  private historyDays(): number {
    return Math.max(HISTORY_DAYS, this.setup.lookbackDays);
  }

  /**
   * What a `timeframe` chart of `symbol` can draw from before the loaded bars (null for a session
   * without a data provider, or an unknown symbol). The bars are all complete before the replay's
   * start, so they never show anything a trader at the replay's clock could not have seen.
   */
  chartHistory(symbol: string, timeframe: Timeframe): ChartHistory | null {
    const sym = symbol.toUpperCase();
    const h = this.histories.get(sym);
    const engine = this.engines.get(sym);
    if (!h || !engine) return null;
    // The size of the chart's candles: its timeframe, or the data's bars when those are coarser.
    const shown = TIMEFRAMES[Math.max(TIMEFRAMES.indexOf(timeframe), TIMEFRAMES.indexOf(engine.baseTimeframe))];
    const fits = TIMEFRAMES.indexOf(shown) >= TIMEFRAMES.indexOf(h.timeframe);
    const days = DEFAULT_LOOKBACK[shown];
    let wantedFrom = this.setup.date;
    for (let i = 0; i < days; i++) wantedFrom = prevTradingDay(wantedFrom);
    return {
      bars: fits ? h.bars : [],
      timeframe: h.timeframe,
      status: h.status,
      error: h.error,
      wanted: fits && days > h.baseDays,
      dataStart: h.dataStart !== null && h.dataStart > wantedFrom ? h.dataStart : null,
    };
  }

  /**
   * Loads `symbol`'s history for higher timeframes: bars of historyTimeframe from HISTORY_DAYS trading
   * days before the start (or the setup's longer lookback) up to the loaded bars. Only bars that end
   * before the loaded bars begin, and so before the start, are kept, whatever the data source returns.
   * A load already under way is shared; a failed one can be tried again.
   */
  loadHistory(symbol: string, signal?: AbortSignal): Promise<void> {
    const sym = symbol.toUpperCase();
    const h = this.histories.get(sym);
    const engine = this.engines.get(sym);
    const provider = this.provider;
    if (!h || !engine || !provider || h.status === 'ready') return Promise.resolve();
    if (h.loading) return h.loading;
    let from = h.baseFrom;
    for (let i = h.baseDays; i < this.historyDays(); i++) from = prevTradingDay(from);
    const req: BarRequest = { symbol: sym, from: exchangeTimeToUnix(from, PREMARKET_OPEN), to: exchangeTimeToUnix(h.baseFrom, PREMARKET_OPEN) };
    if (req.from >= req.to) {
      h.status = 'ready';
      return Promise.resolve();
    }
    h.status = 'loading';
    h.error = null;
    const base = engine.baseTimeframe;
    h.loading = (async () => {
      try {
        const raw =
          h.timeframe === base ? await provider.getBars(req, signal) : provider.getCoarseBars ? await provider.getCoarseBars(req, h.timeframe, signal) : aggregateBars(await provider.getBars(req, signal), h.timeframe, base);
        const limit = Math.min(req.to, this.start);
        const bars = raw.filter((b) => b.time >= req.from && barEndTime(b, h.timeframe) <= limit).sort((a, b) => a.time - b.time);
        h.bars = Object.freeze(bars.map((b) => Object.freeze({ ...b })));
        h.status = 'ready';
        const first = bars.length ? exchangeDate(bars[0].time) : h.baseStart;
        if (first > from) h.dataStart = first;
      } catch (e) {
        h.status = 'failed';
        h.error = (e as Error).name === 'AbortError' ? 'Loading was cancelled.' : (e as Error).message;
      } finally {
        h.loading = null;
      }
    })();
    return h.loading;
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
    const keyed = bars.map((r) => ({ r, end: r.bar.time + this.engines.get(r.symbol)!.barSeconds(r.bar), rank: rank.get(r.symbol)! }));
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

  /** Reveal the next base bar (the earliest across symbols, e.g. one minute), or go to the end time when no bar is left before it. */
  step(): RevealedBar[] {
    return this.advanceAll(this.nextRevealTime() ?? this.end);
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
   * Advance simulated time by `seconds` (used by Play). Time outside the data's trading hours (nights,
   * weekends, holidays, and the pre-market or after-hours of data that has none) is skipped by the
   * calendar, so multi-day replays don't sit on an empty chart. Inside those hours time passes at the
   * chosen speed whether bars come or not, whatever the base timeframe (an hourly or daily bar takes
   * its hour or session): skipping a quiet stretch to the next bar would tell how long a halt lasts.
   */
  advance(seconds: number): RevealedBar[] {
    let target = this.now + seconds;
    const resume = this.hoursResume(this.now);
    if (resume !== null && resume > target) target = resume;
    return this.advanceAll(target);
  }

  /**
   * The part of the exchange day the replay's data trades in, in minutes: from the earliest bar opening
   * to the latest bar ending in the last few sessions of bars already revealed (what a trader knows of a
   * stock's hours from its recent past), widened to the setup's start and end times when they make a
   * daily window (a replay set to run to 20:00 is watched after hours). With nothing to go by, the
   * whole extended session.
   */
  private tradingHours(): { open: number; close: number } {
    const date = exchangeDate(this.now);
    if (this.hours?.date === date) return this.hours;
    let from = date;
    for (let i = 0; i < HOURS_SESSIONS; i++) from = prevTradingDay(from);
    const since = exchangeTimeToUnix(from, 0);
    let open = Infinity;
    let close = -Infinity;
    for (const e of this.engines.values()) {
      for (const bar of e.revealedSince(since)) {
        const m = exchangeMinuteOfDay(bar.time);
        open = Math.min(open, m);
        close = Math.max(close, Math.min(24 * 60, m + e.barSeconds(bar) / 60));
      }
    }
    const start = parseHHMM(this.setup.startTime);
    const end = parseHHMM(this.setup.endTime);
    if (end > start) {
      open = Math.min(open, start);
      close = Math.max(close, end);
    }
    if (open === Infinity) {
      open = PREMARKET_OPEN;
      close = AFTERHOURS_CLOSE;
    }
    this.hours = { date, open, close };
    return this.hours;
  }

  /** When the data's trading hours next begin, if `t` is outside them; null while they last. */
  private hoursResume(t: UnixSeconds): UnixSeconds | null {
    const { open, close } = this.tradingHours();
    const date = exchangeDate(t);
    const m = exchangeMinuteOfDay(t);
    if (isTradingDay(date)) {
      // On an early-close day the regular session, and the after-hours with it, end earlier.
      const shut = close <= REGULAR_CLOSE ? Math.min(close, regularCloseMinute(date)) : Math.min(close + regularCloseMinute(date) - REGULAR_CLOSE, afterHoursCloseMinute(date));
      if (m < open) return exchangeTimeToUnix(date, open);
      if (m < shut) return null;
    }
    return exchangeTimeToUnix(nextTradingDay(date), open);
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
    this.hours = null;
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
