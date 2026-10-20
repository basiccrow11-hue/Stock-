import { useEffect, useState } from 'react';
import { useTrading, setActiveSymbol, browseSymbol, browseHoldOn, browseLastClose, type LastClose } from '../state/tradingStore';
import { removeFromWatchlist, useSettings } from '../state/settingsStore';
import { csvProvider, getProvider, onCsvDatasetsChanged } from '../state/dataRegistry';
import { useCredentials } from '../state/credentials';
import { pct, price } from '../services/format';
import { EmptyState } from './common';
import { openSymbolSearch, sourceLabel } from './SymbolSearch';
import { SIM_STOCKS } from '../../core/sim/SimMarket';
import { DEMO_TICKERS } from '../../core/data/demoProvider';

/** The simulated market's companies by ticker: the watchlist names each one's kind of stock. */
const SIM_PROFILES = new Map(SIM_STOCKS.map((p) => [p.symbol, p]));

/**
 * The data source a watchlist symbol is charted from with no session. The watchlist keeps tickers only,
 * so this is worked out from what each source has: the chart's own source when it has the symbol (Polygon
 * and Alpaca, once their key is set, take any ticker), else the first that has it, in this order: your
 * imported data, the demo data, Polygon, Alpaca. When none has it, the chart's own, whose chart then
 * says it has no such symbol and how to get one.
 */
export function watchSource(symbol: string, current: string): string {
  const own = getProvider(current).id;
  return [own, 'csv', 'demo', 'polygon', 'alpaca'].find((id) => sourceHas(id, symbol)) ?? own;
}

/** Whether data source `id` can chart `symbol` now: set up, and listing it (Polygon and Alpaca take any ticker). */
function sourceHas(id: string, symbol: string): boolean {
  const p = getProvider(id);
  if (p.unavailableReason()) return false;
  if (p.id === 'demo') return DEMO_TICKERS.some((t) => t.symbol === symbol);
  if (p === csvProvider) return csvProvider.list().some((d) => d.symbol.toUpperCase() === symbol);
  return true;
}

/**
 * useLastCloses: each local row's last close (the demo's or imported data; Polygon and Alpaca are never
 * asked, as each would spend the visitor's rate limit), once worked out by browseLastClose. That gives none
 * for a symbol a replay not finished yet keeps the chart from (blind or not), so a row never shows a close
 * the chart beside it hides. Each is kept apart while one does, so a close worked out before a replay was
 * left unfinished is never shown once it is.
 */
function useLastCloses(rows: { symbol: string; source: string }[], csvVersion: number): Record<string, LastClose | null> {
  const holds = useTrading((s) => s.browse.holds);
  const [known, setKnown] = useState<Record<string, LastClose | null>>({});
  const local = rows.filter((r) => r.source === 'demo' || r.source === 'csv').map((r) => closeKey(r.source, r.symbol, holds));
  const keys = local.join(',');
  useEffect(() => {
    let alive = true;
    for (const k of keys ? keys.split(',') : []) {
      const [source, symbol] = k.split('|');
      void browseLastClose(source, symbol).then((c) => alive && setKnown((m) => (m[k] === c ? m : { ...m, [k]: c })));
    }
    return () => {
      alive = false;
    };
  }, [keys, csvVersion]);
  return known;
}

/** Where useLastCloses keeps `symbol`'s close from `source`: apart while an unfinished replay of it there keeps its chart from being drawn. */
function closeKey(source: string, symbol: string, holds: ReturnType<typeof useTrading.getState>['browse']['holds']): string {
  return `${source}|${symbol}|${browseHoldOn(source, symbol, holds) ? 'held' : ''}`;
}

export function Watchlist() {
  const session = useTrading((s) => s.session);

  return (
    <section className="panel area-watch">
      <div className="panel-head">
        <h3>Watchlist</h3>
        <div className="spacer" />
        {session ? (
          <span className="muted small">
            {session.symbols.length} symbol{session.symbols.length === 1 ? '' : 's'}
          </span>
        ) : (
          <button
            type="button"
            className="btn sm ghost icon-btn watch-add"
            aria-label="Add a symbol to the watchlist"
            title="Add a symbol to the watchlist"
            onClick={(e) => {
              e.currentTarget.focus();
              openSymbolSearch({ adding: true });
            }}
          >
            <span aria-hidden="true">+</span>
          </button>
        )}
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        {session ? <SessionRows /> : <BrowseRows />}
      </div>
    </section>
  );
}

