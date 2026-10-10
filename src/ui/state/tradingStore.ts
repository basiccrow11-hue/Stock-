/**
 * The active trading session (historical replay or simulated market) and its play loop.
 *
 * Engine objects (ReplaySession, SimMarket, SimBroker) live outside React. After every change we
 * publish a plain snapshot to the zustand store for the UI, and push bar updates to the chart over
 * a small event bus so the chart can update incrementally instead of re-rendering.
 */
import { create } from 'zustand';
import { bucketFor, ownCandles } from '../../core/data/aggregate';
import { TIMEFRAMES, type AccountSnapshot, type Bar, type DataSourceKind, type EquityPoint, type Fill, type Order, type OrderRequest, type Position, type RoundTrip, type Timeframe, type UnixSeconds } from '../../core/types';
import { ReplaySession, type ChartHistory, type ReplaySetup } from '../../core/replay/ReplaySession';
import { SimBroker, describe as describeOrder, type BrokerEvent, type SubmitResult, type TradeRisk } from '../../core/broker/SimBroker';
import { SimulationDataProvider } from '../../core/data/simulationProvider';
import type { SimConfig, SimEvent } from '../../core/sim/SimMarket';
import { journalEntryFromTrip, type JournalEntry } from '../../core/journal';
import { reviewTrade, type TradeReview, type TradingRules } from '../../core/learning/review';
import { CHALLENGES, evaluateChallenge } from '../../core/challenges/challenges';
import { exchangeDate, isTradingDay, marketSession, nextTradingDay, prevTradingDay, withoutDates } from '../../core/time';
import { getProvider } from './dataRegistry';
import { getSettings, useSettings } from './settingsStore';
import { useJournal, saveSnapshot } from './journalStore';
import { useChallenges } from './challengeStore';
import { toast } from './toasts';
import { recordTradeClosed } from './streakStore';
import { setLiveBlind } from './liveBlind';
import { newId } from '../../core/util/ids';

export type SessionMode = 'replay' | 'sim';

export interface SessionMeta {
  id: string;
  mode: SessionMode;
  source: DataSourceKind;
  symbols: string[];
  start: UnixSeconds;
  end: UnixSeconds | null;
  startDate: string;
  blind: boolean;
  challengeId?: string;
  label: string;
}

export interface Quote {
  last: number;
  prevClose: number | null;
  changePct: number | null;
  time: UnixSeconds;
}

export interface TradingSnapshot {
  session: SessionMeta | null;
  activeSymbol: string;
  timeframe: Timeframe;
  playing: boolean;
  speed: number;
  now: UnixSeconds;
  finished: boolean;
  rewinds: number;
  account: AccountSnapshot | null;
  positions: Position[];
  orders: Order[];
  fills: Fill[];
  trips: RoundTrip[];
  events: BrokerEvent[];
  equityCurve: EquityPoint[];
  quotes: Record<string, Quote>;
  simEvents: SimEvent[];
  version: number;
  loading: boolean;
  error: string | null;
  warnings: string[];
  /** Journal entry id whose learning review should be shown. */
  reviewId: string | null;
  /** Reviews of other trades that closed in the same step, shown after it in turn. */
  reviewQueue: string[];
  /** Learning Mode reviews of trades that have closed but are still being written to the journal. */
  reviewsPending: number;
  /** Order-ticket field waiting for a price click on the chart. */
  pickTarget: 'limit' | 'stop' | 'stopLoss' | 'takeProfit' | null;
  pickedPrice: { field: string; price: number; seq: number } | null;
}

// ------------------------------------------------------------------ chart bus

/**
 * `tick` carries the simulated 1m bars a step touched, oldest first, each in its latest state: the
 * forming bar is re-sent with cumulative values, and a fast step can finish several minutes at once.
 * `history` says the bars from before a replay's loaded bars (getChartHistory) arrived for `symbol`,
 * or failed to.
 */
export type ChartEvent = { type: 'reset' } | { type: 'append'; symbol: string; bars: Bar[] } | { type: 'tick'; symbol: string; bars: Bar[] } | { type: 'history'; symbol: string };
type ChartListener = (e: ChartEvent) => void;
const chartListeners = new Set<ChartListener>();
export function onChartEvent(fn: ChartListener): () => void {
  chartListeners.add(fn);
  return () => chartListeners.delete(fn);
}
function emitChart(e: ChartEvent): void {
  for (const l of chartListeners) l(e);
}

/** Snapshot provider registered by the chart (used to attach images to journal entries). */
let snapshotFn: (() => Promise<string | null>) | null = null;
export function registerSnapshotProvider(fn: (() => Promise<string | null>) | null): void {
  snapshotFn = fn;
}

// ------------------------------------------------------------------ engine state (non-reactive)

interface Engines {
  replay: ReplaySession | null;
  sim: SimulationDataProvider | null;
  simBroker: SimBroker | null;
  processedTrips: Set<string>;
  /** Journal entries whose review waits for price after the exit, with the timeframe and trading rules it was made with. */
  watching: Map<string, { timeframe: Timeframe; rules: TradingRules }>;
  /** Orders whose cancellation (a position the other way opened before they filled) was announced. */
  noticedConflicts: Set<string>;
  timer: ReturnType<typeof setInterval> | null;
  lastTick: number;
  lastPublish: number;
  simCarry: number;
  /** Previous session close per symbol for % change. */
  prevClose: Record<string, number>;
}

