/** Open positions, compactly, for the right column (the full table is in the bottom panel). */
import { useId } from 'react';
import { closePosition, setActiveSymbol, useTrading } from '../state/tradingStore';
import { toast } from '../state/toasts';
import { price, pnlClass, qty, signedMoney } from '../services/format';

/**
 * Close a position at market from a positions list. Outside regular hours the order waits for the
 * open, which is said, as is any note (the rest of an entry still filling is cancelled, say).
 */
export function closeFromList(symbol: string): void {
  const r = closePosition(symbol);
  if (!r.ok) toast('error', r.error ?? 'Could not close position');
  else if (r.order?.status === 'pending') toast('info', r.warnings[r.warnings.length - 1] ?? 'Close order queued until the market is open.');
  for (const n of r.notes ?? []) toast('info', n, 6000);
}

/**
 * One line per open position: pick it to chart and trade that symbol (the order ticket then shows it),
 * or close it at market. Nothing is shown while flat.
 */
export function PositionList() {
  const positions = useTrading((s) => s.positions);
  const quotes = useTrading((s) => s.quotes);
  const active = useTrading((s) => s.activeSymbol);
  const titleId = useId();
  if (!positions.length) return null;
  return (
    <section className="pos-mini" aria-labelledby={titleId}>
      <h3 id={titleId}>
        Open positions <span className="muted">({positions.length})</span>
      </h3>
      {positions.map((p) => {
        const last = quotes[p.symbol]?.last ?? p.avgPrice;
        const upl = (last - p.avgPrice) * p.quantity;
        const long = p.quantity > 0;
        return (
          <div key={p.symbol} className={`pos-mini-row${p.symbol === active ? ' on' : ''}`}>
            {/* A button, as in the watchlist: Enter switches the symbol (Space plays and pauses). */}
            <button type="button" className="pos-mini-pick" aria-pressed={p.symbol === active} onClick={() => setActiveSymbol(p.symbol)} title={`Chart and trade ${p.symbol}`}>
              <b>{p.symbol}</b>
              <span className={`badge ${long ? 'pos' : 'neg'}`}>
                <span aria-hidden="true">{long ? 'L' : 'S'}</span>
                <span className="sr-only">{long ? 'long' : 'short'}</span> {qty(Math.abs(p.quantity))}
              </span>
              <span className="muted mono small">@ {price(p.avgPrice)}</span>
              <span className={`mono small pos-mini-pnl ${pnlClass(upl)}`}>{signedMoney(upl)}</span>
            </button>
            <button type="button" className="btn sm ghost" aria-label={`Close ${p.symbol} position at market`} title="Close at market" onClick={() => closeFromList(p.symbol)}>
              Close
            </button>
          </div>
        );
      })}
    </section>
  );
}
