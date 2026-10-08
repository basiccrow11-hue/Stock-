/**
 * Fictional, continuously generated stock market. Everything here is SIMULATED: the companies,
 * prices, volume and news events are made up and are labelled as such in the UI.
 *
 * Model (per tick, default 5 simulated seconds):
 *   d log P = (drift_base + drift_regime + drift_event) dt
 *           + beta * marketShock
 *           + sigma_idio * garch * eventVol * intradayU(t) * sqrt(dt) * fatTail()
 *           - kappa * (log P - anchor) dt            (only in range/consolidation regimes)
 *           + jump                                    (news events)
 * Regimes per stock: uptrend / downtrend / range / breakout, switching stochastically.
 * Market regime: bull / bear / neutral across sessions, plus a trend-or-chop character per day.
 * Sessions are 09:30–16:00 exchange time on real calendar trading days; between sessions the clock
 * jumps overnight and prices gap (sometimes on simulated earnings).
 */
import type { Bar, UnixSeconds } from '../types';
import type { SymbolInfo } from '../data/provider';
import { Rng, hashString } from '../util/random';
import { roundToTick } from '../util/math';
import { REGULAR_OPEN, exchangeDate, exchangeMinuteOfDay, exchangeTimeToUnix, isTradingDay, nextTradingDay, prevTradingDay, regularCloseMinute } from '../time';

export type Personality = 'growth' | 'tech' | 'small_cap' | 'blue_chip' | 'volatile' | 'etf';

export interface SimStockProfile {
  symbol: string;
  name: string;
  personality: Personality;
  description: string;
  startPrice: number;
  annualVol: number;
  annualDrift: number;
  beta: number;
  avgDailyVolume: number;
  /** Expected company news events per session. */
  eventRate: number;
  /** Strength of pull back to the range anchor during consolidation. */
  meanReversion: number;
  /** Overnight gap volatility as a fraction of daily vol. */
  gapVol: number;
}

export const SIM_STOCKS: SimStockProfile[] = [
  { symbol: 'NOVA', name: 'Novaline Therapeutics', personality: 'growth', description: 'Growth stock: strong trends, sharp pullbacks', startPrice: 84, annualVol: 0.45, annualDrift: 0.25, beta: 1.3, avgDailyVolume: 9e6, eventRate: 0.5, meanReversion: 0.6, gapVol: 0.5 },
  { symbol: 'QBIT', name: 'Qubitron Systems', personality: 'tech', description: 'Large-cap tech: liquid, trends with the index', startPrice: 212, annualVol: 0.28, annualDrift: 0.15, beta: 1.25, avgDailyVolume: 25e6, eventRate: 0.35, meanReversion: 0.8, gapVol: 0.4 },
  { symbol: 'MINR', name: 'Minaret Resources', personality: 'small_cap', description: 'Small cap: thin, jumpy, big news reactions', startPrice: 6.4, annualVol: 0.75, annualDrift: 0.05, beta: 1.1, avgDailyVolume: 2.5e6, eventRate: 0.7, meanReversion: 0.4, gapVol: 0.7 },
  { symbol: 'STLW', name: 'Stallworth Consumer', personality: 'blue_chip', description: 'Blue chip: low volatility, mean-reverting', startPrice: 148, annualVol: 0.16, annualDrift: 0.07, beta: 0.7, avgDailyVolume: 7e6, eventRate: 0.15, meanReversion: 1.6, gapVol: 0.3 },
  { symbol: 'VLTX', name: 'Voltrix Mobility', personality: 'volatile', description: 'Volatile momentum name: violent swings both ways', startPrice: 37, annualVol: 0.95, annualDrift: 0.1, beta: 1.8, avgDailyVolume: 40e6, eventRate: 0.8, meanReversion: 0.3, gapVol: 0.8 },
  { symbol: 'SIMX', name: 'SimMarket 500 Index ETF', personality: 'etf', description: 'Index ETF: tracks the simulated market', startPrice: 410, annualVol: 0.17, annualDrift: 0.08, beta: 1, avgDailyVolume: 60e6, eventRate: 0, meanReversion: 0.5, gapVol: 0.35 },
];

