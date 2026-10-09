import { useEffect, useRef, useState } from 'react';
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
  stepBackTarget,
  stepForward,
  togglePlay,
  tradesUndoneBy,
  useTrading,
} from '../state/tradingStore';
import { exchangeDate, exchangeTimeToUnix, formatExchangeTime, parseHHMM } from '../../core/time';
import { price, speedLabel } from '../services/format';
import { modalOpen, useFocusRescue } from './common';

/** Warns before a rewind to `target` (or Restart) and says what it undoes; false when cancelled. */
function confirmRewind(target: number | null, restart = false): boolean {
  if (target === null) return false;
  const { open, closed, hides } = tradesUndoneBy(target, restart);
  // Going back before any new bar has appeared (Restart at the start) hides nothing, so it is not a rewind.
  const first = useTrading.getState().rewinds === 0 && hides;
  const parts: string[] = [];
  if (first) parts.push('Going back in time means you have seen what happens next. This session will be marked "rewound": challenges become unofficial and journal entries are flagged.');
  if (closed > 0) parts.push(`This will undo ${closed} closed trade(s) and permanently delete ${closed === 1 ? 'its journal entry' : 'their journal entries'}, notes included.`);
  if (open > 0) parts.push(`${open} open trade(s) entered after that point will be undone.`);
  return parts.length === 0 || window.confirm(`${parts.join('\n\n')}\n\nContinue?`);
}

/** Step back one bar, after the same warning as any rewind. */
function confirmStepBack(): void {
  if (confirmRewind(stepBackTarget())) stepBack();
}

/**
 * Whether a key press belongs to the replay shortcuts (Space, arrows) rather than to the control
 * that has focus. Text fields, dialogs, popovers and option groups keep their keys, and so do
 * controls that Space toggles (checkboxes, switches, disclosure summaries). On a plain button Space
 * still plays or pauses, and the button is not pressed: after a click on BUY, Space must never
 * place a second order. Enter presses a focused button as usual.
 */
function isReplayShortcut(e: KeyboardEvent): boolean {
  // An open toolbar menu keeps the keys, even once focus is no longer inside it.
  if (modalOpen() || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.popover')) return false;
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return true;
  if (el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], .popover, [role="radiogroup"], [role="listbox"], [role="menu"], [role="tablist"], [role="slider"], [role="combobox"]')) return false;
  if (e.code === 'Space' && el.closest('summary, [role="checkbox"], [role="switch"], [role="option"]')) return false;
  return true;
}

export function ReplayControls({ active = true }: { active?: boolean }) {
  const session = useTrading((s) => s.session);
  const playing = useTrading((s) => s.playing);
  const speed = useTrading((s) => s.speed);
  const now = useTrading((s) => s.now);
  const finished = useTrading((s) => s.finished);
  const rewinds = useTrading((s) => s.rewinds);
  const quote = useTrading((s) => s.quotes[s.activeSymbol]);
  const timeframe = useTrading((s) => s.timeframe);
  // Restart also clears orders placed at the start, so it stays available there once there are any.
  const ordered = useTrading((s) => s.orders.length > 0);
  // The jump fields show the replay clock until the user edits them; a jump or a new session clears the edits.
  const [edited, setEdited] = useState<{ session?: string; date?: string; time?: string }>({});
  // Set when Space was used for play/pause, so its keyup cannot press the focused button either
  // (some browsers press buttons on keyup). A ref, so it survives the listeners being re-registered.
  const spaceTaken = useRef(false);
  const isReplay = session?.mode === 'replay';
  const edits = edited.session === session?.id ? edited : {};
  // Restart and Step back disable themselves at the start, Play and the steps at the end: focus then
  // goes to Play, else Step back, else the speed.
  const barRef = useFocusRescue<HTMLDivElement>(
    (bar) =>
      bar.querySelector<HTMLElement>('[data-home="play"]:not(:disabled)') ??
      bar.querySelector<HTMLElement>('[data-home="back"]:not(:disabled)') ??
      bar.querySelector<HTMLElement>('select'),
  );
  // Blind mode has no date field: the date is always the replay's current day.
  const jumpDate = (!session?.blind && edits.date) || (now ? exchangeDate(now) : '');
  const jumpTime = edits.time ?? (now ? formatExchangeTime(now) : '');
  const edit = (field: 'date' | 'time', value: string) => setEdited({ ...edits, session: session?.id, [field]: value });

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!session || !isReplayShortcut(e)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        spaceTaken.current = true;
        if (!e.repeat) togglePlay();
      } else if (e.key === 'ArrowRight' && isReplay) {
        e.preventDefault();
        if (e.shiftKey) stepCandle();
        else stepForward();
      } else if (e.key === 'ArrowLeft' && isReplay) {
        e.preventDefault();
        confirmStepBack();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !spaceTaken.current) return;
      spaceTaken.current = false;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [session, isReplay, active]);

  if (!session) return null;
  const progress = session.end ? Math.min(1, Math.max(0, (now - session.start) / (session.end - session.start))) : 0;
  const speeds = isReplay ? REPLAY_SPEEDS : SIM_SPEEDS;

  const doJump = () => {
    if (!jumpDate || !jumpTime) return;
    const t = exchangeTimeToUnix(jumpDate, parseHHMM(jumpTime));
    if (t < now && !confirmRewind(t)) return;
    setEdited({});
    jumpTo(t);
  };

  return (
    <div className="replay-bar" ref={barRef}>
      {isReplay ? (
        <>
          <button className="btn icon" title="Restart (rewind to start)" aria-label="Restart" onClick={() => confirmRewind(session.start, true) && restart()} disabled={now <= session.start && !ordered}>
            <span aria-hidden="true">⏮</span>
          </button>
          <button className="btn icon" data-home="back" title="Step back one bar (←)" aria-label="Step back one bar" onClick={confirmStepBack} disabled={now <= session.start}>
            <span aria-hidden="true">◀</span>
          </button>
          <button className={`btn ${playing ? '' : 'primary'}`} data-home="play" style={{ minWidth: 76 }} onClick={() => (playing ? pause() : play())} disabled={finished}>
            <span aria-hidden="true">{playing ? '❚❚' : '▶'}</span> {playing ? 'Pause' : 'Play'}
          </button>
          <button className="btn icon" title="Step forward one bar (→)" aria-label="Step forward one bar" onClick={stepForward} disabled={finished}>
            <span aria-hidden="true">▶|</span>
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
            {!session.blind && <input type="date" value={jumpDate} onChange={(e) => edit('date', e.target.value)} aria-label="Jump to date" title="Jump to date" style={{ width: 130 }} />}
            <input type="time" value={jumpTime} onChange={(e) => edit('time', e.target.value)} aria-label="Jump to time (ET)" title="Jump to time (ET)" style={{ width: 'auto' }} />
            <button className="btn sm" onClick={doJump} title="Jump to time. Forward jumps process every skipped bar, so your orders still fill.">
              Jump
            </button>
          </span>
        </>
      )}
    </div>
  );
}
