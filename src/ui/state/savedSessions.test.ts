// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { exchangeDate, exchangeTimeToUnix, nextTradingDay, prevTradingDay } from '../../core/time';
import type { JournalEntry } from '../../core/journal';
import { CHALLENGES } from '../../core/challenges/challenges';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * IndexedDB stand-in: one Map per store, kept across module resets as a browser keeps it across a reload.
 * `written`: the keys written, in order. `held`: while set, deleting a session's summary waits for it.
 * `commitMs`: while set, each call waits for those before it and then takes that long, as IndexedDB runs
 * its transactions one after another (`queue` is the last one). `readMs`: per store, how long a read of
 * it takes, alongside any others, as reads run side by side (a large store takes longer). `readHeld`: per
 * store with a `readMs`, while set, a read of it started then waits for it too. `reading`: reads under way.
 */
const db = vi.hoisted(() => ({
  stores: new Map<string, Map<string, unknown>>(),
  written: [] as string[],
  held: null as Promise<void> | null,
  commitMs: 0,
  queue: Promise.resolve() as Promise<unknown>,
  readMs: {} as Record<string, number>,
  readHeld: {} as Record<string, Promise<void>>,
  reading: new Set<Promise<unknown>>(),
}));
vi.mock('../services/idb', () => {
  const store = (name: string) => {
    if (!db.stores.has(name)) db.stores.set(name, new Map());
    return db.stores.get(name)!;
  };
  const read = <T>(s: string, fn: () => T): Promise<T> => {
    const held = db.readHeld[s];
    const done = db.readMs[s] ? new Promise((r) => setTimeout(r, db.readMs[s])).then(() => held).then(fn) : run(fn);
    db.reading.add(done);
    const over = () => void db.reading.delete(done);
    done.then(over, over);
    return done;
  };
  const run = <T>(fn: () => T | Promise<T>): Promise<T> => {
    if (!db.commitMs) {
      try {
        return Promise.resolve(fn());
      } catch (e) {
        return Promise.reject(e);
      }
    }
    const done = db.queue.then(() => new Promise((r) => setTimeout(r, db.commitMs))).then(fn);
    db.queue = done.catch(() => undefined);
    return done;
  };
  return {
    idb: {
      all: (s: string) => read(s, () => [...store(s).values()].map((v) => structuredClone(v))),
      withPrefix: (s: string, prefix: string) =>
        read(s, () =>
          [...store(s).entries()]
            .filter(([k]) => k.startsWith(prefix))
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([, v]) => structuredClone(v)),
        ),
      get: (s: string, k: string) => read(s, () => structuredClone(store(s).get(k))),
      set: (s: string, k: string, v: unknown) =>
        run(() => {
          db.written.push(k);
          store(s).set(k, structuredClone(v));
        }),
      delete: (s: string, k: string) =>
        run(async () => {
          if (db.held && k.startsWith('session-summary:')) await db.held;
          store(s).delete(k);
        }),
      modify: (s: string, k: string, fn: (v: unknown) => unknown) =>
        run(() => {
          const next = fn(structuredClone(store(s).get(k)));
          if (next !== undefined) store(s).set(k, structuredClone(next));
          return next;
        }),
      clear: (s: string) => run(() => void store(s).clear()),
    },
  };
});
vi.mock('../chart/offscreenSnapshot', () => ({ offscreenSnapshot: async () => 'data:image/jpeg;base64,BB==' }));
// The chart draws on a canvas jsdom does not have; the screen around it is what is tested here.
vi.mock('../chart/ChartView', () => ({ ChartView: () => null }));

/** Web Locks stand-in: locks this page holds, and those another tab holds. */
const locks = vi.hoisted(() => ({ mine: new Set<string>(), elsewhere: new Set<string>() }));
Object.defineProperty(navigator, 'locks', {
  configurable: true,
  value: {
    request: (name: string, _o: unknown, cb: (lock: { name: string } | null) => unknown) => {
      if (locks.mine.has(name) || locks.elsewhere.has(name)) return Promise.resolve(cb(null));
      locks.mine.add(name);
      return Promise.resolve(cb({ name })).then(() => void locks.mine.delete(name));
    },
    query: async () => ({ held: [...locks.mine, ...locks.elsewhere].map((name) => ({ name })), pending: [] }),
  },
});

/**
 * Timers that repeat (liveBlind's heartbeat), kept to stop once the test is over: its pages are gone
 * then, and a page left from an earlier test would otherwise list its blind session again on its next
 * beat, in the middle of a later test (on a busy machine this file takes longer than a beat).
 */
const repeating = vi.hoisted(() => {
  const handles = new Set<ReturnType<typeof setInterval>>();
  const real = globalThis.setInterval;
  globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => {
    const h = real(...a);
    handles.add(h);
    return h;
  }) as typeof setInterval;
  return handles;
});

const settle = () => new Promise((r) => setTimeout(r, 120));

/** The app's modules as a page sees them when it opens: after a reload, what the browser kept. */
async function page() {
  vi.resetModules();
  // The page before it is gone, and its locks with it.
  locks.mine.clear();
  const store = await import('./tradingStore');
  const { useJournal } = await import('./journalStore');
  const { useChallenges } = await import('./challengeStore');
  const { useToasts } = await import('./toasts');
  const { useSettings } = await import('./settingsStore');
  const saved = await import('../services/savedSessions');
  await useJournal.getState().load();
  await useChallenges.getState().load();
  return { store, useJournal, useChallenges, useToasts, useSettings, saved };
}

/** Closing the page as a reload does: its last saves land, then it goes. */
async function reload(p: Awaited<ReturnType<typeof page>>) {
  await settle();
  p.store.pause();
  await settle();
  return page();
}

const replay = { providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m' as const, speed: 60, blind: false };
const at = (hhmm: string) => exchangeTimeToUnix('2024-03-12', Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));

beforeEach(() => {
  db.stores.clear();
  db.written = [];
  db.held = null;
  db.commitMs = 0;
  db.queue = Promise.resolve();
  db.readMs = {};
  db.readHeld = {};
  localStorage.clear();
  sessionStorage.clear();
  locks.mine.clear();
  locks.elsewhere.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const h of repeating) clearInterval(h);
  repeating.clear();
});

