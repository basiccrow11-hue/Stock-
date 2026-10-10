import { describe, expect, it } from 'vitest';
import { SimBroker } from '../broker/SimBroker';
import { DEFAULT_EXECUTION_CONFIG, ZERO_COST_CONFIG, type ExecutionConfig } from '../broker/config';
import { bar, et } from './helpers';
import { equityBeforeEntry, riskBasis } from '../analytics/stats';
import { CHALLENGES } from '../challenges/challenges';
import { DEFAULT_TRADING_RULES } from '../learning/review';

const D = '2025-01-15';
const S = 'TEST';

function setup(cfg: Partial<ExecutionConfig> = {}, balance = 100_000, startPrice = 100) {
  const broker = new SimBroker({ startingBalance: balance, config: { ...ZERO_COST_CONFIG, ...cfg }, idPrefix: 't' });
  broker.onBar(S, bar(et(D, '09:30'), startPrice, startPrice, startPrice, startPrice));
  let t = et(D, '09:31');
  const next = (o: number, h: number, l: number, c: number, v = 1_000_000) => {
    const fills = broker.onBar(S, bar(t, o, h, l, c, v));
    t += 60;
    return fills;
  };
  return { broker, next };
}

function identity(broker: SimBroker) {
  const a = broker.account();
  // Equity can be computed two ways; they must always agree.
  expect(a.equity).toBeCloseTo(a.startingBalance + a.realizedPnl + a.unrealizedPnl, 4);
  expect(a.equity).toBeCloseTo(a.cash + a.longMarketValue + a.shortMarketValue, 4);
}

describe('market orders', () => {
  it('fills immediately at the last price in last_price mode', () => {
    const { broker } = setup();
    const r = broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10 });
    expect(r.ok).toBe(true);
    expect(broker.state.fills).toHaveLength(1);
    expect(broker.state.fills[0].price).toBe(100);
    expect(broker.position(S).quantity).toBe(10);
    expect(broker.account().cash).toBe(99_000);
    identity(broker);
  });

  it('fills at the next bar open in next_bar_open mode, never at a stale price', () => {
    const { broker, next } = setup({ marketOrderFill: 'next_bar_open' });
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10 });
    expect(broker.state.fills).toHaveLength(0);
    next(101.5, 102, 101, 101.8);
    expect(broker.state.fills[0].price).toBe(101.5);
  });

  it('pays the spread and slippage on marketable orders', () => {
    const { broker } = setup({
      spread: { mode: 'cents', value: 0.04, minimum: 0, extendedHoursMultiplier: 1 },
      slippage: { bps: 10, impactBpsPerPctOfVolume: 0 },
      commission: { perShare: 0.005, perOrder: 0, minimumPerOrder: 1, maxPctOfValue: 0 },
    });
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 100 });
    const f = broker.state.fills[0];
    // ask = 100.02, +10bps slippage = 100.120002 -> rounded up to the tick
    expect(f.price).toBe(100.13);
    expect(f.commission).toBe(1); // 0.50 per-share fee raised to the $1 minimum
    expect(f.spreadCost).toBeCloseTo(2, 6);
    identity(broker);
  });

  it('queues market orders outside regular hours until the open', () => {
    const broker = new SimBroker({ startingBalance: 10_000, config: ZERO_COST_CONFIG });
    broker.onBar(S, bar(et(D, '09:00'), 50, 50, 50, 50));
    const r = broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10 });
    expect(r.ok).toBe(true);
    expect(r.order!.status).toBe('pending');
    broker.onBar(S, bar(et(D, '09:01'), 50, 51, 49, 50.5));
    expect(broker.state.fills).toHaveLength(0);
    broker.onBar(S, bar(et(D, '09:30'), 52, 53, 51, 52.5));
    expect(broker.state.fills[0].price).toBe(52);
  });
});

describe('limit orders', () => {
  it('rests until price reaches the limit and fills at the limit', () => {
    const { broker, next } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'limit', quantity: 10, limitPrice: 98 });
    next(100, 100.5, 98.5, 99);
    expect(broker.state.fills).toHaveLength(0);
    next(99, 99.2, 97.5, 98.8);
    expect(broker.state.fills).toHaveLength(1);
    expect(broker.state.fills[0].price).toBe(98);
  });

  it('fills at the better open price when the market gaps through the limit', () => {
    const { broker, next } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'limit', quantity: 10, limitPrice: 98 });
    next(96, 97, 95, 96.5);
    expect(broker.state.fills[0].price).toBe(96);
  });

  it('a buy limit needs the ASK to reach the limit (spread modelled)', () => {
    const { broker, next } = setup({ spread: { mode: 'cents', value: 0.1, minimum: 0, extendedHoursMultiplier: 1 } });
    broker.submit({ symbol: S, action: 'buy', type: 'limit', quantity: 10, limitPrice: 98 });
    next(99, 99, 97.96, 98.5); // low trade 97.96 -> ask 98.01 never <= 98
    expect(broker.state.fills).toHaveLength(0);
    next(98.5, 98.5, 97.9, 98); // low 97.90 -> ask 97.95
    expect(broker.state.fills[0].price).toBe(98);
  });

  it('trade-through mode requires price to trade beyond the limit', () => {
    const { broker, next } = setup({ limitFill: 'trade_through' });
    broker.submit({ symbol: S, action: 'buy', type: 'limit', quantity: 10, limitPrice: 98 });
    next(99, 99, 98, 98.5);
    expect(broker.state.fills).toHaveLength(0);
    next(98.5, 98.5, 97.98, 98.2);
    expect(broker.state.fills).toHaveLength(1);
  });

  it('fills a marketable limit immediately at the better market price', () => {
    const { broker } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'limit', quantity: 10, limitPrice: 105 });
    expect(broker.state.fills[0].price).toBe(100);
  });

  it('sell limits fill at the limit when price rises to it', () => {
    const { broker, next } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10 });
    broker.submit({ symbol: S, action: 'sell', type: 'limit', quantity: 10, limitPrice: 102 });
    next(100, 101.9, 99.5, 101);
    expect(broker.position(S).quantity).toBe(10);
    next(101, 102.4, 100.8, 102.2);
    expect(broker.position(S).quantity).toBe(0);
    expect(broker.state.fills[1].price).toBe(102);
    expect(broker.account().realizedPnl).toBe(20);
    identity(broker);
  });
});

describe('stop and stop-limit orders', () => {
  it('buy stop triggers at the stop price', () => {
    const { broker, next } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'stop', quantity: 10, stopPrice: 101 });
    next(100, 100.9, 99.8, 100.5);
    expect(broker.state.fills).toHaveLength(0);
    next(100.5, 101.6, 100.4, 101.4);
    expect(broker.state.fills[0].price).toBe(101);
  });

  it('a stop that gaps fills at the (worse) open, not the stop price', () => {
    const { broker, next } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10 });
    broker.submit({ symbol: S, action: 'sell', type: 'stop', quantity: 10, stopPrice: 98 });
    next(95, 96, 94, 95.5);
    expect(broker.state.fills[1].price).toBe(95);
    expect(broker.account().realizedPnl).toBe(-50);
  });

  it('stop-limit fills inside the limit after triggering', () => {
    const { broker, next } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'stop_limit', quantity: 10, stopPrice: 101, limitPrice: 101.2 });
    next(100.5, 101.5, 100.4, 101.3);
    expect(broker.state.fills[0].price).toBe(101);
  });

  it('stop-limit does not fill when price gaps past the limit, and then rests as a limit', () => {
    const { broker, next } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'stop_limit', quantity: 10, stopPrice: 101, limitPrice: 101.2 });
    next(102, 103, 101.8, 102.5);
    expect(broker.state.fills).toHaveLength(0);
    expect(broker.state.orders[0].triggered).toBe(true);
    next(102.5, 102.6, 101.1, 101.5);
    expect(broker.state.fills[0].price).toBe(101.2);
  });

  it('stops are not active outside regular hours', () => {
    const broker = new SimBroker({ startingBalance: 10_000, config: ZERO_COST_CONFIG });
    broker.onBar(S, bar(et(D, '15:59'), 100, 100, 100, 100));
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10 });
    broker.submit({ symbol: S, action: 'sell', type: 'stop', quantity: 10, stopPrice: 99, tif: 'gtc' });
    broker.onBar(S, bar(et(D, '16:05'), 98, 98, 97, 97.5));
    expect(broker.position(S).quantity).toBe(10);
    broker.onBar(S, bar(et('2025-01-16', '09:30'), 97, 97.5, 96, 96.5));
    expect(broker.position(S).quantity).toBe(0);
    expect(broker.state.fills[1].price).toBe(97);
  });
});

describe('positions and P/L', () => {
  it('tracks average cost when scaling in and realized P/L when scaling out', () => {
    const { broker, next } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 100 }); // @100
    next(102, 102, 102, 102);
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 100 }); // @102
    expect(broker.position(S).avgPrice).toBe(101);
    next(104, 104, 104, 104);
    expect(broker.account().unrealizedPnl).toBe(600);
    broker.submit({ symbol: S, action: 'sell', type: 'market', quantity: 50 }); // @104
    expect(broker.account().realizedPnl).toBe(150);
    expect(broker.position(S).avgPrice).toBe(101);
    identity(broker);
    broker.submit({ symbol: S, action: 'sell', type: 'market', quantity: 150 });
    expect(broker.account().realizedPnl).toBe(600);
    const trip = broker.state.roundTrips[0];
    expect(trip.closed).toBe(true);
    expect(trip.avgEntry).toBe(101);
    expect(trip.avgExit).toBe(104);
    expect(trip.pnl).toBe(600);
    expect(trip.maxQuantity).toBe(200);
    identity(broker);
  });

  it('short selling: profit when price falls, cash and equity consistent', () => {
    const { broker, next } = setup();
    const r = broker.submit({ symbol: S, action: 'short', type: 'market', quantity: 100 });
    expect(r.ok).toBe(true);
    expect(broker.position(S).quantity).toBe(-100);
    expect(broker.account().cash).toBe(110_000);
    next(95, 95, 95, 95);
    expect(broker.account().unrealizedPnl).toBe(500);
    expect(broker.account().equity).toBe(100_500);
    identity(broker);
    broker.submit({ symbol: S, action: 'cover', type: 'market', quantity: 100 });
    expect(broker.account().realizedPnl).toBe(500);
    expect(broker.state.roundTrips[0].direction).toBe('short');
    expect(broker.state.roundTrips[0].pnl).toBe(500);
    identity(broker);
  });

  it('short loses when price rises', () => {
    const { broker, next } = setup();
    broker.submit({ symbol: S, action: 'short', type: 'market', quantity: 10 });
    next(103, 103, 103, 103);
    broker.submit({ symbol: S, action: 'cover', type: 'market', quantity: 10 });
    expect(broker.account().realizedPnl).toBe(-30);
  });

  it('commissions reduce realized P/L and trip P/L', () => {
    const { broker, next } = setup({ commission: { perShare: 0, perOrder: 1, minimumPerOrder: 0, maxPctOfValue: 0 } });
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10 });
    next(101, 101, 101, 101);
    broker.submit({ symbol: S, action: 'sell', type: 'market', quantity: 10 });
    expect(broker.account().realizedPnl).toBe(8);
    expect(broker.state.roundTrips[0].pnl).toBe(8);
    expect(broker.account().commissionsPaid).toBe(2);
    identity(broker);
  });

  it('day P/L resets at the start of each trading day', () => {
    const { broker, next } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 100 });
    next(101, 101, 101, 101);
    expect(broker.account().dayPnl).toBe(100);
    broker.onBar(S, bar(et('2025-01-16', '09:30'), 102, 102, 102, 102));
    expect(broker.account().dayPnl).toBe(100); // 101 -> 102 on the new day
    expect(broker.account().equity).toBe(100_200);
  });

  it('equity identity holds across a random order sequence', () => {
    const { broker, next } = setup({ commission: { perShare: 0.01, perOrder: 0, minimumPerOrder: 0, maxPctOfValue: 0 }, spread: { mode: 'bps', value: 5, minimum: 0.01, extendedHoursMultiplier: 1 } });
    let price = 100;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 300; i++) {
      const o = price;
      price = Math.max(5, price + (rnd() - 0.5) * 2);
      next(o, Math.max(o, price) + 0.3, Math.min(o, price) - 0.3, price);
      const pos = broker.position(S).quantity;
      const q = 1 + Math.floor(rnd() * 20);
      const roll = rnd();
      if (pos === 0) broker.submit({ symbol: S, action: roll < 0.5 ? 'buy' : 'short', type: roll < 0.25 ? 'limit' : 'market', quantity: q, limitPrice: price - 0.2 });
      else if (pos > 0) broker.submit({ symbol: S, action: roll < 0.5 ? 'sell' : 'buy', type: 'market', quantity: roll < 0.5 ? Math.min(q, pos) : q });
      else broker.submit({ symbol: S, action: roll < 0.5 ? 'cover' : 'short', type: 'market', quantity: roll < 0.5 ? Math.min(q, -pos) : q });
      identity(broker);
    }
    const closedPnl = broker.state.roundTrips.filter((t) => t.closed).reduce((a, t) => a + t.pnl, 0);
    const openTrip = broker.state.roundTrips.find((t) => !t.closed);
    // Realized P/L = closed trips + realized part (incl. commissions) of any still-open trip.
    expect(broker.account().realizedPnl).toBeCloseTo(closedPnl + (openTrip?.pnl ?? 0), 4);
  });
});

