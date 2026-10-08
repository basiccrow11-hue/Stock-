/** Right column: account summary, active challenge progress and the order ticket. */
import { useMemo } from 'react';
import { useTrading } from '../state/tradingStore';
import { useChallenges } from '../state/challengeStore';
import { CHALLENGES } from '../../core/challenges/challenges';
import { OrderTicket } from './OrderTicket';
import { money, pnlClass, signedMoney } from '../services/format';

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
  return (
    <div className="kv" style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
      <span className="k">Total value</span>
      <span className="num">{money(account.equity)}</span>
      <span className="k">Cash</span>
      <span className="num">{money(account.cash)}</span>
      <span className="k">Buying power</span>
      <span className="num">{money(account.buyingPower)}</span>
      <span className="k">Unrealized P/L</span>
      <span className={`num ${pnlClass(account.unrealizedPnl)}`}>{signedMoney(account.unrealizedPnl)}</span>
      <span className="k">Realized P/L</span>
      <span className={`num ${pnlClass(account.realizedPnl)}`}>{signedMoney(account.realizedPnl)}</span>
      <span className="k">Day P/L</span>
      <span className={`num ${pnlClass(account.dayPnl)}`}>{signedMoney(account.dayPnl)}</span>
      <span className="k">Session P/L</span>
      <span className={`num ${pnlClass(total)}`}>{signedMoney(total)}</span>
      <span className="k">Trades · win rate</span>
      <span className="num">
        {stats.n} · {stats.winRate === null ? '—' : `${stats.winRate.toFixed(0)}%`}
      </span>
    </div>
  );
}

function ChallengeWidget() {
  const active = useChallenges((s) => s.active);
  if (!active) return null;
  const def = CHALLENGES.find((c) => c.id === active.challengeId);
  const r = active.result;
  return (
    <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
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

export function RightPanel() {
  const session = useTrading((s) => s.session);
  return (
    <div className="panel area-right">
      <div className="panel-head">
        <b>Order ticket</b>
        <div className="spacer" />
        {session && <span className="muted small">Paper trading</span>}
      </div>
      <div className="panel-body">
        <AccountBox />
        <ChallengeWidget />
        <OrderTicket />
      </div>
    </div>
  );
}