describe('carrying a replay on after a reload', () => {
  it('comes back paused where it was: clock, orders, positions, trades and what the chart showed', async () => {
    const a = await page();
    expect(await a.store.startReplay({ ...replay, extraSymbols: ['QQQ'] })).toBe(true);
    a.store.jumpTo(at('10:30'));
    const px = a.store.lastPrice('SPY')!;
    expect(a.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    expect(a.store.submitOrder({ symbol: 'QQQ', action: 'buy', type: 'limit', quantity: 5, limitPrice: 1 }).ok).toBe(true);
    a.store.stepForward();
    a.store.setActiveSymbol('QQQ');
    a.store.setTimeframe('5m');
    a.store.setSpeed(300);
    await settle();
    const before = a.store.useTrading.getState();
    const bars = a.store.getBaseBars('SPY');
    expect(px).toBeGreaterThan(0);

    const b = await reload(a);
    expect(b.store.useTrading.getState().session).toBeNull();
    expect(await b.store.resumeAfterReload()).toBe(true);
    const after = b.store.useTrading.getState();
    expect(after.session).toEqual(before.session);
    expect(after.playing).toBe(false);
    expect(after.now).toBe(before.now);
    expect([after.activeSymbol, after.timeframe, after.speed]).toEqual(['QQQ', '5m', 300]);
    expect(after.positions).toEqual(before.positions);
    expect(after.orders).toEqual(before.orders);
    expect(after.fills).toEqual(before.fills);
    expect(after.account).toEqual(before.account);
    expect(b.store.getBaseBars('SPY')).toEqual(bars);
    expect(b.useToasts.getState().toasts.some((t) => t.text.startsWith('Session restored where you left off'))).toBe(true);
    // Not offered again while it runs here.
    expect(await b.store.unfinishedSessions()).toEqual([]);
    await b.store.endSession();
  });

  it('goes on from the last whole save to where Play had taken the clock, hiding nothing seen', async () => {
    const a = await page();
    expect(await a.store.startReplay(replay)).toBe(true);
    a.store.jumpTo(at('10:05'));
    // A stop far below: the order is saved with the session; the bars after it are not.
    const px = a.store.lastPrice('SPY')!;
    expect(a.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'stop', quantity: 10, stopPrice: px * 2 }).ok).toBe(true);
    await settle();
    for (let i = 0; i < 25; i++) a.store.stepForward();
    await settle();
    const seen = a.store.getBaseBars('SPY');
    const now = a.store.useTrading.getState().now;
    expect(now).toBe(at('10:30'));

    const b = await page(); // a crash: no last save
    expect(await b.store.resumeAfterReload()).toBe(true);
    expect(b.store.useTrading.getState().now).toBe(now);
    expect(b.store.getBaseBars('SPY')).toEqual(seen);
    expect(b.store.useTrading.getState().orders.filter((o) => o.status === 'working')).toHaveLength(1);
    expect(b.store.useTrading.getState().rewinds).toBe(0);
  });

  it('brings the undo history back too, each checkpoint stored once and let go once undone', async () => {
    const a = await page();
    expect(await a.store.startReplay(replay)).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    for (const t of ['10:10', '10:20', '10:30']) {
      a.store.jumpTo(at(t));
      expect(a.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 1 }).ok).toBe(true);
    }
    a.store.stepForward();
    await settle();
    const kv = db.stores.get('kv')!;
    const stored = () => [...kv.keys()].filter((k) => k.startsWith(`session-cp:${id}:`)).sort();
    const listed = () => [...(kv.get(`session:${id}`) as { replay: { state: { checkpoints: string[] } } }).replay.state.checkpoints].sort();
    const before = stored();
    expect(before.length).toBeGreaterThanOrEqual(4);
    expect(listed()).toEqual(before);
    // Saved again: nothing stored twice.
    a.store.cancelAllOrders();
    await settle();
    expect(stored()).toEqual(before);
    // Back to 10:15: the checkpoints after it are undone, and go.
    a.store.jumpTo(at('10:15'));
    await settle();
    expect(stored()).toEqual(listed());
    expect(stored().length).toBeLessThan(before.length);
    expect(a.store.useTrading.getState().positions[0].quantity).toBe(1);

    const b = await reload(a);
    expect(await b.store.resumeAfterReload()).toBe(true);
    expect(b.store.useTrading.getState().rewinds).toBe(1);
    b.store.jumpTo(at('10:40'));
    expect(b.store.useTrading.getState().positions[0].quantity).toBe(1);
    b.store.stepBack();
    b.store.restart();
    await settle();
    expect(b.store.useTrading.getState().now).toBe(at('10:00'));
    expect(b.store.useTrading.getState().orders).toHaveLength(0);
    expect(b.store.useTrading.getState().positions).toHaveLength(0);
  });

  it('journals a trade once, whether it was written before the page went or not', async () => {
    const a = await page();
    expect(await a.store.startReplay(replay)).toBe(true);
    a.store.stepForward();
    const px = a.store.lastPrice('SPY')!;
    expect(a.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10, stopLoss: px - 0.15, takeProfit: px + 0.15 }).ok).toBe(true);
    a.store.jumpTo(at('12:00'));
    await vi.waitFor(() => expect(a.useJournal.getState().entries).toHaveLength(1));
    const id = a.useJournal.getState().entries[0].id;

    const b = await reload(a);
    expect(await b.store.resumeAfterReload()).toBe(true);
    await settle();
    expect(b.useJournal.getState().entries.map((e) => e.id)).toEqual([id]);
    // Deleted from the journal, it is not written again either.
    await b.useJournal.getState().remove(id);
    const c = await reload(b);
    expect(await c.store.resumeAfterReload()).toBe(true);
    await settle();
    expect(c.useJournal.getState().entries).toHaveLength(0);
  });

  it('undoes a journal entry whose trade the saved account never closed', async () => {
    const a = await page();
    expect(await a.store.startReplay(replay)).toBe(true);
    a.store.stepForward();
    const px = a.store.lastPrice('SPY')!;
    expect(a.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    a.store.stepForward();
    await settle();
    const id = a.store.useTrading.getState().session!.id;
    // The account as last saved, before the close below; where the clock was noted then too.
    const record = structuredClone(db.stores.get('kv')!.get(`session:${id}`));
    const position = localStorage.getItem(`stock-replay-session-position:${id}`)!;
    expect(a.store.closePosition('SPY').ok).toBe(true);
    await vi.waitFor(() => expect(a.useJournal.getState().entries).toHaveLength(1));
    await settle();
    // The page went before its save of the close landed.
    db.stores.get('kv')!.set(`session:${id}`, record);
    localStorage.setItem(`stock-replay-session-position:${id}`, position);
    expect(px).toBeGreaterThan(0);

    const b = await page();
    expect(await b.store.resumeAfterReload()).toBe(true);
    expect(b.store.useTrading.getState().positions).toHaveLength(1);
    expect(b.useJournal.getState().entries).toHaveLength(0);
  });

  it('keeps a blind replay blind and its challenge attempt under way', async () => {
    const a = await page();
    expect(await a.store.startReplay({ ...replay, blind: true, challengeId: 'rules-20' })).toBe(true);
    a.store.stepForward();
    const attempt = a.useChallenges.getState().active!;
    expect(attempt.challengeId).toBe('rules-20');

    const b = await reload(a);
    expect(await b.store.resumeAfterReload()).toBe(true);
    const s = b.store.useTrading.getState().session!;
    expect(s.blind).toBe(true);
    expect(s.label).not.toContain('2024');
    expect(b.useChallenges.getState().active?.id).toBe(attempt.id);
    expect(b.useToasts.getState().toasts.map((t) => t.text).join(' ')).not.toContain('2024');
  });

  it('is gone once ended, and starting another session leaves the tab nothing to carry on', async () => {
    const a = await page();
    expect(await a.store.startReplay(replay)).toBe(true);
    await a.store.endSession();
    const b = await reload(a);
    expect(await b.store.resumeAfterReload()).toBe(false);
    expect(await b.store.unfinishedSessions()).toEqual([]);
    expect([...(db.stores.get('kv')?.keys() ?? [])]).toEqual([]);
  });

  it('will not carry on with part of its undo history missing', async () => {
    const a = await page();
    expect(await a.store.startReplay(replay)).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    a.store.jumpTo(at('10:10'));
    expect(a.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 1 }).ok).toBe(true);
    await settle();
    const kv = db.stores.get('kv')!;
    kv.delete([...kv.keys()].find((k) => k.startsWith(`session-cp:${id}:`))!);
    const b = await reload(a);
    expect(await b.store.resumeAfterReload()).toBe(false);
    expect(b.store.useTrading.getState().error).toBe('This saved session could not be read.');
  });

  it('carries on one the previous version of the app saved, and keeps one a newer version saved without carrying it on', async () => {
    const a = await page();
    expect(await a.store.startReplay(replay)).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    for (const t of ['10:10', '10:20']) {
      a.store.jumpTo(at(t));
      expect(a.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 1 }).ok).toBe(true);
    }
    a.store.jumpTo(at('10:30'));
    const b = await reload(a);
    const kv = db.stores.get('kv')!;
    const record = kv.get(`session:${id}`) as { version: number; replay: { state: { checkpoints: string[] } } };
    // Its checkpoints' logs are stored apart, which the previous version (it reads version 1) could not rewind with.
    expect(record.version).toBe(2);

    // As the previous version saved it: version 1, each checkpoint with its whole log.
    const whole = (await b.saved.readSession(id))!.replay!.state.checkpoints;
    record.replay.state.checkpoints.forEach((key, i) => kv.set(key, { key, cp: whole[i] }));
    kv.set(`session:${id}`, { ...record, version: 1 });
    expect(await b.store.resumeAfterReload()).toBe(true);
    expect(b.store.useTrading.getState().positions[0].quantity).toBe(2);
    b.store.jumpTo(at('10:15'));
    await settle();
    expect(b.store.useTrading.getState().positions[0].quantity).toBe(1);
    b.store.restart();
    await settle();
    expect(b.store.useTrading.getState().positions).toHaveLength(0);

    // One a newer version saved is not read here, and stays to carry on there.
    const c = await reload(b);
    kv.set(`session:${id}`, { ...(kv.get(`session:${id}`) as object), version: 3 });
    expect(await c.store.resumeAfterReload()).toBe(false);
    expect(c.store.useTrading.getState().error).toBe('This saved session could not be read.');
    expect((await c.store.unfinishedSessions()).map((s) => s.id)).toEqual([id]);
    expect(kv.has(`session:${id}`)).toBe(true);
  });

  it('will not carry on over imported data that changed, and says so', async () => {
    const a = await page();
    const registry = await import('./dataRegistry');
    const bars = Array.from({ length: 120 }, (_, i) => ({ time: at('09:30') + i * 60, open: 10, high: 10.1, low: 9.9, close: 10, volume: 1000 }));
    await registry.saveCsvDataset({ symbol: 'ACME', name: 'ACME', baseTimeframe: '1m', importedAt: 1, fileName: 'a.csv', bars });
    expect(await a.store.startReplay({ ...replay, providerId: 'csv', symbol: 'ACME', startTime: '10:00', endTime: '11:00' })).toBe(true);
    a.store.stepForward();
    await settle();
    await registry.saveCsvDataset({ symbol: 'ACME', name: 'ACME', baseTimeframe: '1m', importedAt: 2, fileName: 'b.csv', bars: bars.map((b) => ({ ...b, close: 10.05 })) });

    const b = await reload(a);
    await (await import('./dataRegistry')).loadCsvDatasets();
    expect(await b.store.resumeAfterReload()).toBe(false);
    expect(b.store.useTrading.getState().error).toMatch(/The ACME data is not what this session was played on any more/);
    // Still kept, to discard.
    expect((await b.store.unfinishedSessions()).map((s) => s.meta.symbols)).toEqual([['ACME']]);
  });

  it('waits to hear whether the server keeps a vendor key before saying one is needed', async () => {
    const a = await page();
    polygonServesDemo(await import('./dataRegistry'));
    (await import('./credentials')).useCredentials.setState((c) => ({ creds: { ...c.creds, serverHasPolygonKey: true }, serverChecked: true }));
    expect(await a.store.startReplay({ ...replay, providerId: 'polygon' })).toBe(true);
    a.store.jumpTo(at('10:05'));

    const b = await reload(a);
    polygonServesDemo(await import('./dataRegistry'));
    // The server answers after the session is asked for, as a cold start does.
    const answer = { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ polygon: true, alpaca: false }) };
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/server-keys' ? new Promise((r) => setTimeout(() => r(answer), 300)) : Promise.reject(new Error('offline')))));
    // As the app opens: the check is asked for, and the session carried on without waiting for it.
    void (await import('./credentials')).useCredentials.getState().checkServer();
    expect(await b.store.resumeAfterReload()).toBe(true);
    expect(b.store.useTrading.getState().now).toBe(at('10:05'));
  });

  it('gives up waiting for a server that does not answer', async () => {
    const a = await page();
    polygonServesDemo(await import('./dataRegistry'));
    (await import('./credentials')).useCredentials.setState((c) => ({ creds: { ...c.creds, serverHasPolygonKey: true }, serverChecked: true }));
    expect(await a.store.startReplay({ ...replay, providerId: 'polygon' })).toBe(true);

    const b = await reload(a);
    polygonServesDemo(await import('./dataRegistry'));
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const resumed = b.store.resumeAfterReload();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await resumed).toBe(false);
    expect(b.store.useTrading.getState().error).toBe('Add a Polygon API key in Data & Settings. Then resume the session.');
  });

  it('trades under execution settings changed while it was away, from its next fill', async () => {
    const a = await page();
    a.useSettings.getState().updateExecution({ marketOrderFill: 'next_bar_open' });
    expect(await a.store.startReplay(replay)).toBe(true);
    a.store.jumpTo(at('10:05'));
    expect(a.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    // It fills at the open of the next bar to begin, after the last whole save: carrying on fills it
    // again, under the settings it had then.
    a.store.stepForward();
    a.store.stepForward();
    await settle();
    expect(a.store.useTrading.getState().fills.map((f) => f.commission)).toEqual([0]);

    const b = await page(); // a crash: no last save
    const settings = b.useSettings;
    settings.getState().updateExecution({ commission: { ...settings.getState().execution.commission, perOrder: 7 } });
    expect(await b.store.resumeAfterReload()).toBe(true);
    expect(b.store.useTrading.getState().fills.map((f) => f.commission)).toEqual([0]);
    expect(b.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    b.store.stepForward();
    b.store.stepForward();
    await settle();
    expect(b.store.useTrading.getState().fills.map((f) => f.commission)).toEqual([0, 7]);
  });
});

