/**
 * The active trading session (historical replay or simulated market) and its play loop.
 *
 * Engine objects (ReplaySession, SimMarket, SimBroker) live outside React. After every change we
 * publish a plain snapshot to the zustand store for the UI, and push bar updates to the chart over
 * a small event bus so the chart can update incrementally instead of re-rendering.
 */
import { create } from 'zustand';
import { bucketFor, ownCandles } from '../../core/data/aggregate';
import { lastIndexAtOrBefore } from '../../core/util/math';
import { TIMEFRAMES, type AccountSnapshot, type Bar, type DataSourceKind, type EquityPoint, type Fill, type Order, type OrderRequest, type Position, type RoundTrip, type Timeframe, type UnixSeconds } from '../../core/types';
import { ReplaySession, type ChartHistory, type ReplaySetup } from '../../core/replay/ReplaySession';
import { SimBroker, describe as describeOrder, type BrokerEvent, type SubmitResult, type TradeRisk } from '../../core/broker/SimBroker';
import { SimulationDataProvider } from '../../core/data/simulationProvider';
import { isDriven, type StreamingDataProvider, type StreamUpdate, type Unsubscribe } from '../../core/data/provider';
import { SimMarket, type SimConfig, type SimEvent } from '../../core/sim/SimMarket';
import { journalEntryFromTrip, type JournalEntry } from '../../core/journal';
import { reviewTrade, type TradeReview, type TradingRules } from '../../core/learning/review';
import { CHALLENGES, evaluateChallenge, type ChallengeDefinition } from '../../core/challenges/challenges';
import { exchangeDate, isTradingDay, marketSession, nextTradingDay, prevTradingDay, withoutDates } from '../../core/time';
import {
  SAVED_SESSION_VERSION,
  MAX_SAVED_SESSIONS,
  claimSession,
  deleteSession,
  keptSessions,
  listSessions,
  notePosition,
  readPosition,
  readSession,
  releaseSession,
  rememberTabSession,
  tabSession,
  writeSession,
  type SavedSession,
  type SessionSummary,
} from '../services/savedSessions';
import { getProvider } from './dataRegistry';
import { getSettings, useSettings } from './settingsStore';
import { useCredentials } from './credentials';
import { useJournal, saveSnapshot } from './journalStore';
import { useChallenges } from './challengeStore';
import { toast } from './toasts';
import { recordTradeClosed } from './streakStore';
import { reconcileSavedBlind, setLiveBlind, setSavedBlind } from './liveBlind';
import { newId } from '../../core/util/ids';
import type { ChartScene } from '../chart/offscreenSnapshot';

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
  /**
   * After a reload, the session this tab was running, until resumeAfterReload has carried it on or found
   * that it cannot: meanwhile it is not offered to resume or discard, since the reload carries it on itself.
   */
  carryingOn: string | null;
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
  /** The streaming session's prices (the simulated market), through the streaming interface only. */
  stream: StreamingDataProvider<SimEvent> | null;
  /** The streaming session's broker. */
  simBroker: SimBroker | null;
  /** Where a replay's data comes from, to load it again when the session is carried on later. */
  providerId: string | null;
  /** The simulated market behind the stream, kept to save it (savedSessions); trading goes through the stream. */
  market: SimMarket | null;
  /** When the session was last saved whole (performance.now()). */
  savedAt: number;
  /** Ends the session's subscription to the stream. */
  unsubscribe: Unsubscribe | null;
  /** Per symbol, every minute bar stream updates have touched since the chart last heard, in its latest state (oldest first). */
  streamTouched: Map<string, Map<number, Bar>>;
  processedTrips: Set<string>;
  /** This session's trades whose journal entry was written: one no longer in the journal was deleted. */
  journaledTrips: Set<string>;
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
  /** The stream's headlines so far that are toasted or held for a toast (those before the session started are not). */
  newsSeen: number;
  /** Headlines waiting for the next news toast, when it last showed (performance.now()) and the timer that shows it. */
  newsHeld: number;
  newsToastAt: number;
  newsTimer: ReturnType<typeof setTimeout> | null;
}

const eng: Engines = {
  replay: null,
  stream: null,
  simBroker: null,
  providerId: null,
  market: null,
  savedAt: 0,
  unsubscribe: null,
  streamTouched: new Map(),
  processedTrips: new Set(),
  journaledTrips: new Set(),
  watching: new Map(),
  noticedConflicts: new Set(),
  timer: null,
  lastTick: 0,
  lastPublish: 0,
  simCarry: 0,
  prevClose: {},
  newsSeen: 0,
  newsHeld: 0,
  newsToastAt: -Infinity,
  newsTimer: null,
};

// The top speed plays one regular session (6.5 hours) per second, which suits daily bars.
export const REPLAY_SPEEDS = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200, 23400];
export const SIM_SPEEDS = [1, 2, 5, 10, 30, 60, 120, 300];

