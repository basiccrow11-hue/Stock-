/** Right column: account summary, active challenge progress, open positions and the order ticket. */
import { useMemo } from 'react';
import { useTrading } from '../state/tradingStore';
import { useChallenges } from '../state/challengeStore';
import { CHALLENGES } from '../../core/challenges/challenges';
import { OrderTicket } from './OrderTicket';
import { PositionList } from './PositionList';
import { EmptyState, useFocusRescue } from './common';
import { money, pct, pnlClass, signedMoney } from '../services/format';

/**
 * The account at a glance, in little room so the ticket below stays in view. Account value and day
 * P/L are always in the top bar, so they are not repeated here; the starting balance is only here.
 */
function AccountBox() {
  const account = useTrading((s) => s.account);
  const trips = useTrading((s) => s.trips);
  const stats = useMemo(() => {
    const closed = trips.filter((t) => t.closed);
    const wins = closed.filter((t) => t.pnl > 0).length;
    return { n: closed.length, winRate: closed.length ? (wins / closed.length) * 100 : null };
  }, [trips]);
  if (!account) return null;
  const total = account.equity - account.startingBalance;
  const item = (k: string, v: string, cls = '', title?: string) => (
    <div title={title}>
      <dt>{k}</dt>
      <dd className={`num ${cls}`}>{v}</dd>
    </div>
  );
  return (
    <dl className="acct">
      {item('Starting balance', money(account.startingBalance))}
      {item('Cash', money(account.cash))}
      {item('Buying power', money(account.buyingPower))}
      {item('Session P/L', signedMoney(total), pnlClass(total), account.startingBalance > 0 ? `${pct((total / account.startingBalance) * 100, 2, true)} since the session started` : undefined)}
      {item('Unrealized P/L', signedMoney(account.unrealizedPnl), pnlClass(account.unrealizedPnl))}
      {item('Realized P/L', signedMoney(account.realizedPnl), pnlClass(account.realizedPnl))}
      {item('Closed trades', String(stats.n))}
      {item('Win rate', stats.winRate === null ? '—' : `${stats.winRate.toFixed(0)}%`)}
    </dl>
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

/** Before any session: what this column is for, and how to start. */
function NoSession({ onNewSession }: { onNewSession: (mode: 'replay' | 'sim') => void }) {
  return (
    <EmptyState title="No session running">
      <p className="small" style={{ margin: '0 0 12px' }}>
        Start a replay of a past trading day or the simulated market. Your paper account, open positions and the order ticket appear here.
      </p>
      <div className="stack">
        <button className="btn primary" onClick={() => onNewSession('replay')}>
          Start a historical replay
        </button>
        <button className="btn" onClick={() => onNewSession('sim')}>
          Start the simulated market
        </button>
      </div>
    </EmptyState>
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
