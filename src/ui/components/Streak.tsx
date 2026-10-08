/** Daily practice streak: top-bar chip, full panel, and milestone celebration. */
import { useMemo } from 'react';
import {
  FREEZE_EVERY,
  GOAL_OPTIONS,
  MAX_FREEZES,
  MILESTONES,
  calendarWeeks,
  minutesText,
  streakMessage,
  streakStatus,
  type CalendarCell,
  type StreakStatus,
} from '../../core/streak/streak';
import { dismissCelebration, openStreakPanel, setStreakGoal, useStreak } from '../state/streakStore';
import { useTrading } from '../state/tradingStore';
import { Modal } from './common';
import type { View } from './TopBar';

const FREEZE_RULE = `Every ${FREEZE_EVERY}th day you meet your goal within a running streak earns a streak freeze (you can hold ${MAX_FREEZES}). Freezes cover missed days automatically, but only when you have enough for the whole gap.`;

export function FlameIcon({ size = 16, lit = true }: { size?: number; lit?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={`flame${lit ? ' lit' : ''}`}>
      <path
        d="M12 2.5c.6 3.1-.9 5-2.5 6.7C7.9 10.9 6.5 12.6 6.5 15.2a5.5 5.5 0 0 0 11 0c0-2.4-1.1-3.9-2.2-5.2-.3 1.3-1 2.3-2 2.8.4-3.4-.2-7.2-1.3-10.3Z"
        fill={lit ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={lit ? 0 : 1.8}
        strokeLinejoin="round"
      />
      {lit && <path d="M12 21a3 3 0 0 1-3-3c0-1.6 1.2-2.6 2-3.6.2 1 .8 1.6 1.6 1.9.1-.9 0-1.8-.3-2.6 1.6 1 2.7 2.4 2.7 4.3a3 3 0 0 1-3 3Z" fill="var(--panel)" opacity="0.55" />}
    </svg>
  );
}

export function SnowflakeIcon({ size = 14, on = true }: { size?: number; on?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={`snowflake${on ? ' on' : ''}`}>
      <g stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" fill="none">
        <path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7" />
        <path d="m9.5 3.8 2.5 2 2.5-2M9.5 20.2l2.5-2 2.5 2M4.2 10.6l3.1-.6-1-3M19.8 13.4l-3.1.6 1 3M4.2 13.4l3.1.6-1 3M19.8 10.6l-3.1-.6 1-3" />
      </g>
    </svg>
  );
}

function useStatus(): StreakStatus {
  const data = useStreak((s) => s.data);
  const today = useStreak((s) => s.today);
  return useMemo(() => streakStatus(data, today), [data, today]);
}

/** Compact streak indicator for the top bar: flame + count, ring = today's goal progress. */
export function StreakChip() {
  const s = useStatus();
  const pct = Math.min(1, s.todaySeconds / s.goalSeconds);
  const state = s.todayDone ? 'done' : s.atRisk ? 'risk' : 'idle';
  const R = 13;
  const C = 2 * Math.PI * R;
  const left = Math.max(1, Math.ceil((s.goalSeconds - s.todaySeconds) / 60));
  const title = s.todayDone
    ? `${s.current}-day practice streak. Today's goal is done.`
    : s.atRisk
      ? `${s.current}-day practice streak. ${left} more min today keeps it going.`
      : `No streak yet. Practise ${left} min today to start one.`;
  return (
    <button className={`streak-chip ${state}`} onClick={() => openStreakPanel()} title={title} aria-label={title}>
      <span className="streak-ring">
        <svg className="ring" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
          <circle cx="15" cy="15" r={R} className="track" />
          <circle cx="15" cy="15" r={R} className="fill" strokeDasharray={`${pct * C} ${C}`} transform="rotate(-90 15 15)" />
        </svg>
        <FlameIcon size={15} lit={s.todayDone || s.current > 0} />
      </span>
      <span className="streak-count num">{s.current}</span>
    </button>
  );
}

function fmtCell(c: CalendarCell): string {
  const [y, m, d] = c.key.split('-').map(Number);
  const label = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const what = c.state === 'done' ? 'goal met' : c.state === 'frozen' ? 'covered by a streak freeze' : c.state === 'partial' ? 'some practice' : 'no practice';
  return `${label}: ${c.seconds >= 60 ? `${minutesText(c.seconds)}, ` : ''}${what}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function heatmapSummary(weeks: CalendarCell[][]): string {
  const cells = weeks.flat().filter((c) => c.state !== 'future');
  const n = (s: CalendarCell['state']) => cells.filter((c) => c.state === s).length;
  const days = (k: number) => `${k} day${k === 1 ? '' : 's'}`;
  return `Practice calendar, last ${weeks.length} weeks: ${days(n('done'))} goal met, ${days(n('frozen'))} covered by a freeze, ${days(n('partial'))} with some practice.`;
}

function Heatmap({ weeks }: { weeks: CalendarCell[][] }) {
  return (
    <div className="heatmap-wrap">
      <div className="heatmap" role="img" aria-label={heatmapSummary(weeks)}>
        <div className="heatmap-days" aria-hidden="true">
          <span />
          <span />
          <span>Mon</span>
          <span />
          <span>Wed</span>
          <span />
          <span>Fri</span>
          <span />
        </div>
        {weeks.map((col, i) => {
          const first = col[0].key;
          const prev = i > 0 ? weeks[i - 1][0].key : null;
          const month = Number(first.slice(5, 7));
          const showMonth = !prev || Number(prev.slice(5, 7)) !== month;
          return (
            <div key={first} className="heatmap-col">
              <span className="heatmap-month" aria-hidden="true">
                {showMonth ? MONTHS[month - 1] : ''}
              </span>
              {col.map((c) => (
                <span key={c.key} className={`cell ${c.state}`} title={c.state === 'future' ? undefined : fmtCell(c)} />
              ))}
            </div>
          );
        })}
      </div>
      <div className="heatmap-legend small muted">
        <span className="cell done" /> goal met <span className="cell frozen" /> freeze <span className="cell partial" /> some practice <span className="cell none" /> none
      </div>
    </div>
  );
}

export function StreakPanel() {
  const s = useStatus();
  const data = useStreak((st) => st.data);
  const today = useStreak((st) => st.today);
  const weeks = useMemo(() => calendarWeeks(data, today, 17), [data, today]);
  const msg = streakMessage(s);
  const pct = Math.min(1, s.todaySeconds / s.goalSeconds);
  const lit = s.todayDone || s.current > 0;
  const next = s.nextMilestone;
  const prevMilestone = Math.max(0, ...MILESTONES.filter((m) => m <= s.current));
  return (
    <div className="streak-panel stack">
      <div className="streak-hero">
        <span className={`streak-big-flame${lit ? ' lit' : ''}${s.todayDone ? ' done' : ''}`}>
          <FlameIcon size={46} lit={lit} />
        </span>
        <div>
          <div className="streak-big num">{s.current}</div>
          <div className="muted small">day streak</div>
        </div>
        <div className="spacer" />
        <div className="streak-side">
          <div>
            <span className="muted small">Best </span>
            <b className="num">{s.best}</b>
          </div>
          <div className="row" style={{ gap: 4 }} title={FREEZE_RULE}>
            <span className="muted small">Freezes</span>
            {Array.from({ length: MAX_FREEZES }, (_, i) => (
              <SnowflakeIcon key={i} on={i < s.freezes} />
            ))}
            <span className="sr-only">
              {s.freezes} of {MAX_FREEZES} banked
            </span>
          </div>
        </div>
      </div>

      <div>
        <div className="streak-title">{msg.title}</div>
        <div className="muted">{msg.body}</div>
      </div>

      <div className="stack" style={{ gap: 4 }}>
        <div className="row small">
          <span>Today</span>
          <div className="spacer" />
          <span className="num">
            {minutesText(s.todaySeconds)} of {Math.round(s.goalSeconds / 60)} min{s.todayDone ? ' · done' : ''}
          </span>
        </div>
        <div className={`streak-bar${s.todayDone ? ' done' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} aria-label="Today's practice goal">
          <div style={{ width: `${pct * 100}%` }} />
        </div>
        {s.todayReviews > 0 && (
          <div className="small muted">
            {s.todayReviews} trade{s.todayReviews === 1 ? '' : 's'} reviewed in the journal today
          </div>
        )}
      </div>

      {next && (
        <div className="stack" style={{ gap: 4 }}>
          <div className="row small">
            <span>Next milestone: {next} days</span>
            <div className="spacer" />
            <span className="muted">{next - s.current} to go</span>
          </div>
          <div className="streak-bar milestone">
            <div style={{ width: `${((s.current - prevMilestone) / (next - prevMilestone)) * 100}%` }} />
          </div>
        </div>
      )}

      <Heatmap weeks={weeks} />

      <div className="row wrap" style={{ gap: 8 }}>
        <span className="small">Daily goal</span>
        <div className="seg" role="group" aria-label="Daily practice goal in minutes">
          {GOAL_OPTIONS.map((m) => (
            <button key={m} aria-pressed={data.goalMinutes === m} className={data.goalMinutes === m ? 'on' : ''} onClick={() => setStreakGoal(m)}>
              {m}
            </button>
          ))}
        </div>
        <span className="small muted">minutes</span>
      </div>

      <details className="streak-help small muted">
        <summary>How the streak counts</summary>
        <p>
          Practice time counts while this tab is in front and you are active, on every screen except Data &amp; Settings. A playing replay keeps counting for up to 10 minutes after your last
          click or key press, because watching tape is practice too. Reach your daily goal to extend the streak. Days follow your computer&apos;s calendar, weekends included.
        </p>
        <p>{FREEZE_RULE} Lowering or raising the goal never changes days you already completed.</p>
        <p>The streak rewards practice time, never profit or the number of trades, so there is no reason to force a trade to keep it alive.</p>
      </details>
    </div>
  );
}

export function StreakModal() {
  const open = useStreak((s) => s.panelOpen);
  if (!open) return null;
  return (
    <Modal title="Daily practice" onClose={() => openStreakPanel(false)}>
      <StreakPanel />
    </Modal>
  );
}

/** Milestone celebration. It waits while a replay is playing on the trade screen, so it never covers live orders. */
export function StreakCelebration({ view }: { view: View }) {
  const c = useStreak((s) => s.celebrate);
  const playing = useTrading((s) => s.playing);
  if (!c || (view === 'trade' && playing)) return null;
  return (
    <Modal
      title="Milestone reached"
      onClose={dismissCelebration}
      footer={
        <button className="btn primary" onClick={dismissCelebration} data-autofocus>
          Keep going
        </button>
      }
    >
      <div className="celebrate">
        <span className="streak-big-flame lit done celebrate-flame">
          <FlameIcon size={72} />
        </span>
        <div className="streak-big num">{c.streak}</div>
        <div className="streak-title">day streak</div>
        <p className="muted">{c.line}</p>
      </div>
    </Modal>
  );
}
