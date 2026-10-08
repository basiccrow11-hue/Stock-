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
            // A button, so the symbol can be switched from the keyboard (Enter; Space plays and pauses,
            // as on every button of the trade screen).
            <button key={sym} type="button" className={`watch-row${sym === active ? ' on' : ''}`} aria-pressed={sym === active} onClick={() => setActiveSymbol(sym)}>
              <span className="sym">
                {sym} {pos && <span className={`badge ${pos.quantity > 0 ? 'pos' : 'neg'}`} style={{ padding: '0 5px' }}>{pos.quantity > 0 ? 'L' : 'S'} {Math.abs(pos.quantity)}</span>}
              </span>
              <span className="px">
                <span>{q ? price(q.last) : '—'}</span>
                <span className={`small ${q?.changePct ? (q.changePct >= 0 ? 'pos' : 'neg') : 'muted'}`}>{q?.changePct !== null && q?.changePct !== undefined ? pct(q.changePct, 2, true) : '—'}</span>
              </span>
            </button>
          );
        })}
        {session?.mode === 'replay' && (
          <p className="muted small" style={{ padding: '8px 10px' }}>
            All symbols here replay on the same clock. Click one (or Tab to it and press Enter) to chart and trade it. Change the list in Data &amp; Settings.
          </p>
        )}
      </div>
    </section>
  );
}
