/** Rule-based backtester: build IF/THEN rules, pick data, run without look-ahead, inspect results. */
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { CandlestickSeries, createChart, createSeriesMarkers, PriceLineSource, type IChartApi, type SeriesMarker, type Time } from 'lightweight-charts';
import {
  OPERATOR_LABELS,
  STRATEGY_PRESETS,
  seriesLabel,
  strategyLabel,
  type Condition,
  type Operator,
  type Rule,
  type SeriesRef,
  type Sizing,
  type StrategyDefinition,
} from '../../core/backtest/strategy';
import { warmupCandlesFrom, warmupTradingDays, type BacktestResult } from '../../core/backtest/Backtester';
import { HISTORICAL_PROVIDERS, demoProvider } from '../state/dataRegistry';
import { useSettings } from '../state/settingsStore';
import { useCredentials } from '../state/credentials';
import { toast } from '../state/toasts';
import { TIMEFRAMES, type Bar, type DataSourceKind, type OrderAction, type Timeframe } from '../../core/types';
import { DEFAULT_LOOKBACK } from '../../core/replay/ReplaySession';
import { AFTERHOURS_CLOSE, exchangeDate, exchangeTimeToUnix, isTradingDay, nextTradingDay, prevTradingDay, tradingDayOnOrAfter, tradingDayOnOrBefore } from '../../core/time';
import { runBacktestAsync, cancelBacktests } from '../services/backtestClient';
import { NumberField, SourceBadge, EmptyState, useFocusRescue, useNumberDraft } from '../components/common';
import { StatsGrid } from './AnalyticsPage';
import { LineChart, type LineSpec } from '../chart/LineChart';
import { toChartTime } from '../chart/ChartView';
import { candleOptions, lastVisibleIndex, panelChartOptions } from '../chart/chartTheme';
import { chartLabelFill } from '../theme/color';
import { useTheme } from '../theme/useTheme';
import type { PanelChartPalette } from '../theme/themes';
import { CHART_LOCALE, dateTime, money, pnlClass, price, qty, signedMoney } from '../services/format';
import { newId } from '../../core/util/ids';
import { lastIndexAtOrBefore } from '../../core/util/math';
import { formatDuration } from '../../core/time';

const SERIES_KINDS: { kind: SeriesRef['kind']; label: string }[] = [
  { kind: 'close', label: 'Price (close)' },
  { kind: 'open', label: 'Price (open)' },
  { kind: 'high', label: 'Price (high)' },
  { kind: 'low', label: 'Price (low)' },
  { kind: 'ema', label: 'EMA' },
  { kind: 'sma', label: 'SMA' },
  { kind: 'vwap', label: 'VWAP' },
  { kind: 'rsi', label: 'RSI' },
  { kind: 'macd', label: 'MACD line' },
  { kind: 'macd_signal', label: 'MACD signal' },
  { kind: 'macd_hist', label: 'MACD histogram' },
  { kind: 'bb_upper', label: 'Bollinger upper' },
  { kind: 'bb_middle', label: 'Bollinger middle' },
  { kind: 'bb_lower', label: 'Bollinger lower' },
  { kind: 'atr', label: 'ATR' },
  { kind: 'value', label: 'Number' },
];

function defaultRef(kind: SeriesRef['kind']): SeriesRef {
  switch (kind) {
    case 'ema':
    case 'sma':
      return { kind, period: 20 };
    case 'rsi':
    case 'atr':
      return { kind, period: 14 };
    case 'macd':
    case 'macd_signal':
    case 'macd_hist':
      return { kind, fast: 12, slow: 26, signal: 9 };
    case 'bb_upper':
    case 'bb_middle':
    case 'bb_lower':
      return { kind, period: 20, mult: 2 };
    case 'value':
      return { kind, value: 50 };
    default:
      return { kind } as SeriesRef;
  }
}

/** The most warm-up history one run loads: about three years of trading days (a vendor's minute bars for longer take many requests). */
const MAX_WARMUP_DAYS = 756;
/** Warm-up history is loaded this many trading days at a time: at most 48,000 minute bars with extended hours, one Polygon page. */
const WARMUP_CHUNK_DAYS = 50;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function SmallNum({ value, onChange, step = 1, min = 1, title, label }: { value: number; onChange: (n: number) => void; step?: number; min?: number; title: string; label?: string }) {
  const draft = useNumberDraft(value, onChange, min);
  return (
    <input
      type="number"
      title={title}
      aria-label={label ?? title}
      value={draft.text}
      step={step}
      min={min}
      style={{ width: 64 }}
      onChange={(e) => {
        draft.set(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(n) && n >= min) onChange(n);
      }}
      onBlur={draft.finish}
    />
  );
}

