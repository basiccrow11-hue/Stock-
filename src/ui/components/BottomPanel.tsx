/** Bottom dock: positions, working orders, fills, closed trades, simulated news and the broker log. */
import { useEffect, useRef, useState } from 'react';
import { blindDayLabel, cancelAllOrders, cancelOrder, closePosition, modifyOrder, setActiveSymbol, useTrading } from '../state/tradingStore';
import { isOpen } from '../../core/broker/SimBroker';
import type { Order } from '../../core/types';
import { EVENT_LABELS } from '../../core/sim/SimMarket';
import { useJournal } from '../state/journalStore';
import { EmptyState, rowAction } from './common';
import { dateTime, money, pnlClass, price, qty, signedMoney } from '../services/format';
import { formatDuration, formatExchangeTime } from '../../core/time';
import { toast } from '../state/toasts';

type Tab = 'positions' | 'orders' | 'history' | 'trades' | 'news' | 'log';

function useTimeLabel(): (t: number) => string {
  const blind = useTrading((s) => s.session?.blind ?? false);
  return (t: number) => (blind ? `${blindDayLabel(t)} ${formatExchangeTime(t)}` : dateTime(t));
}

export function BottomPanel({ onOpenJournal }: { onOpenJournal: (entryId: string) => void }) {
  const [tab, setTab] = useState<Tab>('positions');
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<Element | null>(null);
  // A focused control that disappears (its order filled or was cancelled, its position closed)
  // hands focus to the open tab rather than dropping it on the page body. Children run their effects
  // first, so a control that takes focus back itself (the order price) wins.
  useEffect(() => {
    const el = lastFocus.current;
    if (el && !el.isConnected && (document.activeElement === document.body || !document.activeElement)) {
      lastFocus.current = null;
      panelRef.current?.querySelector<HTMLButtonElement>('.tabs button.on')?.focus();
    }
  });
  const positions = useTrading((s) => s.positions);
  const orders = useTrading((s) => s.orders);
  const fills = useTrading((s) => s.fills);
  const trips = useTrading((s) => s.trips);
  const session = useTrading((s) => s.session);
  const simEvents = useTrading((s) => s.simEvents);
  const working = orders.filter(isOpen);
  const closed = trips.filter((t) => t.closed);

  const tabs: { id: Tab; label: string; count?: number; hide?: boolean }[] = [
    { id: 'positions', label: 'Positions', count: positions.length },
    { id: 'orders', label: 'Orders', count: working.length },
    { id: 'history', label: 'Fills', count: fills.length },
    { id: 'trades', label: 'Closed trades', count: closed.length },
    { id: 'news', label: 'News (simulated)', count: simEvents.length, hide: session?.mode !== 'sim' },
    { id: 'log', label: 'Activity log' },
  ];
  // A tab that went away (News, when a replay replaces the simulated market) falls back to Positions.
  const shown: Tab = tabs.some((t) => t.id === tab && !t.hide) ? tab : 'positions';

  return (
    <div className="panel area-bottom" ref={panelRef} onFocus={(e) => (lastFocus.current = e.target)}>
      <div className="tabs">
        {tabs
          .filter((t) => !t.hide)
          .map((t) => (
            <button key={t.id} className={shown === t.id ? 'on' : ''} aria-pressed={shown === t.id} onClick={() => setTab(t.id)}>
              {t.label}
              {t.count ? <span className="count">{t.count}</span> : null}
            </button>
          ))}
      </div>
      <div className="panel-body">
        {!session ? (
          <EmptyState title="No active session">Start a replay or the simulated market to trade.</EmptyState>
        ) : shown === 'positions' ? (
          <PositionsTab />
        ) : shown === 'orders' ? (
          <OrdersTab orders={orders} />
        ) : shown === 'history' ? (
          <FillsTab />
        ) : shown === 'trades' ? (
          <TradesTab onOpenJournal={onOpenJournal} />
        ) : shown === 'news' ? (
          <NewsTab />
        ) : (
          <LogTab />
        )}
      </div>
    </div>
  );
}

