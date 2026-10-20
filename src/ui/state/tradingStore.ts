/**
 * The active trading session (historical replay or simulated market) and its play loop.
 *
 * Engine objects (ReplaySession, SimMarket, SimBroker) live outside React. After every change we
 * publish a plain snapshot to the zustand store for the UI, and push bar updates to the chart over
 * a small event bus so the chart can update incrementally instead of re-rendering.
 */
import { create } from 'zustand';
import { bucketFor, candleTimeframe, ownCandles } from '../../core/data/aggregate';
import { lastIndexAtOrBefore } from '../../core/util/math';
import { TIMEFRAMES, type AccountSnapshot, type Bar, type DataSourceKind, type EquityPoint, type Fill, type Order, type OrderRequest, type Position, type RoundTrip, type Timeframe, type UnixSeconds } from '../../core/types';
import { BASE_LOOKBACK_LIMIT, DEFAULT_LOOKBACK, HISTORY_DAYS, ReplaySession, historyTimeframe, lastDataDay, loadedDays, type ChartHistory, type ReplaySetup } from '../../core/replay/ReplaySession';
import { barEnds } from '../../core/replay/ReplayEngine';
import { HOURS_DAYS, candleSpeed, cutTime, hhmm, onlyAfterHoursFollow, playOnEndDate, randomDay, sessionEndMinute, vendorPlayOnDays, vendorRandomFrom } from '../../core/replay/barReplay';
import { DataProviderError, type HistoricalDataProvider } from '../../core/data/provider';
import { DEMO_FIRST_DATE } from '../../core/data/demoProvider';
import { SimBroker, describe as describeOrder, type BrokerEvent, type SubmitResult, type TradeRisk } from '../../core/broker/SimBroker';
import { SimulationDataProvider } from '../../core/data/simulationProvider';
import { isDriven, type StreamingDataProvider, type StreamUpdate, type Unsubscribe } from '../../core/data/provider';
import { SimMarket, type SimConfig, type SimEvent } from '../../core/sim/SimMarket';
import { journalEntryFromTrip, type JournalEntry } from '../../core/journal';
import { reviewTrade, type TradeReview, type TradingRules } from '../../core/learning/review';
import { CHALLENGES, evaluateChallenge, type ChallengeDefinition } from '../../core/challenges/challenges';
import { AFTERHOURS_CLOSE, PREMARKET_OPEN, REGULAR_OPEN, addDays, exchangeDate, exchangeMinuteOfDay, exchangeTimeToUnix, isTradingDay, marketSession, nextTradingDay, parseHHMM, prevTradingDay, withoutDates } from '../../core/time';
import {
  SAVED_SESSION_VERSION,
  MAX_SAVED_SESSIONS,
  claimSession,
  deleteSession,
  keptSessions,
  listSessions,
  notePosition,
  onPositionsNotedElsewhere,
  onSessionFreed,
  readPosition,
  readSession,
  releaseSession,
  rememberTabSession,
  savedSource,
  tabSession,
  writeSession,
  type SavedSession,
  type SessionSummary,
} from '../services/savedSessions';
import { csvDatasetsLoaded, csvProvider, getProvider, onCsvDatasetsChanged } from './dataRegistry';
import { getSettings, useSettings } from './settingsStore';
import { useCredentials } from './credentials';
import { useJournal, saveSnapshot } from './journalStore';
import { useChallenges } from './challengeStore';
import { toast } from './toasts';
import { recordTradeClosed } from './streakStore';
import { reconcileSavedBlind, setLiveBlind, setSavedBlind, useLiveBlind } from './liveBlind';
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

/** The chart shown while no session runs (see browsing below). */
export interface BrowseState {
  /** Its data source (a HISTORICAL_PROVIDERS id). The symbol is the snapshot's activeSymbol. */
  providerId: string;
  /** Its bars are loading. */
  loading: boolean;
  /** Why it cannot be shown, or null. */
  error: string | null;
  /** What kind of prices it shows, once they are in (for the chart's watermark). */
  source: DataSourceKind | null;
  /** Saved sessions whose future it must not show (BrowseHold), on whatever symbol. */
  holds: BrowseHold[];
}

/**
 * A replay the chart with no session must not give away the future of: one kept to carry on later
 * (savedSessions) that is not finished and not this tab's, left unfinished or running in another tab.
 * On its data source and symbols, that chart is not drawn at all, as it would show what comes next in it
 * (and, for a blind one, the dates it hides): browseHiddenReason says why.
 */
export interface BrowseHold {
  id: string;
  /** Its data source (a HISTORICAL_PROVIDERS id). */
  providerId: string;
  /** Its symbols, primary first, in capitals. */
  symbols: string[];
  /**
   * The day of its clock, as its card of unfinished sessions names it, for one left unfinished: never for a
   * blind one, whose date it hides, nor for one another tab runs, whose clock moves on.
   */
  date?: string;
  blind: boolean;
  /** Whether another tab runs it (else it is left unfinished, to resume). */
  elsewhere: boolean;
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
   * that it cannot (or, sooner, the app has found it is no longer kept): meanwhile it is not offered to
   * resume or discard, since the reload carries it on itself.
   */
  carryingOn: string | null;
  /** With no session: the chart's data source and how its bars are loading. Starting or ending a session leaves it as it is. */
  browse: BrowseState;
  /** Bar Replay's select-bar mode: the next click on a candle starts a replay there (startBarReplay). */
  selectingBar: boolean;
}

// ------------------------------------------------------------------ chart bus

/**
 * `tick` carries the simulated 1m bars a step touched, oldest first, each in its latest state: the
 * forming bar is re-sent with cumulative values, and a fast step can finish several minutes at once.
 * `history` says the bars from before a replay's loaded bars (getChartHistory) arrived for `symbol`,
 * or failed to. A `reset` with `cut` is a bar replay started from a bar of the chart shown before it
 * (startBarReplay): the chart keeps its zoom, with room after that bar for the bars to come.
 */
export type ChartEvent = { type: 'reset'; cut?: boolean } | { type: 'append'; symbol: string; bars: Bar[] } | { type: 'tick'; symbol: string; bars: Bar[] } | { type: 'history'; symbol: string };
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

/** What starting or ending a session resets: not carryingOn, which only the reload settles, nor what the chart shows with no session. */
const EMPTY: Omit<TradingSnapshot, 'carryingOn' | 'browse'> = {
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
  selectingBar: false,
};

/** The chart the app opens on, with no session: the symbol, timeframe and data source last used (settings.replay). */
function openingChart(): Pick<TradingSnapshot, 'activeSymbol' | 'timeframe' | 'browse'> {
  const r = getSettings().replay;
  return {
    activeSymbol: r.symbol.trim().toUpperCase() || EMPTY.activeSymbol,
    timeframe: TIMEFRAMES.includes(r.timeframe) ? r.timeframe : EMPTY.timeframe,
    browse: { providerId: r.providerId, loading: false, error: null, source: null, holds: [] },
  };
}

export const useTrading = create<TradingSnapshot>()(() => ({ ...EMPTY, ...openingChart(), carryingOn: tabSession() }));

// As the app opens: a session this tab was running that is no longer kept at all (it ended, or was
// discarded) cannot come back, which is known before the journal and imported data are in. One kept
// but held by another tab still waits for resumeAfterReload: just after a reload, the page before may
// not have let go of it yet.
if (typeof window !== 'undefined') {
  const id = tabSession();
  if (id)
    void keptSessions()
      .then((kept) => {
        if (kept.some((k) => k.id === id) || useTrading.getState().carryingOn !== id) return;
        if (tabSession() === id) rememberTabSession(null);
        useTrading.setState({ carryingOn: null });
      })
      .catch(() => undefined);
}

