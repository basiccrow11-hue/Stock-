/**
 * The chart toolbar's Replay button, as in TradingView. Pressing it picks a bar on the chart to start a
 * replay from (select-bar mode: see BarCutLayer); its arrow opens the other ways to start one: at a date,
 * at a random day's open, the full setup form, or the simulated market.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { barReplaySource, browseHiddenReason, selectBarBlocked, sessionEndNotice, setSelectingBar, startRandomBar, startReplayAt, useTrading } from '../state/tradingStore';
import { getProvider, onCsvDatasetsChanged } from '../state/dataRegistry';
import { useSettings } from '../state/settingsStore';
import { useLiveBlind } from '../state/liveBlind';
import { toast } from '../state/toasts';
import { exchangeDate, isTradingDay } from '../../core/time';
import { DEMO_FIRST_DATE } from '../../core/data/demoProvider';
import { usePopover } from './usePopover';

/** Scissors, the Replay button's sign: a replay cuts the chart at a bar. */
export function ScissorsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="4" cy="4" r="2.2" />
      <circle cx="4" cy="12" r="2.2" />
      <path d="M5.7 5.4 14 13M5.7 10.6 14 3" />
    </svg>
  );
}

/** Asks before a start ends a session with open positions (sessionEndNotice); false when the user says no. */
function startConfirmed(): boolean {
  const notice = sessionEndNotice();
  return !notice || window.confirm(notice);
}

/** Turns select-bar mode on or off from a button, or says why it cannot be used now (a blind replay, the simulated market). */
export function toggleSelectBar(): void {
  const blocked = selectBarBlocked();
  if (blocked) toast('info', blocked);
  else setSelectingBar(!useTrading.getState().selectingBar);
}

