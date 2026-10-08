// @vitest-environment jsdom
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
