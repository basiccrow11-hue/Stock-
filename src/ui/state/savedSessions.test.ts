// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { exchangeTimeToUnix } from '../../core/time';
import type { JournalEntry } from '../../core/journal';
import { CHALLENGES } from '../../core/challenges/challenges';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * IndexedDB stand-in: one Map per store, kept across module resets as a browser keeps it across a reload.
 * `written`: the keys written, in order. `held`: while set, deleting a session's summary waits for it.
 */
const db = vi.hoisted(() => ({ stores: new Map<string, Map<string, unknown>>(), written: [] as string[], held: null as Promise<void> | null }));
vi.mock('../services/idb', () => {
  const store = (name: string) => {
    if (!db.stores.has(name)) db.stores.set(name, new Map());
    return db.stores.get(name)!;
  };
  return {
    idb: {
      all: async (s: string) => [...store(s).values()].map((v) => structuredClone(v)),
      withPrefix: async (s: string, prefix: string) =>
        [...store(s).entries()]
          .filter(([k]) => k.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([, v]) => structuredClone(v)),
      get: async (s: string, k: string) => structuredClone(store(s).get(k)),
      set: async (s: string, k: string, v: unknown) => {
        db.written.push(k);
        store(s).set(k, structuredClone(v));
      },
      delete: async (s: string, k: string) => {
        if (db.held && k.startsWith('session-summary:')) await db.held;
        store(s).delete(k);
      },
      modify: async (s: string, k: string, fn: (v: unknown) => unknown) => {
        const next = fn(structuredClone(store(s).get(k)));
        if (next !== undefined) store(s).set(k, structuredClone(next));
        return next;
      },
      clear: async (s: string) => void store(s).clear(),
    },
  };
});
vi.mock('../chart/offscreenSnapshot', () => ({ offscreenSnapshot: async () => 'data:image/jpeg;base64,BB==' }));

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
  localStorage.clear();
  sessionStorage.clear();
  locks.mine.clear();
  locks.elsewhere.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