describe('the simulated market after a reload', () => {
  it('carries on with the same prices, account and clock, where Play had taken it', async () => {
    const a = await page();
    expect(await a.store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 60 })).toBe(true);
    const sym = a.store.useTrading.getState().activeSymbol;
    a.store.stepForward();
    expect(a.store.submitOrder({ symbol: sym, action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    for (let i = 0; i < 5; i++) a.store.stepForward();
    await settle();
    const before = a.store.useTrading.getState();
    const history = a.store.getBaseBars(sym);

    const b = await page();
    expect(await b.store.resumeAfterReload()).toBe(true);
    const after = b.store.useTrading.getState();
    expect(after.now).toBe(before.now);
    expect(after.positions).toEqual(before.positions);
    expect(after.account).toEqual(before.account);
    expect(b.store.getBaseBars(sym)).toEqual(history);
    // And goes on.
    b.store.stepForward();
    expect(b.store.useTrading.getState().now).toBe(before.now + 60);
  });

  it('trades under execution settings changed while it was away', async () => {
    const a = await page();
    expect(await a.store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 60 })).toBe(true);
    a.store.stepForward();
    const b = await reload(a);
    const settings = b.useSettings;
    settings.getState().updateExecution({ commission: { ...settings.getState().execution.commission, perOrder: 7 } });
    expect(await b.store.resumeAfterReload()).toBe(true);
    const sym = b.store.useTrading.getState().activeSymbol;
    expect(b.store.submitOrder({ symbol: sym, action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    b.store.stepForward();
    await settle();
    expect(b.store.useTrading.getState().fills.map((f) => f.commission)).toEqual([7]);
  });
});

describe('unfinished sessions and other tabs', () => {
  it('offers a session left by a closed tab, but not one another tab is running', async () => {
    const a = await page();
    expect(await a.store.startReplay(replay)).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    await settle();
    // The same session in a tab duplicated from this one: the first still runs it.
    sessionStorage.setItem('stock-replay-tab-session', id);
    vi.resetModules();
    locks.elsewhere = new Set(locks.mine);
    locks.mine.clear();
    const dup = await import('./tradingStore');
    expect(await dup.resumeAfterReload()).toBe(false);
    expect(sessionStorage.getItem('stock-replay-tab-session')).toBeNull();
    expect(await dup.unfinishedSessions()).toEqual([]);
    expect(await dup.resumeSession(id)).toBe(false);
    expect(dup.useTrading.getState().error).toMatch(/open in another tab/);
    // That tab closes: its session is offered here.
    locks.elsewhere.clear();
    const offered = await dup.unfinishedSessions();
    expect(offered.map((s) => s.id)).toEqual([id]);
    expect(offered[0]).toMatchObject({ closedTrades: 0, openPositions: 0, finished: false });
    expect(await dup.resumeSession(id)).toBe(true);
  });

  it('discards a session: its trades stay, its challenge attempt goes to the history as abandoned', async () => {
    const a = await page();
    expect(await a.store.startReplay({ ...replay, challengeId: 'rules-20' })).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    rememberNothing(); // the tab closed
    const b = await page();
    expect((await b.store.unfinishedSessions()).map((s) => s.id)).toEqual([id]);
    expect(await b.store.discardSession(id)).toBe(true);
    expect(await b.store.unfinishedSessions()).toEqual([]);
    const attempts = b.useChallenges.getState().attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ sessionId: id, result: { status: 'in_progress' } });
    expect(attempts[0].endedAt).toBeGreaterThan(0);
  });

  it('says a challenge attempt goes as abandoned only while one is under way', async () => {
    const a = await page();
    // A trade closed without a stop loss fails this challenge at once: its attempt is over.
    expect(await a.store.startReplay({ ...replay, challengeId: 'grow-20-1pct' })).toBe(true);
    const over = a.store.useTrading.getState().session!.id;
    a.store.stepForward();
    expect(a.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    expect(a.store.closePosition('SPY').ok).toBe(true);
    await vi.waitFor(() => expect(a.useChallenges.getState().attempts.map((x) => x.result.status)).toEqual(['failed']));
    await settle();
    rememberNothing();
    const b = await page();
    expect(await b.store.startReplay({ ...replay, challengeId: 'rules-20' })).toBe(true);
    await settle();
    rememberNothing();

    const c = await page();
    expect((await c.store.unfinishedSessions()).map((s) => [s.id === over, s.challengeUnderWay])).toEqual([
      [false, true],
      [true, false],
    ]);
    const { UnfinishedSessions } = await import('../components/UnfinishedSessions');
    const asked: string[] = [];
    vi.spyOn(window, 'confirm').mockImplementation((m) => (asked.push(String(m)), false));
    const discardAll = (el: HTMLElement) => act(() => [...el.querySelectorAll('button')].filter((x) => x.textContent === 'Discard').forEach((x) => x.click()));
    let list = render(createElement(UnfinishedSessions));
    await vi.waitFor(() => expect(list.el.querySelectorAll('li')).toHaveLength(2));
    const [underWay, ended] = [...list.el.querySelectorAll('li')].map((li) => li.textContent);
    expect(underWay).toContain(`Challenge: ${CHALLENGES.find((x) => x.id === 'rules-20')!.title}`);
    expect(ended).not.toContain('Challenge:');
    discardAll(list.el);
    expect(asked).toEqual([
      'Discard this session? Its closed trades stay in your journal. Its challenge attempt is kept as abandoned.',
      'Discard this session? Its closed trades stay in your journal.',
    ]);
    list.unmount();

    // Saved before this was noted, a session says what it said before: the challenge it started with.
    const kv = db.stores.get('kv')!;
    const { challengeUnderWay, ...summary } = kv.get(`session-summary:${over}`) as Record<string, unknown>;
    expect(challengeUnderWay).toBe(false);
    kv.set(`session-summary:${over}`, summary);
    list = render(createElement(UnfinishedSessions));
    await vi.waitFor(() => expect(list.el.querySelectorAll('li')).toHaveLength(2));
    expect(list.el.querySelectorAll('li')[1].textContent).toContain(`Challenge: ${CHALLENGES.find((x) => x.id === 'grow-20-1pct')!.title}`);
    list.unmount();
  });

  it('keeps only the latest few', async () => {
    let p = await page();
    const { MAX_SAVED_SESSIONS } = p.saved;
    const ids: string[] = [];
    for (let i = 0; i < MAX_SAVED_SESSIONS + 2; i++) {
      expect(await p.store.startReplay(replay)).toBe(true);
      ids.push(p.store.useTrading.getState().session!.id);
      await settle();
      // Each left by its tab closing, not ended: a new tab starts the next.
      rememberNothing();
      p = await page();
    }
    expect((await p.store.unfinishedSessions()).map((s) => s.id)).toEqual(ids.slice(-MAX_SAVED_SESSIONS).reverse());
  });

  // IndexedDB runs its transactions one after another, each taking a moment, so the session that just
  // ended is still stored while the next one starts: it is not one of the few kept.
  it.each([
    ['a position open', 'position'],
    ['Play on', 'playing'],
    ['a position open and the simulated market starts', 'sim'],
  ] as const)('keeps the latest few when the session that ends had %s', async (_, how) => {
    db.commitMs = 3;
    let p = await page();
    const { MAX_SAVED_SESSIONS } = p.saved;
    const older: string[] = [];
    for (let i = 0; i < MAX_SAVED_SESSIONS - 1; i++) {
      expect(await p.store.startReplay(replay)).toBe(true);
      older.push(p.store.useTrading.getState().session!.id);
      await drained();
      rememberNothing();
      p = await page();
    }
    expect(await p.store.startReplay(replay)).toBe(true);
    await drained();
    if (how === 'playing') p.store.play();
    else {
      p.store.stepForward();
      expect(p.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    }
    expect(await (how === 'sim' ? p.store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 60 }) : p.store.startReplay(replay))).toBe(true);
    await drained();
    expect((await p.store.unfinishedSessions()).map((s) => s.id)).toEqual([...older].reverse());
  });

  it('keeps the latest few when one is carried on while the session that ends has a position open', async () => {
    db.commitMs = 3;
    let p = await page();
    const { MAX_SAVED_SESSIONS } = p.saved;
    const older: string[] = [];
    for (let i = 0; i < MAX_SAVED_SESSIONS - 1; i++) {
      expect(await p.store.startReplay(replay)).toBe(true);
      older.push(p.store.useTrading.getState().session!.id);
      await drained();
      rememberNothing();
      p = await page();
    }
    // One more runs in another tab while this tab starts its own...
    expect(await p.store.startReplay(replay)).toBe(true);
    const other = p.store.useTrading.getState().session!.id;
    await drained();
    rememberNothing();
    p = await page();
    locks.elsewhere = new Set([`stock-replay-session:${other}`]);
    expect(await p.store.startReplay(replay)).toBe(true);
    await drained();
    p.store.stepForward();
    expect(p.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    // ...and that tab closes, leaving five to offer: this tab carries its session on.
    locks.elsewhere.clear();
    expect((await p.store.unfinishedSessions()).map((s) => s.id)).toEqual([other, ...[...older].reverse()]);
    expect(await p.store.resumeSession(other)).toBe(true);
    await drained();
    expect((await p.store.unfinishedSessions()).map((s) => s.id)).toEqual([...older].reverse());
    expect(p.store.useTrading.getState().session!.id).toBe(other);
  });

  /**
   * This tab's card of unfinished sessions (the sessions it names), and the chart of SPY with no session beside
   * it, which a replay of SPY you have not finished, or one in another tab, keeps from being drawn.
   */
  async function besideTheCard(p: Awaited<ReturnType<typeof page>>) {
    const { UnfinishedSessions } = await import('../components/UnfinishedSessions');
    const card = render(createElement(UnfinishedSessions));
    p.store.setActiveSymbol('SPY');
    // As the chart asks for its bars.
    p.store.getBaseBars('SPY');
    return { listed: () => [...card.el.querySelectorAll('li strong')].map((e) => e.textContent), unmount: card.unmount };
  }
  /** Another tab's save or deletion of a session, as the browser tells this one. */
  const told = () => window.dispatchEvent(new StorageEvent('storage', { key: 'stock-replay-sessions-changed' }));
  const yours = /^Your SPY replay of 2024-03-12 is unfinished/;
  const elsewhere = /^A SPY replay is running in another tab/;

  it('offers a replay another tab started after this one opened once that tab closes, as the note on its chart says it is yours to resume', async () => {
    const b = await page();
    const card = await besideTheCard(b);
    await settle();
    expect(card.listed()).toEqual([]);
    // Another tab starts a replay of SPY: its save tells this one, which no longer charts SPY.
    const a = await page();
    expect(await a.store.startReplay(replay)).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    await settle();
    told();
    await vi.waitFor(() => expect(b.store.browseHiddenReason()).toMatch(elsewhere), { timeout: 3000 });
    await settle();
    expect(card.listed()).toEqual([]);
    // It closes without ending it: its lock goes with it, and its last save tells this tab.
    a.store.pause();
    await settle();
    locks.mine.delete(`stock-replay-session:${id}`);
    told();
    await vi.waitFor(() => expect(b.store.browseHiddenReason()).toMatch(yours), { timeout: 3000 });
    await vi.waitFor(() => expect(card.listed()).toEqual(['SPY · 2024-03-12']));
    card.unmount();
  });

  it('no longer offers a replay left unfinished once another tab carries it on, as the note on its chart says that tab runs it', async () => {
    const a = await page();
    expect(await a.store.startReplay(replay)).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    await settle();
    a.store.pause();
    await settle();
    rememberNothing();
    // A tab opened after that one closed offers it.
    const b = await page();
    const card = await besideTheCard(b);
    await vi.waitFor(() => expect(card.listed()).toEqual(['SPY · 2024-03-12']));
    await vi.waitFor(() => expect(b.store.browseHiddenReason()).toMatch(yours));
    // Another tab carries it on: its save tells this one.
    const c = await page();
    expect(await c.store.resumeSession(id)).toBe(true);
    await settle();
    told();
    await vi.waitFor(() => expect(b.store.browseHiddenReason()).toMatch(elsewhere), { timeout: 3000 });
    await vi.waitFor(() => expect(card.listed()).toEqual([]));
    card.unmount();
  });

  it('sends focus on to Play once a session resumed from the keyboard is in, never to the page, and leaves focus put elsewhere meanwhile', async () => {
    // Two replays and the simulated market, each left by a tab that closed.
    const leave = async (start: (store: Awaited<ReturnType<typeof page>>['store']) => Promise<boolean>) => {
      const a = await page();
      expect(await start(a.store)).toBe(true);
      await settle();
      a.store.pause();
      await settle();
      rememberNothing();
      return a.store.useTrading.getState().session!.id;
    };
    const replayId = await leave((store) => store.startReplay(replay));
    const otherId = await leave((store) => store.startReplay({ ...replay, symbol: 'QQQ' }));
    const simId = await leave((store) => store.startSim({ config: { seed: 4 }, startingBalance: 25_000, speed: 1 }));
    const b = await page();
    // Laid out, as the browser does (Play is focused only when it is on screen).
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
      return (this.closest('[hidden]') ? [] : [new DOMRect(0, 0, 10, 10)]) as unknown as DOMRectList;
    });
    const { ChartPanel } = await import('../components/ChartPanel');
    const panel = render(createElement(ChartPanel, { onNewSession: () => undefined }));
    const resume = (sym: string) => [...panel.el.querySelectorAll<HTMLElement>('.unfinished-list li')].find((li) => li.querySelector('strong')!.textContent!.startsWith(sym))?.querySelector<HTMLButtonElement>('.btn.primary');
    const play = () => panel.el.querySelector<HTMLButtonElement>('.replay-bar [data-home="play"]');
    /** Resume on the row of `sym`, reached with the keyboard: focused, then pressed (Enter clicks it). */
    const press = async (sym: string) => {
      await vi.waitFor(() => expect(resume(sym)).toBeTruthy());
      act(() => resume(sym)!.focus());
      await act(async () => resume(sym)!.click());
    };
    await press('SPY');
    await vi.waitFor(() => expect(b.store.useTrading.getState().session?.id).toBe(replayId));
    await act(async () => undefined);
    expect(play()!.textContent).toContain('Play');
    expect(document.activeElement).toBe(play());
    await act(async () => void (await b.store.endSession()));

    // The simulated market: its Start market.
    await press('Simulated market');
    await vi.waitFor(() => expect(b.store.useTrading.getState().session?.id).toBe(simId));
    await act(async () => undefined);
    expect(play()!.textContent).toContain('Start market');
    expect(document.activeElement).toBe(play());
    await act(async () => void (await b.store.endSession()));

    // Focus put on the ticker button while it loads stays there.
    await press('QQQ');
    const symbol = panel.el.querySelector<HTMLElement>('.chart-toolbar .sym-btn')!;
    act(() => symbol.focus());
    await vi.waitFor(() => expect(b.store.useTrading.getState().session?.id).toBe(otherId));
    await act(async () => undefined);
    expect(play()).not.toBeNull();
    expect(document.activeElement).toBe(symbol);
    await act(async () => void (await b.store.endSession()));
    panel.unmount();
  });
});

