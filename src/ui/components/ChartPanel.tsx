import { TIMEFRAMES } from '../../core/types';
import { ChartView } from '../chart/ChartView';
import { TOOL_LABELS, useDrawings, type DrawingTool } from '../chart/drawings';
import { setTimeframe, useTrading } from '../state/tradingStore';
import { IndicatorMenu } from './IndicatorMenu';
import { ChartSettingsMenu } from './Appearance';
import { ReplayControls } from './ReplayControls';
import { EmptyState } from './common';

const TOOL_ICONS: Record<DrawingTool, string> = { select: '↖', trend: '╱', hline: '─', vline: '│', rect: '▭', sr: '▤', fib: 'ƒ' };

export function ChartPanel({ onNewSession, onOpenSettings, active = true }: { onNewSession: (mode: 'replay' | 'sim') => void; onOpenSettings?: () => void; active?: boolean }) {
  const session = useTrading((s) => s.session);
  const symbol = useTrading((s) => s.activeSymbol);
  const timeframe = useTrading((s) => s.timeframe);
  const loading = useTrading((s) => s.loading);
  const error = useTrading((s) => s.error);
  const { tool, setTool, color, setColor, clear, drawings } = useDrawings();
  const isSim = session?.mode === 'sim';

  return (
    <section className="panel area-chart">
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
        <div className="seg" role="group" aria-label="Drawing tools">
          {(Object.keys(TOOL_LABELS) as DrawingTool[]).map((t) => (
            <button key={t} className={tool === t ? 'on' : ''} aria-pressed={tool === t} aria-label={TOOL_LABELS[t]} onClick={() => setTool(t)} title={TOOL_LABELS[t]}>
              <span aria-hidden="true">{TOOL_ICONS[t]}</span>
            </button>
          ))}
        </div>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Drawing color" aria-label="Drawing color" style={{ width: 26, height: 24, padding: 0, border: 0, background: 'none' }} />
        {/* Always there (disabled when empty): a button that comes and goes would re-wrap the
            toolbar and move the chart under the pointer. Deleting the selected drawing is a button
            on the chart itself (ChartView). */}
        <button className="btn sm ghost icon-btn" disabled={!drawings.length} onClick={() => window.confirm('Remove all drawings on this symbol?') && clear()} aria-label="Clear all drawings" title="Clear all drawings on this symbol">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.6 6.5v4.5M9.4 6.5v4.5" />
          </svg>
        </button>
        <div className="spacer" />
        <button className="btn sm" onClick={() => onNewSession('replay')}>
          New replay
        </button>
        <button className="btn sm" onClick={() => onNewSession('sim')}>
          Sim market
        </button>
      </div>
      <div className="chart-host">
        <ChartView symbol={symbol} timeframe={timeframe} />
        {!session && (
          <div className="chart-empty">
            {loading ? (
              <EmptyState title="Loading market data…">Preparing the replay. Future bars stay hidden.</EmptyState>
            ) : (
              <div className="stack" style={{ alignItems: 'center', maxWidth: 520, textAlign: 'center' }}>
                {error && <div className="alert error">{error}</div>}
                <h2>Practice trading when the market is closed</h2>
                <p className="muted">
                  Pick an old trading day and replay it bar by bar without seeing what comes next, or trade a continuously running fictional market.
                </p>
                <div className="row">
                  <button className="btn primary" onClick={() => onNewSession('replay')}>
                    Start a historical replay
                  </button>
                  <button className="btn" onClick={() => onNewSession('sim')}>
                    Start the simulated market
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <ReplayControls active={active} />
    </section>
  );
}
