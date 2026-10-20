import { useEffect, useRef, useState } from 'react';
import {
  REPLAY_SPEEDS,
  SIM_SPEEDS,
  blindDayLabel,
  endSession,
  jumpTo,
  pause,
  play,
  restart,
  selectBarBlocked,
  sessionEndNotice,
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
import { focusHome, isShown, modalOpen, useFocusRescue } from './common';
import { usePopover } from './usePopover';
import { ScissorsIcon, toggleSelectBar } from './ReplayMenu';

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
 * Ends the session (Exit), after saying what that does to open positions; the chart goes back to browsing.
 * The row goes with the session, ✕ (`button`) included, so focus goes to the toolbar's Replay button,
 * which starts the next one, rather than to the page body, where screen-reader users lose their place.
 * Not when the user has already put it somewhere else meanwhile.
 */
function confirmExit(button: HTMLElement): void {
  const notice = sessionEndNotice('exit');
  if (notice && !window.confirm(notice)) return;
  void endSession().then(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== button) return;
    const replay = [...document.querySelectorAll<HTMLElement>('.replay-btn')].find(isShown);
    if (replay) replay.focus({ preventScroll: true });
    else focusHome();
  });
}

/**
 * Whether a key press belongs to the replay shortcuts (Space, arrows) rather than to the control
 * that has focus. Text fields, dialogs, popovers and option groups keep their keys, and so do
 * controls that Space toggles (checkboxes, switches, disclosure summaries). On a plain button Space
 * still plays or pauses, and the button is not pressed: after a click on BUY, Space must never
 * place a second order. Enter presses a focused button as usual.
 */
function isReplayShortcut(e: KeyboardEvent): boolean {
  if (modalOpen() || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return false;
  const el = e.target instanceof Element ? e.target : null;
  const arrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
  // The ⋯ panel shows ← and → beside the steps they take: with focus in it, they step there too.
  if (arrow && el?.closest('.more-pop')) return true;
  // An open toolbar menu keeps the keys, even once focus is no longer inside it. Not ⋯'s panel for ← and
  // →: they step while it is open, with focus still on ⋯ after a click (or on the page, where a click
  // focuses no button, as in Safari), and nothing can be acting behind it, as only one panel is open at a
  // time (usePopover). Space is still left to the focused control (on ⋯ it closes the panel), and the
  // checks below still leave fields and dialogs their arrows.
  if ([...document.querySelectorAll('.popover')].some((pop) => !(arrow && pop.classList.contains('more-pop')))) return false;
  if (!el) return true;
  if (el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], .popover, [role="radiogroup"], [role="listbox"], [role="menu"], [role="tablist"], [role="slider"], [role="combobox"]')) return false;
  if (e.code === 'Space' && el.closest('summary, [role="checkbox"], [role="switch"], [role="option"]')) return false;
  return true;
}

/**
 * Jump to a date and time, from a small menu so the replay controls fit on one row. Its fields show
 * the replay clock until edited; a jump or a new session clears the edits. Enter in a field jumps.
 */
function JumpMenu() {
  const session = useTrading((s) => s.session);
  const now = useTrading((s) => s.now);
  const { open, toggle, close, boxRef, triggerRef, popRef } = usePopover();
  const [edited, setEdited] = useState<{ session?: string; date?: string; time?: string }>({});
  const edits = edited.session === session?.id ? edited : {};
  // Blind mode has no date field: the date is always the replay's current day.
  const jumpDate = (!session?.blind && edits.date) || (now ? exchangeDate(now) : '');
  const jumpTime = edits.time ?? (now ? formatExchangeTime(now) : '');
  const edit = (field: 'date' | 'time', value: string) => setEdited({ ...edits, session: session?.id, [field]: value });
  if (!session) return null;

  const doJump = () => {
    if (!jumpDate || !jumpTime) return;
    const t = exchangeTimeToUnix(jumpDate, parseHHMM(jumpTime));
    if (t < now && !confirmRewind(t)) return;
    setEdited({});
    jumpTo(t);
    close();
  };

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button ref={triggerRef} className={`btn sm${open ? ' active' : ''}`} onClick={toggle} aria-expanded={open} title="Jump to a date and time">
        Jump to…
      </button>
      {open && (
        <div ref={popRef} className="card popover jump-pop" role="dialog" aria-label="Jump to a time">
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              doJump();
            }}
          >
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              {!session.blind && (
                <label className="field">
                  Date
                  <input type="date" value={jumpDate} onChange={(e) => edit('date', e.target.value)} style={{ width: 140 }} />
                </label>
              )}
              <label className="field">
                Time (ET)
                <input type="time" value={jumpTime} onChange={(e) => edit('time', e.target.value)} />
              </label>
              <button type="submit" className="btn sm primary">
                Jump
              </button>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              Forward jumps process every skipped bar, so your orders still fill. Jumping back rewinds the session.
            </p>
          </form>
        </div>
      )}
    </div>
  );
}