const eng: Engines = {
  replay: null,
  sim: null,
  simBroker: null,
  processedTrips: new Set(),
  watching: new Map(),
  noticedConflicts: new Set(),
  timer: null,
  lastTick: 0,
  lastPublish: 0,
  simCarry: 0,
  prevClose: {},
};

// The top speed plays one regular session (6.5 hours) per second, which suits daily bars.
export const REPLAY_SPEEDS = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 23400];
export const SIM_SPEEDS = [1, 2, 5, 10, 30, 60, 120, 300];

const EMPTY: TradingSnapshot = {
  session: null,
  activeSymbol: 'SPY',
  timeframe: '1m',
  playing: false,
  speed: 60,
  now: 0,
  finished: false,
  rewinds: 0,
  account: null,
  positions: [],
  orders: [],
  fills: [],
  trips: [],
  events: [],
  equityCurve: [],
  quotes: {},
  simEvents: [],
  version: 0,
  loading: false,
  error: null,
  warnings: [],
  reviewId: null,
  reviewQueue: [],
  reviewsPending: 0,
  pickTarget: null,
  pickedPrice: null,
};

export const useTrading = create<TradingSnapshot>()(() => ({ ...EMPTY }));

// Other open tabs keep this tab's running blind session's dates hidden too (they share the journal).
useTrading.subscribe((s, prev) => {
  if (s.session !== prev.session) setLiveBlind(s.session?.blind ? { id: s.session.id, start: s.session.startDate } : null);
});

function broker(): SimBroker | null {
  return eng.replay?.broker ?? eng.simBroker;
}

// ------------------------------------------------------------------ data access for the chart

/** Revealed base bars for a symbol (replay) or generated history (sim). Never future data. */
export function getBaseBars(symbol: string): Bar[] {
  if (eng.replay) return eng.replay.engineFor(symbol)?.visibleBaseBars() ?? [];
  if (eng.sim) return eng.sim.getHistory(symbol);
  return [];
}

/**
 * What a `timeframe` chart of `symbol` draws from before the replay's loaded bars (ReplaySession.chartHistory),
 * or null outside a replay. The first chart that wants it starts loading it (`retry`: again after a
 * failure), and a 'history' chart event says when it has arrived.
 */
export function getChartHistory(symbol: string, timeframe: Timeframe, retry = false): ChartHistory | null {
  const replay = eng.replay;
  const h = replay?.chartHistory(symbol, timeframe);
  if (!replay || !h) return null;
  if (!h.wanted || !(h.status === 'idle' || (retry && h.status === 'failed'))) return h;
  void replay.loadHistory(symbol).then(() => {
    if (eng.replay === replay) emitChart({ type: 'history', symbol });
  });
  return replay.chartHistory(symbol, timeframe);
}

/** The size of `symbol`'s base bars: the replay's data, or the simulated market's 1-minute bars. */
export function getBaseTimeframe(symbol: string): Timeframe {
  return eng.replay?.engineFor(symbol)?.baseTimeframe ?? '1m';
}

/**
 * Start of the candle holding time `t` on a `timeframe` chart of `symbol`: at the data's own bar
 * size, the revealed bar holding it (bars need not sit on the 09:30 grid), else its bucket.
 */
export function candleStartFor(symbol: string, t: UnixSeconds, timeframe: Timeframe): UnixSeconds {
  const e = eng.replay?.engineFor(symbol);
  if (e && ownCandles(timeframe, e.baseTimeframe)) return e.barStartAtOrBefore(t) ?? t;
  return bucketFor(t, timeframe).start;
}

export function getSimEventsFor(symbol: string): SimEvent[] {
  return eng.sim ? eng.sim.market.events.filter((e) => e.symbol === symbol || e.symbol === 'MARKET') : [];
}

/** "Day N" label used in blind mode: trading days from the start date of the blind session (default: this tab's). */
export function blindDayLabel(t: UnixSeconds, startDate = useTrading.getState().session?.startDate): string {
  if (!startDate) return 'Day ?';
  const d = exchangeDate(t);
  if (d === startDate) return 'Day 1';
  let n = 0;
  if (d > startDate) {
    let x = startDate;
    while (x < d && n < 400) {
      x = nextTradingDay(x);
      n++;
    }
    return `Day ${n + 1}`;
  }
  let x = startDate;
  while (x > d && n < 400) {
    x = prevTradingDay(x);
    n++;
  }
  return `Day −${n}`;
}

// ------------------------------------------------------------------ publish

