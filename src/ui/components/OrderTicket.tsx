import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrderAction, OrderType, TimeInForce } from '../../core/types';
import { assessRisk, positionSizeForRisk } from '../../core/risk/risk';
import { commissionFor, halfSpread } from '../../core/broker/config';
import { marketSession } from '../../core/time';
import { closePosition, setPickTarget, submitOrder, useTrading } from '../state/tradingStore';
import { useSettings } from '../state/settingsStore';
import { toast } from '../state/toasts';
import { money, pct, price as fmtPrice, qty as fmtQty, signedMoney, pnlClass } from '../services/format';
import { modalOpen, useFocusRescue } from './common';

const ACTIONS: { a: OrderAction; label: string; cls: string }[] = [
  { a: 'buy', label: 'Buy', cls: 'buy' },
  { a: 'sell', label: 'Sell', cls: 'sell' },
  { a: 'short', label: 'Short', cls: 'sell' },
  { a: 'cover', label: 'Cover', cls: 'buy' },
];

const TYPES: { t: OrderType; label: string }[] = [
  { t: 'market', label: 'Market' },
  { t: 'limit', label: 'Limit' },
  { t: 'stop', label: 'Stop' },
  { t: 'stop_limit', label: 'Stop limit' },
];

type PriceField = 'limit' | 'stop' | 'stopLoss' | 'takeProfit';

function parse(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) && n > 0 ? n : undefined;
}

