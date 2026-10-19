/**
 * Symbol search, as in TradingView: the ticker in the chart toolbar, the watchlist's +, or a letter typed
 * while the chart has focus opens it.
 *
 * With no session it searches one data source's tickers at a time (Demo, Imported, Polygon, Alpaca, each
 * marked ready or not set up) and charts the one picked from that source. Polygon and Alpaca take any
 * ticker typed in ("Use XYZ"): they have every US listing, and this app cannot ask them for it (its data
 * proxy forwards only their bar endpoints), so a mistyped ticker shows as such once its bars are asked
 * for. The demo and imported data have only their own tickers; for anything else the search says so and
 * opens Data & Settings at the card that brings real bars in.
 *
 * During a session it lists the session's own symbols to switch between. A session loads its symbols
 * when it starts and they all play on its clock, so another ticker cannot join it: the search says that
 * charting one means exiting the session first.
 *
 * A star on each row adds the ticker to the watchlist or takes it off (outside a session).
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { create } from 'zustand';
import type { SymbolInfo } from '../../core/data/provider';
import { cleanTicker } from '../../core/data/vendorProviders';
import { SIM_STOCKS } from '../../core/sim/SimMarket';
import { browseSymbol, setActiveSymbol, useTrading } from '../state/tradingStore';
import { getProvider, onCsvDatasetsChanged } from '../state/dataRegistry';
import { addToWatchlist, toggleWatchlist, useSettings } from '../state/settingsStore';
import { useCredentials } from '../state/credentials';
import type { SettingsCard } from '../services/focusRequest';
import { Modal, keyBelongsElsewhere } from './common';

/** The data sources the search covers, in the order of its switch, with their short names. */
export const SEARCH_SOURCES = [
  { id: 'demo', label: 'Demo' },
  { id: 'csv', label: 'Imported' },
  { id: 'polygon', label: 'Polygon' },
  { id: 'alpaca', label: 'Alpaca' },
] as const;

/** A short name for a data source (a HISTORICAL_PROVIDERS id), as the search's switch and the watchlist name it. */
export function sourceLabel(id: string): string {
  return SEARCH_SOURCES.find((s) => s.id === id)?.label ?? getProvider(id).name;
}

const SIM_NAMES = new Map(SIM_STOCKS.map((p) => [p.symbol, p.name]));

/** What the search was opened with: text already typed, and whether it adds to the watchlist (its +). */
interface SearchRequest {
  query: string;
  adding: boolean;
  /** Counts openings, so each starts afresh. */
  n: number;
}

const useSearch = create<{ request: SearchRequest | null }>()(() => ({ request: null }));
let openings = 0;

/**
 * Opens the symbol search, with `query` typed in. `adding` (the watchlist's +): the symbol picked also goes
 * on the watchlist. The control that opened it gets focus back when it closes.
 */
export function openSymbolSearch(opts: { query?: string; adding?: boolean } = {}): void {
  useSearch.setState({ request: { query: opts.query ?? '', adding: !!opts.adding, n: ++openings } });
}

export function closeSymbolSearch(): void {
  useSearch.setState({ request: null });
}

/**
 * Typing a letter while the chart panel has focus (or nothing has, as after a click on the chart) opens
 * the search with that letter typed, as in TradingView. No other shortcut uses letters (Space and the
 * arrows play and step, Delete and Esc act on drawings); a letter typed in a field, a dialog or a menu,
 * or with Ctrl, Alt or Cmd held, is left alone. Only while the Trade screen is shown (`active`).
 */
export function useTypeToSearch(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || !/^[a-z]$/i.test(e.key) || keyBelongsElsewhere(e)) return;
      const el = document.activeElement;
      const onChart = !el || el === document.body || el === document.documentElement || el.matches('[data-focus-home]') || !!el.closest('.area-chart');
      if (!onChart) return;
      e.preventDefault();
      openSymbolSearch({ query: e.key.toUpperCase() });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}

/** The symbol search dialog while it is open. `onOpenSettingsAt` opens Data & Settings at a card. */
export function SymbolSearchHost({ onOpenSettingsAt }: { onOpenSettingsAt?: (card: SettingsCard) => void }) {
  const request = useSearch((s) => s.request);
  return request ? <SymbolSearch key={request.n} request={request} onOpenSettingsAt={onOpenSettingsAt} /> : null;
}

/** A magnifying glass: the toolbar's ticker opens the search. */
export function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="6.8" cy="6.8" r="4.3" />
      <path d="m10.1 10.1 3.6 3.6" />
    </svg>
  );
}

type Row = { symbol: string; name: string; use?: boolean };

/**
 * `list`'s entries that match `query`, best first: the ticker itself, tickers that start with it, tickers
 * holding it, then names holding it (so "apple" finds AAPL). All of them for an empty query.
 */
export function matchSymbols<T extends { symbol: string; name: string }>(list: readonly T[], query: string): T[] {
  const q = query.trim();
  if (!q) return [...list];
  const upper = q.toUpperCase();
  const lower = q.toLowerCase();
  const rank = (x: T) => (x.symbol === upper ? 0 : x.symbol.startsWith(upper) ? 1 : x.symbol.includes(upper) ? 2 : x.name.toLowerCase().includes(lower) ? 3 : -1);
  return list
    .map((x) => ({ x, r: rank(x) }))
    .filter((m) => m.r >= 0)
    .sort((a, b) => a.r - b.r)
    .map((m) => m.x);
}

