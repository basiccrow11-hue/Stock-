import { describe, expect, it } from 'vitest';
import { modelledQuote } from './modelledQuote';
import { SimBroker } from '../../core/broker/SimBroker';
import { DEFAULT_EXECUTION_CONFIG, ZERO_COST_CONFIG, type ExecutionConfig } from '../../core/broker/config';
import { bar, et } from '../../core/__tests__/helpers';

describe('the modelled bid and ask', () => {
  it('is the last price less and plus half the spread, rounded to the tick against the trader', () => {
    // Default spread: 2 bp of the price (2 cents at $100), at least a cent, four times as wide outside regular hours.
    expect(modelledQuote(DEFAULT_EXECUTION_CONFIG, 100, false)).toEqual({ bid: 99.99, ask: 100.01 });
    expect(modelledQuote(DEFAULT_EXECUTION_CONFIG, 100, true)).toEqual({ bid: 99.96, ask: 100.04 });
    // Half of 2 bp of 250.555 is 0.025056: 250.529944 rounds down to the cent, 250.580056 up.
    expect(modelledQuote(DEFAULT_EXECUTION_CONFIG, 250.555, false)).toEqual({ bid: 250.52, ask: 250.59 });
    // The cent minimum spread at $0.50. Below $1 the tick is a hundredth of a cent, and the bid never goes below one tick.
    expect(modelledQuote(DEFAULT_EXECUTION_CONFIG, 0.5, false)).toEqual({ bid: 0.495, ask: 0.505 });
    const wide: ExecutionConfig = { ...DEFAULT_EXECUTION_CONFIG, spread: { mode: 'cents', value: 1, minimum: 0, extendedHoursMultiplier: 1 } };
    expect(modelledQuote(wide, 0.2, false).bid).toBe(0.0001);
  });

  it('is where the broker fills a market order when there is no slippage', () => {
    const D = '2025-01-15';
    const configs: ExecutionConfig[] = [
      { ...ZERO_COST_CONFIG, spread: DEFAULT_EXECUTION_CONFIG.spread },
      { ...ZERO_COST_CONFIG, spread: { mode: 'cents', value: 0.05, minimum: 0.01, extendedHoursMultiplier: 3 } },
    ];
    for (const config of configs)
      for (const last of [0.4321, 1.2345, 37.123, 100, 250.555]) {
        const broker = new SimBroker({ startingBalance: 1_000_000, config, idPrefix: 't' });
        broker.onBar('TEST', bar(et(D, '10:00'), last, last, last, last));
        const { bid, ask } = modelledQuote(config, last, false);
        expect(broker.submit({ symbol: 'TEST', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
        expect(broker.submit({ symbol: 'TEST', action: 'sell', type: 'market', quantity: 10 }).ok).toBe(true);
        const [buy, sell] = broker.state.fills;
        expect([last, buy.price, sell.price]).toEqual([last, ask, bid]);
      }
  });
});