describe('the Trade screen as a reload carries its session on', () => {
  /** Apps still open when a test ends (one that failed did not close its own). */
  const open = new Set<() => void>();
  /** What lets go of reads held (`readHeld`): all of them once the test ends. */
  const holds: (() => void)[] = [];
  /** Holds every read of `store` started from now until what this returns is called. */
  function hold(store: string): () => void {
    let release!: () => void;
    db.readHeld[store] = new Promise((r) => (release = r));
    holds.push(release);
    return release;
  }
  afterEach(async () => {
    open.forEach((close) => close());
    holds.splice(0).forEach((release) => release());
    // An app closed while its journal and imported data were still loading carries on its tab's session
    // once they are in: within its own test, not in the middle of the next one (whose tab it is not).
    while (db.reading.size) {
      await Promise.allSettled([...db.reading]);
      await settle();
    }
  });

  /**
   * What the Trade screen shows over the chart in place of a session: that it is picking one up or loading
   * one (.chart-empty), or, with none, the notes over the chart of the symbol (.browse-notes: how to start
   * a replay, and the sessions left unfinished).
   */
  const SCREEN = '.chart-empty, .browse-notes';

  /**
   * Opens the app in this tab again, its storage slow (a large journal or imported data takes a while to
   * read), as a reload does. `offered` gets each list of unfinished sessions the screen shows, with whether
   * `shownWith` was on the screen too at that moment; `screens`, each text the Trade screen shows in place
   * of a session, in turn.
   */
  async function openApp(shownWith = '') {
    db.readMs = { kv: 5, journal: 5, challenges: 5, datasets: 300 };
    vi.resetModules();
    locks.mine.clear();
    const store = await import('./tradingStore');
    const { App } = await import('../App');
    const offered: { text: string; withIt: boolean }[] = [];
    const screens: string[] = [];
    const seen = new MutationObserver((changes) => {
      const now = document.querySelector(SCREEN)?.textContent ?? '';
      if (now !== screens[screens.length - 1]) screens.push(now);
      for (const c of changes)
        for (const n of c.addedNodes) {
          const list = n instanceof Element && (n.closest('.unfinished-list') ?? n.querySelector('.unfinished-list'));
          if (list) offered.push({ text: list.textContent ?? '', withIt: !!shownWith && document.body.textContent!.includes(shownWith) });
        }
    });
    seen.observe(document.body, { childList: true, characterData: true, subtree: true });
    const app = render(createElement(App));
    // From here React schedules its own updates, as in the browser: the app's loads finish outside act.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    const screen = () => app.el.querySelector(SCREEN)?.textContent ?? '';
    // The screen that starts a session with none running, whole: the notes over the chart, and why it is not drawn when it is not.
    const start = () => [...app.el.querySelectorAll('.browse-notes, .browse-empty')].map((e) => e.textContent ?? '').join(' ');
    const close = () => {
      if (!open.delete(close)) return;
      seen.disconnect();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      app.unmount();
    };
    open.add(close);
    return { store, offered, screens, screen, start, close };
  }

  /** A replay with a position open, its clock at `hhmm`, saved as a reload leaves it; its id. */
  async function leaveRunning(hhmm = '10:30') {
    const a = await page();
    expect(await a.store.startReplay(replay)).toBe(true);
    a.store.jumpTo(at(hhmm));
    expect(a.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    await settle();
    a.store.pause();
    await settle();
    return a.store.useTrading.getState().session!.id;
  }

  it('never offers that session to resume or discard, however long the journal and imported data take to load', async () => {
    const id = await leaveRunning();
    const app = await openApp();
    const first = app.screen();
    expect(await app.store.unfinishedSessions()).toEqual([]);
    await vi.waitFor(() => expect(app.store.useTrading.getState().session?.id).toBe(id), { timeout: 5000 });
    await settle();
    expect(app.offered).toEqual([]);
    expect(first).toContain('Picking up where you left off');
    app.close();
  }, 20_000);

  it('offers it once it is not carried on: when it cannot be read, or once the other tab running it lets it go', async () => {
    const id = await leaveRunning();
    // Part of its undo history is gone: it cannot be carried on, and is offered with the reason.
    const kv = db.stores.get('kv')!;
    kv.delete([...kv.keys()].find((k) => k.startsWith(`session-cp:${id}:`))!);
    let app = await openApp('This saved session could not be read.');
    await vi.waitFor(() => expect(app.offered.some((o) => o.withIt)).toBe(true), { timeout: 5000 });
    // Not before then: until it had tried, the reload was carrying it on.
    expect(app.offered.every((o) => o.withIt)).toBe(true);
    expect(app.offered[0].text).toContain('SPY · 2024-03-12');
    expect(app.store.useTrading.getState().session).toBeNull();
    app.close();

    // Running in another tab (this one was duplicated from it): not offered here until that tab lets it go,
    // the start screen saying why SPY is not charted meanwhile (for the one left unfinished above).
    const other = await leaveRunning('11:00');
    locks.elsewhere = new Set([`stock-replay-session:${other}`]);
    app = await openApp();
    await vi.waitFor(() => expect(app.start()).toContain('Your SPY replay of 2024-03-12 is unfinished'), { timeout: 5000 });
    await settle();
    expect(app.offered.map((o) => o.text).join()).not.toContain('11:00 ET');
    locks.elsewhere.clear();
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(app.offered.map((o) => o.text).join()).toContain('11:00 ET'), { timeout: 5000 });
    expect(app.store.useTrading.getState().session).toBeNull();
    app.close();
  }, 20_000);

  it('lists it as soon as the reload finds it cannot carry it on, and not before', async () => {
    const id = await leaveRunning();
    const kv = db.stores.get('kv')!;
    kv.delete([...kv.keys()].find((k) => k.startsWith(`session-cp:${id}:`))!);
    const b = await page();
    const { UnfinishedSessions } = await import('../components/UnfinishedSessions');
    const list = render(createElement(UnfinishedSessions));
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(list.el.querySelectorAll('li')).toHaveLength(0);
    expect(await b.store.resumeAfterReload()).toBe(false);
    await vi.waitFor(() => expect(list.el.querySelectorAll('li')).toHaveLength(1));
    expect((await b.store.unfinishedSessions()).map((s) => s.id)).toEqual([id]);
    list.unmount();
  });

  it('offers a session left by a closed tab at once, with nothing of its own to carry on', async () => {
    const id = await leaveRunning();
    rememberNothing();
    const app = await openApp();
    expect(app.screen()).not.toContain('Picking up where you left off');
    await vi.waitFor(() => expect(app.offered).toHaveLength(1), { timeout: 5000 });
    // Offered on the screen that starts a session, which never said it was picking one up (SPY not charted
    // there while it is unfinished).
    expect(app.start()).toContain('Your SPY replay of 2024-03-12 is unfinished');
    expect(app.offered[0].text).toContain('SPY · 2024-03-12');
    expect(app.store.useTrading.getState().session).toBeNull();
    expect((await app.store.unfinishedSessions()).map((s) => s.id)).toEqual([id]);
    app.close();
  }, 20_000);

  it('never says a session another tab runs comes back, in a tab duplicated from that one', async () => {
    const id = await leaveRunning();
    // The tab running it was duplicated: the copy remembers the session too, but the other tab holds it.
    locks.elsewhere = new Set([`stock-replay-session:${id}`]);
    const app = await openApp();
    await vi.waitFor(() => expect(app.start()).toContain('A SPY replay is running in another tab, and charting SPY here'), { timeout: 5000 });
    await settle();
    const waiting = app.screens.filter((s) => s.includes('Picking up where you left off'));
    expect(waiting.length).toBeGreaterThan(0);
    // Until it knows, it says the session comes back only if it can be carried on.
    for (const s of waiting) expect(s).toContain('If the session this tab was running can be carried on');
    expect(app.store.useTrading.getState().session).toBeNull();
    expect(sessionStorage.getItem('stock-replay-tab-session')).toBeNull();
    app.close();
  }, 20_000);

  it.each([
    [
      'discarded',
      async (p: Awaited<ReturnType<typeof page>>, id: string) => {
        expect(await p.store.discardSession(id)).toBe(true);
      },
    ],
    [
      'ended',
      async (p: Awaited<ReturnType<typeof page>>, id: string) => {
        expect(await p.store.resumeSession(id)).toBe(true);
        await p.store.endSession();
        await settle();
      },
    ],
  ] as const)('shows the start screen at once when the session the tab remembers was %s meanwhile, without waiting for the journal and imported data', async (_, letGo) => {
    const id = await leaveRunning();
    // This tab was closed, another one let the session go, and this one was opened again (a closed
    // tab reopened, or a copy of it), remembering it still.
    rememberNothing();
    await letGo(await page(), id);
    expect(await (await page()).store.unfinishedSessions()).toEqual([]);
    sessionStorage.setItem('stock-replay-tab-session', id);
    const loaded = hold('datasets');
    const app = await openApp();
    await vi.waitFor(() => expect(app.screen()).toContain('Press Replay, then click the bar to start from.'), { timeout: 5000 });
    expect(sessionStorage.getItem('stock-replay-tab-session')).toBeNull();
    // Only as the app first drew, before it had read which sessions are kept.
    expect(app.screens.slice(1).filter((s) => s.includes('Picking up where you left off'))).toEqual([]);
    loaded();
    await settle();
    expect(app.screen()).toContain('Press Replay, then click the bar to start from.');
    expect(app.screens.slice(1).filter((s) => s.includes('Picking up where you left off'))).toEqual([]);
    expect(app.store.useTrading.getState().session).toBeNull();
    app.close();
  }, 20_000);

  it('still carries it on when the page before lets go of it only a moment after this one opens', async () => {
    const id = await leaveRunning();
    locks.elsewhere = new Set([`stock-replay-session:${id}`]);
    const loaded = hold('datasets');
    const app = await openApp();
    // Every read but the held one done: the app has read which sessions are kept, and still waits.
    await vi.waitFor(() => expect(db.reading.size).toBe(1));
    await settle();
    expect(app.screen()).toContain('Picking up where you left off');
    locks.elsewhere.clear();
    loaded();
    await vi.waitFor(() => expect(app.store.useTrading.getState().session?.id).toBe(id), { timeout: 5000 });
    expect(app.offered).toEqual([]);
    expect(app.screens.filter((s) => s.includes('Press Replay, then click the bar to start from.'))).toEqual([]);
    app.close();
  }, 20_000);

  const acme = { symbol: 'ACME', name: 'ACME', baseTimeframe: '1m' as const, importedAt: 1, fileName: 'a.csv', bars: Array.from({ length: 120 }, (_, i) => ({ time: at('09:30') + i * 60, open: 10, high: 10.1, low: 9.9, close: 10, volume: 1000 })) };
  const acmeReplay = { ...replay, providerId: 'csv', symbol: 'ACME', startTime: '10:00', endTime: '11:00' };

  /** A replay of imported data, left by a tab that closed: its id. */
  async function leaveImported() {
    const a = await page();
    await (await import('./dataRegistry')).saveCsvDataset(acme);
    expect(await a.store.startReplay(acmeReplay)).toBe(true);
    a.store.stepForward();
    await settle();
    a.store.pause();
    await settle();
    rememberNothing();
    return a.store.useTrading.getState().session!.id;
  }

  /** The Resume button of the session the Trade screen offers, once it is there. */
  const resumeButton = () =>
    vi.waitFor(
      () => {
        const b = [...document.querySelectorAll<HTMLButtonElement>('.unfinished-list button')].find((x) => x.textContent === 'Resume');
        expect(b).toBeDefined();
        return b!;
      },
      { timeout: 5000 },
    );

  it.each([
    ['in a new tab', null],
    // The start screen shows as soon as the app has read that the session this tab remembers is gone.
    ['in a tab whose own session has ended', 'replay_gone'],
  ] as const)('resumes a replay of imported data pressed before that data has loaded, %s, once it has', async (_, remembered) => {
    const id = await leaveImported();
    if (remembered) sessionStorage.setItem('stock-replay-tab-session', remembered);
    const loaded = hold('datasets');
    const app = await openApp();
    (await resumeButton()).click();
    await vi.waitFor(() => expect(app.screen()).toContain('Loading market data'), { timeout: 5000 });
    await settle();
    expect(app.screen()).toContain('Loading market data');
    loaded();
    await vi.waitFor(() => expect(app.store.useTrading.getState().session?.id).toBe(id), { timeout: 5000 });
    expect(app.store.useTrading.getState().error).toBeNull();
    expect(app.screens.join(' ')).not.toContain('No CSV data');
    app.close();
  }, 20_000);

  it('says there is no imported data, and waits no longer, when reading it fails', async () => {
    await leaveImported();
    const loaded = hold('datasets');
    const app = await openApp();
    (await resumeButton()).click();
    // Storage gives an error instead of the data.
    db.stores.set('datasets', {
      values: () => {
        throw new Error('The storage is broken');
      },
    } as never);
    loaded();
    await vi.waitFor(() => expect(app.store.useTrading.getState().error).toBe('No CSV data imported yet. Import a file in Data & Settings. Then resume the session.'), { timeout: 5000 });
    expect(app.store.useTrading.getState()).toMatchObject({ session: null, loading: false });
    await vi.waitFor(() => expect(app.screen()).toContain('ACME · 2024-03-12'), { timeout: 5000 });
    app.close();
  }, 20_000);

  it('starts a replay of imported data asked for before that data has loaded, once it has', async () => {
    await (await import('./dataRegistry')).saveCsvDataset(acme);
    const loaded = hold('datasets');
    const app = await openApp();
    const started = app.store.startReplay(acmeReplay);
    await settle();
    expect(app.store.useTrading.getState().error).toBeNull();
    loaded();
    expect(await started).toBe(true);
    expect(app.store.useTrading.getState().session?.symbols).toEqual(['ACME']);
    app.close();
  }, 20_000);

  it('says in the new replay form that imported data is still loading, then starts on it once it has', async () => {
    await (await import('./dataRegistry')).saveCsvDataset(acme);
    (await import('./settingsStore')).useSettings.getState().updateReplay({ providerId: 'csv', symbol: 'ACME', date: '2024-03-12', startTime: '10:00', endTime: '11:00', multiDay: false, blind: false, timeframe: '1m', includeWatchlist: false });
    const loaded = hold('datasets');
    const app = await openApp();
    await vi.waitFor(() => expect(app.screen()).toContain('Press Replay, then click the bar to start from.'), { timeout: 5000 });
    // The full form is in the Replay button's menu.
    document.querySelector<HTMLButtonElement>('button[aria-label="More ways to start a replay"]')!.click();
    await vi.waitFor(() => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === 'Advanced replay setup…')!.click());
    const warning = () => document.querySelector('.modal .alert.warn, [role="dialog"] .alert.warn')?.textContent ?? null;
    await vi.waitFor(() => expect(warning()).toBe('Your imported data is still loading.'), { timeout: 5000 });
    expect(document.body.textContent).not.toContain('No CSV data');
    loaded();
    await vi.waitFor(() => expect(warning()).toBeNull(), { timeout: 5000 });
    // The form reads the tickers again once the data is in, in a moment of its own.
    await vi.waitFor(() => expect(document.querySelector('#setup-symbols option')?.getAttribute('value')).toBe('ACME'), { timeout: 5000 });
    await vi.waitFor(() => expect(document.body.textContent).toContain('Available data: 2024-03-12 to 2024-03-12'), { timeout: 5000 });
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Start replay')!.click();
    await vi.waitFor(() => expect(app.store.useTrading.getState().session?.symbols).toEqual(['ACME']), { timeout: 5000 });
    app.close();
  }, 20_000);

  it('has nothing to pick up on the next reload once a session it could not carry on is discarded in it', async () => {
    const id = await leaveRunning();
    const kv = db.stores.get('kv')!;
    kv.delete([...kv.keys()].find((k) => k.startsWith(`session-cp:${id}:`))!);
    const b = await page();
    expect(await b.store.resumeAfterReload()).toBe(false);
    expect(await b.store.discardSession(id)).toBe(true);
    expect(sessionStorage.getItem('stock-replay-tab-session')).toBeNull();
    const app = await openApp();
    expect(app.screen()).not.toContain('Picking up where you left off');
    await vi.waitFor(() => expect(app.screen()).toContain('Press Replay, then click the bar to start from.'), { timeout: 5000 });
    app.close();
  }, 20_000);
});

