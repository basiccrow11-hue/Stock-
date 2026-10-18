// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_NOTES, type JournalEntry } from '../../core/journal';
import type { CsvDataset } from '../../core/data/csvProvider';
import { exchangeTimeToUnix } from '../../core/time';

/**
 * IndexedDB stand-in: one Map per store, kept across module resets like a real browser's storage.
 * `failing` makes chosen writes fail, as a full disk does.
 */
const db = vi.hoisted(() => ({ stores: new Map<string, Map<string, unknown>>(), failing: null as ((store: string, key: string) => boolean) | null }));
vi.mock('./idb', () => {
  const store = (name: string) => {
    if (!db.stores.has(name)) db.stores.set(name, new Map());
    return db.stores.get(name)!;
  };
  const write = (s: string, k: string, v: unknown) => {
    if (db.failing?.(s, k)) throw new Error('The storage quota has been exceeded');
    store(s).set(k, structuredClone(v));
  };
  return {
    idb: {
      all: async (s: string) => [...store(s).values()].map((v) => structuredClone(v)),
      get: async (s: string, k: string) => structuredClone(store(s).get(k)),
      set: async (s: string, k: string, v: unknown) => write(s, k, v),
      delete: async (s: string, k: string) => void store(s).delete(k),
      modify: async (s: string, k: string, fn: (v: unknown) => unknown) => {
        const next = fn(structuredClone(store(s).get(k)));
        if (next !== undefined) write(s, k, next);
        return next;
      },
      clear: async (s: string) => void store(s).clear(),
    },
  };
});

function entry(id: string, over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id,
    sessionId: 's1',
    mode: 'replay',
    source: 'DEMO',
    symbol: 'TSLA',
    direction: 'long',
    entryTime: 1_736_951_400,
    exitTime: 1_736_952_000,
    avgEntry: 100,
    avgExit: 101,
    quantity: 10,
    pnl: 10,
    returnPct: 1,
    holdingSeconds: 600,
    commission: 0,
    tag: '',
    notes: { ...EMPTY_NOTES },
    rewound: false,
    createdAt: 1,
    trip: { id: `t-${id}`, symbol: 'TSLA', direction: 'long', entryTime: 1_736_951_400, avgEntry: 100, pnl: 10, fills: [] } as unknown as JournalEntry['trip'],
    ...over,
  };
}

const dataset: CsvDataset = {
  symbol: 'ACME',
  name: 'ACME',
  baseTimeframe: '1m',
  importedAt: 1,
  fileName: 'acme.csv',
  bars: [
    { time: 1_736_951_400, open: 1, high: 2, low: 1, close: 2, volume: 10 },
    { time: 1_736_951_460, open: 2, high: 2, low: 1, close: 1, volume: 10 },
  ],
};

/** The app's modules as a freshly opened tab sees them. */
async function app() {
  vi.resetModules();
  const backup = await import('./backup');
  const { useJournal } = await import('../state/journalStore');
  const { useChallenges } = await import('../state/challengeStore');
  const streak = await import('../state/streakStore');
  const { useSettings } = await import('../state/settingsStore');
  const drawings = await import('../chart/drawings');
  const registry = await import('../state/dataRegistry');
  await useJournal.getState().load();
  await useChallenges.getState().load();
  await registry.loadCsvDatasets();
  return { ...backup, useJournal, useChallenges, streak, useSettings, drawings, registry };
}

/** Clearing the browser's site data. */
function clearSiteData() {
  db.stores.clear();
  db.failing = null;
  localStorage.clear();
}

beforeEach(clearSiteData);
afterEach(() => vi.useRealTimers());

