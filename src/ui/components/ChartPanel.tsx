import { useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { TIMEFRAMES } from '../../core/types';
import { ChartView } from '../chart/ChartView';
import { TOOL_LABELS, useDrawings, type DrawingTool } from '../chart/drawings';
import { browseHiddenReason, browseHoldOn, browseSymbol, dismissError, retryBrowse, setSelectingBar, setTimeframe, useTrading } from '../state/tradingStore';
import { csvProvider, getProvider } from '../state/dataRegistry';
import { DEMO_TICKERS } from '../../core/data/demoProvider';
import { exchangeDate, formatExchangeTime } from '../../core/time';
import { IndicatorMenu } from './IndicatorMenu';
import { ChartSettingsMenu } from './Appearance';
import { ReplayControls } from './ReplayControls';
import { ReplayMenu } from './ReplayMenu';
import { EmptyState, useFocusRescue } from './common';
import { UnfinishedSessions } from './UnfinishedSessions';
import { SearchIcon, SymbolSearchHost, openSymbolSearch, useTypeToSearch } from './SymbolSearch';
import type { SettingsCard } from '../services/focusRequest';

const TOOL_ICONS: Record<DrawingTool, string> = { select: '↖', trend: '╱', hline: '─', vline: '│', rect: '▭', sr: '▤', fib: 'ƒ' };

/** Where the first-use tip ("Press Replay, then click the bar…") is remembered as dismissed. */
const TIP_KEY = 'stock-replay-bar-replay-tip';

function tipDismissed(): boolean {
  try {
    return localStorage.getItem(TIP_KEY) === 'dismissed';
  } catch {
    return false;
  }
}

function dismissTip(): void {
  try {
    localStorage.setItem(TIP_KEY, 'dismissed');
  } catch {
    /* storage blocked: the tip shows again next time */
  }
}

/**
 * The chart with its toolbar and replay controls. `onOpenSettings` opens Data & Settings at Appearance
 * (Chart style), `onOpenSettingsAt` at another card (the symbol search's ways to bring in real bars).
 */
export function ChartPanel({
  onNewSession,
  onOpenSettings,
  onOpenSettingsAt,
  active = true,
}: {
  onNewSession: (mode: 'replay' | 'sim') => void;
  onOpenSettings?: () => void;
  onOpenSettingsAt?: (card: SettingsCard) => void;
  active?: boolean;
}) {
  const session = useTrading((s) => s.session);
  const symbol = useTrading((s) => s.activeSymbol);
  const timeframe = useTrading((s) => s.timeframe);
  const loading = useTrading((s) => s.loading);
  const carryingOn = useTrading((s) => s.carryingOn !== null);
  const selecting = useTrading((s) => s.selectingBar);
  const { tool, setTool, color, setColor, clear, drawings } = useDrawings();
  const isSim = session?.mode === 'sim';
  // Clear all drawings disables itself once they are gone: focus goes to the drawing tools.
  const toolsRef = useFocusRescue<HTMLDivElement>((bar) => bar.querySelector<HTMLElement>('[aria-label="Drawing tools"] button.on'));

  // Another page covering the chart stops picking a bar on it.
  useEffect(() => {
    if (!active) setSelectingBar(false);
  }, [active]);
  useTypeToSearch(active);

  return (
    <section className="panel area-chart">
      {/* One row on a laptop: the drawing tools have their own column along the chart's left edge. */}
      <div className="chart-toolbar">
        {/* The ticker opens the symbol search (so does typing a letter on the chart). */}
        <button
          type="button"
          className="btn sm sym-btn"
          aria-haspopup="dialog"
          aria-label={`${symbol}: search symbols`}
          title="Symbol search: chart another ticker (or type its first letter on the chart)"
          onClick={(e) => {
            // Focused even where a click does not focus a button (Safari), so the search hands focus back to it.
            e.currentTarget.focus();
            openSymbolSearch();
          }}
        >
          <SearchIcon />
          <strong>{symbol}</strong>
        </button>
        <div className="seg" role="group" aria-label="Timeframe">
          {TIMEFRAMES.map((tf) => (
            <button key={tf} className={tf === timeframe ? 'on' : ''} aria-pressed={tf === timeframe} onClick={() => setTimeframe(tf)} disabled={isSim && tf === '1D'} title={isSim && tf === '1D' ? 'The simulated market has only a few sessions of history' : undefined}>
              {tf}
            </button>
          ))}
        </div>
        <IndicatorMenu />
        <ChartSettingsMenu onOpenSettings={onOpenSettings} />
        <div className="spacer" />
        <ReplayMenu onNewSession={onNewSession} />
      </div>
      <div className="chart-host">
        {/* Not while a reload carries its session on: the chart is covered then. */}
        {!carryingOn && (
          <div className="draw-tools" ref={toolsRef}>
            <div className="seg" role="group" aria-label="Drawing tools">
              {(Object.keys(TOOL_LABELS) as DrawingTool[]).map((t) => (
                <button key={t} className={tool === t ? 'on' : ''} aria-pressed={tool === t} aria-label={TOOL_LABELS[t]} onClick={() => setTool(t)} title={TOOL_LABELS[t]}>
                  <span aria-hidden="true">{TOOL_ICONS[t]}</span>
                </button>
              ))}
            </div>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Drawing color" aria-label="Drawing color" />
            {/* Always there (disabled when empty): a button that comes and goes would move the
                others. Deleting the selected drawing is a button on the chart itself (ChartView). */}
            <button className="btn sm ghost icon-btn" disabled={!drawings.length} onClick={() => window.confirm('Remove all drawings on this symbol?') && clear()} aria-label="Clear all drawings" title="Clear all drawings on this symbol">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.6 6.5v4.5M9.4 6.5v4.5" />
              </svg>
            </button>
          </div>
        )}
        <ChartView symbol={symbol} timeframe={timeframe} />
        {loading ? (
          // Over the chart it starts from (a bar replay keeps its view), which stays in sight, dimmed.
          <div className="chart-empty chart-veil">
            <EmptyState title="Loading market data…">Preparing the replay. Future bars stay hidden.</EmptyState>
          </div>
        ) : carryingOn ? (
          // A reload carries on the session this tab was running, unless another tab runs it (this one was
          // duplicated from it): it is not offered to resume or discard meanwhile.
          <div className="chart-empty">
            <EmptyState title="Picking up where you left off…">If the session this tab was running can be carried on, it comes back as it was, paused.</EmptyState>
          </div>
        ) : (
          !session && <BrowseNotes selecting={selecting} onOpenSettingsAt={onOpenSettingsAt} />
        )}
      </div>
      <ReplayControls active={active} />
      <SymbolSearchHost onOpenSettingsAt={onOpenSettingsAt} />
    </section>
  );
}

/**
 * What the chart with no session says over its top: why the last start failed, the sessions left
 * unfinished to resume or discard, where its bars stop when a saved session on its symbol has not got
 * further (browseHoldOn), and, until dismissed, how to start a replay; why its bars cannot be shown, in its
 * middle; and that they are loading. Picking a bar, none of the notes over its top: the hint the chart
 * shows then (BarCutLayer) is in their place.
 */
function BrowseNotes({ selecting, onOpenSettingsAt }: { selecting: boolean; onOpenSettingsAt?: (card: SettingsCard) => void }) {
  const error = useTrading((s) => s.error);
  const browse = useTrading((s) => s.browse);
  const symbol = useTrading((s) => s.activeSymbol);
  // Why a blind replay of the symbol keeps its chart from being drawn (its dates would show), or null.
  const hidden = useTrading(() => browseHiddenReason());
  // Where the chart stops for an unfinished (or elsewhere running) replay of the symbol, as `time|elsewhere`.
  const capKey = useTrading((s) => {
    const h = browseHoldOn(getProvider(s.browse.providerId).id, s.activeSymbol, s.browse.holds);
    return h && !h.blind ? `${h.until}|${h.elsewhere ? 1 : 0}` : null;
  });
  const [tip, setTip] = useState(() => !tipDismissed());
  const [unfinishedHidden, setUnfinishedHidden] = useState(false);
  const notesRef = useRef<HTMLDivElement>(null);
  useClearOfLegend(notesRef);
  // Pressing Replay is what the tip teaches: once done, it is not needed again.
  useEffect(() => {
    if (!selecting || !tip) return;
    dismissTip();
    setTip(false);
  }, [selecting, tip]);
  const provider = getProvider(browse.providerId);
  const sym = symbol.toUpperCase();
  const cap = capKey ? { until: Number(capKey.split('|')[0]), elsewhere: capKey.endsWith('|1') } : null;
  // The cards of Data & Settings that bring in what the chart lacks: a key for Polygon or Alpaca, imported bars.
  const vendorKey = provider.id === 'polygon' || provider.id === 'alpaca' ? (provider.unavailableReason() ? provider.id : null) : null;
  const needsImport = provider === csvProvider && (!!provider.unavailableReason() || !csvProvider.list().some((d) => d.symbol.toUpperCase() === sym));
  const searchSymbols = (e: MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.focus();
    openSymbolSearch();
  };
  return (
    <>
      <div className="browse-notes" ref={notesRef}>
        {error && !selecting && (
          <div className="alert error row" role="alert">
            <span style={{ flex: 1, minWidth: 0 }}>{error}</span>
            <button className="btn sm ghost" onClick={dismissError} aria-label="Dismiss this message" title="Dismiss">
              ✕
            </button>
          </div>
        )}
        {!selecting && !unfinishedHidden && (
          <div className="browse-unfinished">
            <UnfinishedSessions />
            <button className="btn sm ghost browse-hide" onClick={() => setUnfinishedHidden(true)} aria-label="Hide unfinished sessions" title="Hide for now">
              ✕
            </button>
          </div>
        )}
        {!selecting && cap && !hidden && (
          <div className="browse-cap" role="status">
            Bars shown up to {exchangeDate(cap.until)} {formatExchangeTime(cap.until)} ET, where {cap.elsewhere ? `the ${sym} replay running in another tab was last saved` : `your unfinished ${sym} replay is`}.
          </div>
        )}
        {!selecting && tip && !browse.error && !hidden && (
          <div className="browse-tip">
            <span>
              Press <b>Replay</b>, then click the bar to start from.
            </span>
            <button
              className="btn sm ghost"
              onClick={() => {
                dismissTip();
                setTip(false);
              }}
              aria-label="Dismiss this tip"
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
      </div>
      {browse.loading && !hidden && (
        <div className="browse-loading" role="status">
          Loading {symbol}…
        </div>
      )}
      {hidden ? (
        // Hiding the unfinished sessions' card leaves the chart hidden: it is the replay that hides it.
        <div className="browse-empty" role="status">
          <div className="card stack">
            <strong>{sym} is not charted here for now</strong>
            <span>{hidden}</span>
            <div className="row wrap">
              <button className="btn sm" onClick={searchSymbols}>
                Search symbols
              </button>
              {unfinishedHidden && (
                <button className="btn sm" onClick={() => setUnfinishedHidden(false)}>
                  Show unfinished sessions
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        browse.error &&
        !browse.loading && (
          <div className="browse-empty" role="alert">
            <div className="card stack">
              <strong>
                No chart of {symbol} from {provider.name}
              </strong>
              <span>{browse.error}</span>
              <div className="row wrap">
                <button className="btn sm" onClick={retryBrowse}>
                  Try again
                </button>
                {/* A mistyped ticker is the usual reason. */}
                <button className="btn sm" onClick={searchSymbols}>
                  Search symbols
                </button>
                {vendorKey && onOpenSettingsAt && (
                  <button className="btn sm" onClick={() => onOpenSettingsAt('api-keys')}>
                    Add {vendorKey === 'alpaca' ? 'an Alpaca' : 'a Polygon'} API key
                  </button>
                )}
                {needsImport && onOpenSettingsAt && (
                  <button className="btn sm" onClick={() => onOpenSettingsAt('csv-import')}>
                    Import a CSV file
                  </button>
                )}
                {provider.id !== 'demo' && (
                  <button
                    className="btn sm"
                    onClick={(e) => {
                      // The demo's own copy of the ticker when it has one, else SPY: one change, so no load
                      // starts for a ticker the demo lacks. The card goes; focus goes on to the ticker button.
                      const symBtn = e.currentTarget.closest('.area-chart')?.querySelector<HTMLElement>('.chart-toolbar .sym-btn');
                      browseSymbol('demo', DEMO_TICKERS.some((t) => t.symbol === sym) ? sym : 'SPY');
                      symBtn?.focus({ preventScroll: true });
                    }}
                  >
                    Use the demo data
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      )}
    </>
  );
}

/**
 * Keeps the notes over the chart clear of the legend's first row (the candle's prices), however many
 * lines that wraps to on a narrow chart: their top (--clear-of-legend) follows its bottom. In the one
 * scrolling column they are in the flow above the chart instead (styles.css), and this changes nothing.
 */
function useClearOfLegend(ref: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const notes = ref.current;
    const host = notes?.closest<HTMLElement>('.chart-host');
    const wrap = host?.querySelector<HTMLElement>('.chart-wrap');
    if (!notes || !host || !wrap || typeof ResizeObserver === 'undefined') return;
    let row: HTMLElement | null = null;
    const place = () => {
      const below = row?.isConnected ? row.getBoundingClientRect().bottom - host.getBoundingClientRect().top + 8 : 8;
      notes.style.setProperty('--clear-of-legend', `${Math.max(8, Math.ceil(below))}px`);
    };
    const ro = new ResizeObserver(place);
    // The legend comes and goes with the chart's bars: the row watched is the one there now.
    const watch = () => {
      const next = wrap.querySelector<HTMLElement>(':scope > .chart-legend:not(.pane-legend) > .legend-row');
      if (next !== row) {
        if (row) ro.unobserve(row);
        row = next;
        if (row) ro.observe(row);
      }
      place();
    };
    const mo = new MutationObserver(watch);
    mo.observe(wrap, { childList: true });
    ro.observe(host);
    watch();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref]);
}
