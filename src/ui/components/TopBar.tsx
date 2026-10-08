import { useTrading } from '../state/tradingStore';
import { SourceBadge } from './common';
import { money, pnlClass, signedMoney } from '../services/format';
import { exchangeDate, marketSession, formatExchangeTime } from '../../core/time';
import { blindDayLabel } from '../state/tradingStore';
import { StreakChip } from './Streak';

export type View = 'trade' | 'backtest' | 'journal' | 'analytics' | 'challenges' | 'settings';

const VIEWS: [View, string][] = [
  ['trade', 'Trade'],
  ['backtest', 'Backtest'],
  ['journal', 'Journal'],
  ['analytics', 'Analytics'],
  ['challenges', 'Challenges'],
  ['settings', 'Data & Settings'],
];

const SESSION_LABEL = { pre: 'PRE-MARKET', regular: 'MARKET OPEN', post: 'AFTER HOURS', closed: 'MARKET CLOSED' } as const;

export function TopBar({ view, onView }: { view: View; onView: (v: View) => void }) {
  const session = useTrading((s) => s.session);
  const account = useTrading((s) => s.account);
  const now = useTrading((s) => s.now);
  const playing = useTrading((s) => s.playing);
  const ms = session && now ? marketSession(now) : null;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" />
        Stock Replay
      </div>
      <nav className="nav">
        {VIEWS.map(([v, label]) => (
          <button key={v} className={view === v ? 'on' : ''} onClick={() => onView(v)}>
            {label}
          </button>
        ))}
      </nav>
      <StreakChip />
      <div className="integrity">
        {session ? (
          <>
            <SourceBadge source={session.source} />
            <span className="badge neutral">{session.mode === 'replay' ? 'REPLAY' : 'SIM MARKET'}</span>
            {ms && (
              <span className={`badge ${ms === 'regular' ? 'pos' : ms === 'closed' ? 'neutral' : 'warn'}`} title="Simulated market status at the replay clock">
                <span className={`dot${playing ? ' pulse' : ''}`} />
                {SESSION_LABEL[ms]} · {session.blind ? blindDayLabel(now) : exchangeDate(now)} {formatExchangeTime(now)} ET
              </span>
            )}
          </>
        ) : (
          <span className="badge neutral">NO ACTIVE SESSION</span>
        )}
      </div>
      {account && (
        <div className="metrics">
          <div className="metric">
            <span className="k">Account value</span>
            <span className="v">{money(account.equity)}</span>
          </div>
          <div className="metric opt">
            <span className="k">Cash</span>
            <span className="v">{money(account.cash)}</span>
          </div>
          <div className="metric opt">
            <span className="k">Buying power</span>
            <span className="v">{money(account.buyingPower)}</span>
          </div>
          <div className="metric">
            <span className="k">Day P/L</span>
            <span className={`v ${pnlClass(account.dayPnl)}`}>{signedMoney(account.dayPnl)}</span>
          </div>
          <div className="metric opt">
            <span className="k">Unrealized</span>
            <span className={`v ${pnlClass(account.unrealizedPnl)}`}>{signedMoney(account.unrealizedPnl)}</span>
          </div>
          <div className="metric opt">
            <span className="k">Realized</span>
            <span className={`v ${pnlClass(account.realizedPnl)}`}>{signedMoney(account.realizedPnl)}</span>
          </div>
        </div>
      )}
    </header>
  );
}
