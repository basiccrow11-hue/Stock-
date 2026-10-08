/** Bottom dock: positions, working orders, fills, closed trades, simulated news and the broker log. */
import { useState } from 'react';
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

  return (
    <div className="panel area-bottom">
      <div className="tabs">
        {tabs
          .filter((t) => !t.hide)
          .map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
              {t.count ? <span className="count">{t.count}</span> : null}
            </button>
          ))}
        <div className="spacer" />
        {tab === 'orders' && working.length > 0 && (
          <button className="btn sm danger" onClick={cancelAllOrders}>
            Cancel all
          </button>
        )}
      </div>
      <div className="panel-body">
        {!session ? (
          <EmptyState title="No active session">Start a replay or the simulated market to trade.</EmptyState>
        ) : tab === 'positions' ? (
          <PositionsTab />
        ) : tab === 'orders' ? (
          <OrdersTab orders={orders} />
        ) : tab === 'history' ? (
          <FillsTab />
        ) : tab === 'trades' ? (
          <TradesTab onOpenJournal={onOpenJournal} />
        ) : tab === 'news' ? (
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

function OrderPriceEditor({ order }: { order: Order }) {
  const field: 'limitPrice' | 'stopPrice' | null = order.type === 'limit' || (order.type === 'stop_limit' && order.triggered) ? 'limitPrice' : order.type === 'market' ? null : 'stopPrice';
  const current = field ? order[field] : undefined;
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState<string>('');
  if (!field || current === undefined) return <>{order.type === 'market' ? 'MKT' : '—'}</>;
  if (!editing)
    return (
      <span
        className="mono"
        title="Click to modify"
        style={{ cursor: 'pointer', borderBottom: '1px dashed var(--muted)' }}
        onClick={() => {
          setVal(String(current));
          setEditing(true);
        }}
      >
        {price(current)}
      </span>
    );
  const commit = () => {
    const n = Number(val);
    setEditing(false);
    if (!Number.isFinite(n) || n <= 0 || n === current) return;
    const r = modifyOrder(order.id, { [field]: n });
    if (!r.ok) toast('error', r.error ?? 'Modify failed');
  };
  return (
    <input
      autoFocus
      type="number"
      step="0.01"
      value={val}
      style={{ width: 90 }}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setEditing(false);
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
      <div className="row" style={{ padding: '4px 8px' }}>
        <label className="check">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show filled, cancelled and rejected
        </label>
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
                <td className="num">{isOpen(o) ? <OrderPriceEditor order={o} /> : orderPriceText(o)}</td>
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
          const has = entries.some((e) => e.id === entryId);
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
              <td>{t.tag || <span className="muted">—</span>}</td>
              <td className="num">
                {has && (
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

