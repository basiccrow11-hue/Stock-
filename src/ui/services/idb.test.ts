// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_NOTES, type JournalEntry } from '../../core/journal';
import type { CsvDataset } from '../../core/data/csvProvider';
import type { SavedSession } from './savedSessions';

/**
 * IndexedDB as a browser runs it, in miniature: each request succeeds on a turn of its own, and a
 * transaction commits once no request is left, only then writing what its requests put. `refuse`
 * makes a transaction that wrote a chosen key fail as it commits, after its put has succeeded, as
 * Chromium does when the disk is full.
 */
const disk = { stores: new Map<string, Map<string, unknown>>(), refuse: null as ((store: string, key: string) => boolean) | null };
const GONE = Symbol('deleted');
type Handler = (() => void) | null;

class FakeRequest {
  result: unknown;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
}

class FakeTransaction {
  error: DOMException | null = null;
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  private pending = 0;
  private readonly writes: Array<[string, unknown]> = [];
  private readonly data: Map<string, unknown>;
  constructor(private readonly name: string) {
    this.data = disk.stores.get(name)!;
  }
  objectStore() {
    const data = this.data;
    return {
      get: (key: string) => this.request(() => structuredClone(data.get(key))),
      getAll: () => this.request(() => [...data.values()].map((v) => structuredClone(v))),
      put: (value: unknown, key: string) => {
        const copy = structuredClone(value);
        return this.request(() => (this.writes.push([key, copy]), key));
      },
      delete: (key: string) => this.request(() => void this.writes.push([key, GONE])),
    };
  }
  private request(run: () => unknown): FakeRequest {
    const req = new FakeRequest();
    this.pending++;
    setTimeout(() => {
      req.result = run();
      req.onsuccess?.();
      if (--this.pending === 0) setTimeout(() => this.commit());
    });
    return req;
  }
  private commit() {
    if (this.writes.some(([key]) => disk.refuse?.(this.name, key))) {
      this.error = new DOMException('Encountered full disk while committing transaction.', 'QuotaExceededError');
      this.onabort?.();
      return;
    }
    for (const [key, v] of this.writes) {
      if (v === GONE) this.data.delete(key);
      else this.data.set(key, v);
    }
    this.oncomplete?.();
  }
}

const fakeIndexedDB = {
  open: () => {
    const req = new FakeRequest();
    req.result = {
      objectStoreNames: { contains: (s: string) => disk.stores.has(s) },
      createObjectStore: (s: string) => void disk.stores.set(s, new Map()),
      transaction: (s: string) => new FakeTransaction(s),
    };
    setTimeout(() => {
      req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  },
};

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
  const { idb } = await import('./idb');
  const backup = await import('./backup');
  const registry = await import('../state/dataRegistry');
  const { useJournal } = await import('../state/journalStore');
  const saved = await import('./savedSessions');
  await registry.loadCsvDatasets();
  return { idb, ...backup, registry, useJournal, saved };
}

beforeEach(() => {
  disk.stores = new Map();
  disk.refuse = null;
  localStorage.clear();
  vi.stubGlobal('indexedDB', fakeIndexedDB);
});
afterEach(() => vi.unstubAllGlobals());

describe('a write storage refuses as it commits', () => {
  it('counts as stored only once it has committed', async () => {
    const { idb } = await app();
    await idb.set('kv', 'a', 1);
    expect(disk.stores.get('kv')!.get('a')).toBe(1);
    expect(await idb.get('kv', 'a')).toBe(1);
    await idb.delete('kv', 'a');
    expect(disk.stores.get('kv')!.has('a')).toBe(false);
    disk.refuse = () => true;
    await expect(idb.set('kv', 'b', 2)).rejects.toThrow('full disk');
    disk.stores.get('kv')!.set('c', 3);
    await expect(idb.delete('kv', 'c')).rejects.toThrow('full disk');
    expect(disk.stores.get('kv')!.get('c')).toBe(3);
  });

  it('leaves an imported dataset unshown, and a restore stopped with nothing shown, until it is stored', async () => {
    const a = await app();
    disk.refuse = (store) => store === 'datasets';
    await expect(a.registry.saveCsvDataset(dataset)).rejects.toThrow('full disk');
    expect(a.registry.csvProvider.list()).toEqual([]);

    const text = JSON.stringify({ format: 'stock-replay-backup', version: 1, createdAt: 1, journal: [], datasets: [dataset] });
    await expect(a.restoreBackup(a.parseBackup(text).backup, { settings: false })).rejects.toThrow('full disk');
    expect(a.registry.csvProvider.list()).toEqual([]);
    expect(disk.stores.get('datasets')!.size).toBe(0);
    // Restoring the same file again, once there is room, adds it.
    disk.refuse = null;
    expect(await a.restoreBackup(a.parseBackup(text).backup, { settings: false })).toMatchObject({ datasetsAdded: ['ACME'], datasetsKept: [] });
    expect((await app()).registry.csvProvider.list().map((d) => d.symbol)).toEqual(['ACME']);
  });

  it('is reported by the journal', async () => {
    const a = await app();
    disk.refuse = (store) => store === 'journal';
    await a.useJournal.getState().add({ id: 'j1', notes: { ...EMPTY_NOTES } } as JournalEntry);
    expect(a.useJournal.getState().error).toEqual(expect.stringContaining('full disk'));
  });

  it('lists no saved session whose record was not stored', async () => {
    const a = await app();
    disk.refuse = (_store, key) => key.startsWith('session:');
    const session = {
      version: a.saved.SAVED_SESSION_VERSION,
      summary: { id: 's1', savedAt: 1 },
      view: { activeSymbol: 'SPY', timeframe: '1m', speed: 60 },
      warnings: [],
      journaledTrips: [],
      watching: [],
      challenge: null,
    } as unknown as SavedSession;
    await expect(a.saved.writeSession(session)).rejects.toThrow('full disk');
    expect([...disk.stores.get('kv')!.keys()]).toEqual([]);
  });
});