export function ReplayMenu({ onNewSession }: { onNewSession: (mode: 'replay' | 'sim') => void }) {
  const selecting = useTrading((s) => s.selectingBar);
  // What selectBarBlocked and browseHiddenReason read: the session, the browsing chart's bars arriving and the
  // saved sessions it stops at (browse.holds), its symbol and timeframe.
  useTrading((s) => s.session);
  useTrading((s) => s.browse);
  useTrading((s) => s.activeSymbol);
  useTrading((s) => s.timeframe);
  const blocked = selectBarBlocked();
  // A blind replay of the symbol keeps its chart hidden: a replay from a date, random or not, would show its days with their dates.
  const hidden = browseHiddenReason();
  const { open, toggle, close, boxRef, triggerRef, popRef } = usePopover();
  const [panel, setPanel] = useState<'menu' | 'date'>('menu');
  const replayRef = useRef<HTMLButtonElement>(null);

  // The menu opens with focus on its first item; arrows move through the items.
  useEffect(() => {
    if (open && panel === 'menu') popRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, panel, popRef]);
  const onMenuKey = (e: ReactKeyboardEvent) => {
    const items = [...(popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
    if (to === null || !items.length) return;
    e.preventDefault();
    items[(to + items.length) % items.length].focus();
  };
  const item = (label: string, onSelect: () => void, opts: { title?: string; disabled?: boolean } = {}) => (
    <button
      role="menuitem"
      className="menu-item"
      aria-disabled={opts.disabled || undefined}
      title={opts.title}
      onClick={() => {
        if (opts.disabled) return;
        onSelect();
      }}
    >
      {label}
    </button>
  );

  return (
    <div ref={boxRef} className="replay-menu" style={{ position: 'relative' }}>
      <div className="split" role="group" aria-label="Replay">
        <button
          ref={replayRef}
          className={`btn sm replay-btn${selecting ? ' active' : ''}`}
          aria-pressed={selecting}
          aria-disabled={!!blocked || undefined}
          title={blocked ?? (selecting ? 'Stop picking a bar (Esc)' : 'Replay: click a bar on the chart to start the replay there')}
          onClick={toggleSelectBar}
        >
          <ScissorsIcon /> Replay
        </button>
        <button
          ref={triggerRef}
          className={`btn sm replay-more${open ? ' active' : ''}`}
          aria-label="More ways to start a replay"
          title="More ways to start a replay"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            setPanel('menu');
            toggle();
          }}
        >
          <span aria-hidden="true">▾</span>
        </button>
      </div>
      {open && panel === 'menu' && (
        <div ref={popRef} className="card popover replay-pop" role="menu" aria-label="Start a replay" onKeyDown={onMenuKey}>
          {item(
            'Select bar',
            () => {
              // Focus goes to the Replay button, not the page body: pressed, it tells a screen reader
              // that select-bar mode is on, and pressing it again turns the mode off.
              close(false);
              setSelectingBar(true);
              replayRef.current?.focus({ preventScroll: true });
            },
            { disabled: !!blocked, title: blocked ?? 'Click a bar on the chart to start the replay there' },
          )}
          {item('Select date…', () => setPanel('date'), { disabled: !!hidden, title: hidden ?? 'Start the replay at a date and time' })}
          {item(
            'Random bar',
            () => {
              close();
              if (startConfirmed()) void startRandomBar();
            },
            { disabled: !!hidden, title: hidden ?? 'Start at the open of a day picked at random' },
          )}
          {item('Advanced replay setup…', () => {
            close(false);
            onNewSession('replay');
          })}
          <div role="separator" className="menu-sep" />
          {item('Simulated market…', () => {
            close(false);
            onNewSession('sim');
          })}
        </div>
      )}
      {open && panel === 'date' && (
        <div ref={popRef} className="card popover replay-pop" role="dialog" aria-label="Start the replay at a date">
          <SelectDate
            onBack={() => setPanel('menu')}
            onStart={(date, time) => {
              close();
              if (startConfirmed()) void startReplayAt(date, time);
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Select date: a date and a time (exchange time, 09:30 to begin with) to start the replay of the chart's
 * symbol at, checked as the setup form checks them: a trading day the data covers, with bars for imported
 * data with gaps.
 */
function SelectDate({ onBack, onStart }: { onBack: () => void; onStart: (date: string, time: string) => void }) {
  const [{ providerId, symbol }] = useState(barReplaySource);
  const provider = getProvider(providerId);
  const saved = useSettings.getState().replay.date;
  // The last date used may be one a blind replay that has not ended is hiding.
  const [date, setDate] = useState(() => (Object.values(useLiveBlind.getState().sessions).includes(saved) ? '' : saved));
  const [time, setTime] = useState('09:30');
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [days, setDays] = useState<string[] | null>(null);
  const [imported, setImported] = useState(0);
  const dateRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // It takes the menu's place: kept on screen as the menu was (usePopover places a panel on open and on resize).
    window.dispatchEvent(new Event('resize'));
    dateRef.current?.focus();
  }, []);
  useEffect(() => onCsvDatasetsChanged(() => setImported((n) => n + 1)), []);
  useEffect(() => {
    let alive = true;
    provider
      .availableRange(symbol)
      .then((r) => alive && setRange(r ? { from: exchangeDate(r.from), to: exchangeDate(r.to) } : null))
      .catch(() => undefined);
    provider
      .sessionDates?.(symbol)
      .then((d) => alive && setDays(d))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [provider, symbol, imported]);

  const problem = useMemo(() => {
    const unavailable = provider.unavailableReason();
    if (unavailable) return unavailable;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Choose a date.';
    if (!isTradingDay(date)) return `${date} is not a trading day (weekend or NYSE holiday).`;
    if (range && (date < range.from || date > range.to)) return `Data for ${symbol} covers ${range.from} to ${range.to}.`;
    if (days && !days.includes(date)) return `There is no ${symbol} data on ${date}: the imported data has gaps. Pick another day, or Random bar.`;
    if (!/^\d{1,2}:\d{2}$/.test(time)) return 'Enter the time as HH:MM.';
    return null;
  }, [provider, symbol, date, time, range, days]);

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) onStart(date, time);
      }}
    >
      <strong>
        Replay {symbol} from a date <span className="muted small">· {provider.name}</span>
      </strong>
      <div className="row wrap" style={{ alignItems: 'flex-end' }}>
        <label className="field">
          Date
          <input ref={dateRef} type="date" value={date} min={range?.from ?? DEMO_FIRST_DATE} max={range?.to} onChange={(e) => setDate(e.target.value)} style={{ width: 140 }} />
        </label>
        <label className="field">
          Time (ET)
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      {problem && <div className="alert warn">{problem}</div>}
      <div className="row">
        <button type="button" className="btn sm ghost" onClick={onBack}>
          Back
        </button>
        <div className="spacer" />
        <button type="submit" className="btn sm primary" disabled={!!problem}>
          Start replay
        </button>
      </div>
    </form>
  );
}
