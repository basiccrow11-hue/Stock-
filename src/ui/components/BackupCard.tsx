/** Data & Settings: back up what the app keeps in this browser to a file, and restore it. */
import { useEffect, useState } from 'react';
import { backupFileName, createBackup, hasSavedSettings, parseBackup, restoreBackup, type BackupContents, type RestoreResult } from '../services/backup';
import { download } from '../services/download';
import { useDateHidden } from './useEntryTime';
import { toast } from '../state/toasts';
import { csvProvider, onCsvDatasetsChanged } from '../state/dataRegistry';

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function describe(c: BackupContents): string {
  const b = c.backup;
  const parts = [plural(b.journal.length, 'trade')];
  const shots = Object.keys(b.snapshots).length;
  if (shots) parts[0] += ` (${plural(shots, 'chart snapshot')})`;
  if (b.challenges.length) parts.push(plural(b.challenges.length, 'challenge attempt'));
  const days = Object.values(b.streak.days).filter((d) => d.done).length;
  if (days) parts.push(plural(days, 'practice day'));
  const drawn = Object.keys(b.drawings).length;
  if (drawn) parts.push(`drawings on ${plural(drawn, 'symbol')}`);
  if (b.datasets?.length) parts.push(`imported data for ${b.datasets.map((d) => d.symbol.toUpperCase()).join(', ')}`);
  if (b.settings) parts.push('settings and appearance');
  const when = b.createdAt ? `A backup from ${new Date(b.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}` : 'A journal export';
  const skipped = c.skipped ? ` ${plural(c.skipped, 'item')} in it could not be read and will be skipped.` : '';
  return `${when}: ${parts.join(', ')}.${skipped}`;
}

function summary(r: RestoreResult): string {
  const parts: string[] = [];
  parts.push(`${plural(r.journalAdded, 'trade')} added to your journal${r.journalKept ? ` (${r.journalKept} already there, kept as they were)` : ''}`);
  if (r.challengesAdded) parts.push(plural(r.challengesAdded, 'challenge attempt'));
  if (r.streakDays) parts.push(`${plural(r.streakDays, 'practice day')} merged into your streak`);
  if (r.drawingsAdded) parts.push(plural(r.drawingsAdded, 'drawing'));
  if (r.datasetsAdded.length) parts.push(`imported data for ${r.datasetsAdded.join(', ')}`);
  if (r.datasetsKept.length) parts.push(`your own data for ${r.datasetsKept.join(', ')} kept instead of the backup's`);
  if (r.settings) parts.push('settings and appearance replaced');
  return `Restored: ${parts.join('; ')}.`;
}

export function BackupCard() {
  const holdBack = useDateHidden();
  const [snapshots, setSnapshots] = useState(true);
  const [withData, setWithData] = useState(false);
  const [imported, setImported] = useState(() => csvProvider.list().length);
  useEffect(() => onCsvDatasetsChanged(() => setImported(csvProvider.list().length)), []);
  const [busy, setBusy] = useState<'backup' | 'restore' | null>(null);
  const [chosen, setChosen] = useState<{ name: string; contents: BackupContents } | null>(null);
  const [withSettings, setWithSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [fileBox, setFileBox] = useState(0);

  const backUp = async () => {
    if (busy) return;
    setBusy('backup');
    try {
      const { backup, heldBack } = await createBackup({ snapshots, datasets: withData && imported > 0, holdBack });
      download(backupFileName(backup), JSON.stringify(backup), 'application/json');
      const held = heldBack ? ` ${plural(heldBack, 'trade')} ${heldBack === 1 ? 'is' : 'are'} left out until ${heldBack === 1 ? 'its' : 'their'} blind session ends.` : '';
      toast('success', `Backup saved with ${plural(backup.journal.length, 'trade')}.${held}`);
    } catch (e) {
      toast('error', `The backup could not be made: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const onFile = async (f: File | undefined) => {
    setDone(null);
    setError(null);
    setChosen(null);
    if (!f) return;
    try {
      setChosen({ name: f.name, contents: parseBackup(await f.text()) });
      // A browser with no settings of its own (a fresh one) usually wants everything back.
      setWithSettings(!hasSavedSettings());
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const restore = async () => {
    if (!chosen || busy) return;
    setBusy('restore');
    setError(null);
    try {
      setDone(summary(await restoreBackup(chosen.contents.backup, { settings: withSettings })));
      setChosen(null);
      setFileBox((n) => n + 1);
    } catch (e) {
      setError(`Restoring stopped partway: ${(e as Error).message}. What was restored before that is kept, and restoring the same file again adds the rest.`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card stack">
      <h2>Back up and restore</h2>
      <p className="muted small">
        Your journal, challenge history, streak, settings and drawings live only in this browser: clearing its site data deletes them. A backup file keeps a copy you can restore here or in another
        browser. API keys are never included. Restoring adds what you don't have and keeps what you do: nothing here is deleted. Your settings and appearance are replaced only if
        the box for that is ticked, which it is at first only when this browser has no settings of its own yet.
      </p>
      <div className="row wrap" style={{ gap: 16 }}>
        <label className="check">
          <input type="checkbox" checked={snapshots} onChange={(e) => setSnapshots(e.target.checked)} /> Include chart snapshots
        </label>
        <label className="check">
          <input type="checkbox" checked={withData && imported > 0} disabled={imported === 0} onChange={(e) => setWithData(e.target.checked)} /> Include imported price data
          {imported === 0 ? ' (none imported)' : ` (${plural(imported, 'ticker')}; can make the file large)`}
        </label>
        <div className="spacer" />
        <button className="btn primary" aria-disabled={busy !== null} onClick={() => void backUp()}>
          {busy === 'backup' ? 'Saving…' : 'Download backup'}
        </button>
      </div>
      <div className="form-grid">
        <label className="field" style={{ gridColumn: 'span 2' }}>
          <span>Restore from a backup file</span>
          <input
            key={fileBox}
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              void onFile(f);
            }}
          />
        </label>
      </div>
      {chosen && (
        <div className="stack" style={{ gap: 8 }}>
          <p className="small">{describe(chosen.contents)}</p>
          {chosen.contents.backup.settings && (
            <label className="check">
              <input type="checkbox" checked={withSettings} onChange={(e) => setWithSettings(e.target.checked)} /> Also replace my settings and appearance with the backup's
            </label>
          )}
          <div className="row">
            <button className="btn primary" aria-disabled={busy !== null} onClick={() => void restore()}>
              {busy === 'restore' ? 'Restoring…' : 'Restore'}
            </button>
          </div>
        </div>
      )}
      <div role="alert" className="small error">
        {error}
      </div>
      <div role="status" className="small">
        {done}
      </div>
    </div>
  );
}
