/**
 * Bundled DEMO data provider.
 *
 * IMPORTANT: these are SYNTHETIC prices. They are generated deterministically from a seed so that a
 * given ticker + date always replays identically, and they are shaped to behave like real tape
 * (overnight gaps, U-shaped intraday volume and volatility, trend / range / reversal days, earnings
 * gaps, market-wide regimes, beta to an index factor). They are NOT the real prices of the named
 * companies on those dates, and the app labels them DEMO everywhere. Use CSV import or a vendor API
 * for real history.
 */
import type { Bar, Timeframe, UnixSeconds } from '../types';
import type { BarRequest, HistoricalDataProvider, SymbolInfo } from './provider';
import { aggregateBars } from './aggregate';
import { Rng, hashString } from '../util/random';
import { roundToTick } from '../util/math';
import {
  AFTERHOURS_CLOSE,
  PREMARKET_OPEN,
  REGULAR_OPEN,
  addDays,
  exchangeDate,
  exchangeTimeToUnix,
  isTradingDay,
  nextTradingDay,
  regularCloseMinute,
} from '../time';

export interface DemoTickerProfile extends SymbolInfo {
  startPrice: number;
  /** Annualized drift and volatility. */
  drift: number;
  vol: number;
  /** Sensitivity to the shared market factor. 0 for the market proxy itself. */
  beta: number;
  avgVolume: number;
  /** Stocks have quarterly earnings gaps; ETFs do not. */
  earnings: boolean;
}

export const DEMO_TICKERS: DemoTickerProfile[] = [
  { symbol: 'SPY', name: 'S&P 500 ETF (demo)', kind: 'etf', startPrice: 250, drift: 0.1, vol: 0.17, beta: 1, avgVolume: 75e6, earnings: false },
  { symbol: 'QQQ', name: 'Nasdaq-100 ETF (demo)', kind: 'etf', startPrice: 155, drift: 0.14, vol: 0.22, beta: 1.2, avgVolume: 45e6, earnings: false },
  { symbol: 'IWM', name: 'Russell 2000 ETF (demo)', kind: 'etf', startPrice: 135, drift: 0.06, vol: 0.23, beta: 1.15, avgVolume: 30e6, earnings: false },
  { symbol: 'AAPL', name: 'Apple (demo)', kind: 'stock', startPrice: 150, drift: 0.15, vol: 0.28, beta: 1.2, avgVolume: 60e6, earnings: true },
  { symbol: 'MSFT', name: 'Microsoft (demo)', kind: 'stock', startPrice: 100, drift: 0.15, vol: 0.25, beta: 1.05, avgVolume: 25e6, earnings: true },
  { symbol: 'NVDA', name: 'NVIDIA (demo)', kind: 'stock', startPrice: 35, drift: 0.3, vol: 0.5, beta: 1.7, avgVolume: 250e6, earnings: true },
  { symbol: 'TSLA', name: 'Tesla (demo)', kind: 'stock', startPrice: 60, drift: 0.2, vol: 0.6, beta: 1.9, avgVolume: 100e6, earnings: true },
  { symbol: 'AMZN', name: 'Amazon (demo)', kind: 'stock', startPrice: 80, drift: 0.12, vol: 0.32, beta: 1.25, avgVolume: 45e6, earnings: true },
  { symbol: 'META', name: 'Meta Platforms (demo)', kind: 'stock', startPrice: 135, drift: 0.15, vol: 0.38, beta: 1.35, avgVolume: 18e6, earnings: true },
  { symbol: 'GOOGL', name: 'Alphabet (demo)', kind: 'stock', startPrice: 52, drift: 0.13, vol: 0.29, beta: 1.1, avgVolume: 30e6, earnings: true },
  { symbol: 'AMD', name: 'AMD (demo)', kind: 'stock', startPrice: 18, drift: 0.22, vol: 0.52, beta: 1.8, avgVolume: 55e6, earnings: true },
];

export const DEMO_FIRST_DATE = '2019-01-02';
const TRADING_DAYS_PER_YEAR = 252;
const SUBTICKS = 4;
/** Longest stretch of generating a request runs without letting the page draw (getBars). */
const SLICE_MS = 40;
/** Most days of coarse bars kept for getCoarseBars (a few dozen bars each). */
const MAX_COARSE_DAYS = 5000;

/**
 * Lets the page handle input and draw. A timer, not scheduler.yield: Chromium resumes a yielded task
 * ahead of drawing, so the page would not draw until the whole request was done.
 */
const yieldToPage = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Regime = 'bull' | 'bear' | 'chop';