describe('backing up and restoring this browser’s data', () => {
  it('brings everything back after site data is cleared', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 10, 12, 0, 0));
    const a = await app();
    await a.useJournal.getState().add(entry('j1', { snapshotKey: 'snap1', notes: { ...EMPTY_NOTES, why: 'breakout' } }));
    await a.useJournal.getState().add(entry('j2'));
    db.stores.get('snapshots')?.set('snap1', 'data:image/png;base64,AAAA') ?? db.stores.set('snapshots', new Map([['snap1', 'data:image/png;base64,AAAA']]));
    a.useChallenges.getState().start({ id: 'c1', challengeId: 'risk1', sessionId: 's1', startedAt: 5, label: 'Risk 1%', result: { status: 'passed', detail: 'ok', progress: 1, official: true } as never });
    await a.useChallenges.getState().finishActive();
    a.streak.recordPractice({ activeSeconds: 20 * 60 });
    a.useSettings.getState().update({ defaultBalance: 25_000 });
    a.useSettings.getState().setChartColor('up', '#00ff00');
    a.drawings.useDrawings.getState().setSymbol('TSLA');
    a.drawings.useDrawings.getState().add({ id: 'd1', type: 'hline', points: [{ time: 1, price: 100 }], color: '#fff' });
    await a.registry.saveCsvDataset(dataset);
    // A key the user saved encrypted: never part of a backup.
    db.stores.get('kv')?.set('encrypted-credentials', { secret: 'x' }) ?? db.stores.set('kv', new Map([['encrypted-credentials', { secret: 'x' }]]));

    const { backup, heldBack } = await a.createBackup({ snapshots: true, datasets: true, holdBack: () => false });
    expect(heldBack).toBe(0);
    const text = JSON.stringify(backup);
    expect(text).not.toContain('encrypted-credentials');
    expect(a.backupFileName(backup)).toBe('stock-replay-backup-2026-10-10.json');

    clearSiteData();
    const b = await app();
    expect(b.useJournal.getState().entries).toHaveLength(0);
    const parsed = b.parseBackup(text);
    expect(parsed.skipped).toBe(0);
    const r = await b.restoreBackup(parsed.backup, { settings: true });
    expect(r).toMatchObject({ journalAdded: 2, journalKept: 0, challengesAdded: 1, drawingsAdded: 1, datasetsAdded: ['ACME'], datasetsKept: [], settings: true, streakDays: 1 });
    expect(b.useJournal.getState().entries.map((e) => e.id).sort()).toEqual(['j1', 'j2']);
    expect(b.useJournal.getState().entries.find((e) => e.id === 'j1')!.notes.why).toBe('breakout');
    expect(db.stores.get('snapshots')!.get('snap1')).toBe('data:image/png;base64,AAAA');
    expect(b.useChallenges.getState().attempts.map((x) => x.id)).toEqual(['c1']);
    expect(b.streak.useStreak.getState().data.days['2026-10-10']?.done).toBe(true);
    expect(b.useSettings.getState().defaultBalance).toBe(25_000);
    expect(b.useSettings.getState().appearance.colors.up).toBe('#00ff00');
    b.drawings.useDrawings.getState().setSymbol('TSLA');
    expect(b.drawings.useDrawings.getState().drawings.map((d) => d.id)).toEqual(['d1']);
    expect(b.registry.csvProvider.list().map((d) => d.symbol)).toEqual(['ACME']);
    // A fresh tab reads it all back from storage.
    const c = await app();
    expect(c.useJournal.getState().entries).toHaveLength(2);
    expect(c.useSettings.getState().defaultBalance).toBe(25_000);
  });

  it('adds what is missing and keeps what is here: an entry edited since, imported data, settings when asked', async () => {
    const a = await app();
    await a.useJournal.getState().add(entry('j1'));
    await a.useJournal.getState().add(entry('j2'));
    await a.registry.saveCsvDataset(dataset);
    a.useSettings.getState().update({ defaultBalance: 25_000 });
    const { backup } = await a.createBackup({ snapshots: false, datasets: true, holdBack: () => false });

    // Since the backup: j1's notes were written, j2 deleted, ACME re-imported, the balance changed.
    await a.useJournal.getState().updateNotes('j1', { why: 'written after the backup' });
    await a.useJournal.getState().remove('j2');
    await a.registry.saveCsvDataset({ ...dataset, fileName: 'newer.csv' });
    a.useSettings.getState().update({ defaultBalance: 50_000 });

    const r = await a.restoreBackup(a.parseBackup(JSON.stringify(backup)).backup, { settings: false });
    expect(r).toMatchObject({ journalAdded: 1, journalKept: 1, datasetsAdded: [], datasetsKept: ['ACME'], settings: false });
    expect(a.useJournal.getState().entries.find((e) => e.id === 'j1')!.notes.why).toBe('written after the backup');
    expect(a.useJournal.getState().entries.some((e) => e.id === 'j2')).toBe(true);
    expect(a.registry.csvProvider.list()[0].fileName).toBe('newer.csv');
    expect(a.useSettings.getState().defaultBalance).toBe(50_000);
    // Restoring the same file again adds nothing.
    expect(await a.restoreBackup(a.parseBackup(JSON.stringify(backup)).backup, { settings: false })).toMatchObject({ journalAdded: 0, journalKept: 2 });
  });

  it('finishes a restore cut off by a failed write when the same file is restored again, journal included', async () => {
    const a = await app();
    for (const id of ['j1', 'j2', 'j3']) await a.useJournal.getState().add(entry(id, { snapshotKey: `k-${id}` }));
    for (const id of ['j1', 'j2', 'j3']) db.stores.get('snapshots')?.set(`k-${id}`, 'data:image/png;base64,AA') ?? db.stores.set('snapshots', new Map([[`k-${id}`, 'data:image/png;base64,AA']]));
    const text = JSON.stringify((await a.createBackup({ snapshots: true, datasets: false, holdBack: () => false })).backup);

    clearSiteData();
    const b = await app();
    db.failing = (store, key) => store === 'snapshots' && key === 'k-j3';
    await expect(b.restoreBackup(b.parseBackup(text).backup, { settings: false })).rejects.toThrow('quota');
    // What was written shows at once; the entry whose picture could not be saved was not saved either.
    expect(b.useJournal.getState().entries.map((e) => e.id).sort()).toEqual(['j1', 'j2']);
    expect([...db.stores.get('journal')!.keys()].sort()).toEqual(['j1', 'j2']);
    db.failing = null;
    expect(await b.restoreBackup(b.parseBackup(text).backup, { settings: false })).toMatchObject({ journalAdded: 1, journalKept: 2 });
    expect(b.useJournal.getState().entries.map((e) => e.id).sort()).toEqual(['j1', 'j2', 'j3']);
    expect(db.stores.get('snapshots')!.get('k-j3')).toBe('data:image/png;base64,AA');

    // An entry stored but missing from this tab's list (left so by an earlier version) is put back in it, with its picture.
    clearSiteData();
    const c = await app();
    db.stores.set('journal', new Map([['j1', entry('j1', { snapshotKey: 'k-j1' })]]));
    expect(await c.restoreBackup(c.parseBackup(text).backup, { settings: false })).toMatchObject({ journalAdded: 3, journalKept: 0 });
    expect(c.useJournal.getState().entries.map((e) => e.id).sort()).toEqual(['j1', 'j2', 'j3']);
    expect(db.stores.get('snapshots')!.get('k-j1')).toBe('data:image/png;base64,AA');
  });

  it('never keeps restored data only in memory: a failed save is finished by restoring again, and data stored but not shown is put back', async () => {
    const a = await app();
    await a.registry.saveCsvDataset(dataset);
    const text = JSON.stringify((await a.createBackup({ snapshots: false, datasets: true, holdBack: () => false })).backup);

    clearSiteData();
    const b = await app();
    db.failing = (store) => store === 'datasets';
    await expect(b.restoreBackup(b.parseBackup(text).backup, { settings: false })).rejects.toThrow('quota');
    expect(b.registry.csvProvider.list()).toEqual([]);
    db.failing = null;
    expect(await b.restoreBackup(b.parseBackup(text).backup, { settings: false })).toMatchObject({ datasetsAdded: ['ACME'], datasetsKept: [] });
    expect((await app()).registry.csvProvider.list().map((d) => d.symbol)).toEqual(['ACME']);

    clearSiteData();
    const c = await app();
    db.stores.set('datasets', new Map([['ACME', { ...dataset, fileName: 'mine.csv' }]]));
    expect(await c.restoreBackup(c.parseBackup(text).backup, { settings: false })).toMatchObject({ datasetsAdded: ['ACME'], datasetsKept: [] });
    expect(c.registry.csvProvider.list().map((d) => d.fileName)).toEqual(['mine.csv']);
  });

  it('leaves out the trades of a blind session still running, and imported data unless asked', async () => {
    const a = await app();
    await a.useJournal.getState().add(entry('seen'));
    await a.useJournal.getState().add(entry('blind', { blind: true, sessionId: 'live' }));
    await a.registry.saveCsvDataset(dataset);
    const { backup, heldBack } = await a.createBackup({ snapshots: true, datasets: false, holdBack: (e) => e.sessionId === 'live' });
    expect(heldBack).toBe(1);
    expect(backup.journal.map((e) => e.id)).toEqual(['seen']);
    expect(backup.datasets).toBeUndefined();
  });
});