function computeQuotes(): Record<string, Quote> {
  const out: Record<string, Quote> = {};
  const symbols = eng.replay ? eng.replay.symbols : eng.sim ? eng.sim.market.profiles.map((p) => p.symbol) : [];
  for (const sym of symbols) {
    const bars = eng.replay ? null : eng.sim!.getHistory(sym);
    const last = eng.replay ? eng.replay.engineFor(sym)?.lastBar() : bars![bars!.length - 1];
    if (!last) continue;
    const today = exchangeDate(last.time);
    let prev = eng.prevClose[`${sym}|${today}`];
    if (prev === undefined) {
      const all = eng.replay ? eng.replay.engineFor(sym)!.visibleBaseBars() : bars!;
      // The previous trading day's regular-session close, if visible (its last bar if it has no
      // regular-hours bars): with extended-hours data its last bar is an after-hours print.
      let i = all.length - 1;
      while (i >= 0 && exchangeDate(all[i].time) >= today) i--;
      if (i >= 0) {
        const day = exchangeDate(all[i].time);
        let j = i;
        while (j >= 0 && exchangeDate(all[j].time) === day && marketSession(all[j].time) !== 'regular') j--;
        prev = (j >= 0 && exchangeDate(all[j].time) === day ? all[j] : all[i]).close;
      }
      if (prev !== undefined) eng.prevClose[`${sym}|${today}`] = prev;
    }
    out[sym] = { last: last.close, prevClose: prev ?? null, changePct: prev ? (last.close / prev - 1) * 100 : null, time: last.time };
  }
  return out;
}

let trailingPublish: ReturnType<typeof setTimeout> | null = null;

/**
 * The broker extends its equity curve and updates the latest point in place, so the UI gets a copy,
 * new whenever the curve changed (charts redraw only when the array does).
 */
let curveSeen: { src: EquityPoint[]; length: number; time?: number; equity?: number; copy: EquityPoint[] } | null = null;
function publishedCurve(src: EquityPoint[]): EquityPoint[] {
  const last = src[src.length - 1];
  const c = curveSeen;
  if (c && c.src === src && c.length === src.length && c.time === last?.time && c.equity === last?.equity) return c.copy;
  const copy = src.slice();
  if (last) copy[copy.length - 1] = { ...last };
  curveSeen = { src, length: src.length, time: last?.time, equity: last?.equity, copy };
  return copy;
}

/** Tells the user about working orders the broker cancelled (Order.conflict says when). */
function announceConflicts(orders: readonly Order[]): void {
  for (const o of orders) {
    if (!o.conflict || eng.noticedConflicts.has(o.id)) continue;
    eng.noticedConflicts.add(o.id);
    toast('warning', `${describeOrder(o)} cancelled. ${o.rejectReason ?? ''}`, 8000);
  }
}

function publish(force = false): void {
  const b = broker();
  const nowMs = performance.now();
  if (!force && nowMs - eng.lastPublish < 90) {
    // Throttled: make sure the latest state still reaches the UI (trailing publish).
    if (!trailingPublish) trailingPublish = setTimeout(() => publish(true), 90 - (nowMs - eng.lastPublish));
    return;
  }
  if (trailingPublish) {
    clearTimeout(trailingPublish);
    trailingPublish = null;
  }
  eng.lastPublish = nowMs;
  if (!b) {
    useTrading.setState({ account: null, positions: [], orders: [], fills: [], trips: [] });
    return;
  }
  const st = b.state;
  const now = eng.replay ? eng.replay.now : eng.sim ? eng.sim.market.clock : 0;
  const finished = eng.replay ? eng.replay.finished : false;
  useTrading.setState({
    now,
    finished,
    rewinds: eng.replay?.rewinds ?? 0,
    account: b.account(),
    positions: b.openPositions().map((p) => ({ ...p })),
    orders: st.orders.map((o) => ({ ...o })),
    fills: st.fills.slice(),
    trips: st.roundTrips.map((t) => ({ ...t })),
    events: st.events.slice(-200),
    equityCurve: publishedCurve(st.equityCurve),
    quotes: computeQuotes(),
    simEvents: eng.sim ? eng.sim.market.events.slice(-100) : [],
    version: st.version,
  });
  announceConflicts(st.orders);
  // A blind replay that has run to its end gives its date back: clock, chart, journal and exports.
  const meta = useTrading.getState().session;
  const revealed = finished && !!meta?.blind;
  if (finished && meta?.blind) {
    const last = exchangeDate(now);
    useTrading.setState({ session: { ...meta, blind: false, label: `${meta.symbols[0]} · ${meta.startDate}` } });
    toast('info', `Blind replay over: that was ${meta.symbols[0]} on ${last === meta.startDate ? meta.startDate : `${meta.startDate} to ${last}`}.`, 10_000);
  }
  if (finished && useTrading.getState().playing) {
    pause();
    if (!revealed) toast('info', 'Replay reached the end time.');
  }
  evaluateActiveChallenge();
}

// ------------------------------------------------------------------ journal + learning hooks

/** Journal writes for closed trades, one batch after another, so reviews queue in the order trades closed. */
let journaling: Promise<void> = Promise.resolve();

/**
 * Journals trades that closed since the last call. `ended`: they closed because the session is ending
 * (another one starts), so their reviews are final and Learning Mode does not stop to show them; they
 * are in the journal.
 */