/** One side of a condition; `side` names its controls for screen readers ("Left value period"). */
function SeriesEditor({ value, onChange, side }: { value: SeriesRef; onChange: (s: SeriesRef) => void; side: string }) {
  const num = (title: string) => ({ title, label: `${side} ${title.toLowerCase()}` });
  return (
    <span className="row" style={{ gap: 4 }}>
      <select aria-label={side} value={value.kind} onChange={(e) => onChange(defaultRef(e.target.value as SeriesRef['kind']))}>
        {SERIES_KINDS.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.label}
          </option>
        ))}
      </select>
      {'period' in value && <SmallNum {...num('Period')} value={value.period} onChange={(n) => onChange({ ...value, period: Math.max(1, Math.round(n)) })} />}
      {'mult' in value && <SmallNum {...num('Std devs')} value={value.mult} step={0.5} min={0.5} onChange={(n) => onChange({ ...value, mult: n })} />}
      {'fast' in value && (
        <>
          <SmallNum {...num('Fast')} value={value.fast} onChange={(n) => onChange({ ...value, fast: Math.max(1, Math.round(n)) })} />
          <SmallNum {...num('Slow')} value={value.slow} onChange={(n) => onChange({ ...value, slow: Math.max(2, Math.round(n)) })} />
          <SmallNum {...num('Signal')} value={value.signal} onChange={(n) => onChange({ ...value, signal: Math.max(1, Math.round(n)) })} />
        </>
      )}
      {value.kind === 'value' && <SmallNum {...num('Value')} value={value.value} step={1} min={-1e9} onChange={(n) => onChange({ kind: 'value', value: n })} />}
    </span>
  );
}

function RuleEditor({ rule, onChange, onRemove }: { rule: Rule; onChange: (r: Rule) => void; onRemove: () => void }) {
  const setCond = (i: number, c: Condition) => onChange({ ...rule, conditions: rule.conditions.map((x, j) => (j === i ? c : x)) });
  // A removed condition takes its ✕ with it: focus goes to this rule's "+ Condition".
  const ruleRef = useFocusRescue<HTMLDivElement>((r) => r.querySelector<HTMLElement>('[data-home]'));
  return (
    <div className="rule card" ref={ruleRef} style={{ padding: 10, background: 'var(--panel-2)' }}>
      <div className="row wrap">
        <b>IF</b>
        <select aria-label="Condition logic" value={rule.logic} onChange={(e) => onChange({ ...rule, logic: e.target.value as 'all' | 'any' })}>
          <option value="all">ALL of these are true</option>
          <option value="any">ANY of these is true</option>
        </select>
        <div className="spacer" />
        <button className="btn sm ghost" onClick={onRemove}>
          Remove rule
        </button>
      </div>
      {rule.conditions.map((c, i) => (
        <div key={i} className="cond row wrap" style={{ margin: '6px 0 6px 16px' }}>
          <SeriesEditor side="Left value" value={c.left} onChange={(s) => setCond(i, { ...c, left: s })} />
          <select aria-label="Comparison" value={c.op} onChange={(e) => setCond(i, { ...c, op: e.target.value as Operator })}>
            {(Object.keys(OPERATOR_LABELS) as Operator[]).map((o) => (
              <option key={o} value={o}>
                {OPERATOR_LABELS[o]}
              </option>
            ))}
          </select>
          <SeriesEditor side="Right value" value={c.right} onChange={(s) => setCond(i, { ...c, right: s })} />
          {rule.conditions.length > 1 && (
            <button className="btn sm ghost icon" title="Remove condition" aria-label="Remove condition" onClick={() => onChange({ ...rule, conditions: rule.conditions.filter((_, j) => j !== i) })}>
              <span aria-hidden="true">✕</span>
            </button>
          )}
        </div>
      ))}
      <div className="row wrap" style={{ marginLeft: 16 }}>
        <button className="btn sm" data-home onClick={() => onChange({ ...rule, conditions: [...rule.conditions, { left: { kind: 'close' }, op: 'above', right: { kind: 'ema', period: 20 } }] })}>
          + Condition
        </button>
        <div className="spacer" />
        <b>THEN</b>
        <select aria-label="Action" value={rule.action} onChange={(e) => onChange({ ...rule, action: e.target.value as OrderAction })}>
          <option value="buy">Buy (open long)</option>
          <option value="sell">Sell (close long)</option>
          <option value="short">Short (open short)</option>
          <option value="cover">Cover (close short)</option>
        </select>
      </div>
    </div>
  );
}