function PositionsTab() {
  const positions = useTrading((s) => s.positions);
  const quotes = useTrading((s) => s.quotes);
  const orders = useTrading((s) => s.orders);
  const activeSymbol = useTrading((s) => s.activeSymbol);
  if (!positions.length) return <EmptyState title="No open positions" />;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Side</th>
          <th className="num">Qty</th>
          <th className="num">Avg entry</th>
          <th className="num">Last</th>
          <th className="num">Market value</th>
          <th className="num">Unrealized P/L</th>
          <th className="num">%</th>
          <th className="num">Stop</th>
          <th className="num">Target</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => {
          const last = quotes[p.symbol]?.last ?? p.avgPrice;
          const upl = (last - p.avgPrice) * p.quantity;
          const pctMove = ((last - p.avgPrice) / p.avgPrice) * 100 * Math.sign(p.quantity);
          const exits = orders.filter((o) => isOpen(o) && o.symbol === p.symbol && (o.action === 'sell' || o.action === 'cover'));
          const stop = exits.find((o) => o.type === 'stop' || o.type === 'stop_limit')?.stopPrice;
          const target = exits.find((o) => o.type === 'limit')?.limitPrice;
          return (
            <tr key={p.symbol} className="clickable" {...rowAction(() => setActiveSymbol(p.symbol), false)} aria-current={p.symbol === activeSymbol ? 'true' : undefined}>
              <td>
                <b>{p.symbol}</b>
              </td>
              <td className={p.quantity > 0 ? 'pos' : 'neg'}>{p.quantity > 0 ? 'LONG' : 'SHORT'}</td>
              <td className="num">{qty(Math.abs(p.quantity))}</td>
              <td className="num">{price(p.avgPrice)}</td>
              <td className="num">{price(last)}</td>
              <td className="num">{money(last * p.quantity)}</td>
              <td className={`num ${pnlClass(upl)}`}>{signedMoney(upl)}</td>
              <td className={`num ${pnlClass(pctMove)}`}>{pctMove.toFixed(2)}%</td>
              <td className="num">{stop !== undefined ? price(stop) : <span className="warn">none</span>}</td>
              <td className="num">{target !== undefined ? price(target) : '—'}</td>
              <td className="num">
                <button
                  className="btn sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = closePosition(p.symbol);
                    if (!r.ok) toast('error', r.error ?? 'Could not close position');
                    else if (r.order?.status === 'pending') toast('info', r.warnings[r.warnings.length - 1] ?? 'Close order queued until the market is open.');
                  }}
                >
                  Close
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

type PriceField = 'limitPrice' | 'stopPrice';

/** The working order's prices, each a button that edits it. A stop-limit shows both legs. */
function OrderPrices({ order }: { order: Order }) {
  if (order.type === 'market') return <>MKT</>;
  if (order.type === 'limit') return <OrderPriceEditor order={order} field="limitPrice" />;
  if (order.type === 'stop') return <OrderPriceEditor order={order} field="stopPrice" />;
  return (
    <span className="price-legs">
      <span className="muted small">STP</span>
      {/* Once triggered the stop is history and only the limit can change. */}
      <OrderPriceEditor order={order} field="stopPrice" done={order.triggered} />
      <span className="muted small">LMT</span>
      <OrderPriceEditor order={order} field="limitPrice" />
    </span>
  );
}

function OrderPriceEditor({ order, field, done = false }: { order: Order; field: PriceField; done?: boolean }) {
  const current = order[field];
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState<string>('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter and Escape hand focus back to the price; leaving the box by clicking elsewhere does not.
  const refocus = useRef(false);
  /** The typed value no longer applies, so the blur that closes the box must not save it. */
  const discard = useRef(false);
  useEffect(() => {
    if (editing && done) {
      // A stop-limit's stop triggered while its stop was being edited: the typed stop no longer
      // applies. Focus moves on to the limit price, which can still be changed.
      const input = inputRef.current;
      discard.current = true;
      setEditing(false);
      if (input && document.activeElement === input) input.closest('.price-legs')?.querySelector<HTMLButtonElement>('button.price-edit')?.focus();
      toast('warning', `${order.symbol} stop triggered while you were editing it, so the change was not applied. The order is now a limit at ${price(order.limitPrice)}.`, 7000);
    }
  }, [editing, done, order.symbol, order.limitPrice]);
  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      buttonRef.current?.focus();
    }
  }, [editing]);
  if (current === undefined) return <>—</>;
  const what = `${order.symbol} ${order.action} ${field === 'limitPrice' ? 'limit' : 'stop'} price`;
  // While the box is open, the effect above closes it first (dropping the typed value).
  if (done && !editing) return <span className="mono">{price(current)}</span>;
  if (!editing)
    return (
      <button
        ref={buttonRef}
        type="button"
        className="price-edit mono"
        title="Change price"
        aria-label={`Change ${what}, now ${price(current)}`}
        onClick={() => {
          setVal(String(current));
          discard.current = false;
          setEditing(true);
        }}
      >
        {price(current)}
      </button>
    );
  const commit = () => {
    const n = Number(val);
    setEditing(false);
    if (discard.current) return;
    if (!Number.isFinite(n) || n <= 0 || n === current) return;
    const r = modifyOrder(order.id, { [field]: n });
    if (!r.ok) toast('error', r.error ?? 'Modify failed');
  };
  return (
    <input
      ref={inputRef}
      autoFocus
      type="number"
      step="0.01"
      value={val}
      aria-label={`New ${what}`}
      style={{ width: 90 }}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          // Without this the same Enter would also press the price button that takes focus back.
          e.preventDefault();
          refocus.current = true;
          commit();
        }
        if (e.key === 'Escape') {
          refocus.current = true;
          setEditing(false);
        }
      }}
    />
  );
}