interface DayPlan {
  date: string;
  prevClose: number;
  /** Where the previous day's after-hours session ended (premarket starts here). */
  prevPostEnd: number;
  open: number;
  close: number;
  postEnd: number;
  /** Daily intraday volatility (log units) used to scale the minute path. */
  sigma: number;
  volume: number;
  shape: 'trend' | 'range' | 'reversal';
  seed: number;
}

interface MarketDay {
  ret: number;
  gapShare: number;
  regime: Regime;
  volMult: number;
}

/** Market factor shared by all demo tickers so they are correlated like real stocks. */
class MarketFactor {
  private days = new Map<string, MarketDay>();
  private built = false;
  private ordered: string[] = [];

  constructor(private lastDate: string) {}

  private build(): void {
    if (this.built) return;
    this.built = true;
    const rng = new Rng(hashString('DEMO-MARKET-FACTOR-v1'));
    let regime: Regime = 'bull';
    let garch = 1;
    const transition: Record<Regime, [Regime, number][]> = {
      bull: [['bull', 0.985], ['chop', 0.01], ['bear', 0.005]],
      chop: [['chop', 0.97], ['bull', 0.02], ['bear', 0.01]],
      bear: [['bear', 0.97], ['chop', 0.02], ['bull', 0.01]],
    };
    const params: Record<Regime, { mu: number; sigma: number }> = {
      bull: { mu: 0.0007, sigma: 0.0085 },
      chop: { mu: 0.0, sigma: 0.0105 },
      bear: { mu: -0.0011, sigma: 0.0175 },
    };
    let d = DEMO_FIRST_DATE;
    while (d <= this.lastDate) {
      const u = rng.next();
      let acc = 0;
      for (const [next, p] of transition[regime]) {
        acc += p;
        if (u < acc) {
          regime = next;
          break;
        }
      }
      const { mu, sigma } = params[regime];
      const shock = rng.fatTail(5);
      const ret = mu + sigma * garch * shock;
      // Volatility clustering: big moves raise tomorrow's volatility.
      garch = Math.min(3, Math.max(0.6, 0.94 * garch + 0.06 * (1 + 0.9 * (Math.abs(shock) - 0.8))));
      this.days.set(d, { ret, gapShare: rng.range(0.15, 0.45), regime, volMult: garch * (regime === 'bear' ? 1.6 : regime === 'chop' ? 1.15 : 1) });
      this.ordered.push(d);
      d = nextTradingDay(d);
    }
  }

  get(date: string): MarketDay | undefined {
    this.build();
    return this.days.get(date);
  }

  dates(): string[] {
    this.build();
    return this.ordered;
  }
}

function lastCompletedTradingDay(now: Date): string {
  // A day is complete once its after-hours session has ended.
  const nowSec = Math.floor(now.getTime() / 1000);
  let d = exchangeDate(nowSec);
  if (!isTradingDay(d) || nowSec < exchangeTimeToUnix(d, AFTERHOURS_CLOSE)) {
    d = addDays(d, -1);
  }
  while (!isTradingDay(d)) d = addDays(d, -1);
  return d;
}

export class DemoDataProvider implements HistoricalDataProvider {
  readonly id = 'demo';
  readonly name = 'Demo data (synthetic, offline)';
  readonly source = 'DEMO' as const;
  readonly requiresCredentials = false;

  readonly lastDate: string;
  private market: MarketFactor;
  private plans = new Map<string, Map<string, DayPlan>>();
  private dayCache = new Map<string, Bar[]>();
  private dayCacheOrder: string[] = [];
  private coarseCache = new Map<string, Bar[]>();

  constructor(now: Date = new Date(), private maxCachedDays = 400) {
    this.lastDate = lastCompletedTradingDay(now);
    this.market = new MarketFactor(this.lastDate);
  }

  unavailableReason(): string | null {
    return null;
  }

  async listSymbols(): Promise<SymbolInfo[]> {
    return DEMO_TICKERS.map(({ symbol, name, kind }) => ({ symbol, name, kind, description: 'Synthetic demo data' }));
  }

  baseTimeframe(): Timeframe {
    return '1m';
  }

  async availableRange(symbol: string): Promise<{ from: UnixSeconds; to: UnixSeconds } | null> {
    if (!this.profile(symbol)) return null;
    return { from: exchangeTimeToUnix(DEMO_FIRST_DATE, PREMARKET_OPEN), to: exchangeTimeToUnix(this.lastDate, AFTERHOURS_CLOSE) };
  }