describe('a session as saved when its replay or its challenge attempt ends', () => {
  const kv = () => db.stores.get('kv')!;
  const summary = (id: string) => kv().get(`session-summary:${id}`) as import('../services/savedSessions').SessionSummary;
  const attempt = (id: string) => (kv().get(`session:${id}`) as { challenge: unknown }).challenge;
  const saves = (id: string) => db.written.filter((k) => k === `session-summary:${id}`).length;

  it('is saved with its attempt over once Play reaches the end', async () => {
    const a = await page();
    expect(await a.store.startReplay({ ...replay, endTime: '10:03', speed: 23_400, challengeId: 'day-max-dd-5' })).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    a.store.play();
    await vi.waitFor(() => expect(a.useChallenges.getState().attempts.map((x) => x.result.status)).toEqual(['failed']));
    await settle();
    // A tab that dies now, with no other save, leaves it saved as it ended.
    expect(summary(id)).toMatchObject({ finished: true, challengeUnderWay: false });
    expect(attempt(id)).toBeNull();
  });

  it('is saved once a step reaches the end, and not on every step', async () => {
    const a = await page();
    expect(await a.store.startReplay({ ...replay, endTime: '10:03', challengeId: 'day-max-dd-5' })).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    await settle();
    const before = saves(id);
    a.store.stepForward();
    await settle();
    expect(saves(id)).toBe(before);
    for (let i = 0; i < 4; i++) a.store.stepForward();
    await settle();
    expect(a.store.useTrading.getState().finished).toBe(true);
    expect(summary(id)).toMatchObject({ finished: true, challengeUnderWay: false });
    expect(attempt(id)).toBeNull();
    expect(saves(id)).toBe(before + 1);
    a.store.stepForward();
    a.store.stepCandle();
    await settle();
    expect(saves(id)).toBe(before + 1);
  });

  it('is saved once its attempt fails between saves, mid-session', async () => {
    const a = await page();
    const { execution } = a.useSettings.getState();
    a.useSettings.getState().updateExecution({ marketOrderFill: 'next_bar_open', commission: { ...execution.commission, perOrder: 1_500 } });
    expect(await a.store.startReplay({ ...replay, challengeId: 'day-max-dd-5' })).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    // It fills at the next bar's open, where its commission takes equity more than 5% below the start.
    expect(a.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 1 }).ok).toBe(true);
    await settle();
    expect(summary(id).challengeUnderWay).toBe(true);
    a.store.stepForward();
    a.store.stepForward();
    await vi.waitFor(() => expect(a.useChallenges.getState().attempts.map((x) => x.result.status)).toEqual(['failed']));
    await settle();
    expect(a.store.useTrading.getState().positions).toHaveLength(1);
    expect(summary(id)).toMatchObject({ finished: false, challengeUnderWay: false });
    expect(attempt(id)).toBeNull();
  });

  it('is saved once your own rule, marked broken on a trade, fails its attempt', async () => {
    const a = await page();
    a.useSettings.getState().updateRules({ minRewardRisk: 0, custom: ['Wait for a pullback'] });
    expect(await a.store.startReplay({ ...replay, challengeId: 'rules-20' })).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    a.store.stepForward();
    const px = a.store.lastPrice('SPY')!;
    expect(a.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 1, stopLoss: Math.round(px - 1) }).ok).toBe(true);
    a.store.stepForward();
    expect(a.store.closePosition('SPY').ok).toBe(true);
    await vi.waitFor(() => expect(a.useJournal.getState().entries).toHaveLength(1));
    await settle();
    expect(summary(id).challengeUnderWay).toBe(true);
    await a.useJournal.getState().updateRuleCheck(a.useJournal.getState().entries[0].id, 'Wait for a pullback', false);
    expect(a.useChallenges.getState().attempts.map((x) => x.result.status)).toEqual(['failed']);
    await settle();
    expect(summary(id).challengeUnderWay).toBe(false);
    expect(attempt(id)).toBeNull();
  });
});