describe('order validation', () => {
  it('rejects selling without a long position and buying while short', () => {
    const { broker } = setup();
    expect(broker.submit({ symbol: S, action: 'sell', type: 'market', quantity: 1 }).ok).toBe(false);
    expect(broker.submit({ symbol: S, action: 'cover', type: 'market', quantity: 1 }).ok).toBe(false);
    broker.submit({ symbol: S, action: 'short', type: 'market', quantity: 5 });
    const r = broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Cover/);
  });

  it('rejects shorting in a cash account', () => {
    const { broker } = setup({ marginMultiplier: 1 });
    expect(broker.submit({ symbol: S, action: 'short', type: 'market', quantity: 1 }).ok).toBe(false);
  });

  it('enforces buying power, including working orders', () => {
    const { broker } = setup({ marginMultiplier: 1 }, 10_000);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 101 }).ok).toBe(false);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', quantity: 60, limitPrice: 90 }).ok).toBe(true);
    // 60*90 = 5400 reserved; 50*100 = 5000 > 4600 remaining
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 50 }).ok).toBe(false);
  });

  it('does not allow selling more than is available after open exit orders', () => {
    const { broker } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10 });
    broker.submit({ symbol: S, action: 'sell', type: 'limit', quantity: 8, limitPrice: 110 });
    expect(broker.submit({ symbol: S, action: 'sell', type: 'market', quantity: 3 }).ok).toBe(false);
    expect(broker.submit({ symbol: S, action: 'sell', type: 'market', quantity: 2 }).ok).toBe(true);
  });

  it('rejects brackets on the wrong side of the entry', () => {
    const { broker } = setup();
    const r = broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10, stopLoss: 101 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/below the entry/);
  });

  it('rejects fractional and zero quantities', () => {
    const { broker } = setup();
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 0 }).ok).toBe(false);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 1.5 }).ok).toBe(false);
  });

  it('strict risk mode blocks oversized risk, warns otherwise', () => {
    const loose = setup();
    const w = loose.broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 500, stopLoss: 90.6 });
    expect(w.ok).toBe(true);
    expect(w.warnings.join(' ')).toMatch(/risks 4\.7% of your account/);

    const strict = setup({ strictRisk: { enabled: true, maxRiskPctPerTrade: 1, requireStopLoss: true, maxDailyLossPct: 3, maxPositionPctOfEquity: 100 } });
    expect(strict.broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 500, stopLoss: 90.6 }).ok).toBe(false);
    expect(strict.broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10 }).ok).toBe(false); // no stop
    expect(strict.broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 100, stopLoss: 99 }).ok).toBe(true);
  });

  it('estimates a fill with its spread, slippage, impact and tick rounding, and Strict Mode checks risk there', () => {
    // Default costs at 100: half spread 0.01, 1 bp slippage plus 5 bp per 1% of the bar's volume.
    const strictRisk = { enabled: true, maxRiskPctPerTrade: 1, requireStopLoss: true, maxDailyLossPct: 3, maxPositionPctOfEquity: 100 };
    const { broker, next } = setup({ ...DEFAULT_EXECUTION_CONFIG, strictRisk });
    next(100, 100, 100, 100, 50_000);
    const order = { symbol: S, action: 'buy' as const, type: 'market' as const, quantity: 500 };
    // 500 of 50,000 shares = 1% of the bar: 6 bp in all on the 100.01 ask is 100.070006, rounded up to 100.08.
    expect(broker.estimateFill(order)).toBe(100.08);
    expect(broker.estimateFill({ ...order, action: 'short' })).toBe(99.93);
    expect(broker.estimateFill({ ...order, type: 'stop', stopPrice: 101 })).toBe(101.08);
    expect(broker.estimateFill({ ...order, type: 'limit', limitPrice: 99.5 })).toBe(99.5);
    // At the quote, 500 shares with a stop at 98.01 risk $1000 = 1%; at the fill they would risk $1035.
    expect(broker.submit({ ...order, stopLoss: 98.01 }).error).toMatch(/^Strict risk: this trade risks 1\.0[34]% \(limit 1%\)\.$/);
    // Sized at the estimate (483 shares take less of the bar, so 100.07), the order passes and fills there.
    expect(broker.estimateFill({ ...order, quantity: 483 })).toBe(100.07);
    expect(483 * (100.07 - 98.01)).toBeLessThanOrEqual(1000);
    expect(broker.submit({ ...order, quantity: 483, stopLoss: 98.01 }).ok).toBe(true);
    expect(broker.state.fills.at(-1)!.price).toBe(100.07);
  });

  it('estimates market and stop orders at the regular spread they fill at, and at the time the order is placed', () => {
    const strictRisk = { enabled: true, maxRiskPctPerTrade: 1, requireStopLoss: true, maxDailyLossPct: 3, maxPositionPctOfEquity: 100 };
    const broker = new SimBroker({ startingBalance: 100_000, config: { ...DEFAULT_EXECUTION_CONFIG, strictRisk }, idPrefix: 't' });
    // Regular-hours data: the day's last bar, then the replay's clock at the next day's 09:30 open.
    broker.onBar(S, bar(et('2025-01-14', '15:59'), 100, 100, 100, 100, 1_000_000));
    const now = et('2025-01-15', '09:30');
    const order = { symbol: S, action: 'buy' as const, type: 'market' as const, quantity: 980 };
    // 100 + 0.01 half spread, + 1 bp slippage and 0.49 bp impact: the same before and after the clock moves on.
    expect(broker.estimateFill(order)).toBe(100.03);
    expect(broker.estimateFill(order, now)).toBe(100.03);
    expect(broker.estimateFill({ ...order, type: 'stop', stopPrice: 100.5 }, now)).toBe(100.53);
    // Sized to 1% at that estimate (980 x 1.02 = $999.60 + no commission), Strict Mode accepts it once the clock has moved on, and it fills there.
    broker.syncClock(now);
    expect(broker.submit({ ...order, stopLoss: 99.01 }).ok).toBe(true);
    broker.onBar(S, bar(now, 100, 100, 100, 100, 1_000_000));
    expect(broker.state.fills.at(-1)!.price).toBe(100.03);
    // An extended-hours limit can trade outside the regular session, at its own price.
    expect(broker.estimateFill({ ...order, type: 'limit', limitPrice: 99.9, extendedHours: true }, now)).toBe(99.9);
  });
});