  /**
   * Generating a day takes a few milliseconds, so a long request (a multi-month replay) is generated
   * in slices that let the page draw in between.
   */
  async getBars(req: BarRequest, signal?: AbortSignal): Promise<Bar[]> {
    const profile = this.requireProfile(req.symbol);
    const out: Bar[] = [];
    let slice = performance.now();
    for (const date of this.dates(req)) {
      for (const b of this.dayBars(profile, date)) if (b.time >= req.from && b.time < req.to) out.push(b);
      if (performance.now() - slice > SLICE_MS) {
        await yieldToPage();
        signal?.throwIfAborted();
        slice = performance.now();
      }
    }
    return out;
  }

  /** The days' minute bars aggregated as a chart does, generated in slices like getBars and kept for later requests. */
  async getCoarseBars(req: BarRequest, timeframe: Timeframe, signal?: AbortSignal): Promise<Bar[]> {
    const profile = this.requireProfile(req.symbol);
    const out: Bar[] = [];
    let slice = performance.now();
    for (const date of this.dates(req)) {
      const key = `${profile.symbol}|${date}|${timeframe}`;
      let bars = this.coarseCache.get(key);
      if (!bars) {
        bars = aggregateBars(this.dayBars(profile, date), timeframe, '1m');
        if (this.coarseCache.size >= MAX_COARSE_DAYS) this.coarseCache.delete(this.coarseCache.keys().next().value!);
        this.coarseCache.set(key, bars);
      }
      for (const b of bars) if (b.time >= req.from && b.time < req.to) out.push({ ...b });
      if (performance.now() - slice > SLICE_MS) {
        await yieldToPage();
        signal?.throwIfAborted();
        slice = performance.now();
      }
    }
    return out;
  }

  /** Synchronous variant (generation is pure CPU work); used by tests and the backtester. */
  getBarsSync(req: BarRequest): Bar[] {
    const profile = this.requireProfile(req.symbol);
    const out: Bar[] = [];
    for (const date of this.dates(req)) {
      for (const b of this.dayBars(profile, date)) {
        if (b.time >= req.from && b.time < req.to) out.push(b);
      }
    }
    return out;
  }

  /** The trading days with demo data that `req` touches. */
  private *dates(req: BarRequest): Generator<string> {
    let date = exchangeDate(req.from);
    const lastDate = exchangeDate(req.to - 1);
    if (!isTradingDay(date)) date = nextTradingDay(date);
    while (date <= lastDate && date <= this.lastDate) {
      yield date;
      date = nextTradingDay(date);
    }
  }

  private requireProfile(symbol: string): DemoTickerProfile {
    const profile = this.profile(symbol);
    if (!profile) throw new Error(`Unknown demo symbol ${symbol}`);
    return profile;
  }

  private profile(symbol: string): DemoTickerProfile | undefined {
    return DEMO_TICKERS.find((t) => t.symbol === symbol.toUpperCase());
  }

  private planFor(profile: DemoTickerProfile, date: string): DayPlan | undefined {
    let plans = this.plans.get(profile.symbol);
    if (!plans) {
      plans = this.buildPlans(profile);
      this.plans.set(profile.symbol, plans);
    }
    return plans.get(date);
  }

