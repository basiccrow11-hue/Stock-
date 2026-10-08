import { useTrading, setActiveSymbol } from '../state/tradingStore';
import { pct, price } from '../services/format';
import { EmptyState } from './common';

export function Watchlist() {
  const session = useTrading((s) => s.session);
  const quotes = useTrading((s) => s.quotes);
  const active = useTrading((s) => s.activeSymbol);
  const positions = useTrading((s) => s.positions);

  return (
    <section className="panel area-watch">
      <div className="panel-head">
        <h3>Watchlist</h3>
        <div className="spacer" />
        {session && <span className="muted small">{session.symbols.length} symbols</span>}
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        {!session && <EmptyState title="No session">Start a replay or the simulated market to see prices.</EmptyState>}
        {session?.symbols.map((sym) => {
          const q = quotes[sym];
          const pos = positions.find((p) => p.symbol === sym);
          return (
            <div key={sym} className={`watch-row${sym === active ? ' on' : ''}`} onClick={() => setActiveSymbol(sym)}>
              <div>
                <div className="sym">
                  {sym} {pos && <span className={`badge ${pos.quantity > 0 ? 'pos' : 'neg'}`} style={{ padding: '0 5px' }}>{pos.quantity > 0 ? 'L' : 'S'} {Math.abs(pos.quantity)}</span>}
                </div>
              </div>
              <div className="px">
                <div>{q ? price(q.last) : '—'}</div>
                <div className={`small ${q?.changePct ? (q.changePct >= 0 ? 'pos' : 'neg') : 'muted'}`}>{q?.changePct !== null && q?.changePct !== undefined ? pct(q.changePct, 2, true) : '—'}</div>
              </div>
            </div>
          );
        })}
        {session?.mode === 'replay' && (
          <p className="muted small" style={{ padding: '8px 10px' }}>
            All symbols here replay on the same clock. Click one to chart and trade it. Change the list in Data &amp; Settings.
          </p>
        )}
      </div>
    </section>
  );
}