describe('Strict Mode and buying power judge the whole trade, placed or changed', () => {
  const strict = (o: Partial<ExecutionConfig['strictRisk']> = {}): Partial<ExecutionConfig> => ({
    strictRisk: { enabled: true, maxRiskPctPerTrade: 1, requireStopLoss: true, maxDailyLossPct: 3, maxPositionPctOfEquity: 100, ...o },
  });
  /** Turns Strict Mode on or off mid-session, as the Settings page does. */
  const strictOn = (broker: SimBroker, enabled: boolean) => {
    broker.cfg = { ...broker.cfg, strictRisk: { ...broker.cfg.strictRisk, enabled } };
  };
  /** A closed trade's risk as the trade review and the challenges measure it, in % of the equity it started with. */
  const reviewed = (broker: SimBroker, i = 0) => {
    const st = broker.state;
    const t = st.roundTrips[i];
    const basis = riskBasis(t)!;
    return { pct: ((basis.risk * t.maxQuantity) / equityBeforeEntry(t, st.fills, st.equityCurve, st.startingBalance)) * 100, from: basis.from };
  };

  it('checks a changed entry price as if the order were placed there', () => {
    const { broker } = setup(strict());
    // 250 at 90 with a stop at 87 risks $750 (0.75%); at 99.50 it would risk $3,125.
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 90, quantity: 250, stopLoss: 87 }).ok).toBe(true);
    const id = broker.state.orders[0].id;
    // Placed beside it with the same stop, the same order at 99.50 counts the first one's risk too.
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 99.5, quantity: 250, stopLoss: 87 })).toMatchObject({
      ok: false,
      error: "Strict risk: with this order the TEST trade would risk 3.88% (limit 1%), counting 250 shares in working entries, every share from the trade's first stop at 87.00, as the trade review counts it.",
    });
    expect(broker.modify(id, { limitPrice: 99.5 })).toEqual({ ok: false, error: 'Strict risk: this trade risks 3.13% (limit 1%).' });
    expect(broker.state.orders[0].limitPrice).toBe(90);
    expect(broker.modify(id, { limitPrice: 89 })).toEqual({ ok: true });
  });

  it("lets a cash account change an entry only within its buying power, counting what the order already holds back", () => {
    const { broker } = setup({ marginMultiplier: 1 }, 10_000);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 55, quantity: 180 }).ok).toBe(true);
    expect(broker.affordableQuantity({ symbol: S, action: 'buy', type: 'market' })).toBe(1);
    const id = broker.state.orders[0].id;
    expect(broker.modify(id, { limitPrice: 100.1 })).toEqual({ ok: false, error: 'Insufficient buying power: need $18018.00, have $10000.00.' });
    expect(broker.modify(id, { quantity: 200 })).toEqual({ ok: false, error: 'Insufficient buying power: need $11000.00, have $10000.00.' });
    // 180 x 55.50 = $9,990 fits in the $10,000, the $9,900 the order held back included.
    expect(broker.modify(id, { limitPrice: 55.5 })).toEqual({ ok: true });
    expect(broker.account().cash).toBe(10_000);
    expect(broker.affordableQuantity({ symbol: S, action: 'buy', type: 'limit', limitPrice: 0.5 })).toBe(20);
  });

  it('counts the shares already held or working toward the position limit', () => {
    const { broker } = setup(strict({ maxPositionPctOfEquity: 25 }));
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 200, stopLoss: 98 }).ok).toBe(true);
    expect(broker.position(S).quantity).toBe(200);
    // 200 held at 100 are 20% of equity, so another 100 would make the position 30%.
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 100, stopLoss: 98 })).toMatchObject({
      ok: false,
      error: 'Strict risk: position is 30% of equity with the 200 TEST shares you already hold or have working (limit 25%).',
    });
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 99, quantity: 50, stopLoss: 98 }).ok).toBe(true);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 2, stopLoss: 98 })).toMatchObject({
      ok: false,
      error: 'Strict risk: position is 25.1% of equity with the 250 TEST shares you already hold or have working (limit 25%).',
    });
  });

  it('makes entries working before a position opens share one stop loss, and counts them together from it', () => {
    const { broker, next } = setup(strict());
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 90, quantity: 100, stopLoss: 87 }).ok).toBe(true);
    const lead = "Strict risk: with no TEST position yet, Buy entries working together must share one stop loss, so the trade's risk is measured from it whichever fills first.";
    expect(broker.submit({ symbol: S, action: 'buy', type: 'stop', stopPrice: 101, quantity: 50, stopLoss: 99 })).toMatchObject({
      ok: false,
      error: `${lead} Your working BUY 100 TEST LMT 90.00 has its stop at 87.00: use 87.00 here too, or cancel that order.`,
    });
    // Sharing it, the two risk 100 x 3 + 50 x 14 = $1,000 from it together: 1%.
    expect(broker.submit({ symbol: S, action: 'buy', type: 'stop', stopPrice: 101, quantity: 50, stopLoss: 87 }).ok).toBe(true);
    expect(broker.tradeRisk({ symbol: S, action: 'buy', type: 'limit', limitPrice: 90, quantity: 1, stopLoss: 87 })).toMatchObject({ stop: 87, held: 0, working: 150, by: 'review' });
    // The short side is a trade of its own.
    expect(broker.submit({ symbol: S, action: 'short', type: 'limit', limitPrice: 105, quantity: 100, stopLoss: 106 }).ok).toBe(true);
    // Entries placed while Strict Mode was off are named when they disagree.
    strictOn(broker, false);
    const odd = broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 92, quantity: 10, stopLoss: 86 }).order!;
    strictOn(broker, true);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 91, quantity: 1, stopLoss: 87 })).toMatchObject({
      ok: false,
      error: `${lead} Your working BUY 100 TEST LMT 90.00 and BUY 10 TEST LMT 92.00 have different stops (87.00 and 86.00): cancel one of them first.`,
    });
    broker.cancel(odd.id);
    // Once the first fills, its stop is the trade's first stop, and an add's own tighter stop does not
    // shrink what it adds: 100 x 3 + 50 x 14 + 10 x 4 = $1,040.
    next(95, 95, 90, 91);
    expect(broker.position(S).quantity).toBe(100);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 91, quantity: 10, stopLoss: 88 })).toMatchObject({
      ok: false,
      error: "Strict risk: with this order the TEST trade would risk 1.04% (limit 1%), counting the 100 shares you hold and 50 shares in working entries, every share from the trade's first stop at 87.00, as the trade review counts it. This order's tighter stop at 88.00 does not change this: the review counts every share from the first stop.",
    });
  });

  it('holds the line at the first stop: no adds at or past it, no stops past it, and every share covered', () => {
    const { broker } = setup(strict());
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 300, stopLoss: 98 }).ok).toBe(true);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 99, quantity: 300, stopLoss: 97 })).toMatchObject({
      ok: false,
      error: "Strict risk: this order's stop at 97.00 is below the trade's first stop at 98.00. Every share is measured from 98.00, so use a stop at 98.00 or higher.",
    });
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 98, quantity: 10, stopLoss: 97.5 })).toMatchObject({
      ok: false,
      error: "Strict risk: this order would fill at about 98.00, at or below the trade's first stop at 98.00, which would add past that stop. To re-enter after a stop-out, place the order once the trade has closed.",
    });
    // Every share from 98: 300 x 2 + 500 x 1 = $1,100.
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 99, quantity: 500, stopLoss: 98 })).toMatchObject({
      ok: false,
      error: "Strict risk: with this order the TEST trade would risk 1.10% (limit 1%), counting the 300 shares you hold, every share from the trade's first stop at 98.00, as the trade review counts it.",
    });
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 99, quantity: 400, stopLoss: 98.5 }).ok).toBe(true);
    // An exit stop can be tightened, and moved back toward the first stop, but not past it.
    const stop = broker.state.orders.find((o) => o.parentId && o.type === 'stop')!;
    const past = "Strict risk: a stop on this trade can't go below its first stop at 98.00 (anything from 98.00 up is fine).";
    expect(broker.modify(stop.id, { stopPrice: 97.9 })).toEqual({ ok: false, error: past });
    expect(broker.modify(stop.id, { stopPrice: 99.5 })).toEqual({ ok: true });
    // Raised, it still makes no room: the trade is counted from 98, $1,002 with one more share.
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 1, stopLoss: 98 })).toMatchObject({
      ok: false,
      error: "Strict risk: with this order the TEST trade would risk 1.002% (limit 1%), counting the 300 shares you hold and 400 shares in working entries, every share from the trade's first stop at 98.00, as the trade review counts it. Raising your stop does not change this: the review counts every share from the first stop.",
    });
    expect(broker.modify(stop.id, { stopPrice: 98.5 })).toEqual({ ok: true });
    // Held shares need a stop before an add, and a stop placed on its own can't go past the first stop either.
    broker.cancel(stop.id);
    const bare = 'Strict risk: your 300 TEST shares have no stop. Place a Sell stop for them (at 98.00 or higher) before adding.';
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 1, stopLoss: 98 })).toMatchObject({ ok: false, error: bare });
    expect(broker.submit({ symbol: S, action: 'sell', type: 'stop', stopPrice: 97.9, quantity: 300 })).toMatchObject({ ok: false, error: past });
    // A stop-limit whose limit is above its stop may never fill once price is through it, so it does not count.
    const loose = broker.submit({ symbol: S, action: 'sell', type: 'stop_limit', stopPrice: 98, limitPrice: 98.5, quantity: 300 }).order!;
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 1, stopLoss: 98 })).toMatchObject({ ok: false, error: bare });
    broker.cancel(loose.id);
    expect(broker.submit({ symbol: S, action: 'sell', type: 'stop', stopPrice: 98, quantity: 200 }).ok).toBe(true);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 1, stopLoss: 98 })).toMatchObject({
      ok: false,
      error: 'Strict risk: 100 of your 300 TEST shares have no stop. Place a Sell stop for them (at 98.00 or higher) before adding.',
    });
  });

  it('names a working entry that sits at or past the first stop, or has no stop or a wider one', () => {
    const { broker } = setup(strict());
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 100, stopLoss: 98 }).ok).toBe(true);
    const add = { symbol: S, action: 'buy' as const, type: 'market' as const, quantity: 10, stopLoss: 98 };
    for (const [stale, why] of [
      [{ limitPrice: 97.5, stopLoss: 97 }, "BUY 10 TEST LMT 97.50 would fill at or below the trade's first stop at 98.00, and Strict Mode measures every share from that stop. Cancel it first."],
      [{ limitPrice: 99, stopLoss: 97 }, "BUY 10 TEST LMT 99.00 has its stop below the trade's first stop at 98.00, and Strict Mode measures every share from that stop. Cancel it first."],
      [{ limitPrice: 99 }, 'BUY 10 TEST LMT 99.00 has no stop loss. Cancel it and place it again with one first.'],
    ] as const) {
      strictOn(broker, false);
      const o = broker.submit({ symbol: S, action: 'buy', type: 'limit', quantity: 10, ...stale }).order!;
      strictOn(broker, true);
      expect(broker.submit(add)).toMatchObject({ ok: false, error: `Strict risk: your working ${why}` });
      broker.cancel(o.id);
    }
    expect(broker.submit(add).ok).toBe(true);
  });

  it('counts the trade at its worst over which working entries fill, so a cheap entry makes no room for a dear one', () => {
    const { broker, next } = setup(strict(), 10_000, 10);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 100, stopLoss: 9.6, takeProfit: 10.5 }).ok).toBe(true);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 100, stopLoss: 9.6 }).ok).toBe(true);
    // The first entry's target takes 100 off: the trade's largest size stays 200 at an average of 10.
    next(10, 10.55, 10, 10.5);
    expect(broker.position(S).quantity).toBe(100);
    const dear = { symbol: S, action: 'buy' as const, type: 'stop' as const, stopPrice: 10.8, quantity: 50, stopLoss: 9.6 };
    // 50 more at 10.80 make the average 10.16: 200 x 0.56 = $112 from the first stop.
    const refused = "Strict risk: with this order the TEST trade would risk 1.12% (limit 1%), counting the 100 shares you hold";
    // Sold down to 100, the review still counts the trade at its largest size, and says so.
    expect(broker.submit(dear).error).toBe(
      "Strict risk: with this order the TEST trade would risk 1.12% (limit 1%). The trade review counts the trade at its largest size, 200 shares (you hold 100 shares now), from its average entry to its first stop at 9.60, and this order raises that average.",
    );
    // A cheap entry at 9.70 would pull the average down only if it filled, so it changes nothing.
    const cheap = broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 9.7, quantity: 50, stopLoss: 9.6 }).order!;
    expect(broker.submit(dear).error).toBe(`${refused} and 50 shares in working entries, every share from the trade's first stop at 9.60, as the trade review counts it.`);
    // Size by risk finds what fits whichever fills: 200 x (80 + 28 x 1.20) / 228 = $99.65.
    const sized = broker.sizeByRisk({ symbol: S, action: 'buy', type: 'stop', stopPrice: 10.8, stopLoss: 9.6 }, 1);
    expect(sized).toMatchObject({ ok: true, quantity: 28, needed: 28 });
    if (!sized.ok) return;
    expect(sized.risk.pct).toBeCloseTo(0.9965, 4);
    expect(broker.submit({ ...dear, quantity: 28 }).ok).toBe(true);
    // The cheap one is cancelled and the dear one fills: the review measures what Strict Mode allowed.
    broker.cancel(cheap.id);
    next(10.5, 10.9, 10.5, 10.85);
    next(10.85, 10.85, 9.5, 9.55);
    expect(broker.state.roundTrips[0]).toMatchObject({ closed: true, maxQuantity: 200 });
    const r = reviewed(broker);
    expect(r.from).toBe('average');
    expect(r.pct).toBeCloseTo(0.9965, 4);
  });

  it("counts what the trade would lose at its first stop, so buying back after selling most of it can't hide risk", () => {
    const { broker, next } = setup(strict(), 10_000, 10);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 50, stopLoss: 9 }).ok).toBe(true);
    const stop = broker.state.orders.find((o) => o.parentId && o.type === 'stop')!;
    expect(broker.modify(stop.id, { quantity: 1 })).toEqual({ ok: true });
    next(10, 10.01, 10, 10.01);
    expect(broker.submit({ symbol: S, action: 'sell', type: 'market', quantity: 49 }).ok).toBe(true);
    next(10.01, 12, 10.01, 12);
    // The review would count 50 x (10.99 - 9) = $99.49, under 1%; but 1 share from 10 and 49 from 12
    // stand to lose $1 + $147 at 9, less the $0.49 made so far.
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 49, stopLoss: 9 })).toMatchObject({
      ok: false,
      error: 'Strict risk: with this order the TEST trade would lose 1.48% if its stops fired at its first stop at 9.00, counting the 1 share you hold and what the trade has already made or lost (limit 1%).',
    });
    const sized = broker.sizeByRisk({ symbol: S, action: 'buy', type: 'market', stopLoss: 9 }, 1);
    expect(sized).toMatchObject({ ok: true, quantity: 33, needed: 33, risk: { by: 'loss', stop: 9, held: 1, working: 0 } });
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 33, stopLoss: 9 }).ok).toBe(true);
    next(12, 12, 8.9, 8.95);
    const trip = broker.state.roundTrips[0];
    expect(trip.closed).toBe(true);
    // Stopped out at 9: $99.51 lost, within the 1% of the $10,000 it started with.
    expect(trip.pnl).toBeCloseTo(-99.51, 6);
    expect(reviewed(broker).pct).toBeLessThan(1);
  });

  it('fills exits before entries at the same price, so a gap closes the trade before a resting add', () => {
    const { broker, next } = setup(strict(), 10_000, 10);
    const gtc = { symbol: S, action: 'buy' as const, tif: 'gtc' as const, stopLoss: 9.5 };
    expect(broker.submit({ ...gtc, type: 'market', quantity: 100 }).ok).toBe(true);
    expect(broker.submit({ ...gtc, type: 'limit', limitPrice: 9.6, quantity: 100 }).ok).toBe(true);
    const a2 = broker.submit({ ...gtc, type: 'limit', limitPrice: 9.55, quantity: 200 }).order!;
    // A dip fills the first add, whose stop then sits behind the second add in the book.
    next(10, 10, 9.58, 9.7);
    expect(broker.position(S).quantity).toBe(200);
    // The gap triggers everything at the open: both stops close the trade first, at its stops, and the
    // add, measured as part of that trade, goes with it instead of opening a new one past its stop.
    next(9, 9.1, 8.9, 9);
    expect(broker.state.fills.filter((f) => f.time === et(D, '09:32')).map((f) => [f.side, f.quantity])).toEqual([
      ['sell', 100],
      ['sell', 100],
    ]);
    expect(broker.state.orders.find((o) => o.id === a2.id)).toMatchObject({
      status: 'cancelled',
      conflict: true,
      rejectReason: 'Strict Mode: it was measured as part of the TEST trade that closed. Place it again to check it as a new trade.',
    });
    expect(broker.state.roundTrips).toHaveLength(1);
    expect(reviewed(broker)).toMatchObject({ from: 'average' });
    expect(reviewed(broker).pct).toBeCloseTo(0.6, 9);
  });

  it("cancels the entries still working on a trade's side when it closes, so they can't open a trade nobody checked", () => {
    const { broker, next } = setup(strict(), 10_000, 49.2);
    // A trade that bought near its stop and sold higher again and again: 10 rounds of 49 shares made $392,
    // and its average entry stays 0.20 above the stop at 49.
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 50, stopLoss: 49 }).ok).toBe(true);
    for (let i = 0; i < 10; i++) {
      next(50, 50, 50, 50);
      for (const o of broker.workingOrders(S)) if (o.action === 'sell') broker.cancel(o.id);
      expect(broker.submit({ symbol: S, action: 'sell', type: 'market', quantity: 49 }).ok).toBe(true);
      expect(broker.submit({ symbol: S, action: 'sell', type: 'stop', stopPrice: 49, quantity: 1, tif: 'gtc' }).ok).toBe(true);
      next(49.2, 49.2, 49.2, 49.2);
      expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 49, stopLoss: 49 }).ok).toBe(true);
    }
    expect(broker.state.roundTrips[0]).toMatchObject({ entryQtyTotal: 540, maxQuantity: 50, pnl: 392 });
    // As part of this trade, 67 more at 55 fit the 1% limit (the review would count 0.98%) ...
    const add = { symbol: S, action: 'buy' as const, type: 'stop' as const, stopPrice: 55, stopLoss: 49, tif: 'gtc' as const };
    expect(broker.sizeByRisk(add, 1)).toMatchObject({ ok: true, quantity: 67 });
    const o = broker.submit({ ...add, quantity: 67 }).order!;
    // ... but on their own, once the trade has closed, they would risk 67 x 6 = $402, 3.9%.
    next(49.2, 49.2, 48.95, 49);
    expect(broker.state.roundTrips[0].closed).toBe(true);
    expect(broker.state.orders.find((x) => x.id === o.id)).toMatchObject({ status: 'cancelled', conflict: true });
    next(49, 55.5, 49, 55.5);
    expect(broker.state.roundTrips).toHaveLength(1);
  });

  it('after the daily loss limit, cancels working entries instead of filling them; they can only be cut or cancelled', () => {
    const { broker, next } = setup(strict({ maxDailyLossPct: 0.5 }));
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 98, quantity: 200, stopLoss: 97 }).ok).toBe(true);
    const id = broker.state.orders[0].id;
    // A $500 stop-out on a short reaches the 0.5% daily loss limit.
    expect(broker.submit({ symbol: S, action: 'short', type: 'market', quantity: 500, stopLoss: 101 }).ok).toBe(true);
    next(100.5, 101.2, 100.4, 101.1);
    expect(broker.position(S).quantity).toBe(0);
    expect(broker.modify(id, { limitPrice: 97.5 })).toEqual({
      ok: false,
      error: "Strict risk: daily loss limit of 0.5% reached, so working entries can't be changed until the next session. You can still cancel this one.",
    });
    expect(broker.modify(id, { quantity: 100 })).toEqual({ ok: true });
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10, stopLoss: 97 })).toMatchObject({
      ok: false,
      error: 'Strict risk: daily loss limit of 0.5% reached. No new entries or adds until the next session.',
    });
    next(101, 101, 97.9, 98);
    expect(broker.state.orders.find((o) => o.id === id)).toMatchObject({ status: 'cancelled', filledQty: 0, rejectReason: 'Strict Mode: the 0.5% daily loss limit was reached.', conflict: true });
    expect(broker.position(S).quantity).toBe(0);
    // The next session starts again.
    broker.onBar(S, bar(et('2025-01-16', '09:30'), 98, 98, 98, 98));
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10, stopLoss: 97 }).ok).toBe(true);
  });

  it('always lets a working entry be cut back, even once price is past its stop loss', () => {
    // A buy stop that fired and is filling in parts under the volume cap.
    const { broker, next } = setup({ maxParticipation: 0.25 });
    expect(broker.submit({ symbol: S, action: 'buy', type: 'stop', stopPrice: 100.5, quantity: 400, stopLoss: 99.5 }).ok).toBe(true);
    const id = broker.state.orders[0].id;
    next(100.6, 100.6, 100.4, 100.5, 400);
    next(99.4, 99.4, 99.3, 99.3, 4);
    const entry = broker.state.orders[0];
    expect(entry).toMatchObject({ triggered: true, status: 'partially_filled' });
    // Price is below the 99.50 stop loss, so the order cannot grow, but it can be cut back.
    expect(broker.modify(id, { quantity: 500 })).toEqual({ ok: false, error: expect.stringContaining('Stop loss must be below the entry price') });
    expect(broker.modify(id, { quantity: entry.filledQty + 50 })).toEqual({ ok: true });
  });

  it("measures a partly filled entry's later shares from the trade's first stop, wherever its bracket stop has moved", () => {
    const { broker, next } = setup({ ...strict(), maxParticipation: 0.25 }, 1_000_000, 101);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 100, quantity: 4500, stopLoss: 98, takeProfit: 106 }).ok).toBe(true);
    const id = broker.state.orders[0].id;
    next(100.5, 100.5, 99.9, 100.4, 2000);
    next(100.4, 103.2, 100.4, 103);
    expect(broker.state.orders[0].filledQty).toBe(500);
    const stop = broker.state.orders.find((o) => o.parentId === id && o.type === 'stop')!;
    expect(broker.modify(stop.id, { stopPrice: 100.5 })).toEqual({ ok: true });
    expect(broker.modify(stop.id, { stopPrice: 97 })).toEqual({ ok: false, error: "Strict risk: a stop on this trade can't go below its first stop at 98.00 (anything from 98.00 up is fine)." });
    // The 4,000 still to come count from 98 too: with 3,000 more, 7,500 x 2 = $15,000.
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 100, quantity: 3000, stopLoss: 98 })).toMatchObject({
      ok: false,
      error: "Strict risk: with this order the TEST trade would risk 1.50% (limit 1%), counting the 500 shares you hold and 4000 shares in working entries, every share from the trade's first stop at 98.00, as the trade review counts it. Raising your stop does not change this: the review counts every share from the first stop.",
    });
    // The entry itself can still be changed within the limit: 500 x 2 + 4,000 x 2.20 = $9,800.
    expect(broker.modify(id, { limitPrice: 100.2 })).toEqual({ ok: true });
    expect(broker.modify(id, { limitPrice: 100.3 })).toMatchObject({ ok: false, error: expect.stringContaining('would risk 1.02%') });
    expect(broker.modify(id, { limitPrice: 99.5, quantity: 4000 })).toEqual({ ok: true });
  });

  it("measures an add from the first stop, as the review and the challenges do", () => {
    const { broker, next } = setup(strict(), 10_000);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 25, stopLoss: 98 }).ok).toBe(true);
    next(100, 104, 100, 104);
    const stop = broker.state.orders.find((o) => o.type === 'stop')!;
    expect(broker.modify(stop.id, { stopPrice: 100 })).toEqual({ ok: true });
    // To its own stop the add risks 0.96%, but from the first stop at 98 the review counts
    // 25 x 2 + 48 x 6 = $338: 3.38%.
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 48, stopLoss: 102 })).toMatchObject({
      ok: false,
      error: "Strict risk: with this order the TEST trade would risk 3.38% (limit 1%), counting the 25 shares you hold, every share from the trade's first stop at 98.00, as the trade review counts it. This order's tighter stop at 102.00 does not change this: the review counts every share from the first stop.",
    });
    // 8 shares: 25 x 2 + 8 x 6 = $98, within 1%.
    expect(broker.tradeRisk({ symbol: S, action: 'buy', type: 'market', quantity: 8, stopLoss: 102 })).toMatchObject({ stop: 98, held: 25, working: 0, equity: 10_000 });
    expect(broker.tradeRisk({ symbol: S, action: 'buy', type: 'market', quantity: 8, stopLoss: 102 })!.pct).toBeCloseTo(0.98, 9);
    expect(broker.sizeByRisk({ symbol: S, action: 'buy', type: 'market', stopLoss: 102 }, 1)).toMatchObject({ ok: true, quantity: 8, needed: 8 });
    expect(broker.sizeByRisk({ symbol: S, action: 'buy', type: 'market', stopLoss: 102 }, 0.4)).toEqual({
      ok: false,
      error: 'With even one more share the TEST trade would risk 0.56% from its first stop at 98.00, more than the 0.4% asked.',
    });
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 8, stopLoss: 102 }).ok).toBe(true);
  });

  it('says what cut a size below the risk asked for', () => {
    const { broker } = setup(strict({ maxPositionPctOfEquity: 25 }));
    // 1% at a stop 1.00 away would need 1,000 shares; the position limit allows 250.
    expect(broker.sizeByRisk({ symbol: S, action: 'buy', type: 'market', stopLoss: 99 }, 1)).toMatchObject({
      ok: true,
      quantity: 250,
      needed: 1000,
      reason: 'Strict Mode refuses 251: position is 25.1% of equity (limit 25%).',
    });
    const cash = setup({ marginMultiplier: 1 }, 10_000).broker;
    // A limit order may fill anywhere up to its price, which the buying power covers exactly ...
    expect(cash.sizeByRisk({ symbol: S, action: 'buy', type: 'limit', limitPrice: 100, stopLoss: 99.9 }, 1)).toMatchObject({
      ok: true,
      quantity: 100,
      needed: 1000,
      reason: '101 would be refused: Insufficient buying power: need $10100.00, have $10000.00.',
    });
    // ... while a market order keeps a little back for the price to move before it fills.
    expect(cash.sizeByRisk({ symbol: S, action: 'buy', type: 'market', stopLoss: 99.9 }, 1)).toMatchObject({
      ok: true,
      quantity: 99,
      reason: 'Your available buying power covers 99, with room for the price to move before it fills.',
    });
  });

  it('ignores a price the order type does not use, so it cannot stand in for the entry', () => {
    const { broker } = setup(strict(), 100_000);
    // A buy stop at 101 with a stray limit price: 900 shares risk $900 to the stop loss at 100.
    expect(broker.submit({ symbol: S, action: 'buy', type: 'stop', stopPrice: 101, limitPrice: 99, quantity: 900, stopLoss: 100 }).ok).toBe(true);
    const entry = broker.workingOrders(S)[0];
    expect(entry.limitPrice).toBeUndefined();
    // Raising the stop to 101.20 puts $1,080 at risk: a changed entry is checked like a new one.
    expect(broker.modify(entry.id, { stopPrice: 101.2 })).toEqual({ ok: false, error: 'Strict risk: this trade risks 1.08% (limit 1%).' });
  });

  it("measures an add against the equity the trade started with, as the review does", () => {
    const { broker, next } = setup(strict(), 10_000);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 50, stopLoss: 99 }).ok).toBe(true);
    next(100, 150, 100, 150);
    expect(broker.account().equity).toBe(12_500);
    // 50 held risk $50 to the first stop and one more share at 150 another $51: $101 is 1.01% of the
    // $10,000 the trade started with (0.81% of today's $12,500).
    expect(broker.tradeRisk({ symbol: S, action: 'buy', type: 'market', quantity: 1, stopLoss: 99 })).toMatchObject({ equity: 10_000, dollars: 101 });
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 1, stopLoss: 99 })).toMatchObject({
      ok: false,
      error: "Strict risk: with this order the TEST trade would risk 1.01% (limit 1%), counting the 50 shares you hold, every share from the trade's first stop at 99.00, as the trade review counts it.",
    });
  });

  it('sizes by risk at the time the order would be placed, from its stop on the tick, without changing the account', () => {
    const broker = new SimBroker({ startingBalance: 100_000, config: { ...ZERO_COST_CONFIG, ...strict({ maxDailyLossPct: 0.5 }) }, idPrefix: 't' });
    broker.onBar(S, bar(et('2025-01-14', '15:50'), 100, 100, 100, 100));
    const day = broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 95, quantity: 100, stopLoss: 94 }).order!;
    expect(broker.submit({ symbol: S, action: 'short', type: 'market', quantity: 900, stopLoss: 101 }).ok).toBe(true);
    broker.onBar(S, bar(et('2025-01-14', '15:51'), 100, 101.5, 100, 101.2));
    expect(broker.account().equity).toBe(99_100);
    const req = { symbol: S, action: 'buy' as const, type: 'limit' as const, limitPrice: 100, stopLoss: 99 };
    // Today the daily loss limit is reached.
    expect(broker.sizeByRisk(req, 1)).toMatchObject({ ok: false, error: expect.stringContaining('daily loss limit of 0.5% reached') });
    // At the next morning's clock the day starts again and yesterday's DAY entry, whose stop at 94 would
    // not match, has expired: $991 is 1% of $99,100.
    const before = JSON.stringify(broker.state);
    const now = et('2025-01-15', '09:00');
    expect(broker.sizeByRisk(req, 1, now)).toMatchObject({ ok: true, quantity: 991, needed: 991 });
    expect(broker.tradeRisk({ ...req, quantity: 991 }, now)).toMatchObject({ held: 0, working: 0, stop: 99 });
    expect(JSON.stringify(broker.state)).toBe(before);
    expect(broker.workingOrders(S).map((o) => o.id)).toEqual([day.id]);
    // A stop loss off the tick is sized from where submit puts it: 98.004 is 98.00, 2.00 a share.
    broker.syncClock(now);
    broker.onBar(S, bar(et('2025-01-15', '09:30'), 100, 100, 100, 100));
    expect(broker.sizeByRisk({ symbol: S, action: 'buy', type: 'market', stopLoss: 98.004 }, 1)).toMatchObject({ ok: true, quantity: 495, risk: { stop: 98 } });
  });

  it('never approves a trade that the review or the 1% challenge then fails (random gapless sessions)', () => {
    const challenge = CHALLENGES.find((c) => c.id === 'grow-20-1pct')!;
    let trades = 0;
    let refused = 0;
    let sized = 0;
    for (let seed = 1; seed <= 200; seed++) {
      let s = seed * 7919;
      const rand = () => {
        s = (s * 1664525 + 1013904223) % 4294967296;
        return s / 4294967296;
      };
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
      // One side per session: a long and a short trade can't both be open, and an entry on the other side
      // would be measured against equity the open trade is still moving.
      const dir = seed % 2 ? 1 : -1;
      const entry = dir === 1 ? ('buy' as const) : ('short' as const);
      const exit = dir === 1 ? ('sell' as const) : ('cover' as const);
      const px = (v: number) => +Math.max(0.5, v).toFixed(2);
      const broker = new SimBroker({ startingBalance: 10_000, config: { ...ZERO_COST_CONFIG, ...strict() }, idPrefix: 'f' });
      let price = 50;
      let t = et('2025-01-15', '09:30');
      broker.onBar(S, bar(t, price, price, price, price));
      for (let i = 0; i < 360; i++) {
        const last = broker.markPrice(S)!;
        const trip = broker.state.roundTrips.find((x) => !x.closed);
        const held = Math.abs(broker.position(S).quantity);
        const r = rand();
        if (r < 0.3) {
          const type = pick(['market', 'limit', 'limit', 'stop'] as const);
          const S0 = trip?.initialStop;
          // Mostly at or inside the first stop, sometimes past it; a fresh trade's stop 0.2 to 2.2 away.
          const stopLoss = px(S0 !== undefined && rand() < 0.8 ? S0 + dir * (rand() * 0.6 - 0.1) : last - dir * (0.2 + rand() * 2));
          const req = {
            symbol: S,
            action: entry,
            type,
            tif: 'gtc' as const,
            limitPrice: type === 'limit' ? px(last - dir * (rand() * 1.5 - 0.2)) : undefined,
            stopPrice: type === 'stop' ? px(last + dir * rand() * 1.5) : undefined,
            stopLoss,
          };
          const size = rand() < 0.6 ? broker.sizeByRisk(req, 0.2 + rand()) : null;
          const quantity = size?.ok ? size.quantity : 1 + Math.floor(rand() * 300);
          const placed = broker.submit({ ...req, quantity });
          // What Size by risk sizes, submit accepts.
          if (size?.ok) {
            expect(placed.error, `seed ${seed} bar ${i}`).toBeUndefined();
            sized++;
          } else if (!placed.ok) refused++;
        } else if (r < 0.4) {
          const e = pick(broker.workingOrders(S).filter((o) => o.action === entry));
          if (e) broker.modify(e.id, rand() < 0.5 ? { quantity: e.filledQty + 1 + Math.floor(rand() * 2 * (e.quantity - e.filledQty)) } : e.type === 'limit' ? { limitPrice: px(e.limitPrice! + rand() - 0.5) } : { stopPrice: px(e.stopPrice! + rand() - 0.5) });
        } else if (r < 0.5) {
          const x = pick(broker.workingOrders(S).filter((o) => o.action === exit && o.type === 'stop'));
          if (x) broker.modify(x.id, { stopPrice: px(x.stopPrice! + rand() * 1.2 - 0.6) });
        } else if (r < 0.56 && held > 1) {
          broker.submit({ symbol: S, action: exit, type: 'market', quantity: 1 + Math.floor(rand() * (held - 1)) });
        } else if (r < 0.62 && held > 1 && trip?.initialStop !== undefined) {
          // Scale out of most of it and keep a stop on the rest, as a trader buying back later would.
          for (const x of broker.workingOrders(S)) if (x.action === exit) broker.cancel(x.id);
          const keep = 1 + Math.floor(rand() * Math.min(held - 1, 20));
          broker.submit({ symbol: S, action: exit, type: 'market', quantity: held - keep });
          broker.submit({ symbol: S, action: exit, type: 'stop', stopPrice: px(trip.initialStop + dir * rand() * 0.3), quantity: keep, tif: 'gtc' });
        } else if (r < 0.66) {
          const e = pick(broker.workingOrders(S).filter((o) => o.action === entry));
          if (e) broker.cancel(e.id);
        }
        // Gapless: each bar opens where the last one closed.
        t += 60;
        const o = price;
        price = Math.max(5, o + (rand() - 0.5) * 0.8);
        broker.onBar(S, bar(t, o, Math.max(o, price) + rand() * 0.3, Math.max(0.5, Math.min(o, price) - rand() * 0.3), price));
      }
      broker.cancelAll(S);
      if (broker.position(S).quantity) broker.closePosition(S);
      const st = broker.state;
      for (let i = 0; i < st.roundTrips.length; i++) {
        const trip = st.roundTrips[i];
        const at = `seed ${seed} trade ${i}`;
        expect(trip.closed, at).toBe(true);
        const r = reviewed(broker, i);
        expect(r.from, at).toBe('average');
        expect(r.pct, at).toBeLessThanOrEqual(1 + 1e-6);
        // With every stop at or inside the first stop and no gaps, no trade loses more than the limit.
        expect(trip.pnl / equityBeforeEntry(trip, st.fills, st.equityCurve, st.startingBalance), at).toBeGreaterThanOrEqual(-0.01 - 1e-9);
        trades++;
      }
      const result = challenge.evaluate({ trips: st.roundTrips, fills: st.fills, equityCurve: st.equityCurve, startingBalance: 10_000, equity: broker.account().equity, sessionFinished: false, rewound: false, rules: DEFAULT_TRADING_RULES });
      expect(result.status, `seed ${seed}: ${result.detail}`).not.toBe('failed');
    }
    // The sessions trade, size and get refused enough to mean something.
    expect(trades).toBeGreaterThan(800);
    expect(sized).toBeGreaterThan(2000);
    expect(refused).toBeGreaterThan(10_000);
  });
});