export function OrderTicket() {
  const session = useTrading((s) => s.session);
  const symbol = useTrading((s) => s.activeSymbol);
  const quote = useTrading((s) => s.quotes[s.activeSymbol]);
  const account = useTrading((s) => s.account);
  const positions = useTrading((s) => s.positions);
  const picked = useTrading((s) => s.pickedPrice);
  const pickTarget = useTrading((s) => s.pickTarget);
  const now = useTrading((s) => s.now);
  const exec = useSettings((s) => s.execution);
  const rules = useSettings((s) => s.rules);
  // Close position removes its own box once the position is flat: focus goes to the chosen order side.
  const ticketRef = useFocusRescue<HTMLDivElement>((t) => t.querySelector<HTMLElement>('[aria-label="Order side"] button[aria-pressed="true"]'));

  const [action, setAction] = useState<OrderAction>('buy');
  const [type, setType] = useState<OrderType>('market');
  const [quantity, setQuantity] = useState('100');
  const [limit, setLimit] = useState('');
  const [stop, setStop] = useState('');
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [tif, setTif] = useState<TimeInForce>('day');
  const [ext, setExt] = useState(false);
  const [tag, setTag] = useState('');
  const [riskPct, setRiskPct] = useState(String(rules.maxRiskPctPerTrade));
  const [result, setResultState] = useState<{ tone: 'error' | 'success'; text: string; n: number } | null>(null);
  const resultSeq = useRef(0);
  const setResult = (r: { tone: 'error' | 'success'; text: string } | null) => setResultState(r && { ...r, n: ++resultSeq.current });

  const position = positions.find((p) => p.symbol === symbol);
  const last = quote?.last;
  const opening = action === 'buy' || action === 'short';

  useEffect(() => {
    if (!picked) return;
    const v = picked.price.toFixed(2);
    if (picked.field === 'limit') setLimit(v);
    if (picked.field === 'stop') setStop(v);
    if (picked.field === 'stopLoss') setSl(v);
    if (picked.field === 'takeProfit') setTp(v);
  }, [picked]);

  useEffect(() => {
    // Works from the ticket's own fields too; only an Escape that closed a dialog or menu is left alone.
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !modalOpen() && !e.defaultPrevented && setPickTarget(null);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // A new session (the ticket stays mounted) starts without the last session's order result.
  const sessionId = session?.id;
  useEffect(() => setResult(null), [symbol, action, type, sessionId]);
  // The result sits below the submit button, which can be at the bottom edge of a scrolled panel.
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (result) resultRef.current?.scrollIntoView({ block: 'nearest' });
  }, [result]);

  // Stop and target prices only make sense for one direction, one symbol and one session: clear them when any changes.
  const direction = action === 'buy' || action === 'sell' ? 'long' : 'short';
  useEffect(() => {
    setSl('');
    setTp('');
  }, [symbol, direction, sessionId]);
  // So do limit and stop prices, for one symbol and one session (not the side: a level can be bought or sold).
  useEffect(() => {
    setLimit('');
    setStop('');
  }, [symbol, sessionId]);

  // Estimated fill price used for risk math.
  const entry = useMemo(() => {
    if (type === 'limit' || type === 'stop_limit') return parse(limit);
    if (type === 'stop') return parse(stop);
    if (last === undefined) return undefined;
    const ext = now ? marketSession(now) !== 'regular' : false;
    const hs = halfSpread(exec, last, ext);
    return action === 'buy' || action === 'cover' ? last + hs : last - hs;
  }, [type, limit, stop, last, action, exec, now]);

  const q = Math.floor(Number(quantity) || 0);
  const risk = useMemo(() => {
    if (!entry || !account || q <= 0) return null;
    return assessRisk({ action, quantity: q, entryPrice: entry, stopLoss: opening ? parse(sl) : undefined, takeProfit: opening ? parse(tp) : undefined, equity: account.equity, commissionEstimate: commissionFor(exec, q, entry) });
  }, [entry, account, q, action, opening, sl, tp, exec]);

  if (!session) return null;

  const sizeByRisk = () => {
    const stopPx = parse(sl);
    const r = Number(riskPct);
    if (!entry || !stopPx || !account || !(r > 0)) {
      toast('warning', 'Set a stop loss (and entry price for non-market orders) first. Position size = risk ÷ stop distance.');
      return;
    }
    const n = positionSizeForRisk(account.equity, r, entry, stopPx);
    if (n <= 0) {
      toast('warning', 'Stop is on the wrong side or too close to the entry.');
      return;
    }
    // A tight stop can imply more shares than the account can hold; cap at buying power (with a small buffer for spread and slippage).
    const affordable = Math.floor((account.buyingPower * 0.995) / entry);
    if (affordable < n) toast('info', `${r}% risk would need ${n} shares, but buying power covers ${affordable}. Sized to ${affordable}; actual risk is lower.`, 6000);
    setQuantity(String(Math.max(0, Math.min(n, affordable))));
  };

  const targetFromR = (mult: number) => {
    const stopPx = parse(sl);
    if (!entry || !stopPx) return;
    const d = Math.abs(entry - stopPx);
    const long = action === 'buy';
    setTp((long ? entry + d * mult : entry - d * mult).toFixed(2));
  };

  const submit = () => {
    const r = submitOrder({
      symbol,
      action,
      type,
      quantity: q,
      limitPrice: type === 'limit' || type === 'stop_limit' ? parse(limit) : undefined,
      stopPrice: type === 'stop' || type === 'stop_limit' ? parse(stop) : undefined,
      stopLoss: opening ? parse(sl) : undefined,
      takeProfit: opening ? parse(tp) : undefined,
      tif,
      extendedHours: ext && type === 'limit',
      tag: tag.trim() || undefined,
    });
    if (!r.ok) {
      setResult({ tone: 'error', text: r.error ?? 'Rejected' });
      return;
    }
    const o = r.order!;
    const name = `${action.toUpperCase()} ${q} ${symbol}`;
    // Fills are capped by each bar's volume, so a large order can fill in pieces: say how far it got.
    const text =
      o.filledQty >= o.quantity
        ? `${name} filled.`
        : o.filledQty > 0
          ? `${name}: ${o.filledQty} filled, ${o.quantity - o.filledQty} ${o.status === 'partially_filled' ? 'still working' : o.status}.`
          : `${name} ${o.status === 'pending' ? 'queued' : 'working'}.${r.warnings.length ? ` ${r.warnings[r.warnings.length - 1]}` : ''}`;
    setResult({ tone: 'success', text: [text, ...(r.notes ?? [])].join(' ') });
    // The last warning is shown in the ticket itself; risk warnings were already visible before submitting.
    for (const w of r.warnings.slice(0, -1)) if (!w.startsWith('No stop loss')) toast('warning', w, 6000);
  };

  /** Close at market, with the same feedback as an order: outside regular hours it waits for the open. */
  const closeNow = () => {
    const r = closePosition(symbol);
    if (!r.ok) {
      setResult({ tone: 'error', text: r.error ?? 'Could not close the position.' });
      return;
    }
    const o = r.order!;
    const done = o.action === 'sell' ? 'sold' : 'bought back';
    const text =
      o.filledQty >= o.quantity
        ? `${symbol} position closed.`
        : o.filledQty > 0
          ? `Close order for ${symbol}: ${o.filledQty} of ${o.quantity} ${done}, the rest is still working.`
          : `Close order for ${symbol} ${o.status === 'pending' ? 'queued' : 'working'}.${r.warnings.length ? ` ${r.warnings[r.warnings.length - 1]}` : ''}`;
    setResult({ tone: 'success', text: [text, ...(r.notes ?? [])].join(' ') });
  };

  /** Pick-from-chart button. The field's input carries its own name, so the button's never joins it. */
  const pickBtn = (field: PriceField, name: string) => (
    <button
      className={`btn sm${pickTarget === field ? ' active' : ''}`}
      title="Pick price from chart"
      aria-label={`Pick ${name} from chart`}
      aria-pressed={pickTarget === field}
      onClick={() => setPickTarget(pickTarget === field ? null : field)}
    >
      <span aria-hidden="true">⌖</span>
    </button>
  );

  const actCls = ACTIONS.find((x) => x.a === action)!.cls;
  const label = `${action.toUpperCase()} ${q || 0} ${symbol} ${type === 'market' ? 'MKT' : type === 'limit' ? `LMT ${limit || '—'}` : type === 'stop' ? `STP ${stop || '—'}` : `STP ${stop || '—'} LMT ${limit || '—'}`}`;
  const strict = exec.strictRisk.enabled;

  return (
    <div className="ticket" ref={ticketRef}>
      <div className="row">
        <h3>Order ticket</h3>
        <div className="spacer" />
        <span className="mono">{fmtPrice(last)}</span>
      </div>
      <div className="actions" role="group" aria-label="Order side">
        {ACTIONS.map((x) => (
          <button key={x.a} className={`btn sm ${action === x.a ? `${x.cls} sel` : ''}`} aria-pressed={action === x.a} onClick={() => setAction(x.a)}>
            {x.label}
          </button>
        ))}
      </div>
      <div className="seg" style={{ width: '100%' }} role="group" aria-label="Order type">
        {TYPES.map((x) => (
          <button key={x.t} className={type === x.t ? 'on' : ''} aria-pressed={type === x.t} style={{ flex: 1 }} onClick={() => setType(x.t)}>
            {x.label}
          </button>
        ))}
      </div>
      <div className="grid2">
        <label className="field">
          Quantity (shares)
          <input type="number" min={1} step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </label>
        <label className="field">
          Time in force
          <select value={tif} onChange={(e) => setTif(e.target.value as TimeInForce)}>
            <option value="day">Day</option>
            <option value="gtc">GTC</option>
          </select>
        </label>
        {(type === 'stop' || type === 'stop_limit') && (
          <label className="field">
            Stop (trigger) price
            <span className="price-input">
              <input type="number" step={0.01} value={stop} onChange={(e) => setStop(e.target.value)} placeholder={fmtPrice(last)} aria-label="Stop (trigger) price" />
              {pickBtn('stop', 'stop price')}
            </span>
          </label>
        )}
        {(type === 'limit' || type === 'stop_limit') && (
          <label className="field">
            Limit price
            <span className="price-input">
              <input type="number" step={0.01} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder={fmtPrice(last)} aria-label="Limit price" />
              {pickBtn('limit', 'limit price')}
            </span>
          </label>
        )}
        {opening && (
          <>
            <label className="field">
              Stop loss
              <span className="price-input">
                <input type="number" step={0.01} value={sl} onChange={(e) => setSl(e.target.value)} placeholder="optional" aria-label="Stop loss" />
                {pickBtn('stopLoss', 'stop loss')}
              </span>
            </label>
            <label className="field">
              Take profit
              <span className="price-input">
                <input type="number" step={0.01} value={tp} onChange={(e) => setTp(e.target.value)} placeholder="optional" aria-label="Take profit" />
                {pickBtn('takeProfit', 'take profit')}
              </span>
            </label>
          </>
        )}
      </div>
      {opening && (
        <div className="row" style={{ gap: 4 }}>
          <span className="muted small">Size for</span>
          <input type="number" step={0.25} min={0.05} value={riskPct} onChange={(e) => setRiskPct(e.target.value)} style={{ width: 58 }} aria-label="Risk per trade, percent of account" />
          <span className="muted small">% risk</span>
          <button className="btn sm" onClick={sizeByRisk}>
            Size
          </button>
          <span className="spacer" />
          <span className="muted small">TP</span>
          {[1, 2, 3].map((m) => (
            <button key={m} className="btn sm" onClick={() => targetFromR(m)} title={`Set take profit at ${m}× the stop distance`}>
              {m}R
            </button>
          ))}
        </div>
      )}
      <div className="row wrap" style={{ gap: 10 }}>
        <label className="check small" title="Limit orders only. Fills use wider pre/post-market spreads.">
          <input type="checkbox" checked={ext} disabled={type !== 'limit'} onChange={(e) => setExt(e.target.checked)} />
          Extended hours
        </label>
        <input type="text" placeholder="Strategy / setup tag" value={tag} onChange={(e) => setTag(e.target.value)} style={{ flex: 1 }} />
      </div>

      <div className="risk-box">
        <span className="muted">Est. entry</span>
        <span className="num">{fmtPrice(entry)}</span>
        <span className="muted">Position value</span>
        <span className="num">{money(risk?.positionValue)}</span>
        {opening && (
          <>
            <span className="muted">Stop distance</span>
            <span className="num">{risk?.stopDistance !== null && risk ? `${risk.stopDistance.toFixed(2)} (${pct(risk.stopDistancePct)})` : '—'}</span>
            <span className="muted">Dollar risk</span>
            <span className="num">{money(risk?.dollarRisk)}</span>
            <span className="muted">% of account</span>
            <span className={`num ${risk?.pctRisk && risk.pctRisk > rules.maxRiskPctPerTrade ? 'error' : ''}`}>{pct(risk?.pctRisk)}</span>
            <span className="muted">Potential reward</span>
            <span className="num">{money(risk?.reward)}</span>
            <span className="muted">Reward : risk</span>
            <span className="num">{risk?.rewardRiskRatio ? `${risk.rewardRiskRatio.toFixed(2)} : 1` : '—'}</span>
          </>
        )}
        <span className="muted">Est. commission</span>
        <span className="num">{entry && q > 0 ? money(commissionFor(exec, q, entry)) : '—'}</span>
      </div>
      {risk?.errors.map((e) => (
        <div key={e} className="alert error">
          {e}
        </div>
      ))}
      {risk?.warnings.map((w) => (
        <div key={w} className="alert warn">
          {w}
        </div>
      ))}
      {strict && opening && <div className="alert info">Strict risk controls are ON: max {exec.strictRisk.maxRiskPctPerTrade}% risk per trade{exec.strictRisk.requireStopLoss ? ', stop required' : ''}.</div>}
      <button className={`btn ${actCls}`} style={{ padding: '9px 10px', fontWeight: 600 }} onClick={submit} disabled={q <= 0 || !!risk?.errors.length}>
        {label}
      </button>
      {result && (
        <div ref={resultRef} className={`alert ${result.tone}`} aria-hidden="true">
          {result.text}
        </div>
      )}
      {/* Screen readers hear the outcome of every submit, the same message twice included. */}
      <div className="sr-only" role="status">
        {result && <span key={result.n}>{result.text}</span>}
      </div>

      {position && (
        <div className="risk-box" style={{ gridTemplateColumns: '1fr auto' }}>
          <span className="muted">Position</span>
          <span className={`num ${position.quantity > 0 ? 'pos' : 'neg'}`}>
            {position.quantity > 0 ? 'LONG' : 'SHORT'} {fmtQty(Math.abs(position.quantity))}
          </span>
          <span className="muted">Avg entry</span>
          <span className="num">{fmtPrice(position.avgPrice)}</span>
          <span className="muted">Unrealized P/L</span>
          <span className={`num ${pnlClass(last !== undefined ? (last - position.avgPrice) * position.quantity : 0)}`}>
            {last !== undefined ? signedMoney((last - position.avgPrice) * position.quantity) : '—'}
          </span>
          <span />
          <button className="btn sm" onClick={closeNow}>
            Close position (market)
          </button>
        </div>
      )}
    </div>
  );
}