  private buildPlans(p: DemoTickerProfile): Map<string, DayPlan> {
    const rng = new Rng(hashString(`DEMO-${p.symbol}-v1`));
    const plans = new Map<string, DayPlan>();
    const dailyVol = p.vol / Math.sqrt(TRADING_DAYS_PER_YEAR);
    const marketDailyVol = 0.17 / Math.sqrt(TRADING_DAYS_PER_YEAR);
    const isMarket = p.symbol === 'SPY';
    const idioVol = isMarket ? 0 : Math.sqrt(Math.max(dailyVol ** 2 - (p.beta * marketDailyVol) ** 2, (0.25 * dailyVol) ** 2));
    const dailyDrift = p.drift / TRADING_DAYS_PER_YEAR;
    let logPrice = Math.log(p.startPrice);
    const trendStart = logPrice;
    let close = p.startPrice;
    let postEnd = p.startPrice;
    let idioGarch = 1;
    let dayIndex = 0;
    // Earnings roughly every 63 trading days, offset per symbol.
    const earningsOffset = hashString(p.symbol) % 63;

    for (const date of this.market.dates()) {
      const m = this.market.get(date)!;
      const marketPart = isMarket ? m.ret : p.beta * m.ret;
      const idioShock = rng.fatTail(4);
      let idio = idioVol * idioGarch * idioShock;
      idioGarch = Math.min(3, Math.max(0.6, 0.93 * idioGarch + 0.07 * (1 + 0.8 * (Math.abs(idioShock) - 0.8))));
      let gapShare = m.gapShare;
      let earningsDay = false;
      if (p.earnings && (dayIndex + earningsOffset) % 63 === 0) {
        // Earnings: a large overnight gap that dominates the day.
        idio += rng.normal() * dailyVol * 3.2;
        gapShare = 0.8;
        earningsDay = true;
      }
      // Gentle pull toward the long-run trend keeps prices in a plausible range over many years.
      const trend = trendStart + dailyDrift * dayIndex;
      const reversion = -0.004 * (logPrice - trend);
      const totalRet = dailyDrift * 0.3 + marketPart + idio + reversion;

      const gap = totalRet * gapShare + rng.normal() * dailyVol * 0.08;
      const intraday = totalRet - gap;
      const prevClose = close;
      const prevPostEnd = postEnd;
      const open = prevClose * Math.exp(gap);
      close = open * Math.exp(intraday);
      postEnd = close * Math.exp(rng.normal() * dailyVol * 0.12);
      logPrice = Math.log(close);

      const sigma = dailyVol * m.volMult * Math.sqrt(idioGarch) * (earningsDay ? 1.6 : 1) * 0.75;
      const shapeRoll = rng.next();
      const shape: DayPlan['shape'] = Math.abs(intraday) > 1.2 * sigma ? (shapeRoll < 0.75 ? 'trend' : 'reversal') : shapeRoll < 0.45 ? 'range' : shapeRoll < 0.75 ? 'reversal' : 'trend';
      const volume = p.avgVolume * Math.exp(0.25 * rng.normal()) * (1 + 1.4 * Math.min(4, Math.abs(totalRet) / dailyVol) * 0.35) * (earningsDay ? 2.5 : 1);

      plans.set(date, { date, prevClose, prevPostEnd, open, close, postEnd, sigma, volume, shape, seed: rng.int(1, 2 ** 31) });
      dayIndex++;
    }
    return plans;
  }

  private dayBars(profile: DemoTickerProfile, date: string): Bar[] {
    const key = `${profile.symbol}|${date}`;
    const hit = this.dayCache.get(key);
    if (hit) return hit;
    const plan = this.planFor(profile, date);
    const bars = plan ? generateDay(plan) : [];
    this.dayCache.set(key, bars);
    this.dayCacheOrder.push(key);
    if (this.dayCacheOrder.length > this.maxCachedDays) {
      const evict = this.dayCacheOrder.shift()!;
      this.dayCache.delete(evict);
    }
    return bars;
  }
}

/**
 * Brownian bridge in log-price space with per-step variance weights, through optional waypoints.
 * Returns log prices at every step (length = weights.length + 1), starting at `from`, ending at `to`.
 */
function bridge(rng: Rng, from: number, to: number, weights: number[], totalVar: number, waypoints: { step: number; value: number }[] = []): number[] {
  const n = weights.length;
  const points = [{ step: 0, value: from }, ...waypoints.filter((w) => w.step > 0 && w.step < n), { step: n, value: to }];
  const out = new Array<number>(n + 1);
  const wSum = weights.reduce((a, b) => a + b, 0) || 1;
  for (let s = 0; s < points.length - 1; s++) {
    const a = points[s];
    const b = points[s + 1];
    // Free walk over the segment, then pin both ends (variance-weighted correction).
    const incs: number[] = [];
    let walk = 0;
    let segVar = 0;
    for (let i = a.step; i < b.step; i++) {
      const v = (weights[i] / wSum) * totalVar;
      const inc = Math.sqrt(v) * rng.fatTail(6);
      incs.push(inc);
      walk += inc;
      segVar += v;
    }
    const target = b.value - a.value;
    let acc = a.value;
    let cumVar = 0;
    out[a.step] = a.value;
    for (let k = 0; k < incs.length; k++) {
      const i = a.step + k;
      const v = (weights[i] / wSum) * totalVar;
      cumVar += v;
      acc += incs[k];
      const frac = segVar > 0 ? cumVar / segVar : (k + 1) / incs.length;
      out[i + 1] = acc - frac * (walk - target);
    }
  }
  return out;
}