describe('opening orders that meet a position the other way', () => {
  it('cancels a working Short limit that would fill while long, instead of booking it as an exit', () => {
    const { broker, next } = setup();
    expect(broker.submit({ symbol: S, action: 'short', type: 'limit', quantity: 300, limitPrice: 101 }).ok).toBe(true);
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 100 });
    next(100, 101.5, 100, 101.4);
    const short = broker.state.orders[0];
    expect(short.status).toBe('cancelled');
    expect(short.conflict).toBe(true);
    expect(short.rejectReason).toBe('You were long 100 TEST when it would have filled. Sell the long before shorting.');
    expect(broker.position(S)).toMatchObject({ quantity: 100, avgPrice: 100 });
    expect(broker.state.fills).toHaveLength(1);
    const [trip] = broker.state.roundTrips;
    expect(trip).toMatchObject({ direction: 'long', entryQtyTotal: 100, exitQtyTotal: 0, closed: false });
    expect(broker.state.events.at(-1)?.message).toBe('SHORT 300 TEST LMT 101.00 cancelled: you were long 100 TEST when it would have filled');
    identity(broker);
  });

  it('cancels a working Buy (and its bracket) that would fill while short', () => {
    const { broker, next } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'limit', quantity: 100, limitPrice: 98, stopLoss: 97 });
    broker.submit({ symbol: S, action: 'short', type: 'market', quantity: 40 });
    next(100, 100, 97.5, 98.5);
    expect(broker.state.orders[0]).toMatchObject({ status: 'cancelled', conflict: true });
    expect(broker.state.orders.some((o) => o.parentId)).toBe(false);
    expect(broker.position(S)).toMatchObject({ quantity: -40, avgPrice: 100 });
    expect(broker.state.roundTrips).toHaveLength(1);
    expect(broker.state.roundTrips[0]).toMatchObject({ direction: 'short', entryQtyTotal: 40, exitQtyTotal: 0 });
    identity(broker);
  });

  // Where an exit and the opposite entry share a level (stop and reverse, a range traded both ways,
  // a gap through both), the exit goes first, so the entry opens the new trade.
  it('reverses when the exit and the opposite entry trigger at the same price', () => {
    const { broker, next } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'stop', stopPrice: 101, quantity: 100, stopLoss: 99, tif: 'gtc' });
    broker.submit({ symbol: S, action: 'short', type: 'stop', stopPrice: 99, quantity: 100, stopLoss: 101, tif: 'gtc' });
    next(100, 101.4, 99.9, 101.3); // breaks out: long at 101
    next(101.3, 101.4, 98.5, 98.6); // fails through 99: the long's stop and the short entry
    expect(broker.position(S)).toMatchObject({ quantity: -100, avgPrice: 99 });
    expect(broker.state.fills.map((f) => [f.action, f.price])).toEqual([
      ['buy', 101],
      ['sell', 99],
      ['short', 99],
    ]);
    expect(broker.state.orders.some((o) => o.conflict)).toBe(false);
    expect(broker.workingOrders(S).map((o) => [o.action, o.type, o.stopPrice])).toEqual([['cover', 'stop', 101]]);
    identity(broker);
  });

  it('trades a range both ways when the target is the other side\'s entry', () => {
    const { broker, next } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 99, quantity: 100, takeProfit: 101 });
    broker.submit({ symbol: S, action: 'short', type: 'limit', limitPrice: 101, quantity: 100, takeProfit: 99 });
    next(100, 101.2, 98.9, 101); // dips to 99 (long), then rallies to 101 (target, and the short)
    expect(broker.position(S)).toMatchObject({ quantity: -100, avgPrice: 101 });
    expect(broker.state.roundTrips.map((t) => [t.direction, t.closed, t.pnl])).toEqual([
      ['long', true, 200],
      ['short', false, 0],
    ]);
  });

  it('reverses on a gap through both the stop and the opposite entry', () => {
    const { broker, next } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'stop', stopPrice: 101, quantity: 100, stopLoss: 99, tif: 'gtc' });
    broker.submit({ symbol: S, action: 'short', type: 'stop', stopPrice: 98.5, quantity: 100, stopLoss: 100.5, tif: 'gtc' });
    next(100, 101.4, 99.9, 101.3);
    next(97, 97.2, 96.5, 96.8); // opens at 97, below both
    expect(broker.position(S)).toMatchObject({ quantity: -100, avgPrice: 97 });
    expect(broker.state.fills.map((f) => [f.action, f.price])).toEqual([
      ['buy', 101],
      ['sell', 97],
      ['short', 97],
    ]);
  });

  it('still fills a Buy placed while flat once the opposite trade has closed', () => {
    const { broker, next } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'limit', quantity: 100, limitPrice: 98 });
    broker.submit({ symbol: S, action: 'short', type: 'market', quantity: 40 });
    broker.submit({ symbol: S, action: 'cover', type: 'market', quantity: 40 });
    next(100, 100, 97.5, 98.5);
    expect(broker.state.orders[0].status).toBe('filled');
    expect(broker.position(S)).toMatchObject({ quantity: 100, avgPrice: 98 });
    expect(broker.state.roundTrips.map((t) => [t.direction, t.closed])).toEqual([
      ['short', true],
      ['long', false],
    ]);
  });
});

