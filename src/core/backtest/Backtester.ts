/**
 * Strategy backtester.
 *
 * Execution model (no look-ahead):
 *  - Signals are evaluated only when a candle has CLOSED, using indicator values of completed candles.
 *  - The resulting market order fills at the OPEN of the next base bar (never at the signal candle's
 *    close, which would be unachievable in practice), through the same SimBroker the replay uses,
 *    so spread, slippage, commission, liquidity and stop/target behaviour are identical.
 *  - Stops and targets are evaluated on 1-minute bars inside each candle, not on the candle as a whole.
 *
 * Indicator series are computed once over the full candle array for speed. That is safe ONLY because
 * every series is causal (value[i] depends on candles[0..i]); tests enforce both causality and that
 * perturbing future bars cannot change earlier trades.
 */
import type { Bar, DataSourceKind, EquityPoint, Fill, OrderAction, RoundTrip, Timeframe, UnixSeconds } from '../types';
import type { ExecutionConfig } from '../broker/config';
import { SimBroker } from '../broker/SimBroker';
import { aggregateBars, candleFor } from '../data/aggregate';
import { computeStats, type PerformanceStats } from '../analytics/stats';
import { positionSizeForRisk } from '../risk/risk';
import { roundToTick } from '../util/math';
import { exchangeDate, exchangeTimeToUnix, marketSession, regularCloseMinute } from '../time';
import { barEndTime } from '../replay/ReplayEngine';
import { computeSeries, evalCondition, seriesKey, type StrategyDefinition } from './strategy';

export interface BacktestParams {
  symbol: string;
  /** Chronological base bars (1m) including warm-up history before `tradeFrom`. */
  bars: readonly Bar[];
  baseTimeframe: Timeframe;
  timeframe: Timeframe;
  /** Signals before this time are ignored (bars before it only warm up indicators). */
  tradeFrom: UnixSeconds;
  startingBalance: number;
  config: ExecutionConfig;
  strategy: StrategyDefinition;
  source: DataSourceKind;
}

export interface SignalRecord {
  time: UnixSeconds;
  candleTime: UnixSeconds;
  action: OrderAction;
  price: number;
  executed: boolean;
  note?: string;
}

export interface BacktestResult {
  trades: RoundTrip[];
  fills: Fill[];
  equityCurve: EquityPoint[];
  stats: PerformanceStats;
  signals: SignalRecord[];
  candles: Bar[];
  benchmarkReturnPct: number;
  benchmarkCurve: EquityPoint[];
  warnings: string[];
  barsProcessed: number;
}

const EXIT_ORDER: OrderAction[] = ['sell', 'cover', 'buy', 'short'];

