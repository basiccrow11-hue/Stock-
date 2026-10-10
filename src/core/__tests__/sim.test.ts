import { describe, expect, it } from 'vitest';
import { SIM_STOCKS, SimMarket, nextVariance, varianceBudget, varianceCoefficients, type SimConfig } from '../sim/SimMarket';
import { SimBroker } from '../broker/SimBroker';
import { DEFAULT_EXECUTION_CONFIG, ZERO_COST_CONFIG } from '../broker/config';
import { exchangeDate, exchangeTimeToUnix, marketSession } from '../time';
import { Rng } from '../util/random';

function logReturns(closes: number[]): number[] {
  return closes.slice(1).map((c, i) => Math.log(c / closes[i]));
}
function std(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

describe('simulated market', () => {
  const market = new SimMarket({ startDate: '2026-10-08', warmupSessions: 0 });
  market.advance(390 * 60 * 6);

  it('is deterministic for a seed', () => {
    const again = new SimMarket({ startDate: '2026-10-08', warmupSessions: 0 });
    again.advance(390 * 60 * 6);
    expect(again.history('NOVA')).toEqual(market.history('NOVA'));
    expect(again.events).toEqual(market.events);
  });

  it('produces valid regular-session OHLC bars and positive prices', () => {
    for (const p of market.profiles) {
      const bars = market.history(p.symbol);
      expect(bars.length).toBeGreaterThan(390 * 5);
      for (const b of bars) {
        expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
        expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
        expect(b.low).toBeGreaterThan(0);
        expect(Number.isFinite(b.close)).toBe(true);
        expect(marketSession(b.time)).toBe('regular');
      }
    }
  });

  it('gives each personality its own volatility: volatile > growth > blue chip', () => {
    const vol = (s: string) => std(logReturns(market.history(s).map((b) => b.close)));
    expect(vol('VLTX')).toBeGreaterThan(vol('NOVA'));
    expect(vol('NOVA')).toBeGreaterThan(vol('STLW'));
    expect(vol('SIMX')).toBeLessThan(vol('QBIT'));
  });

  it('stocks are correlated with the index ETF', () => {
    // Intraday 1m returns only (bars are aligned by time across symbols).
    const intraday = (sym: string) => {
      const bars = market.history(sym);
      return bars.slice(1).flatMap((b, i) => (exchangeDate(b.time) === exchangeDate(bars[i].time) ? [Math.log(b.close / bars[i].close)] : []));
    };
    const r1 = intraday('QBIT');
    const r2 = intraday('SIMX');
    const n = Math.min(r1.length, r2.length);
    const a = r1.slice(0, n);
    const b = r2.slice(0, n);
    const ma = a.reduce((x, y) => x + y, 0) / n;
    const mb = b.reduce((x, y) => x + y, 0) / n;
    let cov = 0;
    for (let i = 0; i < n; i++) cov += (a[i] - ma) * (b[i] - mb);
    const corr = cov / n / (std(a) * std(b));
    expect(corr).toBeGreaterThan(0.3);
    expect(corr).toBeLessThan(0.95);
  });

  it('spans multiple sessions with overnight gaps', () => {
    const bars = market.history('SIMX');
    const days = new Set(bars.map((b) => exchangeDate(b.time)));
    expect(days.size).toBe(6);
  });

  it('updates every stock every simulated second, like a live tape', () => {
    const m = new SimMarket({ startDate: '2026-10-08', warmupSessions: 0 });
    const open = m.clock;
    expect(m.advance(1).map((u) => u.symbol)).toEqual(m.profiles.map((p) => p.symbol));
    expect(m.clock).toBe(open + 1);
  });

  it('generates labelled SIMULATED news events', () => {
    expect(market.events.length).toBeGreaterThan(3);
    for (const e of market.events) {
      expect(e.simulated).toBe(true);
      expect(e.headline.startsWith('[SIMULATED]')).toBe(true);
    }
  });

  it('can be traded through the same broker in real time', () => {
    const m = new SimMarket({ startDate: '2026-10-08', warmupSessions: 1 });
    const broker = new SimBroker({ startingBalance: 50_000, config: ZERO_COST_CONFIG, source: 'SIMULATED' });
    const feed = (secs: number) => {
      for (const u of m.advance(secs)) broker.onBar(u.symbol, u.tick, m.config.tickSeconds);
    };
    feed(60);
    const r = broker.submit({ symbol: 'QBIT', action: 'buy', type: 'market', quantity: 10, stopLoss: Math.round(m.price('QBIT') * 0.99 * 100) / 100 });
    expect(r.ok).toBe(true);
    expect(broker.position('QBIT').quantity).toBe(10);
    feed(3600);
    expect(broker.state.source).toBe('SIMULATED');
    const a = broker.account();
    expect(a.equity).toBeCloseTo(a.cash + a.longMarketValue + a.shortMarketValue, 4);
  });

  it('fills an order placed at the open, before the first tick, at that tick and not at the last close', () => {
    for (const seed of [3, 5]) {
      // As the app starts it: the broker learns each price from the warm-up history, then the clock is 09:30.
      const m = new SimMarket({ startDate: '2026-10-08', warmupSessions: 1, config: { seed } });
      const broker = new SimBroker({ startingBalance: 100_000, config: ZERO_COST_CONFIG, source: 'SIMULATED' });
      const h = m.history('NOVA');
      broker.onBar('NOVA', h[h.length - 1], 60);
      expect(exchangeDate(h[h.length - 1].time)).toBe('2026-10-07');
      broker.syncClock(m.clock);
      const r = broker.submit({ symbol: 'NOVA', action: 'buy', type: 'market', quantity: 10 });
      expect(r.order!.status).toBe('pending');
      const first = m.advance(m.config.tickSeconds).find((u) => u.symbol === 'NOVA')!;
      broker.onBar('NOVA', first.tick, m.config.tickSeconds);
      expect(broker.state.fills[0]).toMatchObject({ price: first.tick.open, time: first.tick.time });
      expect(exchangeDate(broker.state.fills[0].time)).toBe('2026-10-08');
    }
  });

  it('respects configuration: zero event frequency means no news', () => {
    const quiet = new SimMarket({ startDate: '2026-10-08', warmupSessions: 0, config: { eventFrequency: 0 } });
    quiet.advance(390 * 60 * 3);
    expect(quiet.events).toHaveLength(0);
  });
});

/** Per stock, over whole sessions: daily close-to-close log returns, daily high-low ranges (of the open), volumes and 1m log returns. */
interface RunStats {
  daily: number[];
  ranges: number[];
  volumes: number[];
  minutes: number[][];
}

function runMarket(seeds: number[], sessions: number, config: Partial<SimConfig> = {}): { stats: Map<string, RunStats>; events: number } {
  const stats = new Map<string, RunStats>(SIM_STOCKS.map((p) => [p.symbol, { daily: [], ranges: [], volumes: [], minutes: [] }]));
  let events = 0;
  for (const seed of seeds) {
    // The sessions before the start date, generated as the warm-up history the app opens with.
    const m = new SimMarket({ startDate: '2026-10-08', warmupSessions: sessions, config: { seed, ...config } });
    events += m.events.length;
    for (const p of SIM_STOCKS) {
      const days = new Map<string, ReturnType<SimMarket['history']>>();
      for (const b of m.history(p.symbol)) {
        const d = exchangeDate(b.time);
        const list = days.get(d);
        if (list) list.push(b);
        else days.set(d, [b]);
      }
      const whole = [...days.values()].slice(0, sessions);
      const st = stats.get(p.symbol)!;
      whole.forEach((d, i) => {
        st.ranges.push((Math.max(...d.map((b) => b.high)) - Math.min(...d.map((b) => b.low))) / d[0].open);
        st.volumes.push(d.reduce((v, b) => v + b.volume, 0));
        st.minutes.push(logReturns(d.map((b) => b.close)));
        if (i > 0) st.daily.push(Math.log(d[d.length - 1].close / whole[i - 1][whole[i - 1].length - 1].close));
      });
    }
  }
  return { stats, events };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
/** Annualised volatility from daily close-to-close returns: everything included (gaps, news, trends). */
const annualVol = (st: RunStats) => std(st.daily) * Math.sqrt(252);
/** Annualised volatility from the sum of squared 1m returns within sessions (more precise; leaves out gaps and slow drifts). */
const intradayVol = (st: RunStats) => Math.sqrt(mean(st.minutes.map((d) => d.reduce((a, r) => a + r * r, 0))) * 252);

/**
 * Autocorrelation of absolute 1m returns at `lag` minutes within sessions, after dividing out the usual
 * size at each minute of the session (the open is always livelier), so only clustering is left.
 */
function absAutocorrelation(days: number[][], lag: number): number {
  const len = Math.max(...days.map((d) => d.length));
  const usual = Array.from({ length: len }, (_, i) => mean(days.filter((d) => d.length > i).map((d) => Math.abs(d[i]))) || 1);
  const scaled = days.map((d) => d.map((r, i) => Math.abs(r) / usual[i]));
  const m = mean(scaled.flat());
  let num = 0;
  let den = 0;
  for (const d of scaled) {
    for (let i = 0; i < d.length; i++) {
      den += (d[i] - m) ** 2;
      if (i >= lag) num += (d[i] - m) * (d[i - lag] - m);
    }
  }
  return num / den;
}

describe('simulated market calibration (default settings, fixed seeds)', () => {
  // 120 sessions (four seeds of 30) at the default one-second tick (spelled out, as the last test compares it
  // with five seconds), and the same seeds at five seconds.
  const fine = runMarket([1, 2, 3, 4], 30, { tickSeconds: 1 }).stats;
  const coarse = runMarket([1, 2, 3, 4], 30, { tickSeconds: 5 });
  const at = (symbol: string) => fine.get(symbol)!;

  it("realises each stock's configured volatility, news and gaps included", () => {
    for (const p of SIM_STOCKS) {
      const realised = `${p.symbol} realised ${(annualVol(at(p.symbol)) * 100).toFixed(1)}% vs ${p.annualVol * 100}%`;
      expect(annualVol(at(p.symbol)) / p.annualVol, realised).toBeGreaterThan(0.75);
      expect(annualVol(at(p.symbol)) / p.annualVol, realised).toBeLessThan(1.25);
      // Intraday moves are most of it: their own volatility is within the same band.
      expect(intradayVol(at(p.symbol)) / p.annualVol, p.symbol).toBeGreaterThan(0.75);
      expect(intradayVol(at(p.symbol)) / p.annualVol, p.symbol).toBeLessThan(1.25);
    }
  });

  it('keeps the personalities in order and their daily ranges plausible for their type', () => {
    const vol = (s: string) => annualVol(at(s));
    const range = (s: string) => mean(at(s).ranges);
    for (const order of [vol, range]) {
      expect(order('VLTX')).toBeGreaterThan(order('MINR'));
      expect(order('MINR')).toBeGreaterThan(order('NOVA'));
      expect(order('NOVA')).toBeGreaterThan(order('QBIT'));
      expect(order('QBIT')).toBeGreaterThan(order('STLW'));
      expect(order('QBIT')).toBeGreaterThan(order('SIMX'));
    }
    for (const p of SIM_STOCKS) {
      // A day's high-low range is about 1.6 daily standard deviations for a random walk with no gaps.
      const dailyVol = p.annualVol / Math.sqrt(252);
      expect(range(p.symbol) / dailyVol, p.symbol).toBeGreaterThan(1);
      expect(range(p.symbol) / dailyVol, p.symbol).toBeLessThan(1.8);
    }
    expect(range('STLW')).toBeLessThan(0.02);
    expect(range('SIMX')).toBeLessThan(0.02);
    expect(range('QBIT')).toBeLessThan(0.035);
    expect(range('VLTX')).toBeLessThan(0.1);
  });

  it('clusters volatility: busy and quiet stretches last from minutes to an hour', () => {
    const days = SIM_STOCKS.flatMap((p) => at(p.symbol).minutes);
    const acf = [1, 5, 15, 30, 60].map((lag) => absAutocorrelation(days, lag));
    for (const a of acf) expect(a).toBeGreaterThan(0.01);
    expect(acf[2]).toBeGreaterThan(0.03);
    // It fades with time.
    for (let i = 1; i < acf.length; i++) expect(acf[i]).toBeLessThan(acf[i - 1]);
  });

  it('moves each stock with the market by its beta, ranges included', () => {
    const corr = (a: number[], b: number[]) => {
      const ma = mean(a);
      const mb = mean(b);
      let cov = 0;
      for (let i = 0; i < a.length; i++) cov += (a[i] - ma) * (b[i] - mb);
      return cov / a.length / (std(a) * std(b));
    };
    for (const p of SIM_STOCKS.filter((x) => x.personality !== 'etf')) {
      // The market's share of the stock's variance, as budgeted, is the expected squared correlation.
      const expected = Math.sqrt(varianceBudget(p).market);
      const daily = corr(at(p.symbol).daily, at('SIMX').daily);
      expect(daily, p.symbol).toBeGreaterThan(expected - 0.2);
      expect(daily, p.symbol).toBeLessThan(expected + 0.2);
    }
  });

  it("trades about each stock's average daily volume", () => {
    for (const p of SIM_STOCKS) {
      const ratio = mean(at(p.symbol).volumes) / p.avgDailyVolume;
      expect(ratio, p.symbol).toBeGreaterThan(0.85);
      expect(ratio, p.symbol).toBeLessThan(1.15);
    }
  });

  it('budgets every stock so that intraday diffusion keeps a real share of its volatility', () => {
    for (const p of SIM_STOCKS.filter((x) => x.personality !== 'etf')) {
      const b = varianceBudget(p);
      expect(b.market + b.gap + b.news + b.jumps + b.diffusion, p.symbol).toBeCloseTo(1, 6);
      expect(b.diffusion, p.symbol).toBeGreaterThan(0.15);
      expect(b.news, p.symbol).toBeGreaterThan(0.1);
      expect(b.news, p.symbol).toBeLessThan(0.4);
    }
  });

  it('has the same statistics at a five-second tick: the tick only sets how often prices update', () => {
    for (const p of SIM_STOCKS) {
      const one = at(p.symbol);
      const five = coarse.stats.get(p.symbol)!;
      expect(intradayVol(five) / intradayVol(one), p.symbol).toBeGreaterThan(0.9);
      expect(intradayVol(five) / intradayVol(one), p.symbol).toBeLessThan(1.1);
      expect(mean(five.volumes) / mean(one.volumes), p.symbol).toBeGreaterThan(0.92);
      expect(mean(five.volumes) / mean(one.volumes), p.symbol).toBeLessThan(1.08);
      expect(mean(five.ranges) / mean(one.ranges), p.symbol).toBeGreaterThan(0.85);
      expect(mean(five.ranges) / mean(one.ranges), p.symbol).toBeLessThan(1.15);
    }
  });

});

describe('volatility clustering', () => {
  it('is a mean-reverting variance with a long-run mean of 1 that stays off its ceiling, the same at any tick', () => {
    const sds: number[] = [];
    for (const dt of [1, 5]) {
      const rng = new Rng(11);
      const coefficients = varianceCoefficients(dt);
      // 300 sessions, sampled every minute.
      const sessions = 300;
      const perMinute = 60 / dt;
      const samples: number[] = [];
      let h = 1;
      let atCeiling = 0;
      for (let i = 0; i < sessions * 390 * perMinute; i++) {
        h = nextVariance(h, rng.normal(), coefficients);
        if (h >= 10) atCeiling++;
        if (i % perMinute === 0) samples.push(h);
      }
      expect(mean(samples), `mean at ${dt}s`).toBeGreaterThan(0.9);
      expect(mean(samples), `mean at ${dt}s`).toBeLessThan(1.1);
      sds.push(std(samples));
      // A clamp it brushes in a rare burst, not a level it sits at: under 0.01% of the time.
      expect((atCeiling * dt) / (sessions * 390 * 60), `share of time at the ceiling at ${dt}s`).toBeLessThan(1e-4);
      expect(samples.filter((x) => x < 0.2).length / samples.length).toBeLessThan(0.005);
      // It decays back toward 1 over about an hour: the autocorrelation an hour apart is near 1/e.
      const m = mean(samples);
      let num = 0;
      for (let i = 60; i < samples.length; i++) num += (samples[i] - m) * (samples[i - 60] - m);
      const lagHour = num / samples.length / std(samples) ** 2;
      expect(lagHour, `at ${dt}s`).toBeGreaterThan(0.25);
      expect(lagHour, `at ${dt}s`).toBeLessThan(0.5);
    }
    for (const sd of sds) {
      expect(sd).toBeGreaterThan(0.5);
      expect(sd).toBeLessThan(0.9);
    }
    expect(sds[1] / sds[0]).toBeGreaterThan(0.9);
    expect(sds[1] / sds[0]).toBeLessThan(1.1);
  });
});

describe('simulated market settings', () => {
  // Statistics do not depend on the tick (tested above), so these run at fifteen seconds, which is faster.
  const config = { tickSeconds: 15 };
  const base = runMarket([1, 2, 3, 4], 30, config);
  const variance = (r: { stats: Map<string, RunStats> }) => mean(SIM_STOCKS.map((p) => annualVol(r.stats.get(p.symbol)!) ** 2));

  it('scales every move with the volatility setting', () => {
    const one = runMarket([7], 10, config).stats;
    const two = runMarket([7], 10, { ...config, volatilityMultiplier: 2 }).stats;
    for (const p of SIM_STOCKS) {
      expect(annualVol(two.get(p.symbol)!) / annualVol(one.get(p.symbol)!), p.symbol).toBeCloseTo(2, 1);
      // Minute returns too, less exactly: rounding to the cent adds a little noise of its own (MINR trades near $6).
      expect(intradayVol(two.get(p.symbol)!) / intradayVol(one.get(p.symbol)!), p.symbol).toBeGreaterThan(1.85);
      expect(intradayVol(two.get(p.symbol)!) / intradayVol(one.get(p.symbol)!), p.symbol).toBeLessThan(2.15);
    }
  });

  it('adds moves with more news and takes them away with none', { timeout: 30_000 }, () => {
    const none = runMarket([1, 2, 3, 4], 30, { ...config, eventFrequency: 0 });
    const lots = runMarket([1, 2, 3, 4], 30, { ...config, eventFrequency: 3 });
    expect(none.events).toBe(0);
    expect(lots.events).toBeGreaterThan(base.events * 2);
    // Without news a stock moves a little less than its profile, which counts news in; nothing pins it elsewhere.
    const quiet = SIM_STOCKS.map((p) => annualVol(none.stats.get(p.symbol)!) / p.annualVol);
    quiet.forEach((ratio, i) => {
      expect(ratio, SIM_STOCKS[i].symbol).toBeGreaterThan(0.65);
      expect(ratio, SIM_STOCKS[i].symbol).toBeLessThan(1.05);
    });
    expect(mean(quiet)).toBeLessThan(0.95);
    expect(variance(none)).toBeLessThan(variance(base) * 0.9);
    expect(variance(lots)).toBeGreaterThan(variance(base) * 1.25);
  });

  it('travels further each day with a stronger trend setting', { timeout: 30_000 }, () => {
    const flat = runMarket([1, 2, 3, 4], 30, { ...config, trendStrength: 0 });
    const strong = runMarket([1, 2, 3, 4], 30, { ...config, trendStrength: 2.5 });
    expect(variance(strong)).toBeGreaterThan(variance(base) * 1.3);
    expect(variance(flat)).toBeLessThan(variance(base));
  });
});

describe('market impact in the simulated market', () => {
  it('is the same however often prices tick: a minute of volume at the tick\'s pace, as against a 1-minute bar', () => {
    const t0 = exchangeTimeToUnix('2026-10-08', 10 * 60);
    const fillAt = (barSeconds: number) => {
      const broker = new SimBroker({ startingBalance: 1_000_000, config: { ...DEFAULT_EXECUTION_CONFIG, maxParticipation: 0 }, source: 'SIMULATED' });
      // The same pace of trading, 600 shares a second, in bars of 1 s, 5 s and a minute.
      broker.onBar('QBIT', { time: t0, open: 200, high: 200, low: 200, close: 200, volume: 600 * barSeconds }, barSeconds);
      expect(broker.submit({ symbol: 'QBIT', action: 'buy', type: 'market', quantity: 1800 }).ok).toBe(true);
      return broker.state.fills[0].price;
    };
    const minute = fillAt(60);
    expect(fillAt(1)).toBe(minute);
    expect(fillAt(5)).toBe(minute);
    // 1,800 of a minute's 36,000 shares is 5% of its volume: 1 bp of slippage plus 25 bps of impact, over the half spread.
    expect(minute).toBeLessThan(200 * 1.004);
  });
});

describe('the equity curve in the simulated market', () => {
  it('keeps one point a minute however often prices tick, at the end of each minute as 1-minute bars would', () => {
    const t0 = exchangeTimeToUnix('2026-10-08', 10 * 60);
    const broker = new SimBroker({ startingBalance: 100_000, config: DEFAULT_EXECUTION_CONFIG, source: 'SIMULATED' });
    const price = (k: number) => 200 + 0.01 * k;
    const tick = (k: number) => broker.onBar('QBIT', { time: t0 + k, open: price(k), high: price(k), low: price(k), close: price(k), volume: 1000 }, 1);
    tick(0);
    expect(broker.submit({ symbol: 'QBIT', action: 'buy', type: 'market', quantity: 100 }).ok).toBe(true);
    const atMinuteEnd: number[] = [];
    for (let k = 1; k < 180; k++) {
      tick(k);
      if (k % 60 === 59) atMinuteEnd.push(broker.account().equity);
    }
    expect(broker.state.fills).toHaveLength(1);
    expect(broker.state.equityCurve.map((p) => p.time)).toEqual([t0 + 60, t0 + 120, t0 + 180]);
    expect(broker.state.equityCurve.map((p) => p.equity)).toEqual(atMinuteEnd);
  });
});