describe('brackets (stop loss / take profit)', () => {
  it('creates OCO exits on fill; target fill cancels the stop', () => {
    const { broker, next } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10, stopLoss: 98, takeProfit: 103 });
    const exits = broker.workingOrders(S);
    expect(exits.map((o) => o.type).sort()).toEqual(['limit', 'stop']);
    next(100, 102, 99, 101);
    next(101, 103.5, 100.5, 103.2);
    expect(broker.position(S).quantity).toBe(0);
    expect(broker.workingOrders(S)).toHaveLength(0);
    const trip = broker.state.roundTrips[0];
    expect(trip.pnl).toBe(30);
    expect(trip.initialStop).toBe(98);
    expect(trip.initialTarget).toBe(103);
    expect(trip.highWhileOpen).toBeGreaterThanOrEqual(103);
    expect(trip.lowWhileOpen).toBe(99);
  });

  it('uses the intrabar path when stop and target are both inside one bar', () => {
    // Down bar (close < open): path O -> H -> L -> C, so the target (high) is hit first.
    const a = setup();
    a.broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10, stopLoss: 98, takeProfit: 102 });
    a.next(100, 102.5, 97.5, 98);
    expect(a.broker.state.roundTrips[0].pnl).toBe(20);
    // Worst case: the adverse extreme is assumed to come first.
    const b = setup({ intrabarPath: 'worst_case' });
    b.broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10, stopLoss: 98, takeProfit: 102 });
    b.next(100, 102.5, 97.5, 98);
    expect(b.broker.state.roundTrips[0].pnl).toBe(-20);
  });

  it('counts the part of the exit bar a trade was open for in its excursions', () => {
    // Down bar O -> H -> L: the long ran to 101.5, then the stop filled at 98. The 97.5 low came after.
    const a = setup();
    a.broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10, stopLoss: 98 });
    a.next(100, 101.5, 97.5, 97.8);
    const stopped = a.broker.state.roundTrips[0];
    expect(stopped.closed).toBe(true);
    expect([stopped.highWhileOpen, stopped.lowWhileOpen]).toEqual([101.5, 98]);
    // Up bar O -> L -> H: the dip to 98.5 came before the target filled at 102.
    const b = setup();
    b.broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10, takeProfit: 102 });
    b.next(100, 102.5, 98.5, 102.2);
    const target = b.broker.state.roundTrips[0];
    expect(target.closed).toBe(true);
    expect([target.highWhileOpen, target.lowWhileOpen]).toEqual([102, 98.5]);
    // Opened and closed in one bar: in at 99 on the way down to 98, out at the 101 target.
    const c = setup();
    c.broker.submit({ symbol: S, action: 'buy', type: 'limit', quantity: 10, limitPrice: 99, takeProfit: 101, tif: 'day' });
    c.next(100, 101.5, 98, 101.2);
    const inOut = c.broker.state.roundTrips[0];
    expect(inOut.closed).toBe(true);
    expect([inOut.highWhileOpen, inOut.lowWhileOpen]).toEqual([101, 98]);
  });

  it('closing manually cancels the bracket exits', () => {
    const { broker } = setup();
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10, stopLoss: 98, takeProfit: 103 });
    broker.closePosition(S);
    expect(broker.position(S).quantity).toBe(0);
    expect(broker.workingOrders(S)).toHaveLength(0);
  });

  it('short bracket: stop above, target below', () => {
    const { broker, next } = setup();
    expect(broker.submit({ symbol: S, action: 'short', type: 'market', quantity: 10, stopLoss: 102, takeProfit: 97 }).ok).toBe(true);
    next(100, 102.5, 99.5, 102.2); // up bar: O -> L -> H -> C; stop at 102 hit
    expect(broker.position(S).quantity).toBe(0);
    expect(broker.state.roundTrips[0].pnl).toBe(-20);
  });
});