function processClosedTrips(ended = false): Promise<void> {
  const b = broker();
  const session = useTrading.getState().session;
  if (!b || !session) return journaling;
  // In the order they closed, so reviews of trades closed in one step come in that order too.
  const closed = b.state.roundTrips.filter((t) => t.closed && !eng.processedTrips.has(t.id)).sort((x, y) => x.exitTime! - y.exitTime!);
  if (!closed.length) {
    settleWatchedReviews();
    return journaling;
  }
  // Claimed, reviewed and pictured now, as they closed. Learning Mode stops playback before anything
  // is awaited, so the replay does not run on while the journal is written.
  const settings = getSettings();
  const rules = reviewRules(session.id);
  const timeframe = useTrading.getState().timeframe;
  let picture: Promise<string | null> | null = null;
  const batch = closed.map((trip) => {
    eng.processedTrips.add(trip.id);
    const entry: JournalEntry = journalEntryFromTrip(trip, { sessionId: session.id, mode: session.mode, rewound: (eng.replay?.rewinds ?? 0) > 0, blind: session.blind });
    try {
      entry.review = reviewOf(trip, timeframe, ended, rules);
    } catch (e) {
      console.error('Review failed', e);
    }
    let snap: Promise<string | null> | null = null;
    if (settings.autoSnapshot && snapshotFn && useTrading.getState().activeSymbol === trip.symbol) {
      if (!picture) {
        // Publishing is throttled while playing; the picture shows the moment the trade closed.
        publish(true);
        picture = snapshotFn().catch(() => null);
      }
      snap = picture;
    }
    return { trip, entry, snap };
  });
  const showReviews = settings.learningMode && !ended;
  if (showReviews) {
    pause();
    // Other dialogs (a streak celebration) wait for these reviews rather than open just before them.
    useTrading.setState((s) => ({ reviewsPending: s.reviewsPending + batch.length }));
  }
  journaling = journaling
    .then(async () => {
      for (const { trip, entry, snap } of batch) {
        try {
          try {
            const img = snap && (await snap);
            if (img) {
              entry.snapshotKey = `snap:${entry.id}`;
              await saveSnapshot(entry.snapshotKey, img);
            }
          } catch {
            /* snapshot is best effort */
          }
          await useJournal.getState().add(entry);
          // Only once the entry is in the journal: settling looks it up there.
          if (entry.review?.afterExitUntil !== undefined) eng.watching.set(entry.id, { timeframe, rules });
          recordTradeClosed();
          const tone = trip.pnl >= 0 ? 'success' : 'error';
          toast(tone, `${trip.direction === 'long' ? 'Long' : 'Short'} ${trip.symbol} closed: ${trip.pnl >= 0 ? '+' : '−'}$${Math.abs(trip.pnl).toFixed(2)}. Journal entry created.`);
          if (showReviews) {
            // A jump or a gap can close several trades at once: each gets its review, one after another.
            const { reviewId, reviewQueue } = useTrading.getState();
            if (reviewId) useTrading.setState({ reviewQueue: [...reviewQueue, entry.id] });
            else useTrading.setState({ reviewId: entry.id });
          }
        } catch (e) {
          // One entry that cannot be saved does not hold up the others.
          console.error('Journal update failed', e);
        } finally {
          if (showReviews) useTrading.setState((s) => ({ reviewsPending: Math.max(0, s.reviewsPending - 1) }));
        }
      }
      settleWatchedReviews();
    })
    .catch((e) => console.error('Journal update failed', e));
  return journaling;
}

/** The learning review of `trip` with what the replay has shown so far, against `rules`. */
function reviewOf(trip: RoundTrip, timeframe: Timeframe, ended: boolean, rules: TradingRules): TradeReview {
  const st = broker()!.state;
  // Data coarser than the chart (a daily file on a 1m chart): its own bars are the finest candles there are.
  const base = eng.replay?.engineFor(trip.symbol)?.baseTimeframe;
  return reviewTrade({
    trip,
    fills: st.fills,
    orders: st.orders,
    revealedBars: getBaseBars(trip.symbol),
    timeframe: base && TIMEFRAMES.indexOf(base) > TIMEFRAMES.indexOf(timeframe) ? base : timeframe,
    baseTimeframe: base,
    equityCurve: st.equityCurve,
    startingBalance: st.startingBalance,
    allTrips: st.roundTrips,
    rules,
    now: st.clock,
    ended: ended || (eng.replay?.finished ?? false),
  });
}

/**
 * Finish the reviews waiting on price after their exit once the replay has shown the whole window
 * (or the session is over: `ended`), so the verdict on a stop is the same at any replay speed.
 */
function settleWatchedReviews(ended = false): void {
  const b = broker();
  if (!b || !eng.watching.size) return;
  const journal = useJournal.getState();
  for (const [id, { timeframe, rules }] of eng.watching) {
    const entry = journal.entries.find((e) => e.id === id);
    const until = entry?.review?.afterExitUntil;
    if (!entry || until === undefined) {
      eng.watching.delete(id);
      continue;
    }
    if (!ended && !(eng.replay?.finished ?? false) && b.state.clock < until) continue;
    eng.watching.delete(id);
    try {
      // Judged by the rules in force when the trade closed, even if they changed since; its rule checks
      // stay as they were then.
      void journal.updateReview(id, { ...reviewOf(entry.trip, timeframe, ended, rules), rules: entry.review!.rules });
    } catch (e) {
      console.error('Review failed', e);
    }
  }
}

