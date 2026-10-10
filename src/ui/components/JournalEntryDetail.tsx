/**
 * One journal entry: trade facts, chart snapshot, the Learning Mode review and editable notes.
 * Used by the post-trade review popup and the Journal page.
 */
import { useEffect, useRef, useState } from 'react';
import type { JournalEntry, JournalNotes } from '../../core/journal';
import { loadSnapshot, useJournal } from '../state/journalStore';
import { SourceBadge, Stat } from './common';
import { money, pct, pnlClass, price, qty, signedMoney } from '../services/format';
import { useEntryTime } from './useEntryTime';
import { formatDuration } from '../../core/time';
import type { TradeReview } from '../../core/learning/review';
import { pctAgainst } from '../../core/risk/risk';

const NOTE_FIELDS: { key: keyof JournalNotes; label: string }[] = [
  { key: 'why', label: 'Why did I enter?' },
  { key: 'setup', label: 'What was my setup?' },
  { key: 'good', label: 'What did I do well?' },
  { key: 'bad', label: 'What did I do wrong?' },
  { key: 'change', label: 'What would I change next time?' },
  { key: 'other', label: 'Other notes' },
];

const EXIT_LABEL: Record<string, string> = { stop_loss: 'Stop loss', take_profit: 'Take profit', manual: 'Manual exit', session_end: 'Session ended', other: 'Other' };

/** The note fields that differ from what the editor last took in from the store. */
function edited(notes: JournalNotes, base: JournalNotes): Partial<JournalNotes> {
  return Object.fromEntries(NOTE_FIELDS.filter(({ key }) => notes[key] !== base[key]).map(({ key }) => [key, notes[key]]));
}

