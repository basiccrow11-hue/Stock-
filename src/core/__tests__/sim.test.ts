import { describe, expect, it } from 'vitest';
import { SimMarket } from '../sim/SimMarket';
import { SimBroker } from '../broker/SimBroker';
import { ZERO_COST_CONFIG } from '../broker/config';
import { exchangeDate, marketSession } from '../time';

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
