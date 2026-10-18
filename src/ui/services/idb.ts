/**
 * Minimal promise-based IndexedDB key-value store. Used for data that is too large for
 * localStorage: imported CSV datasets, journal entries, chart snapshots, encrypted credentials and
 * unfinished sessions (savedSessions).
 * Every call degrades gracefully (rejects with a clear error) if IndexedDB is unavailable. A
 * connection the browser closes (site data cleared with the app open) is opened again.
 */
const DB_NAME = 'stock-replay';
const DB_VERSION = 1;
export const STORES = ['datasets', 'journal', 'snapshots', 'kv', 'challenges'] as const;
export type StoreName = (typeof STORES)[number];

/**
 * Why storage cannot be used: a newer version of the app, opened in another tab, has upgraded the
 * database, which this version cannot open. Only reloading the page (to the newer version) helps.
 */
export const STORAGE_UPGRADED = 'A newer version of the app, opened in another tab, has updated its storage: reload this page to keep saving';

let dbPromise: Promise<IDBDatabase> | null = null;
/** The connection dbPromise gave. */
let opened: IDBDatabase | null = null;

/** Lets go of connection `db`, if it is still the one in use: the next call opens a new one. */
function forget(db: IDBDatabase): void {
  if (opened !== db) return;
  opened = null;
  dbPromise = null;
}

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser; data will not persist.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => {
      const db = req.result;
      // The browser closes the connection when the site's data is cleared with the app open, and a
      // newer version of the app in another tab can upgrade the database only once it is closed.
      db.onclose = () => forget(db);
      db.onversionchange = () => {
        db.close();
        forget(db);
      };
      if (dbPromise === opening) opened = db;
      resolve(db);
    };
    req.onerror = () => reject(req.error?.name === 'VersionError' ? new Error(STORAGE_UPGRADED) : (req.error ?? new Error('Could not open IndexedDB')));
  });
  dbPromise = opening;
  opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });
  return opening;
}

/**
 * `run` on a new transaction. When the connection was closed under the app before it heard (site data
 * cleared), the transaction cannot be started on it, and is started once on a new connection: nothing
 * ran on the old one, so nothing runs twice. A transaction that started and then failed is never tried again.
 */
function begin<T>(store: StoreName, mode: IDBTransactionMode, run: (t: IDBTransaction) => Promise<T>): Promise<T> {
  return open().then((db) => {
    let t: IDBTransaction;
    try {
      t = db.transaction(store, mode);
    } catch (e) {
      if ((e as DOMException | null)?.name !== 'InvalidStateError') throw e;
      forget(db);
      return open().then((fresh) => run(fresh.transaction(store, mode)));
    }
    return run(t);
  });
}

/**
 * One request in a transaction of its own. A read resolves with the request's result; a write only
 * once the transaction has committed, since storage can still refuse it then (Chromium checks for a
 * full disk as it commits, after the request has succeeded).
 */
function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return begin(
    store,
    mode,
    (t) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(t.objectStore(store));
        if (mode === 'readonly') {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
          return;
        }
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
        t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
      }),
  );
}

export const idb = {
  get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return tx<T>(store, 'readonly', (s) => s.get(key) as IDBRequest<T>);
  },
  /** Resolves once the value is stored (the transaction has committed). */
  set<T>(store: StoreName, key: string, value: T): Promise<IDBValidKey> {
    return tx(store, 'readwrite', (s) => s.put(value, key));
  },
  /** Resolves once the value is gone from storage (the transaction has committed). */
  delete(store: StoreName, key: string): Promise<undefined> {
    return tx(store, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>);
  },
  /**
   * Read, change and write one value in a single transaction, so a write from another tab cannot
   * land between the read and the write. `fn` returning undefined writes nothing. Resolves with the
   * written value once the transaction has committed.
   */
  modify<T>(store: StoreName, key: string, fn: (current: T | undefined) => T | undefined): Promise<T | undefined> {
    return begin(
      store,
      'readwrite',
      (t) =>
        new Promise<T | undefined>((resolve, reject) => {
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
  /** Every value whose key starts with `prefix`. */
  withPrefix<T>(store: StoreName, prefix: string): Promise<T[]> {
    return tx<T[]>(store, 'readonly', (s) => s.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`)) as IDBRequest<T[]>);
  },
  clear(store: StoreName): Promise<undefined> {
    return tx(store, 'readwrite', (s) => s.clear() as IDBRequest<undefined>);
  },
};