function describeRule(r: Rule): string {
  return `IF ${r.conditions.map((c) => `${seriesLabel(c.left)} ${OPERATOR_LABELS[c.op]} ${seriesLabel(c.right)}`).join(r.logic === 'all' ? ' AND ' : ' OR ')} THEN ${r.action.toUpperCase()}`;
}

/**
 * The trades chart. Built only while the page shows (a chart sized while hidden has no width, and
 * would open zoomed out on every candle), and kept while it is hidden; a result or a theme change made
 * meanwhile rebuilds it when the page shows again.
 */
function ResultChart({ result, timeframe, panel, active }: { result: BacktestResult; timeframe: Timeframe; panel: PanelChartPalette; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const built = useRef<{ chart: IChartApi; result: BacktestResult; timeframe: Timeframe; panel: PanelChartPalette } | null>(null);
  useEffect(() => () => {
    built.current?.chart.remove();
    built.current = null;
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const was = built.current;
    if (was && was.result === result && was.timeframe === timeframe && was.panel === panel) return;
    was?.chart.remove();
    const themed = panelChartOptions(panel);
    const chart = createChart(el, {
      ...themed,
      autoSize: true,
      layout: { ...themed.layout, fontSize: 11, attributionLogo: false },
      timeScale: { ...themed.timeScale, timeVisible: timeframe !== '1D' },
      localization: { locale: CHART_LOCALE },
      // On a scrolling page a vertical swipe scrolls the page.
      handleScroll: { vertTouchDrag: false },
    });
    // The last-price line marks the same candle as its label (the last one on screen).
    const s = chart.addSeries(CandlestickSeries, { ...candleOptions(panel), priceLineSource: PriceLineSource.LastVisible });
    const data = result.candles.map((c: Bar) => ({ time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close }));
    s.setData(data);
    // The last-price label shows the last candle on screen: fill it in that candle's colour, adjusted
    // so the label text stays readable.
    let labelUp: boolean | null = null;
    const syncLabel = () => {
      const b = result.candles[lastVisibleIndex(chart.timeScale().getVisibleLogicalRange(), result.candles.length)];
      const up = !b || b.close >= b.open;
      if (up === labelUp) return;
      labelUp = up;
      s.applyOptions({ priceLineColor: chartLabelFill(up ? panel.up : panel.down) });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(syncLabel);
    const markers: SeriesMarker<Time>[] = result.fills
      .map((f) => ({
        // On the candle holding the fill: data at its own bar size keeps the vendor's bar times.
        time: toChartTime(result.candles[Math.max(0, lastIndexAtOrBefore(result.candles, f.time, (c) => c.time))].time) as Time,
        position: f.side === 'buy' ? ('belowBar' as const) : ('aboveBar' as const),
        color: f.side === 'buy' ? panel.markerUp : panel.markerDown,
        shape: f.side === 'buy' ? ('arrowUp' as const) : ('arrowDown' as const),
        text: f.action === 'buy' ? 'B' : f.action === 'sell' ? 'S' : f.action === 'short' ? 'SH' : 'CV',
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    createSeriesMarkers(s, markers);
    // Show the last ~200 candles initially; the rest is a scroll away.
    const n = data.length;
    if (n > 200) chart.timeScale().setVisibleLogicalRange({ from: n - 200, to: n + 5 });
    else chart.timeScale().fitContent();
    syncLabel();
    built.current = { chart, result, timeframe, panel };
  }, [result, timeframe, panel, active]);
  return <div ref={ref} style={{ height: 380, position: 'relative' }} />;
}

// The results' tables can hold thousands of rows: they re-render only when their data changes, not
// on every theme change made while the page is hidden.
const TradesTable = memo(function TradesTable({ trades }: { trades: BacktestResult['trades'] }) {
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Side</th>
          <th>Entry</th>
          <th>Exit</th>
          <th className="num">Qty</th>
          <th className="num">Entry px</th>
          <th className="num">Exit px</th>
          <th className="num">P/L</th>
          <th>Held</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t) => (
          <tr key={t.id}>
            <td className={t.direction === 'long' ? 'pos' : 'neg'}>{t.direction.toUpperCase()}</td>
            <td className="mono small">{dateTime(t.entryTime)}</td>
            <td className="mono small">{t.exitTime ? dateTime(t.exitTime) : 'open'}</td>
            <td className="num">{qty(t.maxQuantity)}</td>
            <td className="num">{price(t.avgEntry)}</td>
            <td className="num">{price(t.avgExit)}</td>
            <td className={`num ${pnlClass(t.pnl)}`}>{signedMoney(t.pnl)}</td>
            <td>{t.exitTime ? formatDuration(t.exitTime - t.entryTime) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
});

const SignalsTable = memo(function SignalsTable({ signals }: { signals: BacktestResult['signals'] }) {
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Candle closed</th>
          <th>Action</th>
          <th className="num">Close</th>
          <th>Executed</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        {signals.map((s, i) => (
          <tr key={i}>
            <td className="mono small">{dateTime(s.candleTime)}</td>
            <td>{s.action.toUpperCase()}</td>
            <td className="num">{price(s.price)}</td>
            <td>{s.executed ? 'yes' : 'no'}</td>
            <td className="small muted">{s.note ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
});

/**
 * Stays mounted once opened (App hides it while another page is showing), so the strategy, the
 * settings, the results and a run in progress all survive a look at another page.
 */
export function BacktestPage({ active = true }: { active?: boolean }) {
  const settings = useSettings();
  const panel = useTheme().panel;
  useCredentials((s) => s.creds);
  const [strategy, setStrategy] = useState<StrategyDefinition>(() => clone(STRATEGY_PRESETS[0]));
  // A removed rule takes its Remove button with it: focus goes to "+ Rule".
  const rulesRef = useFocusRescue<HTMLDivElement>((card) => card.querySelector<HTMLElement>('[data-add-rule]'));
  const [providerId, setProviderId] = useState(settings.replay.providerId);
  const [symbol, setSymbol] = useState(settings.replay.symbol);
  const lastDay = demoProvider.lastDate;
  const [from, setFrom] = useState(() => {
    let d = lastDay;
    for (let i = 0; i < 20; i++) d = prevTradingDay(d);
    return d;
  });
  const [to, setTo] = useState(lastDay);
  const [timeframe, setTimeframe] = useState<Timeframe>('5m');
  const [balance, setBalance] = useState<number | ''>(settings.defaultBalance);
  const [commission, setCommission] = useState<number | ''>(settings.execution.commission.perShare);
  const [slippage, setSlippage] = useState<number | ''>(settings.execution.slippage.bps);
  const [spread, setSpread] = useState<number | ''>(settings.execution.spread.mode === 'bps' ? settings.execution.spread.value : 2);
  const [running, setRunning] = useState<string | null>(null);
  /** How far a long load has got, shown next to `running` but not announced (it changes every moment). */
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** What a screen reader is told when a run finishes. */
  const [announce, setAnnounce] = useState('');
  /** The last run's results, with the rules that produced them (the editor may have changed since). */
  const [result, setResult] = useState<{ r: BacktestResult; tf: Timeframe; label: string; rules: string[]; source: DataSourceKind } | null>(null);
  const [tab, setTab] = useState<'trades' | 'signals'>('trades');
  /** The run in progress: Cancel aborts its bar download, or stops the worker once it is running. */
  const runRef = useRef<{ controller: AbortController; started: number } | null>(null);
  /** When Cancel was last pressed: the button turns back into Run at once, and a press right after is still part of Cancel. */
  const cancelledAt = useRef(-Infinity);
  const activeRef = useRef(active);
  activeRef.current = active;

  const provider = HISTORICAL_PROVIDERS.find((p) => p.id === providerId) ?? demoProvider;
  // A daily candle is a whole session: the flatten before the close does not apply (the results say so too).
  const flattenNoteId = useId();
  const flattenNote =
    timeframe === '1D'
      ? 'Not used with the 1D signal timeframe: each candle is a whole session, so positions are held overnight.'
      : provider.baseTimeframe(symbol.trim().toUpperCase()) === '1D'
        ? 'Not used with daily data: each bar is a whole session, so positions are held overnight.'
        : null;

  // Read on every render: a key or a CSV added on another page makes the source available without
  // changing anything this page holds.
  const unavailable = provider.unavailableReason();
  const fieldError = useMemo(() => {
    if (!symbol.trim()) return 'Choose a ticker.';
    if (!from || !to || from > to) return 'Choose a valid date range.';
    if (!strategy.rules.length) return 'Add at least one rule.';
    if (!strategy.rules.some((r) => r.action === 'buy' || r.action === 'short')) return 'Add a rule that opens a position (Buy or Short).';
    if (strategy.sizing.mode === 'risk_percent' && !strategy.stopLossPct) return 'Risk-based sizing needs a stop loss %.';
    if (typeof balance !== 'number' || balance < 100) return 'Starting balance must be at least $100.';
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
    if (days > 1100) return 'Backtests are limited to about three years per run to keep memory use reasonable in the browser.';
    return null;
  }, [symbol, from, to, strategy, balance]);
  const validation = unavailable ?? fieldError;

  const run = async () => {
    if (validation || runRef.current) return;
    const controller = new AbortController();
    runRef.current = { controller, started: performance.now() };
    const cancelled = () => controller.signal.aborted;
    setError(null);
    setAnnounce('');
    setRunning('Loading bars…');
    setProgress('');
    try {
      const tradeStart = isTradingDay(from) ? from : nextTradingDay(from);
      const end = tradingDayOnOrBefore(to);
      const sym = symbol.trim().toUpperCase();
      const baseTimeframe = provider.baseTimeframe(sym);
      const bars = await provider.getBars({ symbol: sym, from: exchangeTimeToUnix(tradeStart, 0), to: exchangeTimeToUnix(end, AFTERHOURS_CLOSE) }, controller.signal);
      if (cancelled()) throw new Error('Cancelled');
      if (!bars.length) throw new Error(`No data for ${sym} in that range.`);
      // Warm-up history, so the rules' indicators have settled values from the first tradable candle: as
      // many trading days as the longest of them needs on this timeframe (never fewer than the replay's
      // own lookback, up to 60), from no earlier than the data starts. The results say when that was
      // not enough.
      const days = Math.min(MAX_WARMUP_DAYS, Math.max(Math.min(DEFAULT_LOOKBACK[timeframe], 60), warmupTradingDays(strategy, timeframe)));
      let warm = tradeStart;
      for (let i = 0; i < days; i++) warm = prevTradingDay(warm);
      const range = await provider.availableRange(sym);
      if (range && exchangeDate(range.from) > warm) warm = tradingDayOnOrAfter(exchangeDate(range.from));
      // Loaded WARMUP_CHUNK_DAYS at a time, newest first, and turned into candles at once, so a long warm-up
      // never holds its minute bars, a vendor's page limit never cuts it short, and Cancel works between
      // pieces. A piece that fails to load (a free plan's rate limit, say) ends the warm-up there: the
      // test runs on the recent history already loaded, which has no gap before the start, and says so.
      const pieces: Bar[][] = [];
      let partial: string | null = null;
      let total = 0;
      for (let d = warm; d < tradeStart; d = nextTradingDay(d)) total++;
      setRunning('Loading warm-up history…');
      for (let hi = tradeStart, done = 0; hi > warm; ) {
        let lo = hi;
        let n = 0;
        for (; n < WARMUP_CHUNK_DAYS && lo > warm; n++) lo = prevTradingDay(lo);
        let chunk: Bar[];
        try {
          chunk = await provider.getBars({ symbol: sym, from: exchangeTimeToUnix(lo, 0), to: exchangeTimeToUnix(hi, 0) }, controller.signal);
        } catch (e) {
          if (cancelled()) throw e;
          const why = (e as Error).message;
          partial = done
            ? `Only ${done} of ${total} trading days of warm-up history could be loaded (from ${hi} on), so the test started with less: ${why}`
            : `The warm-up history (${total} trading days) could not be loaded, so the test started without it: ${why}`;
          break;
        }
        if (cancelled()) throw new Error('Cancelled');
        pieces.unshift(warmupCandlesFrom(chunk, strategy, timeframe, baseTimeframe));
        done += n;
        setProgress(`${done} of ${total} days`);
        hi = lo;
        // Demo bars are made on this thread: let the page draw and take a Cancel press between pieces.
        await new Promise((r) => setTimeout(r, 0));
        if (cancelled()) throw new Error('Cancelled');
      }
      const warmupCandles = pieces.flat();
      setProgress('');
      setRunning(`Running on ${bars.length.toLocaleString('en-US')} bars…`);
      const ex = settings.execution;
      const job = runBacktestAsync({
        symbol: sym,
        bars,
        baseTimeframe,
        timeframe,
        warmupCandles,
        tradeFrom: exchangeTimeToUnix(tradeStart, 0),
        startingBalance: balance as number,
        config: {
          ...ex,
          commission: { ...ex.commission, perShare: typeof commission === 'number' ? commission : 0 },
          slippage: { ...ex.slippage, bps: typeof slippage === 'number' ? slippage : 0 },
          spread: { ...ex.spread, mode: 'bps', value: typeof spread === 'number' ? spread : 0 },
          strictRisk: { ...ex.strictRisk, enabled: false },
        },
        strategy,
        source: provider.source,
      });
      // Making demo bars and handing them to the worker happen on this thread, which can keep it busy
      // for a second or two: a second press queued meanwhile is handled only now, so it still counts
      // as part of the Run press.
      runRef.current!.started = performance.now();
      const ran = await job;
      if (cancelled()) throw new Error('Cancelled');
      const r = partial ? { ...ran, warnings: [partial, ...ran.warnings] } : ran;
      setResult({ r, tf: timeframe, label: `${strategyLabel(strategy)} · ${sym} · ${tradeStart} → ${end} · ${timeframe}`, rules: strategy.rules.map(describeRule), source: provider.source });
      const done = `Backtest done: ${r.stats.totalTrades} ${r.stats.totalTrades === 1 ? 'trade' : 'trades'}, strategy return ${r.stats.totalReturnPct.toFixed(2)}%.`;
      setAnnounce(done);
      // Finished while another page is showing: say so there.
      if (!activeRef.current) toast('success', done, 6000);
    } catch (e) {
      if (cancelled() || (e as Error).message === 'Cancelled') setAnnounce('Backtest cancelled.');
      else {
        setError((e as Error).message);
        if (!activeRef.current) toast('error', `Backtest failed: ${(e as Error).message}`, 8000);
      }
    } finally {
      runRef.current = null;
      setRunning(null);
      setProgress('');
    }
  };

  /**
   * Cancel, from the same button as Run. A second click of a double-click, a held Enter's repeats, and
   * any press in the first half second (or the first half second after the bars have loaded) are taken
   * as the Run press carrying on, not as Cancel.
   */
  const cancel = (e: React.MouseEvent) => {
    const r = runRef.current;
    if (!r || e.detail > 1 || performance.now() - r.started < 500) return;
    cancelledAt.current = performance.now();
    r.controller.abort();
    cancelBacktests();
  };

  /** Run, from the same button. Likewise the second click of a double-click on Cancel, or a press in the half second after it, carries on that Cancel. */
  const runPressed = (e: React.MouseEvent) => {
    if (e.detail > 1 || performance.now() - cancelledAt.current < 500) return;
    void run();
  };

  const equityLines = useMemo<LineSpec[]>(() => {
    if (!result) return [];
    return [
      { name: 'Strategy', color: panel.accent, area: true, points: result.r.equityCurve.map((p) => ({ time: p.time, value: p.equity })) },
      { name: 'Buy & hold', color: panel.benchmark, dashed: true, points: result.r.benchmarkCurve.map((p) => ({ time: p.time, value: p.equity })) },
    ];
  }, [result, panel.accent, panel.benchmark]);

  const setSizing = (s: Sizing) => setStrategy({ ...strategy, sizing: s });

  return (
    <div className="page" hidden={!active}>
      <div className="page-inner stack" style={{ gap: 16 }}>
        <div className="row wrap">
          <h1>Backtester</h1>
          <span className="muted small">Signals are evaluated on closed candles only and filled at the next bar&apos;s open. No future data is used.</span>
        </div>

        <div className="card stack rule-builder" ref={rulesRef}>
          <div className="row wrap">
            <h2>Strategy</h2>
            <div className="spacer" />
            <select
              aria-label="Load a strategy preset"
              value=""
              onChange={(e) => {
                const p = STRATEGY_PRESETS.find((x) => x.name === e.target.value);
                if (p) setStrategy(clone(p));
              }}
            >
              <option value="">Load a preset…</option>
              {STRATEGY_PRESETS.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <label className="field" style={{ maxWidth: 420 }}>
            <span>Name</span>
            <input type="text" value={strategy.name} onChange={(e) => setStrategy({ ...strategy, name: e.target.value })} />
          </label>
          {strategy.rules.map((r) => (
            <RuleEditor
              key={r.id}
              rule={r}
              onChange={(nr) => setStrategy({ ...strategy, rules: strategy.rules.map((x) => (x.id === r.id ? nr : x)) })}
              onRemove={() => setStrategy({ ...strategy, rules: strategy.rules.filter((x) => x.id !== r.id) })}
            />
          ))}
          <div className="row">
            <button
              className="btn sm"
              data-add-rule
              onClick={() =>
                setStrategy({
                  ...strategy,
                  rules: [...strategy.rules, { id: newId('rule'), logic: 'all', action: 'buy', conditions: [{ left: { kind: 'ema', period: 9 }, op: 'crosses_above', right: { kind: 'ema', period: 21 } }] }],
                })
              }
            >
              + Rule
            </button>
          </div>
          <div className="form-grid">
            <NumberField label="Stop loss" suffix="% · blank = none" value={strategy.stopLossPct ?? ''} step={0.25} min={0} onChange={(v) => setStrategy({ ...strategy, stopLossPct: v === '' || v <= 0 ? undefined : v })} />
            <NumberField label="Take profit" suffix="% · blank = none" value={strategy.takeProfitPct ?? ''} step={0.25} min={0} onChange={(v) => setStrategy({ ...strategy, takeProfitPct: v === '' || v <= 0 ? undefined : v })} />
            <label className="field">
              <span>Position size</span>
              <select
                value={strategy.sizing.mode}
                onChange={(e) => {
                  const m = e.target.value as Sizing['mode'];
                  setSizing(m === 'shares' ? { mode: 'shares', shares: 100 } : m === 'percent_equity' ? { mode: 'percent_equity', percent: 25 } : { mode: 'risk_percent', percent: 1 });
                }}
              >
                <option value="risk_percent">Risk % of equity per trade</option>
                <option value="percent_equity">% of equity per trade</option>
                <option value="shares">Fixed shares</option>
              </select>
            </label>
            {strategy.sizing.mode === 'shares' ? (
              <NumberField label="Shares" value={strategy.sizing.shares} step={1} min={1} onChange={(v) => v !== '' && setSizing({ mode: 'shares', shares: Math.max(1, Math.round(v)) })} />
            ) : (
              <NumberField
                label={strategy.sizing.mode === 'risk_percent' ? 'Risk per trade' : 'Position size'}
                suffix="%"
                value={strategy.sizing.percent}
                step={strategy.sizing.mode === 'risk_percent' ? 0.05 : 1}
                min={strategy.sizing.mode === 'risk_percent' ? 0.1 : 1}
                onChange={(v) => v !== '' && setSizing({ ...(strategy.sizing as { mode: 'risk_percent' | 'percent_equity'; percent: number }), percent: v })}
              />
            )}
          </div>
          <div className="row wrap" style={{ gap: 16 }}>
            <label className="check">
              <input
                type="checkbox"
                checked={strategy.exitAtSessionEnd}
                aria-describedby={flattenNote ? flattenNoteId : undefined}
                onChange={(e) => setStrategy({ ...strategy, exitAtSessionEnd: e.target.checked })}
              />{' '}
              Flatten before the close each day
            </label>
            {flattenNote && (
              <span id={flattenNoteId} className="small muted">
                {flattenNote}
              </span>
            )}
            <label className="check">
              <input type="checkbox" checked={strategy.regularHoursOnly} onChange={(e) => setStrategy({ ...strategy, regularHoursOnly: e.target.checked })} /> Regular hours only
            </label>
          </div>
        </div>

        <div className="card stack">
          <h2>Data and costs</h2>
          <div className="form-grid">
            <label className="field">
              <span>Data source</span>
              <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                {HISTORICAL_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.unavailableReason() ? ' (not set up)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Ticker</span>
              <input type="text" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
            </label>
            <label className="field">
              <span>From</span>
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="field">
              <span>To</span>
              <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </label>
            <label className="field">
              <span>Signal timeframe</span>
              <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)}>
                {TIMEFRAMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <NumberField label="Starting balance" suffix="$" value={balance} step={100} min={100} onChange={setBalance} />
            <NumberField label="Commission" suffix="$ per share" value={commission} step={0.001} min={0} onChange={setCommission} />
            <NumberField label="Slippage" suffix="bps" value={slippage} step={0.5} min={0} onChange={setSlippage} />
            <NumberField label="Spread" suffix="bps" value={spread} step={0.5} min={0} onChange={setSpread} />
          </div>
          <p className="small muted">
            Also from the Execution model in Data &amp; Settings:{' '}
            {settings.execution.commission.perOrder > 0 ? `a commission of ${money(settings.execution.commission.perOrder)} per order on top of the per-share one` : 'the per-order commission (none set)'}
            {settings.execution.commission.minimumPerOrder > 0 ? `, a minimum of ${money(settings.execution.commission.minimumPerOrder)} on any order that pays commission` : ''}, the minimum spread, market impact, the share of each bar&rsquo;s volume an order can take, how a take-profit limit fills, the path inside a bar, shorting and margin. Market orders here always fill at the next bar&rsquo;s open, in regular hours only, whatever Data &amp; Settings says, and Strict Mode is off.
          </p>
          <div className="row wrap">
            <SourceBadge source={provider.source} />
            {providerId === 'demo' && <span className="small muted">Synthetic data: results show how the rules behave, not how they would have done on the real ticker.</span>}
            <div className="spacer" />
            {validation && <span className="small warn">{validation}</span>}
            {running && (
              <span className="small muted">
                {running}
                {progress && ` ${progress}`}
              </span>
            )}
            {/* One button that turns into Cancel while running, so keyboard focus stays on it. */}
            <button
              className={running ? 'btn' : 'btn primary'}
              disabled={!running && !!validation}
              onClick={running ? cancel : runPressed}
              onKeyDown={(e) => {
                if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
              }}
            >
              {running ? 'Cancel' : 'Run backtest'}
            </button>
          </div>
          {error && <div className="alert error">{error}</div>}
          <div className="sr-only" role="alert">
            {error ?? ''}
          </div>
          <div className="sr-only" role="status">
            {running ?? announce}
          </div>
        </div>

        {!result ? (
          <EmptyState title="No results yet">Pick a preset or build your own rules, then run the backtest.</EmptyState>
        ) : (
          <div className="card stack">
            <div className="row wrap">
              <h2>Results</h2>
              <SourceBadge source={result.source} />
              <span className="small muted">{result.label}</span>
            </div>
            <div className="small muted">
              {result.rules.map((r, i) => (
                <div key={i}>{r}</div>
              ))}
            </div>
            {result.r.warnings.map((w, i) => (
              <div key={i} className="alert warn">
                {w}
              </div>
            ))}
            <div className="row wrap small">
              <span>
                Strategy return <b className={pnlClass(result.r.stats.totalReturnPct)}>{result.r.stats.totalReturnPct.toFixed(2)}%</b>
              </span>
              <span>
                Buy &amp; hold <b className={pnlClass(result.r.benchmarkReturnPct)}>{result.r.benchmarkReturnPct.toFixed(2)}%</b>
              </span>
              <span className="muted">
                {result.r.barsProcessed.toLocaleString('en-US')} bars · {result.r.signals.length} signals
              </span>
            </div>
            <StatsGrid s={result.r.stats} />
            <h3>Equity vs buy &amp; hold</h3>
            {/* Fitted to its width when drawn, so drawn only while the page shows. */}
            {result.r.equityCurve.length <= 1 ? <p className="muted small">No equity changes.</p> : active ? <LineChart lines={equityLines} height={240} format={money} /> : <div style={{ height: 240 }} />}
            <h3>Trades on chart</h3>
            <ResultChart result={result.r} timeframe={result.tf} panel={panel} active={active} />
            <div className="tabs">
              <button className={tab === 'trades' ? 'on' : ''} aria-pressed={tab === 'trades'} onClick={() => setTab('trades')}>
                Trades <span className="count">{result.r.trades.length}</span>
              </button>
              <button className={tab === 'signals' ? 'on' : ''} aria-pressed={tab === 'signals'} onClick={() => setTab('signals')}>
                Signals <span className="count">{result.r.signals.length}</span>
              </button>
            </div>
            <div style={{ maxHeight: 420, overflow: 'auto' }}>
              {tab === 'trades' ? <TradesTable trades={result.r.trades} /> : <SignalsTable signals={result.r.signals} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