describe('daily data imported with midnight stamps', () => {
  // Jan 8-12 2024 stamped at midnight UTC, as daily files imported before bars were filed under their session were.
  const days = ['2024-01-08', '2024-01-09', '2024-01-10', '2024-01-11', '2024-01-12'];
  const raw: CsvDataset = {
    symbol: 'ACME',
    name: 'ACME',
    baseTimeframe: '1D',
    importedAt: 1,
    fileName: 'acme-daily.csv',
    bars: days.map((d, i) => ({ time: Date.parse(`${d}T00:00:00Z`) / 1000, open: 100 + i, high: 110 + i, low: 90 + i, close: 104 + i, volume: 1000 })),
  };
  const sessionOpens = days.map((d) => exchangeTimeToUnix(d, 9 * 60 + 30));
  const storedTimes = () => (db.stores.get('datasets')!.get('ACME') as CsvDataset).bars.map((b) => b.time);

  it('are filed under their session when loaded, and saved that way', async () => {
    db.stores.set('datasets', new Map([['ACME', raw]]));
    const a = await app();
    expect(a.registry.csvProvider.list()[0].bars.map((b) => b.time)).toEqual(sessionOpens);
    expect(storedTimes()).toEqual(sessionOpens);
    // Filing them again changes nothing.
    expect(a.registry.sessionStamped(a.registry.csvProvider.list()[0])).toBe(a.registry.csvProvider.list()[0]);
  });

  it('are backed up filed under their session, even when storage still has the midnight stamps', async () => {
    const a = await app();
    db.stores.set('datasets', new Map([['ACME', raw]]));
    const { backup } = await a.createBackup({ snapshots: false, datasets: true, holdBack: () => false });
    expect(backup.datasets![0].bars.map((b) => b.time)).toEqual(sessionOpens);
  });

  it('are restored filed under their session, so a replay never shows a day’s bar before that day has traded', async () => {
    const text = JSON.stringify({ format: 'stock-replay-backup', version: 1, createdAt: 1, journal: [], datasets: [raw] });
    const b = await app();
    expect(await b.restoreBackup(b.parseBackup(text).backup, { settings: false })).toMatchObject({ datasetsAdded: ['ACME'] });
    expect(b.registry.csvProvider.list()[0].bars.map((x) => x.time)).toEqual(sessionOpens);
    expect(storedTimes()).toEqual(sessionOpens);
    // Without a reload: Jan 10 to 12, jumped to 09:31 on Jan 11. Jan 11's bar has not traded yet.
    const trading = await import('../state/tradingStore');
    const replay = { providerId: 'csv', symbol: 'ACME', date: '2024-01-10', startTime: '09:30', endDate: '2024-01-12', endTime: '16:00', startingBalance: 25_000, lookbackDays: 2 };
    expect(await trading.startReplay({ ...replay, timeframe: '1D', speed: 1, blind: false })).toBe(true);
    trading.jumpTo(exchangeTimeToUnix('2024-01-11', 9 * 60 + 31));
    expect(trading.lastPrice('ACME')).toBe(106);
    expect(trading.getBaseBars('ACME').every((x) => x.time < exchangeTimeToUnix('2024-01-11', 0))).toBe(true);
    await trading.endSession();
  });
});

