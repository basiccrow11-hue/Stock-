/** The bid and ask the execution settings model around a last price. */
import { halfSpread, type ExecutionConfig } from '../../core/broker/config';

/**
 * Bid and ask as the broker models them: the last trade price less and plus half the configured
 * spread (wider outside regular hours), the bid rounded down and the ask up to the tick, as the
 * broker rounds a fill at the quote. It is not a real quote: market orders also pay slippage and
 * market impact on top of it.
 */
export function modelledQuote(cfg: ExecutionConfig, last: number, extendedHours: boolean): { bid: number; ask: number } {
  const hs = halfSpread(cfg, last, extendedHours);
  // The same tick rounding as SimBroker's fills: a cent, or a hundredth of a cent below $1.
  const down = (p: number) => (p >= 1 ? Math.floor(p * 100 + 1e-7) / 100 : Math.floor(p * 10_000 + 1e-7) / 10_000);
  const up = (p: number) => (p >= 1 ? Math.ceil(p * 100 - 1e-7) / 100 : Math.ceil(p * 10_000 - 1e-7) / 10_000);
  // A sell never fills below the minimum tick, however wide the spread.
  return { bid: Math.max(0.0001, down(last - hs)), ask: up(last + hs) };
}
