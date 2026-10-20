/** Sessions a reload, a closed tab or a crash left unfinished, to carry on or let go (savedSessions). */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SourceBadge, focusHome, isShown } from './common';
import { focusPlayOnceIn } from './ReplayControls';
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

/** `onGone`: the session may no longer be listed; `focused`, whether focus was in its row (on its buttons). */
function Row({ s, onGone }: { s: SessionSummary; onGone: (focused: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const gone = () => onGone(!!rowRef.current?.contains(document.activeElement));
  const pnl = s.equity - s.startingBalance;
  const money = `${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  // Its challenge attempt, while one is under way (a summary saved before that was noted says only which it started with).
  const challenge = s.meta.challengeId && (s.challengeUnderWay ?? true) ? CHALLENGES.find((c) => c.id === s.meta.challengeId) : undefined;
  // This card goes as the session loads, and focus on its Resume with it: pressed from the keyboard (or with a
  // click that focuses it, or none), focus goes on to the replay row's Play once the session is in, never to
  // the page. One that cannot be carried on is listed again (gone).
  const resume = () => {
    const active = document.activeElement;
    const focused = !active || active === document.body || !!rowRef.current?.contains(active);
    if (focused) focusPlayOnceIn(s.id);
    void resumeSession(s.id).then((ok) => {
      if (ok) return;
      if (focused) focusPlayOnceIn(null);
      gone();
    });
  };
  const discard = async () => {
    const open = s.openPositions ? ` Its ${plural(s.openPositions, 'open position')} ${s.openPositions === 1 ? 'goes' : 'go'} without a journal entry.` : '';
    const attempt = challenge ? ' Its challenge attempt is kept as abandoned.' : '';
    if (!window.confirm(`Discard this session? Its closed trades stay in your journal.${open}${attempt}`)) return;
    setBusy(true);
    await discardSession(s.id).catch(() => false);
    setBusy(false);
    gone();
  };
  return (
    <li className="unfinished" ref={rowRef}>
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
        <button className="btn primary sm" aria-disabled={busy} onClick={() => !busy && resume()}>
          Resume
        </button>
        <button className="btn sm" aria-disabled={busy} onClick={() => !busy && void discard()}>
          Discard
        </button>
      </div>
    </li>
  );
}

/** The sessions left unfinished, to resume or discard. `onList` hears how many it lists, whenever that changes. */
export function UnfinishedSessions({ onList }: { onList?: (count: number) => void } = {}) {
  const session = useTrading((s) => s.session);
  const loading = useTrading((s) => s.loading);
  const carryingOn = useTrading((s) => s.carryingOn !== null);
  // The saved sessions that keep a chart from being drawn, as the store last read them (on another tab's
  // start, save or end, or its letting one go): the note on such a chart and this card say the same.
  const holds = useTrading((s) => s.browse.holds);
  const [list, setList] = useState<SessionSummary[]>([]);
  // Looks overlap (a change in another tab as this one comes into view): only the newest one's answer is used.
  const asked = useRef(0);
  const refresh = useCallback(() => {
    const seq = ++asked.current;
    unfinishedSessions()
      .then((l) => seq === asked.current && setList(l))
      .catch(() => seq === asked.current && setList([]));
  }, []);
  // Looked at again once a reload has carried its session on, or found that it cannot (then it is listed),
  // and as what keeps a chart from being drawn changes: a session another tab started is listed once that
  // tab lets it go (the list looked at again watches it), and one another tab carries on is no longer offered.
  useEffect(() => {
    if (!session && !loading && !carryingOn) refresh();
  }, [session, loading, carryingOn, holds, refresh]);
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
  useEffect(() => onList?.(list.length), [list.length, onList]);
  // A row discarded (or whose session failed to resume) while focus was on its buttons takes them with it:
  // once the list without it is in, focus goes on to the Resume of the row now in its place (or the one
  // before it, at the end), else, with none left, the toolbar's Replay button, never to the page. Only then:
  // the list looked at again in the background (coming back to the tab) moves nothing.
  const refocus = useRef<{ id: string; index: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const was = refocus.current;
    if (!was) return;
    refocus.current = null;
    // Still listed (another tab runs it, so it was not discarded): its button still has focus.
    if (list.some((s) => s.id === was.id)) return;
    // Focus moved on meanwhile (a click elsewhere) is left where it is.
    if (document.activeElement && document.activeElement !== document.body) return;
    const resumes = [...(listRef.current?.querySelectorAll<HTMLElement>(':scope > li .btn.primary') ?? [])];
    const target = resumes[Math.min(was.index, resumes.length - 1)] ?? [...document.querySelectorAll<HTMLElement>('.replay-btn')].find(isShown);
    if (target) target.focus({ preventScroll: true });
    else focusHome();
  }, [list]);
  if (!list.length) return null;
  return (
    <section className="card stack unfinished-list" aria-label="Unfinished sessions">
      <h3>{list.length === 1 ? 'Unfinished session' : 'Unfinished sessions'}</h3>
      <p className="small muted">Carry on where you left off, paused, or discard it.</p>
      <ul ref={listRef}>
        {list.map((s, index) => (
          <Row
            key={s.id}
            s={s}
            onGone={(focused) => {
              if (focused) refocus.current = { id: s.id, index };
              refresh();
            }}
          />
        ))}
      </ul>
    </section>
  );
}