/**
 * The replay's less used controls, kept out of the row so it stays as simple as TradingView's: Restart,
 * Step back one bar and Step forward one bar (one bar of the data, finer than the chart's candles). Its
 * panel stays open while they are used, so a few steps take a click each; the keys do them too.
 */
function MoreControls({ now, start, finished, ordered }: { now: number; start: number; finished: boolean; ordered: boolean }) {
  const { open, toggle, boxRef, triggerRef, popRef } = usePopover();
  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <button ref={triggerRef} className={`btn icon${open ? ' active' : ''}`} data-home="more" onClick={toggle} aria-expanded={open} aria-label="More replay controls" title="Restart, step back, step one bar">
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div ref={popRef} className="card popover more-pop" role="dialog" aria-label="More replay controls">
          <button className="btn sm" title="Restart (rewind to start)" aria-label="Restart" onClick={() => confirmRewind(start, true) && restart()} disabled={now <= start && !ordered}>
            <span aria-hidden="true">⏮</span> Restart
          </button>
          <button className="btn sm" title="Step back one bar (←)" aria-label="Step back one bar" onClick={confirmStepBack} disabled={now <= start}>
            <span aria-hidden="true">◀</span> Step back one bar <kbd>←</kbd>
          </button>
          <button className="btn sm" title="Step forward one bar of the data (→)" aria-label="Step forward one bar" onClick={stepForward} disabled={finished}>
            <span aria-hidden="true">▶|</span> Step forward one bar <kbd>→</kbd>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A badge of the replay row, in full (`full`) or, where the row is short of room, shortened (`short`):
 * the full text stays in its title and for screen readers. `shortTitle`: the shortened text's own
 * tooltip, when it says more than this badge (REWOUND and END OF REPLAY in one, below).
 */
function Badge({ tone, full, short, title, shortTitle }: { tone: 'warn' | 'neutral'; full: string; short: string; title: string; shortTitle?: string }) {
  return (
    <span className={`badge ${tone} replay-badge`} title={title}>
      <span className="badge-full">{full}</span>
      <span className="badge-short" aria-hidden="true" title={shortTitle}>
        {short}
      </span>
    </span>
  );
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
  const selecting = useTrading((s) => s.selectingBar);
  // Set when Space was used for play/pause, so its keyup cannot press the focused button either
  // (some browsers press buttons on keyup). A ref, so it survives the listeners being re-registered.
  const spaceTaken = useRef(false);
  const isReplay = session?.mode === 'replay';
  // Restart and Step back disable themselves at the start, Play and the steps at the end: focus then
  // goes to Play, else ⋯ (Restart and Step back are behind it), else the speed. Never to a control in
  // a popover: focus there would keep the panel open behind it, and Enter on it would act unseen.
  const barRef = useFocusRescue<HTMLDivElement>(
    (bar) =>
      bar.querySelector<HTMLElement>('[data-home="play"]:not(:disabled)') ??
      bar.querySelector<HTMLElement>('[data-home="more"]') ??
      bar.querySelector<HTMLElement>('select'),
  );
  // Read when rendering: what the session is, and the browsing chart's bars, decide it.
  const selectBlocked = selectBarBlocked();

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

  return (
    <div className="replay-bar" ref={barRef}>
      {isReplay ? (
        <>
          {/* Picks a bar to start a fresh replay from, ending this one as any new start does. */}
          <button
            className={`btn sm${selecting ? ' active' : ''}`}
            aria-pressed={selecting}
            aria-disabled={!!selectBlocked || undefined}
            title={selectBlocked ?? (selecting ? 'Stop picking a bar (Esc)' : 'Select bar: click a bar on the chart to start a new replay there')}
            onClick={toggleSelectBar}
          >
            <ScissorsIcon /> Select bar
          </button>
          <button className={`btn ${playing ? '' : 'primary'}`} data-home="play" style={{ minWidth: 76 }} onClick={() => (playing ? pause() : play())} disabled={finished}>
            <span aria-hidden="true">{playing ? '❚❚' : '▶'}</span> {playing ? 'Pause' : 'Play'}
          </button>
          <button className="btn icon" title={`Forward one ${timeframe} candle (Shift+→)`} aria-label={`Forward one ${timeframe} candle`} onClick={stepCandle} disabled={finished}>
            <span aria-hidden="true">⏭</span>
          </button>
        </>
      ) : (
        <button className={`btn ${playing ? '' : 'primary'}`} onClick={() => (playing ? pause() : play())}>
          {playing ? '❚❚ Pause market' : '▶ Start market'}
        </button>
      )}
      {/* Short labels ("1m/s" rather than "60x · 1m/s"), so the row keeps to one line; the full one is in the title. */}
      <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title={`${isReplay ? 'Replay' : 'Market'} speed: ${speedLabel(speed)} (simulated time per real second)`}>
        {speeds.map((s) => (
          <option key={s} value={s}>
            {speedLabel(s, true)}
          </option>
        ))}
      </select>
      <span className="clock" title="Simulated time (exchange time, ET)">
        {session.blind ? blindDayLabel(now) : exchangeDate(now)} {formatExchangeTime(now, true)}
      </span>
      {/* Also on the ticket and the price scale, so it gives way first on narrower screens. */}
      {quote && (
        <span className="mono replay-last" title="Last traded price">
          {price(quote.last)}
        </span>
      )}
      {/* Shortened on narrower screens (styles.css), so the row keeps to one line on a laptop. Both at once
          shorten to one badge, ↺ ×1 · END: the END badge then gives way, its text kept for screen readers. */}
      {rewinds > 0 && (
        <Badge
          tone="warn"
          full={`REWOUND ×${rewinds}`}
          short={`↺ ×${rewinds}${finished ? ' · END' : ''}`}
          title={`REWOUND ×${rewinds}: you rewound this session; results are not blind.`}
          shortTitle={finished ? `REWOUND ×${rewinds}: you rewound this session; results are not blind. END OF REPLAY` : undefined}
        />
      )}
      {finished && <Badge tone="neutral" full="END OF REPLAY" short="END" title="END OF REPLAY" />}
      {/* A line along the bar's top edge, so it takes no room in the row. Placed against the whole row. */}
      {isReplay && (
        <div className="progress" title={`${(progress * 100).toFixed(0)}% of the session window`}>
          <div style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      {/* At the right end, together: when the row runs out of room they wrap as one, still on the right. */}
      <div className="replay-end">
        {isReplay && (
          <>
            <JumpMenu />
            <MoreControls now={now} start={session.start} finished={finished} ordered={ordered} />
          </>
        )}
        <button className="btn icon" onClick={(e) => confirmExit(e.currentTarget)} aria-label={isReplay ? 'Exit replay' : 'Exit the simulated market'} title={isReplay ? 'Exit replay: end it and go back to the chart' : 'Exit the simulated market: end it and go back to the chart'}>
          <span aria-hidden="true">✕</span>
        </button>
      </div>
    </div>
  );
}