/** What starting or ending a session resets: not carryingOn, which only resumeAfterReload settles. */
const EMPTY: Omit<TradingSnapshot, 'carryingOn'> = {
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

export const useTrading = create<TradingSnapshot>()(() => ({ ...EMPTY, carryingOn: tabSession() }));

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
  if (eng.stream) return eng.stream.getHistory(symbol);
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
 * Where a `timeframe` chart of `symbol` puts what happened at time `t` (a fill, a headline): the start
 * of the candle holding the last bar shown at or before `t`, at the data's own bar size that bar (bars
 * need not sit on the 09:30 grid). So a fill at a candle's end whose next candle has not formed, or
 * never forms (at the close, before a gap in the data), stays on the candle it came after, and no bar
 * still to come moves it. One lookup serves every time asked about (the simulated market's bars are
 * copied once).
 */
export function candleStarts(symbol: string, timeframe: Timeframe): (t: UnixSeconds) => UnixSeconds {
  const e = eng.replay?.engineFor(symbol);
  if (e) {
    const own = ownCandles(timeframe, e.baseTimeframe);
    return (t) => {
      const start = e.barStartAtOrBefore(t) ?? t;
      return own ? start : bucketFor(start, timeframe).start;
    };
  }
  // The simulated market's minute bars so far.
  const bars = eng.stream?.getHistory(symbol) ?? [];
  return (t) => bucketFor(bars[lastIndexAtOrBefore(bars, t, (b) => b.time)]?.time ?? t, timeframe).start;
}

export function getSimEventsFor(symbol: string): SimEvent[] {
  return eng.stream ? eng.stream.events().filter((e) => e.symbol === symbol || e.symbol === 'MARKET') : [];
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
  const symbols = eng.replay ? eng.replay.symbols : eng.stream ? eng.stream.symbols : [];
  for (const sym of symbols) {
    const bars = eng.replay ? null : eng.stream!.getHistory(sym);
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
  const now = eng.replay ? eng.replay.now : eng.stream ? eng.stream.clock : 0;
  const finished = eng.replay ? eng.replay.finished : false;
  const reachedEnd = finished && !useTrading.getState().finished;
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
    simEvents: eng.stream ? eng.stream.events().slice(-100) : [],
    version: st.version,
  });
  announceConflicts(st.orders);
  notePositionNow();
  // A blind replay that has run to its end gives its date back: clock, chart, journal and exports.
  const meta = useTrading.getState().session;
  const revealed = finished && !!meta?.blind;
  if (finished && meta?.blind) {
    const last = exchangeDate(now);
    useTrading.setState({ session: { ...meta, blind: false, label: `${meta.symbols[0]} · ${meta.startDate}` } });
    setSavedBlind(meta.id, null);
    toast('info', `Blind replay over: that was ${meta.symbols[0]} on ${last === meta.startDate ? meta.startDate : `${meta.startDate} to ${last}`}.`, 10_000);
  }
  const stopping = finished && useTrading.getState().playing;
  if (stopping && !revealed) toast('info', 'Replay reached the end time.');
  const attemptEnded = evaluateActiveChallenge();
  // Saved when it reaches its end or its challenge attempt ends, with the attempt scored and the date
  // given back, so a tab that goes then does not leave it saved as blind or with its attempt under way.
  // Pausing saves it.
  if (stopping) pause();
  else if (reachedEnd || attemptEnded) saveSession();
}

// ------------------------------------------------------------------ journal + learning hooks

/** Journal writes for closed trades, one batch after another, so reviews queue in the order trades closed. */
let journaling: Promise<void> = Promise.resolve();

/** A journal snapshot, and whether it was drawn off screen rather than taken from the chart on screen. */
type Snapshot = { img: string; offscreen: boolean };

/**
 * What `trip`'s symbol had shown by the moment its exit became known, for a snapshot drawn off screen:
 * its bars, fills and simulated news up to then and none after. `later`: bars have been revealed since
 * (a fast step or a jump can reveal several before the trade is journaled), so the chart on screen is past it.
 */
function sceneAtClose(trip: RoundTrip, timeframe: Timeframe, session: SessionMeta): { scene: ChartScene; later: boolean } {
  const st = broker()!.state;
  const exit = st.fills.find((f) => f.id === trip.fills[trip.fills.length - 1]);
  const at = exit?.knownAt ?? trip.exitTime!;
  const engine = eng.replay?.engineFor(trip.symbol);
  let bars: Bar[];
  let later: boolean;
  if (engine) {
    // A replay shows a bar once it has ended: those that had ended by then.
    const shown = engine.revealedCountAt(at);
    bars = engine.revealedBars(0, shown);
    later = engine.revealedCount > bars.length;
  } else {
    // The simulated market's minute bars, the one forming at the exit included.
    const all = getBaseBars(trip.symbol);
    bars = all.filter((b) => b.time <= trip.exitTime!);
    later = all.length > bars.length;
  }
  // The history from before the replay's loaded bars that the chart shows on this timeframe, if any
  // has loaded (it is all from before the start).
  const history = eng.replay?.chartHistory(trip.symbol, timeframe);
  const scene: ChartScene = {
    symbol: trip.symbol,
    timeframe,
    baseTimeframe: getBaseTimeframe(trip.symbol),
    bars,
    history: history?.bars.length ? { bars: history.bars, timeframe: history.timeframe } : undefined,
    fills: st.fills.filter((f) => f.symbol === trip.symbol && (f.knownAt ?? f.time) <= at),
    news: getSimEventsFor(trip.symbol).filter((e) => e.time <= at),
    entryTime: trip.entryTime,
    source: trip.source,
    blind: session.blind ? { sessionId: session.id, startDate: session.startDate } : null,
  };
  return { scene, later };
}