function generateDay(plan: DayPlan): Bar[] {
  const rng = new Rng(plan.seed);
  const date = plan.date;
  const close = regularCloseMinute(date);
  const regularMinutes = close - REGULAR_OPEN;
  const preMinutes = REGULAR_OPEN - PREMARKET_OPEN;
  const postMinutes = Math.min(AFTERHOURS_CLOSE, close + 240) - close;

  const bars: Bar[] = [];
  const sigma = plan.sigma;

  const emit = (logPath: number[], startMinute: number, minutes: number, volumes: number[]) => {
    for (let m = 0; m < minutes; m++) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let s = 0; s <= SUBTICKS; s++) {
        const v = logPath[m * SUBTICKS + s];
        if (v > hi) hi = v;
        if (v < lo) lo = v;
      }
      const o = roundToTick(Math.exp(logPath[m * SUBTICKS]));
      const c = roundToTick(Math.exp(logPath[(m + 1) * SUBTICKS]));
      const h = Math.max(o, c, roundToTick(Math.exp(hi)));
      const l = Math.min(o, c, roundToTick(Math.exp(lo)));
      bars.push({ time: exchangeTimeToUnix(date, startMinute + m), open: o, high: h, low: l, close: c, volume: volumes[m] });
    }
  };

  const volumeCurve = (minutes: number, total: number, shape: (t: number) => number) => {
    const w: number[] = [];
    for (let t = 0; t < minutes; t++) w.push(shape(t) * Math.exp(0.45 * rng.normal()));
    const s = w.reduce((a, b) => a + b, 0);
    return w.map((x) => Math.max(1, Math.round(((x / s) * total) / 10) * 10));
  };

  // ---- Pre-market: thin, drifting from last night's after-hours print toward the open.
  {
    const steps = preMinutes * SUBTICKS;
    const weights = Array.from({ length: steps }, (_, i) => 1 + 3 * Math.exp(-(steps - i) / (SUBTICKS * 40)));
    const path = bridge(rng, Math.log(plan.prevPostEnd), Math.log(plan.open), weights, (sigma * 0.35) ** 2);
    const vols = volumeCurve(preMinutes, plan.volume * 0.045, (t) => 0.2 + Math.exp(-(preMinutes - t) / 45) * 3);
    emit(path, PREMARKET_OPEN, preMinutes, vols);
  }

  // ---- Regular session: U-shaped volatility, shaped by the day type.
  {
    const steps = regularMinutes * SUBTICKS;
    const weights = Array.from({ length: steps }, (_, i) => {
      const t = i / SUBTICKS;
      return 1 + 2.4 * Math.exp(-t / 25) + 0.9 * Math.exp(-(regularMinutes - t) / 30);
    });
    const lo = Math.log(plan.open);
    const lc = Math.log(plan.close);
    const move = lc - lo;
    const waypoints: { step: number; value: number }[] = [];
    let noiseVar = sigma ** 2;
    if (plan.shape === 'reversal') {
      const step = Math.floor(steps * rng.range(0.15, 0.6));
      const ext = -Math.sign(move || rng.normal()) * (Math.abs(move) * rng.range(0.3, 0.8) + sigma * rng.range(0.3, 0.7));
      waypoints.push({ step, value: lo + ext });
    } else if (plan.shape === 'trend') {
      // Trend days grind: less noise relative to the net move, with a mid-day pause.
      noiseVar *= 0.45;
      waypoints.push({ step: Math.floor(steps * rng.range(0.35, 0.55)), value: lo + move * rng.range(0.55, 0.8) });
    } else {
      noiseVar *= 1.1;
    }
    const path = bridge(rng, lo, lc, weights, noiseVar, waypoints);
    const vols = volumeCurve(regularMinutes, plan.volume * 0.92, (t) => 1 + 4.5 * Math.exp(-t / 14) + 1.8 * Math.exp(-(regularMinutes - t) / 18));
    // Volume reacts to price movement.
    for (let m = 0; m < regularMinutes; m++) {
      const r = Math.abs(path[(m + 1) * SUBTICKS] - path[m * SUBTICKS]) / (sigma / Math.sqrt(regularMinutes));
      vols[m] = Math.max(100, Math.round((vols[m] * (0.6 + 0.4 * Math.min(r, 4))) / 10) * 10);
    }
    emit(path, REGULAR_OPEN, regularMinutes, vols);
  }

  // ---- After-hours: thin drift from the close.
  {
    const steps = postMinutes * SUBTICKS;
    const weights = Array.from({ length: steps }, (_, i) => 1 + 2 * Math.exp(-i / (SUBTICKS * 20)));
    const path = bridge(rng, Math.log(plan.close), Math.log(plan.postEnd), weights, (sigma * 0.25) ** 2);
    const vols = volumeCurve(postMinutes, plan.volume * 0.03, (t) => 0.2 + 3 * Math.exp(-t / 20));
    emit(path, close, postMinutes, vols);
  }

  // The bridges are pinned, so the regular session opens and closes exactly at the planned prices
  // (up to tick rounding) and daily candles agree with the day plan.
  return bars;
}
