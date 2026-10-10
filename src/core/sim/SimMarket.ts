/**
 * Fictional, continuously generated stock market. Everything here is SIMULATED: the companies,
 * prices, volume and news events are made up and are labelled as such in the UI.
 *
 * Model (per tick of dt simulated seconds, default 1):
 *   d log P = (drift_base + drift_regime + drift_event) dt
 *           + beta * marketMove                       (shared market factor, with its own news and gaps)
 *           + sigma_diffusion * sqrt(h) * eventVol * regimeVol * intradayU(t) * sqrt(dt) * z
 *           - kappa * (own log P - anchor) dt        (only in range/consolidation regimes)
 *           + jump                                    (news events and occasional sudden moves)
 * where z is a standard normal shock and h a mean-reverting variance (volatility clustering, see
 * nextVariance). The market factor moves the same way with its own variance.
 * Each stock's configured annual volatility is a budget: the market, overnight gaps, news and sudden
 * moves take their expected shares of it and the intraday diffusion gets the rest (varianceBudget), so
 * realised volatility, news included, matches the profile. Every move scales with the volatility
 * setting. The tick only sets how often prices update: per-tick volatility, the variance process and
 * the chances of news and jumps are all scaled to it, so the statistics are the same at any tick size.
 * Regimes per stock: uptrend / downtrend / range / breakout, switching stochastically.
 * Market regime: bull / bear / neutral across sessions, plus a trend-or-chop character per day.
 * Sessions are 09:30–16:00 exchange time on real calendar trading days; between sessions the clock
 * jumps overnight and prices gap (sometimes on simulated earnings).
 */
import type { Bar, UnixSeconds } from '../types';
import type { SymbolInfo } from '../data/provider';
import { Rng, hashString } from '../util/random';
import { roundToTick } from '../util/math';
import { REGULAR_OPEN, exchangeDate, exchangeTimeToUnix, isTradingDay, nextTradingDay, prevTradingDay, regularCloseMinute } from '../time';

export type Personality = 'growth' | 'tech' | 'small_cap' | 'blue_chip' | 'volatile' | 'etf';

export interface SimStockProfile {
  symbol: string;
  name: string;
  personality: Personality;
  description: string;
  startPrice: number;
  /** Annual volatility of the stock's moves, everything included (market, gaps, news), at the default settings. */
  annualVol: number;
  annualDrift: number;
  beta: number;
  avgDailyVolume: number;
  /** Expected company news events per session at the default news frequency. */
  eventRate: number;
  /** Strength of pull back to the range anchor during consolidation. */
  meanReversion: number;
  /** Standard deviation of the company's own overnight gap, as a fraction of its daily volatility (the market's gap comes on top, by beta). */
  gapVol: number;
}

export const SIM_STOCKS: SimStockProfile[] = [
  { symbol: 'NOVA', name: 'Novaline Therapeutics', personality: 'growth', description: 'Growth stock: strong trends, sharp pullbacks', startPrice: 84, annualVol: 0.45, annualDrift: 0.25, beta: 1.3, avgDailyVolume: 9e6, eventRate: 0.23, meanReversion: 0.6, gapVol: 0.28 },
  { symbol: 'QBIT', name: 'Qubitron Systems', personality: 'tech', description: 'Large-cap tech: liquid, trends with the index', startPrice: 212, annualVol: 0.28, annualDrift: 0.15, beta: 1.25, avgDailyVolume: 25e6, eventRate: 0.18, meanReversion: 0.8, gapVol: 0.18 },
  { symbol: 'MINR', name: 'Minaret Resources', personality: 'small_cap', description: 'Small cap: thin, jumpy, big news reactions', startPrice: 6.4, annualVol: 0.75, annualDrift: 0.05, beta: 1.1, avgDailyVolume: 2.5e6, eventRate: 0.21, meanReversion: 0.4, gapVol: 0.3 },
  { symbol: 'STLW', name: 'Stallworth Consumer', personality: 'blue_chip', description: 'Blue chip: low volatility, mean-reverting', startPrice: 148, annualVol: 0.16, annualDrift: 0.07, beta: 0.7, avgDailyVolume: 7e6, eventRate: 0.14, meanReversion: 1.6, gapVol: 0.2 },
  { symbol: 'VLTX', name: 'Voltrix Mobility', personality: 'volatile', description: 'Volatile momentum name: violent swings both ways', startPrice: 37, annualVol: 0.95, annualDrift: 0.1, beta: 1.8, avgDailyVolume: 40e6, eventRate: 0.3, meanReversion: 0.3, gapVol: 0.3 },
  { symbol: 'SIMX', name: 'SimMarket 500 Index ETF', personality: 'etf', description: 'Index ETF: tracks the simulated market', startPrice: 410, annualVol: 0.17, annualDrift: 0.08, beta: 1, avgDailyVolume: 60e6, eventRate: 0, meanReversion: 0.5, gapVol: 0 },
];

