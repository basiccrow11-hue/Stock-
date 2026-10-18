// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_NOTES, type JournalEntry } from '../../core/journal';
import type { CsvDataset } from '../../core/data/csvProvider';
import type { SavedSession } from './savedSessions';

/**
 * IndexedDB as a browser runs it, in miniature: each request succeeds on a turn of its own, and a
 * transaction commits once no request is left, only then writing what its requests put. `refuse`
 * makes a transaction that wrote a chosen key fail as it commits, after its put has succeeded, as
 * Chromium does when the disk is full. `version` is the database's (a newer version of the app may
 * have upgraded it), `opens` counts the connections asked for and `connections` holds those opened.
 */
const disk = {
  stores: new Map<string, Map<string, unknown>>(),
  refuse: null as ((store: string, key: string) => boolean) | null,
  version: 1,
  opens: 0,
  connections: [] as FakeConnection[],
};
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
      getAll: (range?: { lower: string; upper: string }) =>
        this.request(() =>
          [...data.entries()]
            .filter(([k]) => !range || (k >= range.lower && k <= range.upper))
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([, v]) => structuredClone(v)),
        ),
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

class FakeConnection {
  onclose: Handler = null;
  onversionchange: Handler = null;
  /** Transactions asked of it once closed. */
  refused = 0;
  private closed = false;
  objectStoreNames = { contains: (s: string) => disk.stores.has(s) };
  createObjectStore(s: string) {
    disk.stores.set(s, new Map());
  }
  transaction(s: string) {
    if (this.closed) {
      this.refused++;
      throw new DOMException("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.", 'InvalidStateError');
    }
    return new FakeTransaction(s);
  }
  close() {
    this.closed = true;
  }
  /** Closed by the browser, as when the site's data is cleared: at once, and the close event a moment later. */
  forceClose() {
    this.closed = true;
    setTimeout(() => this.onclose?.());
  }
}

const fakeIndexedDB = {
  open: (_name: string, version: number) => {
    const req = new FakeRequest();
    disk.opens++;
    setTimeout(() => {
      if (version < disk.version) {
        req.error = new DOMException(`The requested version (${version}) is less than the existing version (${disk.version}).`, 'VersionError');
        req.onerror?.();
        return;
      }
      const conn = new FakeConnection();
      disk.connections.push(conn);
      req.result = conn;
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
  disk.version = 1;
  disk.opens = 0;
  disk.connections = [];
  localStorage.clear();
  vi.stubGlobal('indexedDB', fakeIndexedDB);
  vi.stubGlobal('IDBKeyRange', { bound: (lower: string, upper: string) => ({ lower, upper }) });
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
    // A transaction that started and failed is not tried again.
    expect(disk.opens).toBe(1);
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

describe('a connection the browser closes', () => {
  /** Clearing the site's data while the app is open: the browser deletes the database and closes the connection. */
  function clearSiteData() {
    disk.stores = new Map();
    disk.connections.at(-1)!.forceClose();
  }

  it('is let go once closed, and the next call opens a new one', async () => {
    const { idb } = await app();
    await idb.set('kv', 'a', 1);
    clearSiteData();
    await new Promise((r) => setTimeout(r, 10));
    await idb.set('kv', 'b', 2);
    expect(await idb.modify<number>('kv', 'b', (v) => (v ?? 0) + 1)).toBe(3);
    expect(Object.fromEntries(disk.stores.get('kv')!)).toEqual({ b: 3 });
    expect(disk.opens).toBe(2);
    expect(disk.connections[0].refused).toBe(0);
  });

  it('runs a call made before the browser says it closed on a new connection, opened once for every call waiting', async () => {
    const { idb } = await app();
    await idb.set('kv', 'a', 1);
    clearSiteData();
    const calls = [idb.set('kv', 'b', 2), idb.get('kv', 'a'), idb.modify<number>('kv', 'c', () => 5)];
    expect(await Promise.all(calls)).toEqual(['b', undefined, 5]);
    expect(Object.fromEntries(disk.stores.get('kv')!)).toEqual({ b: 2, c: 5 });
    expect(disk.connections[0].refused).toBe(3);
    expect(disk.opens).toBe(2);
    expect(await idb.get('kv', 'b')).toBe(2);
    expect(disk.opens).toBe(2);
  });

  it('with storage emptied: a session saved after that is stored whole again, checkpoints and all', async () => {
    const a = await app();
    const cp = (time: number) => ({ cursors: [time], time, revealed: time, broker: { events: [] }, config: {} });
    const replay = { providerId: 'demo', state: { config: {}, checkpoints: [cp(1), cp(2)] } };
    const session = {
      ...{ version: a.saved.SAVED_SESSION_VERSION, summary: { id: 's1', savedAt: 1 }, view: { activeSymbol: 'SPY', timeframe: '1m', speed: 60 } },
      ...{ warnings: [], journaledTrips: [], watching: [], challenge: null, replay },
    } as unknown as SavedSession;
    await a.saved.writeSession(session);
    clearSiteData();
    await new Promise((r) => setTimeout(r, 10));
    await a.saved.writeSession({ ...session, summary: { ...session.summary, savedAt: 2 } });
    expect((await a.saved.readSession('s1'))?.replay?.state.checkpoints.map((c) => c.time)).toEqual([1, 2]);
  });

  it('is closed for a newer version of the app in another tab, and then says to reload the page', async () => {
    const a = await app();
    await a.idb.set('kv', 'a', 1);
    // The newer version upgrades the database once this tab has let its connection go.
    disk.version = 2;
    disk.connections.at(-1)!.onversionchange?.();
    const { STORAGE_UPGRADED } = await import('./idb');
    expect(STORAGE_UPGRADED).toMatch(/reload this page/);
    await expect(a.idb.set('kv', 'b', 2)).rejects.toThrow(STORAGE_UPGRADED);
    await expect(a.idb.get('kv', 'a')).rejects.toThrow(STORAGE_UPGRADED);
    // A closing connection that cannot be opened again says the same.
    disk.version = 1;
    await a.idb.set('kv', 'c', 3);
    disk.version = 2;
    disk.connections.at(-1)!.forceClose();
    await expect(a.useJournal.getState().add({ id: 'j1', notes: { ...EMPTY_NOTES } } as JournalEntry)).resolves.toBeUndefined();
    expect(a.useJournal.getState().error).toBe(STORAGE_UPGRADED);
  });
});
