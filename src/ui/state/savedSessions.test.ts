// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exchangeTimeToUnix } from '../../core/time';

/** IndexedDB stand-in: one Map per store, kept across module resets as a browser keeps it across a reload. */
const db = vi.hoisted(() => ({ stores: new Map<string, Map<string, unknown>>() }));
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
      set: async (s: string, k: string, v: unknown) => void store(s).set(k, structuredClone(v)),
      delete: async (s: string, k: string) => void store(s).delete(k),
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
  const saved = await import('../services/savedSessions');
  await useJournal.getState().load();
  await useChallenges.getState().load();
  return { store, useJournal, useChallenges, useToasts, saved };
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
  localStorage.clear();
  sessionStorage.clear();
  locks.mine.clear();
  locks.elsewhere.clear();
});
afterEach(() => vi.restoreAllMocks());

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

/** A new tab: nothing of the closed one's own tab state. */
function rememberNothing() {
  sessionStorage.clear();
}
