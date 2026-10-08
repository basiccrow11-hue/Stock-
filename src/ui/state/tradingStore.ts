/**
 * The active trading session (historical replay or simulated market) and its play loop.
 *
 * Engine objects (ReplaySession, SimMarket, SimBroker) live outside React. After every change we
 * publish a plain snapshot to the zustand store for the UI, and push bar updates to the chart over
 * a small event bus so the chart can update incrementally instead of re-rendering.
 */
import { create } from 'zustand';
import type { AccountSnapshot, Bar, DataSourceKind, EquityPoint, Fill, Order, OrderRequest, Position, RoundTrip, Timeframe, UnixSeconds } from '../../core/types';
import { ReplaySession, type ReplaySetup } from '../../core/replay/ReplaySession';
import { SimBroker, type BrokerEvent, type SubmitResult } from '../../core/broker/SimBroker';
import { SimulationDataProvider } from '../../core/data/simulationProvider';
import type { SimConfig, SimEvent } from '../../core/sim/SimMarket';
import { journalEntryFromTrip, type JournalEntry } from '../../core/journal';
import { reviewTrade } from '../../core/learning/review';
import { CHALLENGES, evaluateChallenge } from '../../core/challenges/challenges';
import { exchangeDate, isTradingDay, nextTradingDay, prevTradingDay } from '../../core/time';
import { getProvider } from './dataRegistry';
import { getSettings } from './settingsStore';
import { useJournal, saveSnapshot } from './journalStore';
import { useChallenges } from './challengeStore';
import { toast } from './toasts';
import { recordTradeClosed } from './streakStore';
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
  /** Order-ticket field waiting for a price click on the chart. */
  pickTarget: 'limit' | 'stop' | 'stopLoss' | 'takeProfit' | null;
  pickedPrice: { field: string; price: number; seq: number } | null;
}

// ------------------------------------------------------------------ chart bus

export type ChartEvent = { type: 'reset' } | { type: 'append'; symbol: string; bars: Bar[] } | { type: 'tick'; symbol: string; bar: Bar };
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
  timer: null,
  lastTick: 0,
  lastPublish: 0,
  simCarry: 0,
  prevClose: {},
};

export const REPLAY_SPEEDS = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];
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
  pickTarget: null,
  pickedPrice: null,
};

export const useTrading = create<TradingSnapshot>()(() => ({ ...EMPTY }));

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

export function getSimEventsFor(symbol: string): SimEvent[] {
  return eng.sim ? eng.sim.market.events.filter((e) => e.symbol === symbol || e.symbol === 'MARKET') : [];
}

/** "Day N" label used in blind mode (relative trading-day index from the session start date). */
export function blindDayLabel(t: UnixSeconds): string {
  const s = useTrading.getState().session;
  if (!s) return exchangeDate(t);
  const d = exchangeDate(t);
  if (d === s.startDate) return 'Day 1';
  let n = 0;
  if (d > s.startDate) {
    let x = s.startDate;
    while (x < d && n < 400) {
      x = nextTradingDay(x);
      n++;
    }
    return `Day ${n + 1}`;
  }
  let x = s.startDate;
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
      // Previous session's last regular-hours close, if visible.
      for (let i = all.length - 1; i >= 0; i--) {
        if (exchangeDate(all[i].time) < today) {
          prev = all[i].close;
          break;
        }
      }
      if (prev !== undefined) eng.prevClose[`${sym}|${today}`] = prev;
    }
    out[sym] = { last: last.close, prevClose: prev ?? null, changePct: prev ? (last.close / prev - 1) * 100 : null, time: last.time };
  }
  return out;
}

let trailingPublish: ReturnType<typeof setTimeout> | null = null;

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
    equityCurve: st.equityCurve,
    quotes: computeQuotes(),
    simEvents: eng.sim ? eng.sim.market.events.slice(-100) : [],
    version: st.version,
  });
  if (finished && useTrading.getState().playing) {
    pause();
    toast('info', 'Replay reached the end time.');
  }
  evaluateActiveChallenge();
}