describe('a replay’s undo history in storage', () => {
  it('stores the log about once, not once per checkpoint, and reads every checkpoint back as it was', async () => {
    const { ReplaySession } = await import('../../core/replay/ReplaySession');
    const { DemoDataProvider } = await import('../../core/data/demoProvider');
    const { ZERO_COST_CONFIG } = await import('../../core/broker/config');
    const p = new DemoDataProvider(new Date('2026-10-08T12:00:00Z'));
    const day = (date: string, hhmm: string) => exchangeTimeToUnix(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
    const symbols = ['SPY', 'AAPL', 'MSFT', 'QQQ'];
    const setup = { symbol: 'SPY', extraSymbols: symbols.slice(1), date: '2024-03-12', endDate: '2024-03-26', startTime: '04:00', endTime: '20:00', startingBalance: 1_000_000, lookbackDays: 1 };
    const id = 'long';
    /** The page's savedSessions module after a reload. */
    const fresh = async () => {
      vi.resetModules();
      return import('../services/savedSessions');
    };
    let saved = await fresh();
    /** The session as the trading store saves it. */
    const record = (r: import('../../core/replay/ReplaySession').ReplaySession): import('../services/savedSessions').SavedSession => ({
      version: saved.SAVED_SESSION_VERSION,
      summary: { id, savedAt: 0, now: r.now } as import('../services/savedSessions').SessionSummary,
      view: { activeSymbol: 'SPY', timeframe: '1m', speed: 60 },
      warnings: [],
      replay: { providerId: 'demo', state: r.save() },
      journaledTrips: [],
      watching: [],
      challenge: null,
    });
    const { session: a } = await ReplaySession.load(p, setup, ZERO_COST_CONFIG, id);
    a.jumpTo(day('2024-03-12', '09:40'));
    // A full log: orders placed and cancelled, all at one moment (each checkpoint takes the last one's place).
    for (let i = 0; i < 260; i++) a.cancel(a.submit({ symbol: 'SPY', action: 'buy', type: 'limit', limitPrice: 1, quantity: 1, tif: 'gtc' }).order!.id);
    // And trades along the way, which add to it (and drop its oldest lines) during the jump.
    for (const symbol of symbols) {
      const px = a.broker.markPrice(symbol)!;
      for (const k of [1, 2, 3, 4, 5]) {
        a.submit({ symbol, action: 'buy', type: 'limit', limitPrice: Math.round(px * (1 - k / 100) * 100) / 100, quantity: 10, tif: 'gtc', stopLoss: Math.round(px * (0.98 - k / 100) * 100) / 100, takeProfit: Math.round(px * (1 + k / 100) * 100) / 100 });
      }
    }
    expect(a.broker.state.events).toHaveLength(500);
    const first = a.broker.state.events[0];
    await saved.writeSession(record(a));
    a.jumpTo(day('2024-03-25', '12:00'));
    expect(a.broker.state.roundTrips.filter((t) => t.closed).length).toBeGreaterThan(0);
    expect(a.broker.state.events).not.toContainEqual(first);
    await saved.writeSession(record(a));
    // Back a few days, which drops the checkpoints after it, then trading there and on.
    a.jumpTo(day('2024-03-20', '10:00'));
    a.cancel(a.submit({ symbol: 'AAPL', action: 'buy', type: 'limit', limitPrice: 1, quantity: 1, tif: 'gtc' }).order!.id);
    a.jumpTo(day('2024-03-22', '15:00'));
    await saved.writeSession(record(a));
    const kv = db.stores.get('kv')!;
    const cps = [...kv.entries()].filter(([k]) => k.startsWith(`session-cp:${id}:`)).map(([, v]) => v as { log?: unknown; cp: { broker: { events?: unknown } } });
    const checkpoints = a.save().checkpoints;
    expect(cps).toHaveLength(checkpoints.length);
    expect(checkpoints.filter((c) => c.broker.events.length === 500).length).toBeGreaterThan(100);
    // The log is stored about once, not 500 lines again for each checkpoint.
    const logs = cps.reduce((n, c) => n + JSON.stringify(c.log ?? c.cp.broker.events).length, 0);
    expect(logs).toBeLessThan(3 * JSON.stringify(a.broker.state.events).length);

    // Read back after a reload: every checkpoint as it was, so a rewind to any of them gives the same account.
    saved = await fresh();
    const read = (await saved.readSession(id))!;
    expect(read.replay!.state.checkpoints).toEqual(checkpoints);
    const b = await ReplaySession.resume(p, read.replay!.state, id);
    for (const t of [day('2024-03-22', '11:00'), day('2024-03-19', '15:30'), day('2024-03-14', '04:30'), day('2024-03-12', '09:40')]) {
      a.jumpTo(t);
      b.jumpTo(t);
      expect({ ...b.broker.state, version: 0 }).toEqual({ ...a.broker.state, version: 0 });
    }
    // Carried on and saved again, its new checkpoints' logs are stored as changes to the ones read back.
    b.jumpTo(day('2024-03-15', '12:00'));
    await saved.writeSession(record(b));
    saved = await fresh();
    expect((await saved.readSession(id))!.replay!.state.checkpoints).toEqual(b.save().checkpoints);

    // A checkpoint stored whole, as before logs were stored as changes, is read as it was.
    const keys = (kv.get(`session:${id}`) as { replay: { state: { checkpoints: string[] } } }).replay.state.checkpoints;
    const k = Math.floor(keys.length / 2);
    const { log, ...whole } = kv.get(keys[k]) as { log: unknown; cp: { broker: object } };
    expect(log).toBeDefined();
    kv.set(keys[k], { ...whole, cp: { ...whole.cp, broker: { ...whole.cp.broker, events: b.save().checkpoints[k].broker.events } } });
    saved = await fresh();
    expect((await saved.readSession(id))!.replay!.state.checkpoints).toEqual(b.save().checkpoints);
    // A log stored as a change to one that is not before it in the list cannot be rebuilt: the session is not read.
    const last = kv.get(keys.at(-1)!) as { log: { base?: string } };
    expect(last.log.base).toBe(keys.at(-2));
    kv.set(keys.at(-1)!, { ...last, log: { ...last.log, base: keys.at(-1) } });
    saved = await fresh();
    expect(await saved.readSession(id)).toBeNull();
  }, 60_000);
});

describe('the chart with no session beside a replay not finished', () => {
  /** The browsing chart's bars of `symbol` once loaded (or nothing when it stays empty). */
  async function browsed(store: Awaited<ReturnType<typeof page>>['store'], symbol: string) {
    store.setActiveSymbol(symbol);
    await vi.waitFor(() => {
      store.getBaseBars(symbol);
      expect(store.useTrading.getState().browse.loading).toBe(false);
      expect(store.useTrading.getState().browse.error).toBeNull();
    }, { timeout: 10_000 });
    return store.getBaseBars(symbol);
  }

  /**
   * A replay of SPY (and QQQ on its clock) `back` trading days before the demo data's last, left by a closed tab
   * five minutes after its start (10:00, or as `more` says, with the rest of its setup).
   */
  async function leftUnfinished(blind = false, back = 2, more: { startTime?: string; endTime?: string; endDate?: (day: string) => string } = {}) {
    const a = await page();
    const { demoProvider } = await import('./dataRegistry');
    let day = demoProvider.lastDate;
    for (let i = 0; i < back; i++) day = prevTradingDay(day);
    const { endDate, ...times } = more;
    expect(await a.store.startReplay({ ...replay, ...times, ...(endDate ? { endDate: endDate(day) } : {}), date: day, blind, extraSymbols: ['QQQ'] })).toBe(true);
    expect(a.store.useTrading.getState().session!.symbols).toEqual(['SPY', 'QQQ']);
    const id = a.store.useTrading.getState().session!.id;
    for (let i = 0; i < 5; i++) a.store.stepForward();
    await settle();
    a.store.pause();
    await settle();
    window.dispatchEvent(new Event('pagehide'));
    rememberNothing();
    return { id, day, last: demoProvider.lastDate };
  }

  /** Why the chart is not drawn for a replay of SPY (and `sym` on its clock) of `day` left unfinished. */
  const unfinishedWhy = (sym: string, day: string) => `Your SPY replay of ${day} is unfinished, and charting ${sym} here would show what comes next in it. Resume or discard it to chart ${sym} here.`;

  it('is not drawn on the symbols and data source of a replay left unfinished, says why, and is drawn to the end of its data once that replay is discarded', async () => {
    const { id, day, last } = await leftUnfinished();
    const b = await page();
    const preview = vi.spyOn((await import('../../core/replay/ReplaySession')).ReplaySession, 'preview');
    for (const sym of ['SPY', 'QQQ']) {
      b.store.setActiveSymbol(sym);
      // As the chart asks for its bars.
      await vi.waitFor(() => {
        b.store.getBaseBars(sym);
        expect(b.store.browseHiddenReason()).toBe(unfinishedWhy(sym, day));
      });
      // Nothing of it: no bar, no longer past, no last close, nothing to pick, no date or random day to start from.
      expect(b.store.getBaseBars(sym)).toEqual([]);
      for (const tf of ['1m', '1h', '1D'] as const) expect(b.store.getChartHistory(sym, tf)).toBeNull();
      expect(await b.store.browseLastClose('demo', sym)).toBeNull();
      expect(b.store.selectBarBlocked()).toBe(unfinishedWhy(sym, day));
      expect(await b.store.startRandomBar(() => 0.5)).toBe(false);
      expect(b.store.useTrading.getState()).toMatchObject({ session: null, loading: false, error: unfinishedWhy(sym, day) });
      b.store.dismissError();
      expect(await b.store.startReplayAt(prevTradingDay(day), '10:00')).toBe(false);
      expect(b.store.useTrading.getState()).toMatchObject({ session: null, loading: false, error: unfinishedWhy(sym, day) });
      b.store.dismissError();
    }
    // Its bars are not even loaded.
    await settle();
    expect(preview.mock.calls.filter(([, setup]) => ['SPY', 'QQQ'].includes(setup.symbol))).toEqual([]);
    // Another symbol, or the same one from another data source, is drawn as ever.
    expect((await browsed(b.store, 'AAPL')).at(-1)!.time).toBe(exchangeTimeToUnix(last, 19 * 60 + 59));
    expect(b.store.browseHiddenReason()).toBeNull();
    expect(b.store.browseHoldOn('csv', 'SPY')).toBeNull();
    // Discarded: drawn to the end of its data, and the watchlist's close is back.
    b.store.setActiveSymbol('SPY');
    expect(await b.store.discardSession(id)).toBe(true);
    await vi.waitFor(() => {
      b.store.getBaseBars('SPY');
      expect(b.store.getBaseBars('SPY').at(-1)?.time).toBe(exchangeTimeToUnix(last, 19 * 60 + 59));
    }, { timeout: 10_000 });
    expect(b.store.browseHiddenReason()).toBeNull();
    expect(b.store.selectBarBlocked()).toBeNull();
    expect(await b.store.browseLastClose('demo', 'QQQ')).not.toBeNull();
  });

  it('says why imported data is not charted beside a replay left unfinished on an earlier file of it, not that a day is missing', async () => {
    const a = await page();
    const minutes = (days: string[]) => days.flatMap((d) => Array.from({ length: 390 }, (_, i) => ({ time: exchangeTimeToUnix(d, 570 + i), open: 10, high: 10.1, low: 9.9, close: 10, volume: 1000 })));
    const acme = { symbol: 'ACME', name: 'ACME', baseTimeframe: '1m' as const, fileName: 'a.csv' };
    await (await import('./dataRegistry')).saveCsvDataset({ ...acme, importedAt: 1, bars: minutes(['2024-03-11', '2024-03-12', '2024-03-13', '2024-03-14', '2024-03-15']) });
    expect(await a.store.startReplay({ ...replay, providerId: 'csv', symbol: 'ACME', date: '2024-03-13' })).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    a.store.stepForward();
    await settle();
    a.store.pause();
    await settle();
    window.dispatchEvent(new Event('pagehide'));
    rememberNothing();
    // ACME imported again, from a later file.
    const b = await page();
    const registry = await import('./dataRegistry');
    await registry.loadCsvDatasets();
    await registry.saveCsvDataset({ ...acme, importedAt: 2, bars: minutes(['2024-06-03', '2024-06-04', '2024-06-05', '2024-06-06', '2024-06-07']) });
    b.store.browseSymbol('csv', 'ACME');
    const why = 'Your ACME replay of 2024-03-13 is unfinished, and charting ACME here would show what comes next in it. Resume or discard it to chart ACME here.';
    await vi.waitFor(() => {
      b.store.getBaseBars('ACME');
      expect(b.store.browseHiddenReason()).toBe(why);
    });
    await settle();
    expect(b.store.useTrading.getState().browse).toMatchObject({ loading: false, error: null });
    expect(b.store.selectBarBlocked()).toBe(why);
    // Discarded: the new file's bars.
    expect(await b.store.discardSession(id)).toBe(true);
    await vi.waitFor(() => {
      b.store.getBaseBars('ACME');
      expect(b.store.getBaseBars('ACME').at(-1)?.time).toBe(exchangeTimeToUnix('2024-06-07', 15 * 60 + 59));
    }, { timeout: 10_000 });
  });

  it('asks Polygon for nothing while a replay of the ticker plays on in another tab from day to day, and charts it once that replay ends', async () => {
    const vendor = async () => {
      const registry = await import('./dataRegistry');
      polygonServesDemo(registry);
      (await import('./credentials')).useCredentials.setState((c) => ({ creds: { ...c.creds, serverHasPolygonKey: true }, serverChecked: true }));
      return registry;
    };
    const a = await page();
    const { demoProvider } = await vendor();
    let day = demoProvider.lastDate;
    for (let i = 0; i < 60; i++) day = prevTradingDay(day);
    let end = day;
    for (let i = 0; i < 20; i++) end = nextTradingDay(end);
    expect(await a.store.startReplay({ ...replay, providerId: 'polygon', date: day, endDate: end, startTime: '09:30', endTime: '16:00', timeframe: '1h', speed: 3600 })).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    a.store.stepForward();
    await settle();
    a.store.pause();
    await settle();
    window.dispatchEvent(new Event('pagehide'));
    rememberNothing();
    // Another tab carries it on, and this one charts the ticker from Polygon on hourly candles.
    locks.elsewhere.add(`stock-replay-session:${id}`);
    const b = await page();
    const { polygonProvider } = await vendor();
    const requests = () => vi.mocked(polygonProvider.getBars).mock.calls.length + vi.mocked(polygonProvider.getCoarseBars).mock.calls.length;
    b.store.setTimeframe('1h');
    b.store.browseSymbol('polygon', 'SPY');
    const why = 'A SPY replay is running in another tab, and charting SPY here would show what comes next in it. It is charted here again once that replay ends.';
    await vi.waitFor(() => {
      b.store.getBaseBars('SPY');
      expect(b.store.browseHiddenReason()).toBe(why);
    });
    await settle();
    expect(requests()).toBe(0);
    // That tab plays on, saving on a new day every time (about every 30 s at its speed), and tells this one.
    const kv = db.stores.get('kv')!;
    const key = `session-summary:${id}`;
    let d = day;
    for (let i = 0; i < 6; i++) {
      d = nextTradingDay(d);
      kv.set(key, { ...(kv.get(key) as object), now: exchangeTimeToUnix(d, 11 * 60), savedAt: Date.now() });
      window.dispatchEvent(new StorageEvent('storage', { key: 'stock-replay-sessions-changed' }));
      // This tab reads the saved sessions again at most once a second.
      await new Promise((r) => setTimeout(r, 1100));
      b.store.getBaseBars('SPY');
      b.store.getChartHistory('SPY', '1h');
      expect(b.store.browseHiddenReason()).toBe(why);
    }
    expect(requests()).toBe(0);
    // It ends there: the chart is loaded, once, to the end of the data.
    kv.delete(key);
    kv.delete(`session:${id}`);
    locks.elsewhere.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: 'stock-replay-sessions-changed' }));
    await vi.waitFor(() => expect(b.store.browseHoldOn('polygon', 'SPY')).toBeNull(), { timeout: 3000 });
    await vi.waitFor(() => {
      b.store.getBaseBars('SPY');
      expect(b.store.getChartHistory('SPY', '1h')?.status).toBe('ready');
    }, { timeout: 10_000 });
    expect(exchangeDate(b.store.getBaseBars('SPY').at(-1)!.time)).toBe(demoProvider.lastDate);
    expect(requests()).toBe(2);
  }, 30_000);

  it('is not drawn at all on the symbols of a blind replay left unfinished, whose dates it would show', async () => {
    await leftUnfinished(true);
    const b = await page();
    const preview = vi.spyOn((await import('../../core/replay/ReplaySession')).ReplaySession, 'preview');
    b.store.setActiveSymbol('QQQ');
    // As the chart asks for its bars.
    await vi.waitFor(() => {
      b.store.getBaseBars('QQQ');
      expect(b.store.browseHiddenReason()).toBe('A blind replay of QQQ is unfinished. Resume or discard it to chart QQQ here.');
    });
    expect(b.store.getBaseBars('QQQ')).toEqual([]);
    expect(b.store.getChartHistory('QQQ', '1D')).toBeNull();
    expect(b.store.selectBarBlocked()).toBe(b.store.browseHiddenReason());
    expect(await b.store.browseLastClose('demo', 'QQQ')).toBeNull();
    // Its bars are not even loaded.
    await settle();
    expect(preview.mock.calls.filter(([, setup]) => setup.symbol === 'QQQ')).toEqual([]);
    expect((await browsed(b.store, 'AAPL')).length).toBeGreaterThan(0);
    expect(b.store.browseHiddenReason()).toBeNull();
  });

  it('is not drawn while a replay of its ticker runs in another tab, learning of it as that tab saves, and is drawn again once it ends; nor while a blind one does', async () => {
    const a = await page();
    const { demoProvider } = await import('./dataRegistry');
    const day = prevTradingDay(demoProvider.lastDate);
    // This page, opened beside the first, charts SPY to the end of its data.
    const b = await page();
    const end = exchangeTimeToUnix(demoProvider.lastDate, 19 * 60 + 59);
    expect((await browsed(b.store, 'SPY')).at(-1)!.time).toBe(end);
    // The first tab starts a replay of SPY: its saves tell this one (a storage event), which stops drawing SPY.
    expect(await a.store.startReplay({ ...replay, date: day })).toBe(true);
    await settle();
    window.dispatchEvent(new StorageEvent('storage', { key: `stock-replay-session-position:${a.store.useTrading.getState().session!.id}` }));
    await vi.waitFor(() => expect(b.store.browseHoldOn('demo', 'SPY')).toEqual({ blind: false, elsewhere: true }), { timeout: 3000 });
    expect(b.store.getBaseBars('SPY')).toEqual([]);
    expect(b.store.browseHiddenReason()).toBe('A SPY replay is running in another tab, and charting SPY here would show what comes next in it. It is charted here again once that replay ends.');
    // It ends there: the chart has all its bars again.
    await a.store.endSession();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    await vi.waitFor(() => expect(b.store.browseHoldOn('demo', 'SPY')).toBeNull(), { timeout: 3000 });
    await vi.waitFor(() => {
      b.store.getBaseBars('SPY');
      expect(b.store.getBaseBars('SPY').at(-1)?.time).toBe(end);
    }, { timeout: 10_000 });

    // A blind one there: nothing of SPY is shown here, and this page says why, naming no date.
    expect(await a.store.startReplay({ ...replay, date: day, blind: true })).toBe(true);
    await settle();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    await vi.waitFor(() => expect(b.store.browseHiddenReason()).toBe('A blind replay of SPY is running in another tab. Its chart stays hidden here until that replay ends, as its date does.'), { timeout: 3000 });
    expect(b.store.getBaseBars('SPY')).toEqual([]);
  });

  it('learns of a replay another tab starts and leaves paused once its save has landed, and of its end once its deletion has', async () => {
    // A storage event reaches the other tabs only, after the write, and only for a change. Both pages share this
    // window here: each change to localStorage is passed on as a browser passes it to the other tab.
    const realSet = Storage.prototype.setItem;
    const realRemove = Storage.prototype.removeItem;
    const tell = (key: string) => void setTimeout(() => window.dispatchEvent(new StorageEvent('storage', { key })), 0);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      const changed = this.getItem(key) !== value;
      realSet.call(this, key, value);
      if (this === localStorage && changed) tell(key);
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      const changed = this.getItem(key) !== null;
      realRemove.call(this, key);
      if (this === localStorage && changed) tell(key);
    });
    // Each write to IndexedDB takes a while, as it can, and a read goes alongside them.
    db.commitMs = 40;
    db.readMs = { kv: 1 };
    const a = await page();
    const { demoProvider } = await import('./dataRegistry');
    const day = prevTradingDay(demoProvider.lastDate);
    const b = await page();
    const end = exchangeTimeToUnix(demoProvider.lastDate, 19 * 60 + 59);
    expect((await browsed(b.store, 'SPY')).at(-1)!.time).toBe(end);
    // The first tab starts a replay of SPY and leaves it paused: where its clock is gets noted once, as it starts,
    // before its save is there to read.
    expect(await a.store.startReplay({ ...replay, date: day })).toBe(true);
    await vi.waitFor(() => expect(b.store.browseHoldOn('demo', 'SPY')).toEqual({ blind: false, elsewhere: true }), { timeout: 4000 });
    expect(b.store.getBaseBars('SPY')).toEqual([]);
    // It ends: once its save is gone, the chart is drawn again, and stays so.
    await a.store.endSession();
    await vi.waitFor(() => expect(b.store.browseHoldOn('demo', 'SPY')).toBeNull(), { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(b.store.browseHoldOn('demo', 'SPY')).toBeNull();
    await vi.waitFor(() => {
      b.store.getBaseBars('SPY');
      expect(b.store.getBaseBars('SPY').at(-1)?.time).toBe(end);
    }, { timeout: 10_000 });
  }, 20_000);

  it('starts no replay from a date or a random day on the symbols of a blind replay left unfinished, and the Replay menu says why, once, in words a touch screen shows', async () => {
    const { day } = await leftUnfinished(true);
    const b = await page();
    b.store.setActiveSymbol('QQQ');
    await vi.waitFor(() => {
      b.store.getBaseBars('QQQ');
      expect(b.store.browseHiddenReason()).not.toBeNull();
    });
    const why = b.store.browseHiddenReason()!;
    expect(why).toBe('A blind replay of QQQ is unfinished. Resume or discard it to chart QQQ here.');
    // Either would show days of that ticker with their dates, its replay's days among them, or near them.
    expect(await b.store.startRandomBar(() => 0.5)).toBe(false);
    expect(b.store.useTrading.getState()).toMatchObject({ session: null, loading: false, error: why });
    b.store.dismissError();
    expect(await b.store.startReplayAt(day, '10:00')).toBe(false);
    expect(b.store.useTrading.getState()).toMatchObject({ session: null, loading: false, error: why });
    b.store.dismissError();

    // The Replay button's menu greys them out and says why under them, once, as a line that is not an item; they
    // do nothing. The full setup form is still there.
    const { ReplayMenu } = await import('../components/ReplayMenu');
    const opened: string[] = [];
    const menu = render(createElement(ReplayMenu, { onNewSession: (mode: 'replay' | 'sim') => void opened.push(mode) }));
    act(() => menu.el.querySelector<HTMLButtonElement>('button[aria-label="More ways to start a replay"]')!.click());
    const item = (label: string) => [...menu.el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((x) => x.textContent === label)!;
    const notes = () => [...menu.el.querySelectorAll<HTMLElement>('[role="menu"] .menu-note')];
    expect(notes().map((n) => n.textContent)).toEqual([why]);
    expect(notes()[0].getAttribute('role')).toBe('none');
    // Right under the items it is about, before the full setup form.
    expect(notes()[0].previousElementSibling).toBe(item('Random bar'));
    for (const label of ['Select bar', 'Select date…', 'Random bar']) {
      expect(item(label).getAttribute('aria-disabled'), label).toBe('true');
      expect(item(label).title, label).toBe(why);
      expect(item(label).getAttribute('aria-describedby'), label).toBe(notes()[0].id);
    }
    expect(document.getElementById(notes()[0].id)).toBe(notes()[0]);
    act(() => item('Random bar').click());
    act(() => item('Select date…').click());
    await settle();
    expect(b.store.useTrading.getState()).toMatchObject({ session: null, loading: false, error: null });
    expect(menu.el.querySelector('[role="dialog"]')).toBeNull();
    expect(item('Advanced replay setup…').getAttribute('aria-disabled')).toBeNull();
    expect(item('Advanced replay setup…').getAttribute('aria-describedby')).toBeNull();
    // Another ticker's chart is shown, and they are there to use, with nothing said under them.
    act(() => b.store.setActiveSymbol('AAPL'));
    await vi.waitFor(() => {
      b.store.getBaseBars('AAPL');
      expect(b.store.selectBarBlocked()).toBeNull();
    }, { timeout: 10_000 });
    act(() => b.store.useTrading.setState({}));
    expect(item('Random bar').getAttribute('aria-disabled')).toBeNull();
    expect(item('Random bar').getAttribute('aria-describedby')).toBeNull();
    expect(item('Random bar').title).toBe('Start at the open of a day picked at random');
    expect(item('Select date…').getAttribute('aria-disabled')).toBeNull();
    expect(notes()).toEqual([]);
    menu.unmount();
  });

  it('turns Random bar off on a ticker with a replay left unfinished, during another replay of it too, and picks any day once that one is discarded', async () => {
    const { id, day } = await leftUnfinished(false, 2);
    const b = await page();
    b.store.setActiveSymbol('SPY');
    await vi.waitFor(() => {
      b.store.getBaseBars('SPY');
      expect(b.store.randomBarBlocked()).toBe(unfinishedWhy('SPY', day));
    });
    // A replay of SPY started from the full setup form (the way around): Random bar there could pick one of the
    // unfinished replay's days, after its clock, so it is off, and starts nothing.
    const { demoProvider } = await import('./dataRegistry');
    expect(await b.store.startReplay({ ...replay, date: prevTradingDay(prevTradingDay(day)) })).toBe(true);
    const running = b.store.useTrading.getState().session!.id;
    const off = "Random bar is off while a SPY replay is unfinished: it could pick one of that replay's days, after its clock.";
    expect(b.store.randomBarBlocked()).toBe(off);
    expect(await b.store.startRandomBar(() => 0.999999)).toBe(false);
    expect(b.store.useTrading.getState().session!.id).toBe(running);
    expect(b.useToasts.getState().toasts.at(-1)?.text).toBe(`The replay did not start: ${off}`);
    await b.store.endSession();
    // Discarded: any day, the last one too.
    expect(await b.store.discardSession(id)).toBe(true);
    expect(b.store.randomBarBlocked()).toBeNull();
    expect(await b.store.startRandomBar(() => 0.999999)).toBe(true);
    expect(b.store.useTrading.getState().now).toBe(exchangeTimeToUnix(demoProvider.lastDate, 9 * 60 + 30));
  });

  /**
   * Makes carrying a replay on load its data for a while, until what this returns is called, and then fail as
   * a vendor's rate limit does. `called`: once the load has begun (the session is this tab's by then).
   */
  async function slowFailingResume() {
    let fail!: () => void;
    const failing = new Promise<void>((r) => (fail = r));
    const { ReplaySession } = await import('../../core/replay/ReplaySession');
    const load = vi.spyOn(ReplaySession, 'resume').mockImplementation(async () => {
      await failing;
      throw new Error('Polygon rate limit reached. Wait a minute and try again.');
    });
    return { fail, called: () => vi.waitFor(() => expect(load).toHaveBeenCalled()) };
  }

  it('still says a replay you have not finished is yours to resume or discard when carrying it on fails, though the saved sessions were read meanwhile', async () => {
    const { id, day } = await leftUnfinished();
    const b = await page();
    b.store.setActiveSymbol('SPY');
    await vi.waitFor(() => {
      b.store.getBaseBars('SPY');
      expect(b.store.browseHiddenReason()).toBe(unfinishedWhy('SPY', day));
    });
    const resume = await slowFailingResume();
    const resumed = b.store.resumeSession(id);
    await resume.called();
    // The window comes back into view as it loads: the saved sessions are read again. It is not free, as this
    // tab holds it, but no other tab runs it.
    window.dispatchEvent(new Event('focus'));
    await settle();
    await settle();
    expect(b.store.browseHoldOn('demo', 'SPY')).toEqual({ blind: false, elsewhere: false });
    resume.fail();
    expect(await resumed).toBe(false);
    expect(b.store.useTrading.getState()).toMatchObject({ session: null, loading: false, error: 'Polygon rate limit reached. Wait a minute and try again.' });
    await settle();
    expect(b.store.browseHiddenReason()).toBe(unfinishedWhy('SPY', day));
    expect(b.store.randomBarBlocked()).toBe(unfinishedWhy('SPY', day));
    // And stays so, as its card offers it.
    await new Promise((r) => setTimeout(r, 1500));
    expect(b.store.browseHiddenReason()).toBe(unfinishedWhy('SPY', day));
    expect((await b.store.unfinishedSessions()).map((s) => s.id)).toEqual([id]);
  });

  it('reads the saved sessions again once carrying a replay on fails, so a read that found it this tab’s and ends after that does not leave it said to run in another tab', async () => {
    const { id, day } = await leftUnfinished();
    // A tab that has not read them yet (its chart has not asked for bars).
    const c = await page();
    await settle();
    expect(c.store.useTrading.getState().browse.holds).toEqual([]);
    const resume = await slowFailingResume();
    const resumed = c.store.resumeSession(id);
    await resume.called();
    // A read starts as it loads (the window comes back into view). It finds the session not free, as this tab
    // holds it; what data source it is on (read once) comes in only after carrying it on has failed.
    const gate = () => {
      let open!: () => void;
      return { held: new Promise<void>((r) => (open = r)), open: () => open() };
    };
    const summaries = gate();
    const record = gate();
    db.readMs = { kv: 1 };
    db.readHeld = { kv: summaries.held };
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(db.reading.size).toBeGreaterThan(0));
    db.readHeld = { kv: record.held };
    summaries.open();
    await settle();
    resume.fail();
    expect(await resumed).toBe(false);
    record.open();
    await settle();
    expect(c.store.browseHoldOn('demo', 'SPY')).toEqual({ blind: false, elsewhere: false });
    expect(c.store.browseHiddenReason()).toBe(unfinishedWhy('SPY', day));
  });
});

