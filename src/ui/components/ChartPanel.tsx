import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { TIMEFRAMES } from '../../core/types';
import { ChartView } from '../chart/ChartView';
import { TOOL_LABELS, useDrawings, type DrawingTool } from '../chart/drawings';
import { browseHiddenReason, browseSymbol, dismissError, retryBrowse, setSelectingBar, setTimeframe, useTrading } from '../state/tradingStore';
import { csvProvider, getProvider } from '../state/dataRegistry';
import { DEMO_TICKERS } from '../../core/data/demoProvider';
import { IndicatorMenu } from './IndicatorMenu';
import { ChartSettingsMenu } from './Appearance';
import { ReplayControls } from './ReplayControls';
import { ReplayMenu } from './ReplayMenu';
import { EmptyState, focusHome, isShown, useFocusRescue } from './common';
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
 * unfinished to resume or discard (or, once that card is hidden, a button to show it again), and, until
 * dismissed, how to start a replay; why it is not drawn (a replay of its symbol you have not finished, or
 * one in another tab: browseHiddenReason) or its bars cannot be shown, in its middle, or under the card of
 * unfinished sessions while that shows, as that card would cover the middle of a short chart; and that they
 * are loading. Picking a bar, none of the notes over its top: the hint the chart shows then (BarCutLayer) is
 * in their place.
 */
function BrowseNotes({ selecting, onOpenSettingsAt }: { selecting: boolean; onOpenSettingsAt?: (card: SettingsCard) => void }) {
  const error = useTrading((s) => s.error);
  const browse = useTrading((s) => s.browse);
  const symbol = useTrading((s) => s.activeSymbol);
  // Why a replay of the symbol keeps its chart from being drawn (what comes next in it would show), or null.
  const hidden = useTrading(() => browseHiddenReason());
  const [tip, setTip] = useState(() => !tipDismissed());
  const [unfinishedHidden, setUnfinishedHidden] = useState(false);
  // How many sessions the card of unfinished sessions lists (none: it is not shown).
  const [listed, setListed] = useState(0);
  const notesRef = useRef<HTMLDivElement>(null);
  /** Where focus goes once the card of unfinished sessions has been shown again ('card') or hidden ('hidden'). */
  const refocus = useRef<'card' | 'hidden' | null>(null);
  useClearOfLegend(notesRef);
  // Pressing Replay is what the tip teaches: once done, it is not needed again.
  useEffect(() => {
    if (!selecting || !tip) return;
    dismissTip();
    setTip(false);
  }, [selecting, tip]);
  // Showing the card again, or hiding it, removes the button pressed: focus goes on to the card's first
  // Resume, or to Show unfinished sessions (else the toolbar's Replay button, as after Exit), never to
  // the page. Only after those presses.
  useLayoutEffect(() => {
    const to = refocus.current;
    refocus.current = null;
    const notes = notesRef.current;
    if (!to || !notes) return;
    const panel = notes.closest('.area-chart');
    const target =
      to === 'card'
        ? notes.querySelector<HTMLElement>('.browse-unfinished .unfinished-list li .btn.primary')
        : (panel?.querySelector<HTMLElement>('.browse-show-unfinished') ?? [...document.querySelectorAll<HTMLElement>('.replay-btn')].find(isShown));
    if (target) target.focus({ preventScroll: true });
    else focusHome();
  }, [unfinishedHidden]);
  const provider = getProvider(browse.providerId);
  const sym = symbol.toUpperCase();
  // The cards of Data & Settings that bring in what the chart lacks: a key for Polygon or Alpaca, imported bars.
  const vendorKey = provider.id === 'polygon' || provider.id === 'alpaca' ? (provider.unavailableReason() ? provider.id : null) : null;
  const needsImport = provider === csvProvider && (!!provider.unavailableReason() || !csvProvider.list().some((d) => d.symbol.toUpperCase() === sym));
  const searchSymbols = (e: MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.focus();
    openSymbolSearch();
  };
  const showUnfinished = !selecting && !unfinishedHidden;
  // Brings the card of unfinished sessions back once hidden, while it lists any: one, in the card of why the
  // chart is not drawn when that shows, else where the card was.
  const showAgain = !selecting && unfinishedHidden && listed > 0 && (
    <button
      className="btn sm browse-show-unfinished"
      onClick={() => {
        refocus.current = 'card';
        setUnfinishedHidden(false);
      }}
    >
      Show unfinished sessions
    </button>
  );
  // Why the chart is not drawn: a replay of its symbol keeps it hidden, or its bars could not be had.
  const why = hidden ? (
    <>
      <strong>{sym} is not charted here for now</strong>
      <span>{hidden}</span>
      <div className="row wrap">
        <button className="btn sm" onClick={searchSymbols}>
          Search symbols
        </button>
        {showAgain}
      </div>
    </>
  ) : browse.error && !browse.loading ? (
    <>
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
    </>
  ) : null;
  // A blind replay's reason is a status; a failure, an alert. Under the card of unfinished sessions while
  // that shows (it would cover the chart's middle on a short screen), else in the chart's middle.
  const whyRole = hidden ? 'status' : 'alert';
  const whyInNotes = !!why && showUnfinished && listed > 0;
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
        {/* Kept while hidden, so it knows what it lists when shown again. */}
        <div className="browse-unfinished" hidden={!showUnfinished}>
          <UnfinishedSessions onList={setListed} />
          <button
            className="btn sm ghost browse-hide"
            onClick={() => {
              refocus.current = 'hidden';
              setUnfinishedHidden(true);
            }}
            aria-label="Hide unfinished sessions"
            title="Hide for now"
          >
            ✕
          </button>
        </div>
        {!hidden && showAgain}
        {whyInNotes && (
          <div className="card stack browse-why" role={whyRole}>
            {why}
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
      {why && !whyInNotes && (
        // Hiding the unfinished sessions' card leaves the chart hidden: it is the replay that hides it.
        <div className="browse-empty" role={whyRole}>
          <div className="card stack">{why}</div>
        </div>
      )}
    </>
  );
}

/** Pixels a legend row's text may reach past the notes' left edge, under the card's border, without moving them. */
const LEGEND_TOUCH = 3;

/** Where `el`'s own text ends on screen: its contents' right edge, which a row's box can reach past. */
function textRight(el: Element): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getBoundingClientRect().right;
}

