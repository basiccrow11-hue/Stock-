/** Performance analytics over journaled trades, with filters and breakdowns. */
import { useMemo, useState } from 'react';
import { useJournal } from '../state/journalStore';
import { useTrading } from '../state/tradingStore';
import { useSettings } from '../state/settingsStore';
import { computeStats, rMultiple, type PerformanceStats } from '../../core/analytics/stats';
import type { EquityPoint, RoundTrip } from '../../core/types';
import type { JournalEntry } from '../../core/journal';
import { EmptyState, Stat } from '../components/common';
import { useDateHidden } from '../components/useEntryTime';
import { LineChart, type LineSpec } from '../chart/LineChart';
import { useTheme } from '../theme/useTheme';
import { money, pnlClass, signedMoney } from '../services/format';
import { exchangeDate, exchangeMinuteOfDay, formatDuration, weekdayOf } from '../../core/time';

type SourceFilter = 'all' | 'DEMO' | 'HISTORICAL' | 'SIMULATED';

export function StatsGrid({ s }: { s: PerformanceStats }) {
  const r = (v: number | null, suffix = 'R') => (v === null ? '—' : `${v.toFixed(2)}${suffix}`);
  return (
    <div className="stat-grid">
      <Stat k="Net P/L" v={signedMoney(s.netPnl)} cls={pnlClass(s.netPnl)} />
      <Stat k="Total return" v={`${s.totalReturnPct.toFixed(2)}%`} cls={pnlClass(s.totalReturnPct)} />
      <Stat k="Trades" v={`${s.totalTrades} (${s.longTrades}L / ${s.shortTrades}S)`} />
      <Stat k="Win rate" v={s.totalTrades ? `${s.winRate.toFixed(1)}%` : '—'} />
      <Stat k="Profit factor" v={s.profitFactor === null ? (s.grossProfit > 0 ? '∞ (no losses)' : '—') : s.profitFactor.toFixed(2)} />
      <Stat k="Expectancy / trade" v={signedMoney(s.expectancy)} cls={pnlClass(s.expectancy)} />
      <Stat k="Average R" v={r(s.averageR)} cls={pnlClass(s.averageR)} />
      <Stat k="Avg planned R:R" v={r(s.averagePlannedRR, ':1')} />
      <Stat k="Average win" v={money(s.averageWin)} cls="pos" />
      <Stat k="Average loss" v={money(s.averageLoss)} cls="neg" />
      <Stat k="Payoff ratio" v={s.payoffRatio === null ? '—' : s.payoffRatio.toFixed(2)} />
      <Stat k="Largest win" v={money(s.largestWin)} cls="pos" />
      <Stat k="Largest loss" v={money(s.largestLoss)} cls="neg" />
      <Stat k="Max drawdown" v={`${money(s.maxDrawdown)} · ${s.maxDrawdownPct.toFixed(2)}%`} cls={s.maxDrawdown > 0 ? 'neg' : ''} />
      <Stat k="Max losing streak" v={String(s.maxConsecutiveLosses)} />
      <Stat k="Avg holding time" v={s.totalTrades ? formatDuration(s.averageHoldingSeconds) : '—'} />
      <Stat k="Gross profit" v={money(s.grossProfit)} />
      <Stat k="Gross loss" v={money(s.grossLoss)} />
      <Stat k="Commissions" v={money(s.commissions)} />
    </div>
  );
}

/** The cumulative curve uses one synthetic minute per trade; label the axis by trade number. */
const CURVE_BASE = 1_000_000_000;
const tradeLabel = (t: number) => `#${Math.round((t - CURVE_BASE) / 60)}`;

function curveFromTrips(trips: RoundTrip[], base: number): EquityPoint[] {
  const closed = trips.filter((t) => t.closed).sort((a, b) => a.exitTime! - b.exitTime!);
  const out: EquityPoint[] = [];
  let eq = base;
  // Trades from different sessions overlap in real time, so the curve is plotted in trade order.
  if (closed.length) out.push({ time: CURVE_BASE, equity: base });
  closed.forEach((t, i) => {
    eq += t.pnl;
    out.push({ time: CURVE_BASE + (i + 1) * 60, equity: eq });
  });
  return out;
}