// Other open tabs keep this tab's running blind session's dates hidden too (they share the journal).
useTrading.subscribe((s, prev) => {
  if (s.session !== prev.session) setLiveBlind(s.session?.blind ? { id: s.session.id, start: s.session.startDate } : null);
});

function broker(): SimBroker | null {
  return eng.replay?.broker ?? eng.simBroker;
}

// ------------------------------------------------------------------ browsing: the chart with no session

/**
 * With no session running, the chart shows the chosen symbol's real chart up to the end of its data
 * (ReplaySession.preview), with the history a replay's chart has, to look at and pick a bar to replay
 * from (Bar Replay). Only the chart reads it, through getBaseBars, getChartHistory, getBaseTimeframe
 * and candleStarts: it is no session, so no quote, account, order, journal entry, save, challenge or
 * Play ever sees it. Its bars load when a chart first asks for them.
 */
const browseEng: {
  /** The bars shown, and what they were loaded for (browseTarget's key). */
  preview: ReplaySession | null;
  key: string | null;
  /** The load under way, which a newer one (or a session starting) stops and discards. */
  loading: { key: string; abort: AbortController } | null;
  /** The load that failed, not tried again until something changes (retryBrowse). */
  failed: string | null;
  /** Counts changes to the imported data, so imported bars are loaded again after one. */
  csvVersion: number;
} = { preview: null, key: null, loading: null, failed: null, csvVersion: 0 };

/**
 * Trading days of bars at their own size the chart with no session loads before the last day of its data,
 * whatever its timeframe: as many as a replay loads at most (BASE_LOOKBACK_LIMIT, loadedDays), so one load
 * serves every timeframe, and a switch of timeframe asks the data source for nothing more (on Polygon's free
 * plan, five requests a minute, each one counts). Charts of 30 minutes and more draw their longer past from
 * the history (loadHistory), once, for all of them.
 */
const BROWSE_DAYS = BASE_LOOKBACK_LIMIT;

/**
 * What the chart with no session shows: the data source and the symbol (and, for imported data, which
 * version of it), with BROWSE_DAYS of their bars, up to the end of the data.
 */
function browseTarget(): { key: string; prefix: string; provider: HistoricalDataProvider; symbol: string; days: number } {
  const s = useTrading.getState();
  const provider = getProvider(s.browse.providerId);
  const symbol = s.activeSymbol.toUpperCase();
  const prefix = `${provider.id}|${symbol}|`;
  return { key: `${prefix}${provider === csvProvider ? browseEng.csvVersion : ''}`, prefix, provider, symbol, days: BROWSE_DAYS };
}

/**
 * The last day of the bars the chart with no session shows of `symbol`, or '' when it shows none. The chart
 * (ChartView) opens afresh on bars that end on another day than those it drew before.
 */
export function browseShownEnd(symbol: string): string {
  return shownPreview(symbol)?.setup.date ?? '';
}

/** Whether nothing runs, so the chart shows the browsing chart. A reload carrying its session on shows nothing meanwhile. */
function browsing(): boolean {
  return !eng.replay && !eng.stream && !useTrading.getState().carryingOn;
}

/**
 * The bars the chart shows for `symbol` with no session, or null (a session runs, none have loaded for
 * what is chosen, or a saved session on it keeps it from being drawn: browseHoldOn). While imported data is
 * read again, the symbol's chart stays as it was.
 */
function shownPreview(symbol: string): ReplaySession | null {
  const p = browseEng.preview;
  const t = browseTarget();
  if (!p || !browsing() || !browseEng.key?.startsWith(t.prefix) || p.symbol !== symbol.toUpperCase()) return null;
  return browseHoldOn(t.provider.id, p.symbol) ? null : p;
}

/**
 * shownPreview, after starting to load what is chosen if that is not loaded (not while a session is
 * starting, nor for a chart a saved session on it keeps from being drawn: its bars are not asked for).
 */
function browsePreview(symbol: string): ReplaySession | null {
  if (browsing() && !useTrading.getState().loading) {
    const t = browseTarget();
    const held = holdsKnown && !!browseHoldOn(t.provider.id, t.symbol);
    if (!held && t.key !== browseEng.key && t.key !== browseEng.loading?.key && t.key !== browseEng.failed) void loadBrowse(t);
  }
  return shownPreview(symbol);
}

function setBrowse(patch: Partial<BrowseState>): void {
  useTrading.setState((s) => ({ browse: { ...s.browse, ...patch } }));
}

/** Why a ticker the data source lists its tickers for is not one of them, or null when it is. */
async function notListed(provider: HistoricalDataProvider, symbol: string): Promise<string | null> {
  if (provider !== csvProvider && provider.id !== 'demo') return null;
  if (await provider.availableRange(symbol)) return null;
  const list = (await provider.listSymbols()).map((x) => x.symbol);
  return `${provider === csvProvider ? 'Your imported data' : 'The demo data'} has no ${symbol}. Choose one of: ${list.slice(0, 12).join(', ')}${list.length > 12 ? ', …' : ''}.`;
}

/** Short names of the data sources that take any ticker typed in (rather than listing theirs), for messages. */
const VENDOR_NAMES: Record<string, string> = { polygon: 'Polygon', alpaca: 'Alpaca' };

/**
 * Why `symbol`'s bars from `provider` could not be loaded, as the user should read it. A vendor that has
 * no bars at all for it (or says it does not know it) was most likely given an unknown or mistyped ticker,
 * so that is said plainly instead of in the vendor's words; its other errors (a rejected key, the rate
 * limit, no connection) read as they are. `date`: the day a replay was to start on.
 */
function loadFailure(provider: HistoricalDataProvider, symbol: string, e: unknown, date?: string): string {
  const vendor = VENDOR_NAMES[provider.id];
  if (vendor && e instanceof DataProviderError && e.kind === 'not_found')
    return date ? `${vendor} has no bars for ${symbol} around ${date}. Check the ticker, or pick another date.` : `${vendor} has no bars for ${symbol}. Check the ticker.`;
  return (e as Error).message;
}

/** Loads the browsing chart's bars for `t`; a newer load, or a session starting, discards it. */
async function loadBrowse(t: ReturnType<typeof browseTarget>): Promise<void> {
  browseEng.loading?.abort.abort();
  const mine = { key: t.key, abort: new AbortController() };
  browseEng.loading = mine;
  browseEng.failed = null;
  setBrowse({ loading: true, error: null });
  const current = () => browseEng.loading === mine;
  try {
    // Imported data is there only once the app has read it, which can be after the chart asks as the app opens.
    if (t.provider === csvProvider && t.provider.unavailableReason()) await csvDatasetsLoaded();
    if (!current()) return;
    const reason = t.provider.unavailableReason() ?? (await notListed(t.provider, t.symbol));
    if (reason) throw new Error(reason);
    // The saved sessions that keep a symbol's chart from being drawn are known before any bar is loaded: a
    // held symbol's bars are not asked for at all (browsePreview; on Polygon or Alpaca each load is a
    // request). They are looked at again on every load, alongside the bars, as they may have changed in
    // another tab.
    if (!holdsKnown) await refreshHolds();
    if (!current()) return;
    if (browseHoldOn(t.provider.id, t.symbol)) {
      browseEng.loading = null;
      setBrowse({ loading: false });
      if (browsing()) emitChart({ type: 'reset' });
      return;
    }
    const [preview] = await Promise.all([ReplaySession.preview(t.provider, { symbol: t.symbol, lookbackDays: t.days }, mine.abort.signal), refreshHolds()]);
    if (!current()) return;
    // The data's last day, which the preview ends on: what a cut plays on to reads it (cutWarning).
    noteDataDays(t.provider, t.symbol, preview.setup.date);
    browseEng.loading = null;
    browseEng.preview = preview;
    browseEng.key = t.key;
    setBrowse({ loading: false, error: null, source: preview.broker.state.source });
  } catch (e) {
    if (!current()) return;
    browseEng.loading = null;
    browseEng.failed = t.key;
    browseEng.preview = null;
    browseEng.key = null;
    setBrowse({ loading: false, error: loadFailure(t.provider, t.symbol, e), source: null });
  }
  if (browsing()) emitChart({ type: 'reset' });
}