/** How you marked your own rules on the reviews of this session's trades, by trade id. */
function ownRuleMarks(sessionId: string): Map<string, Record<string, boolean>> {
  const out = new Map<string, Record<string, boolean>>();
  for (const e of useJournal.getState().entries) if (e.sessionId === sessionId && e.ruleChecks) out.set(e.trip.id, e.ruleChecks);
  return out;
}

/**
 * The rules this session's trades are reviewed against: during a challenge, the rules as they were when
 * it started, which it is scored on, so a review lists the rules the challenge checks; else Settings'.
 */
function reviewRules(sessionId: string): TradingRules {
  const active = useChallenges.getState().active;
  return active?.sessionId === sessionId && active.rules ? active.rules : getSettings().rules;
}

function evaluateActiveChallenge(): void {
  const active = useChallenges.getState().active;
  const b = broker();
  // Scored only on its own session's trades (a journal change can come at any moment, even mid-switch).
  if (!active || !b || active.sessionId !== useTrading.getState().session?.id) return;
  const def = CHALLENGES.find((c) => c.id === active.challengeId);
  if (!def) return;
  const st = b.state;
  let result: ReturnType<typeof evaluateChallenge>;
  try {
    result = evaluateChallenge(def, {
      trips: st.roundTrips,
      fills: st.fills,
      equityCurve: st.equityCurve,
      startingBalance: st.startingBalance,
      equity: b.account().equity,
      sessionFinished: eng.replay?.finished ?? false,
      rewound: (eng.replay?.rewinds ?? 0) > 0,
      rules: active.rules ?? getSettings().rules,
      ownRuleMarks: ownRuleMarks(active.sessionId),
    });
  } catch (e) {
    // Scoring a challenge must never stop trading or journaling: its last result stays until the next try.
    console.error(`Challenge ${def.id} could not be evaluated`, e);
    return;
  }
  const prev = active.result.status;
  useChallenges.getState().updateActive(result);
  if (prev === 'in_progress' && result.status !== 'in_progress') {
    toast(result.status === 'passed' ? 'success' : 'error', `Challenge ${result.status === 'passed' ? 'passed' : 'failed'}: ${def.title}${result.official ? '' : ' (unofficial: rewind used)'}`, 8000);
    void useChallenges.getState().finishActive();
  }
}

function afterChange(revealed: { symbol: string; bar: Bar }[]): void {
  if (revealed.length) {
    const bySymbol = new Map<string, Bar[]>();
    for (const r of revealed) {
      const list = bySymbol.get(r.symbol) ?? [];
      list.push(r.bar);
      bySymbol.set(r.symbol, list);
    }
    for (const [symbol, bars] of bySymbol) emitChart({ type: 'append', symbol, bars });
  }
  publish();
  void processClosedTrips();
}

// ------------------------------------------------------------------ play loop

function loop(): void {
  const s = useTrading.getState();
  const nowMs = performance.now();
  const dt = Math.min(1, (nowMs - eng.lastTick) / 1000); // cap to avoid huge jumps after a stall
  eng.lastTick = nowMs;
  if (!s.playing) return;
  if (eng.replay) {
    const revealed = eng.replay.advance(dt * s.speed);
    afterChange(revealed);
  } else if (eng.sim && eng.simBroker) {
    const tickSecs = eng.sim.market.config.tickSeconds;
    eng.simCarry += dt * s.speed;
    const steps = Math.floor(eng.simCarry / tickSecs);
    if (steps <= 0) return;
    eng.simCarry -= steps * tickSecs;
    const updates = eng.sim.advance(steps * tickSecs);
    // Per symbol, every minute this step touched in its final state (Maps keep first-insert order: oldest first).
    const touched = new Map<string, Map<number, Bar>>();
    for (const u of updates) {
      eng.simBroker.onBar(u.symbol, u.tick, tickSecs);
      let bars = touched.get(u.symbol);
      if (!bars) touched.set(u.symbol, (bars = new Map()));
      bars.set(u.bar.time, u.bar);
    }
    for (const [symbol, bars] of touched) emitChart({ type: 'tick', symbol, bars: [...bars.values()] });
    publish();
    void processClosedTrips();
  }
}

function startTimer(): void {
  if (eng.timer) return;
  eng.lastTick = performance.now();
  eng.timer = setInterval(loop, 50);
}

function stopTimer(): void {
  if (eng.timer) clearInterval(eng.timer);
  eng.timer = null;
}

// ------------------------------------------------------------------ public actions

function resetEngines(): void {
  stopTimer();
  // The session ends here: reviews still waiting on price after their exit go by what it showed.
  settleWatchedReviews(true);
  eng.watching = new Map();
  eng.replay = null;
  eng.sim = null;
  eng.simBroker = null;
  eng.processedTrips = new Set();
  eng.noticedConflicts = new Set();
  eng.simCarry = 0;
  eng.prevClose = {};
}