describe('a blind session left unfinished', () => {
  const SAVED_BLIND = 'stock-replay-saved-blind';

  it('keeps its dates hidden in the journal, analytics, exports and backups of every tab until it ends', async () => {
    const a = await page();
    expect(await a.store.startReplay({ ...replay, blind: true })).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    a.store.stepForward();
    expect(a.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    a.store.stepForward();
    expect(a.store.closePosition('SPY').ok).toBe(true);
    await vi.waitFor(() => expect(a.useJournal.getState().entries).toHaveLength(1));
    const entry = a.useJournal.getState().entries[0];
    expect(entry.blind).toBe(true);
    await settle();
    // The tab closes; one opened later hides the dates from its first render, before anything is read.
    window.dispatchEvent(new Event('pagehide'));
    rememberNothing();
    vi.resetModules();
    expect((await import('./liveBlind')).useLiveBlind.getState().sessions).toEqual({ [id]: '2024-03-12' });

    const b = await page();
    expect((await b.store.unfinishedSessions()).map((s) => [s.id, s.meta.blind])).toEqual([[id, true]]);
    const hidden = await shown(entry);
    expect(hidden).toMatchObject({ hidden: true, time: expect.stringMatching(/^Day 1 \d\d:\d\d$/) });
    const { createBackup } = await import('../services/backup');
    const made = await createBackup({ snapshots: true, datasets: false, holdBack: hidden.holdBack });
    expect([made.heldBack, made.backup.journal.length]).toEqual([1, 0]);

    // Carried on and ended, it gives its dates back.
    expect(await b.store.resumeSession(id)).toBe(true);
    expect((await shown(entry)).hidden).toBe(true);
    await b.store.endSession();
    expect(await shown(entry)).toMatchObject({ hidden: false, time: expect.stringMatching(/^2024-03-12 /) });
    expect(localStorage.getItem(SAVED_BLIND)).toBeNull();
  });

  it('is listed once the app opens if it was saved before that listing, and taken off when let go', async () => {
    const a = await page();
    expect(await a.store.startReplay({ ...replay, blind: true })).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    await settle();
    window.dispatchEvent(new Event('pagehide'));
    rememberNothing();
    // Saved by an older version of the app (its summary does not say whether a challenge attempt was
    // under way), with a listing left of a session no longer kept.
    const kv = db.stores.get('kv')!;
    const { challengeUnderWay, ...older } = kv.get(`session-summary:${id}`) as Record<string, unknown>;
    expect(challengeUnderWay).toBe(false);
    kv.set(`session-summary:${id}`, older);
    localStorage.setItem(SAVED_BLIND, JSON.stringify({ gone: '2020-01-02' }));

    const b = await page();
    const { useLiveBlind } = await import('./liveBlind');
    await vi.waitFor(() => expect(useLiveBlind.getState().sessions).toEqual({ [id]: '2024-03-12' }));
    expect(await b.store.discardSession(id)).toBe(true);
    expect(useLiveBlind.getState().sessions).toEqual({});
    expect(localStorage.getItem(SAVED_BLIND)).toBeNull();
  });

  it('gives its date back once it has run to its end', async () => {
    const a = await page();
    expect(await a.store.startReplay({ ...replay, blind: true, endTime: '10:02' })).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    await settle();
    const { useLiveBlind } = await import('./liveBlind');
    expect(JSON.parse(localStorage.getItem(SAVED_BLIND)!)).toEqual({ [id]: '2024-03-12' });
    a.store.stepForward();
    a.store.stepForward();
    await settle();
    expect(a.store.useTrading.getState()).toMatchObject({ finished: true, session: { blind: false } });
    expect(useLiveBlind.getState().sessions).toEqual({});
    expect(localStorage.getItem(SAVED_BLIND)).toBeNull();
  });

  it('is not listed again by a tab that opens while another tab ends it', async () => {
    const a = await page();
    expect(await a.store.startReplay({ ...replay, blind: true })).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    a.store.stepForward();
    expect(a.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    a.store.stepForward();
    expect(a.store.closePosition('SPY').ok).toBe(true);
    await vi.waitFor(() => expect(a.useJournal.getState().entries).toHaveLength(1));
    const entry = a.useJournal.getState().entries[0];
    await settle();
    // Ended, it is deleted after the writes before it: its dates stay hidden until then.
    let land!: () => void;
    db.held = new Promise((r) => (land = r));
    await a.store.endSession();
    await settle();
    expect(JSON.parse(localStorage.getItem(SAVED_BLIND)!)).toEqual({ [id]: '2024-03-12' });

    // Another tab opens meanwhile.
    vi.resetModules();
    await import('./tradingStore');
    const { useLiveBlind } = await import('./liveBlind');
    await settle();
    land();
    await settle();
    window.dispatchEvent(new StorageEvent('storage', { key: SAVED_BLIND }));
    expect(localStorage.getItem(SAVED_BLIND)).toBeNull();
    expect(useLiveBlind.getState().sessions).toEqual({});
    expect(await shown(entry)).toMatchObject({ hidden: false, time: expect.stringMatching(/^2024-03-12 /) });
  });

  it('is not listed again once +1 candle has run it to its end, even by a tab that opens after the save of that was lost', async () => {
    const a = await page();
    expect(await a.store.startReplay({ ...replay, blind: true, endTime: '10:03' })).toBe(true);
    const id = a.store.useTrading.getState().session!.id;
    a.store.stepForward();
    expect(a.store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }).ok).toBe(true);
    a.store.stepForward();
    expect(a.store.closePosition('SPY').ok).toBe(true);
    await vi.waitFor(() => expect(a.useJournal.getState().entries).toHaveLength(1));
    await settle();
    const kv = db.stores.get('kv')!;
    const blindSummary = structuredClone(kv.get(`session-summary:${id}`));
    a.store.stepCandle();
    a.store.stepCandle();
    await settle();
    expect(a.store.useTrading.getState()).toMatchObject({ finished: true, session: { blind: false } });
    expect(kv.get(`session-summary:${id}`)).toMatchObject({ finished: true, meta: { blind: false } });
    await page();
    await settle();
    expect(localStorage.getItem(SAVED_BLIND)).toBeNull();

    // The tab went before that save landed: what is stored still says blind.
    kv.set(`session-summary:${id}`, blindSummary);
    rememberNothing();
    await page();
    await settle();
    expect(localStorage.getItem(SAVED_BLIND)).toBeNull();
    expect((await import('./liveBlind')).useLiveBlind.getState().sessions).toEqual({});
  });
});

