/** Right column: the account in one line, active challenge progress, open positions and the order ticket. */
import { useMemo } from 'react';
import { useTrading } from '../state/tradingStore';
import { useChallenges } from '../state/challengeStore';
import { CHALLENGES } from '../../core/challenges/challenges';
import { OrderTicket } from './OrderTicket';
import { PositionList } from './PositionList';
import { useFocusRescue } from './common';
import { useRememberedOpen } from './useRememberedOpen';
import { money, pct, pnlClass, signedMoney } from '../services/format';

/**
 * The account at a glance, in one line, so the ticket below keeps its room. Account value, day P/L,
 * buying power and unrealized P/L are in the top bar, so the line has what the bar lacks: the session's
 * P/L, realized P/L, the trades closed and the win rate. The line opens the rest (starting balance,
 * cash, buying power, unrealized P/L), which the top bar leaves out when the window is narrow; once
 * opened it stays open, after a reload too (useRememberedOpen).
 */
function AccountBox() {
  const account = useTrading((s) => s.account);
  const trips = useTrading((s) => s.trips);
  const [open, setOpen] = useRememberedOpen('account-details');
  const stats = useMemo(() => {
    const closed = trips.filter((t) => t.closed);
    const wins = closed.filter((t) => t.pnl > 0).length;
    return { n: closed.length, winRate: closed.length ? (wins / closed.length) * 100 : null };
  }, [trips]);
  if (!account) return null;
  const total = account.equity - account.startingBalance;
  const item = (k: string, v: string, cls = '', title?: string) => (
    <span className="acct-item" title={title}>
      <span className="k">{k}</span>
      <span className={`v num ${cls}`}>{v}</span>
    </span>
  );
  return (
    <details className="acct" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary title={open ? 'Hide the account details' : 'Starting balance, cash, buying power and unrealized P/L'}>
        {item('Session P/L', signedMoney(total), pnlClass(total), account.startingBalance > 0 ? `${pct((total / account.startingBalance) * 100, 2, true)} since the session started` : undefined)}
        {item('Realized', signedMoney(account.realizedPnl), pnlClass(account.realizedPnl))}
        {item('Trades', String(stats.n), '', 'Closed trades this session')}
        {item('Win rate', stats.winRate === null ? '—' : `${stats.winRate.toFixed(0)}%`)}
        <svg className="acct-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </summary>
      <div className="acct-more">
        {item('Starting balance', money(account.startingBalance))}
        {item('Cash', money(account.cash))}
        {item('Buying power', money(account.buyingPower))}
        {item('Unrealized P/L', signedMoney(account.unrealizedPnl), pnlClass(account.unrealizedPnl))}
      </div>
    </details>
  );
}

function ChallengeWidget() {
  const active = useChallenges((s) => s.active);
  if (!active) return null;
  const def = CHALLENGES.find((c) => c.id === active.challengeId);
  const r = active.result;
  return (
    <div className="right-section">
      <div className="row">
        <b className="small">Challenge</b>
        <div className="spacer" />
        {!r.official && <span className="badge warn">Unofficial (rewound)</span>}
      </div>
      <div className="small" style={{ margin: '4px 0' }}>
        {def?.title ?? active.challengeId}
      </div>
      <div className="challenge-bar">
        <div style={{ width: `${Math.round(r.progress * 100)}%` }} />
      </div>
      <div className="small muted" style={{ marginTop: 4 }}>
        {r.detail}
      </div>
    </div>
  );
}

/**
 * Before any session: one line on how to start, and the other ways in as small links. The chart above
 * has the Replay button; this column only says what it will hold.
 */
function NoSession({ onNewSession }: { onNewSession: (mode: 'replay' | 'sim') => void }) {
  return (
    <div className="right-idle">
      <p>Press Replay above the chart, then click the bar to start from. Your paper account and order ticket appear here.</p>
      <p className="right-idle-links">
        <button type="button" className="link-btn" onClick={() => onNewSession('replay')}>
          Advanced replay setup
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" className="link-btn" onClick={() => onNewSession('sim')}>
          Simulated market
        </button>
      </p>
    </div>
  );
}

export function RightPanel({ onNewSession }: { onNewSession: (mode: 'replay' | 'sim') => void }) {
  const session = useTrading((s) => s.session);
  // Closing a position from the list removes its row: focus goes to the first position left, else to
  // the ticket's order side, rather than dropping to the page. (The ticket rescues its own controls.)
  const panelRef = useFocusRescue<HTMLDivElement>(
    (root) => root.querySelector<HTMLElement>('.pos-mini-pick') ?? root.querySelector<HTMLElement>('[aria-label="Order side"] button[aria-pressed="true"]'),
  );
  return (
    <div className="panel area-right" ref={panelRef}>
      <div className="panel-head">
        <b>Order ticket</b>
        <div className="spacer" />
        {session && <span className="muted small">Paper trading</span>}
      </div>
      <div className="panel-body right-body">
        {!session && <NoSession onNewSession={onNewSession} />}
        <AccountBox />
        <ChallengeWidget />
        <PositionList />
        <OrderTicket />
      </div>
    </div>
  );
}