/** Every source's list of tickers (listSymbols), read again when the imported data changes. */
function useSymbolLists(): Record<string, SymbolInfo[]> {
  const [imported, setImported] = useState(0);
  useEffect(() => onCsvDatasetsChanged(() => setImported((n) => n + 1)), []);
  const [lists, setLists] = useState<Record<string, SymbolInfo[]>>({});
  useEffect(() => {
    let alive = true;
    for (const { id } of SEARCH_SOURCES)
      getProvider(id)
        .listSymbols()
        // The demo's names say "(demo)", which the switch already says.
        .then((l) => alive && setLists((m) => ({ ...m, [id]: l.map((x) => ({ ...x, name: x.name.replace(/ \(demo\)$/, '') })) })))
        .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [imported]);
  return lists;
}

/** Whether a source can be used now: 'ready', its data still loading (imported data, as the app opens), or not set up. */
function sourceState(id: string): 'ready' | 'loading' | 'off' {
  const reason = getProvider(id).unavailableReason();
  return !reason ? 'ready' : /loading/i.test(reason) ? 'loading' : 'off';
}

const STATE_TEXT = { ready: 'Ready', loading: 'Loading…', off: 'Not set up' } as const;

function SymbolSearch({ request, onOpenSettingsAt }: { request: SearchRequest; onOpenSettingsAt?: (card: SettingsCard) => void }) {
  const session = useTrading((s) => s.session);
  const browseSource = useTrading((s) => s.browse.providerId);
  const activeSymbol = useTrading((s) => s.activeSymbol);
  const watchlist = useSettings((s) => s.watchlist);
  // Whether Polygon and Alpaca are ready changes with their keys.
  useCredentials((s) => s.creds);
  const lists = useSymbolLists();
  const [source, setSource] = useState(() => getProvider(browseSource).id);
  const [query, setQuery] = useState(request.query);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const label = sourceLabel(source);
  const state = sourceState(source);
  const vendor = source === 'polygon' || source === 'alpaca';
  const typed = query.trim();
  const ticker = cleanTicker(query);

  // What is listed: the session's symbols, or the chosen source's tickers (none when it is not set up).
  let all: Row[];
  if (session) all = session.symbols.map((symbol) => ({ symbol, name: SIM_NAMES.get(symbol) ?? lists.csv?.find((x) => x.symbol === symbol)?.name ?? lists.polygon?.find((x) => x.symbol === symbol)?.name ?? '' }));
  else all = state === 'ready' ? (lists[source] ?? []).map(({ symbol, name }) => ({ symbol, name: name === symbol ? '' : name })) : [];
  let rows = matchSymbols(all, query);
  // Polygon and Alpaca take any ticker: one typed that is not listed comes first, as an exact match would.
  if (!session && vendor && state === 'ready' && ticker && !all.some((r) => r.symbol === ticker)) rows = [{ symbol: ticker, name: `Load its bars from ${label}`, use: true }, ...rows];
  // Nothing matches: the whole list stays in view under the note saying so, but Enter picks none of it.
  // (A source not set up lists nothing, and its own note says why.)
  const unmatched = typed !== '' && rows.length === 0 && (!!session || state === 'ready');
  if (unmatched) rows = all;
  const enterRow = unmatched ? null : (rows[0] ?? null);
  const stars = !session;

  const pick = (symbol: string) => {
    if (session) setActiveSymbol(symbol);
    else {
      if (request.adding) addToWatchlist(symbol);
      browseSymbol(source, symbol);
    }
    closeSymbolSearch();
  };
  const openSettings = onOpenSettingsAt
    ? (card: SettingsCard) => {
        closeSymbolSearch();
        onOpenSettingsAt(card);
      }
    : null;

  const picks = () => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.sym-pick') ?? [])];
  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      picks()[0]?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (enterRow) pick(enterRow.symbol);
    }
  };
  // Arrows move through the results (Up from the first goes back to the box); typing goes on in the box.
  const onListKey = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const list = picks();
    const row = (e.target as HTMLElement).closest('.sym-row');
    const i = list.findIndex((b) => b.closest('.sym-row') === row);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const to = e.key === 'ArrowDown' ? Math.min(i + 1, list.length - 1) : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : list.length - 1;
      (to < 0 ? inputRef.current : list[to])?.focus();
    } else if (e.key === 'Backspace' || (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      e.preventDefault();
      setQuery((q) => (e.key === 'Backspace' ? q.slice(0, -1) : q + e.key));
      inputRef.current?.focus();
    }
  };

  const title = session ? 'Symbol search' : request.adding ? 'Add to watchlist' : 'Symbol search';
  const what = session?.mode === 'sim' ? 'the simulated market' : 'this replay';

  return (
    <Modal title={title} onClose={closeSymbolSearch}>
      <div className="sym-search">
        {session ? (
          <p className="small muted" style={{ margin: 0 }}>
            {session.mode === 'sim'
              ? 'The simulated market’s stocks. To chart a real ticker, exit it (✕ under the chart), then search again.'
              : 'This replay’s symbols. To chart another ticker, exit the replay (✕ under the chart), then search again.'}
          </p>
        ) : (
          <div className="seg sym-sources" role="group" aria-label="Data source">
            {SEARCH_SOURCES.map((s) => {
              const st = sourceState(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  className={s.id === source ? 'on' : ''}
                  aria-pressed={s.id === source}
                  title={getProvider(s.id).unavailableReason() ?? getProvider(s.id).name}
                  onClick={() => {
                    setSource(s.id);
                    inputRef.current?.focus();
                  }}
                >
                  <span className="src-name">{s.label}</span>
                  <span className={`src-state ${st}`}>{STATE_TEXT[st]}</span>
                </button>
              );
            })}
          </div>
        )}
        <input
          ref={inputRef}
          className="sym-query"
          type="text"
          data-autofocus
          value={query}
          maxLength={40}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder={session ? 'Ticker' : vendor ? 'Any ticker, e.g. PLTR' : 'Ticker or name'}
          aria-label={session ? `Search ${what}’s symbols` : `Search ${label} tickers`}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          // With text typed in before it opened (a letter typed on the chart), the caret goes after it.
          onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
        />
        {!session && state !== 'ready' && (
          <div className="sym-note" role="status">
            {source === 'csv' && state === 'loading' && <span>Your imported data is still loading.</span>}
            {source === 'csv' && state === 'off' && (
              <>
                <span>No CSV data imported yet. Import a file of a ticker’s bars (from your broker, TradingView or a data vendor) to chart and replay it.</span>
                {openSettings && (
                  <button type="button" className="btn sm" onClick={() => openSettings('csv-import')}>
                    Import a CSV file
                  </button>
                )}
              </>
            )}
            {vendor && (
              <>
                <span>{label} needs your own API key. With it, any US ticker can be charted and replayed.</span>
                {openSettings && (
                  <button type="button" className="btn sm" onClick={() => openSettings('api-keys')}>
                    Add {source === 'alpaca' ? 'an Alpaca' : 'a Polygon'} API key
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {unmatched && (
          <div className="sym-note" role="status">
            {session ? (
              <span>
                <b>{ticker ?? `“${typed}”`}</b> is not in {what}.
              </span>
            ) : source === 'demo' ? (
              <>
                <span>
                  <b>{ticker ?? `“${typed}”`}</b> is not in the demo data. The demo has only these {all.length} symbols, and their prices are made up. To chart {ticker ?? 'another ticker'}, bring in its real bars:
                </span>
                {openSettings && (
                  <span className="row wrap">
                    <button type="button" className="btn sm" onClick={() => openSettings('csv-import')}>
                      Import a CSV file
                    </button>
                    <button type="button" className="btn sm" onClick={() => openSettings('api-keys')}>
                      Add a Polygon or Alpaca API key
                    </button>
                  </span>
                )}
              </>
            ) : source === 'csv' ? (
              <>
                <span>
                  <b>{ticker ?? `“${typed}”`}</b> is not in your imported data. Import a CSV file of its bars to chart it.
                </span>
                {openSettings && (
                  <button type="button" className="btn sm" onClick={() => openSettings('csv-import')}>
                    Import a CSV file
                  </button>
                )}
              </>
            ) : (
              <span>
                “{typed}” is not a ticker: tickers are letters and digits, with a dot or a dash before a share class (BRK.B, BF-B).
              </span>
            )}
          </div>
        )}
        {rows.length > 0 && (
          <ul ref={listRef} className="sym-results" aria-label={session ? `${what}’s symbols` : `${label} tickers`} onKeyDown={onListKey}>
            {rows.map((r) => {
              const current = r.symbol === activeSymbol && (session ? true : source === browseSource);
              const starred = watchlist.includes(r.symbol);
              return (
                <li key={`${r.use ? 'use:' : ''}${r.symbol}`} className={`sym-row${r === enterRow ? ' next' : ''}`}>
                  <button type="button" className={`sym-pick${current ? ' on' : ''}`} aria-current={current || undefined} onClick={() => pick(r.symbol)}>
                    <span className="sym">{r.use ? `Use ${r.symbol}` : r.symbol}</span>
                    {r.name && <span className="nm">{r.name}</span>}
                  </button>
                  {stars && (
                    <button
                      type="button"
                      className={`sym-star${starred ? ' on' : ''}`}
                      aria-pressed={starred}
                      aria-label={starred ? `Remove ${r.symbol} from the watchlist` : `Add ${r.symbol} to the watchlist`}
                      title={starred ? 'Remove from the watchlist' : 'Add to the watchlist'}
                      onClick={() => toggleWatchlist(r.symbol)}
                    >
                      <span aria-hidden="true">{starred ? '★' : '☆'}</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="sym-keys small muted">
          ↑ ↓ to move · Enter to {session ? 'chart' : request.adding ? 'add and chart' : 'chart'} · Esc to close
        </p>
      </div>
    </Modal>
  );
}
