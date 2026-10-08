/**
 * Minimal promise-based IndexedDB key-value store. Used for data that is too large for
 * localStorage: imported CSV datasets, journal entries, chart snapshots, encrypted credentials.
 * Every call degrades gracefully (rejects with a clear error) if IndexedDB is unavailable.
 */
const DB_NAME = 'stock-replay';
const DB_VERSION = 1;
export const STORES = ['datasets', 'journal', 'snapshots', 'kv', 'challenges'] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser; data will not persist.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open IndexedDB'));
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
      }),
  );
}

export const idb = {
  get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return tx<T>(store, 'readonly', (s) => s.get(key) as IDBRequest<T>);
  },
  set<T>(store: StoreName, key: string, value: T): Promise<IDBValidKey> {
    return tx(store, 'readwrite', (s) => s.put(value, key));
  },
  delete(store: StoreName, key: string): Promise<undefined> {
    return tx(store, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>);
  },
  /**
   * Read, change and write one value in a single transaction, so a write from another tab cannot
   * land between the read and the write. `fn` returning undefined writes nothing. Resolves with the
   * written value once the transaction has committed.
   */
  modify<T>(store: StoreName, key: string, fn: (current: T | undefined) => T | undefined): Promise<T | undefined> {
    return open().then(
      (db) =>
        new Promise<T | undefined>((resolve, reject) => {
          const t = db.transaction(store, 'readwrite');
          const s = t.objectStore(store);
          let next: T | undefined;
          const req = s.get(key) as IDBRequest<T | undefined>;
          req.onsuccess = () => {
            next = fn(req.result);
            if (next !== undefined) s.put(next, key);
          };
          t.oncomplete = () => resolve(next);
          t.onerror = () => reject(t.error ?? new Error('IndexedDB request failed'));
          t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
        }),
    );
  },
  all<T>(store: StoreName): Promise<T[]> {
    return tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  },
  clear(store: StoreName): Promise<undefined> {
    return tx(store, 'readwrite', (s) => s.clear() as IDBRequest<undefined>);
  },
};