// ------------------------------------------------------------------ journal + learning hooks

async function processClosedTrips(): Promise<void> {
  const b = broker();
  const session = useTrading.getState().session;
  if (!b || !session) return;
  const st = b.state;
  for (const trip of st.roundTrips) {
    if (!trip.closed || eng.processedTrips.has(trip.id)) continue;
    eng.processedTrips.add(trip.id);
    const settings = getSettings();
    const entry: JournalEntry = journalEntryFromTrip(trip, { sessionId: session.id, mode: session.mode, rewound: (eng.replay?.rewinds ?? 0) > 0, blind: session.blind });
    try {
      entry.review = reviewTrade({
        trip,
        fills: st.fills,
        orders: st.orders,
        revealedBars: getBaseBars(trip.symbol),
        timeframe: useTrading.getState().timeframe,
        equityCurve: st.equityCurve,
        startingBalance: st.startingBalance,
        allTrips: st.roundTrips,
        rules: settings.rules,
      });
    } catch (e) {
      console.error('Review failed', e);
    }
    if (settings.autoSnapshot && snapshotFn && useTrading.getState().activeSymbol === trip.symbol) {
      try {
        // Publishing is throttled while playing; the picture shows the moment the trade closed.
        publish(true);
        const img = await snapshotFn();
        if (img) {
          entry.snapshotKey = `snap:${entry.id}`;
          await saveSnapshot(entry.snapshotKey, img);
        }
      } catch {
        /* snapshot is best effort */
      }
    }
    await useJournal.getState().add(entry);
    recordTradeClosed();
    const tone = trip.pnl >= 0 ? 'success' : 'error';
    toast(tone, `${trip.direction === 'long' ? 'Long' : 'Short'} ${trip.symbol} closed: ${trip.pnl >= 0 ? '+' : '−'}$${Math.abs(trip.pnl).toFixed(2)}. Journal entry created.`);
    if (settings.learningMode) {
      pause();
      useTrading.setState({ reviewId: entry.id });
    }
  }
}

function evaluateActiveChallenge(): void {
  const active = useChallenges.getState().active;
  const b = broker();
  if (!active || !b) return;
  const def = CHALLENGES.find((c) => c.id === active.challengeId);
  if (!def) return;
  const st = b.state;
  const result = evaluateChallenge(def, {
    trips: st.roundTrips,
    equityCurve: st.equityCurve,
    startingBalance: st.startingBalance,
    equity: b.account().equity,
    sessionFinished: eng.replay?.finished ?? false,
    rewound: (eng.replay?.rewinds ?? 0) > 0,
    rules: getSettings().rules,
  });
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
    const latest = new Map<string, Bar>();
    for (const u of updates) {
      eng.simBroker.onBar(u.symbol, u.tick, tickSecs);
      latest.set(u.symbol, u.bar);
    }
    for (const [symbol, bar] of latest) emitChart({ type: 'tick', symbol, bar });
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
  eng.replay = null;
  eng.sim = null;
  eng.simBroker = null;
  eng.processedTrips = new Set();
  eng.simCarry = 0;
  eng.prevClose = {};
}