/** `scene` drawn off screen (chart/offscreenSnapshot, loaded the first time it is needed). */
async function drawOffscreen(scene: ChartScene): Promise<Snapshot | null> {
  const { offscreenSnapshot } = await import('../chart/offscreenSnapshot');
  const img = await offscreenSnapshot(scene);
  return img ? { img, offscreen: true } : null;
}

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
  // Claimed, reviewed and pictured now, as they closed (a picture drawn off screen is drawn later, one
  // at a time, from what was shown now). Learning Mode stops playback before anything is awaited, so
  // the replay does not run on while the journal is written.
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
    let snap: (() => Promise<Snapshot | null>) | null = null;
    if (!settings.autoSnapshot) entry.snapshotMissing = 'off';
    else {
      try {
        const { scene, later } = sceneAtClose(trip, timeframe, session);
        const offscreen = () => drawOffscreen(scene);
        // The chart on screen shows the moment of the close only when it is on the trade's symbol and
        // nothing has been revealed since.
        if (snapshotFn && !later && useTrading.getState().activeSymbol === trip.symbol) {
          if (!picture) {
            // Publishing is throttled while playing; the picture shows the moment the trade closed.
            publish(true);
            picture = snapshotFn().catch(() => null);
          }
          const onScreen = picture;
          // A chart that is not laid out, or is scrolled back from the close, gives no picture: one is
          // drawn off screen instead.
          snap = () => onScreen.then((img) => (img ? { img, offscreen: false } : offscreen()));
        } else snap = offscreen;
      } catch (e) {
        // Never in the way of journaling the trade.
        console.warn('Chart snapshot failed', e);
        entry.snapshotMissing = 'failed';
      }
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
          // The snapshot is best effort: without one, the entry says why.
          try {
            const shot = snap && (await snap());
            if (shot) {
              const key = `snap:${entry.id}`;
              await saveSnapshot(key, shot.img);
              entry.snapshotKey = key;
              if (shot.offscreen) entry.snapshotOffscreen = true;
            } else if (snap) entry.snapshotMissing = 'failed';
          } catch (e) {
            console.warn('Chart snapshot failed', e);
            entry.snapshotMissing = 'failed';
          }
          await useJournal.getState().add(entry);
          eng.journaledTrips.add(trip.id);
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
      // What was written is saved with the session, so carrying it on does not write it again.
      if (useTrading.getState().session?.id === session.id) saveSession();
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

/** This session's trades whose journal entry was written and has since been deleted. */
function deletedEntries(sessionId: string): Set<string> {
  const kept = new Set<string>();
  for (const e of useJournal.getState().entries) if (e.sessionId === sessionId) kept.add(e.trip.id);
  return new Set([...eng.journaledTrips].filter((id) => !kept.has(id)));
}

/**
 * The rules this session's trades are reviewed against: during a challenge, the rules as they were when
 * it started, which it is scored on, so a review lists the rules the challenge checks; else Settings'.
 */
function reviewRules(sessionId: string): TradingRules {
  const active = useChallenges.getState().active;
  return active?.sessionId === sessionId && active.rules ? active.rules : getSettings().rules;
}

/**
 * The active challenge that marking your own `rule` broken on a trade of session `sessionId` would fail at
 * once, with no way back (the rules challenge, when the rule is one it is scored on), or null.
 */
export function challengeFailedByBrokenRule(sessionId: string, rule: string): ChallengeDefinition | null {
  const active = useChallenges.getState().active;
  if (!active || active.challengeId !== 'rules-20' || active.result.status !== 'in_progress') return null;
  if (active.sessionId !== sessionId || sessionId !== useTrading.getState().session?.id) return null;
  if (!((active.rules ?? getSettings().rules).custom ?? []).includes(rule)) return null;
  return CHALLENGES.find((c) => c.id === active.challengeId) ?? null;
}

/** Scores the running session's challenge attempt. True when that ended it (passed or failed). */
function evaluateActiveChallenge(): boolean {
  const active = useChallenges.getState().active;
  const b = broker();
  // Scored only on its own session's trades (a journal change can come at any moment, even mid-switch).
  if (!active || !b || active.sessionId !== useTrading.getState().session?.id) return false;
  const def = CHALLENGES.find((c) => c.id === active.challengeId);
  if (!def) return false;
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
      deletedEntries: deletedEntries(active.sessionId),
    });
  } catch (e) {
    // Scoring a challenge must never stop trading or journaling: its last result stays until the next try.
    console.error(`Challenge ${def.id} could not be evaluated`, e);
    return false;
  }
  const prev = active.result.status;
  useChallenges.getState().updateActive(result);
  if (prev === 'in_progress' && result.status !== 'in_progress') {
    toast(result.status === 'passed' ? 'success' : 'error', `Challenge ${result.status === 'passed' ? 'passed' : 'failed'}: ${def.title}${result.official ? '' : ' (unofficial: rewind used)'}`, 8000);
    void useChallenges.getState().finishActive();
    return true;
  }
  return false;
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
  if (nowMs - eng.savedAt > SAVE_EVERY_MS) saveSession();
  if (eng.replay) {
    const revealed = eng.replay.advance(dt * s.speed);
    afterChange(revealed);
  } else if (eng.stream && eng.simBroker) {
    // A stream the app drives moves on by whole ticks at the chosen speed; its updates reach the
    // broker as they come (onStreamUpdate) and are shown here.
    if (isDriven(eng.stream)) {
      const tickSecs = eng.stream.tickSeconds;
      eng.simCarry += dt * s.speed;
      const steps = Math.floor(eng.simCarry / tickSecs);
      if (steps <= 0) return;
      eng.simCarry -= steps * tickSecs;
      eng.stream.advance(steps * tickSecs);
    }
    showStream(false);
  }
}

