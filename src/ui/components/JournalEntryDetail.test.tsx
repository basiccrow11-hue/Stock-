// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { EMPTY_NOTES, type JournalEntry } from '../../core/journal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** IndexedDB stand-in: every request waits its turn, as transactions on one store do. */
const db = new Map<string, unknown>();
let queue: Promise<unknown> = Promise.resolve();
const turn = <T,>(fn: () => T): Promise<T> => (queue = queue.then(() => new Promise((r) => setTimeout(r, 5))).then(fn)) as Promise<T>;
vi.mock('../services/idb', () => ({
  idb: {
    all: () => turn(() => [...db.values()].map((v) => structuredClone(v))),
    get: (_s: string, k: string) => turn(() => structuredClone(db.get(k))),
    set: (_s: string, k: string, v: unknown) => turn(() => void db.set(k, structuredClone(v))),
    delete: (_s: string, k: string) => turn(() => void db.delete(k)),
    modify: (_s: string, k: string, fn: (v: unknown) => unknown) =>
      turn(() => {
        const next = fn(structuredClone(db.get(k)));
        if (next !== undefined) db.set(k, structuredClone(next));
        return next;
      }),
  },
}));

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  db.clear();
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 900)));

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mount() {
  const t = 1_700_000_000;
  db.set('t1', {
    ...{ id: 't1', sessionId: 's1', mode: 'replay', source: 'demo', symbol: 'AAPL', direction: 'long', entryTime: t, exitTime: t + 600 },
    ...{ avgEntry: 100, avgExit: 101, quantity: 10, pnl: 10, returnPct: 1, holdingSeconds: 600, commission: 0, rewound: false, createdAt: 1 },
    ...{ tag: '', notes: { ...EMPTY_NOTES } },
  });
  vi.resetModules();
  const { JournalEntryDetail } = await import('./JournalEntryDetail');
  const { useJournal } = await import('../state/journalStore');
  await useJournal.getState().load();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = () => root.render(createElement(JournalEntryDetail, { entry: useJournal.getState().entries[0], showReview: false }));
  act(render);
  const unsub = useJournal.subscribe(() => act(render));
  const tagInput = host.querySelector<HTMLInputElement>('input[type=text]')!;
  const why = host.querySelector<HTMLTextAreaElement>('textarea')!;
  return { useJournal, tagInput, why, stored: () => db.get('t1') as JournalEntry, done: () => (unsub(), act(() => root.unmount())) };
}

describe('journal entry editor', () => {
  it('keeps a tag and a note edited in the same autosave', async () => {
    const m = await mount();
    act(() => type(m.tagInput, 'ORB'));
    act(() => type(m.why, 'opening range breakout'));
    await settle();
    expect(m.stored().tag).toBe('ORB');
    expect(m.stored().notes.why).toBe('opening range breakout');
    expect(m.useJournal.getState().entries[0].tag).toBe('ORB');
    // A later note-only save keeps the tag too.
    act(() => type(m.why, 'opening range breakout, retest'));
    await settle();
    expect(m.stored().tag).toBe('ORB');
    m.done();
  });

  it('saves edits made inside the debounce when the editor closes', async () => {
    const m = await mount();
    act(() => type(m.tagInput, 'VWAP'));
    act(() => type(m.why, 'reclaim'));
    m.done();
    await settle();
    expect(m.stored()).toMatchObject({ tag: 'VWAP', notes: { why: 'reclaim' } });
  });

  it('saves edits made inside the debounce when the page is closed or hidden', async () => {
    const m = await mount();
    act(() => type(m.why, 'pullback to vwap'));
    act(() => void window.dispatchEvent(new Event('pagehide')));
    // Before the debounce would have fired.
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(m.stored().notes.why).toBe('pullback to vwap');
    act(() => type(m.tagInput, 'VWAP'));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(m.stored().tag).toBe('VWAP');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    m.done();
  });

  it('takes in a tag saved in another tab and never writes the old one back', async () => {
    const m = await mount();
    db.set('t1', { ...m.stored(), tag: 'ORB' });
    new BroadcastChannel('stock-replay-journal').postMessage('t1');
    await settle();
    expect(m.tagInput.value).toBe('ORB');
    // A keystroke undone before the save changes nothing.
    act(() => type(m.why, 'x'));
    act(() => type(m.why, ''));
    await settle();
    expect(m.stored().tag).toBe('ORB');
    act(() => type(m.why, 'breakout'));
    await settle();
    expect(m.stored()).toMatchObject({ tag: 'ORB', notes: { why: 'breakout' } });
    m.done();
  });
});