/** Counts session starts and ends: a replay still loading when a newer one starts (or the session ends) is dropped. */
let loadSeq = 0;

/**
 * What ending the running session does to its open positions, for the user to confirm before another
 * session starts; null when nothing is open.
 */
export function sessionEndNotice(): string | null {
  const open = broker()?.openPositions() ?? [];
  if (!useTrading.getState().session || open.length === 0) return null;
  const list = open.map((p) => `${p.symbol} ${p.quantity > 0 ? 'long' : 'short'} ${Math.abs(p.quantity)}`).join(', ');
  return `Starting a new session ends this one. Your open ${open.length === 1 ? 'position' : 'positions'} (${list}) will be closed at the last price, as a market order would close ${open.length === 1 ? 'it' : 'them'}, and journaled with the exit reason "Session ended". Working orders are cancelled.`;
}

/**
 * Ends the running session before another starts or it is ended: open positions are closed at the last
 * price and journaled, and an active challenge attempt is scored on that and finished. Everything it
 * journals is saved before it returns, so nothing from this session reaches the next one.
 */
async function endCurrent(): Promise<void> {
  pause();
  const b = broker();
  if (b && useTrading.getState().session && b.openPositions().length > 0) {
    b.closeOut();
    publish(true);
  }
  await processClosedTrips(true);
  if (useChallenges.getState().active) await useChallenges.getState().finishActive();
}

/**
 * Loads a replay and, once it has loaded, ends the running session (endCurrent) and starts it. A load
 * that fails leaves the running session as it was, paused. False when it failed (the error is in the
 * store) or a newer start or end took its place.
 */
export async function startReplay(setup: ReplaySetup & { providerId: string; timeframe: Timeframe; speed: number; blind: boolean; challengeId?: string }): Promise<boolean> {
  const seq = ++loadSeq;
  const provider = getProvider(setup.providerId);
  const reason = provider.unavailableReason();
  if (reason) {
    useTrading.setState({ loading: false, error: reason });
    return false;
  }
  pause();
  useTrading.setState({ loading: true, error: null });
  const id = newId('replay');
  let loaded: Awaited<ReturnType<typeof ReplaySession.load>>;
  try {
    loaded = await ReplaySession.load(provider, setup, getSettings().execution, id);
  } catch (e) {
    if ((e as Error).name === 'AbortError' || seq !== loadSeq) return false;
    useTrading.setState({ loading: false, error: (e as Error).message });
    return false;
  }
  if (seq !== loadSeq) return false;
  await endCurrent();
  if (seq !== loadSeq) return false;
  resetEngines();
  const session = loaded.session;
  // Blind mode hides the date, and a skipped symbol's message can carry it (ours or the vendor's).
  const warnings = setup.blind ? loaded.warnings.map(withoutDates) : loaded.warnings;
  eng.replay = session;
  const meta: SessionMeta = {
    id,
    mode: 'replay',
    source: session.broker.state.source,
    symbols: session.symbols,
    start: session.start,
    end: session.end,
    startDate: session.setup.date,
    blind: setup.blind,
    challengeId: setup.challengeId,
    label: setup.blind ? `${session.symbol} · blind replay` : `${session.symbol} · ${session.setup.date}`,
  };
  useTrading.setState({ ...EMPTY, session: meta, warnings, activeSymbol: session.symbol, timeframe: setup.timeframe, speed: setup.speed });
  if (setup.challengeId) {
    const def = CHALLENGES.find((c) => c.id === setup.challengeId);
    useChallenges.getState().start({
      id: newId('attempt'),
      challengeId: setup.challengeId,
      sessionId: id,
      startedAt: Date.now(),
      label: meta.label,
      source: meta.source,
      rules: { ...getSettings().rules },
      result: { status: 'in_progress', progress: 0, detail: def?.description ?? '', official: true },
    });
  }
  emitChart({ type: 'reset' });
  publish(true);
  for (const w of warnings) toast('warning', w, 6000);
  return true;
}

/** Ends the running session (endCurrent) and starts the simulated market. False when a newer start or end took its place. */
export async function startSim(opts: { config: Partial<SimConfig>; startingBalance: number; speed: number; challengeId?: string }): Promise<boolean> {
  const seq = ++loadSeq;
  useTrading.setState({ loading: false });
  await endCurrent();
  if (seq !== loadSeq) return false;
  resetEngines();
  const today = new Date().toISOString().slice(0, 10);
  const startDate = isTradingDay(today) ? today : nextTradingDay(today);
  const provider = SimulationDataProvider.create(startDate, opts.config);
  const id = newId('sim');
  eng.sim = provider;
  eng.simBroker = new SimBroker({ startingBalance: opts.startingBalance, config: getSettings().execution, idPrefix: id, source: 'SIMULATED' });
  // Prime marks with the warm-up history.
  for (const p of provider.market.profiles) {
    const h = provider.getHistory(p.symbol);
    const last = h[h.length - 1];
    if (last) eng.simBroker.onBar(p.symbol, last, 60);
  }
  const symbols = provider.market.profiles.map((p) => p.symbol);
  useTrading.setState({
    ...EMPTY,
    session: { id, mode: 'sim', source: 'SIMULATED', symbols, start: provider.market.clock, end: null, startDate, blind: false, challengeId: opts.challengeId, label: 'Simulated market' },
    activeSymbol: symbols[0],
    timeframe: '1m',
    speed: opts.speed,
  });
  if (opts.challengeId) {
    const def = CHALLENGES.find((c) => c.id === opts.challengeId);
    useChallenges.getState().start({
      id: newId('attempt'),
      challengeId: opts.challengeId,
      sessionId: id,
      startedAt: Date.now(),
      label: 'Simulated market',
      source: 'SIMULATED',
      rules: { ...getSettings().rules },
      result: { status: 'in_progress', progress: 0, detail: def?.description ?? '', official: true },
    });
  }
  emitChart({ type: 'reset' });
  publish(true);
  return true;
}