/** Waits until storage has done all it was asked to (with `commitMs` set). */
async function drained() {
  let last: Promise<unknown>;
  do {
    last = db.queue;
    await last;
    await settle();
  } while (last !== db.queue);
}

/** A new tab: nothing of the closed one's own tab state. */
function rememberNothing() {
  sessionStorage.clear();
}

/** Renders `el` into the page, as a screen of the app. */
function render(el: ReactElement) {
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  act(() => root.render(el));
  return {
    el: host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** How the journal, analytics and backup screens show `entry` (useEntryTime, useDateHidden), and what a backup leaves out. */
async function shown(entry: JournalEntry) {
  const { useDateHidden, useEntryTime } = await import('../components/useEntryTime');
  const seen = { time: '', hidden: false, holdBack: (_: JournalEntry) => false };
  function Probe() {
    const time = useEntryTime();
    const hidden = useDateHidden();
    Object.assign(seen, { time: time(entry, entry.entryTime), hidden: hidden(entry), holdBack: hidden });
    return null;
  }
  render(createElement(Probe)).unmount();
  return seen;
}

/** The Polygon provider serving the demo data (there is no network here), for a vendor replay. */
function polygonServesDemo({ polygonProvider, demoProvider }: typeof import('./dataRegistry')) {
  vi.spyOn(polygonProvider, 'getBars').mockImplementation((req, signal) => demoProvider.getBars(req, signal));
  vi.spyOn(polygonProvider, 'getCoarseBars').mockImplementation((req, tf, signal) => demoProvider.getCoarseBars(req, tf, signal));
}