export async function startReplay(setup: ReplaySetup & { providerId: string; timeframe: Timeframe; speed: number; blind: boolean; challengeId?: string }): Promise<boolean> {
  if (useChallenges.getState().active) await useChallenges.getState().finishActive();
  resetEngines();
  useTrading.setState({ ...EMPTY, loading: true, activeSymbol: setup.symbol.toUpperCase(), timeframe: setup.timeframe, speed: setup.speed });
  const provider = getProvider(setup.providerId);
  const reason = provider.unavailableReason();
  if (reason) {
    useTrading.setState({ loading: false, error: reason });
    return false;
  }
  const id = newId('replay');
  try {
    const { session, warnings } = await ReplaySession.load(provider, setup, getSettings().execution, id);
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
    useTrading.setState({ session: meta, loading: false, warnings, activeSymbol: session.symbol });
    if (setup.challengeId) {
      const def = CHALLENGES.find((c) => c.id === setup.challengeId);
      useChallenges.getState().start({
        id: newId('attempt'),
        challengeId: setup.challengeId,
        sessionId: id,
        startedAt: Date.now(),
        label: meta.label,
        result: { status: 'in_progress', progress: 0, detail: def?.description ?? '', official: true },
      });
    }
    emitChart({ type: 'reset' });
    publish(true);
    for (const w of warnings) toast('warning', w, 6000);
    return true;
  } catch (e) {
    if ((e as Error).name === 'AbortError') return false;
    useTrading.setState({ loading: false, error: (e as Error).message });
    return false;
  }
}

export function startSim(opts: { config: Partial<SimConfig>; startingBalance: number; speed: number; challengeId?: string }): void {
  if (useChallenges.getState().active) void useChallenges.getState().finishActive();
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
    useChallenges.getState().start({ id: newId('attempt'), challengeId: opts.challengeId, sessionId: id, startedAt: Date.now(), label: 'Simulated market', result: { status: 'in_progress', progress: 0, detail: def?.description ?? '', official: true } });
  }
  emitChart({ type: 'reset' });
  publish(true);
}

export async function endSession(): Promise<void> {
  if (useChallenges.getState().active) await useChallenges.getState().finishActive();
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

/** Number of journaled trades that a rewind to `time` would undo. */
export function tradesUndoneBy(time: UnixSeconds): number {
  const b = broker();
  if (!b) return 0;
  return b.state.roundTrips.filter((t) => t.closed && (t.exitTime ?? 0) > time).length + b.state.roundTrips.filter((t) => !t.closed && t.entryTime > time).length;
}

async function afterRewind(): Promise<void> {
  const session = useTrading.getState().session;
  const b = broker();
  if (!session || !b) return;
  const alive = new Set(b.state.roundTrips.filter((t) => t.closed).map((t) => t.id));
  // Journal entries for trades that no longer exist in this timeline are removed.
  await useJournal.getState().removeWhere((e) => e.sessionId === session.id && !alive.has(e.trip.id));
  eng.processedTrips = new Set([...eng.processedTrips].filter((id) => alive.has(id)));
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

export function submitOrder(req: OrderRequest): SubmitResult {
  const b = broker();
  if (!b) return { ok: false, error: 'Start a replay or the simulated market first.', warnings: [] };
  const r = eng.replay ? eng.replay.submit(req) : b.submit(req);
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
  const r = eng.replay ? eng.replay.modify(id, changes) : broker()?.modify(id, changes) ?? { ok: false, error: 'No session' };
  publish(true);
  void processClosedTrips();
  return r;
}

export function closePosition(symbol: string): SubmitResult {
  const b = broker();
  if (!b) return { ok: false, error: 'No session', warnings: [] };
  const r = eng.replay ? eng.replay.closePosition(symbol) : b.closePosition(symbol);
  publish(true);
  void processClosedTrips();
  return r;
}

/** Apply changed execution settings to the running session. */
export function applyExecutionConfig(): void {
  const b = broker();
  if (b) b.cfg = getSettings().execution;
}

export function setPickTarget(t: TradingSnapshot['pickTarget']): void {
  useTrading.setState({ pickTarget: t });
}

let pickSeq = 0;
export function pickPrice(price: number): void {
  const t = useTrading.getState().pickTarget;
  if (!t) return;
  useTrading.setState({ pickTarget: null, pickedPrice: { field: t, price, seq: ++pickSeq } });
}

export function closeReview(): void {
  useTrading.setState({ reviewId: null });
}

export function lastPrice(symbol: string): number | null {
  return broker()?.markPrice(symbol) ?? null;
}

/** The replay's equity at the start of the session (for display). */
export function startingBalance(): number {
  return broker()?.state.startingBalance ?? 0;
}