export function runBacktest(p: BacktestParams): BacktestResult {
  const { strategy, symbol } = p;
  const warnings: string[] = [];
  const base = strategy.regularHoursOnly ? p.bars.filter((b) => marketSession(b.time) === 'regular') : [...p.bars];
  if (base.length === 0) throw new Error('No bars in the selected range.');
  if (strategy.rules.length === 0) throw new Error('Add at least one rule.');
  if (strategy.exitAtSessionEnd && p.baseTimeframe === '1D') warnings.push('Flatten before the close does not apply to daily bars: each bar is a whole session, so positions are held overnight.');
  if (strategy.sizing.mode === 'risk_percent' && !strategy.stopLossPct) {
    throw new Error('Risk-based sizing needs a stop loss %.');
  }

  // Pass 1: completed candles + causal indicator series.
  const candles = aggregateBars(base, p.timeframe, p.baseTimeframe);
  const series = new Map<string, number[]>();
  for (const rule of strategy.rules) {
    for (const c of rule.conditions) {
      for (const s of [c.left, c.right]) {
        const k = seriesKey(s);
        if (!series.has(k)) series.set(k, computeSeries(s, candles));
      }
    }
  }
  const candleIndex = new Map<string, number>();
  // Keyed as the base bars are below: at the data's own bar size each bar is its own candle (hourly
  // bars on the clock hour, a 09:30-10:00 first bar), coarser candles are 09:30-anchored buckets.
  candles.forEach((c, i) => candleIndex.set(candleFor(c.time, p.timeframe, p.baseTimeframe).key, i));

  const broker = new SimBroker({
    startingBalance: p.startingBalance,
    config: { ...p.config, marketOrderFill: 'next_bar_open' },
    idPrefix: 'bt',
    source: p.source,
  });
  const signals: SignalRecord[] = [];
  let pendingEntry: { action: OrderAction; candleTime: UnixSeconds; ref: number } | null = null;
  let currentKey = '';
  let firstTradePrice: number | null = null;
  // For the flatten before the close: the last regular session a bar was seen in, the last one whose
  // end has been acted on, the session whose position still has to be closed (until the book is flat),
  // the order closing it, and the days it could not all be closed in the session's last bar.
  let regularDate = '';
  let endedDate = '';
  let owedDate = '';
  let flattenId: string | null = null;
  const lateFlattens: string[] = [];
  const benchmarkCurve: EquityPoint[] = [];

  const submitEntry = (action: OrderAction, ref: number, time: UnixSeconds, candleTime: UnixSeconds) => {
    const equity = broker.account().equity;
    const long = action === 'buy';
    // Brackets sit on the price tick (0.0001 below $1), so a % stop or target keeps its distance on a penny stock.
    const sl = strategy.stopLossPct ? roundToTick(ref * (1 + ((long ? -1 : 1) * strategy.stopLossPct) / 100)) : undefined;
    const tp = strategy.takeProfitPct ? roundToTick(ref * (1 + ((long ? 1 : -1) * strategy.takeProfitPct) / 100)) : undefined;
    let qty = 0;
    const sz = strategy.sizing;
    if (sz.mode === 'shares') qty = sz.shares;
    else if (sz.mode === 'percent_equity') qty = Math.floor((equity * sz.percent) / 100 / ref);
    else qty = positionSizeForRisk(equity, sz.percent, ref, sl!);
    // % sizing never asks for more than the buying power left (with the ticket's small buffer for the
    // fill at the next open); a fixed share count is the user's own and is refused if it does not fit.
    const affordable = Math.floor(broker.affordableQuantity({ symbol, action, type: 'market' }) * 0.995);
    const capped = sz.mode !== 'shares' && qty > affordable;
    if (capped) qty = affordable;
    if (qty <= 0) {
      signals.push({ time, candleTime, action, price: ref, executed: false, note: capped ? 'No buying power left' : 'Position size is 0 shares' });
      return;
    }
    const r = broker.submit({ symbol, action, type: 'market', quantity: qty, stopLoss: sl, takeProfit: tp, tif: 'day', tag: strategy.name });
    signals.push({ time, candleTime, action, price: ref, executed: r.ok, note: r.ok ? `${qty} sh${capped ? ', capped by buying power' : ''}` : r.error });
  };

  /** Close the session's position: cancel its orders (brackets, a working entry) and sell or cover it all at market. */
  const flatten = (date: string) => {
    endedDate = owedDate = date;
    pendingEntry = null;
    for (const o of broker.workingOrders(symbol)) broker.cancel(o.id, 'Session end');
    closeRest();
  };
  const closeRest = () => {
    const q = broker.position(symbol).quantity;
    flattenId = q !== 0 ? (broker.submit({ symbol, action: q > 0 ? 'sell' : 'cover', type: 'market', quantity: Math.abs(q), tif: 'day' }).order?.id ?? null) : null;
  };
  const flattenOpen = () => flattenId !== null && broker.workingOrders(symbol).some((o) => o.id === flattenId);

  for (let j = 0; j < base.length; j++) {
    const b = base[j];
    const { key } = candleFor(b.time, p.timeframe, p.baseTimeframe);
    // Orders placed as this bar opens belong to the session they can fill in, even after a gap in the
    // data (a thin stock's day with no bar at the close), so they do not expire before their first bar.
    broker.syncClock(b.time);

    // The session's position must be closed by its end. A session whose data has no bar at the close,
    // or whose last bar let only part of it trade (the volume cap), is closed from the first bar after
    // it: the market order fills at the next regular session's open, as one placed after the close
    // would. Decided by the clock reaching this bar, never by looking ahead, and before this bar's
    // signals, which wait for the book to be flat.
    let flattening = false;
    if (strategy.exitAtSessionEnd && p.baseTimeframe !== '1D') {
      const past = (date: string) => marketSession(b.time) !== 'regular' || exchangeDate(b.time) !== date;
      if (regularDate && regularDate !== endedDate && past(regularDate)) flatten(regularDate);
      if (owedDate && past(owedDate)) {
        if (broker.position(symbol).quantity === 0) owedDate = '';
        else {
          if (!lateFlattens.includes(owedDate)) lateFlattens.push(owedDate);
          if (!flattenOpen()) closeRest();
          flattening = true;
        }
      }
    }

    // An entry waiting for the book to be flat (a reversal, or a signal during a flatten) is sent as
    // this bar opens, so it belongs to the session it can fill in, even after a thin day that had no
    // bar at the close.
    if (pendingEntry && broker.position(symbol).quantity === 0) {
      const pe = pendingEntry;
      pendingEntry = null;
      submitEntry(pe.action, pe.ref, b.time, pe.candleTime);
    }

    // A new candle opening means the previous one has closed: evaluate signals on it.
    if (currentKey && key !== currentKey && b.time >= p.tradeFrom) {
      const i = candleIndex.get(currentKey)!;
      const fired = new Set<OrderAction>();
      for (const rule of strategy.rules) {
        const results = rule.conditions.map((c) => evalCondition(c, series.get(seriesKey(c.left))!, series.get(seriesKey(c.right))!, i));
        const ok = rule.logic === 'all' ? results.every(Boolean) : results.some(Boolean);
        if (ok) fired.add(rule.action);
      }
      const ref = candles[i].close;
      for (const action of EXIT_ORDER) {
        if (!fired.has(action)) continue;
        const q = broker.position(symbol).quantity;
        const hasWorkingEntry = broker.workingOrders(symbol).some((o) => o.action === 'buy' || o.action === 'short');
        if (action === 'sell' || action === 'cover') {
          const applies = !flattening && (action === 'sell' ? q > 0 : q < 0);
          if (!applies) continue;
          for (const o of broker.workingOrders(symbol)) broker.cancel(o.id, 'Strategy exit');
          // Good till filled: what the volume cap leaves at the session's end is sold at the next open,
          // as the stop it replaces would have been, rather than held with no exit at all.
          const r = broker.submit({ symbol, action, type: 'market', quantity: Math.abs(q), tif: 'gtc' });
          signals.push({ time: b.time, candleTime: candles[i].time, action, price: ref, executed: r.ok, note: r.ok ? undefined : r.error });
        } else if (hasWorkingEntry) {
          continue;
        } else if (q === 0 && !pendingEntry) {
          submitEntry(action, ref, b.time, candles[i].time);
        } else if (flattening && !pendingEntry) {
          // The book is being flattened at this bar's open: enter once that has filled.
          pendingEntry = { action, candleTime: candles[i].time, ref };
        } else if ((action === 'buy' && q < 0 && fired.has('cover')) || (action === 'short' && q > 0 && fired.has('sell'))) {
          // Reversal: enter after the exit fills at this bar's open.
          pendingEntry = { action, candleTime: candles[i].time, ref };
        }
      }
    }
    currentKey = key;

    // Day-trading flatten in the regular session's last bar: the one that ends at the close (the final
    // minute on 1-minute data, 15:55 on 5-minute data). Decided by the clock alone, never by whether the
    // data has more bars, so it cannot peek ahead. Daily bars are whole sessions and are left out.
    if (marketSession(b.time) === 'regular') {
      const date = exchangeDate(b.time);
      regularDate = date;
      if (strategy.exitAtSessionEnd && p.baseTimeframe !== '1D' && barEndTime(b, p.baseTimeframe) >= exchangeTimeToUnix(date, regularCloseMinute(date))) flatten(date);
    }

    broker.onBar(symbol, b, barEndTime(b, p.baseTimeframe) - b.time);
    if (owedDate && broker.position(symbol).quantity === 0) owedDate = '';

    if (b.time >= p.tradeFrom) {
      if (firstTradePrice === null) firstTradePrice = b.open;
      benchmarkCurve.push({ time: b.time + 60, equity: (p.startingBalance * b.close) / firstTradePrice });
    }
  }

  const st = broker.state;
  const equityCurve = st.equityCurve.filter((pt) => pt.time > p.tradeFrom);
  const trades = st.roundTrips.map((t) => ({ ...t }));
  if (lateFlattens.length) {
    const n = lateFlattens.length;
    const days = n <= 3 ? lateFlattens.join(', ') : `${lateFlattens.slice(0, 3).join(', ')} and ${n - 3} more`;
    warnings.push(`On ${n === 1 ? '1 day' : `${n} days`} (${days}) the position could not all be closed in the session's last bar (no bar at the close, or more shares than the volume cap let trade there), so the rest was closed from the next session's open, after the overnight gap.`);
  }
  if (trades.some((t) => !t.closed)) warnings.push('A position was still open at the end of the test; it is excluded from closed-trade statistics but included in equity.');
  const last = base[base.length - 1];
  return {
    trades,
    fills: st.fills.map((f) => ({ ...f })),
    equityCurve,
    stats: computeStats(trades, equityCurve, p.startingBalance),
    signals,
    candles,
    benchmarkReturnPct: firstTradePrice ? (last.close / firstTradePrice - 1) * 100 : 0,
    benchmarkCurve,
    warnings,
    barsProcessed: base.length,
  };
}