/** A stream update: its tick is traded against at once, and the chart hears of its minute bar when the step is shown. */
function onStreamUpdate(u: StreamUpdate): void {
  eng.simBroker?.onBar(u.symbol, u.tick, eng.stream!.tickSeconds);
  let bars = eng.streamTouched.get(u.symbol);
  if (!bars) eng.streamTouched.set(u.symbol, (bars = new Map()));
  bars.set(u.bar.time, u.bar);
}

/**
 * Shows the stream updates since the last call: the chart gets every minute they touched, in its final
 * state, so a stalled frame leaves no gap (or redraws, `reset`), then the store is published and
 * closed trades journaled. Nothing to show, nothing done.
 */
function showStream(reset: boolean): void {
  const touched = eng.streamTouched;
  if (!touched.size && !reset) return;
  eng.streamTouched = new Map();
  if (reset) emitChart({ type: 'reset' });
  else for (const [symbol, bars] of touched) emitChart({ type: 'tick', symbol, bars: [...bars.values()] });
  publish(reset);
  announceNews();
  void processClosedTrips();
}

/** The shortest time between news toasts, so high speeds do not flood the screen (every headline is in the News tab). */
const NEWS_TOAST_GAP_MS = 4000;

/**
 * Toasts the stream's newest headline, wherever it is, so news on a stock you are not charting is not
 * missed: one toast at most every few seconds, naming how many others came with it.
 */