/**
 * Keeps the notes over the chart clear of the legend: their top (--clear-of-legend) follows the bottom of
 * its first row (the candle's prices), however many lines that wraps to on a narrow chart, and of the
 * lowest row below it whose text reaches under the notes (a long indicator row, such as Bollinger Bands'
 * three values). Lower rows that end short of the notes leave them where they are, and so does one whose
 * text ends within LEGEND_TOUCH of their left edge: under the card's border, it covers nothing, and moving
 * the whole column down for it would put its foot over the indicator pane below. The legend is watched
 * whole, so adding or removing an indicator places them again. In the one scrolling column they are in the
 * flow above the chart instead (styles.css), and this changes nothing.
 */
function useClearOfLegend(ref: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const notes = ref.current;
    const host = notes?.closest<HTMLElement>('.chart-host');
    const wrap = host?.querySelector<HTMLElement>('.chart-wrap');
    if (!notes || !host || !wrap || typeof ResizeObserver === 'undefined') return;
    let legend: HTMLElement | null = null;
    let watched: Element[] = [];
    const place = () => {
      // The notes' left edge: that of the leftmost note shown (the tip is narrower than the column).
      const shown = [...notes.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0);
      const left = shown.length ? Math.min(...shown.map((r) => r.left)) : notes.getBoundingClientRect().left;
      const rows = legend?.isConnected ? [...legend.children] : [];
      const under = rows.filter((r, i) => i === 0 || textRight(r) > left + LEGEND_TOUCH).map((r) => r.getBoundingClientRect());
      const below = under.length ? Math.max(...under.map((r) => r.bottom)) - host.getBoundingClientRect().top + 8 : 8;
      notes.style.setProperty('--clear-of-legend', `${Math.max(8, Math.ceil(below))}px`);
    };
    const ro = new ResizeObserver(place);
    // Rows come and go with the indicators: each is watched, as the legend's size alone misses a lower row
    // growing while the first stays the widest.
    const rows = new MutationObserver(() => watch());
    // The legend comes and goes with the chart's bars: the one watched is the one there now.
    const watch = () => {
      const next = wrap.querySelector<HTMLElement>(':scope > .chart-legend:not(.pane-legend)');
      if (next !== legend) {
        rows.disconnect();
        legend = next;
        if (legend) rows.observe(legend, { childList: true });
      }
      const now = legend ? [legend, ...legend.children] : [];
      for (const el of watched) if (!now.includes(el)) ro.unobserve(el);
      for (const el of now) if (!watched.includes(el)) ro.observe(el);
      watched = now;
      place();
    };
    const mo = new MutationObserver(watch);
    mo.observe(wrap, { childList: true });
    // A note shown or gone moves the notes' left edge.
    const noted = new MutationObserver(place);
    noted.observe(notes, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    ro.observe(host);
    watch();
    return () => {
      ro.disconnect();
      mo.disconnect();
      rows.disconnect();
      noted.disconnect();
    };
  }, [ref]);
}