export type MarketRegime = 'bull' | 'bear' | 'neutral';
export type StockRegime = 'uptrend' | 'downtrend' | 'range' | 'breakout';

export interface SimConfig {
  seed: number;
  /** Multiplies every stock's volatility. */
  volatilityMultiplier: number;
  /** Multiplies news-event frequency (0 disables news). */
  eventFrequency: number;
  /** Multiplies regime drift (0 = pure random walk, 2 = strong trends). */
  trendStrength: number;
  marketRegime: 'auto' | MarketRegime;
  /** Simulated seconds per tick. */
  tickSeconds: number;
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  seed: 20251008,
  volatilityMultiplier: 1,
  eventFrequency: 1,
  trendStrength: 1,
  marketRegime: 'auto',
  tickSeconds: 5,
};

export type SimEventType =
  | 'earnings_beat'
  | 'earnings_miss'
  | 'analyst_upgrade'
  | 'analyst_downgrade'
  | 'product_announcement'
  | 'lawsuit'
  | 'acquisition'
  | 'economic_news'
  | 'unexpected_news';

export interface SimEvent {
  id: string;
  time: UnixSeconds;
  /** Ticker, or 'MARKET' for market-wide economic news. */
  symbol: string;
  type: SimEventType;
  headline: string;
  /** Total expected price impact in % (the realised move also includes noise). */
  impactPct: number;
  simulated: true;
}

export const EVENT_LABELS: Record<SimEventType, string> = {
  earnings_beat: 'Earnings beat',
  earnings_miss: 'Earnings miss',
  analyst_upgrade: 'Analyst upgrade',
  analyst_downgrade: 'Analyst downgrade',
  product_announcement: 'Product announcement',
  lawsuit: 'Lawsuit',
  acquisition: 'Acquisition',
  economic_news: 'Economic news',
  unexpected_news: 'Unexpected company news',
};

interface StockState {
  profile: SimStockProfile;
  logPrice: number;
  anchor: number;
  regime: StockRegime;
  regimeMinutesLeft: number;
  regimeDirection: number;
  garch: number;
  eventDrift: number; // log-return per second
  eventDriftSecondsLeft: number;
  eventVol: number;
  bars: Bar[];
  forming: Bar | null;
}

export interface SimTickUpdate {
  symbol: string;
  /** The 1m bar being formed (or just completed). */
  bar: Bar;
  isNewBar: boolean;
  /** Price path of this tick as a micro-bar, for order execution. */
  tick: Bar;
}

const SECONDS_PER_YEAR = 252 * 390 * 60;

export class SimMarket {
  readonly profiles: SimStockProfile[];
  config: SimConfig;
  clock: UnixSeconds;
  marketRegime: MarketRegime = 'neutral';
  dayCharacter: 'trend' | 'chop' = 'chop';
  dayDirection = 1;
  events: SimEvent[] = [];
  private rng: Rng;
  private stocks = new Map<string, StockState>();
  private marketRegimeSessionsLeft = 0;
  private eventSeq = 0;
  private sessionDate: string;

  constructor(opts: { profiles?: SimStockProfile[]; config?: Partial<SimConfig>; startDate: string; warmupSessions?: number }) {
    this.profiles = opts.profiles ?? SIM_STOCKS;
    this.config = { ...DEFAULT_SIM_CONFIG, ...opts.config };
    this.rng = new Rng(this.config.seed);
    let start = isTradingDay(opts.startDate) ? opts.startDate : nextTradingDay(opts.startDate);
    const warmup = opts.warmupSessions ?? 2;
    for (let i = 0; i < warmup; i++) start = prevTradingDay(start);
    this.sessionDate = start;
    this.clock = exchangeTimeToUnix(start, REGULAR_OPEN);
    for (const p of this.profiles) {
      const logPrice = Math.log(p.startPrice);
      this.stocks.set(p.symbol, {
        profile: p,
        logPrice,
        anchor: logPrice,
        regime: 'range',
        regimeMinutesLeft: 30 + this.rng.int(0, 90),
        regimeDirection: 1,
        garch: 1,
        eventDrift: 0,
        eventDriftSecondsLeft: 0,
        eventVol: 1,
        bars: [],
        forming: null,
      });
    }
    this.startSession(true);
    // Generate warm-up history so charts and indicators have context when the market "opens".
    if (warmup > 0) {
      const target = exchangeTimeToUnix(opts.startDate && isTradingDay(opts.startDate) ? opts.startDate : nextTradingDay(opts.startDate), REGULAR_OPEN);
      while (this.clock < target) this.advance(this.config.tickSeconds);
    }
  }