function announceNews(): void {
  if (!eng.stream) return;
  const all = eng.stream.events();
  if (all.length > eng.newsSeen) {
    eng.newsHeld += all.length - eng.newsSeen;
    eng.newsSeen = all.length;
  }
  if (!eng.newsHeld || eng.newsTimer) return;
  const wait = eng.newsToastAt + NEWS_TOAST_GAP_MS - performance.now();
  if (wait > 0) {
    eng.newsTimer = setTimeout(() => {
      eng.newsTimer = null;
      announceNews();
    }, wait);
    return;
  }
  const ev = all[all.length - 1];
  const more = eng.newsHeld - 1;
  eng.newsHeld = 0;
  eng.newsToastAt = performance.now();
  toast('info', `Simulated news, ${ev.symbol === 'MARKET' ? 'whole market' : ev.symbol}: ${ev.headline.replace('[SIMULATED] ', '')}${more > 0 ? ` (and ${more} more in the News tab)` : ''}`);
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

// ------------------------------------------------------------------ saving the session (savedSessions)

/** How often a playing session is saved whole; where its clock has got to is noted on every publish. */
const SAVE_EVERY_MS = 30_000;

/** Saves and deletions, one after another, so an older one never lands after a newer one. */
let saving: Promise<void> = Promise.resolve();
/** Sessions that could not be saved, told once each. */
const saveFailedTold = new Set<string>();

function view(s = useTrading.getState()): SavedSession['view'] {
  return { activeSymbol: s.activeSymbol, timeframe: s.timeframe, speed: s.speed };
}

/** The running session as a record to save, copied now; null when none is running. */
function sessionRecord(): SavedSession | null {
  const s = useTrading.getState();
  const meta = s.session;
  const b = broker();
  if (!meta || !b) return null;
  let replay: SavedSession['replay'];
  let sim: SavedSession['sim'];
  if (eng.replay && eng.providerId) replay = { providerId: eng.providerId, state: eng.replay.save() };
  else if (eng.market && eng.simBroker) sim = { market: eng.market.snapshot(), broker: eng.simBroker.getState(), config: structuredClone(eng.simBroker.cfg) };
  else return null;
  const st = b.state;
  const active = useChallenges.getState().active;
  const challenge = active?.sessionId === meta.id ? structuredClone(active) : null;
  return {
    version: SAVED_SESSION_VERSION,
    summary: {
      id: meta.id,
      savedAt: Date.now(),
      meta,
      now: eng.replay ? eng.replay.now : eng.stream!.clock,
      closedTrades: st.roundTrips.filter((t) => t.closed).length,
      openPositions: b.openPositions().length,
      equity: b.account().equity,
      startingBalance: st.startingBalance,
      finished: eng.replay?.finished ?? false,
      challengeUnderWay: challenge !== null,
    },
    view: view(s),
    warnings: s.warnings,
    replay,
    sim,
    journaledTrips: [...eng.journaledTrips],
    watching: [...eng.watching].map(([id, w]) => [id, structuredClone(w)]),
    challenge,
  };
}

/** A saved session's start date while it is blind and its date still hidden, else null. */
function hiddenStart(s: SessionSummary): string | null {
  return s.meta.blind && !s.finished ? s.meta.startDate : null;
}

/** Saves the running session whole, in the background. */
function saveSession(): void {
  const rec = sessionRecord();
  if (!rec) return;
  eng.savedAt = performance.now();
  notePositionNow();
  const id = rec.summary.id;
  // Saved to carry on later, a blind session keeps its dates hidden in every tab even once no tab runs it.
  setSavedBlind(id, hiddenStart(rec.summary));
  saving = saving
    .then(() => writeSession(rec))
    .catch((e) => {
      if (saveFailedTold.has(id)) return;
      saveFailedTold.add(id);
      console.warn('Session not saved', e);
      toast('warning', 'This session cannot be saved in this browser (its storage is blocked or full), so reloading the page or closing the tab would lose it.', 10_000);
    });
}

/** Whether the running session could not be saved in this browser (so a reload would lose it). */
export function sessionUnsaved(): boolean {
  const id = useTrading.getState().session?.id;
  return !!id && saveFailedTold.has(id);
}

/** Notes where the running session's clock has got to, and what it shows, for carrying it on from there. */
function notePositionNow(): void {
  const s = useTrading.getState();
  if (!s.session || !broker()) return;
  notePosition(s.session.id, { now: eng.replay ? eng.replay.now : (eng.stream?.clock ?? 0), rewinds: eng.replay?.rewinds ?? 0, view: view(s) });
}

/** A session started or carried on in this tab: this tab holds it, a reload carries it on, and it is saved. */
async function adoptSession(id: string): Promise<void> {
  rememberTabSession(id);
  saveSession();
  await claimSession(id);
  // Only the latest few unfinished sessions are kept, this one among them.
  try {
    for (const old of (await listSessions()).slice(MAX_SAVED_SESSIONS - 1)) await discardSession(old.id);
  } catch {
    /* storage unavailable: nothing is kept anyway */
  }
}

/** The session ended: nothing is kept of it to carry on. */
function forgetSession(id: string): void {
  if (tabSession() === id) rememberTabSession(null);
  // Off the blind listing once it is deleted, so a tab opening meanwhile does not list it again; its
  // dates stay hidden until then. Held until then too, so it is not offered (here or in another tab)
  // or counted among the few kept while it is still stored.
  saving = saving
    .then(() => deleteSession(id))
    .catch(() => undefined)
    .then(() => {
      setSavedBlind(id, null);
      releaseSession(id);
    });
}

if (typeof document !== 'undefined') {
  // A tab going to the background may be closed or discarded without another word.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveSession();
  });
}

// As the app opens, the blind sessions listed as saved (liveBlind) are checked against those kept: one
// saved before that listing existed is added, and one no longer kept goes. A summary saved then does not
// say whether its challenge attempt was under way either: that came in with the listing.
if (typeof window !== 'undefined') {
  void reconcileSavedBlind(async () => (await keptSessions()).map((s) => ({ id: s.id, start: hiddenStart(s), older: s.challengeUnderWay === undefined }))).catch(() => undefined);
}

/** Unfinished sessions this browser kept that no tab is running, newest first, but not one a reload is carrying on. */
export async function unfinishedSessions(): Promise<SessionSummary[]> {
  const kept = await listSessions();
  const { session, carryingOn } = useTrading.getState();
  return kept.filter((s) => s.id !== session?.id && s.id !== carryingOn);
}

/**
 * Lets go of an unfinished session without carrying it on: its closed trades stay in the journal, its
 * open positions go without a journal entry (they never closed), and a challenge attempt under way is
 * kept in the history as abandoned. False when another tab is running it.
 */
export async function discardSession(id: string): Promise<boolean> {
  if (useTrading.getState().session?.id === id || !(await claimSession(id))) return false;
  try {
    const rec = await readSession(id).catch(() => null);
    if (rec?.challenge) await useChallenges.getState().importAttempts([{ ...rec.challenge, endedAt: Date.now() }]);
    saving = saving.then(() => deleteSession(id)).catch(() => undefined);
    await saving;
    setSavedBlind(id, null);
  } finally {
    releaseSession(id);
  }
  return true;
}

// ------------------------------------------------------------------ public actions