/** Stops a load of the browsing chart under way (a session is starting): it is loaded again when the chart next asks. */
function stopBrowseLoad(): void {
  if (!browseEng.loading) return;
  browseEng.loading.abort.abort();
  browseEng.loading = null;
  setBrowse({ loading: false });
}

/** Tries the browsing chart's load again after it failed (a key added, the data imported, Try again). */
export function retryBrowse(): void {
  if (!browseEng.failed) return;
  browseEng.failed = null;
  setBrowse({ error: null });
  if (browsing()) emitChart({ type: 'reset' });
}

// ------------------------------------------------------------------ browsing: the saved sessions that keep a chart from it

/**
 * The saved sessions the browsing chart must not show the future of (BrowseHold), as last read
 * (refreshHolds): in the store (browse.holds) for the screens that show them. Until the first read is in,
 * no browsing chart's bars are loaded (loadBrowse waits for it).
 */
let holdsKnown = false;
/** Reads of the saved sessions asked for, and the newest one whose answer is in use. */
let holdsAsked = 0;
let holdsApplied = 0;
/** Sessions this tab ran and ended: kept for a moment more while they are deleted, but no longer held to. */
const endedHere = new Set<string>();
/** Each saved session's data source (savedSource), read once: it never changes. */
const sessionSources = new Map<string, string | null>();

/**
 * The hold the browsing chart of `symbol` from data source `providerId` is under, or null: every saved
 * session on that symbol and source that is held to (BrowseHold), as one, which keeps that chart from being
 * drawn. Blind when any of them is; `elsewhere` when one of those (the blind ones, if any) runs in another
 * tab. Not this tab's own session, nor one it has ended.
 */
export function browseHoldOn(providerId: string, symbol: string, holds = useTrading.getState().browse.holds): { blind: boolean; elsewhere: boolean } | null {
  const on = holdsOn(providerId, symbol, holds);
  if (!on.length) return null;
  const blind = on.filter((h) => h.blind);
  const shown = blind.length ? blind : on;
  return { blind: blind.length > 0, elsewhere: shown.some((h) => h.elsewhere) };
}

/** The saved sessions held to on `symbol` from data source `providerId` (browseHoldOn), each on its own. */
function holdsOn(providerId: string, symbol: string, holds = useTrading.getState().browse.holds): BrowseHold[] {
  const own = useTrading.getState().session?.id;
  const sym = symbol.toUpperCase();
  return holds.filter((h) => h.providerId === providerId && h.symbols.includes(sym) && h.id !== own && !endedHere.has(h.id));
}

/** The saved sessions held to (BrowseHold): every replay kept that has not finished, read from storage. */
async function readHolds(): Promise<BrowseHold[]> {
  const [kept, free] = await Promise.all([keptSessions(), listSessions()]);
  const freeIds = new Set(free.map((f) => f.id));
  const out: BrowseHold[] = [];
  for (const k of kept) {
    const m = k.meta;
    if (k.finished || m?.mode !== 'replay' || !Array.isArray(m.symbols) || !Number.isFinite(k.now)) continue;
    if (!sessionSources.has(k.id)) sessionSources.set(k.id, await savedSource(k.id).catch(() => null));
    const source = sessionSources.get(k.id);
    // One whose record cannot be read cannot be carried on either.
    if (!source) continue;
    // Where its clock is plays no part in what is hidden: the chart is not drawn whatever it is, so another tab
    // playing it on asks nothing of this one (on Polygon or Alpaca, no request). Only one left to resume, not
    // blind, is named by its day, which does not move.
    const elsewhere = !freeIds.has(k.id);
    const date = !m.blind && !elsewhere ? { date: exchangeDate(k.now) } : {};
    out.push({ id: k.id, providerId: getProvider(source).id, symbols: m.symbols.map((x) => String(x).toUpperCase()), ...date, blind: !!m.blind, elsewhere });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Stops listening for a session another tab runs being let go there. */
let stopFreed: (() => void) | null = null;
let freedIds = '';

/**
 * Reads the saved sessions held to again (readHolds) and, when they changed, puts them in the store and
 * redraws the browsing chart. Storage that cannot be read holds nothing: nothing can be carried on then.
 */
async function refreshHolds(): Promise<void> {
  const seq = ++holdsAsked;
  const next = await readHolds().catch(() => [] as BrowseHold[]);
  if (seq < holdsApplied) return;
  holdsApplied = seq;
  holdsKnown = true;
  // A session another tab runs is looked at again once that tab lets it go (closed, or crashed).
  const elsewhere = next.filter((h) => h.elsewhere).map((h) => h.id).join(',');
  if (elsewhere !== freedIds) {
    freedIds = elsewhere;
    stopFreed?.();
    stopFreed = elsewhere ? onSessionFreed(() => void refreshHolds()) : null;
  }
  if (JSON.stringify(next) === JSON.stringify(useTrading.getState().browse.holds)) return;
  setBrowse({ holds: next });
  if (browsing()) emitChart({ type: 'reset' });
}

/** refreshHolds, at most about once a second (another tab notes its clock on every step of play). */
let holdsTimer: ReturnType<typeof setTimeout> | null = null;
let holdsReadAt = -Infinity;
function refreshHoldsSoon(): void {
  if (holdsTimer) return;
  holdsTimer = setTimeout(
    () => {
      holdsTimer = null;
      holdsReadAt = performance.now();
      void refreshHolds();
    },
    Math.max(0, holdsReadAt + 1000 - performance.now()),
  );
}

if (typeof window !== 'undefined') {
  // Another tab started, played, saved or ended a session, or listed or let go of a blind one; or this
  // tab comes back into view.
  onPositionsNotedElsewhere(refreshHoldsSoon);
  useLiveBlind.subscribe(refreshHoldsSoon);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshHoldsSoon());
  window.addEventListener('focus', refreshHoldsSoon);
}
// A session starting or ending here, or one carried on: what is held to changes with it.
useTrading.subscribe((s, prev) => {
  if (s.session !== prev.session) void refreshHolds();
});

/** A symbol's last daily close, and its change from the close before, as the browsing watchlist shows it. */
export interface LastClose {
  last: number;
  changePct: number | null;
}

/** browseLastClose's answers, by `source|symbol`. */
const lastCloses = new Map<string, Promise<LastClose | null>>();
if (typeof window !== 'undefined') onCsvDatasetsChanged(() => [...lastCloses.keys()].filter((k) => k.startsWith('csv|')).forEach((k) => lastCloses.delete(k)));

/**
 * `symbol`'s last daily close in local data (the demo's or an imported file's, from data source `providerId`)
 * and its change from the close before, as the watchlist shows it with no session; none while a saved session
 * on it keeps its chart from being drawn (browseHoldOn), as the close would give away what comes next in it.
 * Worked out once each (a couple of days of bars), again for imported data once it changes. Null for Polygon
 * and Alpaca, which are never asked: each would spend the visitor's rate limit.
 */
export async function browseLastClose(providerId: string, symbol: string): Promise<LastClose | null> {
  const provider = getProvider(providerId);
  const sym = symbol.toUpperCase();
  if (provider !== csvProvider && provider.id !== 'demo') return null;
  // The watchlist can ask before the chart has read the saved sessions.
  if (!holdsKnown) await refreshHolds();
  if (browseHoldOn(provider.id, sym)) return null;
  const key = `${provider.id}|${sym}`;
  let p = lastCloses.get(key);
  if (!p) {
    p = lastClose(provider, sym).catch(() => null);
    lastCloses.set(key, p);
  }
  return p;
}

async function lastClose(provider: HistoricalDataProvider, symbol: string): Promise<LastClose | null> {
  const range = await provider.availableRange(symbol);
  if (!range) return null;
  const last = exchangeDate(range.to);
  // Imported files can skip days (sessionDates): a few days back finds the close before the last one.
  let from = last;
  for (let i = 0; i < (provider.sessionDates ? 6 : 2); i++) from = prevTradingDay(from);
  const req = { symbol, from: exchangeTimeToUnix(from, PREMARKET_OPEN), to: exchangeTimeToUnix(addDays(last, 1), 0) };
  const days = provider.getCoarseBars ? await provider.getCoarseBars(req, '1D') : [];
  const end = days[days.length - 1];
  const prev = days[days.length - 2];
  if (!end) return null;
  return { last: end.close, changePct: prev ? (end.close / prev.close - 1) * 100 : null };
}

// ------------------------------------------------------------------ when a bar replay's data ends

/**
 * Per data source and symbol (`id|SYMBOL`), the last day of the data (lastDataDay) and the days it has bars
 * on when it can have gaps (sessionDates), as last asked: for what select-bar mode says about a bar before
 * it is clicked (cutWarning), which cannot wait for them.
 */
const dataDays = new Map<string, { last: string; dates: readonly string[] | null }>();

function noteDataDays(provider: HistoricalDataProvider, symbol: string, last: string, dates?: readonly string[] | null): void {
  const key = `${provider.id}|${symbol.toUpperCase()}`;
  const known = dataDays.get(key);
  dataDays.set(key, { last, dates: dates === undefined ? (known?.dates ?? null) : dates });
  // An imported file's days with bars, asked for once (they are in memory).
  if (dates === undefined && provider.sessionDates && known?.dates === undefined)
    void provider.sessionDates(symbol).then((d) => dataDays.set(key, { last: dataDays.get(key)?.last ?? last, dates: d }), () => undefined);
}

/** Asks for `symbol`'s data days from `provider` (noteDataDays), in the background. */
function learnDataDays(provider: HistoricalDataProvider, symbol: string): void {
  void lastDataDay(provider, symbol).then((last) => noteDataDays(provider, symbol, last), () => undefined);
}

/** Keeps what the browsing chart shows for the next visit and for the next replay set up (settings.replay). */
function rememberChart(patch: { providerId?: string; symbol?: string; timeframe?: Timeframe }): void {
  const r = getSettings().replay;
  const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && v !== r[k as keyof typeof patch]));
  if (Object.keys(changed).length) useSettings.getState().updateReplay(changed);
}