describe('liquidity, partial fills and time in force', () => {
  it('caps fills at the participation rate and keeps the rest working', () => {
    const { broker, next } = setup({ maxParticipation: 0.1, marketOrderFill: 'next_bar_open' });
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 250 });
    next(100, 100, 100, 100, 1000);
    expect(broker.position(S).quantity).toBe(100);
    expect(broker.state.orders[0].status).toBe('partially_filled');
    next(100, 100, 100, 100, 1000);
    next(100, 100, 100, 100, 1000);
    expect(broker.position(S).quantity).toBe(250);
    expect(broker.state.orders[0].status).toBe('filled');
  });

  it('charges the per-order fee and minimum once for an order that fills in pieces', () => {
    const { broker, next } = setup({
      maxParticipation: 0.25,
      marketOrderFill: 'next_bar_open',
      commission: { perShare: 0.001, perOrder: 1, minimumPerOrder: 2.5, maxPctOfValue: 0 },
    });
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 1000 });
    next(100, 100, 100, 100, 2000);
    next(100, 100, 100, 100, 2000);
    const fills = broker.state.fills.map((f) => [f.quantity, f.commission]);
    // One order of 1000 shares: $1 + $1 = $2, raised to the $2.50 minimum, once.
    expect(fills).toEqual([
      [500, 2.5],
      [500, 0],
    ]);
    expect(broker.account().commissionsPaid).toBe(2.5);
    expect(broker.state.orders[0].commission).toBe(2.5);
    // Once the per-share part passes the minimum, later pieces pay only their own shares.
    const big = setup({ maxParticipation: 0.25, marketOrderFill: 'next_bar_open', commission: { perShare: 0.01, perOrder: 1, minimumPerOrder: 0, maxPctOfValue: 0 } });
    big.broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 1000 });
    big.next(100, 100, 100, 100, 2000);
    big.next(100, 100, 100, 100, 2000);
    expect(big.broker.state.fills.map((f) => f.commission)).toEqual([6, 5]);
    identity(big.broker);
  });

  it('Close position also stops an entry that is still filling, so the position cannot grow back', () => {
    const { broker, next } = setup({ maxParticipation: 0.25, marketOrderFill: 'next_bar_open' }, 100_000, 10);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 3000, stopLoss: 9.5 }).ok).toBe(true);
    // A later entry that has not started is a plan of its own and stays.
    broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 9, quantity: 100 });
    next(10, 10, 10, 10, 4000);
    expect(broker.position(S).quantity).toBe(1000);
    const r = broker.closePosition(S);
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual(['Cancelled the unfilled 2000 of BUY 3000 TEST MKT, so it cannot add to the position after the close.']);
    expect(broker.state.orders[0]).toMatchObject({ status: 'cancelled', filledQty: 1000 });
    for (let i = 0; i < 3; i++) next(10, 10, 10, 10, 4000);
    expect(broker.position(S).quantity).toBe(0);
    expect(broker.workingOrders(S).map((o) => [o.action, o.type, o.limitPrice])).toEqual([['buy', 'limit', 9]]);
    expect(broker.state.roundTrips.map((t) => [t.closed, t.entryQtyTotal, t.exitQtyTotal])).toEqual([[true, 1000, 1000]]);
  });

  it('shares one bar’s volume cap among every order that fills against it, however many there are', () => {
    const { broker, next } = setup({ maxParticipation: 0.25 });
    next(100, 100, 100, 100, 1000);
    // Filled at once against the last bar: 25% of its 1000 shares, for one order or several.
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 1000 }).order!.filledQty).toBe(250);
    for (let i = 0; i < 3; i++) {
      const r = broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 250 });
      expect(r.order!.filledQty).toBe(0);
      expect(r.notes).toEqual(["Fills are capped at 25% of a bar's volume (Data & Settings), so the rest fills from the next bars."]);
    }
    expect(broker.position(S).quantity).toBe(250);
    // The next bar brings 250 more; the orders still working take it in turn.
    next(100, 100, 100, 100, 1000);
    expect(broker.position(S).quantity).toBe(500);
    // A bar's own fills count too: an order placed right after it gets only what they left.
    const b = setup({ maxParticipation: 0.25 });
    b.broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 99, quantity: 200, tif: 'day' });
    b.next(100, 100, 99, 99.5, 1000);
    expect(b.broker.position(S).quantity).toBe(200);
    expect(b.broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 200 }).order!.filledQty).toBe(50);
    identity(b.broker);
  });

  it('a stop that fired is a market order: what the volume cap left fills from the next bars, even if price recovers', () => {
    const { broker, next } = setup({ maxParticipation: 0.25 }, 100_000, 100);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 1000, stopLoss: 99 }).ok).toBe(true);
    // Through the stop on 2,000 shares: 500 can sell. Then price recovers above the stop.
    next(99.5, 99.5, 97.5, 98, 2000);
    expect(broker.position(S).quantity).toBe(500);
    const stop = broker.state.orders.find((o) => o.type === 'stop')!;
    expect([stop.status, stop.triggered]).toEqual(['partially_filled', true]);
    expect(broker.modify(stop.id, { stopPrice: 98 })).toEqual({ ok: false, error: 'The stop has already triggered, so its price no longer applies.' });
    next(99.6, 99.8, 99.4, 99.7, 2000);
    expect(broker.position(S).quantity).toBe(0);
    expect(broker.state.fills.slice(1).map((f) => [f.action, f.quantity, f.price])).toEqual([
      ['sell', 500, 99],
      ['sell', 500, 99.6],
    ]);
    expect(broker.state.roundTrips[0].closed).toBe(true);
  });

  it('with no volume cap, charges impact on at most one bar’s volume and never sells below the minimum tick', () => {
    const { broker, next } = setup({ maxParticipation: 0, slippage: { bps: 0, impactBpsPerPctOfVolume: 5 } }, 100_000, 5);
    next(5, 5, 5, 5, 500);
    // Half the bar's volume: 50% x 5 bps = 250 bps.
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 250 });
    // 24 bars' volume fills at once, charged as one full bar (500 bps), not 12,000 bps.
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 12_000 });
    broker.closePosition(S);
    expect(broker.state.fills.map((f) => [f.action, f.quantity, f.price])).toEqual([
      ['buy', 250, 5.13],
      ['buy', 12_000, 5.25],
      ['sell', 12_250, 4.75],
    ]);
    identity(broker);
    // Costs the user set beyond the price itself still leave a sale at a positive price.
    const steep = setup({ slippage: { bps: 15_000, impactBpsPerPctOfVolume: 0 } }, 100_000, 5);
    steep.broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10 });
    steep.broker.closePosition(S);
    expect(steep.broker.state.fills.map((f) => f.price)).toEqual([12.5, 0.0001]);
  });

  it('DAY orders expire at the regular close; GTC orders survive', () => {
    const broker = new SimBroker({ startingBalance: 10_000, config: ZERO_COST_CONFIG });
    broker.onBar(S, bar(et(D, '15:58'), 100, 100, 100, 100));
    broker.submit({ symbol: S, action: 'buy', type: 'limit', quantity: 1, limitPrice: 90, tif: 'day' });
    broker.submit({ symbol: S, action: 'buy', type: 'limit', quantity: 1, limitPrice: 90, tif: 'gtc' });
    broker.onBar(S, bar(et(D, '16:00'), 100, 100, 100, 100));
    expect(broker.state.orders.map((o) => o.status)).toEqual(['expired', 'working']);
  });

  it('extended-hours limit orders can fill pre-market, with wider spreads', () => {
    const broker = new SimBroker({ startingBalance: 10_000, config: { ...DEFAULT_EXECUTION_CONFIG, slippage: { bps: 0, impactBpsPerPctOfVolume: 0 } } });
    broker.onBar(S, bar(et(D, '08:00'), 100, 100, 100, 100));
    const r = broker.submit({ symbol: S, action: 'buy', type: 'limit', quantity: 5, limitPrice: 100.1, extendedHours: true });
    expect(r.ok).toBe(true);
    expect(broker.state.fills).toHaveLength(1);
    expect(broker.state.fills[0].price).toBeCloseTo(100.04, 2); // ask = 100 + 4x of 1bp half-spread
  });
});

describe('snapshots', () => {
  it('restore() returns exactly to a prior state', () => {
    const { broker, next } = setup();
    const before = broker.getState();
    broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 10 });
    next(105, 105, 105, 105);
    broker.restore(before);
    expect(broker.getState()).toEqual(before);
    expect(broker.position(S).quantity).toBe(0);
  });
});

describe('estimates for orders that fill later, and the daily loss limit', () => {
  const strictRisk: ExecutionConfig['strictRisk'] = { enabled: true, maxRiskPctPerTrade: 1, requireStopLoss: true, maxDailyLossPct: 3, maxPositionPctOfEquity: 100 };
  const reviewedPct = (broker: SimBroker, i = 0) => {
    const st = broker.state;
    const t = st.roundTrips[i];
    return ((riskBasis(t)!.risk * t.maxQuantity) / equityBeforeEntry(t, st.fills, st.equityCurve, st.startingBalance)) * 100;
  };

  for (const dir of [1, -1] as const) {
    it(`prices a ${dir === 1 ? 'buy' : 'short'} stop placed in the pre-market already past its level near the price, as it fills at the open`, () => {
      const broker = new SimBroker({ startingBalance: 10_000, config: { ...DEFAULT_EXECUTION_CONFIG, strictRisk } });
      const p = dir === 1 ? 52 : 48;
      let t = et('2025-01-15', '08:00');
      for (let i = 0; i < 30; i++, t += 60) broker.onBar(S, bar(t, p, p + 0.02, p - 0.02, p, 50_000));
      const req = { symbol: S, action: dir === 1 ? ('buy' as const) : ('short' as const), type: 'stop' as const, stopPrice: p - dir, stopLoss: p - 2 * dir, tif: 'day' as const };
      // A plain stop can't trade before the open, where it fills near today's price, not at its own.
      expect(Math.abs(broker.estimateFill({ ...req, quantity: 100 })! - p)).toBeLessThan(0.05);
      const size = broker.sizeByRisk(req, 1);
      expect(size).toMatchObject({ ok: true, quantity: 49 });
      expect(broker.submit({ ...req, quantity: 49 }).order!.status).toBe('pending');
      t = et('2025-01-15', '09:30');
      for (let i = 0; i < 3; i++, t += 60) broker.onBar(S, bar(t, p, p + 0.03, p - 0.03, p, 1_000_000));
      expect(broker.position(S).quantity).toBe(49 * dir);
      broker.closePosition(S);
      broker.onBar(S, bar(t, p, p, p, p, 1_000_000));
      expect(reviewedPct(broker)).toBeLessThanOrEqual(1);
    });
  }

  it('checks the bracket of an order waiting for the open against where it will fill', () => {
    for (const strict of [true, false]) {
      const broker = new SimBroker({ startingBalance: 100_000, config: { ...DEFAULT_EXECUTION_CONFIG, strictRisk: { ...strictRisk, enabled: strict } } });
      let t = et('2025-01-15', '08:00');
      for (let i = 0; i < 5; i++, t += 60) broker.onBar(S, bar(t, 52, 52.02, 51.98, 52, 50_000));
      // A buy stop at 51 fills near 52 at the open, so a stop loss at 51.50 is below it.
      expect(broker.submit({ symbol: S, action: 'buy', type: 'stop', stopPrice: 51, quantity: 50, stopLoss: 51.5, tif: 'day' }).ok).toBe(true);
      // A buy limit at 53 fills near 52 too, so a stop loss at 52.50 would be above it.
      expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 53, quantity: 50, stopLoss: 52.5, tif: 'day' }).error).toBe(
        'Stop loss must be below the entry price for a long: this limit is already through the market, so it would fill at about 52.01 when the stock next trades in the regular session.',
      );
    }
  });

  it('charges a resting stop entry the impact of a whole bar, whatever the last bar already traded', () => {
    const run = (useBar: boolean) => {
      const broker = new SimBroker({ startingBalance: 10_000, config: { ...DEFAULT_EXECUTION_CONFIG, strictRisk } });
      let t = et('2025-01-15', '09:30');
      broker.onBar(S, bar(t, 50, 50.05, 49.95, 50, 400));
      if (useBar) {
        // An in-and-out in the same bar uses up its volume cap.
        broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 50, stopLoss: 49, tif: 'gtc' });
        broker.closePosition(S);
      }
      const req = { symbol: S, action: 'buy' as const, type: 'stop' as const, stopPrice: 50.5, stopLoss: 49.5, tif: 'gtc' as const };
      const size = broker.sizeByRisk(req, 1);
      expect(size.ok).toBe(true);
      if (!size.ok) return null;
      broker.submit({ ...req, quantity: size.quantity });
      t += 60;
      broker.onBar(S, bar(t, 50, 50.7, 49.98, 50.6, 400));
      const trip = broker.state.roundTrips[broker.state.roundTrips.length - 1];
      return { quantity: size.quantity, est: broker.estimateFill({ ...req, quantity: size.quantity }), risk: ((trip.avgEntry - 49.5) * trip.maxQuantity) / 100 };
    };
    const fresh = run(false)!;
    const used = run(true)!;
    expect(used.quantity).toBe(fresh.quantity);
    expect(used.risk).toBeLessThanOrEqual(1);
  });

  it('holds the daily loss limit for the rest of the session once reached, even if the open trade recovers', () => {
    const { broker, next } = setup({ strictRisk: { ...strictRisk, maxRiskPctPerTrade: 5 } }, 10_000, 50);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 100, stopLoss: 46 }).ok).toBe(true);
    next(50, 50, 46.9, 46.9); // -3.1% at the close
    const add = { symbol: S, action: 'buy' as const, type: 'limit' as const, limitPrice: 48, quantity: 10, stopLoss: 46 };
    const refused = 'Strict risk: daily loss limit of 3% reached. No new entries or adds until the next session.';
    expect(broker.submit(add).error).toBe(refused);
    next(46.9, 48.5, 46.9, 48.5); // back to -1.5%
    expect(broker.submit(add).error).toBe(refused);
    // The next session starts afresh.
    broker.onBar(S, bar(et('2025-01-16', '09:30'), 48.5, 48.5, 48.5, 48.5));
    expect(broker.submit(add).ok).toBe(true);
  });

  it('says an add is just over the asked % with enough decimals to read as over', () => {
    const { broker } = setup({}, 50_000, 50);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 1666, stopLoss: 49.7 }).ok).toBe(true);
    const sized = broker.sizeByRisk({ symbol: S, action: 'buy', type: 'limit', limitPrice: 50, stopLoss: 49.7 }, 1);
    expect(sized).toEqual({ ok: false, error: "With even one more share the TEST trade would risk 1.0002% from its first stop at 49.70, more than the 1% asked." });
  });
});