/** Ends the running session (endCurrent): its open positions are closed at the last price and journaled. */
export async function endSession(): Promise<void> {
  const seq = ++loadSeq;
  useTrading.setState({ loading: false });
  await endCurrent();
  if (seq !== loadSeq) return;
  resetEngines();
  useTrading.setState({ ...EMPTY });
  emitChart({ type: 'reset' });
}

export function play(): void {
  const s = useTrading.getState();
  if (!s.session || s.finished) return;
  useTrading.setState({ playing: true });
  startTimer();
}

export function pause(): void {
  useTrading.setState({ playing: false });
  stopTimer();
}

export function togglePlay(): void {
  if (useTrading.getState().playing) pause();
  else play();
}

export function setSpeed(speed: number): void {
  useTrading.setState({ speed });
}

export function setTimeframe(tf: Timeframe): void {
  useTrading.setState({ timeframe: tf });
  emitChart({ type: 'reset' });
}

export function setActiveSymbol(symbol: string): void {
  if (useTrading.getState().activeSymbol === symbol) return;
  useTrading.setState({ activeSymbol: symbol });
  emitChart({ type: 'reset' });
  publish(true);
}

export function stepForward(): void {
  if (eng.replay) afterChange(eng.replay.step());
  else if (eng.sim && eng.simBroker) {
    const updates = eng.sim.advance(60);
    for (const u of updates) eng.simBroker.onBar(u.symbol, u.tick, eng.sim.market.config.tickSeconds);
    emitChart({ type: 'reset' });
    publish(true);
    void processClosedTrips();
  }
}

export function stepCandle(): void {
  if (!eng.replay) return;
  const s = useTrading.getState();
  afterChange(eng.replay.stepCandle(s.timeframe, s.activeSymbol));
}

/**
 * What a rewind to `time` (or Restart) would undo: trades still open, trades closed (whose journal
 * entries it deletes), and whether bars already seen would be hidden (only then is it a rewind).
 */
export function tradesUndoneBy(time: UnixSeconds, restart = false): { open: number; closed: number; hides: boolean } {
  return eng.replay?.undoneBy(time, restart) ?? { open: 0, closed: 0, hides: false };
}

/** Where Step back goes (the open of the last revealed bar), or null when there is nothing to step back over. */
export function stepBackTarget(): UnixSeconds | null {
  return eng.replay?.stepBackTarget() ?? null;
}

async function afterRewind(): Promise<void> {
  // Entries for trades that closed just before the rewind are written first, so they can be removed.
  await journaling;
  const session = useTrading.getState().session;
  const b = broker();
  if (!session || !b) return;
  const alive = new Set(b.state.roundTrips.filter((t) => t.closed).map((t) => t.id));
  // Journal entries for trades that no longer exist in this timeline are removed.
  await useJournal.getState().removeWhere((e) => e.sessionId === session.id && !alive.has(e.trip.id));
  eng.processedTrips = new Set([...eng.processedTrips].filter((id) => alive.has(id)));
  // An order working again after the rewind is announced again if it is cancelled again.
  const conflicts = new Set(b.state.orders.filter((o) => o.conflict).map((o) => o.id));
  eng.noticedConflicts = new Set([...eng.noticedConflicts].filter((id) => conflicts.has(id)));
  emitChart({ type: 'reset' });
  publish(true);
}

export function stepBack(): void {
  if (!eng.replay) return;
  pause();
  eng.replay.stepBack();
  void afterRewind();
}

export function restart(): void {
  if (!eng.replay) return;
  pause();
  eng.replay.restart();
  void afterRewind();
}

export function jumpTo(time: UnixSeconds): void {
  if (!eng.replay) return;
  const back = time < eng.replay.now;
  if (back) pause();
  const revealed = eng.replay.jumpTo(time);
  if (back) void afterRewind();
  else {
    // The reset redraws every revealed bar, so they are not sent to the chart a second time.
    if (revealed.length) emitChart({ type: 'reset' });
    publish(true);
    void processClosedTrips();
  }
}

/** The simulated market's broker, its clock brought up to the market's time for an order action. */
function simBrokerNow(): SimBroker | null {
  if (!eng.sim || !eng.simBroker) return null;
  eng.simBroker.syncClock(eng.sim.market.clock);
  return eng.simBroker;
}

