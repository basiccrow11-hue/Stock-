import { useEffect, useState } from 'react';
import {
  REPLAY_SPEEDS,
  SIM_SPEEDS,
  blindDayLabel,
  jumpTo,
  pause,
  play,
  restart,
  setSpeed,
  stepBack,
  stepCandle,
  stepForward,
  togglePlay,
  tradesUndoneBy,
  useTrading,
} from '../state/tradingStore';
import { exchangeDate, exchangeTimeToUnix, formatExchangeTime, parseHHMM } from '../../core/time';
import { price } from '../services/format';

function speedLabel(s: number): string {
  if (s === 1) return '1x real time';
  if (s < 60) return `${s}x`;
  const perSec = s / 60;
  return `${s}x · ${perSec >= 60 ? `${perSec / 60}h` : `${perSec}m`}/s`;
}

function confirmRewind(target: number): boolean {
  const n = tradesUndoneBy(target);
  const first = useTrading.getState().rewinds === 0;
  const parts: string[] = [];
  if (first) parts.push('Going back in time means you have seen what happens next. This session will be marked "rewound": challenges become unofficial and journal entries are flagged.');
  if (n > 0) parts.push(`This will undo ${n} trade(s) after that point and remove their journal entries.`);
  return parts.length === 0 || window.confirm(`${parts.join('\n\n')}\n\nContinue?`);
}

export function ReplayControls() {
  const session = useTrading((s) => s.session);
  const playing = useTrading((s) => s.playing);
  const speed = useTrading((s) => s.speed);
  const now = useTrading((s) => s.now);
  const finished = useTrading((s) => s.finished);
  const rewinds = useTrading((s) => s.rewinds);
  const quote = useTrading((s) => s.quotes[s.activeSymbol]);
  const timeframe = useTrading((s) => s.timeframe);
  const [jumpDate, setJumpDate] = useState('');
  const [jumpTime, setJumpTime] = useState('');
  const isReplay = session?.mode === 'replay';

  useEffect(() => {
    if (now) {
      setJumpDate(exchangeDate(now));
      setJumpTime(formatExchangeTime(now));
    }
    // Only refresh the jump fields when the session changes or playback pauses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, playing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !session) return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowRight' && isReplay) {
        e.preventDefault();
        if (e.shiftKey) stepCandle();
        else stepForward();
      } else if (e.key === 'ArrowLeft' && isReplay) {
        e.preventDefault();
        const last = now - 60;
        if (confirmRewind(last)) stepBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, isReplay, now]);

  if (!session) return null;
  const progress = session.end ? Math.min(1, Math.max(0, (now - session.start) / (session.end - session.start))) : 0;
  const speeds = isReplay ? REPLAY_SPEEDS : SIM_SPEEDS;

  const doJump = () => {
    if (!jumpDate || !jumpTime) return;
    const t = exchangeTimeToUnix(jumpDate, parseHHMM(jumpTime));
    if (t < now && !confirmRewind(t)) return;
    jumpTo(t);
  };

  return (
    <div className="replay-bar">
      {isReplay ? (
        <>
          <button className="btn icon" title="Restart (rewind to start)" onClick={() => confirmRewind(session.start) && restart()} disabled={now <= session.start}>
            ⏮
          </button>
          <button className="btn icon" title="Step back one bar (←)" onClick={() => confirmRewind(now - 60) && stepBack()} disabled={now <= session.start}>
            ◀
          </button>
          <button className={`btn ${playing ? '' : 'primary'}`} style={{ minWidth: 76 }} onClick={() => (playing ? pause() : play())} disabled={finished}>
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <button className="btn icon" title="Step forward one 1-minute bar (→)" onClick={stepForward} disabled={finished}>
            ▶|
          </button>
          <button className="btn sm" title={`Step one ${timeframe} candle (Shift+→)`} onClick={stepCandle} disabled={finished}>
            +1 {timeframe}
          </button>
        </>
      ) : (
        <button className={`btn ${playing ? '' : 'primary'}`} onClick={() => (playing ? pause() : play())}>
          {playing ? '❚❚ Pause market' : '▶ Start market'}
        </button>
      )}
      <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Replay speed (simulated time per real second)">
        {speeds.map((s) => (
          <option key={s} value={s}>
            {speedLabel(s)}
          </option>
        ))}
      </select>
      <span className="clock" title="Simulated time (exchange time, ET)">
        {session.blind ? blindDayLabel(now) : exchangeDate(now)} {formatExchangeTime(now, true)}
      </span>
      {quote && (
        <span className="mono" title="Last traded price">
          {price(quote.last)}
        </span>
      )}
      {rewinds > 0 && <span className="badge warn" title="You rewound this session; results are not blind.">REWOUND ×{rewinds}</span>}
      {finished && <span className="badge neutral">END OF REPLAY</span>}
      {isReplay && (
        <>
          <div className="progress" title={`${(progress * 100).toFixed(0)}% of the session window`}>
            <div style={{ width: `${progress * 100}%` }} />
          </div>
          <span className="row" style={{ gap: 4 }}>
            {!session.blind && <input type="date" value={jumpDate} onChange={(e) => setJumpDate(e.target.value)} style={{ width: 130 }} />}
            <input type="time" value={jumpTime} onChange={(e) => setJumpTime(e.target.value)} style={{ width: 96 }} />
            <button className="btn sm" onClick={doJump} title="Jump to time. Forward jumps process every skipped bar, so your orders still fill.">
              Jump
            </button>
          </span>
        </>
      )}
    </div>
  );
}