describe('estimates once the last bar is used, stop-limit brackets, and the daily limit across symbols', () => {
  const strictRisk: ExecutionConfig['strictRisk'] = { enabled: true, maxRiskPctPerTrade: 1, requireStopLoss: true, maxDailyLossPct: 3, maxPositionPctOfEquity: 100 };
  const reviewedPct = (broker: SimBroker, i = 0) => {
    const st = broker.state;
    const t = st.roundTrips[i];
    return ((riskBasis(t)!.risk * t.maxQuantity) / equityBeforeEntry(t, st.fills, st.equityCurve, st.startingBalance)) * 100;
  };

  it('charges an add the last bar has no room left for the impact it pays on the next bar', () => {
    const broker = new SimBroker({ startingBalance: 50_000, config: { ...DEFAULT_EXECUTION_CONFIG, strictRisk } });
    let t = et('2025-03-04', '10:15');
    broker.onBar(S, bar(t, 20, 20.05, 19.95, 20, 2000)); // a 500-share cap
    const req = { symbol: S, action: 'buy' as const, type: 'market' as const, stopLoss: 19.5, tif: 'gtc' as const };
    expect(broker.submit({ ...req, quantity: 480 }).ok).toBe(true);
    // 20 shares of the cap are left, so most of a larger add fills on the next bar: it shows a worse entry.
    const est = [10, 100, 300].map((quantity) => broker.estimateFill({ ...req, quantity })!);
    expect(est[0]).toBeLessThan(est[1]);
    expect(est[1]).toBeLessThan(est[2]);
    const size = broker.sizeByRisk(req, 1);
    expect(size.ok).toBe(true);
    if (!size.ok) return;
    expect(broker.submit({ ...req, quantity: size.quantity }).ok).toBe(true);
    for (let i = 0; i < 2; i++) broker.onBar(S, bar((t += 60), 20, 20.02, 19.98, 20, 2000));
    expect(broker.position(S).quantity).toBe(480 + size.quantity);
    broker.closePosition(S);
    broker.onBar(S, bar((t += 60), 20, 20, 20, 20, 2000));
    expect(reviewedPct(broker)).toBeLessThanOrEqual(1);
  });

  it('prices a stop already through the market like a fresh bar once the last bar is used', () => {
    const estimate = (useBar: boolean) => {
      const broker = new SimBroker({ startingBalance: 10_000, config: DEFAULT_EXECUTION_CONFIG });
      broker.onBar(S, bar(et('2025-01-15', '09:30'), 50, 50.05, 49.95, 50, 400)); // a 100-share cap
      if (useBar) {
        broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 100 });
        broker.closePosition(S);
      }
      return broker.estimateFill({ symbol: S, action: 'buy', type: 'stop', stopPrice: 49.95, quantity: 90 });
    };
    expect(estimate(true)).toBe(estimate(false));
  });

  it("checks a stop-limit's bracket at its stop, never past its limit", () => {
    for (const enabled of [true, false]) {
      const { broker } = setup({ strictRisk: { ...strictRisk, enabled } }, 10_000, 49.5);
      const entry = { symbol: S, action: 'buy' as const, type: 'stop_limit' as const, limitPrice: 50.5, quantity: 50, stopLoss: 49.7, tif: 'day' as const };
      const placed = broker.submit({ ...entry, stopPrice: 50 });
      expect(placed.ok).toBe(true);
      // With its trigger under the stop loss it would fill below it and stop out at once.
      const below = 'Stop loss must be below the entry price for a long: this stop-limit would fill at about 49.60, where its stop fires.';
      expect(broker.modify(placed.order!.id, { stopPrice: 49.6 })).toMatchObject({ ok: false, error: below });
      expect(broker.submit({ ...entry, stopPrice: 49.6 }).error).toBe(below);
      expect(broker.bracketErrors({ ...entry, stopPrice: 49.6 })).toEqual([below]);
      expect(broker.submit({ ...entry, stopPrice: 49, limitPrice: 52 }).error).toBe(
        'Stop loss must be below the entry price for a long: this stop-limit is already through the market, so it would fill at once at about 49.50.',
      );
      // A short whose stop loss sits between its limit and its stop.
      expect(broker.submit({ symbol: S, action: 'short', type: 'stop_limit', stopPrice: 49.2, limitPrice: 48.9, quantity: 50, stopLoss: 49.1, tif: 'day' }).error).toBe(
        'Stop loss must be above the entry price for a short: this stop-limit would fill at about 49.20, where its stop fires.',
      );
    }
  });

  for (const dir of [1, -1] as const) {
    it(`words Strict's refusals for a ${dir === 1 ? 'long' : 'short'} the way that trade moves`, () => {
      const broker = new SimBroker({ startingBalance: 10_000, config: { ...ZERO_COST_CONFIG, strictRisk } });
      let t = et('2025-01-15', '10:00');
      const px = (p: number) => broker.onBar(S, bar((t += 60), p, p, p, p, 1_000_000));
      px(50);
      const [entry, exit] = dir === 1 ? (['buy', 'sell'] as const) : (['short', 'cover'] as const);
      const first = 50 - dir;
      expect(broker.submit({ symbol: S, action: entry, type: 'market', quantity: 90, stopLoss: first, tif: 'gtc' }).ok).toBe(true);
      for (const x of broker.workingOrders(S)) if (x.action === exit) broker.cancel(x.id);
      broker.submit({ symbol: S, action: exit, type: 'market', quantity: 60 });
      const stop = broker.submit({ symbol: S, action: exit, type: 'stop', stopPrice: first, quantity: 30, tif: 'gtc' }).order!;
      px(50 + dir * 0.5);
      const add = { symbol: S, action: entry, type: 'market' as const, quantity: 40, stopLoss: first, tif: 'gtc' as const };
      expect(broker.submit(add).error).toContain(`and this order ${dir === 1 ? 'raises' : 'lowers'} that average.`);
      expect(stop.status).toBe('working');

      // Tightening the stop of a trade held whole does not make room for an add either, and is called what it is.
      const other = new SimBroker({ startingBalance: 10_000, config: { ...ZERO_COST_CONFIG, strictRisk } });
      other.onBar(S, bar((t += 60), 50, 50, 50, 50, 1_000_000));
      expect(other.submit({ symbol: S, action: entry, type: 'market', quantity: 80, stopLoss: first, tif: 'gtc' }).ok).toBe(true);
      other.onBar(S, bar((t += 60), 50 + dir, 50 + dir, 50 + dir, 50 + dir, 1_000_000));
      const bracket = other.workingOrders(S).find((x) => x.action === exit)!;
      expect(other.modify(bracket.id, { stopPrice: 50 }).ok).toBe(true);
      expect(other.submit({ ...add, quantity: 30 }).error).toContain(`${dir === 1 ? 'Raising' : 'Lowering'} your stop does not change this`);
    });
  }

  it('does not say there is no position when entries must share a stop for shares held without one', () => {
    const broker = new SimBroker({ startingBalance: 10_000, config: { ...ZERO_COST_CONFIG, strictRisk: { ...strictRisk, requireStopLoss: false, maxPositionPctOfEquity: 400 } } });
    broker.onBar(S, bar(et('2025-01-15', '10:00'), 50, 50, 50, 50));
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 20 }).ok).toBe(true);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 49.5, quantity: 10, stopLoss: 49, tif: 'gtc' }).ok).toBe(true);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 49.8, quantity: 10, stopLoss: 49.2, tif: 'gtc' }).error).toMatch(
      /^Strict risk: until the TEST trade has a first stop, Buy entries working together must share one stop loss/,
    );
  });

  it('latches the daily loss limit only on equity the account had once every bar ending then was in', () => {
    const broker = new SimBroker({ startingBalance: 30_000, config: { ...ZERO_COST_CONFIG, strictRisk: { ...strictRisk, maxRiskPctPerTrade: 5 } } });
    let t = et('2025-01-15', '10:00');
    const minute = (a: number, b: number) => {
      broker.onBar('A', bar(t, a, a, a, a, 1_000_000));
      broker.onBar('B', bar(t, b, b, b, b, 1_000_000));
      broker.onBar('C', bar(t, 10, 10, 10, 10, 1_000_000));
      t += 60;
    };
    minute(100, 50);
    expect(broker.submit({ symbol: 'A', action: 'buy', type: 'market', quantity: 150, stopLoss: 90 }).ok).toBe(true);
    expect(broker.submit({ symbol: 'B', action: 'short', type: 'market', quantity: 300, stopLoss: 55 }).ok).toBe(true);
    // Both fall 7% in one minute: A's loss and B's gain cancel out, though between their two bars the
    // account looked 3.5% down.
    minute(93, 46.5);
    minute(93, 46.5);
    expect(broker.account().dayPnl).toBeCloseTo(0, 6);
    expect(broker.submit({ symbol: 'C', action: 'buy', type: 'limit', limitPrice: 9.9, quantity: 10, stopLoss: 9.5 }).ok).toBe(true);
  });
});

describe('the daily limit while a step fills, sub-dollar limits, stop-limits through the market, and the planned entry', () => {
  const strictRisk: ExecutionConfig['strictRisk'] = { enabled: true, maxRiskPctPerTrade: 10, requireStopLoss: true, maxDailyLossPct: 3, maxPositionPctOfEquity: 100 };

  for (const order of [['A', 'B'], ['B', 'A']]) {
    it(`fills an entry whose trade's day is not down, whichever symbol's bar comes first (${order.join(', ')})`, () => {
      const broker = new SimBroker({ startingBalance: 30_000, config: { ...ZERO_COST_CONFIG, strictRisk } });
      let t = et('2025-01-15', '10:00');
      const minute = (prices: Record<string, [number, number]>) => {
        for (const sym of order) {
          const [o, c] = prices[sym];
          broker.onBar(sym, bar(t, o, Math.max(o, c), Math.min(o, c), c, 1_000_000));
        }
        t += 60;
      };
      minute({ A: [100, 100], B: [50, 50] });
      expect(broker.submit({ symbol: 'A', action: 'buy', type: 'market', quantity: 150, stopLoss: 90 }).ok).toBe(true);
      expect(broker.submit({ symbol: 'B', action: 'short', type: 'market', quantity: 300, stopLoss: 55 }).ok).toBe(true);
      expect(broker.submit({ symbol: 'B', action: 'short', type: 'stop', stopPrice: 49, quantity: 20, stopLoss: 55, tif: 'gtc' }).ok).toBe(true);
      // Both fall 7%: A's loss and B's gain cancel out. The add fills on B's way down whichever bar is
      // processed first, since the account was never 3% down.
      minute({ A: [100, 93], B: [50, 46.5] });
      expect(broker.position('B').quantity).toBe(-320);
      expect(broker.state.orders.some((o) => o.conflict)).toBe(false);
    });
  }

  it('trades through a sub-dollar limit by its own tick, and fills it at its price', () => {
    const { broker, next } = setup({ limitFill: 'trade_through' }, 10_000, 0.46);
    broker.submit({ symbol: S, action: 'buy', type: 'limit', quantity: 1000, limitPrice: 0.452 });
    next(0.46, 0.46, 0.452, 0.455); // touches it only
    expect(broker.state.fills).toHaveLength(0);
    next(0.455, 0.455, 0.4519, 0.453); // one tick through
    expect(broker.state.fills.map((f) => f.price)).toEqual([0.452]);
  });

  it('fills a stop-limit whose stop has passed at once when its limit meets the market', () => {
    const { broker } = setup({}, 10_000, 50);
    const r = broker.submit({ symbol: S, action: 'buy', type: 'stop_limit', stopPrice: 49.9, limitPrice: 50.2, quantity: 10, tif: 'day' });
    expect(r.order!.status).toBe('filled');
    expect(broker.state.fills.map((f) => f.price)).toEqual([50]);
    // One whose limit the market is already past rests as a limit.
    const rest = broker.submit({ symbol: S, action: 'buy', type: 'stop_limit', stopPrice: 49.5, limitPrice: 49.8, quantity: 10, tif: 'day' });
    expect(rest.order).toMatchObject({ status: 'working', triggered: true });
  });

  it('measures a gapped stop entry from the price it was checked at, not its own stop', () => {
    const broker = new SimBroker({ startingBalance: 10_000, config: { ...ZERO_COST_CONFIG, strictRisk: { ...strictRisk, maxRiskPctPerTrade: 1 } } });
    let t = et('2025-01-15', '08:00');
    for (let i = 0; i < 5; i++, t += 60) broker.onBar(S, bar(t, 10.8, 10.8, 10.8, 10.8, 1_000_000));
    // A buy stop at 10 placed in the pre-market fills at the open near 10.80, so its stop loss at 10.40 is below it.
    const req = { symbol: S, action: 'buy' as const, type: 'stop' as const, stopPrice: 10, stopLoss: 10.4, tif: 'day' as const };
    const size = broker.sizeByRisk(req, 1);
    expect(size.ok).toBe(true);
    if (!size.ok) return;
    expect(broker.submit({ ...req, quantity: size.quantity }).order!.status).toBe('pending');
    // The open gaps to 10.30, under the stop loss: it fills there and stops out.
    broker.onBar(S, bar(et('2025-01-15', '09:30'), 10.3, 10.3, 10.3, 10.3, 1_000_000));
    broker.onBar(S, bar(et('2025-01-15', '09:31'), 10.3, 10.3, 10.3, 10.3, 1_000_000));
    const trip = broker.state.roundTrips[0];
    expect(trip.closed).toBe(true);
    expect(riskBasis(trip)).toEqual({ entry: 10.8, risk: expect.closeTo(0.4, 6), from: 'planned' });
  });

  it('sizes a stop-limit to all the buying power its limit leaves, as it never fills above it', () => {
    const { broker } = setup({}, 10_000, 50);
    const req = { symbol: S, action: 'buy' as const, type: 'stop_limit' as const, stopPrice: 50.5, limitPrice: 51, stopLoss: 40, tif: 'day' as const };
    const size = broker.sizeByRisk(req, 50);
    expect(size).toMatchObject({ ok: true, quantity: broker.affordableQuantity(req) });
  });
});