function resetEngines(): void {
  stopTimer();
  // The session ends here: reviews still waiting on price after their exit go by what it showed.
  settleWatchedReviews(true);
  eng.watching = new Map();
  eng.replay = null;
  eng.providerId = null;
  eng.unsubscribe?.();
  eng.unsubscribe = null;
  eng.stream = null;
  eng.market = null;
  eng.simBroker = null;
  eng.streamTouched = new Map();
  eng.processedTrips = new Set();
  eng.journaledTrips = new Set();
  eng.noticedConflicts = new Set();
  eng.simCarry = 0;
  eng.prevClose = {};
  if (eng.newsTimer) clearTimeout(eng.newsTimer);
  eng.newsTimer = null;
  eng.newsSeen = 0;
  eng.newsHeld = 0;
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
  const id = useTrading.getState().session?.id;
  if (b && id && b.openPositions().length > 0) {
    b.closeOut(eng.replay ? eng.replay.now : eng.stream?.clock);
    publish(true);
  }
  await processClosedTrips(true);
  if (useChallenges.getState().active) await useChallenges.getState().finishActive();
  if (id) forgetSession(id);
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
  eng.providerId = setup.providerId;
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
  void adoptSession(id);
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
  const stream: StreamingDataProvider<SimEvent> = provider;
  const id = newId('sim');
  eng.stream = stream;
  eng.market = provider.market;
  eng.simBroker = new SimBroker({ startingBalance: opts.startingBalance, config: getSettings().execution, idPrefix: id, source: 'SIMULATED' });
  // Prime marks with the warm-up history.
  for (const symbol of stream.symbols) {
    const h = stream.getHistory(symbol);
    const last = h[h.length - 1];
    if (last) eng.simBroker.onBar(symbol, last, 60);
  }
  eng.unsubscribe = stream.subscribe(stream.symbols, onStreamUpdate);
  // Headlines from the warm-up history are in the News tab; only those from here on are toasted.
  eng.newsSeen = stream.events().length;
  const symbols = [...stream.symbols];
  useTrading.setState({
    ...EMPTY,
    session: { id, mode: 'sim', source: 'SIMULATED', symbols, start: stream.clock, end: null, startDate, blind: false, challengeId: opts.challengeId, label: 'Simulated market' },
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
  void adoptSession(id);
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

/** The session a resumeSession call under way is carrying on. */
let resuming: string | null = null;

/** Furthest a simulated market is moved on to where its clock had got to after its last whole save. */
const SIM_CATCH_UP_LIMIT = 7 * 86_400;

/** The longest carrying a session on waits for the server to say which vendor keys it keeps. */
const SERVER_KEYS_WAIT_MS = 10_000;

/** Asks the server which vendor keys it keeps (checkServer), waiting at most SERVER_KEYS_WAIT_MS for the answer. */
async function serverKeysChecked(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([useCredentials.getState().checkServer(), new Promise<void>((r) => (timer = setTimeout(r, SERVER_KEYS_WAIT_MS)))]);
  clearTimeout(timer);
}

/**
 * Carries on an unfinished session (savedSessions) where it was, paused, once it has loaded: ends the
 * running session first (endCurrent), as starting one does. A replay loads its data again and carries on
 * only if it is the same data; then, from the last whole save, the clock goes on to where it had got to,
 * as Play took it there, so no bar seen is hidden again. False when it cannot (the reason is in the
 * store's error) or a newer start or end took its place.
 */
export async function resumeSession(id: string): Promise<boolean> {
  if (useTrading.getState().session?.id === id) return true;
  // Pressed twice: the first is under way (and holds the session).
  if (resuming === id) return false;
  const seq = ++loadSeq;
  resuming = id;
  pause();
  useTrading.setState({ loading: true, error: null });
  const stop = (message?: string): false => {
    if (resuming === id) resuming = null;
    releaseSession(id);
    if (message && seq === loadSeq) useTrading.setState({ loading: false, error: message });
    return false;
  };
  if (!(await claimSession(id))) return stop('This session is open in another tab: carry it on there.');
  const rec = await readSession(id).catch(() => null);
  if (!rec) return stop('This saved session could not be read.');
  const meta = rec.summary.meta;
  let replay: ReplaySession | null = null;
  let stream: SimulationDataProvider | null = null;
  let simBroker: SimBroker | null = null;
  const pos = readPosition(id);
  try {
    if (rec.replay) {
      const provider = getProvider(rec.replay.providerId);
      // A key kept on the server is known only once the server has answered, which can be after a reload gets here.
      if (provider.requiresCredentials && provider.unavailableReason() && !useCredentials.getState().serverChecked) await serverKeysChecked();
      const reason = provider.unavailableReason();
      if (reason) throw new Error(`${reason} Then resume the session.`);
      replay = await ReplaySession.resume(provider, rec.replay.state, id);
      if (pos && pos.now !== replay.now) replay.jumpTo(pos.now);
      if (pos) replay.rewinds = Math.max(replay.rewinds, pos.rewinds);
    } else if (rec.sim) {
      const market = SimMarket.restore(rec.sim.market);
      const b = new SimBroker({ startingBalance: rec.sim.broker.startingBalance, config: rec.sim.config, state: rec.sim.broker });
      const sim = new SimulationDataProvider(market);
      const off = sim.subscribe(sim.symbols, (u) => b.onBar(u.symbol, u.tick, sim.tickSeconds));
      if (pos) while (sim.clock < Math.min(pos.now, rec.summary.now + SIM_CATCH_UP_LIMIT)) sim.advance(sim.tickSeconds);
      off();
      stream = sim;
      simBroker = b;
    } else throw new Error('This saved session could not be read.');
    if (!useJournal.getState().loaded) await useJournal.getState().load();
  } catch (e) {
    if (seq !== loadSeq || (e as Error).name === 'AbortError') return stop();
    const message = (e as Error).message;
    return stop(meta.blind ? withoutDates(message) : message);
  }
  if (seq !== loadSeq) return stop();
  const b = (replay?.broker ?? simBroker)!;
  // Journal entries of trades this account no longer has closed (written after its last save, by a
  // page that went before saving again) are undone, as a rewind would undo them.
  const closed = new Set(b.state.roundTrips.filter((t) => t.closed).map((t) => t.id));
  await useJournal.getState().removeWhere((e) => e.sessionId === id && !closed.has(e.trip.id));
  if (seq !== loadSeq) return stop();
  await endCurrent();
  if (seq !== loadSeq) return stop();
  resetEngines();
  eng.replay = replay;
  eng.providerId = rec.replay?.providerId ?? null;
  if (stream && simBroker) {
    eng.stream = stream;
    eng.market = stream.market;
    eng.simBroker = simBroker;
    eng.unsubscribe = stream.subscribe(stream.symbols, onStreamUpdate);
    eng.newsSeen = stream.events().length;
  }
  // Trades already in the journal (or deleted from it) are not journaled again; others closed are, now.
  const written = useJournal.getState().entries.filter((e) => e.sessionId === id);
  eng.journaledTrips = new Set([...rec.journaledTrips, ...written.map((e) => e.trip.id)].filter((t) => closed.has(t)));
  eng.processedTrips = new Set(eng.journaledTrips);
  eng.watching = new Map(rec.watching.filter(([entryId]) => written.some((e) => e.id === entryId)));
  eng.noticedConflicts = new Set(b.state.orders.filter((o) => o.conflict).map((o) => o.id));
  const symbols = replay ? replay.symbols : [...stream!.symbols];
  const shown = pos?.view ?? rec.view;
  useTrading.setState({
    ...EMPTY,
    session: meta,
    warnings: rec.warnings,
    activeSymbol: symbols.includes(shown.activeSymbol) ? shown.activeSymbol : symbols[0],
    timeframe: TIMEFRAMES.includes(shown.timeframe) && !(stream && shown.timeframe === '1D') ? shown.timeframe : '1m',
    speed: (replay ? REPLAY_SPEEDS : SIM_SPEEDS).includes(shown.speed) ? shown.speed : replay ? 60 : 1,
  });
  if (rec.challenge) useChallenges.getState().start(rec.challenge);
  // It went on to where it had got to under the execution settings it had then. From here it trades
  // under those in use now (compared by value: settings are a new object on every page load), which
  // take effect as a change made while it runs does.
  if (JSON.stringify(getSettings().execution) !== JSON.stringify(b.cfg)) applyExecutionConfig();
  emitChart({ type: 'reset' });
  publish(true);
  resuming = null;
  void adoptSession(id);
  void processClosedTrips();
  toast('info', 'Session restored where you left off. It is paused: press Play to continue.', 6000);
  return true;
}

/** After a reload: carries on the session this tab was running, if it was kept and no other tab has it. */
export async function resumeAfterReload(): Promise<boolean> {
  try {
    const id = tabSession();
    const s = useTrading.getState();
    if (!id || s.session || s.loading) return false;
    const kept = await listSessions().catch(() => []);
    if (!kept.some((k) => k.id === id)) {
      // Ended, or running in a tab this one was duplicated from.
      rememberTabSession(null);
      return false;
    }
    return await resumeSession(id);
  } finally {
    // Carried on, or it cannot be: from here it is offered like any other.
    useTrading.setState({ carryingOn: null });
  }
}

export function play(): void {
  const s = useTrading.getState();
  if (!s.session || s.finished) return;
  useTrading.setState({ playing: true });
  startTimer();
}

export function pause(): void {
  const was = useTrading.getState().playing;
  useTrading.setState({ playing: false });
  stopTimer();
  if (was) saveSession();
}

export function togglePlay(): void {
  if (useTrading.getState().playing) pause();
  else play();
}

export function setSpeed(speed: number): void {
  useTrading.setState({ speed });
  notePositionNow();
}

export function setTimeframe(tf: Timeframe): void {
  useTrading.setState({ timeframe: tf });
  emitChart({ type: 'reset' });
  notePositionNow();
}

export function setActiveSymbol(symbol: string): void {
  if (useTrading.getState().activeSymbol === symbol) return;
  useTrading.setState({ activeSymbol: symbol });
  emitChart({ type: 'reset' });
  publish(true);
}

export function stepForward(): void {
  if (eng.replay) afterChange(eng.replay.step());
  else if (eng.stream && eng.simBroker && isDriven(eng.stream)) {
    eng.stream.advance(60);
    showStream(true);
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
  // Journal entries for trades that no longer exist in this timeline are removed (undone, not deleted).
  eng.journaledTrips = new Set([...eng.journaledTrips].filter((id) => alive.has(id)));
  await useJournal.getState().removeWhere((e) => e.sessionId === session.id && !alive.has(e.trip.id));
  eng.processedTrips = new Set([...eng.processedTrips].filter((id) => alive.has(id)));
  // An order working again after the rewind is announced again if it is cancelled again.
  const conflicts = new Set(b.state.orders.filter((o) => o.conflict).map((o) => o.id));
  eng.noticedConflicts = new Set([...eng.noticedConflicts].filter((id) => conflicts.has(id)));
  emitChart({ type: 'reset' });
  publish(true);
  saveSession();
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
    saveSession();
    void processClosedTrips();
  }
}

/** The simulated market's broker, its clock brought up to the market's time for an order action. */
function simBrokerNow(): SimBroker | null {
  if (!eng.stream || !eng.simBroker) return null;
  eng.simBroker.syncClock(eng.stream.clock);
  return eng.simBroker;
}

export function submitOrder(req: OrderRequest): SubmitResult {
  const b = broker();
  if (!b) return { ok: false, error: 'Start a replay or the simulated market first.', warnings: [] };
  const r = eng.replay ? eng.replay.submit(req) : simBrokerNow()!.submit(req);
  publish(true);
  saveSession();
  void processClosedTrips();
  return r;
}

export function cancelOrder(id: string): void {
  if (eng.replay) eng.replay.cancel(id);
  else broker()?.cancel(id);
  publish(true);
  saveSession();
}

export function cancelAllOrders(): void {
  const b = broker();
  if (!b) return;
  for (const o of b.workingOrders()) {
    if (eng.replay) eng.replay.cancel(o.id);
    else b.cancel(o.id);
  }
  publish(true);
  saveSession();
}

export function modifyOrder(id: string, changes: { limitPrice?: number; stopPrice?: number; quantity?: number }): { ok: boolean; error?: string } {
  const r = eng.replay ? eng.replay.modify(id, changes) : simBrokerNow()?.modify(id, changes) ?? { ok: false, error: 'No session' };
  publish(true);
  saveSession();
  void processClosedTrips();
  return r;
}

export function closePosition(symbol: string): SubmitResult {
  const b = broker();
  if (!b) return { ok: false, error: 'No session', warnings: [] };
  const r = eng.replay ? eng.replay.closePosition(symbol) : simBrokerNow()!.closePosition(symbol);
  publish(true);
  saveSession();
  void processClosedTrips();
  return r;
}

/** Apply changed execution settings to the running session. */
function applyExecutionConfig(): void {
  const cfg = getSettings().execution;
  if (eng.replay) eng.replay.setConfig(cfg);
  else if (eng.simBroker) eng.simBroker.cfg = cfg;
  saveSession();
}
// The running session trades under the current execution settings, however they changed (the
// settings page, a reset, another tab).
useSettings.subscribe((s, prev) => {
  if (s.execution !== prev.execution) applyExecutionConfig();
});
// Your own rules marked on a trade's review count toward a rules challenge at once, even while
// playback is paused for the review. One that ends the attempt is saved with the session.
useJournal.subscribe((s, prev) => {
  if (s.entries !== prev.entries && evaluateActiveChallenge()) saveSession();
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
  const now = eng.replay ? eng.replay.now : eng.stream?.clock;
  return broker()?.estimateFill(req, now) ?? null;
}

/**
 * The risk of the trade a new Buy or Short order would join, from the trade's first stop, as Strict
 * Mode, the trade review and the challenges measure it (SimBroker.tradeRisk), at the time submit would
 * place it.
 */
export function tradeRisk(req: OrderRequest): TradeRisk | null {
  const now = eng.replay ? eng.replay.now : eng.stream?.clock;
  return broker()?.tradeRisk(req, now) ?? null;
}

/** What submit would say is wrong with a Buy or Short order's stop loss or target (SimBroker.bracketErrors), at the time submit would place it. */
export function bracketErrors(req: OrderRequest): string[] {
  const now = eng.replay ? eng.replay.now : eng.stream?.clock;
  return broker()?.bracketErrors(req, now) ?? [];
}

/** Size by risk: the most shares whose trade risks at most `riskPct`% and that submit would accept (SimBroker.sizeByRisk). */
export function sizeByRisk(input: Omit<OrderRequest, 'quantity'>, riskPct: number): ReturnType<SimBroker['sizeByRisk']> {
  const now = eng.replay ? eng.replay.now : eng.stream?.clock;
  return broker()?.sizeByRisk(input, riskPct, now) ?? { ok: false, error: 'Start a session first.' };
}

/** The most shares of an opening order buying power covers now (SimBroker.affordableQuantity). */
export function affordableQuantity(req: Pick<OrderRequest, 'symbol' | 'action' | 'type' | 'limitPrice' | 'stopPrice' | 'extendedHours'>): number {
  const now = eng.replay ? eng.replay.now : eng.stream?.clock;
  return broker()?.affordableQuantity(req, now) ?? 0;
}

export function lastPrice(symbol: string): number | null {
  return broker()?.markPrice(symbol) ?? null;
}

/** The replay's equity at the start of the session (for display). */
export function startingBalance(): number {
  return broker()?.state.startingBalance ?? 0;
}