  symbols(): SymbolInfo[] {
    return this.profiles.map((p) => ({ symbol: p.symbol, name: p.name, kind: p.personality === 'etf' ? 'etf' : 'stock', description: p.description }));
  }

  /** Completed 1m bars plus the forming bar. */
  history(symbol: string): Bar[] {
    const s = this.stocks.get(symbol);
    if (!s) return [];
    return s.forming ? [...s.bars, { ...s.forming }] : [...s.bars];
  }

  price(symbol: string): number {
    const s = this.stocks.get(symbol);
    return s ? roundToTick(Math.exp(s.logPrice)) : NaN;
  }

  regimeOf(symbol: string): StockRegime | undefined {
    return this.stocks.get(symbol)?.regime;
  }

  /** Advance simulated time; returns per-tick updates in chronological order. */
  advance(seconds: number): SimTickUpdate[] {
    const out: SimTickUpdate[] = [];
    const dt = this.config.tickSeconds;
    let remaining = seconds;
    while (remaining >= dt - 1e-9) {
      remaining -= dt;
      const close = exchangeTimeToUnix(this.sessionDate, regularCloseMinute(this.sessionDate));
      if (this.clock + dt > close) {
        this.closeSession();
        this.overnight();
        continue;
      }
      out.push(...this.tick(dt));
    }
    return out;
  }

