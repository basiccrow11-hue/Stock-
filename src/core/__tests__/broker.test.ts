import { describe, expect, it } from 'vitest';
import { SimBroker } from '../broker/SimBroker';
import { DEFAULT_EXECUTION_CONFIG, ZERO_COST_CONFIG, type ExecutionConfig } from '../broker/config';
import { bar, et } from './helpers';

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