export function submitOrder(req: OrderRequest): SubmitResult {
  const b = broker();
  if (!b) return { ok: false, error: 'Start a replay or the simulated market first.', warnings: [] };
  const r = eng.replay ? eng.replay.submit(req) : simBrokerNow()!.submit(req);
  publish(true);
  void processClosedTrips();
  return r;
}

export function cancelOrder(id: string): void {
  if (eng.replay) eng.replay.cancel(id);
  else broker()?.cancel(id);
  publish(true);
}

export function cancelAllOrders(): void {
  const b = broker();
  if (!b) return;
  for (const o of b.workingOrders()) {
    if (eng.replay) eng.replay.cancel(o.id);
    else b.cancel(o.id);
  }
  publish(true);
}

export function modifyOrder(id: string, changes: { limitPrice?: number; stopPrice?: number; quantity?: number }): { ok: boolean; error?: string } {
  const r = eng.replay ? eng.replay.modify(id, changes) : simBrokerNow()?.modify(id, changes) ?? { ok: false, error: 'No session' };
  publish(true);
  void processClosedTrips();
  return r;
}

export function closePosition(symbol: string): SubmitResult {
  const b = broker();
  if (!b) return { ok: false, error: 'No session', warnings: [] };
  const r = eng.replay ? eng.replay.closePosition(symbol) : simBrokerNow()!.closePosition(symbol);
  publish(true);
  void processClosedTrips();
  return r;
}

/** Apply changed execution settings to the running session. */
function applyExecutionConfig(): void {
  const cfg = getSettings().execution;
  if (eng.replay) eng.replay.setConfig(cfg);
  else if (eng.simBroker) eng.simBroker.cfg = cfg;
}
// The running session trades under the current execution settings, however they changed (the
// settings page, a reset, another tab).
useSettings.subscribe((s, prev) => {
  if (s.execution !== prev.execution) applyExecutionConfig();
});
// Your own rules marked on a trade's review count toward a rules challenge at once, even while
// playback is paused for the review.
useJournal.subscribe((s, prev) => {
  if (s.entries !== prev.entries) evaluateActiveChallenge();
});

export function setPickTarget(t: TradingSnapshot['pickTarget']): void {
  useTrading.setState({ pickTarget: t });
}

let pickSeq = 0;
export function pickPrice(price: number): void {
  const t = useTrading.getState().pickTarget;
  if (!t) return;
  useTrading.setState({ pickTarget: null, pickedPrice: { field: t, price, seq: ++pickSeq } });
}

/** Close the review on screen and show the next waiting one (skipping trades undone since). */
export function closeReview(): void {
  const entries = useJournal.getState().entries;
  const queue = useTrading.getState().reviewQueue.filter((id) => entries.some((e) => e.id === id));
  useTrading.setState({ reviewId: queue[0] ?? null, reviewQueue: queue.slice(1) });
}

/** Where an order would be expected to fill if placed now, with its costs (SimBroker.estimateFill), at the time submit would place it. */
export function estimateFill(req: Pick<OrderRequest, 'symbol' | 'action' | 'type' | 'quantity' | 'limitPrice' | 'stopPrice' | 'extendedHours'>): number | null {
  const now = eng.replay ? eng.replay.now : eng.sim?.market.clock;
  return broker()?.estimateFill(req, now) ?? null;
}

/**
 * The risk of the trade a new Buy or Short order would join, from the trade's first stop, as Strict
 * Mode, the trade review and the challenges measure it (SimBroker.tradeRisk), at the time submit would
 * place it.
 */
export function tradeRisk(req: OrderRequest): TradeRisk | null {
  const now = eng.replay ? eng.replay.now : eng.sim?.market.clock;
  return broker()?.tradeRisk(req, now) ?? null;
}

/** What submit would say is wrong with a Buy or Short order's stop loss or target (SimBroker.bracketErrors), at the time submit would place it. */
export function bracketErrors(req: OrderRequest): string[] {
  const now = eng.replay ? eng.replay.now : eng.sim?.market.clock;
  return broker()?.bracketErrors(req, now) ?? [];
}

/** Size by risk: the most shares whose trade risks at most `riskPct`% and that submit would accept (SimBroker.sizeByRisk). */
export function sizeByRisk(input: Omit<OrderRequest, 'quantity'>, riskPct: number): ReturnType<SimBroker['sizeByRisk']> {
  const now = eng.replay ? eng.replay.now : eng.sim?.market.clock;
  return broker()?.sizeByRisk(input, riskPct, now) ?? { ok: false, error: 'Start a session first.' };
}

/** The most shares of an opening order buying power covers now (SimBroker.affordableQuantity). */
export function affordableQuantity(req: Pick<OrderRequest, 'symbol' | 'action' | 'type' | 'limitPrice' | 'stopPrice' | 'extendedHours'>): number {
  const now = eng.replay ? eng.replay.now : eng.sim?.market.clock;
  return broker()?.affordableQuantity(req, now) ?? 0;
}

export function lastPrice(symbol: string): number | null {
  return broker()?.markPrice(symbol) ?? null;
}

/** The replay's equity at the start of the session (for display). */
export function startingBalance(): number {
  return broker()?.state.startingBalance ?? 0;
}
