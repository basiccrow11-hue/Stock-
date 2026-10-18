// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { EMPTY_NOTES, type JournalEntry } from '../../core/journal';
import type { CsvDataset } from '../../core/data/csvProvider';
import type { Bar } from '../../core/types';
import { exchangeTimeToUnix } from '../../core/time';
import type { ChartGeometry } from '../chart/DrawingLayer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

// The appearance card's preview and the analytics equity curve draw on a canvas jsdom does not have.
vi.mock('../components/Appearance', () => ({ AppearanceCard: () => null }));
vi.mock('../chart/LineChart', () => ({ LineChart: () => null }));

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

/** A chart snapshot stored as the journal stores one. */
function saveShot(key: string, img: string) {
  if (!db.stores.has('snapshots')) db.stores.set('snapshots', new Map());
  db.stores.get('snapshots')!.set(key, img);
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

  it('finishes a restore cut off inside the challenge history when the same file is restored again', async () => {
    const a = await app();
    for (const [id, startedAt] of [['c1', 1], ['c2', 2], ['c3', 3]] as const) {
      a.useChallenges.getState().start({ id, challengeId: 'risk1', sessionId: 's1', startedAt, label: 'Risk 1%', result: { status: 'passed', detail: 'ok', progress: 1, official: true } as never });
      await a.useChallenges.getState().finishActive();
    }
    const text = JSON.stringify((await a.createBackup({ snapshots: false, datasets: false, holdBack: () => false })).backup);

    clearSiteData();
    const b = await app();
    db.failing = (store, key) => store === 'challenges' && key === 'c2';
    await expect(b.restoreBackup(b.parseBackup(text).backup, { settings: false })).rejects.toThrow('quota');
    // What was written shows at once.
    const shown = () => b.useChallenges.getState().attempts.map((x) => x.id);
    expect(shown()).toEqual([...db.stores.get('challenges')!.keys()]);
    expect(shown()).toHaveLength(1);
    db.failing = null;
    expect(await b.restoreBackup(b.parseBackup(text).backup, { settings: false })).toMatchObject({ challengesAdded: 2 });
    expect(shown()).toEqual(['c3', 'c2', 'c1']);
    expect(await b.restoreBackup(b.parseBackup(text).backup, { settings: false })).toMatchObject({ challengesAdded: 0 });

    // An attempt stored but missing from this tab's list (left so by an earlier version) is put back in it, and counted.
    clearSiteData();
    const c = await app();
    db.stores.set('challenges', new Map([['c1', { ...b.useChallenges.getState().attempts[2], label: 'stored here' }]]));
    expect(await c.restoreBackup(c.parseBackup(text).backup, { settings: false })).toMatchObject({ challengesAdded: 3 });
    expect(c.useChallenges.getState().attempts.map((x) => [x.id, x.label])).toEqual([['c3', 'Risk 1%'], ['c2', 'Risk 1%'], ['c1', 'stored here']]);
  });

  it('adds the chart snapshots a backup without them left off entries already here, and never replaces one here', async () => {
    const a = await app();
    for (const id of ['j1', 'j2', 'j3']) {
      await a.useJournal.getState().add(entry(id, { snapshotKey: `k-${id}` }));
      saveShot(`k-${id}`, `data:image/png;base64,${id}`);
    }
    const small = JSON.stringify((await a.createBackup({ snapshots: false, datasets: false, holdBack: () => false })).backup);
    const full = JSON.stringify((await a.createBackup({ snapshots: true, datasets: false, holdBack: () => false })).backup);
    // A journal exported from the Journal page has the snapshots' keys but not the pictures.
    const exported = JSON.stringify(a.useJournal.getState().entries);

    clearSiteData();
    const b = await app();
    expect(await b.restoreBackup(b.parseBackup(small).backup, { settings: false })).toMatchObject({ journalAdded: 3, snapshotsAdded: 0 });
    expect(await b.restoreBackup(b.parseBackup(exported).backup, { settings: false })).toMatchObject({ journalAdded: 0, journalKept: 3, snapshotsAdded: 0 });
    expect(db.stores.get('snapshots')?.size ?? 0).toBe(0);
    // A picture this browser has stays; one that is another entry's picture here is not this one's.
    saveShot('k-j1', 'data:image/png;base64,mine');
    db.stores.get('journal')!.set('j3', entry('j3', { snapshotKey: 'k-other' }));
    const c = await app();
    expect(await c.restoreBackup(c.parseBackup(full).backup, { settings: false })).toMatchObject({ journalAdded: 0, journalKept: 3, snapshotsAdded: 1 });
    expect(Object.fromEntries(db.stores.get('snapshots')!)).toEqual({ 'k-j1': 'data:image/png;base64,mine', 'k-j2': 'data:image/png;base64,j2' });
    expect(await c.restoreBackup(c.parseBackup(full).backup, { settings: false })).toMatchObject({ journalAdded: 0, journalKept: 3, snapshotsAdded: 0 });
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

/** Renders `el` as the app shows a page, inside its error boundary, and returns the text it shows. `then` acts on it first. */
async function shown(el: ReactElement, then?: (host: HTMLElement) => void): Promise<string> {
  const { ErrorBoundary } = await import('../components/ErrorBoundary');
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  await act(async () => root.render(createElement(ErrorBoundary, { what: 'The page', layout: 'page', children: el })));
  if (then) act(() => then(host));
  await act(async () => new Promise((r) => setTimeout(r, 10)));
  const text = host.textContent ?? '';
  act(() => root.unmount());
  host.remove();
  return text;
}

/** What the chart hands its drawings, as lightweight-charts 5 would: `candles` 10px apart from x = 100. */
function geometry(candles: Bar[]): ChartGeometry {
  const timeScale = { logicalToCoordinate: (l: number) => 100 + l * 10 };
  return {
    chart: { timeScale: () => timeScale } as never,
    series: { priceToCoordinate: (p: number) => 500 - p, coordinateToPrice: (y: number) => 500 - y } as never,
    candles: () => candles,
    timeframe: '1m',
    paneHeight: () => 400,
    paneWidth: () => 800,
    container: document.body,
  };
}

/** A finished challenge attempt, its result as `result` changes it. */
function attempt(id: string, result: Record<string, unknown> = {}) {
  return { id, challengeId: 'rules-20', sessionId: 's1', label: 'TSLA · 2025-01-15', startedAt: 1, result: { status: 'failed', progress: 0, detail: `Attempt ${id} broke a rule.`, official: true, ...result } };
}

const STOPPED = 'stopped because of an error';

describe('a hand-edited or foreign backup', () => {
  it('keeps drawings and indicators whose colour is not a hex colour, in their default colour, and skips attempts the Challenges page could not show', async () => {
    const a = await app();
    const { backup, skipped } = a.parseBackup(
      JSON.stringify({
        format: 'stock-replay-backup',
        version: 1,
        createdAt: 1,
        journal: [],
        drawings: { TSLA: [{ id: 'd1', type: 'hline', color: 'red', points: [{ time: dataset.bars[0].time, price: 1.5 }] }] },
        settings: {
          indicators: [
            { id: 'ema21', type: 'ema', enabled: true, period: 21, color: 'rgb(255,0,0)' },
            { id: 'mine', type: 'rsi', enabled: true, period: 7, color: 'teal' },
            { id: 'ok', type: 'sma', enabled: true, period: 50, color: '#ABC' },
          ],
        },
        challenges: [attempt('a1'), attempt('a2', { detail: { a: 1 } }), attempt('a3', { official: 'yes' }), attempt('a4', { progress: 'half' }), attempt('a5', { progress: undefined })],
      }),
    );
    expect(skipped).toBe(3);
    expect(backup.drawings.TSLA).toEqual([{ id: 'd1', type: 'hline', color: '#4f8cff', points: [{ time: dataset.bars[0].time, price: 1.5 }] }]);
    expect(backup.challenges.map((x) => x.id)).toEqual(['a1', 'a5']);
    expect(await a.restoreBackup(backup, { settings: true })).toMatchObject({ drawingsAdded: 1, challengesAdded: 2, settings: true });
    // Each in its kind's own default colour; a hex colour stays, written in full.
    expect(a.useSettings.getState().indicators.map((i) => [i.id, i.color])).toEqual([
      ['ema21', '#4f8cff'],
      ['mine', '#b39ddb'],
      ['ok', '#aabbcc'],
    ]);

    // The screens they are on draw.
    const { indicatorColors } = await import('../chart/chartParts');
    const { resolveTheme } = await import('../theme/themes');
    const palette = resolveTheme(a.useSettings.getState().appearance).chart;
    for (const i of a.useSettings.getState().indicators) expect(() => indicatorColors(i, palette)).not.toThrow();
    a.drawings.useDrawings.getState().setSymbol('TSLA');
    const { DrawingLayer } = await import('../chart/DrawingLayer');
    let chart = '';
    expect(await shown(createElement(DrawingLayer, { geometry: geometry(dataset.bars), version: 0 }), (host) => (chart = host.innerHTML))).not.toContain(STOPPED);
    expect(chart).toContain('stroke="#4f8cff"');
    const { ChallengesPage } = await import('../pages/ChallengesPage');
    const page = await shown(createElement(ChallengesPage, { onStart: () => undefined }));
    expect(page).not.toContain(STOPPED);
    expect(page).toContain('Attempt a1 broke a rule.');
  });

  /** A trade review as the journal keeps one. */
  const review = {
    tripId: 't-r1',
    outcome: 'win',
    exitReason: 'manual',
    rMultiple: 1.5,
    plannedRR: null,
    mfe: { perShare: 1, dollars: 10, pct: 1, r: 1.5 },
    mae: { perShare: 0, dollars: 0, pct: 0, r: 0 },
    capturePct: 100,
    riskDollars: 6.67,
    riskPctOfEquity: 0.03,
    equityAtEntry: 25_000,
    atrAtEntry: null,
    stopDistanceAtr: null,
    targetDistanceAtr: null,
    afterExit: null,
    findings: [{ tone: 'good', title: 'Kept the gain', detail: 'You kept all of it.' }],
    rules: [{ rule: 'Use a stop', passed: true, detail: 'It had one.' }],
  };

  it('skips journal entries and imported data that a screen could not show', async () => {
    const a = await app();
    const ds = (symbol: string, over: Partial<Record<keyof CsvDataset, unknown>> = {}) => ({ ...dataset, symbol, name: symbol, ...over });
    const { backup, skipped } = a.parseBackup(
      JSON.stringify({
        format: 'stock-replay-backup',
        version: 1,
        createdAt: 1,
        journal: [
          entry('j1'),
          entry('r1', { review: review as never }),
          entry('notes', { notes: { ...EMPTY_NOTES, extra: 5 } as never }),
          entry('review', { review: { ...review, mfe: { perShare: 1, dollars: 10, pct: 1 } } as never }),
          entry('findings', { review: { ...review, findings: [{ tone: 'good', title: { a: 1 }, detail: 'x' }] } as never }),
          entry('rules', { review: { ...review, rules: 'Use a stop' } as never }),
          entry('entered', { entryTime: 9e12 }),
          entry('exited', { exitTime: 3e11 }),
        ],
        datasets: [
          ds('ACME'),
          ds('NAME', { name: { a: 1 } }),
          ds('FILE', { fileName: ['acme.csv'] }),
          ds('TIME', { bars: [{ ...dataset.bars[0], time: 9e12 }] }),
          ds('VOL', { bars: [{ ...dataset.bars[0], volume: 'many' }] }),
        ],
        settings: { replay: { providerId: 'csv', symbol: 'ACME' } },
      }),
    );
    expect(backup.journal.map((e) => e.id)).toEqual(['j1', 'r1']);
    expect(backup.datasets!.map((d) => d.symbol)).toEqual(['ACME']);
    expect(skipped).toBe(10);
    await a.restoreBackup(backup, { settings: true });

    const { JournalPage } = await import('../pages/JournalPage');
    const search = (host: HTMLElement) => {
      const box = host.querySelector<HTMLInputElement>('input[placeholder^="Search"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, 'kept');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    };
    for (const id of ['j1', 'r1']) expect(await shown(createElement(JournalPage, { focusId: id }), search)).not.toContain(STOPPED);
    expect(await shown(createElement(JournalPage, { focusId: 'r1' }))).toContain('Kept the gain');
    const { AnalyticsPage } = await import('../pages/AnalyticsPage');
    expect(await shown(createElement(AnalyticsPage))).not.toContain(STOPPED);
    const { SettingsPage } = await import('../pages/SettingsPage');
    expect(await shown(createElement(SettingsPage))).toContain('acme.csv');
    const { SessionSetup } = await import('../components/SessionSetup');
    expect(await shown(createElement(SessionSetup, { mode: 'replay', onClose: () => undefined }))).not.toContain(STOPPED);
  });

  it('skips entries and attempts whose data source, exit reason or missing snapshot the app does not know, and keeps every one it ever wrote', async () => {
    const a = await app();
    const known = [
      entry('demo'),
      entry('historical', { source: 'HISTORICAL' }),
      entry('simulated', { source: 'SIMULATED', mode: 'sim' }),
      entry('live', { source: 'LIVE' }),
      ...['stop_loss', 'take_profit', 'manual', 'session_end', 'other'].map((r) => entry(`exit-${r}`, { review: { ...review, exitReason: r } as never })),
      entry('shot-off', { snapshotMissing: 'off' }),
      entry('shot-failed', { snapshotMissing: 'failed' }),
    ];
    const { backup, skipped } = a.parseBackup(
      JSON.stringify({
        format: 'stock-replay-backup',
        version: 1,
        createdAt: 1,
        journal: [
          ...known,
          entry('proto', { source: '__proto__' as never }),
          entry('foo', { source: 'FOO' as never }),
          entry('exit-proto', { review: { ...review, exitReason: '__proto__' } as never }),
          entry('exit-foo', { review: { ...review, exitReason: 'stop' } as never }),
          entry('shot-proto', { snapshotMissing: '__proto__' as never }),
        ],
        challenges: [
          attempt('a1'),
          { ...attempt('a2'), source: 'HISTORICAL' },
          { ...attempt('a3'), startedAt: Date.UTC(2026, 9, 10) },
          { ...attempt('a4'), source: '__proto__' },
          { ...attempt('a5'), source: 'FOO' },
          { ...attempt('a6'), startedAt: 1e20 },
          { ...attempt('a7'), startedAt: '2026-10-10' },
        ],
      }),
    );
    expect(backup.journal.map((e) => e.id)).toEqual(known.map((e) => e.id));
    expect(backup.challenges.map((x) => x.id)).toEqual(['a1', 'a2', 'a3']);
    expect(skipped).toBe(9);
    expect(await a.restoreBackup(backup, { settings: false })).toMatchObject({ journalAdded: known.length, challengesAdded: 3 });
    const { JournalPage } = await import('../pages/JournalPage');
    expect(await shown(createElement(JournalPage, { focusId: 'exit-session_end' }))).toContain('Session ended');
    const { AnalyticsPage } = await import('../pages/AnalyticsPage');
    expect(await shown(createElement(AnalyticsPage))).not.toContain(STOPPED);
    const { ChallengesPage } = await import('../pages/ChallengesPage');
    expect(await shown(createElement(ChallengesPage, { onStart: () => undefined }))).not.toContain(STOPPED);
  });

  it('shows entries already stored with a data source, exit reason or missing snapshot the app does not know, as written', async () => {
    const stored = [
      entry('j1'),
      entry('proto', { source: '__proto__' as never }),
      entry('ctor', { source: 'constructor' as never }),
      entry('exit-proto', { review: { ...review, exitReason: '__proto__' } as never }),
      entry('exit-tostring', { review: { ...review, exitReason: 'toString' } as never }),
      entry('shot-proto', { snapshotMissing: '__proto__' as never }),
    ];
    db.stores.set('journal', new Map(stored.map((e) => [e.id, e])));
    db.stores.set('challenges', new Map<string, unknown>([['a1', { ...attempt('a1'), source: '__proto__' }], ['a2', { ...attempt('a2'), startedAt: 1e20 }], ['a3', { ...attempt('a3'), source: 'SIMULATED' }]]));
    const a = await app();
    expect(a.useJournal.getState().entries).toHaveLength(stored.length);
    const { JournalPage } = await import('../pages/JournalPage');
    for (const e of stored) expect(await shown(createElement(JournalPage, { focusId: e.id }))).not.toContain(STOPPED);
    expect(await shown(createElement(JournalPage, { focusId: 'ctor' }))).toContain('constructor');
    expect(await shown(createElement(JournalPage, { focusId: 'exit-proto' }))).toContain('Exit reason__proto__');
    expect(await shown(createElement(JournalPage, { focusId: 'exit-tostring' }))).toContain('Exit reasontoString');
    expect(await shown(createElement(JournalPage, { focusId: 'shot-proto' }))).toContain('No chart snapshot.');
    const { AnalyticsPage } = await import('../pages/AnalyticsPage');
    const analytics = await shown(createElement(AnalyticsPage));
    expect(analytics).not.toContain(STOPPED);
    expect(analytics).toContain('Their prices are synthetic, unknown and unknown');
    const byExit = analytics.slice(analytics.indexOf('By exit reason'));
    expect(byExit).toContain('__proto__');
    expect(byExit).toContain('toString');
    // An attempt the Challenges page could not show is left out as it loads.
    expect(a.useChallenges.getState().attempts.map((x) => x.id)).toEqual(['a3']);
    const { ChallengesPage } = await import('../pages/ChallengesPage');
    expect(await shown(createElement(ChallengesPage, { onStart: () => undefined }))).not.toContain(STOPPED);
  });

  it('leaves out an attempt stored before such files were checked, and takes a good copy of it from a later restore', async () => {
    db.stores.set('challenges', new Map<string, unknown>([['a1', attempt('a1', { detail: { a: 1 } })], ['a2', attempt('a2')]]));
    const a = await app();
    expect(a.useChallenges.getState().attempts.map((x) => x.id)).toEqual(['a2']);
    const { ChallengesPage } = await import('../pages/ChallengesPage');
    expect(await shown(createElement(ChallengesPage, { onStart: () => undefined }))).not.toContain(STOPPED);
    const file = JSON.stringify({ format: 'stock-replay-backup', version: 1, createdAt: 1, journal: [], challenges: [attempt('a1'), attempt('a2', { detail: 'Changed since.' })] });
    expect(await a.restoreBackup(a.parseBackup(file).backup, { settings: false })).toMatchObject({ challengesAdded: 1 });
    expect(a.useChallenges.getState().attempts.map((x) => [x.id, x.result.detail]).sort()).toEqual([
      ['a1', 'Attempt a1 broke a rule.'],
      ['a2', 'Attempt a2 broke a rule.'],
    ]);
    expect(await shown(createElement(ChallengesPage, { onStart: () => undefined }))).toContain('Attempt a1 broke a rule.');
  });
});