export type MarketRegime = 'bull' | 'bear' | 'neutral';
export type StockRegime = 'uptrend' | 'downtrend' | 'range' | 'breakout';

export interface SimConfig {
  seed: number;
  /** Multiplies every stock's volatility: its diffusion, gaps, news moves and trends alike. */
  volatilityMultiplier: number;
  /** Multiplies news-event frequency (0 disables news). More news adds to the moves; none leaves a calmer market. */
  eventFrequency: number;
  /** Multiplies regime drift (0 = pure random walk, 2 = strong trends). */
  trendStrength: number;
  marketRegime: 'auto' | MarketRegime;
  /** Simulated seconds per tick: how often prices update. The market's statistics do not depend on it. */
  tickSeconds: number;
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  seed: 20251008,
  volatilityMultiplier: 1,
  eventFrequency: 1,
  trendStrength: 1,
  marketRegime: 'auto',
  tickSeconds: 1,
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

/** A full regular session, and a trading year of them: volatilities are annual, ticks are seconds. */
const SESSION_SECONDS = 390 * 60;
const SECONDS_PER_YEAR = 252 * SESSION_SECONDS;

/** Annual volatility of the market factor at the default settings (the index ETF's profile). */
const MARKET_VOL = 0.17;
/** The market's overnight gap, in the market's daily standard deviations. */
const MARKET_GAP = 0.4;
/** Market-wide economic news per session at the default news frequency. */
const MARKET_NEWS_RATE = 0.5;
/** A trend day (DAY_TREND_CHANCE of sessions) drifts DAY_TREND of the market's daily standard deviation. */
const DAY_TREND = 0.5;
const DAY_TREND_CHANCE = 0.35;
/** The hidden market regime's drift per session, in the market's daily standard deviations. */
const MARKET_REGIME_DRIFT: Record<MarketRegime, number> = { bull: 0.075, bear: -0.11, neutral: 0 };
/** The index ETF's own noise around the market factor (tracking error), as a fraction of its volatility. */
const ETF_TRACKING = 0.1;

/**
 * Volatility clustering. Each stock, and the market factor, carries a variance multiplier h with a
 * long-run mean of 1 (a GARCH(1,1) process; see nextVariance): a large shock raises it, and it decays
 * back to 1 with this time constant, so calm and wild stretches last from minutes to hours and carry
 * over into the next morning. h has a standard deviation of about 0.7: a stock's volatility is mostly
 * (10th to 90th percentile) between about 0.65 and 1.3 times its usual level.
 */
const VARIANCE_DECAY_SECONDS = 60 * 60;
/** Volatility of h per square root of a second (its innovations scale with the tick's square root). */
const VARIANCE_VOL = 0.01414;
/** A ceiling for h that only guards against runaway values: h spends well under 0.01% of the time there. */
const MAX_VARIANCE = 10;

/**
 * Sudden moves (a burst of orders), about JUMP_RATE per stock per session, more around the open and
 * close, each with a standard deviation of JUMP_SIZE of the stock's daily volatility. They give minute
 * returns their fat tails in a way that does not depend on the tick size.
 */
const JUMP_RATE = 4;
const JUMP_SIZE = 0.12;

/** Chance per night that a stock reports earnings (at the default news frequency), and that they beat. */
const EARNINGS_CHANCE = 0.015;
const EARNINGS_BEAT_CHANCE = 0.55;
/**
 * News sizes [min, max] in the stock's daily standard deviations (the market's, for economic news),
 * and their direction (0: either way). Uniform between min and max.
 */
const NEWS_SIZE: Record<SimEventType, [number, number, number]> = {
  earnings_beat: [1.2, 3.5, 1],
  earnings_miss: [1.5, 4.5, -1],
  analyst_upgrade: [0.3, 0.9, 1],
  analyst_downgrade: [0.4, 1.1, -1],
  product_announcement: [0.3, 1, 1],
  lawsuit: [0.5, 1.6, -1],
  acquisition: [3, 5, 1],
  economic_news: [0.2, 0.75, 0],
  unexpected_news: [0.5, 2, 0],
};
/** How strongly each personality reacts to its own news, relative to its daily volatility. */
const NEWS_SENSITIVITY: Record<Personality, number> = { growth: 1, tech: 0.9, small_cap: 1.1, blue_chip: 0.8, volatile: 1, etf: 0.5 };
/** News at or above this size (in daily standard deviations) starts a breakout. */
const BREAKOUT_NEWS = 1.2;
/**
 * How a news move plays out: a jump of NEWS_JUMP_SHARE of it at once (OVERNIGHT_JUMP_SHARE for earnings),
 * the rest drifting in over the next minutes, except that FADE_CHANCE of the time the drift gives back a
 * FADE share of the move instead (an overreaction).
 */
const NEWS_JUMP_SHARE: [number, number] = [0.45, 0.75];
const OVERNIGHT_JUMP_SHARE = 0.85;
const FADE_CHANCE = 0.25;
const FADE: [number, number] = [0.2, 0.5];

/** Intraday company news by type, with each type's share of a stock's news (acquisitions only for small caps). */
function newsMix(personality: Personality): [SimEventType, number][] {
  const small = personality === 'small_cap';
  return [
    ['analyst_upgrade', 0.22],
    ['analyst_downgrade', 0.2],
    ['product_announcement', 0.2],
    ['lawsuit', 0.12],
    ...(small ? [['acquisition', 0.02] as [SimEventType, number]] : []),
    ['unexpected_news', small ? 0.24 : 0.26],
  ];
}

/** Expected square of a draw uniform between a and b. */
function meanSquare([a, b]: readonly number[]): number {
  return (a * a + a * b + b * b) / 3;
}

/** Expected square of a news move's net effect, relative to its size: whole, or partly given back when it fades. */
function keptShare(jump: readonly [number, number]): number {
  const mean = (r: readonly [number, number]) => (r[0] + r[1]) / 2;
  const variance = (r: readonly [number, number]) => (r[1] - r[0]) ** 2 / 12;
  return 1 - FADE_CHANCE + FADE_CHANCE * (variance(jump) + variance(FADE) + (mean(jump) - mean(FADE)) ** 2);
}

/** Shares of a stock's daily variance, at the default settings, taken by each source of its moves. */
export interface VarianceBudget {
  /** The market factor (beta squared times the market's variance), its gaps, news and trend days included. */
  market: number;
  /** The company's own overnight gaps. */
  gap: number;
  /** Company news, intraday and overnight earnings, as it plays out. */
  news: number;
  /** Sudden moves. */
  jumps: number;
  /** The intraday diffusion: what is left. */
  diffusion: number;
}

/** Diffusion keeps at least this share, should a profile's other sources come to more than its volatility. */
const MIN_DIFFUSION = 0.15;

/** How a stock's configured volatility is split between the sources of its moves (see the model above). */
export function varianceBudget(p: SimStockProfile): VarianceBudget {
  if (p.personality === 'etf') return { market: 1, gap: 0, news: 0, jumps: 0, diffusion: ETF_TRACKING ** 2 };
  const market = Math.min(1, ((p.beta * MARKET_VOL) / p.annualVol) ** 2);
  const gap = p.gapVol ** 2;
  const intraday = newsMix(p.personality).reduce((sum, [type, share]) => sum + share * meanSquare(NEWS_SIZE[type]), 0);
  const earnings = EARNINGS_BEAT_CHANCE * meanSquare(NEWS_SIZE.earnings_beat) + (1 - EARNINGS_BEAT_CHANCE) * meanSquare(NEWS_SIZE.earnings_miss);
  const news = NEWS_SENSITIVITY[p.personality] ** 2 * (p.eventRate * intraday * keptShare(NEWS_JUMP_SHARE) + EARNINGS_CHANCE * earnings * keptShare([OVERNIGHT_JUMP_SHARE, OVERNIGHT_JUMP_SHARE]));
  const jumps = JUMP_RATE * JUMP_SIZE ** 2;
  return { market, gap, news, jumps, diffusion: Math.max(MIN_DIFFUSION, 1 - market - gap - news - jumps) };
}

/** The market factor's budget: its gaps, economic news (which plays out in full) and trend days; the rest is diffusion. */
const MARKET_DIFFUSION = 1 - MARKET_GAP ** 2 - MARKET_NEWS_RATE * meanSquare(NEWS_SIZE.economic_news) - DAY_TREND_CHANCE * DAY_TREND ** 2;

/**
 * The variance process's coefficients for a tick of dt seconds (see nextVariance): phi decays h back to
 * 1 with VARIANCE_DECAY_SECONDS, and alpha, VARIANCE_VOL times the square root of half the tick, is the
 * continuous-time limit's, so the clustering is the same at any tick size.
 */
export function varianceCoefficients(dt: number): { phi: number; alpha: number } {
  return { phi: Math.exp(-dt / VARIANCE_DECAY_SECONDS), alpha: VARIANCE_VOL * Math.sqrt(dt / 2) };
}

/**
 * One tick of a variance multiplier h: h' = 1 + phi (h - 1) + alpha h (z^2 - 1), a GARCH(1,1) step on
 * the tick's standardized shock z, with a long-run mean of 1. h stays positive while alpha is below phi
 * (any tick under half an hour); the ceiling (MAX_VARIANCE) is a guard it reaches only in a rare burst.
 */
export function nextVariance(h: number, z: number, { phi, alpha }: { phi: number; alpha: number }): number {
  return Math.min(MAX_VARIANCE, 1 + phi * (h - 1) + alpha * h * (z * z - 1));
}

/** Intraday volatility pattern by minute of the session: high after the open, quiet at midday, livelier into the close. */
function volatilityShape(minute: number, sessionMinutes: number): number {
  return 0.75 + 1.4 * Math.exp(-minute / 30) + 0.5 * Math.exp(-(sessionMinutes - minute) / 35);
}

/** Intraday volume pattern: heavy at the open, light at midday, heavy again into the close. */
function volumeShape(minute: number, sessionMinutes: number): number {
  return 0.6 + 3.5 * Math.exp(-minute / 20) + 1.6 * Math.exp(-(sessionMinutes - minute) / 25);
}

/**
 * Scale factors for a session of this length: the volatility pattern gets a mean square of 1 and the
 * volume pattern a mean of 1, so they move volatility and volume within the day, not the day's total.
 */
function shapeNorms(sessionMinutes: number): { volatility: number; volume: number } {
  let squares = 0;
  let volume = 0;
  for (let m = 0; m < sessionMinutes; m++) {
    squares += volatilityShape(m + 0.5, sessionMinutes) ** 2;
    volume += volumeShape(m + 0.5, sessionMinutes);
  }
  return { volatility: 1 / Math.sqrt(squares / sessionMinutes), volume: sessionMinutes / volume };
}

interface StockState {
  profile: SimStockProfile;
  /** Annual volatility of the intraday diffusion at the default volatility setting (from varianceBudget). */
  diffusionVol: number;
  /** Annual volatility of the stock's continuous intraday moves, the market's included: the yardstick for its volume. */
  continuousVol: number;
  logPrice: number;
  /** The last price, on the tick: where the next tick opens. */
  price: number;
  /** Where a range regime pulls the stock back to: its own log price, net of the market's move by beta (see ownLog). */
  anchor: number;
  regime: StockRegime;
  regimeMinutesLeft: number;
  regimeDirection: number;
  /** Variance multiplier (volatility clustering, see nextVariance). */
  h: number;
  eventDrift: number; // log-return per second
  eventDriftSecondsLeft: number;
  eventVol: number;
  /** This minute's volume level (redrawn every minute, so a minute's volume varies the same at any tick size). */
  volumeNoise: number;
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

/** Volatility multiplier for each regime; their mean square over a regime's typical time in each is about 1. */
const REGIME_VOL: Record<StockRegime, number> = { range: 0.9, uptrend: 1.05, downtrend: 1.05, breakout: 1.8 };

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
  private sessionOpen: UnixSeconds = 0;
  private sessionClose: UnixSeconds = 0;
  private sessionMinutes = 390;
  private shapeNorm = shapeNorms(390);
  /** The market factor's variance multiplier, and the drift and extra volatility left by economic news. */
  private marketH = 1;
  /** The market factor's cumulative log move, gaps included. */
  private marketLog = 0;
  private marketDrift = 0;
  private marketDriftSecondsLeft = 0;
  private marketEventVol = 1;

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
        diffusionVol: p.annualVol * Math.sqrt(varianceBudget(p).diffusion),
        continuousVol: Math.sqrt(p.annualVol ** 2 * varianceBudget(p).diffusion + (p.beta * MARKET_VOL) ** 2 * MARKET_DIFFUSION),
        logPrice,
        price: roundToTick(p.startPrice),
        anchor: logPrice,
        regime: 'range',
        regimeMinutesLeft: 30 + this.rng.int(0, 90),
        regimeDirection: 1,
        h: 1,
        eventDrift: 0,
        eventDriftSecondsLeft: 0,
        eventVol: 1,
        volumeNoise: 1,
        bars: [],
        forming: null,
      });
    }
    this.startSession(true);
    // Generate warm-up history so charts and indicators have context when the market "opens".
    if (warmup > 0) {
      const target = exchangeTimeToUnix(opts.startDate && isTradingDay(opts.startDate) ? opts.startDate : nextTradingDay(opts.startDate), REGULAR_OPEN);
      while (this.clock < target) this.step(false);
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
      this.step(true, out);
    }
    return out;
  }

  /** One tick, or the overnight jump to the next session when the tick would cross the close. Updates go to `out` when collecting. */
  private step(collect: boolean, out?: SimTickUpdate[]): void {
    const dt = this.config.tickSeconds;
    if (this.clock + dt > this.sessionClose) {
      this.closeSession();
      this.overnight();
      return;
    }
    this.tick(dt, collect ? out : undefined);
  }

  private tick(dt: number, out?: SimTickUpdate[]): void {
    const cfg = this.config;
    const vm = cfg.volatilityMultiplier;
    const t = this.clock;
    const minuteOfSession = (t - this.sessionOpen) / 60;
    const sessionSeconds = this.sessionMinutes * 60;
    const u = volatilityShape(minuteOfSession, this.sessionMinutes) * this.shapeNorm.volatility;
    const volU = volumeShape(minuteOfSession, this.sessionMinutes) * this.shapeNorm.volume;
    const variance = varianceCoefficients(dt);
    const sqrtDt = Math.sqrt(dt);
    // News leaves livelier trading behind that fades over about 15 minutes.
    const eventDecay = Math.exp(-dt / (15 * 60));

    // Market factor shared by all stocks: hidden regime and day drift, diffusion, economic news.
    const marketDaily = (MARKET_VOL * vm) / Math.sqrt(252);
    let marketMove = ((MARKET_REGIME_DRIFT[this.marketRegime] + (this.dayCharacter === 'trend' ? this.dayDirection * DAY_TREND : 0)) * marketDaily * cfg.trendStrength * dt) / SESSION_SECONDS;
    if (this.marketDriftSecondsLeft > 0) {
      marketMove += this.marketDrift * dt;
      this.marketDriftSecondsLeft -= dt;
    }
    const zm = this.rng.normal();
    marketMove += ((MARKET_VOL * vm * Math.sqrt(MARKET_DIFFUSION)) / Math.sqrt(SECONDS_PER_YEAR)) * Math.sqrt(this.marketH) * this.marketEventVol * u * sqrtDt * zm;
    this.marketH = nextVariance(this.marketH, zm, variance);
    this.marketEventVol = 1 + (this.marketEventVol - 1) * eventDecay;
    if (cfg.eventFrequency > 0 && this.rng.chance((MARKET_NEWS_RATE * cfg.eventFrequency * dt) / sessionSeconds)) {
      marketMove += this.marketEvent(t, marketDaily);
    }

    for (const s of this.stocks.values()) {
      const p = s.profile;
      const daily = (p.annualVol * vm) / Math.sqrt(252);

      // The index ETF is the market factor plus a little tracking noise: regimes are each stock's own.
      const etf = p.personality === 'etf';
      const regime = etf ? null : s.regime;
      // Regime drift. A trend regime drifts about one daily standard deviation per full session.
      let drift = p.annualDrift / SECONDS_PER_YEAR;
      const trendSec = (daily * cfg.trendStrength) / sessionSeconds;
      if (regime === 'uptrend') drift += trendSec;
      else if (regime === 'downtrend') drift -= trendSec;
      else if (regime === 'breakout') drift += s.regimeDirection * trendSec * 3;
      if (s.eventDriftSecondsLeft > 0) {
        drift += s.eventDrift;
        s.eventDriftSecondsLeft -= dt;
      }
      let dlog = drift * dt;
      if (etf) dlog += marketMove;
      else dlog += p.beta * marketMove;
      const z = this.rng.normal();
      const diffusionSec = (s.diffusionVol * vm) / Math.sqrt(SECONDS_PER_YEAR);
      dlog += diffusionSec * Math.sqrt(s.h) * s.eventVol * (regime ? REGIME_VOL[regime] : 1) * u * sqrtDt * z;
      if (regime === 'range') dlog -= (p.meanReversion * 40 * (this.ownLog(s) - s.anchor) * dt) / SESSION_SECONDS;
      if (!etf && this.rng.chance((JUMP_RATE * u * u * dt) / sessionSeconds)) dlog += this.rng.normal() * JUMP_SIZE * daily;

      // Company news.
      if (p.eventRate > 0 && cfg.eventFrequency > 0 && this.rng.chance((p.eventRate * cfg.eventFrequency * dt) / sessionSeconds)) {
        dlog += this.companyEvent(s, t);
      }

      s.logPrice += dlog;
      s.logPrice = Math.max(s.logPrice, Math.log(0.05));
      // Decay event volatility and step the variance process on this tick's own (idiosyncratic) shock.
      s.eventVol = 1 + (s.eventVol - 1) * eventDecay;
      s.h = nextVariance(s.h, z, variance);

      const o = s.price;
      const c = (s.price = roundToTick(Math.exp(s.logPrice)));
      // Volume follows the time of day, how far price moved against a typical tick (about 1 on average), news
      // and the minute's level, so a session trades about the stock's average daily volume.
      const typical = (Math.sqrt(2 / Math.PI) * s.continuousVol * vm * u * sqrtDt) / Math.sqrt(SECONDS_PER_YEAR);
      const activity = 0.5 + 0.5 * Math.min(4, Math.abs(dlog) / (typical + 1e-12));
      const vol = Math.max(1, Math.round((p.avgDailyVolume / (sessionSeconds / dt)) * volU * activity * s.volumeNoise * s.eventVol));
      const tickBar: Bar = { time: t, open: o, high: Math.max(o, c), low: Math.min(o, c), close: c, volume: vol };
      const update = this.updateBar(s, tickBar, !!out);
      if (out && update) out.push(update);
    }

    this.marketLog += marketMove;
    this.clock = t + dt;
    // Regime transitions and the minute's volume level are drawn once per simulated minute.
    if (Math.floor(this.clock / 60) !== Math.floor(t / 60)) {
      for (const s of this.stocks.values()) {
        this.maybeSwitchRegime(s);
        s.volumeNoise = Math.exp(0.4 * this.rng.normal() - 0.08);
      }
    }
  }

  /** Adds a tick to its 1m bar; returns the update when asked for one (warm-up history skips them). */
  private updateBar(s: StockState, tick: Bar, report: boolean): SimTickUpdate | null {
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
    return report ? { symbol: s.profile.symbol, bar: { ...s.forming }, isNewBar, tick } : null;
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
    if (s.regime === 'range') s.anchor = this.ownLog(s);
  }

  private nextEventId(): string {
    this.eventSeq += 1;
    return `sim-ev${this.eventSeq}`;
  }

  /** Applies a company event. Returns the immediate log jump. */
  private companyEvent(s: StockState, t: UnixSeconds, overnight = false): number {
    const p = s.profile;
    let type: SimEventType = 'unexpected_news';
    // Earnings are reported outside market hours (see overnight()); intraday news is everything else.
    if (overnight) type = this.rng.next() < EARNINGS_BEAT_CHANCE ? 'earnings_beat' : 'earnings_miss';
    else {
      let roll = this.rng.next();
      for (const [kind, share] of newsMix(p.personality)) {
        type = kind;
        if ((roll -= share) < 0) break;
      }
    }
    const [lo, hi, sign] = NEWS_SIZE[type];
    const direction = sign === 0 ? (this.rng.next() < 0.5 ? 1 : -1) : sign;
    // The size in daily standard deviations, so news scales with the stock's volatility and the volatility setting.
    const size = this.rng.range(lo, hi) * NEWS_SENSITIVITY[p.personality];
    const total = direction * size * ((p.annualVol * this.config.volatilityMultiplier) / Math.sqrt(252));
    const impactPct = (Math.exp(total) - 1) * 100;
    const jumpShare = overnight ? OVERNIGHT_JUMP_SHARE : this.rng.range(...NEWS_JUMP_SHARE);
    const jump = total * jumpShare;
    // The rest drifts in over the next minutes; FADE_CHANCE of the time the move fades instead (overreaction).
    const fades = this.rng.chance(FADE_CHANCE);
    const driftTotal = fades ? -total * this.rng.range(...FADE) : total * (1 - jumpShare);
    const driftSeconds = this.rng.int(10, 40) * 60;
    s.eventDrift = driftTotal / driftSeconds;
    s.eventDriftSecondsLeft = driftSeconds;
    s.eventVol = Math.max(s.eventVol, Math.min(2.5, 1.3 + 0.3 * size));
    if (size >= BREAKOUT_NEWS) {
      s.regime = 'breakout';
      s.regimeDirection = direction;
      s.regimeMinutesLeft = this.rng.int(5, 15);
    }
    this.events.push({ id: this.nextEventId(), time: t, symbol: p.symbol, type, headline: headlineFor(type, p, impactPct, this.rng), impactPct, simulated: true });
    return jump;
  }

  /**
   * Applies market-wide economic news to the market factor (every stock follows by its beta): 60% of
   * the move at once, returned as a log jump, the rest over the next 20 minutes, with livelier trading.
   */
  private marketEvent(t: UnixSeconds, marketDaily: number): number {
    const [lo, hi] = NEWS_SIZE.economic_news;
    const total = (this.rng.next() < 0.5 ? 1 : -1) * this.rng.range(lo, hi) * marketDaily;
    const impactPct = (Math.exp(total) - 1) * 100;
    this.marketDrift = (total * 0.4) / (20 * 60);
    this.marketDriftSecondsLeft = 20 * 60;
    this.marketEventVol = Math.max(this.marketEventVol, 1.5);
    const what = this.rng.pick(['CPI print', 'jobs report', 'central bank rate decision', 'GDP estimate', 'retail sales figure', 'manufacturing survey']);
    const headline = `[SIMULATED] ${impactPct > 0 ? 'Softer-than-expected' : 'Hotter-than-expected'} ${what} moves the whole market ${impactPct > 0 ? 'higher' : 'lower'}`;
    this.events.push({ id: this.nextEventId(), time: t, symbol: 'MARKET', type: 'economic_news', headline, impactPct, simulated: true });
    return total * 0.6;
  }

  private startSession(first = false): void {
    this.sessionOpen = exchangeTimeToUnix(this.sessionDate, REGULAR_OPEN);
    const close = regularCloseMinute(this.sessionDate);
    this.sessionClose = exchangeTimeToUnix(this.sessionDate, close);
    if (close - REGULAR_OPEN !== this.sessionMinutes) {
      this.sessionMinutes = close - REGULAR_OPEN;
      this.shapeNorm = shapeNorms(this.sessionMinutes);
    }
    // Market regime over sessions.
    if (this.config.marketRegime !== 'auto') this.marketRegime = this.config.marketRegime;
    else if (first || --this.marketRegimeSessionsLeft <= 0) {
      const u = this.rng.next();
      this.marketRegime = u < 0.45 ? 'bull' : u < 0.7 ? 'neutral' : 'bear';
      this.marketRegimeSessionsLeft = this.rng.int(3, 12);
    }
    this.dayCharacter = this.rng.next() < DAY_TREND_CHANCE ? 'trend' : 'chop';
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
    const vm = this.config.volatilityMultiplier;
    const marketGap = this.rng.normal() * ((MARKET_VOL * vm) / Math.sqrt(252)) * MARKET_GAP;
    this.marketLog += marketGap;
    for (const s of this.stocks.values()) {
      const p = s.profile;
      const dailyVol = (p.annualVol * vm) / Math.sqrt(252);
      s.logPrice += (p.personality === 'etf' ? 1 : p.beta) * marketGap;
      if (p.personality !== 'etf') s.logPrice += this.rng.normal() * dailyVol * p.gapVol;
      if (p.eventRate > 0 && this.config.eventFrequency > 0 && this.rng.chance(EARNINGS_CHANCE * this.config.eventFrequency)) {
        s.logPrice += this.companyEvent(s, this.clock, true);
      }
      s.price = roundToTick(Math.exp(s.logPrice));
      s.anchor = this.ownLog(s);
    }
  }

  /**
   * A stock's log price net of the market's move (by its beta): consolidating in a range, a stock still
   * moves with the market, and only its own moves are pulled back.
   */
  private ownLog(s: StockState): number {
    return s.logPrice - (s.profile.personality === 'etf' ? 1 : s.profile.beta) * this.marketLog;
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