  private tick(dt: number): SimTickUpdate[] {
    const cfg = this.config;
    const t = this.clock;
    const minuteOfSession = (exchangeMinuteOfDay(t) - REGULAR_OPEN) + (t % 60) / 60;
    const sessionLen = regularCloseMinute(this.sessionDate) - REGULAR_OPEN;
    const u = 0.75 + 1.4 * Math.exp(-minuteOfSession / 30) + 0.5 * Math.exp(-(sessionLen - minuteOfSession) / 35);
    const volU = 0.6 + 3.5 * Math.exp(-minuteOfSession / 20) + 1.6 * Math.exp(-(sessionLen - minuteOfSession) / 25);

    // Market factor shock shared by all stocks.
    const mVolSec = (0.17 * cfg.volatilityMultiplier) / Math.sqrt(SECONDS_PER_YEAR);
    // Drifts are specified per session (390 minutes) and converted to per-second rates.
    const sessionSeconds = sessionLen * 60;
    const regimeDrift = { bull: 0.0008, bear: -0.0012, neutral: 0 }[this.marketRegime] / sessionSeconds;
    const dayDrift = this.dayCharacter === 'trend' ? (this.dayDirection * 0.006) / sessionSeconds : 0;
    const marketShock = (regimeDrift + dayDrift) * cfg.trendStrength * dt + mVolSec * u * Math.sqrt(dt) * this.rng.fatTail(5);

    // Market-wide economic news.
    if (cfg.eventFrequency > 0 && this.rng.chance((0.5 * cfg.eventFrequency * dt) / (sessionLen * 60))) {
      this.marketEvent(t);
    }

    const updates: SimTickUpdate[] = [];
    for (const s of this.stocks.values()) {
      const p = s.profile;
      const before = s.logPrice;
      const idioVolSec = (Math.sqrt(Math.max(p.annualVol ** 2 - (p.beta * 0.17) ** 2, (0.3 * p.annualVol) ** 2)) * cfg.volatilityMultiplier) / Math.sqrt(SECONDS_PER_YEAR);

      // Regime drift.
      let drift = p.annualDrift / SECONDS_PER_YEAR;
      // A trend regime drifts ~1 daily standard deviation per full session.
      const trendSec = (1.0 * (p.annualVol / Math.sqrt(252)) * cfg.trendStrength) / (sessionLen * 60);
      if (s.regime === 'uptrend') drift += trendSec;
      else if (s.regime === 'downtrend') drift -= trendSec;
      else if (s.regime === 'breakout') drift += s.regimeDirection * trendSec * 3;
      if (s.eventDriftSecondsLeft > 0) {
        drift += s.eventDrift;
        s.eventDriftSecondsLeft -= dt;
      }
      let dlog = drift * dt;
      if (p.personality === 'etf') dlog += marketShock;
      else dlog += p.beta * marketShock;
      const volBoost = s.regime === 'breakout' ? 1.8 : s.regime === 'range' ? 0.85 : 1;
      dlog += idioVolSec * s.garch * s.eventVol * volBoost * u * Math.sqrt(dt) * this.rng.fatTail(4);
      if (s.regime === 'range') dlog -= p.meanReversion * 40 * (s.logPrice - s.anchor) * (dt / (390 * 60));

      // Company news.
      if (p.eventRate > 0 && cfg.eventFrequency > 0 && this.rng.chance((p.eventRate * cfg.eventFrequency * dt) / (sessionLen * 60))) {
        dlog += this.companyEvent(s, t);
      }

      s.logPrice += dlog;
      s.logPrice = Math.max(s.logPrice, Math.log(0.05));
      // Decay event volatility and update GARCH-like clustering.
      s.eventVol = 1 + (s.eventVol - 1) * Math.exp(-dt / (15 * 60));
      const z = Math.abs(dlog) / (idioVolSec * Math.sqrt(dt) + 1e-12);
      s.garch = Math.min(2.5, Math.max(0.7, s.garch + 0.0015 * (z - 1.1)));

      const o = roundToTick(Math.exp(before));
      const c = roundToTick(Math.exp(s.logPrice));
      const vol = Math.max(1, Math.round((p.avgDailyVolume / ((sessionLen * 60) / dt)) * volU * (0.5 + Math.min(4, z) * 0.5) * Math.exp(0.4 * this.rng.normal()) * s.eventVol));
      const tickBar: Bar = { time: t, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: vol };
      updates.push(this.updateBar(s, tickBar));
    }

    this.clock = t + dt;
    // Regime transitions are checked once per simulated minute.
    if (Math.floor(this.clock / 60) !== Math.floor(t / 60)) {
      for (const s of this.stocks.values()) this.maybeSwitchRegime(s);
    }
    return updates;
  }

  private updateBar(s: StockState, tick: Bar): SimTickUpdate {
    const minute = Math.floor(tick.time / 60) * 60;
    let isNewBar = false;
    if (!s.forming || s.forming.time !== minute) {
      if (s.forming) s.bars.push(s.forming);
      s.forming = { time: minute, open: tick.open, high: tick.high, low: tick.low, close: tick.close, volume: tick.volume };
      isNewBar = true;
    } else {
      const f = s.forming;
      f.high = Math.max(f.high, tick.high);
      f.low = Math.min(f.low, tick.low);
      f.close = tick.close;
      f.volume += tick.volume;
    }
    if (s.bars.length > 20_000) s.bars.splice(0, s.bars.length - 20_000);
    return { symbol: s.profile.symbol, bar: { ...s.forming }, isNewBar, tick };
  }

  private maybeSwitchRegime(s: StockState): void {
    s.regimeMinutesLeft -= 1;
    if (s.regimeMinutesLeft > 0) return;
    const r = this.rng.next();
    const bias = this.marketRegime === 'bull' ? 0.12 : this.marketRegime === 'bear' ? -0.12 : 0;
    const prev = s.regime;
    if (prev === 'range' && r < 0.3) {
      s.regime = 'breakout';
      s.regimeDirection = this.rng.next() < 0.5 + bias ? 1 : -1;
      s.regimeMinutesLeft = this.rng.int(5, 20);
    } else if (prev === 'breakout') {
      s.regime = s.regimeDirection > 0 ? 'uptrend' : 'downtrend';
      s.regimeMinutesLeft = this.rng.int(30, 120);
    } else {
      const u = this.rng.next();
      s.regime = u < 0.45 ? 'range' : u < 0.725 + bias ? 'uptrend' : 'downtrend';
      s.regimeMinutesLeft = s.regime === 'range' ? this.rng.int(30, 150) : this.rng.int(20, 100);
    }
    if (s.regime === 'range') s.anchor = s.logPrice;
  }

