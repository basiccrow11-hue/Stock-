// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EMPTY_NOTES, type JournalEntry } from '../../core/journal';

/** IndexedDB stand-in, so journal notes saved from the panel can be read back. */
const db = new Map<string, unknown>();
vi.mock('../services/idb', () => ({
  idb: {
    all: async () => [...db.values()].map((v) => structuredClone(v)),
    get: async (_s: string, k: string) => structuredClone(db.get(k)),
    set: async (_s: string, k: string, v: unknown) => void db.set(k, structuredClone(v)),
    delete: async (_s: string, k: string) => void db.delete(k),
    modify: async (_s: string, k: string, fn: (v: unknown) => unknown) => {
      const next = fn(structuredClone(db.get(k)));
      if (next !== undefined) db.set(k, structuredClone(next));
      return next;
    },
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 'stock-replay-bottom-panel';
const realMatchMedia = window.matchMedia;
const realRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(async () => {
  const store = await import('../state/tradingStore');
  await store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 1 });
  // jsdom has no layout: the panel is as tall as its --bottom-h says, else 200px, as styles.css would make it.
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (!this.classList.contains('area-bottom')) return realRect.call(this);
    return new DOMRect(0, 0, 1000, parseFloat(this.style.getPropertyValue('--bottom-h')) || 200);
  };
});

afterEach(async () => {
  const store = await import('../state/tradingStore');
  await store.endSession();
  HTMLElement.prototype.getBoundingClientRect = realRect;
  window.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
  db.clear();
});

/** Window media queries: those listed match, the rest do not. */
function screenMatches(...queries: string[]) {
  window.matchMedia = ((q: string) => ({ matches: queries.includes(q), media: q, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
}

async function mount(onOpenJournal: (id: string) => void = () => undefined) {
  const { BottomPanel } = await import('./BottomPanel');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  act(() => root.render(createElement(BottomPanel, { onOpenJournal })));
  const panel = host.querySelector<HTMLElement>('.area-bottom')!;
  const toggle = host.querySelector<HTMLButtonElement>('button.dock-toggle')!;
  const handle = () => host.querySelector<HTMLElement>('[role="separator"]');
  const body = () => document.getElementById(toggle.getAttribute('aria-controls')!)!;
  const tab = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.tabs button')].find((b) => b.textContent!.startsWith(label))!;
  const stored = () => JSON.parse(localStorage.getItem(KEY) ?? 'null') as { height?: number; collapsed?: boolean } | null;
  return { host, panel, toggle, handle, body, tab, stored, unmount: () => act(() => root.unmount()) };
}

const press = (el: Element, key: string, shiftKey = false) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })));
const click = (el: Element) => act(() => void (el as HTMLElement).click());