function orderPriceText(o: Order): string {
  if (o.type === 'market') return 'MKT';
  if (o.type === 'limit') return price(o.limitPrice);
  if (o.type === 'stop') return `stop ${price(o.stopPrice)}`;
  return `${price(o.stopPrice)} / ${price(o.limitPrice)}`;
}

function OrdersTab({ orders }: { orders: Order[] }) {
  const [showAll, setShowAll] = useState(false);
  const time = useTimeLabel();
  const list = (showAll ? orders : orders.filter(isOpen)).slice().reverse();
  return (
    <>
      <div className="row wrap" style={{ padding: '4px 8px' }}>
        <label className="check">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show filled, cancelled and rejected
        </label>
        <div className="spacer" />
        {orders.some(isOpen) && (
          <button className="btn sm danger" onClick={cancelAllOrders}>
            Cancel all
          </button>
        )}
      </div>
      {!list.length ? (
        <EmptyState title={showAll ? 'No orders yet' : 'No working orders'} />
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Time</th>
              <th>Symbol</th>
              <th>Action</th>
              <th>Type</th>
              <th className="num">Qty</th>
              <th className="num">Filled</th>
              <th className="num">Price</th>
              <th>TIF</th>
              <th>Status</th>
              <th>Detail</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.id}>
                <td className="mono">{time(o.createdAt)}</td>
                <td>{o.symbol}</td>
                <td className={o.action === 'buy' || o.action === 'cover' ? 'pos' : 'neg'}>{o.action.toUpperCase()}</td>
                <td>
                  {o.type.replace('_', '-')}
                  {o.parentId ? <span className="muted"> (bracket)</span> : null}
                </td>
                <td className="num">{qty(o.quantity)}</td>
                <td className="num">{o.filledQty ? `${qty(o.filledQty)} @ ${price(o.avgFillPrice)}` : '—'}</td>
                <td className="num">{isOpen(o) ? <OrderPrices order={o} /> : orderPriceText(o)}</td>
                <td>{o.tif.toUpperCase()}</td>
                <td>
                  <span className={`badge ${o.status === 'filled' ? 'success' : o.status === 'rejected' ? 'error' : o.status === 'pending' ? 'warn' : 'neutral'}`}>{o.status.replace('_', ' ')}</span>
                </td>
                <td className="muted small">{o.rejectReason ?? (o.status === 'pending' ? 'Waits for the session to open' : o.type === 'stop_limit' && o.triggered ? 'Stop triggered' : '')}</td>
                <td className="num">
                  {isOpen(o) && (
                    <button className="btn sm ghost" onClick={() => cancelOrder(o.id)}>
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function FillsTab() {
  const fills = useTrading((s) => s.fills);
  const time = useTimeLabel();
  if (!fills.length) return <EmptyState title="No fills yet" />;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Time</th>
          <th>Symbol</th>
          <th>Action</th>
          <th className="num">Qty</th>
          <th className="num">Price</th>
          <th className="num">Spread cost</th>
          <th className="num">Slippage</th>
          <th className="num">Commission</th>
          <th className="num">Realized P/L</th>
        </tr>
      </thead>
      <tbody>
        {fills
          .slice()
          .reverse()
          .map((f) => (
            <tr key={f.id}>
              <td className="mono">{time(f.time)}</td>
              <td>{f.symbol}</td>
              <td className={f.side === 'buy' ? 'pos' : 'neg'}>{f.action.toUpperCase()}</td>
              <td className="num">{qty(f.quantity)}</td>
              <td className="num">{price(f.price)}</td>
              <td className="num">{money(f.spreadCost)}</td>
              <td className="num">{money(f.slippage)}</td>
              <td className="num">{money(f.commission)}</td>
              <td className={`num ${pnlClass(f.realizedPnl)}`}>{f.action === 'sell' || f.action === 'cover' ? signedMoney(f.realizedPnl) : '—'}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

function TradesTab({ onOpenJournal }: { onOpenJournal: (id: string) => void }) {
  const trips = useTrading((s) => s.trips);
  const session = useTrading((s) => s.session);
  const entries = useJournal((s) => s.entries);
  const time = useTimeLabel();
  const closed = trips.filter((t) => t.closed).reverse();
  if (!closed.length) return <EmptyState title="No closed trades in this session" />;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Side</th>
          <th>Entry</th>
          <th>Exit</th>
          <th className="num">Qty</th>
          <th className="num">Avg entry</th>
          <th className="num">Avg exit</th>
          <th className="num">P/L</th>
          <th>Held</th>
          <th>Tag</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {closed.map((t) => {
          const entryId = session ? `${session.id}:${t.id}` : '';
          const entry = entries.find((e) => e.id === entryId);
          // A tag set or changed in the review or the journal is stored on the journal entry.
          const tag = entry ? entry.tag : t.tag;
          return (
            <tr key={t.id}>
              <td>{t.symbol}</td>
              <td className={t.direction === 'long' ? 'pos' : 'neg'}>{t.direction.toUpperCase()}</td>
              <td className="mono">{time(t.entryTime)}</td>
              <td className="mono">{time(t.exitTime!)}</td>
              <td className="num">{qty(t.maxQuantity)}</td>
              <td className="num">{price(t.avgEntry)}</td>
              <td className="num">{price(t.avgExit)}</td>
              <td className={`num ${pnlClass(t.pnl)}`}>{signedMoney(t.pnl)}</td>
              <td>{formatDuration(t.exitTime! - t.entryTime)}</td>
              <td>{tag || <span className="muted">—</span>}</td>
              <td className="num">
                {entry && (
                  <button className="btn sm ghost" onClick={() => onOpenJournal(entryId)}>
                    Journal
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function NewsTab() {
  const events = useTrading((s) => s.simEvents);
  const time = useTimeLabel();
  if (!events.length) return <EmptyState title="No simulated news yet">Headlines appear here as the simulated market runs.</EmptyState>;
  return (
    <div>
      {events
        .slice()
        .reverse()
        .map((e) => (
          <div key={e.id} className="news-item">
            <span className="sim-tag">SIMULATED</span>
            <span className="mono muted">{time(e.time)}</span> <b>{e.symbol}</b> <span className="muted">· {EVENT_LABELS[e.type]}</span>
            <div>{e.headline}</div>
          </div>
        ))}
    </div>
  );
}

function LogTab() {
  const events = useTrading((s) => s.events);
  const time = useTimeLabel();
  if (!events.length) return <EmptyState title="Nothing logged yet" />;
  return (
    <table className="grid">
      <tbody>
        {events
          .slice()
          .reverse()
          .map((e, i) => (
            <tr key={i}>
              <td className="mono" style={{ width: 150 }}>
                {time(e.time)}
              </td>
              <td style={{ width: 90 }}>
                <span className={`badge ${e.kind === 'filled' ? 'success' : e.kind === 'rejected' ? 'error' : e.kind === 'partial' || e.kind === 'triggered' ? 'warn' : 'neutral'}`}>{e.kind}</span>
              </td>
              <td>{e.message}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