  private nextEventId(): string {
    this.eventSeq += 1;
    return `sim-ev${this.eventSeq}`;
  }

  /** Applies a company event. Returns the immediate log jump. */
  private companyEvent(s: StockState, t: UnixSeconds, overnight = false): number {
    const p = s.profile;
    const scale = { growth: 1.2, tech: 1, small_cap: 1.8, blue_chip: 0.6, volatile: 1.6, etf: 0.4 }[p.personality];
    const roll = this.rng.next();
    let type: SimEventType;
    if (overnight) type = this.rng.next() < 0.55 ? 'earnings_beat' : 'earnings_miss';
    // Earnings are reported outside market hours (see overnight()); intraday news is everything else.
    else if (roll < 0.22) type = 'analyst_upgrade';
    else if (roll < 0.42) type = 'analyst_downgrade';
    else if (roll < 0.62) type = 'product_announcement';
    else if (roll < 0.74) type = 'lawsuit';
    else if (roll < 0.79 && p.personality === 'small_cap') type = 'acquisition';
    else type = 'unexpected_news';

    const mag: Record<SimEventType, [number, number, number]> = {
      // [min %, max %, sign]
      earnings_beat: [3, 11, 1],
      earnings_miss: [4, 14, -1],
      analyst_upgrade: [1, 4, 1],
      analyst_downgrade: [1.5, 5, -1],
      product_announcement: [1, 6, 1],
      lawsuit: [2, 9, -1],
      acquisition: [10, 20, 1],
      economic_news: [0.2, 0.8, 0],
      unexpected_news: [2, 10, 0],
    };
    const [lo, hi, sign] = mag[type];
    const direction = sign === 0 ? (this.rng.next() < 0.5 ? 1 : -1) : sign;
    const impactPct = direction * this.rng.range(lo, hi) * scale;
    const total = Math.log(1 + impactPct / 100);
    const jumpShare = overnight ? 0.85 : this.rng.range(0.45, 0.75);
    const jump = total * jumpShare;
    // The rest drifts in over the next minutes; ~25% of the time the move fades instead (overreaction).
    const fades = this.rng.chance(0.25);
    const driftTotal = fades ? -total * this.rng.range(0.2, 0.5) : total * (1 - jumpShare);
    const driftSeconds = this.rng.int(10, 40) * 60;
    s.eventDrift = driftTotal / driftSeconds;
    s.eventDriftSecondsLeft = driftSeconds;
    s.eventVol = Math.max(s.eventVol, Math.min(3, 1.4 + Math.abs(impactPct) / 10));
    if (Math.abs(impactPct) > 4) {
      s.regime = 'breakout';
      s.regimeDirection = Math.sign(impactPct);
      s.regimeMinutesLeft = this.rng.int(5, 15);
    }
    this.events.push({ id: this.nextEventId(), time: t, symbol: p.symbol, type, headline: headlineFor(type, p, impactPct, this.rng), impactPct, simulated: true });
    return jump;
  }

  private marketEvent(t: UnixSeconds): void {
    const impactPct = (this.rng.next() < 0.5 ? 1 : -1) * this.rng.range(0.2, 0.8);
    const total = Math.log(1 + impactPct / 100);
    for (const s of this.stocks.values()) {
      const b = s.profile.personality === 'etf' ? 1 : s.profile.beta;
      s.logPrice += total * b * 0.6;
      s.eventDrift = (total * b * 0.4) / (20 * 60);
      s.eventDriftSecondsLeft = 20 * 60;
      s.eventVol = Math.max(s.eventVol, 1.5);
    }
    const what = this.rng.pick(['CPI print', 'jobs report', 'central bank rate decision', 'GDP estimate', 'retail sales figure', 'manufacturing survey']);
    const headline = `[SIMULATED] ${impactPct > 0 ? 'Softer-than-expected' : 'Hotter-than-expected'} ${what} moves the whole market ${impactPct > 0 ? 'higher' : 'lower'}`;
    this.events.push({ id: this.nextEventId(), time: t, symbol: 'MARKET', type: 'economic_news', headline, impactPct, simulated: true });
  }

