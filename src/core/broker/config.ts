/** Execution assumptions. Every one of these is user-configurable in Settings. */
import type { StrictRiskConfig } from '../risk/risk';
import { DEFAULT_STRICT_RISK } from '../risk/risk';

export interface ExecutionConfig {
  spread: {
    /** 'bps' = basis points of price; 'cents' = fixed dollar amount. Full spread (bid to ask). */
    mode: 'bps' | 'cents';
    value: number;
    /** Never narrower than this (dollars). */
    minimum: number;
    /** Spreads widen outside regular hours. */
    extendedHoursMultiplier: number;
  };
  slippage: {
    /** Fixed adverse slippage on marketable fills (market, stop), in bps. */
    bps: number;
    /** Extra bps per 1% of the bar's volume your order consumes (market impact). */
    impactBpsPerPctOfVolume: number;
  };
  commission: {
    perShare: number;
    perOrder: number;
    minimumPerOrder: number;
    /** Cap as % of trade value (0 = no cap). */
    maxPctOfValue: number;
  };
  /**
   * 'last_price': market orders submitted between bars fill immediately at the last trade price
   * (+ spread + slippage), like clicking Buy on a liquid stock.
   * 'next_bar_open': fill at the open of the next bar. More conservative.
   */
  marketOrderFill: 'last_price' | 'next_bar_open';
  /** 'touch': a limit fills when the quote reaches it. 'trade_through': price must trade one tick beyond. */
  limitFill: 'touch' | 'trade_through';
  /** Max fraction of a bar's volume you can trade (0 = unlimited). Larger orders fill partially. */
  maxParticipation: number;
  /**
   * Inside one bar we only know O/H/L/C. 'ohlc' assumes O→L→H→C on up bars and O→H→L→C on
   * down bars. 'worst_case' always visits the extreme that hurts your open position first.
   */
  intrabarPath: 'ohlc' | 'worst_case';
  allowShortSelling: boolean;
  allowExtendedHours: boolean;
  /** 1 = cash account (no shorting, no leverage). 2 = Reg T margin. 4 = intraday margin. */
  marginMultiplier: number;
  strictRisk: StrictRiskConfig;
}

export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  spread: { mode: 'bps', value: 2, minimum: 0.01, extendedHoursMultiplier: 4 },
  slippage: { bps: 1, impactBpsPerPctOfVolume: 5 },
  commission: { perShare: 0, perOrder: 0, minimumPerOrder: 0, maxPctOfValue: 0 },
  marketOrderFill: 'last_price',
  limitFill: 'touch',
  maxParticipation: 0.25,
  intrabarPath: 'ohlc',
  allowShortSelling: true,
  allowExtendedHours: true,
  marginMultiplier: 2,
  strictRisk: DEFAULT_STRICT_RISK,
};

/** A frictionless profile, handy in tests and for "what if" comparisons. */
export const ZERO_COST_CONFIG: ExecutionConfig = {
  ...DEFAULT_EXECUTION_CONFIG,
  spread: { mode: 'cents', value: 0, minimum: 0, extendedHoursMultiplier: 1 },
  slippage: { bps: 0, impactBpsPerPctOfVolume: 0 },
  commission: { perShare: 0, perOrder: 0, minimumPerOrder: 0, maxPctOfValue: 0 },
  maxParticipation: 0,
};

export function commissionFor(cfg: ExecutionConfig, quantity: number, price: number): number {
  const c = cfg.commission;
  let fee = c.perOrder + c.perShare * quantity;
  if (fee > 0 && fee < c.minimumPerOrder) fee = c.minimumPerOrder;
  if (c.maxPctOfValue > 0) fee = Math.min(fee, (c.maxPctOfValue / 100) * quantity * price);
  return Math.round(fee * 100) / 100;
}

export function halfSpread(cfg: ExecutionConfig, price: number, extendedHours: boolean): number {
  const s = cfg.spread;
  let full = s.mode === 'bps' ? (price * s.value) / 10_000 : s.value;
  full = Math.max(full, s.minimum);
  if (extendedHours) full *= s.extendedHoursMultiplier;
  return full / 2;
}