interface Group {
  key: string;
  n: number;
  pnl: number;
  wins: number;
  avgR: number | null;
}

function groupBy(entries: JournalEntry[], keyOf: (e: JournalEntry) => string): Group[] {
  const m = new Map<string, JournalEntry[]>();
  for (const e of entries) {
    const k = keyOf(e);
    m.set(k, [...(m.get(k) ?? []), e]);
  }
  return [...m.entries()]
    .map(([key, es]) => {
      const rs = es.map((e) => rMultiple(e.trip)).filter((x): x is number => x !== null);
      return { key, n: es.length, pnl: es.reduce((a, e) => a + e.pnl, 0), wins: es.filter((e) => e.pnl > 0).length, avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null };
    })
    .sort((a, b) => b.n - a.n);
}

function Breakdown({ title, groups }: { title: string; groups: Group[] }) {
  return (
    <div className="card">
      <h3 style={{ marginBottom: 8 }}>{title}</h3>
      <table className="grid">
        <thead>
          <tr>
            <th />
            <th className="num">Trades</th>
            <th className="num">Win %</th>
            <th className="num">Avg R</th>
            <th className="num">Net P/L</th>
          </tr>
        </thead>
        <tbody>
          {groups.slice(0, 12).map((g) => (
            <tr key={g.key}>
              <td>{g.key}</td>
              <td className="num">{g.n}</td>
              <td className="num">{((g.wins / g.n) * 100).toFixed(0)}%</td>
              <td className={`num ${pnlClass(g.avgR)}`}>{g.avgR === null ? '—' : g.avgR.toFixed(2)}</td>
              <td className={`num ${pnlClass(g.pnl)}`}>{signedMoney(g.pnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RHistogram({ entries }: { entries: JournalEntry[] }) {
  const rs = entries.map((e) => rMultiple(e.trip)).filter((x): x is number => x !== null);
  if (!rs.length) return <p className="muted small">No trades with a stop loss yet, so R multiples are unknown.</p>;
  const buckets = [-3, -2, -1, 0, 1, 2, 3, 4];
  const labels = ['≤ −2R', '−2…−1R', '−1…0R', '0…1R', '1…2R', '2…3R', '3…4R', '≥ 4R'];
  const counts = new Array(buckets.length).fill(0);
  for (const r of rs) {
    let i = buckets.findIndex((b) => r < b);
    if (i === -1) i = buckets.length - 1;
    else i = Math.max(0, i - 1);
    counts[i]++;
  }
  const max = Math.max(...counts);
  return (
    <div className="row" style={{ alignItems: 'flex-end', gap: 6, height: 140 }}>
      {counts.map((c, i) => (
        <div key={i} style={{ flex: 1, textAlign: 'center' }} className="small">
          <div style={{ height: max ? (c / max) * 100 : 0, background: i < 3 ? 'var(--neg)' : 'var(--pos)', opacity: 0.75, borderRadius: 3 }} />
          <div className="mono">{c}</div>
          <div className="muted">{labels[i]}</div>
        </div>
      ))}
    </div>
  );
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function AnalyticsPage() {
  const entries = useJournal((s) => s.entries);
  const base = useSettings((s) => s.defaultBalance);
  // Adjusted to 3:1 on the panel, like every other chart line on app panels.
  const accent = useTheme().panel.accent;
  const session = useTrading((s) => s.session);
  const dateHidden = useDateHidden();
  const sessionCurve = useTrading((s) => s.equityCurve);
  const sessionTrips = useTrading((s) => s.trips);
  const account = useTrading((s) => s.account);
  const [source, setSource] = useState<SourceFilter>('all');
  const [mode, setMode] = useState<'all' | 'replay' | 'sim'>('all');
  const [excludeRewound, setExcludeRewound] = useState(true);
  const [tag, setTag] = useState('');

  const filtered = useMemo(
    () => entries.filter((e) => (source === 'all' || e.source === source) && (mode === 'all' || e.mode === mode) && (!excludeRewound || !e.rewound) && (!tag || e.tag === tag)),
    [entries, source, mode, excludeRewound, tag],
  );
  const tags = useMemo(() => [...new Set(entries.map((e) => e.tag).filter(Boolean))].sort(), [entries]);
  const trips = useMemo(() => filtered.map((e) => e.trip), [filtered]);
  const curve = useMemo(() => curveFromTrips(trips, base), [trips, base]);
  const stats = useMemo(() => computeStats(trips, curve, base), [trips, curve, base]);
  const lines = useMemo<LineSpec[]>(() => [{ name: 'Equity', color: accent, area: true, points: curve.map((p) => ({ time: p.time, value: p.equity })) }], [curve, accent]);

  const sessionStats = useMemo(() => (account ? computeStats(sessionTrips, sessionCurve, account.startingBalance) : null), [sessionTrips, sessionCurve, account]);
  const sessionLines = useMemo<LineSpec[]>(() => [{ name: 'Equity', color: accent, area: true, points: sessionCurve.map((p) => ({ time: p.time, value: p.equity })) }], [sessionCurve, accent]);

  return (
    <div className="page">
      <div className="page-inner stack" style={{ gap: 16 }}>
        <div className="row wrap">
          <h1>Analytics</h1>
          <div className="spacer" />
          <select aria-label="Data source" value={source} onChange={(e) => setSource(e.target.value as SourceFilter)}>
            <option value="all">All data sources</option>
            <option value="HISTORICAL">Historical (real) only</option>
            <option value="DEMO">Demo (synthetic) only</option>
            <option value="SIMULATED">Simulated market only</option>
          </select>
          <select aria-label="Session type" value={mode} onChange={(e) => setMode(e.target.value as 'all' | 'replay' | 'sim')}>
            <option value="all">Replay and sim</option>
            <option value="replay">Replay only</option>
            <option value="sim">Simulated market only</option>
          </select>
          <select aria-label="Setup tag" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">All tags</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <label className="check">
            <input type="checkbox" checked={excludeRewound} onChange={(e) => setExcludeRewound(e.target.checked)} /> Exclude rewound sessions
          </label>
        </div>

        {session && sessionStats && (
          <div className="card stack">
            <div className="section-title">
              <h2>Current session</h2>
              <span className="muted small">{session.label}</span>
            </div>
            {sessionCurve.length > 1 ? <LineChart lines={sessionLines} height={220} format={money} hideDates={session.blind} /> : <p className="muted small">The equity curve appears once the session has run for a while.</p>}
            <StatsGrid s={sessionStats} />
          </div>
        )}

        <div className="card stack">
          <div className="section-title">
            <h2>All journaled trades</h2>
            <span className="muted small">
              {filtered.length} of {entries.length} trades. Curve is cumulative net P/L on a {money(base)} base, one step per trade in exit order.
            </span>
          </div>
          {!filtered.length ? (
            <EmptyState title="No trades match">Closed trades from replays and the simulated market show up here automatically.</EmptyState>
          ) : (
            <>
              <LineChart lines={lines} height={240} format={money} xLabel={tradeLabel} />
              <StatsGrid s={stats} />
            </>
          )}
        </div>

        {filtered.length > 0 && (
          <>
            <div className="card">
              <h3 style={{ marginBottom: 8 }}>R-multiple distribution</h3>
              <RHistogram entries={filtered} />
            </div>
            <div className="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
              <Breakdown title="By symbol" groups={groupBy(filtered, (e) => e.symbol)} />
              <Breakdown title="By setup tag" groups={groupBy(filtered, (e) => e.tag || '(untagged)')} />
              <Breakdown title="By direction" groups={groupBy(filtered, (e) => (e.direction === 'long' ? 'Long' : 'Short'))} />
              <Breakdown
                title="By entry time (ET)"
                groups={groupBy(filtered, (e) => {
                  const h = Math.floor(exchangeMinuteOfDay(e.entryTime) / 60);
                  return `${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00`;
                }).sort((a, b) => a.key.localeCompare(b.key))}
              />
              <Breakdown title="By weekday" groups={groupBy(filtered, (e) => (dateHidden(e) ? 'Blind session (hidden)' : WEEKDAYS[weekdayOf(exchangeDate(e.entryTime))]))} />
              <Breakdown title="By exit reason" groups={groupBy(filtered, (e) => ({ stop_loss: 'Stop loss', take_profit: 'Take profit', manual: 'Manual', other: 'Other' })[e.review?.exitReason ?? 'other'])} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