describe("the daily limit at the bar after a breach and with a bar's own entries, and a stop past a trade's average", () => {
  const strictRisk: ExecutionConfig['strictRisk'] = { enabled: true, maxRiskPctPerTrade: 1, requireStopLoss: true, maxDailyLossPct: 3, maxPositionPctOfEquity: 100 };

  it('values the shares a bar buys at what was paid, so a second entry in a strong bar fills on a day never at the limit', () => {
    const DAY = 6.5 * 3600;
    const broker = new SimBroker({ startingBalance: 100_000, config: { ...ZERO_COST_CONFIG, strictRisk } });
    broker.onBar(S, bar(et('2025-01-14', '09:30'), 100, 101, 99, 100, 20_000_000), DAY);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'stop', stopPrice: 104, quantity: 880, stopLoss: 103, tif: 'gtc' }).ok).toBe(true);
    const add = broker.submit({ symbol: S, action: 'buy', type: 'stop', stopPrice: 104.5, quantity: 50, stopLoss: 103, tif: 'gtc' });
    expect(add.ok).toBe(true);
    // Bought at 104, 4 above the last close: valued at the last close that was a 3.5% loss, which never happened.
    broker.onBar(S, bar(et('2025-01-15', '09:30'), 100.2, 105.3, 100.2, 105, 20_000_000), DAY);
    expect(broker.position(S).quantity).toBe(930);
    expect(broker.state.orders.some((o) => o.conflict)).toBe(false);
    expect(broker.account().equity).toBeGreaterThan(100_000);
  });

  for (const order of [['AAA', 'BBB'], ['BBB', 'AAA']]) {
    it(`cancels a working entry in the bar right after the limit was reached at a close, even once an exit lifts equity (${order.join(', ')})`, () => {
      const broker = new SimBroker({ startingBalance: 20_000, config: { ...ZERO_COST_CONFIG, strictRisk: { ...strictRisk, maxRiskPctPerTrade: 5, maxDailyLossPct: 1 } } });
      let t = et('2025-01-15', '10:00');
      const minute = (o: number, h: number, l: number, c: number) => {
        for (const sym of order) broker.onBar(sym, sym === 'AAA' ? bar(t, o, h, l, c, 1_000_000) : bar(t, 50, 50, 50, 50, 1_000_000));
        t += 60;
      };
      minute(10, 10, 10, 10);
      expect(broker.submit({ symbol: 'AAA', action: 'buy', type: 'market', quantity: 500, stopLoss: 9.5, takeProfit: 10.05, tif: 'gtc' }).ok).toBe(true);
      expect(broker.submit({ symbol: 'AAA', action: 'buy', type: 'market', quantity: 500, stopLoss: 9.5, tif: 'gtc' }).ok).toBe(true);
      const add = broker.submit({ symbol: 'AAA', action: 'buy', type: 'limit', limitPrice: 9.7, quantity: 500, stopLoss: 9.5, tif: 'gtc' });
      expect(add.ok).toBe(true);
      minute(10, 10, 9.78, 9.78); // closes 1.1% down: the limit is reached
      expect(broker.submit({ symbol: 'AAA', action: 'buy', type: 'limit', limitPrice: 9, quantity: 1, stopLoss: 8.9 }).error).toMatch(/daily loss limit of 1% reached/);
      // Up through the target at 10.05, which takes the day back above the limit, then down through the add at 9.70.
      minute(9.78, 10.08, 9.69, 9.75);
      const o = broker.state.orders.find((x) => x.id === add.order!.id)!;
      expect(o).toMatchObject({ status: 'cancelled', conflict: true });
      expect(o.rejectReason).toMatch(/daily loss limit was reached/);
      expect(broker.position('AAA').quantity).toBe(500);
    });
  }

  it("names the order's own stop when an add to a trade with no first stop has its stop past the average", () => {
    const { broker, next } = setup({ strictRisk: { ...strictRisk, maxRiskPctPerTrade: 10, requireStopLoss: false } }, 10_000, 50);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 100 }).ok).toBe(true);
    next(55, 55, 55, 55);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 20, stopLoss: 52 }).error).toBe(
      "Strict risk: this order's stop at 52.00 is at or above the trade's average entry of 50.00, so it would lock in a gain rather than cap a loss, and the trade's risk can't be measured. Use a stop below 50.00.",
    );
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 20, stopLoss: 49 }).ok).toBe(true);
  });
});

describe("the daily limit reached by a bar's own exits, and refused changes in the log", () => {
  it('holds a limit a stop reached partway through a bar for the rest of the day, though the bar closes higher', () => {
    const strictRisk: ExecutionConfig['strictRisk'] = { enabled: true, maxRiskPctPerTrade: 5, requireStopLoss: true, maxDailyLossPct: 1, maxPositionPctOfEquity: 400 };
    const broker = new SimBroker({ startingBalance: 100_000, config: { ...ZERO_COST_CONFIG, marginMultiplier: 4, strictRisk } });
    let t = et('2025-01-15', '09:30');
    const next = (o: number, h: number, l: number, c: number) => {
      broker.onBar(S, bar(t, o, h, l, c, 10_000_000));
      t += 60;
    };
    next(50, 50, 50, 50);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 1000, stopLoss: 48, tif: 'gtc' }).ok).toBe(true);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 1000, stopLoss: 49, tif: 'gtc' }).ok).toBe(true);
    const dip = broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 48.8, quantity: 100, stopLoss: 48, tif: 'gtc' });
    const breakout = broker.submit({ symbol: S, action: 'buy', type: 'stop', stopPrice: 51.3, quantity: 100, stopLoss: 48, tif: 'gtc' });
    expect(dip.ok && breakout.ok).toBe(true);
    // The stop at 49 sells 1000 shares, 1% of the account down from the last close, before the dip add is reached.
    next(50, 51, 48.7, 51);
    expect(broker.state.orders.find((o) => o.id === dip.order!.id)).toMatchObject({ status: 'cancelled', conflict: true });
    expect(broker.account().equity).toBeGreaterThanOrEqual(100_000);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 50.5, quantity: 100, stopLoss: 48 }).error).toMatch(/daily loss limit of 1% reached/);
    next(51, 51.4, 50.9, 51.2);
    expect(broker.state.orders.find((o) => o.id === breakout.order!.id)).toMatchObject({ status: 'cancelled', conflict: true });
    expect(broker.position(S).quantity).toBe(1000);
  });

  it('logs a refused price change with its reason, as a refused order is', () => {
    const { broker } = setup({}, 10_000, 50);
    const o = broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 49, quantity: 10, stopLoss: 48, tif: 'gtc' }).order!;
    const r = broker.modify(o.id, { limitPrice: 47 });
    expect(r.ok).toBe(false);
    const last = broker.state.events.at(-1)!;
    expect(last).toMatchObject({ kind: 'rejected', orderId: o.id });
    expect(last.message).toBe(`Change to BUY 10 ${S} LMT 49.00 refused: ${r.error}`);
  });
});

describe('the daily limit at moments inside a bar', () => {
  const strictRisk: ExecutionConfig['strictRisk'] = { enabled: true, maxRiskPctPerTrade: 5, requireStopLoss: true, maxDailyLossPct: 1, maxPositionPctOfEquity: 400 };

  it('values the shares held from before at the price where an add is stopped out, so a day that never lost 1% is not locked', () => {
    const broker = new SimBroker({ startingBalance: 100_000, config: { ...ZERO_COST_CONFIG, marginMultiplier: 4, strictRisk } });
    let t = et('2025-01-15', '09:30');
    const next = (o: number, h: number, l: number, c: number) => {
      broker.onBar(S, bar(t, o, h, l, c, 10_000_000));
      t += 60;
    };
    next(50, 50, 50, 50);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 1000, stopLoss: 49, tif: 'gtc' }).ok).toBe(true);
    next(50, 50, 50, 50);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'stop', stopPrice: 52, quantity: 1000, stopLoss: 51, tif: 'gtc' }).ok).toBe(true);
    // The add fills at 52 and its stop sells it at 51: -1000 on the add, +1000 on the 1000 shares held from 50.
    next(50, 52.5, 50, 50.1);
    expect(broker.state.fills.map((f) => `${f.action} ${f.quantity}@${f.price}`).slice(-2)).toEqual(['buy 1000@52', 'sell 1000@51']);
    next(50.1, 50.1, 50.1, 50.1);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 50, quantity: 100, stopLoss: 49 }).ok).toBe(true);
  });

  it('cancels an entry reached while the shares held are down past the limit, and holds the limit for the day', () => {
    const broker = new SimBroker({ startingBalance: 100_000, config: { ...ZERO_COST_CONFIG, marginMultiplier: 4, strictRisk } });
    let t = et('2025-01-15', '09:30');
    const next = (o: number, h: number, l: number, c: number) => {
      broker.onBar(S, bar(t, o, h, l, c, 10_000_000));
      t += 60;
    };
    next(50, 50, 50, 50);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 2000, stopLoss: 47.6, tif: 'gtc' }).ok).toBe(true);
    const dip = broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 49.4, quantity: 100, stopLoss: 47.6, tif: 'gtc' });
    expect(dip.ok).toBe(true);
    // At 49.40 the 2000 shares are 1200 (1.2%) down: the add is cancelled though the bar closes higher.
    next(50, 50.2, 49.3, 50.5);
    expect(broker.state.orders.find((o) => o.id === dip.order!.id)).toMatchObject({ status: 'cancelled', conflict: true });
    expect(broker.account().equity).toBeGreaterThan(100_000);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 50, quantity: 100, stopLoss: 47.6 }).error).toMatch(/daily loss limit of 1% reached/);
    next(50.5, 50.6, 50.4, 50.6);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 50, quantity: 100, stopLoss: 47.6 }).error).toMatch(/daily loss limit of 1% reached/);
  });

  for (const order of [['AAA', 'BBB'], ['BBB', 'AAA']]) {
    it(`leaves one symbol's stop-out out of another's bar ending at the same time, then holds it (${order.join(', ')})`, () => {
      const broker = new SimBroker({ startingBalance: 100_000, config: { ...ZERO_COST_CONFIG, strictRisk } });
      let t = et('2025-01-15', '10:00');
      const minute = (bars: Record<string, [number, number, number, number]>) => {
        for (const sym of order) broker.onBar(sym, bar(t, ...bars[sym], 1_000_000));
        t += 60;
      };
      minute({ AAA: [50, 50, 50, 50], BBB: [20, 20, 20, 20] });
      expect(broker.submit({ symbol: 'AAA', action: 'buy', type: 'market', quantity: 1000, stopLoss: 49, tif: 'gtc' }).ok).toBe(true);
      expect(broker.submit({ symbol: 'BBB', action: 'buy', type: 'limit', limitPrice: 19.9, quantity: 500, stopLoss: 19.5, tif: 'gtc' }).ok).toBe(true);
      minute({ AAA: [50, 50, 50, 50], BBB: [20, 20, 20, 20] });
      // AAA's stop costs 1% of the account; BBB's entry fills at its bar's open, in the same minute.
      minute({ AAA: [50, 50.2, 48.9, 49.6], BBB: [19.85, 20, 19.8, 19.95] });
      expect(broker.position('AAA').quantity).toBe(0);
      expect(broker.position('BBB').quantity).toBe(500);
      expect(broker.submit({ symbol: 'BBB', action: 'buy', type: 'limit', limitPrice: 19.5, quantity: 10, stopLoss: 19 }).error).toMatch(/daily loss limit of 1% reached/);
      minute({ AAA: [49.6, 49.6, 49.6, 49.6], BBB: [19.95, 20.5, 19.95, 20.5] });
      expect(broker.submit({ symbol: 'BBB', action: 'buy', type: 'limit', limitPrice: 19.5, quantity: 10, stopLoss: 19 }).error).toMatch(/daily loss limit of 1% reached/);
    });
  }
});

describe("Size by risk on a trade whose risk can't be measured, with Strict Mode off", () => {
  it('does not say adds are refused, as Strict Mode would', () => {
    const { broker, next } = setup({}, 100_000, 50);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 100, stopLoss: 49, tif: 'gtc' }).ok).toBe(true);
    broker.cancel(broker.workingOrders(S).find((o) => o.type === 'stop')!.id);
    next(47, 47, 47, 47);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 300, tif: 'gtc' }).ok).toBe(true);
    next(49.5, 49.5, 49.5, 49.5);
    expect(broker.sizeByRisk({ symbol: S, action: 'buy', type: 'limit', limitPrice: 49.4, stopLoss: 49.2 }, 1)).toEqual({
      ok: false,
      error: "The trade's average entry is at or below its first stop at 49.00, so its risk can't be measured.",
    });
  });

  it("names the working entry whose stop it is, not this order's", () => {
    const { broker, next } = setup({}, 100_000, 50);
    expect(broker.submit({ symbol: S, action: 'buy', type: 'market', quantity: 100, tif: 'gtc' }).ok).toBe(true);
    next(55, 55, 55, 55);
    const w = broker.submit({ symbol: S, action: 'buy', type: 'limit', limitPrice: 54, quantity: 50, stopLoss: 51, tif: 'gtc' });
    expect(w.ok).toBe(true);
    expect(broker.sizeByRisk({ symbol: S, action: 'buy', type: 'limit', limitPrice: 54.5, stopLoss: 53 }, 1)).toEqual({
      ok: false,
      error: `The stop on your working BUY 50 ${S} LMT 54.00 at 51.00 is at or above the trade's average entry of 50.00, so it would lock in a gain rather than cap a loss, and the trade's risk can't be measured. Change its stop to one below 50.00.`,
    });
  });
});