describe('your own rules on a trade review', () => {
  it('are marked followed or broken, saved for that rule only, and cleared by pressing the same answer again', async () => {
    const { reviewTrade, DEFAULT_TRADING_RULES } = await import('../../core/learning/review');
    const t = 1_700_000_000;
    const trip = {
      ...{ id: 'r1', symbol: 'AAPL', direction: 'long' as const, entryTime: t, exitTime: t + 600, maxQuantity: 10, avgEntry: 100, avgExit: 101, entryQtyTotal: 10, exitQtyTotal: 10 },
      ...{ pnl: 10, commission: 0, initialStop: 99, initialTarget: 102, highWhileOpen: 101, lowWhileOpen: 99.5, fills: [], closed: true, source: 'DEMO' as const },
    };
    const rules = { ...DEFAULT_TRADING_RULES, custom: ['Trade with the trend', 'No revenge trades'] };
    const review = reviewTrade({ trip, fills: [], orders: [], revealedBars: [], timeframe: '1m', equityCurve: [], startingBalance: 25_000, allTrips: [trip], rules });
    db.set('r1', {
      ...{ id: 'r1', sessionId: 's1', mode: 'replay', source: 'DEMO', symbol: 'AAPL', direction: 'long', entryTime: t, exitTime: t + 600, stopLoss: 99, takeProfit: 102 },
      ...{ avgEntry: 100, avgExit: 101, quantity: 10, pnl: 10, returnPct: 1, holdingSeconds: 600, commission: 0, rewound: false, createdAt: 1 },
      ...{ tag: '', notes: { ...EMPTY_NOTES }, trip, review, ruleChecks: { 'No revenge trades': true } },
    });
    vi.resetModules();
    const { JournalEntryDetail } = await import('./JournalEntryDetail');
    const { useJournal } = await import('../state/journalStore');
    await useJournal.getState().load();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = () => root.render(createElement(JournalEntryDetail, { entry: useJournal.getState().entries[0] }));
    act(render);
    const unsub = useJournal.subscribe(() => act(render));
    const group = (rule: string) => host.querySelector<HTMLElement>(`[role="group"][aria-label="Did you follow your rule “${rule}”?"]`)!;
    const button = (rule: string, label: 'Followed' | 'Broke') => [...group(rule).querySelectorAll('button')].find((b) => b.textContent === label)!;
    const mark = (rule: string) => group(rule).closest('.rule-row')!.firstElementChild!.textContent;
    const stored = () => (db.get('r1') as JournalEntry).ruleChecks;

    // The app's own checks show their detail; yours ask, and show what you said before.
    expect(host.textContent).toContain('Use a stop lossStop at 99.00');
    expect(button('No revenge trades', 'Followed').getAttribute('aria-pressed')).toBe('true');
    expect(mark('No revenge trades')).toBe('✓');
    expect(button('Trade with the trend', 'Followed').getAttribute('aria-pressed')).toBe('false');
    expect(button('Trade with the trend', 'Broke').getAttribute('aria-pressed')).toBe('false');
    expect(mark('Trade with the trend')).toBe('–');

    act(() => button('Trade with the trend', 'Broke').click());
    expect(mark('Trade with the trend')).toBe('✗');
    await settle();
    expect(stored()).toEqual({ 'No revenge trades': true, 'Trade with the trend': false });

    // Another tab changed the other rule meanwhile: this answer leaves it alone.
    db.set('r1', { ...(db.get('r1') as JournalEntry), ruleChecks: { 'No revenge trades': false, 'Trade with the trend': false } });
    act(() => button('Trade with the trend', 'Followed').click());
    await settle();
    expect(stored()).toEqual({ 'No revenge trades': false, 'Trade with the trend': true });
    expect(button('Trade with the trend', 'Followed').getAttribute('aria-pressed')).toBe('true');

    act(() => button('Trade with the trend', 'Followed').click());
    await settle();
    expect(stored()).toEqual({ 'No revenge trades': false });
    expect(mark('Trade with the trend')).toBe('–');
    unsub();
    act(() => root.unmount());
  });

  it('are buttons at least 24 px tall with rows apart, and fingertip-sized on touch screens', () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');
    document.head.appendChild(style);
    document.body.innerHTML = '<div class="rule-row"><span class="seg own-rule"><button>Followed</button><button>Broke</button></span></div>';
    const button = document.querySelector('.own-rule button')!;
    expect(parseFloat(getComputedStyle(button).minHeight)).toBeGreaterThanOrEqual(24);
    // The space above and below keeps one rule's buttons from touching the next rule's.
    const seg = getComputedStyle(button.parentElement!);
    expect(parseFloat(seg.marginTop) + parseFloat(seg.marginBottom)).toBeGreaterThanOrEqual(4);
    const coarse = [...style.sheet!.cssRules].filter((r): r is CSSMediaRule => r instanceof CSSMediaRule && r.conditionText.includes('pointer: coarse'));
    const touch = coarse.flatMap((m) => [...m.cssRules]).find((r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText === '.seg.own-rule button');
    expect(touch?.style.minHeight).toBe('44px');
    style.remove();
  });

  it('ask before a Broke mark that would fail the rules challenge you are on, and change nothing if you cancel', async () => {
    const { reviewTrade, DEFAULT_TRADING_RULES } = await import('../../core/learning/review');
    const t = 1_700_000_000;
    const trip = {
      ...{ id: 'r2', symbol: 'AAPL', direction: 'long' as const, entryTime: t, exitTime: t + 600, maxQuantity: 10, avgEntry: 100, avgExit: 101, entryQtyTotal: 10, exitQtyTotal: 10 },
      ...{ pnl: 10, commission: 0, initialStop: 99, initialTarget: 102, highWhileOpen: 101, lowWhileOpen: 99.5, fills: [], closed: true, source: 'DEMO' as const },
    };
    const rules = { ...DEFAULT_TRADING_RULES, custom: ['Trade with the trend'] };
    const review = reviewTrade({ trip, fills: [], orders: [], revealedBars: [], timeframe: '1m', equityCurve: [], startingBalance: 25_000, allTrips: [trip], rules });
    db.set('r2', {
      ...{ id: 'r2', sessionId: 's9', mode: 'replay', source: 'DEMO', symbol: 'AAPL', direction: 'long', entryTime: t, exitTime: t + 600, stopLoss: 99, takeProfit: 102 },
      ...{ avgEntry: 100, avgExit: 101, quantity: 10, pnl: 10, returnPct: 1, holdingSeconds: 600, commission: 0, rewound: false, createdAt: 1 },
      ...{ tag: '', notes: { ...EMPTY_NOTES }, trip, review },
    });
    vi.resetModules();
    const { JournalEntryDetail } = await import('./JournalEntryDetail');
    const { useJournal } = await import('../state/journalStore');
    const { useTrading } = await import('../state/tradingStore');
    const { useChallenges } = await import('../state/challengeStore');
    await useJournal.getState().load();
    // The trade belongs to the running session, whose rules challenge is under way.
    useTrading.setState({ session: { id: 's9', mode: 'replay', source: 'DEMO', symbols: ['AAPL'], start: t, end: t + 3600, startDate: '2023-11-14', blind: false, label: 'AAPL' } });
    const result = { status: 'in_progress' as const, progress: 0, detail: '', official: true };
    useChallenges.getState().start({ id: 'a1', challengeId: 'rules-20', sessionId: 's9', startedAt: 1, label: 'AAPL', rules, result });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = () => root.render(createElement(JournalEntryDetail, { entry: useJournal.getState().entries[0] }));
    act(render);
    const unsub = useJournal.subscribe(() => act(render));
    const button = (label: 'Followed' | 'Broke') => [...host.querySelectorAll<HTMLButtonElement>('.own-rule button')].find((b) => b.textContent === label)!;
    const stored = () => (db.get('r2') as JournalEntry).ruleChecks;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    button('Broke').focus();
    act(() => button('Broke').click());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toBe('Marking “Trade with the trend” as broken fails your challenge “Complete 20 trades while following your rules”. A failed attempt cannot be undone.\n\nContinue?');
    await settle();
    expect(stored()).toBeUndefined();
    expect(button('Broke').getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(button('Broke'));

    // Followed fails nothing, so it is not asked about.
    act(() => button('Followed').click());
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual({ 'Trade with the trend': true });

    confirm.mockReturnValue(true);
    act(() => button('Broke').click());
    expect(confirm).toHaveBeenCalledTimes(2);
    await settle();
    expect(stored()).toEqual({ 'Trade with the trend': false });

    // Once that challenge is over, or for a trade of another session, a mark fails nothing and is not asked about.
    await useChallenges.getState().finishActive();
    act(() => button('Followed').click());
    act(() => button('Broke').click());
    expect(confirm).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
    unsub();
    act(() => root.unmount());
  });
});

describe('chart snapshot', () => {
  const t = 1_700_000_000;
  const base = {
    ...{ id: 't2', sessionId: 's1', mode: 'sim', source: 'SIMULATED', symbol: 'NOVA', direction: 'long', entryTime: t, exitTime: t + 600 },
    ...{ avgEntry: 100, avgExit: 99, quantity: 10, pnl: -10, returnPct: -1, holdingSeconds: 600, commission: 0, rewound: false, createdAt: 1 },
    ...{ tag: '', notes: { ...EMPTY_NOTES } },
  } as unknown as JournalEntry;

  /** The entry's detail once its snapshot (if any) has loaded. */
  async function show(entry: JournalEntry) {
    vi.resetModules();
    const { JournalEntryDetail } = await import('./JournalEntryDetail');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(JournalEntryDetail, { entry, showReview: false })));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    return { host, done: () => act(() => root.unmount()) };
  }

  it('says when a picture was drawn off screen, and that drawings are not on it', async () => {
    db.set('snap:t2', 'data:image/jpeg;base64,BB==');
    const v = await show({ ...base, snapshotKey: 'snap:t2', snapshotOffscreen: true });
    expect(v.host.querySelector('img.snapshot-img')?.getAttribute('src')).toBe('data:image/jpeg;base64,BB==');
    expect(v.host.querySelector('figcaption')?.textContent).toContain('NOVA was not on the chart when this trade closed');
    expect(v.host.querySelector('figcaption')?.textContent).toContain('Your drawings are not on it.');
    v.done();
  });

  it('has no caption on a picture of the chart on screen', async () => {
    db.set('snap:t2', 'data:image/jpeg;base64,AA==');
    const v = await show({ ...base, snapshotKey: 'snap:t2' });
    expect(v.host.querySelector('img.snapshot-img')).not.toBeNull();
    expect(v.host.querySelector('figcaption')).toBeNull();
    v.done();
  });

  it('says why there is no picture when the entry knows, and nothing on older entries', async () => {
    const off = await show({ ...base, snapshotMissing: 'off' });
    expect(off.host.textContent).toContain('No chart snapshot: snapshots were turned off');
    expect(off.host.querySelector('img')).toBeNull();
    off.done();
    const failed = await show({ ...base, snapshotMissing: 'failed' });
    expect(failed.host.textContent).toContain('No chart snapshot: the picture of the chart could not be drawn or saved');
    failed.done();
    const older = await show(base);
    expect(older.host.textContent).not.toContain('No chart snapshot');
    expect(older.host.querySelector('img')).toBeNull();
    older.done();
  });
});