export function JournalEntryDetail({ entry, showReview = true }: { entry: JournalEntry; showReview?: boolean }) {
  const updateNotes = useJournal((s) => s.updateNotes);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [notes, setNotes] = useState<JournalNotes>(entry.notes);
  const [tag, setTag] = useState(entry.tag);
  const [saved, setSaved] = useState(true);
  /** The stored notes and tag the editor last took in. Only fields that differ from them are saved. */
  const base = useRef({ notes: entry.notes, tag: entry.tag });
  /** Unsaved edits, so closing the review (or switching entries) inside the debounce still saves them. */
  const pending = useRef<{ id: string; notes: JournalNotes; tag: string } | null>(null);
  useEffect(() => {
    pending.current = saved ? null : { id: entry.id, notes, tag };
  }, [notes, tag, saved, entry.id]);
  const flush = () => {
    const p = pending.current;
    pending.current = null;
    if (p) void useJournal.getState().updateNotes(p.id, edited(p.notes, base.current.notes), p.tag !== base.current.tag ? p.tag : undefined);
  };

  // Closing or reloading the tab, or a phone sending it to the background (where it may be killed
  // without another event), unmounts nothing and may never run the debounce timer: save now.
  useEffect(() => {
    const leave = () => {
      if (!pending.current) return;
      flush();
      setSaved(true);
    };
    const onVisibility = () => document.visibilityState === 'hidden' && leave();
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // flush reads only refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    base.current = { notes: entry.notes, tag: entry.tag };
    setNotes(entry.notes);
    setTag(entry.tag);
    setSaved(true);
    let alive = true;
    setSnapshot(null);
    if (entry.snapshotKey)
      loadSnapshot(entry.snapshotKey)
        .then((s) => alive && setSnapshot(s ?? null))
        .catch(() => undefined);
    return () => {
      alive = false;
      flush();
    };
    // Reset local edits only when switching to another entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id]);

  // Notes or a tag saved elsewhere (another tab, or this editor's own save coming back merged)
  // replace the fields not being edited here, so the next save never writes an old value back.
  useEffect(() => {
    const prev = base.current;
    if (prev.notes === entry.notes && prev.tag === entry.tag) return;
    base.current = { notes: entry.notes, tag: entry.tag };
    setNotes((local) => {
      const out = { ...local };
      for (const { key } of NOTE_FIELDS) if (local[key] === prev.notes[key]) out[key] = entry.notes[key];
      return out;
    });
    setTag((local) => (local === prev.tag ? entry.tag : local));
  }, [entry.notes, entry.tag]);

  // Debounced autosave: one write with every field edited since the last one.
  useEffect(() => {
    if (saved) return;
    const h = setTimeout(() => {
      const { notes: baseNotes, tag: baseTag } = base.current;
      void updateNotes(entry.id, edited(notes, baseNotes), tag !== baseTag ? tag : undefined);
      setSaved(true);
    }, 600);
    return () => clearTimeout(h);
  }, [notes, tag, saved, entry.id, updateNotes]);

  const r = entry.review;
  /** A stop or target that was its own order, placed after entry. */
  const placedAfter = (at: number | undefined) => (at !== undefined && at > entry.entryTime ? ` (placed ${formatDuration(at - entry.entryTime)} after entry)` : '');
  const entryTime = useEntryTime();
  const when = (t: number) => entryTime(entry, t);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row wrap">
        <b style={{ fontSize: 16 }}>
          {entry.direction === 'long' ? 'Long' : 'Short'} {entry.symbol}
        </b>
        <span className={`badge ${entry.pnl >= 0 ? 'pos' : 'neg'}`}>{entry.pnl > 0 ? 'WIN' : entry.pnl < 0 ? 'LOSS' : 'BREAKEVEN'}</span>
        <SourceBadge source={entry.source} />
        <span className="badge neutral">{entry.mode === 'sim' ? 'Simulated market' : 'Replay'}</span>
        {entry.rewound && (
          <span className="badge warn" title="The session was rewound before this trade closed, so you may have seen what happened next.">
            Rewound session
          </span>
        )}
      </div>

      <div className="stat-grid">
        <Stat k="Net P/L" v={signedMoney(entry.pnl)} cls={pnlClass(entry.pnl)} />
        <Stat k="Return on position" v={pct(entry.returnPct, 2, true)} cls={pnlClass(entry.returnPct)} />
        <Stat k="R multiple" v={r?.rMultiple != null ? `${r.rMultiple.toFixed(2)}R` : '—'} cls={pnlClass(r?.rMultiple)} />
        <Stat k="Quantity" v={qty(entry.quantity)} />
        <Stat k="Avg entry" v={price(entry.avgEntry)} />
        <Stat k="Avg exit" v={price(entry.avgExit)} />
        <Stat k="Stop loss" v={entry.stopLoss !== undefined ? `${price(entry.stopLoss)}${placedAfter(entry.trip.stopPlacedAt)}` : 'none'} cls={entry.stopLoss === undefined ? 'warn' : ''} />
        <Stat k="Take profit" v={entry.takeProfit !== undefined ? `${price(entry.takeProfit)}${placedAfter(entry.trip.targetPlacedAt)}` : 'none'} />
        <Stat k="Entry" v={when(entry.entryTime)} />
        <Stat k="Exit" v={when(entry.exitTime)} />
        <Stat k="Held" v={formatDuration(entry.holdingSeconds)} />
        <Stat k="Commission" v={money(entry.commission)} />
      </div>

      {snapshot && <img className="snapshot-img" src={snapshot} alt={`Chart when the ${entry.symbol} trade closed`} />}

      {showReview && r && <ReviewView review={r} hasStop={entry.stopLoss !== undefined} />}

      <div>
        <div className="section-title">
          <h3>Notes</h3>
          <div className="spacer" />
          <span className="small muted">{saved ? 'Saved' : 'Saving…'}</span>
        </div>
        <label className="field" style={{ maxWidth: 260, marginBottom: 10 }}>
          <span>Tag</span>
          <input
            type="text"
            value={tag}
            placeholder="e.g. ORB, pullback, VWAP reclaim"
            onChange={(e) => {
              setTag(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))' }}>
          {NOTE_FIELDS.map((f) => (
            <label key={f.key} className="field">
              <span>{f.label}</span>
              <textarea
                rows={3}
                value={notes[f.key]}
                onChange={(e) => {
                  setNotes({ ...notes, [f.key]: e.target.value });
                  setSaved(false);
                }}
              />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReviewView({ review: r, hasStop }: { review: TradeReview; hasStop: boolean }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="section-title">
        <h3>Trade review</h3>
        <span className="small muted">Explains what happened. It does not tell you what to trade next.</span>
      </div>
      <div className="stat-grid">
        <Stat k="Exit reason" v={EXIT_LABEL[r.exitReason] ?? r.exitReason} />
        <Stat k="Max favorable (MFE)" v={`${signedMoney(r.mfe.dollars)}${r.mfe.r !== null ? ` · ${r.mfe.r.toFixed(2)}R` : ''}`} cls="pos" />
        <Stat k="Max adverse (MAE)" v={`${signedMoney(-Math.abs(r.mae.dollars))}${r.mae.r !== null ? ` · ${r.mae.r.toFixed(2)}R` : ''}`} cls="neg" />
        <Stat k="Kept of best open profit" v={r.capturePct !== null ? `${r.capturePct.toFixed(0)}%` : '—'} />
        <Stat
          k="Risk taken"
          v={r.riskDollars === null ? (hasStop ? 'Not measurable' : 'No stop') : r.addedPastStop ? `More than planned (${money(r.riskDollars)} planned)` : `${money(r.riskDollars)}${r.riskPctOfEquity === null ? '' : ` · ${pctAgainst(r.riskPctOfEquity, r.riskLimitPct)}%`}`}
          cls={r.riskDollars === null || r.addedPastStop ? 'warn' : ''}
        />
        {(r.largestRiskDollars !== undefined || r.unprotected) && (
          <Stat
            k="Largest risk"
            v={r.unprotected ? 'Not limited: shares had no stop' : `${money(r.largestRiskDollars!)}${r.largestRiskPct != null ? ` · ${pctAgainst(r.largestRiskPct, r.riskLimitPct)}%` : ''}`}
            cls="warn"
          />
        )}
        <Stat k="Planned R:R" v={r.plannedRR !== null ? `${r.plannedRR.toFixed(2)}:1` : '—'} />
        <Stat k="Stop distance" v={r.stopDistanceAtr !== null ? `${r.stopDistanceAtr.toFixed(2)} ATR` : '—'} />
        <Stat k="ATR at entry" v={r.atrAtEntry !== null ? price(r.atrAtEntry) : '—'} />
      </div>
      <div className="stack" style={{ gap: 6 }}>
        {r.findings.map((f, i) => (
          <div key={i} className={`finding ${f.tone}`}>
            <div className="t">{f.title}</div>
            <div className="small">{f.detail}</div>
          </div>
        ))}
      </div>
      {r.rules.length > 0 && (
        <div>
          <h4 style={{ marginBottom: 6 }}>Your rules</h4>
          {r.rules.map((c, i) => (
            <div key={i} className="rule-row">
              <span className={c.passed === null ? 'muted' : c.passed ? 'success' : 'error'}>{c.passed === null ? '–' : c.passed ? '✓' : '✗'}</span>
              <b className="small">{c.rule}</b>
              <span className="small muted">{c.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
