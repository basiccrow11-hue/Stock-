/** Sessions a reload, a closed tab or a crash left unfinished, to carry on or let go (savedSessions). */
import { useCallback, useEffect, useState } from 'react';
import { SourceBadge } from './common';
import { blindDayLabel, discardSession, resumeSession, unfinishedSessions, useTrading } from '../state/tradingStore';
import { onSessionFreed, type SessionSummary } from '../services/savedSessions';
import { CHALLENGES } from '../../core/challenges/challenges';
import { exchangeDate, formatExchangeTime } from '../../core/time';

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${plural(min, 'minute')} ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${plural(h, 'hour')} ago`;
  return new Date(ms).toLocaleDateString('en-US', { dateStyle: 'medium' });
}

/** Where the session had got to, its date hidden in blind mode as everywhere else. */
function where(s: SessionSummary): string {
  const m = s.meta;
  const time = `${formatExchangeTime(s.now)} ET`;
  if (m.mode === 'sim') return time;
  return `${m.blind ? blindDayLabel(s.now, m.startDate) : exchangeDate(s.now)} ${time}${s.finished ? ' (end reached)' : ''}`;
}

function Row({ s, onGone }: { s: SessionSummary; onGone: () => void }) {
  const [busy, setBusy] = useState(false);
  const pnl = s.equity - s.startingBalance;
  const money = `${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // Its challenge attempt, while one is under way (a summary saved before that was noted says only which it started with).
  const challenge = s.meta.challengeId && (s.challengeUnderWay ?? true) ? CHALLENGES.find((c) => c.id === s.meta.challengeId) : undefined;
  const discard = async () => {
    const open = s.openPositions ? ` Its ${plural(s.openPositions, 'open position')} ${s.openPositions === 1 ? 'goes' : 'go'} without a journal entry.` : '';
    const attempt = challenge ? ' Its challenge attempt is kept as abandoned.' : '';
    if (!window.confirm(`Discard this session? Its closed trades stay in your journal.${open}${attempt}`)) return;
    setBusy(true);
    await discardSession(s.id).catch(() => false);
    setBusy(false);
    onGone();
  };
  return (
    <li className="unfinished">
      <div className="stack" style={{ gap: 2, minWidth: 0 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <strong>{s.meta.label}</strong>
          <SourceBadge source={s.meta.source} />
        </div>
        <span className="small">
          {where(s)} · {plural(s.closedTrades, 'trade')} closed{s.openPositions ? ` · ${plural(s.openPositions, 'position')} open` : ''} · P&amp;L{'\u00a0'}{money}
        </span>
        <span className="small muted">
          {challenge ? `Challenge: ${challenge.title} · ` : ''}Saved {ago(s.savedAt)}
        </span>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn primary sm" aria-disabled={busy} onClick={() => !busy && void resumeSession(s.id).then((ok) => !ok && onGone())}>
          Resume
        </button>
        <button className="btn sm" aria-disabled={busy} onClick={() => !busy && void discard()}>
          Discard
        </button>
      </div>
    </li>
  );
}

export function UnfinishedSessions() {
  const session = useTrading((s) => s.session);
  const loading = useTrading((s) => s.loading);
  const carryingOn = useTrading((s) => s.carryingOn !== null);
  const [list, setList] = useState<SessionSummary[]>([]);
  const refresh = useCallback(() => {
    unfinishedSessions()
      .then(setList)
      .catch(() => setList([]));
  }, []);
  // Looked at again once a reload has carried its session on, or found that it cannot (then it is listed).
  useEffect(() => {
    if (!session && !loading && !carryingOn) refresh();
  }, [session, loading, carryingOn, refresh]);
  // A session another tab runs is offered once that tab lets it go (closed, or crashed), and the list
  // is looked at again on coming back to this tab.
  useEffect(() => (session ? undefined : onSessionFreed(refresh)), [session, list, refresh]);
  useEffect(() => {
    const onShow = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);
  if (!list.length) return null;
  return (
    <section className="card stack unfinished-list" aria-label="Unfinished sessions">
      <h3>{list.length === 1 ? 'Unfinished session' : 'Unfinished sessions'}</h3>
      <p className="small muted">Carry on where you left off, paused, or discard it.</p>
      <ul>
        {list.map((s) => (
          <Row key={s.id} s={s} onGone={refresh} />
        ))}
      </ul>
    </section>
  );
}