describe('the bottom panel', () => {
  it('collapses to its tabs and expands again, says which it is, and remembers it', async () => {
    const p = await mount();
    expect(p.toggle.getAttribute('aria-expanded')).toBe('true');
    expect(p.body().hidden).toBe(false);
    expect(p.handle()).not.toBeNull();

    click(p.toggle);
    expect(p.toggle.getAttribute('aria-expanded')).toBe('false');
    expect(p.body().hidden).toBe(true);
    expect(p.panel.classList.contains('collapsed')).toBe(true);
    expect(p.handle()).toBeNull();
    expect(p.host.querySelectorAll('.tabs [aria-pressed="true"]')).toHaveLength(0);
    expect(p.stored()).toEqual({ collapsed: true });
    p.unmount();

    // After a reload it is still collapsed; picking a tab opens it on that tab.
    const again = await mount();
    expect(again.toggle.getAttribute('aria-expanded')).toBe('false');
    click(again.tab('Fills'));
    expect(again.toggle.getAttribute('aria-expanded')).toBe('true');
    expect(again.tab('Fills').getAttribute('aria-pressed')).toBe('true');
    expect(again.body().textContent).toContain('No fills yet');
    expect(again.stored()).toEqual({ collapsed: false });
    again.unmount();
  });

  it('starts collapsed on a short laptop screen until the user opens it, but not in the one-column layout', async () => {
    const { SHORT_SCREEN, STACKED } = await import('./useBottomDock');
    screenMatches(SHORT_SCREEN);
    const laptop = await mount();
    expect(laptop.toggle.getAttribute('aria-expanded')).toBe('false');
    laptop.unmount();

    // A phone held sideways is short too, but there the page scrolls and the panel stays open.
    screenMatches(SHORT_SCREEN, STACKED);
    const phone = await mount();
    expect(phone.toggle.getAttribute('aria-expanded')).toBe('true');
    // It has a fixed height there, so there is nothing to resize.
    expect(phone.handle()).toBeNull();
    phone.unmount();

    // Once opened on the laptop, it stays open there.
    screenMatches(SHORT_SCREEN);
    const opened = await mount();
    click(opened.toggle);
    opened.unmount();
    const reloaded = await mount();
    expect(reloaded.toggle.getAttribute('aria-expanded')).toBe('true');
    reloaded.unmount();
  });

  it('resizes from the keyboard within its limits and keeps the height', async () => {
    const p = await mount();
    const handle = p.handle()!;
    const h = () => p.panel.style.getPropertyValue('--bottom-h');
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal');
    expect(handle.getAttribute('aria-label')).toBe('Resize the trading activity panel');
    expect(handle.getAttribute('aria-valuemin')).toBe('96');
    // jsdom's window is 768px tall: the chart column keeps 340px of it.
    expect(handle.getAttribute('aria-valuemax')).toBe('428');
    expect(h()).toBe('');

    press(handle, 'ArrowUp');
    expect(h()).toBe('216px');
    press(handle, 'ArrowUp', true);
    expect(h()).toBe('280px');
    press(handle, 'PageDown');
    expect(h()).toBe('216px');
    press(handle, 'ArrowDown');
    expect(h()).toBe('200px');
    press(handle, 'Home');
    expect(h()).toBe('96px');
    press(handle, 'ArrowDown');
    expect(h()).toBe('96px');
    press(handle, 'End');
    expect(h()).toBe('428px');
    press(handle, 'PageUp');
    expect(h()).toBe('428px');
    expect(p.stored()).toEqual({ height: 428 });

    // Other keys are left alone (Space still plays and pauses the replay).
    const space = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    act(() => void handle.dispatchEvent(space));
    expect(space.defaultPrevented).toBe(false);
    p.unmount();

    const again = await mount();
    expect(again.panel.style.getPropertyValue('--bottom-h')).toBe('428px');
    // Collapsed, the panel is only its tabs, whatever height was chosen.
    click(again.toggle);
    expect(again.panel.style.getPropertyValue('--bottom-h')).toBe('');
    again.unmount();
  });

  it('works when storage is blocked, and ignores a malformed stored value', async () => {
    localStorage.setItem(KEY, '{"height":"tall","collapsed":"yes"}');
    const junk = await mount();
    expect(junk.toggle.getAttribute('aria-expanded')).toBe('true');
    expect(junk.panel.style.getPropertyValue('--bottom-h')).toBe('');
    junk.unmount();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    expect(() => localStorage.setItem(KEY, '{}')).toThrow();
    const blocked = await mount();
    click(blocked.toggle);
    expect(blocked.toggle.getAttribute('aria-expanded')).toBe('false');
    click(blocked.toggle);
    press(blocked.handle()!, 'End');
    expect(blocked.panel.style.getPropertyValue('--bottom-h')).toBe('428px');
    blocked.unmount();
  });

  it('lists this session’s journal entries in its Journal tab, with notes written in place', async () => {
    const store = await import('../state/tradingStore');
    const { useJournal } = await import('../state/journalStore');
    const session = store.useTrading.getState().session!;
    const t = store.useTrading.getState().now;
    const entry = (id: string, sessionId: string, symbol: string, pnl: number, exit: number): JournalEntry => {
      const e: Omit<JournalEntry, 'trip'> = {
        ...{ id, sessionId, mode: 'sim', source: 'SIMULATED', symbol, direction: 'long', entryTime: exit - 600, exitTime: exit },
        ...{ avgEntry: 100, avgExit: 101, quantity: 10, pnl, returnPct: 1, holdingSeconds: 600, commission: 0, rewound: false, createdAt: 1 },
        ...{ tag: '', notes: { ...EMPTY_NOTES } },
      };
      // Without the round trip, which the tab does not use.
      return e as JournalEntry;
    };
    for (const e of [entry('a', session.id, 'AAA', 10, t - 60), entry('b', session.id, 'BBB', -5, t), entry('old', 'an-earlier-session', 'OLD', 3, t - 30)]) db.set(e.id, e);
    await act(() => useJournal.getState().load());

    const opened: string[] = [];
    const p = await mount((id) => opened.push(id));
    expect(p.tab('Journal').textContent).toBe('Journal2');
    click(p.tab('Journal'));
    const rows = () => [...p.body().querySelectorAll<HTMLTableRowElement>('.dock-journal-list tr')];
    // Newest first, and only this session's.
    expect(rows().map((r) => r.querySelector('b')!.textContent)).toEqual(['BBB', 'AAA']);
    expect(rows()[0].getAttribute('aria-current')).toBe('true');
    expect(p.body().querySelector('.dock-journal-notes b')!.textContent).toBe('Long BBB');

    // Enter on a row picks it, as a click does.
    rows()[1].focus();
    press(rows()[1], 'Enter');
    expect(rows()[1].getAttribute('aria-current')).toBe('true');
    expect(p.body().querySelector('.dock-journal-notes b')!.textContent).toBe('Long AAA');

    const why = [...p.body().querySelectorAll('label')].find((l) => l.textContent!.startsWith('Why did I enter?'))!.querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(why, 'opening range breakout');
      why.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(() => new Promise((r) => setTimeout(r, 900)));
    expect((db.get('a') as JournalEntry).notes.why).toBe('opening range breakout');
    expect(rows()[1].textContent).toContain('Notes');
    expect(rows()[0].textContent).toContain('No notes yet');

    click([...p.body().querySelectorAll('button')].find((b) => b.textContent === 'Open in Journal')!);
    expect(opened).toEqual(['a']);
    p.unmount();
  });
});
