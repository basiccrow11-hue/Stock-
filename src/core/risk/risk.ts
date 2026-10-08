/**
 * Pre-trade risk math. Pure functions, used by the order ticket (live preview), the broker's
 * optional strict-risk gate, and the backtester's position sizing.
 */
import type { OrderAction } from '../types';

export interface RiskInput {
  action: OrderAction;
  quantity: number;
  entryPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  equity: number;
  commissionEstimate?: number;
}

export interface RiskAssessment {
  direction: 'long' | 'short';
  /** True when this order opens or adds to a position (buy/short) rather than closing. */
  opening: boolean;
  positionValue: number;
  /** % of account equity the position value represents. */
  positionPctOfEquity: number;
  stopDistance: number | null;
  stopDistancePct: number | null;
  dollarRisk: number | null;
  pctRisk: number | null;
  reward: number | null;
  rewardRiskRatio: number | null;
  /** Problems with the order's prices (e.g. stop on the wrong side). */
  errors: string[];
  warnings: string[];
}

export interface StrictRiskConfig {
  enabled: boolean;
  maxRiskPctPerTrade: number;
  requireStopLoss: boolean;
  maxDailyLossPct: number;
  maxPositionPctOfEquity: number;
}

export const DEFAULT_STRICT_RISK: StrictRiskConfig = {
  enabled: false,
  maxRiskPctPerTrade: 1,
  requireStopLoss: true,
  maxDailyLossPct: 3,
  maxPositionPctOfEquity: 100,
};

/** Warn (but do not block, unless strict mode) above this per-trade risk. */
export const RISK_WARNING_PCT = 2;

export function assessRisk(input: RiskInput): RiskAssessment {
  const { action, quantity, entryPrice, stopLoss, takeProfit, equity } = input;
  const opening = action === 'buy' || action === 'short';
  const direction: 'long' | 'short' = action === 'buy' || action === 'sell' ? 'long' : 'short';
  const positionValue = Math.abs(quantity * entryPrice);
  const errors: string[] = [];
  const warnings: string[] = [];
  const commission = input.commissionEstimate ?? 0;

  let stopDistance: number | null = null;
  let dollarRisk: number | null = null;
  let reward: number | null = null;

  if (stopLoss !== undefined && stopLoss > 0 && opening) {
    const wrongSide = direction === 'long' ? stopLoss >= entryPrice : stopLoss <= entryPrice;
    if (wrongSide) {
      errors.push(direction === 'long' ? 'Stop loss must be below the entry price for a long.' : 'Stop loss must be above the entry price for a short.');
    } else {
      stopDistance = Math.abs(entryPrice - stopLoss);
      dollarRisk = stopDistance * quantity + commission * 2;
    }
  }
  if (takeProfit !== undefined && takeProfit > 0 && opening) {
    const wrongSide = direction === 'long' ? takeProfit <= entryPrice : takeProfit >= entryPrice;
    if (wrongSide) {
      errors.push(direction === 'long' ? 'Take profit must be above the entry price for a long.' : 'Take profit must be below the entry price for a short.');
    } else {
      reward = Math.abs(takeProfit - entryPrice) * quantity - commission * 2;
    }
  }

  const pctRisk = dollarRisk !== null && equity > 0 ? (dollarRisk / equity) * 100 : null;
  const rewardRiskRatio = dollarRisk !== null && reward !== null && dollarRisk > 0 ? reward / dollarRisk : null;
  const positionPctOfEquity = equity > 0 ? (positionValue / equity) * 100 : 0;

  if (opening) {
    if (stopLoss === undefined || stopLoss <= 0) warnings.push('No stop loss: your risk on this trade is undefined.');
    if (pctRisk !== null && pctRisk > RISK_WARNING_PCT) warnings.push(`WARNING: This trade risks ${pctRisk.toFixed(1)}% of your account.`);
    if (rewardRiskRatio !== null && rewardRiskRatio < 1) warnings.push(`Reward/risk is ${rewardRiskRatio.toFixed(2)}:1, below 1:1.`);
    if (positionPctOfEquity > 100) warnings.push(`Position is ${positionPctOfEquity.toFixed(0)}% of equity (uses margin).`);
  }

  return {
    direction,
    opening,
    positionValue,
    positionPctOfEquity,
    stopDistance,
    stopDistancePct: stopDistance !== null && entryPrice > 0 ? (stopDistance / entryPrice) * 100 : null,
    dollarRisk,
    pctRisk,
    reward,
    rewardRiskRatio,
    errors,
    warnings,
  };
}

/** Shares to buy/short so that hitting the stop loses `riskPct`% of equity. */
export function positionSizeForRisk(equity: number, riskPct: number, entry: number, stop: number): number {
  const perShare = Math.abs(entry - stop);
  if (perShare <= 0 || equity <= 0 || riskPct <= 0) return 0;
  return Math.floor((equity * riskPct) / 100 / perShare);
}

/** Returns a reason the order must be blocked under strict risk controls, or null. */
export function strictRiskViolation(
  cfg: StrictRiskConfig,
  assessment: RiskAssessment,
  ctx: { dayPnl: number; dayStartEquity: number },
): string | null {
  if (!cfg.enabled || !assessment.opening) return null;
  if (ctx.dayStartEquity > 0 && (-ctx.dayPnl / ctx.dayStartEquity) * 100 >= cfg.maxDailyLossPct) {
    return `Strict risk: daily loss limit of ${cfg.maxDailyLossPct}% reached. New positions are blocked for today.`;
  }
  if (cfg.requireStopLoss && assessment.dollarRisk === null) return 'Strict risk: a valid stop loss is required.';
  if (assessment.pctRisk !== null && assessment.pctRisk > cfg.maxRiskPctPerTrade + 1e-9) {
    return `Strict risk: this trade risks ${assessment.pctRisk.toFixed(2)}% (limit ${cfg.maxRiskPctPerTrade}%).`;
  }
  if (assessment.positionPctOfEquity > cfg.maxPositionPctOfEquity + 1e-9) {
    return `Strict risk: position is ${assessment.positionPctOfEquity.toFixed(0)}% of equity (limit ${cfg.maxPositionPctOfEquity}%).`;
  }
  return null;
}
