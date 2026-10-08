/** Challenge mode: pick a challenge, start a session for it, see past attempts. */
import { CHALLENGES } from '../../core/challenges/challenges';
import { useChallenges } from '../state/challengeStore';
import { EmptyState } from '../components/common';
import { money } from '../services/format';
import { StreakPanel } from '../components/Streak';

export function ChallengesPage({ onStart }: { onStart: (challengeId: string, mode: 'replay' | 'sim') => void }) {
  const attempts = useChallenges((s) => s.attempts);
  const active = useChallenges((s) => s.active);
  return (
    <div className="page">
      <div className="page-inner stack" style={{ gap: 16 }}>
        <h1>Challenges</h1>
        <p className="muted">
          Structured goals that train discipline rather than luck. A result only counts as <b>official</b> if you never rewound or restarted the session, because going back means you have seen the future.
        </p>
        <div className="card">
          <StreakPanel />
        </div>
        {active && (
          <div className="alert info">
            In progress: <b>{CHALLENGES.find((c) => c.id === active.challengeId)?.title}</b>. {active.result.detail} Progress is shown on the trade screen.
          </div>
        )}
        <div className="card-grid">
          {CHALLENGES.map((c) => {
            const mine = attempts.filter((a) => a.challengeId === c.id);
            const passed = mine.filter((a) => a.result.status === 'passed' && a.result.official).length;
            return (
              <div key={c.id} className="card stack">
                <h3>{c.title}</h3>
                <p className="small muted" style={{ flex: 1 }}>
                  {c.description}
                </p>
                <div className="small">
                  Starting balance {money(c.setup.startingBalance)} · {c.setup.mode === 'sim' ? 'simulated market' : c.setup.multiDay ? 'multi-day replay' : 'one-day replay'}
                </div>
                <div className="small muted">
                  {mine.length ? `${mine.length} attempt(s), ${passed} official pass(es)` : 'Not attempted yet'}
                </div>
                <div className="row">
                  <button className="btn primary sm" onClick={() => onStart(c.id, c.setup.mode)}>
                    Start
                  </button>
                  {!c.requiresSessionEnd && c.setup.mode === 'replay' && (
                    <button className="btn sm" onClick={() => onStart(c.id, 'sim')}>
                      In simulated market
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <h2>History</h2>
        {!attempts.length ? (
          <EmptyState title="No attempts yet" />
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Started</th>
                <th>Challenge</th>
                <th>Session</th>
                <th>Result</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id}>
                  <td className="mono small">{new Date(a.startedAt).toLocaleString('en-US')}</td>
                  <td>{CHALLENGES.find((c) => c.id === a.challengeId)?.title ?? a.challengeId}</td>
                  <td className="small">{a.label}</td>
                  <td>
                    <span className={`badge ${a.result.status === 'passed' ? 'success' : a.result.status === 'failed' ? 'error' : 'neutral'}`}>{a.result.status === 'in_progress' ? 'abandoned' : a.result.status}</span>
                    {!a.result.official && <span className="badge warn" style={{ marginLeft: 4 }}>unofficial</span>}
                  </td>
                  <td className="small muted">{a.result.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