describe('reading a backup file', () => {
  it('refuses a file that is not a backup, with a reason', async () => {
    const { parseBackup } = await app();
    expect(() => parseBackup('not json')).toThrow('not valid JSON');
    expect(() => parseBackup('{"format":"something-else"}')).toThrow('not a Stock Replay backup');
    expect(() => parseBackup('{"format":"stock-replay-backup","version":2}')).toThrow('newer version');
  });

  it('restores a journal exported from the Journal page, and skips entries it cannot read', async () => {
    const { parseBackup } = await app();
    const broken = { ...entry('bad'), notes: null };
    const { backup, skipped } = parseBackup(JSON.stringify([entry('j1'), broken, { id: 3 }]));
    expect(backup.journal.map((e) => e.id)).toEqual(['j1']);
    expect(skipped).toBe(2);
    expect(backup.settings).toBeNull();
    expect(backup.datasets).toBeUndefined();
  });

  it('skips drawings, attempts and datasets it cannot read, and snapshots that are not images', async () => {
    const { parseBackup } = await app();
    const { backup, skipped } = parseBackup(
      JSON.stringify({
        format: 'stock-replay-backup',
        version: 1,
        createdAt: 1,
        journal: [],
        snapshots: { a: 'data:image/png;base64,AA', b: 'javascript:alert(1)' },
        challenges: [{ id: 'x' }],
        drawings: { TSLA: [{ id: 'd', type: 'hline', color: '#fff', points: [{ time: 1, price: 'x' }] }] },
        datasets: [{ ...dataset, bars: [dataset.bars[1], dataset.bars[0]] }],
        streak: 'garbage',
      }),
    );
    expect(Object.keys(backup.snapshots)).toEqual(['a']);
    expect(backup.challenges).toEqual([]);
    expect(backup.drawings).toEqual({});
    expect(backup.datasets).toEqual([]);
    expect(backup.streak.days).toEqual({});
    expect(skipped).toBe(3);
  });

  it('skips data of a bar size the replay does not support, and drawings of an unknown kind or with the wrong number of points', async () => {
    const { parseBackup } = await app();
    const { backup, skipped } = parseBackup(
      JSON.stringify({
        format: 'stock-replay-backup',
        version: 1,
        createdAt: 1,
        journal: [],
        drawings: {
          TSLA: [
            { id: 'ok', type: 'trend', color: '#fff', points: [{ time: 1, price: 1 }, { time: 2, price: 2 }] },
            { id: 'short', type: 'trend', color: '#fff', points: [{ time: 1, price: 1 }] },
            { id: 'odd', type: 'circle', color: '#fff', points: [{ time: 1, price: 1 }] },
          ],
        },
        datasets: [dataset, { ...dataset, symbol: 'ODD', baseTimeframe: '3m' }],
      }),
    );
    expect(backup.drawings.TSLA.map((d) => d.id)).toEqual(['ok']);
    expect(backup.datasets!.map((d) => d.symbol)).toEqual(['ACME']);
    expect(skipped).toBe(3);
  });

  it('restores only settings it can use, never the settings store’s own functions, and they stay right after a reload', async () => {
    const a = await app();
    const { backup } = a.parseBackup(
      JSON.stringify({
        format: 'stock-replay-backup',
        version: 1,
        createdAt: 1,
        journal: [],
        settings: { watchlist: 'SPY', update: 1, execution: { commissionPerShare: 'abc', commission: { perShare: 'abc', perOrder: 1 } }, replay: { symbol: 'AAPL', timeframe: '3m' } },
      }),
    );
    expect(backup.settings).toEqual({ execution: { commission: { perOrder: 1 } }, replay: { symbol: 'AAPL' } });
    expect(a.parseBackup(JSON.stringify({ format: 'stock-replay-backup', version: 1, settings: { update: 1 } })).backup.settings).toBeNull();
    expect((await a.restoreBackup(backup, { settings: true })).settings).toBe(true);
    const b = await app();
    await vi.waitFor(() => expect(b.useSettings.persist.hasHydrated()).toBe(true));
    const s = b.useSettings.getState();
    expect(typeof s.update).toBe('function');
    expect(s.watchlist).toEqual(['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META']);
    expect(s.execution.commission).toEqual({ perShare: 0, perOrder: 1, minimumPerOrder: 0, maxPctOfValue: 0 });
    expect(s.replay).toMatchObject({ symbol: 'AAPL', timeframe: '1m' });
  });
});
