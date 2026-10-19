import { useEffect, useState } from 'react';
import { TIMEFRAMES } from '../../core/types';
import { ChartView } from '../chart/ChartView';
import { TOOL_LABELS, useDrawings, type DrawingTool } from '../chart/drawings';
import { dismissError, retryBrowse, setBrowseSource, setSelectingBar, setTimeframe, useTrading } from '../state/tradingStore';
import { getProvider } from '../state/dataRegistry';
import { IndicatorMenu } from './IndicatorMenu';
import { ChartSettingsMenu } from './Appearance';
import { ReplayControls } from './ReplayControls';
import { ReplayMenu } from './ReplayMenu';
import { EmptyState, useFocusRescue } from './common';
import { UnfinishedSessions } from './UnfinishedSessions';

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

export function ChartPanel({ onNewSession, onOpenSettings, active = true }: { onNewSession: (mode: 'replay' | 'sim') => void; onOpenSettings?: () => void; active?: boolean }) {
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

  return (
    <section className="panel area-chart">
      {/* One row on a laptop: the drawing tools have their own column along the chart's left edge. */}
      <div className="chart-toolbar">
        <strong style={{ marginRight: 4 }}>{symbol}</strong>
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
          !session && <BrowseNotes selecting={selecting} />
        )}
      </div>
      <ReplayControls active={active} />
    </section>
  );
}

/**
 * What the chart with no session says over its top: why the last start failed, the sessions left
 * unfinished to resume or discard, and, until dismissed, how to start a replay; why its bars cannot be
 * shown, in its middle; and that they are loading. Picking a bar, only the error stays.
 */
function BrowseNotes({ selecting }: { selecting: boolean }) {
  const error = useTrading((s) => s.error);
  const browse = useTrading((s) => s.browse);
  const symbol = useTrading((s) => s.activeSymbol);
  const [tip, setTip] = useState(() => !tipDismissed());
  const [unfinishedHidden, setUnfinishedHidden] = useState(false);
  // Pressing Replay is what the tip teaches: once done, it is not needed again.
  useEffect(() => {
    if (!selecting || !tip) return;
    dismissTip();
    setTip(false);
  }, [selecting, tip]);
  const provider = getProvider(browse.providerId);
  return (
    <>
      <div className="browse-notes">
        {error && (
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
        {!selecting && tip && !browse.error && (
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
      {browse.loading && (
        <div className="browse-loading" role="status">
          Loading {symbol}…
        </div>
      )}
      {browse.error && !browse.loading && (
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
              {provider.id !== 'demo' && (
                <button className="btn sm" onClick={() => setBrowseSource('demo')}>
                  Use the demo data
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