/**
 * With no session: charts `symbol` (in capitals) from the data source `providerId` (a HISTORICAL_PROVIDERS
 * id), both in one change, so no load starts for the one without the other (on Polygon or Alpaca every
 * load spends the visitor's rate limit). Kept for the next visit and the next replay set up. During a
 * session it does nothing: the session's own symbols are switched with setActiveSymbol.
 */
export function browseSymbol(providerId: string, symbol: string): void {
  const s = useTrading.getState();
  const next = symbol.trim().toUpperCase();
  const id = getProvider(providerId).id;
  if (s.session || !next) return;
  // Chosen again after it could not be shown: it is tried again.
  if (s.activeSymbol === next && s.browse.providerId === id) return retryBrowse();
  useTrading.setState({ activeSymbol: next, selectingBar: false, browse: { ...s.browse, providerId: id, error: null } });
  rememberChart({ providerId: id, symbol: next });
  emitChart({ type: 'reset' });
}

/** The data source of the chart shown with no session (a HISTORICAL_PROVIDERS id); its symbol is set by setActiveSymbol. */
export function setBrowseSource(providerId: string): void {
  const s = useTrading.getState();
  if (s.browse.providerId === providerId) return;
  setBrowse({ providerId, error: null });
  rememberChart({ providerId });
  if (!s.session) {
    useTrading.setState({ selectingBar: false });
    emitChart({ type: 'reset' });
  }
}

if (typeof window !== 'undefined') {
  // Imported data read, added or deleted: the browsing chart of it loads again. A key added or the
  // server's keys known: a load that failed for want of one is tried again.
  onCsvDatasetsChanged(() => {
    browseEng.csvVersion++;
    for (const k of [...dataDays.keys()]) if (k.startsWith('csv|')) dataDays.delete(k);
    if (browseEng.failed?.startsWith('csv|')) browseEng.failed = null;
    if (useTrading.getState().browse.providerId === 'csv' && browsing()) emitChart({ type: 'reset' });
  });
  useCredentials.subscribe(() => retryBrowse());
}

// A reload that could not carry its session on, or a start that failed, leaves the browsing chart to show.
useTrading.subscribe((s, prev) => {
  if (!s.session && ((prev.carryingOn && !s.carryingOn) || (prev.loading && !s.loading))) emitChart({ type: 'reset' });
});

// ------------------------------------------------------------------ data access for the chart

/**
 * Revealed base bars for a symbol (replay) or generated history (sim); with no session, the browsing chart's,
 * none while a saved session on it keeps it from being drawn (browseHoldOn). Never future data.
 */
export function getBaseBars(symbol: string): Bar[] {
  if (eng.replay) return eng.replay.engineFor(symbol)?.visibleBaseBars() ?? [];
  if (eng.stream) return eng.stream.getHistory(symbol);
  return browsePreview(symbol)?.engineFor(symbol)?.visibleBaseBars() ?? [];
}

/**
 * What a `timeframe` chart of `symbol` draws from before the replay's loaded bars (ReplaySession.chartHistory),
 * or null outside a replay (with no session, the browsing chart's, when getBaseBars gives its bars). The first
 * chart that wants it starts loading it (`retry`: again after a failure), and a 'history' chart event says
 * when it has arrived. With no session, only for the bars wanted: not for those shown while others load to
 * take their place (imported data read again), which would spend a vendor's request for nothing.
 */
export function getChartHistory(symbol: string, timeframe: Timeframe, retry = false): ChartHistory | null {
  const browse = !eng.replay && !eng.stream;
  const replay = eng.replay ?? (eng.stream ? null : browsePreview(symbol));
  const h = replay?.chartHistory(symbol, timeframe);
  if (!replay || !h) return null;
  if (!h.wanted || !(h.status === 'idle' || (retry && h.status === 'failed')) || (browse && browseEng.key !== browseTarget().key)) return h;
  void replay.loadHistory(symbol).then(() => {
    if (eng.replay === replay || (!eng.replay && browseEng.preview === replay && browsing())) emitChart({ type: 'history', symbol });
  });
  return replay.chartHistory(symbol, timeframe);
}

/** The size of `symbol`'s base bars: the replay's data (or the browsing chart's), or the simulated market's 1-minute bars. */
export function getBaseTimeframe(symbol: string): Timeframe {
  return (eng.replay ?? (eng.stream ? null : browsePreview(symbol)))?.engineFor(symbol)?.baseTimeframe ?? '1m';
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
  const e = (eng.replay ?? (eng.stream ? null : browsePreview(symbol)))?.engineFor(symbol);
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
  // The chart with no session is no longer kept from its symbols for it (BrowseHold), though it is kept a moment more.
  endedHere.add(id);
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
      void refreshHolds();
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
    // Nothing is left of it for a reload of this tab to carry on.
    if (tabSession() === id) rememberTabSession(null);
  } finally {
    releaseSession(id);
  }
  // The chart with no session is no longer kept from its symbols for it (BrowseHold).
  await refreshHolds();
  return true;
}