  private startSession(first = false): void {
    // Market regime over sessions.
    if (this.config.marketRegime !== 'auto') this.marketRegime = this.config.marketRegime;
    else if (first || --this.marketRegimeSessionsLeft <= 0) {
      const u = this.rng.next();
      this.marketRegime = u < 0.45 ? 'bull' : u < 0.7 ? 'neutral' : 'bear';
      this.marketRegimeSessionsLeft = this.rng.int(3, 12);
    }
    this.dayCharacter = this.rng.next() < 0.35 ? 'trend' : 'chop';
    const bias = this.marketRegime === 'bull' ? 0.65 : this.marketRegime === 'bear' ? 0.35 : 0.5;
    this.dayDirection = this.rng.next() < bias ? 1 : -1;
  }

  private closeSession(): void {
    for (const s of this.stocks.values()) {
      if (s.forming) {
        s.bars.push(s.forming);
        s.forming = null;
      }
    }
  }

  private overnight(): void {
    this.sessionDate = nextTradingDay(this.sessionDate);
    this.clock = exchangeTimeToUnix(this.sessionDate, REGULAR_OPEN);
    this.startSession();
    // Overnight gap = shared market gap (scaled by beta) + company-specific gap.
    const marketGap = this.rng.normal() * (0.17 / Math.sqrt(252)) * 0.35 * this.config.volatilityMultiplier;
    for (const s of this.stocks.values()) {
      const p = s.profile;
      const dailyVol = (p.annualVol * this.config.volatilityMultiplier) / Math.sqrt(252);
      s.logPrice += (p.personality === 'etf' ? 1 : p.beta) * marketGap;
      if (p.personality !== 'etf') s.logPrice += this.rng.normal() * dailyVol * p.gapVol * 0.8;
      if (p.eventRate > 0 && this.config.eventFrequency > 0 && this.rng.chance(0.06 * this.config.eventFrequency)) {
        s.logPrice += this.companyEvent(s, this.clock, true);
      }
      s.anchor = s.logPrice;
    }
  }

  get currentSessionDate(): string {
    return this.sessionDate;
  }

  /** Exchange date of the simulated clock (for display). */
  get date(): string {
    return exchangeDate(this.clock);
  }
}

function headlineFor(type: SimEventType, p: SimStockProfile, impactPct: number, rng: Rng): string {
  const n = p.name;
  const q = rng.pick(['Q1', 'Q2', 'Q3', 'Q4']);
  const firm = rng.pick(['Halvorsen & Co.', 'Brightwater Securities', 'Marlowe Capital', 'Sundial Research', 'Kestrel Partners']);
  const product = rng.pick(['next-generation platform', 'flagship product line', 'subscription service', 'partnership program', 'manufacturing facility']);
  const text: Record<SimEventType, string> = {
    earnings_beat: `${n} beats ${q} estimates and raises guidance`,
    earnings_miss: `${n} misses ${q} estimates; outlook cut`,
    analyst_upgrade: `${firm} upgrades ${p.symbol} to Buy`,
    analyst_downgrade: `${firm} downgrades ${p.symbol} to Underperform`,
    product_announcement: `${n} unveils ${product}`,
    lawsuit: `${n} named in lawsuit over ${rng.pick(['patent infringement', 'accounting practices', 'product safety', 'contract dispute'])}`,
    acquisition: `${n} to be acquired at a premium in all-cash deal`,
    economic_news: `Economic data surprise`,
    unexpected_news: impactPct > 0 ? `${n} shares jump on unexpected ${rng.pick(['contract win', 'regulatory approval', 'CEO buyback announcement'])}` : `${n} shares slide after ${rng.pick(['CFO departure', 'production halt', 'guidance warning', 'short-seller report'])}`,
  };
  return `[SIMULATED] ${text[type]}`;
}

export function simSeedFrom(label: string): number {
  return hashString(label);
}
