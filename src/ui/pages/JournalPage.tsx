/** Trade journal: every closed trade, filterable, with notes, snapshots and reviews. */
import { useEffect, useMemo, useState } from 'react';
import { useJournal } from '../state/journalStore';
import { EmptyState, SourceBadge } from '../components/common';
import { JournalEntryDetail } from '../components/JournalEntryDetail';
import { dateTime, pnlClass, signedMoney } from '../services/format';
import type { JournalEntry } from '../../core/journal';

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toCsv(entries: JournalEntry[]): string {
  const cols = ['symbol', 'direction', 'source', 'mode', 'entryTime', 'exitTime', 'quantity', 'avgEntry', 'avgExit', 'stopLoss', 'takeProfit', 'pnl', 'returnPct', 'rMultiple', 'holdingSeconds', 'commission', 'tag', 'rewound', 'why', 'setup', 'good', 'bad', 'change', 'other'];
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = entries.map((e) =>
    [
      e.symbol,
      e.direction,
      e.source,
      e.mode,
      new Date(e.entryTime * 1000).toISOString(),
      new Date(e.exitTime * 1000).toISOString(),
      e.quantity,
      e.avgEntry,
      e.avgExit,
      e.stopLoss,
      e.takeProfit,
      e.pnl.toFixed(2),
      e.returnPct.toFixed(3),
      e.review?.rMultiple?.toFixed(2),
      e.holdingSeconds,
      e.commission.toFixed(2),
      e.tag,
      e.rewound,
      e.notes.why,
      e.notes.setup,
      e.notes.good,
      e.notes.bad,
      e.notes.change,
      e.notes.other,
    ]
      .map(esc)
      .join(','),
  );
  return [cols.join(','), ...rows].join('\n');
}

export function JournalPage({ focusId }: { focusId: string | null }) {
  const { entries, loaded, error, remove } = useJournal();
  const [selected, setSelected] = useState<string | null>(focusId);
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<'all' | 'win' | 'loss'>('all');
  const [noteless, setNoteless] = useState(false);

  useEffect(() => {
    if (focusId) setSelected(focusId);
  }, [focusId]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (!q || e.symbol.toLowerCase().includes(q) || e.tag.toLowerCase().includes(q) || Object.values(e.notes).some((n) => n.toLowerCase().includes(q))) &&
        (outcome === 'all' || (outcome === 'win' ? e.pnl > 0 : e.pnl <= 0)) &&
        (!noteless || Object.values(e.notes).every((n) => !n.trim())),
    );
  }, [entries, query, outcome, noteless]);

  const current = entries.find((e) => e.id === selected) ?? list[0];
  // Pin the entry shown by default. Otherwise saving its notes can drop it from a "Needs notes" or
  // notes-search list, the next entry would slide into the editor, and typing would continue there.
  useEffect(() => {
    if (current && current.id !== selected) setSelected(current.id);
  }, [current, selected]);

  if (!loaded) return <div className="page"><div className="page-inner">Loading journal…</div></div>;

  return (
    <div className="page">
      <div className="page-inner stack" style={{ gap: 12 }}>
        <div className="row wrap">
          <h1>Journal</h1>
          <span className="muted small">{entries.length} trades. An entry is created automatically when a trade closes.</span>
          <div className="spacer" />
          <button className="btn sm" disabled={!entries.length} onClick={() => download('trade-journal.csv', toCsv(list), 'text/csv')}>
            Export CSV
          </button>
          <button className="btn sm" disabled={!entries.length} onClick={() => download('trade-journal.json', JSON.stringify(list, null, 2), 'application/json')}>
            Export JSON
          </button>
        </div>
        {error && <div className="alert error">Journal storage error: {error}. Entries may not persist in this browser.</div>}
        {!entries.length ? (
          <EmptyState title="Your journal is empty">Start a replay or the simulated market and close a trade. It will be journaled here with a chart snapshot and review.</EmptyState>
        ) : (
          <div className="two-col" style={{ gridTemplateColumns: 'minmax(280px, 380px) 1fr', alignItems: 'start' }}>
            <div className="card stack" style={{ padding: 10, gap: 8 }}>
              <input type="text" placeholder="Search symbol, tag or notes" value={query} onChange={(e) => setQuery(e.target.value)} />
              <div className="row wrap">
                <div className="seg">
                  {(['all', 'win', 'loss'] as const).map((o) => (
                    <button key={o} className={outcome === o ? 'on' : ''} onClick={() => setOutcome(o)}>
                      {o === 'all' ? 'All' : o === 'win' ? 'Wins' : 'Losses'}
                    </button>
                  ))}
                </div>
                <label className="check small">
                  <input type="checkbox" checked={noteless} onChange={(e) => setNoteless(e.target.checked)} /> Needs notes
                </label>
              </div>
              <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
                <table className="grid">
                  <tbody>
                    {list.map((e) => (
                      <tr key={e.id} className="clickable" onClick={() => setSelected(e.id)} style={current?.id === e.id ? { background: 'var(--panel-3)' } : undefined}>
                        <td>
                          <b>{e.symbol}</b> <span className={e.direction === 'long' ? 'pos' : 'neg'}>{e.direction === 'long' ? 'L' : 'S'}</span>
                          <div className="small muted">{dateTime(e.exitTime)}</div>
                        </td>
                        <td>
                          <SourceBadge source={e.source} />
                          {e.tag && <div className="small muted">{e.tag}</div>}
                        </td>
                        <td className={`num ${pnlClass(e.pnl)}`}>{signedMoney(e.pnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!list.length && <p className="muted small">No entries match.</p>}
              </div>
            </div>
            <div className="card">
              {current ? (
                <>
                  <JournalEntryDetail key={current.id} entry={current} />
                  <div className="row" style={{ marginTop: 14 }}>
                    <div className="spacer" />
                    <button
                      className="btn sm danger"
                      onClick={() => {
                        if (window.confirm('Delete this journal entry? Analytics will no longer include it.')) void remove(current.id);
                      }}
                    >
                      Delete entry
                    </button>
                  </div>
                </>
              ) : (
                <EmptyState title="Select a trade" />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