// ------------------------------------------------------------------ public actions

function resetEngines(): void {
  stopTimer();
  // The browsing chart's bars still loading are not wanted now; those loaded are kept for coming back to it.
  stopBrowseLoad();
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
export function sessionEndNotice(action: 'start' | 'exit' = 'start'): string | null {
  const open = broker()?.openPositions() ?? [];
  if (!useTrading.getState().session || open.length === 0) return null;
  const list = open.map((p) => `${p.symbol} ${p.quantity > 0 ? 'long' : 'short'} ${Math.abs(p.quantity)}`).join(', ');
  return `${action === 'exit' ? 'Exiting ends this session.' : 'Starting a new session ends this one.'} Your open ${open.length === 1 ? 'position' : 'positions'} (${list}) will be closed at the last price, as a market order would close ${open.length === 1 ? 'it' : 'them'}, and journaled with the exit reason "Session ended". Working orders are cancelled.`;
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
 * store) or a newer start or end took its place. `cut`: started from a bar of the chart (startBarReplay).
 */
export async function startReplay(
  options: ReplaySetup & { providerId: string; timeframe: Timeframe; speed: number; blind: boolean; challengeId?: string; cut?: boolean; retryOn?: (e: unknown) => boolean },
): Promise<boolean> {
  // `retryOn`: a load failure it says yes to is left to the caller, who tries another day (Random bar):
  // nothing is shown, and the loading note stays up.
  const { cut, retryOn, ...setup } = options;
  const seq = ++loadSeq;
  const provider = getProvider(setup.providerId);
  // Imported data is there only once the app has read it, which can be after this is asked for as it opens.
  if (provider === csvProvider && provider.unavailableReason()) await csvDatasetsLoaded();
  if (seq !== loadSeq) return false;
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
    if ((e as Error).name === 'AbortError' || seq !== loadSeq || retryOn?.(e)) return false;
    // A blind replay's date stays hidden, also when it could not be loaded (a random date was picked for it).
    const message = loadFailure(provider, setup.symbol.toUpperCase(), e, setup.date);
    useTrading.setState({ loading: false, error: setup.blind ? withoutDates(message) : message });
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
  emitChart(cut ? { type: 'reset', cut } : { type: 'reset' });
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

/**
 * Ends the running session (endCurrent): its open positions are closed at the last price and journaled.
 * The chart goes back to browsing on the same timeframe: a replay's symbol from its data source; after
 * the simulated market, whose stocks are made up, the symbol browsed before it.
 */
export async function endSession(): Promise<void> {
  const seq = ++loadSeq;
  useTrading.setState({ loading: false });
  const providerId = eng.replay ? eng.providerId : null;
  await endCurrent();
  if (seq !== loadSeq) return;
  const sim = !!eng.stream;
  resetEngines();
  const s = useTrading.getState();
  const symbol = sim ? getSettings().replay.symbol.trim().toUpperCase() || EMPTY.activeSymbol : s.activeSymbol.toUpperCase();
  // A browsing chart that could not be loaded before the session is tried again, once: its error goes
  // with the mark that keeps it from being tried (it comes back if it fails again, with Try again).
  browseEng.failed = null;
  useTrading.setState({ ...EMPTY, activeSymbol: symbol, timeframe: s.timeframe, browse: { ...s.browse, providerId: providerId ?? s.browse.providerId, error: null } });
  rememberChart({ providerId: providerId ?? undefined, symbol, timeframe: s.timeframe });
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
      // Imported data is there only once the app has read it, which can be after Resume is pressed as it opens.
      if (provider === csvProvider && provider.unavailableReason()) await csvDatasetsLoaded();
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

/** Plays the session; picking a bar to replay from stops, as the chart is about to move under it. */
export function play(): void {
  const s = useTrading.getState();
  if (!s.session || s.finished) return;
  useTrading.setState({ playing: true, selectingBar: false });
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

/** The chart's timeframe; with no session it is kept for the next visit (settings.replay). Picking a bar to replay from stops. */
export function setTimeframe(tf: Timeframe): void {
  useTrading.setState({ timeframe: tf, selectingBar: false });
  if (!useTrading.getState().session) rememberChart({ timeframe: tf });
  emitChart({ type: 'reset' });
  notePositionNow();
}

/**
 * The symbol the chart shows. During a session, one of its symbols; with no session, any symbol of the
 * browsing chart's data source (in capitals), kept for the next visit and the next replay set up. Picking
 * a bar to replay from stops.
 */
export function setActiveSymbol(symbol: string): void {
  const s = useTrading.getState();
  const next = s.session ? symbol : symbol.trim().toUpperCase();
  if (!next || s.activeSymbol === next) return;
  useTrading.setState({ activeSymbol: next, selectingBar: false });
  if (!s.session) rememberChart({ symbol: next });
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

// ------------------------------------------------------------------ Bar Replay

/**
 * Why a bar cannot be picked on the chart to replay from now, or null when it can: a blind replay would
 * show its dates (a bar replay is not blind), the simulated market's made-up stocks have no data to
 * replay, and with no session the chart needs bars to pick from first (it has none while a saved session
 * on its symbol keeps it from being drawn: browseHiddenReason).
 */
export function selectBarBlocked(): string | null {
  const s = useTrading.getState();
  if (s.session?.blind) return 'A blind replay hides its dates, and picking a bar would show them. Exit the replay first.';
  if (s.session?.mode === 'sim') return 'The simulated market has no past data to replay. Exit it first.';
  if (!s.session && !shownPreview(s.activeSymbol)) return browseHiddenReason() ?? s.browse.error ?? 'The chart is still loading.';
  return null;
}

/**
 * Why the chart with no session does not draw its symbol, or null when nothing keeps it from it: a replay of
 * that symbol and data source you have not finished, or one running in another tab (browseHoldOn), as the
 * chart would show what comes next in it, and, for a blind one, the dates it hides (so its words name none).
 * Select date… and Random bar are off then too (a replay from a date, random or not, would show the same),
 * and so is Select bar, as the chart has no bar to pick. Advanced replay setup is the way around it.
 */
export function browseHiddenReason(): string | null {
  const s = useTrading.getState();
  if (s.session || !browsing()) return null;
  const sym = s.activeSymbol.toUpperCase();
  const on = holdsOn(getProvider(s.browse.providerId).id, sym);
  if (!on.length) return null;
  const blind = on.filter((h) => h.blind);
  if (blind.length)
    return blind.some((h) => h.elsewhere) ? `A blind replay of ${sym} is running in another tab. Its chart stays hidden here until that replay ends, as its date does.` : `A blind replay of ${sym} is unfinished. Resume or discard it to chart ${sym} here.`;
  // One left to resume says what to do about it, as its card does; one another tab runs only ends there.
  const mine = on.filter((h) => !h.elsewhere);
  if (!mine.length) return `A ${sym} replay is running in another tab, so ${sym} is not charted here (it would show what comes next there). It is charted here again once that replay ends.`;
  const which = mine.length === 1 ? `your ${mine[0].symbols[0]} replay${mine[0].date ? ` of ${mine[0].date}` : ''} is` : `${mine.length} of your ${sym} replays are`;
  return `${sym} is not charted here while ${which} unfinished (it would show what comes next). Resume or discard ${mine.length === 1 ? 'it' : 'them'} to chart ${sym} here.`;
}

/**
 * Why Random bar will not start a replay of the chart's symbol now, or null: with no session, what keeps that
 * symbol's chart from being drawn (browseHiddenReason); during one, a saved session other than it on that
 * symbol and data source (a replay you have not finished, or one in another tab, BrowseHold), as the day it
 * picks could be one of that replay's, from its clock on. Select date… is a day you pick, and the full setup
 * form the way around it.
 */
export function randomBarBlocked(): string | null {
  const s = useTrading.getState();
  if (!s.session) return browseHiddenReason();
  const { providerId, symbol } = barReplaySource();
  const hold = browseHoldOn(getProvider(providerId).id, symbol);
  if (!hold) return null;
  const which = hold.blind ? `a blind replay of ${symbol}` : `a ${symbol} replay`;
  return `Random bar is off while ${which} ${hold.elsewhere ? 'is running in another tab' : 'is unfinished'}: it could pick one of that replay's days, after its clock.`;
}

/** Select-bar mode on or off (selectingBar). On, playback pauses and a price pick waiting for the chart is let go. */
export function setSelectingBar(on: boolean): void {
  if (!on) {
    if (useTrading.getState().selectingBar) useTrading.setState({ selectingBar: false });
    return;
  }
  if (selectBarBlocked()) return;
  pause();
  useTrading.setState({ selectingBar: true, pickTarget: null });
  // What follows a bar is told before it is clicked (cutWarning): the data's last day, if not known yet.
  const { providerId, symbol } = barReplaySource();
  if (!dataDays.has(`${getProvider(providerId).id}|${symbol}`)) learnDataDays(getProvider(providerId), symbol);
}

/**
 * Where a replay started from the chart takes its bars: the chart's data source and symbol. While the
 * simulated market runs, whose stocks are made up, the symbol and data source browsed before it.
 */
export function barReplaySource(): { providerId: string; symbol: string } {
  const s = useTrading.getState();
  if (eng.replay && eng.providerId) return { providerId: eng.providerId, symbol: s.activeSymbol.toUpperCase() };
  const symbol = eng.stream ? getSettings().replay.symbol : s.activeSymbol;
  return { providerId: getProvider(s.browse.providerId).id, symbol: symbol.trim().toUpperCase() };
}

/** The replay or browsing chart that shows `symbol` from `providerId`, if the chart shows one. */
function chartData(providerId: string, symbol: string): ReplaySession | null {
  if (eng.replay) return eng.providerId === providerId && eng.replay.engineFor(symbol) ? eng.replay : null;
  const p = shownPreview(symbol);
  return p && browseEng.key?.startsWith(`${providerId}|`) ? p : null;
}

/**
 * What a replay's (or the browsing chart's) bars of a symbol tell, as the chart shows them on a timeframe
 * (knownBars): its loaded bars first, then the history before them.
 */
interface KnownBars {
  /** When the replay cut at the chart's candle that starts at `start` begins (cutTime); null when no bar shown is in it. */
  cutTime(start: UnixSeconds): UnixSeconds | null;
  /** When the data's sessions end around `day` (sessionEndMinute); null when no bar shown is in those days. */
  sessionEnd(day: string): number | null;
}

/** When each bar of a history ends (barEnds), worked out once for each history loaded. */
const historyEnds = new WeakMap<readonly Bar[], UnixSeconds[]>();

/**
 * What `replay`'s bars of `symbol` the chart can show on a `timeframe` chart tell (KnownBars): the revealed
 * ones, then the history before them, so no bar it does not show can be cut at or tell the hours. Worked out on
 * the bars where they are, none of them copied: select-bar mode asks about every candle the pointer crosses
 * (cutWarning), in replays of tens of thousands of bars. The history is looked at only when the loaded bars
 * say nothing.
 */
function knownBars(replay: ReplaySession | null, symbol: string, timeframe: Timeframe): KnownBars {
  const e = replay?.engineFor(symbol);
  if (!replay || !e) return { cutTime: () => null, sessionEnd: () => null };
  let past: { bars: readonly Bar[]; ends: readonly UnixSeconds[]; timeframe: Timeframe } | null | undefined;
  const history = () => {
    if (past !== undefined) return past;
    const h = replay.chartHistory(symbol, timeframe);
    if (!h?.bars.length) return (past = null);
    let ends = historyEnds.get(h.bars);
    if (!ends) historyEnds.set(h.bars, (ends = barEnds(h.bars, h.timeframe)));
    return (past = { bars: h.bars, ends, timeframe: h.timeframe });
  };
  return {
    cutTime: (start) => {
      const t = e.cutTime(start, timeframe);
      const h = t === null ? history() : null;
      return h ? cutTime(start, timeframe, h.bars, h.ends, h.timeframe) : t;
    },
    sessionEnd: (day) => {
      const close = e.sessionEndMinute(day);
      const h = close === null ? history() : null;
      return h ? sessionEndMinute(h.bars, h.ends, day) : close;
    },
  };
}

/**
 * When the data's sessions end (sessionEndMinute) around `day`, in minutes: from the bars `known` that cover
 * those days, else from bars of them asked of the data source.
 */
async function sessionClose(provider: HistoricalDataProvider, symbol: string, day: string, known: KnownBars): Promise<number> {
  const close = known.sessionEnd(day);
  if (close !== null) return close;
  let from = day;
  for (let i = 0; i < HOURS_DAYS; i++) from = prevTradingDay(from);
  const bars = await provider.getBars({ symbol, from: exchangeTimeToUnix(from, PREMARKET_OPEN), to: exchangeTimeToUnix(nextTradingDay(day), 0) });
  return sessionEndMinute(bars, barEnds(bars, provider.baseTimeframe(symbol)), day) ?? AFTERHOURS_CLOSE;
}

/** A bar replay that cannot start: why, as a start error with no session, else in a toast (the session runs on). */
function startRefused(message: string): false {
  if (useTrading.getState().session) toast('error', `The replay did not start: ${message}`, 10_000);
  else useTrading.setState({ error: message });
  return false;
}

const NOTHING_FOLLOWS = {
  bar: 'Nothing follows this bar in the data yet, so there is nothing to replay. Pick an earlier bar.',
  time: 'Nothing follows that moment in the data, so there is nothing to replay. Pick an earlier date or time.',
};

/**
 * How a bar replay of `symbol` from `provider` on a `timeframe` chart plays: the size of the candles the chart
 * draws (the timeframe, or the data's own bars when those are coarser: a daily file on a 1-minute chart),
 * by which it plays on and picks its speed; the trading days it loads before its start, at least as many as
 * the chart with no session shows (BROWSE_DAYS), so the cut shows no less on the left; on a vendor's data,
 * the most days it plays on (vendorPlayOnDays); and whether its chart also loads the longer history before
 * those days (HISTORY_DAYS of it: on charts of 30-minute candles and more, see ReplaySession.chartHistory).
 */
function barReplayPlan(provider: HistoricalDataProvider, symbol: string, timeframe: Timeframe): { candles: Timeframe; lookbackDays: number; maxDays: number; history: boolean } {
  const base = provider.baseTimeframe(symbol);
  const candles = candleTimeframe(timeframe, base);
  const lookbackDays = Math.max(DEFAULT_LOOKBACK[candles], BROWSE_DAYS);
  const history = TIMEFRAMES.indexOf(candles) >= TIMEFRAMES.indexOf(historyTimeframe(base)) && DEFAULT_LOOKBACK[candles] > loadedDays(base, lookbackDays);
  return { candles, lookbackDays, maxDays: VENDOR_NAMES[provider.id] ? vendorPlayOnDays(loadedDays(base, lookbackDays)) : Infinity, history };
}

/**
 * Whether a vendor's refusal of a replay may be about its day alone, so another day may load: anything but
 * a rejected key, the rate limit or no connection (no bars that day, say, or none your plan covers).
 */
function dayMayBeTheCause(e: unknown): boolean {
  return e instanceof DataProviderError && !(['auth', 'rate_limit', 'network'] as string[]).includes(e.kind);
}

/**
 * Starts a replay of `symbol` from `providerId` at `t` with the chart's timeframe (startReplay), the way
 * Bar Replay starts every replay: it plays on for PLAY_ON_DAYS of the candles the chart draws (barReplayPlan),
 * never past the end of the data or across a day an imported file has no bars for (playOnEndDate), and on
 * its last day to the end of the data's sessions (sessionClose), so it never plays empty hours. As many days
 * before the start as a replay of those candles loads (DEFAULT_LOOKBACK), and no fewer than the chart with no
 * session shows; the default balance; that symbol only; not blind; no challenge; about one candle a second
 * (candleSpeed). Once started, saved as the next replay's setup (settings.replay), as the setup form saves
 * it, so Advanced replay setup opens on it; one that did not start leaves the setup as it was. `known`: the
 * chart's bars, for the data's hours. `what` was picked: a bar of the chart (which keeps its view, see
 * ChartEvent) or a moment. `retry`: says whether the caller takes a failure to load (it tries another day,
 * or says why itself): one it takes is not shown but answered 'retry', the loading note left up.
 */
async function startReplayFrom(t: UnixSeconds, providerId: string, symbol: string, known: KnownBars, what: 'bar' | 'time', retry?: (e: unknown) => boolean): Promise<boolean | 'retry'> {
  const provider = getProvider(providerId);
  const timeframe = useTrading.getState().timeframe;
  const plan = barReplayPlan(provider, symbol, timeframe);
  const day = exchangeDate(t);
  let endDate: string;
  let close: number;
  try {
    if (provider === csvProvider && provider.unavailableReason()) await csvDatasetsLoaded();
    const reason = provider.unavailableReason() ?? (await notListed(provider, symbol));
    if (reason) return startRefused(reason);
    const last = await lastDataDay(provider, symbol);
    const dates = await provider.sessionDates?.(symbol);
    noteDataDays(provider, symbol, last, dates ?? null);
    endDate = playOnEndDate(day, plan.candles, last, dates, plan.maxDays);
    close = await sessionClose(provider, symbol, day, known);
  } catch (e) {
    if (retry?.(e)) return 'retry';
    return startRefused((e as Error).message);
  }
  const endTime = hhmm(close);
  if (exchangeTimeToUnix(endDate, parseHHMM(endTime)) <= t) return startRefused(NOTHING_FOLLOWS[what]);
  const startTime = hhmm((t - exchangeTimeToUnix(day, 0)) / 60);
  const speed = candleSpeed(plan.candles, REPLAY_SPEEDS);
  let retrying = false;
  const retryOn = retry ? (e: unknown) => (retrying = retry(e)) : undefined;
  const ok = await startReplay({ providerId: provider.id, symbol, date: day, startTime, endTime, endDate, startingBalance: getSettings().defaultBalance, lookbackDays: plan.lookbackDays, timeframe, speed, blind: false, cut: what === 'bar', retryOn });
  if (retrying) return 'retry';
  // The chart's timeframe is the setup's (the full form opens on it), whatever the candles it draws.
  if (ok) useSettings.getState().updateReplay({ providerId: provider.id, symbol, date: day, startTime, endTime, multiDay: endDate > day, endDate, timeframe, speed });
  const failed = useTrading.getState().error;
  if (!ok && failed) {
    // The replay's own words for an empty window are about start and end times, which were not asked for here.
    const message = failed === 'No data between the selected start and end times.' ? NOTHING_FOLLOWS[what] : failed;
    if (useTrading.getState().session) useTrading.setState({ error: null });
    startRefused(message);
  }
  return ok;
}

/**
 * Bar Replay: starts a replay of the chart's symbol cut at its candle that starts at `candleStart` (one of
 * the chart's timeframe). It starts as that candle ends (cutTime): it is the newest candle shown, complete,
 * and the next bar shown is the first one after it. Any session running ends first (endCurrent), as
 * another start ends it. False when it did not start: why is in the store's error, or a toast while a
 * session runs on.
 */
export async function startBarReplay(candleStart: UnixSeconds): Promise<boolean> {
  const blocked = selectBarBlocked();
  useTrading.setState({ selectingBar: false });
  if (blocked) return startRefused(blocked);
  const { providerId, symbol } = barReplaySource();
  const known = knownBars(chartData(providerId, symbol), symbol, useTrading.getState().timeframe);
  const t = known.cutTime(candleStart);
  if (t === null) return startRefused('That bar is not on the chart.');
  return (await startReplayFrom(t, providerId, symbol, known, 'bar')) === true;
}

/** What select-bar mode says about a candle before it is clicked (cutWarning): its words, and whether a click there is refused. */
export interface CutNote {
  text: string;
  refused: boolean;
}

/**
 * What select-bar mode says about the chart's candle that starts at `candleStart` before it is clicked, or
 * null when there is nothing to say: that nothing follows it before the replay cut there would end (data
 * that stops for a day it has no bars on, after that day's last bar), which refuses it as startBarReplay
 * would; or that only after-hours trading follows it before it ends (onlyAfterHoursFollow), in which an
 * order that waits for the regular session (any but a Limit with Extended hours) never fills. Worked out as
 * the cut would be, from the chart's bars (for the data's hours, as sessionClose does: the after-hours close
 * when they do not tell), the calendar and the data's last day once known (noteDataDays), at once: no bar
 * is asked of the data source, nor copied.
 */
export function cutWarning(candleStart: UnixSeconds): CutNote | null {
  const { providerId, symbol } = barReplaySource();
  const provider = getProvider(providerId);
  const days = dataDays.get(`${provider.id}|${symbol}`);
  if (!days) return null;
  const timeframe = useTrading.getState().timeframe;
  const known = knownBars(chartData(providerId, symbol), symbol, timeframe);
  const t = known.cutTime(candleStart);
  if (t === null) return null;
  const plan = barReplayPlan(provider, symbol, timeframe);
  const day = exchangeDate(t);
  const endDate = playOnEndDate(day, plan.candles, days.last, days.dates, plan.maxDays);
  if (exchangeTimeToUnix(endDate, parseHHMM(hhmm(known.sessionEnd(day) ?? AFTERHOURS_CLOSE))) <= t) return { text: NOTHING_FOLLOWS.bar, refused: true };
  return onlyAfterHoursFollow(t, endDate) ? { text: CUT_AFTER_HOURS, refused: false } : null;
}

/**
 * Why select-bar mode will not start at the newest candle the chart shows: nothing follows it in the data.
 * (A chart with no session is not drawn at all where a saved session would have it stop: browseHiddenReason.)
 */
export function newestBarRefusal(): string {
  return 'This is the newest bar: nothing follows it yet. Pick an earlier one.';
}

/** cutWarning's words for a cut with only after-hours trading after it. */
export const CUT_AFTER_HOURS = "Only after-hours trading follows this bar: market orders won't fill. Pick an earlier bar.";

/**
 * Select date: starts a replay of the chart's symbol at `time` (HH:MM, exchange time) on `date`, as a bar
 * replay starts. Not with no session while a saved session on the symbol keeps its chart from being drawn
 * (browseHiddenReason): the replay would show what that chart hides.
 */
export async function startReplayAt(date: string, time: string): Promise<boolean> {
  useTrading.setState({ selectingBar: false });
  const hidden = browseHiddenReason();
  if (hidden) return startRefused(hidden);
  const { providerId, symbol } = barReplaySource();
  const known = knownBars(chartData(providerId, symbol), symbol, useTrading.getState().timeframe);
  return (await startReplayFrom(exchangeTimeToUnix(date, parseHHMM(time)), providerId, symbol, known, 'time')) === true;
}

/**
 * Random bar: starts a replay of the chart's symbol at the 09:30 open of a trading day picked at random
 * from its data (one with bars, for imported data), as a bar replay starts. Picked without looking at
 * the bars, so nothing about the day is known before it plays. Not while a saved session on the symbol
 * could be given away by the day picked (randomBarBlocked). A vendor does not say how far back
 * its data goes: the day is one of the last VENDOR_RANDOM_DAYS (about two years, as far as Polygon's free
 * plan goes; HISTORY_DAYS fewer on a chart that loads that much history before it), and when the vendor has
 * no bars that day or will not serve it (a ticker listed since, a plan that does not reach back so far), one
 * other day is tried before giving up: after the day it had no bars for, as it has none before a listing.
 */
export async function startRandomBar(rand: () => number = Math.random): Promise<boolean> {
  useTrading.setState({ selectingBar: false });
  const blocked = randomBarBlocked();
  if (blocked) return startRefused(blocked);
  const { providerId, symbol } = barReplaySource();
  const provider = getProvider(providerId);
  const vendor = VENDOR_NAMES[provider.id];
  const timeframe = useTrading.getState().timeframe;
  const plan = barReplayPlan(provider, symbol, timeframe);
  let pool: { from: string; to: string; days: string[] | null | undefined; known: boolean };
  try {
    if (provider === csvProvider && provider.unavailableReason()) await csvDatasetsLoaded();
    const reason = provider.unavailableReason() ?? (await notListed(provider, symbol));
    if (reason) return startRefused(reason);
    const range = await provider.availableRange(symbol);
    const to = await lastDataDay(provider, symbol);
    pool = { from: range ? exchangeDate(range.from) : vendor ? vendorRandomFrom(to, plan.history ? HISTORY_DAYS : 0) : DEMO_FIRST_DATE, to, days: await provider.sessionDates?.(symbol), known: !!range };
  } catch (e) {
    return startRefused((e as Error).message);
  }
  // The chart shows the ticker from this vendor: one day it has no bars for is not a wrong ticker.
  const charted = !!chartData(provider.id, symbol);
  const tried = new Set<string>();
  const tries = pool.known ? 1 : 2;
  let from = pool.from;
  /** loadSeq once a try was left to try another day (its loading note still up), and why it did not load. */
  let leftLoading: number | null = null;
  // Set from the callback below, which the compiler does not follow.
  let failure = null as { day: string; e: unknown } | null;
  for (let n = 0; n < tries; n++) {
    const day = randomDay(from, pool.to, pool.days, rand, tried);
    if (!day) {
      if (leftLoading === loadSeq) useTrading.setState({ loading: false });
      if (failure) return startRefused(randomFailure(provider, symbol, failure.day, failure.e));
      return startRefused(`There is no ${symbol} data to replay.`);
    }
    tried.add(day);
    const last = n + 1 === tries;
    const known = knownBars(chartData(providerId, symbol), symbol, timeframe);
    // Taken here, and not shown: a refusal another day may not get, before the last try; on the last, that
    // the vendor has no bars that day for a ticker the chart shows, said here in its own words.
    const take = vendor
      ? (e: unknown) => {
          if (!dayMayBeTheCause(e) || (last && !(charted && noBars(e)))) return false;
          failure = { day, e };
          return true;
        }
      : undefined;
    const r = await startReplayFrom(exchangeTimeToUnix(day, REGULAR_OPEN), providerId, symbol, known, 'time', take);
    if (r !== 'retry') {
      // A try that stopped before loading (a refusal is shown) leaves the loading note of the one before it.
      if (!r && leftLoading === loadSeq) useTrading.setState({ loading: false });
      return r;
    }
    leftLoading = loadSeq;
    // A vendor has no bars for a ticker before it was listed, on any day: the next day tried is after this one.
    if (noBars(failure?.e)) from = nextTradingDay(day);
  }
  // The last try's failure, taken: no bars that day.
  if (leftLoading !== loadSeq || !failure) return false;
  useTrading.setState({ loading: false });
  return startRefused(randomFailure(provider, symbol, failure.day, failure.e));
}

/** Whether `e` is a data source's answer that it has no bars for what was asked (DataProviderError's 'not_found'). */
function noBars(e: unknown): boolean {
  return e instanceof DataProviderError && e.kind === 'not_found';
}

/**
 * Why Random bar's replay of `symbol` from `provider` on `day` did not load: for a vendor that has no bars that
 * day for a ticker the chart shows, most likely a day before it was listed, said so (not loadFailure's "check
 * the ticker", which is for a ticker typed in); else as loadFailure says it.
 */
function randomFailure(provider: HistoricalDataProvider, symbol: string, day: string, e: unknown): string {
  const vendor = VENDOR_NAMES[provider.id];
  if (vendor && noBars(e) && chartData(provider.id, symbol)) return `${vendor} has no ${symbol} bars around ${day}; it may not have traded then. Press Random bar again, or use Select date… for a later day.`;
  return loadFailure(provider, symbol, e, day);
}

/** Clears the start error shown over the chart. */
export function dismissError(): void {
  useTrading.setState({ error: null });
}

/** The simulated market's broker, its clock brought up to the market's time for an order action. */
function simBrokerNow(): SimBroker | null {
  if (!eng.stream || !eng.simBroker) return null;
  eng.simBroker.syncClock(eng.stream.clock);
  return eng.simBroker;
}

/** What the broker says of an order queued outside regular hours that only regular hours fill (SimBroker.submit). */
const QUEUED_FOR_REGULAR = 'Market is not in regular hours. The order will work from the next regular session.';

/** What is said instead when the replay ends before that session (replayEndsFirst). */
export const QUEUED_PAST_END = 'Market is not in regular hours, and this replay ends before the next regular session, so the order will not fill in this replay. To trade after hours, use a Limit order with Extended hours (under More options).';

/**
 * `r`, saying so when its order waits for the next regular session and the replay ends before that session
 * opens (a bar replay cut after the close of the data's last day): the broker queues it all the same, as a
 * broker would, but it can never fill here.
 */
function replayEndsFirst(r: SubmitResult): SubmitResult {
  const replay = eng.replay;
  const i = r.warnings.indexOf(QUEUED_FOR_REGULAR);
  if (!replay || !r.ok || r.order?.status !== 'pending' || i < 0) return r;
  const now = replay.now;
  const day = exchangeDate(now);
  const opens = isTradingDay(day) && exchangeMinuteOfDay(now) < REGULAR_OPEN ? exchangeTimeToUnix(day, REGULAR_OPEN) : exchangeTimeToUnix(nextTradingDay(day), REGULAR_OPEN);
  // Its first minute must end by the replay's end for anything to fill in it.
  if (opens + 60 <= replay.end) return r;
  const warnings = r.warnings.slice();
  warnings[i] = QUEUED_PAST_END;
  return { ...r, warnings };
}

export function submitOrder(req: OrderRequest): SubmitResult {
  const b = broker();
  if (!b) return { ok: false, error: 'Start a replay or the simulated market first.', warnings: [] };
  const r = eng.replay ? eng.replay.submit(req) : simBrokerNow()!.submit(req);
  publish(true);
  saveSession();
  void processClosedTrips();
  return replayEndsFirst(r);
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
  return replayEndsFirst(r);
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

/** The order-ticket field waiting for a price click on the chart; asking for one stops picking a bar to replay from. */
export function setPickTarget(t: TradingSnapshot['pickTarget']): void {
  useTrading.setState(t ? { pickTarget: t, selectingBar: false } : { pickTarget: null });
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
