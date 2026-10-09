/**
 * Core domain types shared by the engine (data, broker, replay, backtest, sim).
 * Everything in src/core is framework-free and must not import React or touch the DOM.
 */

/** Unix time in seconds (UTC). All bars are keyed by their OPEN time. */
export type UnixSeconds = number;

export interface Bar {
  time: UnixSeconds;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1D';

export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1D'];

/** Minutes per bar; 1D is handled specially (one bar per session). */
export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1D': 1440,
};

/**
 * Where prices come from. This is shown prominently in the UI and stored on every
 * trade and journal entry so simulated results are never mixed up with real ones.
 *  - LIVE: real-time feed from a market-data vendor
 *  - HISTORICAL: real recorded market data (CSV import or vendor API)
 *  - DEMO: synthetic bars bundled with the app so it works offline. Not real prices.
 *  - SIMULATED: the fictional, continuously generated market
 */
export type DataSourceKind = 'LIVE' | 'HISTORICAL' | 'DEMO' | 'SIMULATED';

export type Side = 'buy' | 'sell';
/** The four user-facing actions. buy/sell act on longs, short/cover on shorts. */
export type OrderAction = 'buy' | 'sell' | 'short' | 'cover';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit';
export type TimeInForce = 'day' | 'gtc';
export type OrderStatus = 'pending' | 'working' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'expired';

export function actionSide(action: OrderAction): Side {
  return action === 'buy' || action === 'cover' ? 'buy' : 'sell';
}

export interface OrderRequest {
  symbol: string;
  action: OrderAction;
  type: OrderType;
  quantity: number;
  /** Limit price for limit and stop_limit orders. */
  limitPrice?: number;
  /** Trigger price for stop and stop_limit orders. */
  stopPrice?: number;
  tif?: TimeInForce;
  /** Allow filling outside regular trading hours (limit orders only, like real brokers). */
  extendedHours?: boolean;
  /** Bracket: protective stop placed when the entry fills. */
  stopLoss?: number;
  /** Bracket: profit target placed when the entry fills. */
  takeProfit?: number;
  /** Free-form strategy/setup tag carried to the journal. */
  tag?: string;
}

export interface Order extends Required<Pick<OrderRequest, 'symbol' | 'action' | 'type' | 'quantity'>> {
  id: string;
  limitPrice?: number;
  stopPrice?: number;
  tif: TimeInForce;
  extendedHours: boolean;
  stopLoss?: number;
  takeProfit?: number;
  tag?: string;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice: number;
  createdAt: UnixSeconds;
  updatedAt: UnixSeconds;
  /** For stop_limit: true once the stop has triggered and it is resting as a limit. */
  triggered: boolean;
  /** Bracket children reference their parent entry. */
  parentId?: string;
  /** One-cancels-other group id for bracket exits. */
  ocoGroup?: string;
  /** Session date (YYYY-MM-DD, exchange time) on which a DAY order expires. */
  sessionDate?: string;
  rejectReason?: string;
  /** Commission charged on this order's fills so far (the per-order fee and minimum apply once). */
  commission?: number;
  /** Cancelled at fill time because a position the other way had opened since it was placed. */
  conflict?: boolean;
  /** Market orders: the price they were checked against when placed (last price plus or minus half the spread). */
  quotedPrice?: number;
  /** When the order's current terms took effect (placed, or its price or size last changed): it trades only on prices after this. */
  activeFrom?: UnixSeconds;
}

export interface Fill {
  id: string;
  orderId: string;
  symbol: string;
  action: OrderAction;
  side: Side;
  quantity: number;
  price: number;
  commission: number;
  /** Slippage cost in dollars relative to the pre-slippage quote. Always >= 0. */
  slippage: number;
  /** Half-spread cost in dollars relative to the mid/trade price. Always >= 0. */
  spreadCost: number;
  time: UnixSeconds;
  /**
   * How its price was set: 'open' at the open of a bar that began after the order was placed (a gap
   * can carry it past the order's price), 'placed' at once at the last price when the order was placed
   * or changed, 'bar' later in a bar. Absent on older fills.
   */
  at?: 'open' | 'placed' | 'bar';
  /** Realized P/L produced by this fill (closing fills only), after commission. */
  realizedPnl: number;
}

export interface Position {
  symbol: string;
  /** Signed: positive long, negative short. */
  quantity: number;
  avgPrice: number;
  realizedPnl: number;
}

/**
 * A round-trip trade: opens when a position leaves flat and closes when it returns to flat.
 * Scaling in/out is folded into one round trip (avg entry / avg exit).
 */
export interface RoundTrip {
  id: string;
  symbol: string;
  direction: 'long' | 'short';
  entryTime: UnixSeconds;
  exitTime?: UnixSeconds;
  /** Max absolute size held during the trade. */
  maxQuantity: number;
  /** Volume-weighted entry price of all opening fills. */
  avgEntry: number;
  /** Volume-weighted exit price of all closing fills. */
  avgExit?: number;
  entryQtyTotal: number;
  exitQtyTotal: number;
  /** Net P/L after commissions. */
  pnl: number;
  commission: number;
  /** Stop loss / take profit in force when the trade was opened (from the entry order). */
  initialStop?: number;
  initialTarget?: number;
  /**
   * The entry order the initial stop came with (the first entry, unless it had no stop and a later
   * add brought one): the price it was placed at (its limit, its stop, or for a market order the
   * price it was checked against), and the average price of its fills in this trade (an order capped
   * by bar volume fills in parts). Later adds move avgEntry, not these. Absent on older trades.
   */
  plannedEntry?: number;
  bracketEntry?: number;
  /** The initial stop came with an add, not with the trade's first entry (which had none). */
  stopFromAdd?: boolean;
  /** The same for the entry order the initial target came with (which may be a later add). Absent on older trades. */
  targetPlanned?: number;
  targetEntry?: number;
  /** Bookkeeping for bracketEntry and targetEntry: those orders' ids and how many of their shares have filled in this trade. */
  stopOrder?: { id: string; qty: number };
  targetOrder?: { id: string; qty: number };
  /**
   * The account's equity just before the trade's first fill, and the equity its trading day started
   * with: the day's P/L at entry as Strict Mode sees it, including anything realized earlier in the
   * same bar. Absent on older trades.
   */
  entryEquity?: number;
  entryDayStartEquity?: number;
  tag?: string;
  /** Highest / lowest price seen while the trade was open. */
  highWhileOpen: number;
  lowWhileOpen: number;
  /**
   * Best and worst open P/L while the trade was open (MFE/MAE), before costs: what it had made so
   * far plus the shares still held, at every price reached. Absent on trades recorded before these
   * were tracked.
   */
  bestOpenPnl?: number;
  worstOpenPnl?: number;
  fills: string[];
  closed: boolean;
  source: DataSourceKind;
}

export interface AccountSnapshot {
  startingBalance: number;
  cash: number;
  equity: number;
  buyingPower: number;
  longMarketValue: number;
  shortMarketValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  dayPnl: number;
  commissionsPaid: number;
}

export interface EquityPoint {
  time: UnixSeconds;
  equity: number;
}
