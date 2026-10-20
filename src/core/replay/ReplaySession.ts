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
import { DataProviderError, type BarRequest, type HistoricalDataProvider } from '../data/provider';
import { aggregateBars } from '../data/aggregate';
import { DEFAULT_EXECUTION_CONFIG, type ExecutionConfig } from '../broker/config';
import { SimBroker, type BrokerCheckpoint, type BrokerState, type SubmitResult } from '../broker/SimBroker';
import { ReplayEngine, barEndTime } from './ReplayEngine';
import {
  AFTERHOURS_CLOSE,
  PREMARKET_OPEN,
  REGULAR_CLOSE,
  addDays,
  afterHoursCloseMinute,
  exchangeDate,
  exchangeMinuteOfDay,
  exchangeTimeToUnix,
  formatExchangeTime,
  isTradingDay,
  lastCompletedTradingDay,
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

/**
 * Trading days of data at its own bar size (`base`) a replay loads before its start for a lookback of
 * `lookbackDays`: all of them when the data is as coarse as the history, else at most BASE_LOOKBACK_LIMIT.
 */
export function loadedDays(base: Timeframe, lookbackDays: number): number {
  return historyTimeframe(base) === base ? lookbackDays : Math.min(lookbackDays, BASE_LOOKBACK_LIMIT);
}

/**
 * The last trading day `provider` has `symbol`'s data for: where its availableRange ends, or, for a
 * source that does not say (a vendor), the last trading day that has ended by `now`.
 */
export async function lastDataDay(provider: HistoricalDataProvider, symbol: string, now = new Date()): Promise<string> {
  const range = await provider.availableRange(symbol.toUpperCase());
  return tradingDayOnOrBefore(range ? exchangeDate(range.to) : lastCompletedTradingDay(now));
}

/**
 * The last trading day on or before `day` that `provider` has `symbol`'s bars on: that day, or, for data that
 * can skip days (an imported file's sessionDates), the last day before it it has bars on (`day` itself when it
 * has none before).
 */
async function dayWithBars(provider: HistoricalDataProvider, symbol: string, day: string): Promise<string> {
  const d = tradingDayOnOrBefore(day);
  const dates = await provider.sessionDates?.(symbol);
  if (!dates) return d;
  let best: string | null = null;
  for (const x of dates) if (x <= d && (best === null || x > best)) best = x;
  return best ?? d;
}

/** Where a replay's clock starts and ends, and up to when its bars are asked for (see ReplaySession.load). */
interface LoadWindow {
  date: string;
  start: UnixSeconds;
  end: UnixSeconds;
  to: UnixSeconds;
  lookbackDays: number;
  preview?: boolean;
}

/** Trading days before the start the history reaches back (a daily chart's lookback, or a longer one asked for). */
export const HISTORY_DAYS = DEFAULT_LOOKBACK['1D'];

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

/** Bars one engine revealed, oldest first, from its bar index `from` on, with when each ends. */
interface Batch {
  symbol: string;
  from: number;
  bars: Bar[];
  ends: UnixSeconds[];
}

export interface Checkpoint {
  /** Bars revealed by each engine (engine order) when it was taken. */
  cursors: number[];
  /**
   * The replay's time when it was taken. Orders placed while the replay is paused inside a bar share
   * that bar's reveal point, so a rewind to an earlier moment there must not take it.
   */
  time: UnixSeconds;
  /** Their sum. */
  revealed: number;
  broker: BrokerCheckpoint;
  /** The execution settings the bars after it were processed with. */
  config: ExecutionConfig;
}

/** A replay session's state as plain data (ReplaySession.save), to carry it on later (ReplaySession.resume). */
export interface SavedReplay {
  /** The setup it was loaded with, its symbol and dates as loaded. */
  setup: ReplaySetup;
  /** The symbols it loaded, primary first. */
  symbols: string[];
  /** Each symbol's data (ReplayEngine.fingerprint), to tell the same data is loaded again. */
  data: number[];
  /** Each symbol's clock and bars revealed. */
  nows: UnixSeconds[];
  cursors: number[];
  rewinds: number;
  broker: BrokerState;
  /** The undo history, oldest first. Checkpoints never change once taken: these are the session's own. */
  checkpoints: Checkpoint[];
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
      if (last) this.broker.onBar(e.symbol, last, e.revealedEnds(e.revealedCount - 1, e.revealedCount)[0] - last.time);
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
    const { engines, histories, warnings } = await ReplaySession.loadSymbols(provider, symbols, { date, start, end, to, lookbackDays: setup.lookbackDays }, signal);
    const session = new ReplaySession(engines, { ...setup, symbol, date, endDate }, config, sessionId, provider.source === 'DEMO' ? 'DEMO' : 'HISTORICAL');
    session.provider = provider;
    session.histories = histories;
    return { session, warnings };
  }

  /**
   * `symbol`'s chart as a replay's chart shows it, with the clock at the end of its data (lastDataDay):
   * the bars of that last day and of the trading days a replay with `lookbackDays` loads before its
   * start, every one revealed, and the history for higher timeframes as a replay loads it (chartHistory,
   * loadHistory). For looking at a chart before any replay starts: nothing plays in it, and it is never
   * traded (its account is its own, and stays empty). With an `endDay` before the data's last day, it ends
   * at the end of that day instead (of the last day before it with bars, for data with gaps), its days
   * before it and its history with it: a chart that must show nothing after a moment of that day (a replay
   * not finished: tradingStore's BrowseHold) has the days before it to show.
   */
  static async preview(provider: HistoricalDataProvider, setup: { symbol: string; lookbackDays: number; endDay?: string }, signal?: AbortSignal, now = new Date()): Promise<ReplaySession> {
    const symbol = setup.symbol.toUpperCase();
    const last = await lastDataDay(provider, symbol, now);
    const date = setup.endDay !== undefined && setup.endDay < last ? await dayWithBars(provider, symbol, setup.endDay) : last;
    // The end of that day: every bar of it has ended by then, whatever its hours.
    const clock = exchangeTimeToUnix(addDays(date, 1), 0);
    const { engines, histories } = await ReplaySession.loadSymbols(provider, [symbol], { date, start: clock, end: clock, to: clock, lookbackDays: setup.lookbackDays, preview: true }, signal);
    // Its times are never read: the clock sits at the end of the day, and nothing plays.
    const session = new ReplaySession(engines, { symbol, date, startTime: '24:00', endTime: '24:00', startingBalance: 0, lookbackDays: setup.lookbackDays }, DEFAULT_EXECUTION_CONFIG, 'preview', provider.source === 'DEMO' ? 'DEMO' : 'HISTORICAL');
    session.provider = provider;
    session.histories = histories;
    return session;
  }

  /**
   * Each of `symbols`' engine over `w` and the record of its history for higher timeframes. Symbols after
   * the first that fail to load are skipped and reported in `warnings`; the first one's failure is thrown.
   */
  private static async loadSymbols(provider: HistoricalDataProvider, symbols: string[], w: LoadWindow, signal?: AbortSignal): Promise<{ engines: ReplayEngine[]; histories: Map<string, SymbolHistory>; warnings: string[] }> {
    const warnings: string[] = [];
    const engines: ReplayEngine[] = [];
    const histories = new Map<string, SymbolHistory>();
    for (const sym of symbols) {
      try {
        const base = provider.baseTimeframe(sym);
        const timeframe = historyTimeframe(base);
        // Months of 1-minute bars would take long to load and chart: past a few weeks, history comes coarser.
        const baseDays = loadedDays(base, w.lookbackDays);
        let from = w.date;
        for (let i = 0; i < baseDays; i++) from = prevTradingDay(from);
        const bars = await provider.getBars({ symbol: sym, from: exchangeTimeToUnix(from, PREMARKET_OPEN), to: w.to }, signal);
        // No bars at all over the days asked for: a ticker the source does not have, or a date it has none for.
        if (bars.length === 0) throw new DataProviderError(`No ${sym} data for ${w.date}. Pick another date or data source.`, 'not_found');
        engines.push(new ReplayEngine({ symbol: sym, start: w.start, end: w.end, baseTimeframe: base, preview: w.preview }, bars));
        const baseStart = exchangeDate(bars.reduce((t, b) => Math.min(t, b.time), Infinity));
        // Data that begins after the first day asked for has nothing earlier to load either.
        const dataStart = baseStart > from ? baseStart : null;
        histories.set(sym, { bars: [], timeframe, status: dataStart ? 'ready' : 'idle', error: null, baseFrom: from, baseDays, baseStart, dataStart, loading: null });
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        if (sym === symbols[0]) throw e;
        warnings.push(`${sym} skipped: ${(e as Error).message}`);
      }
    }
    return { engines, histories, warnings };
  }

  /**
   * The session's state as plain data, as it is now, to save and carry on later (resume): each symbol's
   * clock, the account with its undo history, and what tells that the same data is loaded again. The
   * account is a copy; the checkpoints and settings, which never change once made, are the session's
   * own, so a long undo history is stored a checkpoint at a time rather than copied whole each time.
   */
  save(): SavedReplay {
    const engines = [...this.engines.values()];
    return {
      setup: structuredClone(this.setup),
      symbols: this.symbols,
      data: engines.map((e) => e.fingerprint()),
      nows: engines.map((e) => e.now),
      cursors: this.cursors(),
      rewinds: this.rewinds,
      broker: this.broker.getState(),
      checkpoints: this.checkpoints.slice(),
      config: this.broker.cfg,
    };
  }

  /**
   * Carries on a session saved with save(): loads the same data again from `provider` and puts each
   * symbol's clock, the account and its undo history back as they were, bars revealed as far as they
   * had been and no further. Its checkpoints become the session's. Throws, with a message for the
   * user, when it cannot carry on exactly: the data is not what the session was played on any more
   * (imported again, or changed by its source), or a symbol no longer loads.
   */
  static async resume(provider: HistoricalDataProvider, saved: SavedReplay, sessionId: string, signal?: AbortSignal): Promise<ReplaySession> {
    const n = Array.isArray(saved?.symbols) ? saved.symbols.length : 0;
    const lists = [saved?.data, saved?.nows, saved?.cursors];
    if (!n || lists.some((l) => !Array.isArray(l) || l.length !== n) || !Array.isArray(saved.checkpoints) || !saved.checkpoints.length || !saved.broker || !saved.config) {
      throw new Error('This saved session could not be read.');
    }
    // The broker trades under the settings the session last had (later bars are processed with them).
    const { session, warnings } = await ReplaySession.load(provider, { ...saved.setup, extraSymbols: saved.symbols.slice(1) }, saved.config, sessionId, signal);
    const engines = [...session.engines.values()];
    for (const [k, sym] of saved.symbols.entries()) {
      const e = engines[k];
      if (e?.symbol !== sym) throw new Error(warnings.find((w) => w.startsWith(sym)) ?? `${sym} could not be loaded.`);
      if (e.fingerprint() !== saved.data[k]) {
        throw new Error(`The ${sym} data is not what this session was played on any more (it was imported again, or its source changed it), so the session cannot carry on.`);
      }
      // The clock moves as Play would move it, revealing only bars that had ended by then.
      e.advanceTo(saved.nows[k]);
      if (e.revealedCount !== saved.cursors[k] || e.now !== saved.nows[k]) throw new Error('This saved session does not match its data, so it cannot carry on.');
    }
    session.broker.restore(saved.broker);
    session.checkpoints = saved.checkpoints.slice();
    session.rewinds = saved.rewinds;
    return session;
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

  /**
   * A checkpoint at the reveal point `cursors` and time `time` (by default the current ones). A later one
   * at the same point and time replaces it (not the start's).
   */
  private checkpoint(cursors = this.cursors(), time = this.now): void {
    const last = this.checkpoints[this.checkpoints.length - 1];
    if (this.checkpoints.length > 1 && last.time === time && last.cursors.every((c, i) => c === cursors[i])) this.checkpoints.pop();
    this.checkpoints.push({ cursors, time, revealed: cursors.reduce((a, b) => a + b, 0), broker: this.broker.checkpoint(), config: this.broker.cfg });
  }

  /**
   * Feed bars to `broker` in the order they completed (then by open time, then engine order, primary
   * first). Every reveal hands over all bars completed by the new time, so feeding a replay range at
   * once gives the same order as revealing it step by step did. `batches` are in engine order, each
   * oldest first, so they are merged rather than sorted. With `checkpoints`, a checkpoint is taken
   * whenever CHECKPOINT_BARS have gone by since the last, once every bar ending at that moment is in,
   * as revealing the range step by step would have: a rewind after a long jump replays only a few bars.
   */
  private process(broker: SimBroker, batches: Batch[], checkpoints = false): RevealedBar[] {
    const out: RevealedBar[] = [];
    const next = batches.map(() => 0);
    const total = batches.reduce((n, b) => n + b.bars.length, 0);
    // Bars revealed, over every engine, before the first of these.
    const before = batches.reduce((n, b) => n + b.from, 0);
    for (let n = 0; n < total; n++) {
      let k = -1;
      for (let j = 0; j < batches.length; j++) {
        const i = next[j];
        if (i >= batches[j].bars.length) continue;
        if (k < 0) {
          k = j;
          continue;
        }
        const end = batches[j].ends[i];
        const best = batches[k].ends[next[k]];
        // Ties go to the earlier batch: engine order.
        if (end < best || (end === best && batches[j].bars[i].time < batches[k].bars[next[k]].time)) k = j;
      }
      const b = batches[k];
      const i = next[k]++;
      broker.onBar(b.symbol, b.bars[i], b.ends[i] - b.bars[i].time);
      out.push({ symbol: b.symbol, bar: b.bars[i] });
      if (!checkpoints || n === total - 1 || before + n + 1 - this.checkpoints[this.checkpoints.length - 1].revealed < CHECKPOINT_BARS) continue;
      // Once the next bar to go in ends later: every bar ending at this moment is in.
      if (batches.every((c, j) => next[j] >= c.bars.length || c.ends[next[j]] > b.ends[i])) this.checkpoint(batches.map((c, j) => c.from + next[j]), b.ends[i]);
    }
    return out;
  }

  /**
   * The bars `reveal` gives for each engine, in engine order, as batches: the bars it just revealed (with
   * one of its reveal methods), which are its newest.
   */
  private reveal(reveal: (e: ReplayEngine) => Bar[]): Batch[] {
    return [...this.engines.values()].map((e) => {
      const bars = reveal(e);
      const from = e.revealedCount - bars.length;
      return { symbol: e.symbol, from, bars, ends: e.revealedEnds(from, from + bars.length) };
    });
  }

  /** Feed newly revealed bars to the broker. */
  private feed(batches: Batch[]): RevealedBar[] {
    const out = this.process(this.broker, batches, true);
    const revealedNow = this.cursors().reduce((a, b) => a + b, 0);
    if (revealedNow - this.checkpoints[this.checkpoints.length - 1].revealed >= CHECKPOINT_BARS) this.checkpoint();
    return out;
  }

  /** The newest checkpoint at or before the reveal point `cursors` and the time `time`. */
  private checkpointAt(cursors: number[], time: UnixSeconds): number {
    for (let i = this.checkpoints.length - 1; i > 0; i--) {
      const cp = this.checkpoints[i];
      if (cp.time <= time && cp.cursors.every((c, k) => c <= cursors[k])) return i;
    }
    return 0;
  }

  /** Bring `broker`, rolled back to `cp`, up to the reveal point `cursors` with the bars in between. */
  private replayFrom(broker: SimBroker, cp: Checkpoint, cursors: number[]): void {
    const batches = [...this.engines.values()].map((e, k) => ({
      symbol: e.symbol,
      from: cp.cursors[k],
      bars: e.revealedBars(cp.cursors[k], cursors[k]),
      ends: e.revealedEnds(cp.cursors[k], cursors[k]),
    }));
    const config = broker.cfg;
    broker.cfg = cp.config;
    this.process(broker, batches);
    broker.cfg = config;
  }

  /** Move every engine's clock to `target`, revealing completed bars. */
  private advanceAll(target: UnixSeconds): RevealedBar[] {
    return this.feed(this.reveal((e) => e.advanceTo(target)));
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

  /**
   * Reveal one full candle of `timeframe` on `symbol` (default: primary); others follow the clock. A symbol
   * with no bar left that completes by the end time steps as Step does.
   */
  stepCandle(timeframe: Timeframe, symbol = this.symbol): RevealedBar[] {
    const e = this.engineFor(symbol) ?? this.engine;
    // A symbol whose data has ended, or whose next bar ends after the end time (today's daily bar in a
    // replay that ends at noon), has no candle to complete: the replay moves on as Step does, rather
    // than taking every other symbol to the end with it.
    if (!e.nextBarCompletesBy(this.end)) return this.step();
    // The engines go in their order, so the others are taken to the candle's end only once it is known.
    const own = e.stepCandle(timeframe);
    return this.feed(this.reveal((other) => (other === e ? own : other.advanceTo(e.now))));
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
    // A time before the start goes to the start, as the engines' clocks do.
    const cp = this.checkpoints[restart ? 0 : this.checkpointAt(target, Math.max(time, this.start))];
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
    // A time before the start goes to the start, as the engines' clocks do, orders placed there included.
    const i = restart ? 0 : this.checkpointAt(cursors, Math.max(time, this.start));
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
    // No date: the log's time column already gives the day, and hides it in blind mode. A time before
    // the start is given as the start, where the clock now is.
    this.broker.logInfo(`Rewound to ${formatExchangeTime(Math.max(time, this.start))} ET. Results after a rewind are not blind.`);
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