/** During a session: its symbols, with their prices on its clock and the positions held. */
function SessionRows() {
  const session = useTrading((s) => s.session)!;
  const quotes = useTrading((s) => s.quotes);
  const active = useTrading((s) => s.activeSymbol);
  const positions = useTrading((s) => s.positions);
  return (
    <>
      {session.symbols.map((sym) => {
        const q = quotes[sym];
        const pos = positions.find((p) => p.symbol === sym);
        const profile = session.mode === 'sim' ? SIM_PROFILES.get(sym) : undefined;
        return (
          // A button, so the symbol can be switched from the keyboard (Enter; Space plays and pauses,
          // as on every button of the trade screen).
          <button key={sym} type="button" className={`watch-row${sym === active ? ' on' : ''}`} aria-pressed={sym === active} onClick={() => setActiveSymbol(sym)}>
            <span className="sym">
              {sym} {pos && <span className={`badge ${pos.quantity > 0 ? 'pos' : 'neg'}`} style={{ padding: '0 5px' }}>{pos.quantity > 0 ? 'L' : 'S'} {Math.abs(pos.quantity)}</span>}
              {/* Its kind of stock ("Growth stock", "Blue chip"), which sets how it moves. */}
              {profile && <span className="nm" title={`${profile.name}: ${profile.description}`}>{profile.description.split(':')[0]}</span>}
            </span>
            <span className="px">
              <span>{q ? price(q.last) : '—'}</span>
              <span className={`small ${q?.changePct ? (q.changePct >= 0 ? 'pos' : 'neg') : 'muted'}`}>{q?.changePct !== null && q?.changePct !== undefined ? pct(q.changePct, 2, true) : '—'}</span>
            </span>
          </button>
        );
      })}
      {/* A bar replay has its one symbol: there is nothing to switch to, only the note on editing. */}
      {session.mode === 'replay' && (
        <p className="muted small" style={{ padding: '8px 10px' }}>
          {session.symbols.length > 1 && 'All symbols here replay on the same clock. Click one (or Tab to it and press Enter) to chart and trade it. '}
          Your own watchlist can be edited (+, ×) once the replay ends, or in Data &amp; Settings.
        </p>
      )}
    </>
  );
}

/**
 * With no session: your watchlist, each symbol charted from the data source that has it (watchSource) with
 * a click, and its last close where that costs nothing (the demo's and imported data; Polygon and Alpaca
 * are named instead). × takes a symbol off, + (in the head) adds one.
 */
function BrowseRows() {
  const watchlist = useSettings((s) => s.watchlist);
  const active = useTrading((s) => s.activeSymbol);
  const current = useTrading((s) => s.browse.providerId);
  // What each source has changes with the keys and the imported data.
  useCredentials((s) => s.creds);
  const [csvVersion, setCsvVersion] = useState(0);
  useEffect(() => onCsvDatasetsChanged(() => setCsvVersion((n) => n + 1)), []);
  const rows = watchlist.map((symbol) => {
    const source = watchSource(symbol, current);
    return { symbol, source, has: sourceHas(source, symbol) };
  });
  const known = useLastCloses(rows, csvVersion);
  const holds = useTrading((s) => s.browse.holds);

  if (!rows.length)
    return (
      <EmptyState title="Your watchlist is empty">
        <button type="button" className="btn sm" onClick={(e) => {
          e.currentTarget.focus();
          openSymbolSearch({ adding: true });
        }}>
          Add a symbol
        </button>
      </EmptyState>
    );
  return (
    <>
      {rows.map(({ symbol, source, has }, i) => {
        const on = symbol === active && source === getProvider(current).id;
        // Only local data's closes are worked out (useLastCloses).
        const c = known[closeKey(source, symbol, holds)];
        return (
          <div key={symbol} className={`watch-item${on ? ' on' : ''}`}>
            <button
              type="button"
              className={`watch-row${on ? ' on' : ''}`}
              aria-pressed={on}
              title={has ? `Chart ${symbol} from ${getProvider(source).name}` : `No data source here has ${symbol}: import a CSV file of it, or add a Polygon or Alpaca API key`}
              onClick={() => browseSymbol(source, symbol)}
            >
              <span className="sym">
                {symbol}
                <span className="nm">{has ? sourceLabel(source) : 'No data'}</span>
              </span>
              <span className="px">
                {c ? (
                  <>
                    <span title="Last close in the data">{price(c.last)}</span>
                    <span className={`small ${c.changePct ? (c.changePct >= 0 ? 'pos' : 'neg') : 'muted'}`}>{c.changePct !== null ? pct(c.changePct, 2, true) : '—'}</span>
                  </>
                ) : null}
              </span>
            </button>
            <button
              type="button"
              className="watch-x"
              aria-label={`Remove ${symbol} from the watchlist`}
              title="Remove from the watchlist"
              onClick={(e) => {
                // Focus goes on to the next row's × (or the one before, or +), not to the page.
                const item = e.currentTarget.closest('.watch-item');
                const next = (item?.nextElementSibling ?? item?.previousElementSibling)?.querySelector<HTMLElement>('.watch-x') ?? item?.closest('.panel')?.querySelector<HTMLElement>('.watch-add');
                removeFromWatchlist(rows[i].symbol);
                next?.focus();
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        );
      })}
    </>
  );
}
