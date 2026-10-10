import { useEffect, useLayoutEffect, useRef } from 'react';
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

/**
 * Shows the optional parts of a bar (elements with a data-fit rank, 1 the most useful), most useful
 * first, for as long as they fit without making the bar taller or wider than it is without any of
 * them, and hides the rest (data-cut). So a wider window only ever adds parts, in the same order.
 */
export function fitOptional(bar: HTMLElement): void {
  const parts = [...bar.querySelectorAll<HTMLElement>('[data-fit]')].sort((a, b) => Number(a.dataset.fit) - Number(b.dataset.fit));
  for (const p of parts) p.setAttribute('data-cut', '');
  const height = bar.offsetHeight;
  const width = Math.max(bar.clientWidth, bar.scrollWidth);
  for (const p of parts) {
    p.removeAttribute('data-cut');
    if (bar.offsetHeight > height || bar.scrollWidth > width) {
      p.setAttribute('data-cut', '');
      return;
    }
  }
}

/**
 * Keeps the bar's optional parts fitted: before paint when what it shows changes length (`key`) or
 * the window is resized, and a frame later when anything in it changes size some other way (the
 * streak count gaining a digit, fonts loading).
 */
function useFitOptional(key: string) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (ref.current) fitOptional(ref.current);
  }, [key]);
  useEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const fit = () => fitOptional(bar);
    window.addEventListener('resize', fit);
    let frame = 0;
    const ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(fit);
          });
    for (const el of bar.children) ro?.observe(el);
    return () => {
      window.removeEventListener('resize', fit);
      cancelAnimationFrame(frame);
      ro?.disconnect();
    };
  }, []);
  return ref;
}

export function TopBar({ view, onView }: { view: View; onView: (v: View) => void }) {
  const session = useTrading((s) => s.session);
  const account = useTrading((s) => s.account);
  const now = useTrading((s) => s.now);
  const playing = useTrading((s) => s.playing);
  const ms = session && now ? marketSession(now) : null;
  const when = session && ms ? ` · ${session.blind ? blindDayLabel(now) : exchangeDate(now)} ${formatExchangeTime(now)} ET` : '';
  const figures = account ? [money(account.equity), money(account.cash), money(account.buyingPower), signedMoney(account.dayPnl), signedMoney(account.unrealizedPnl), signedMoney(account.realizedPnl)] : [];
  // What decides the widths in the bar: figures are in a monospaced font, so their length is enough.
  const fitKey = [session?.id, session?.source, ms, when.length, ...figures.map((f) => f.length)].join('|');
  const barRef = useFitOptional(fitKey);

  return (
    <header className="topbar" ref={barRef}>
      <div className="brand">
        <span className="logo" aria-hidden="true" />
        {/* The least useful part of the bar: only screen readers get it when the figures need the room. */}
        <span className="brand-name" data-fit="6">
          Stock Replay
        </span>
      </div>
      <nav className="nav">
        {VIEWS.map(([v, label]) => (
          <button key={v} className={view === v ? 'on' : ''} aria-current={view === v ? 'page' : undefined} onClick={() => onView(v)}>
            {label}
          </button>
        ))}
      </nav>
      {/* Source labels come before anything optional, so they are the last thing to be squeezed off screen. */}
      <div className="integrity">
        {session ? (
          <>
            <SourceBadge source={session.source} />
            <span className="badge neutral">{session.mode === 'replay' ? 'REPLAY' : 'SIM MARKET'}</span>
            {ms && (
              <span className={`badge ${ms === 'regular' ? 'success' : ms === 'closed' ? 'neutral' : 'warn'}`} title="Simulated market status at the replay clock">
                <span className={`dot${playing ? ' pulse' : ''}`} />
                {SESSION_LABEL[ms]}
                {/* The replay bar under the chart shows the same clock, so this part is the last to get room. */}
                <span className="session-when" data-fit="5">
                  {when}
                </span>
              </span>
            )}
          </>
        ) : (
          <span className="badge neutral">NO ACTIVE SESSION</span>
        )}
      </div>
      {/* Account value and day P/L always show; the others (data-fit, most useful first) wherever they fit
          on the bar's row. Those are all in the account box on the right too. */}
      <div className="topbar-right">
        {account && (
          <div className="metrics">
            <div className="metric">
              <span className="k">Account value</span>
              <span className="v">{figures[0]}</span>
            </div>
            <div className="metric" data-fit="4">
              <span className="k">Cash</span>
              <span className="v">{figures[1]}</span>
            </div>
            <div className="metric" data-fit="1">
              <span className="k">Buying power</span>
              <span className="v">{figures[2]}</span>
            </div>
            <div className="metric">
              <span className="k">Day P/L</span>
              <span className={`v ${pnlClass(account.dayPnl)}`}>{figures[3]}</span>
            </div>
            <div className="metric" data-fit="2">
              <span className="k">Unrealized</span>
              <span className={`v ${pnlClass(account.unrealizedPnl)}`}>{figures[4]}</span>
            </div>
            <div className="metric" data-fit="3">
              <span className="k">Realized</span>
              <span className={`v ${pnlClass(account.realizedPnl)}`}>{figures[5]}</span>
            </div>
          </div>
        )}
        <StreakChip />
      </div>
    </header>
  );
}
