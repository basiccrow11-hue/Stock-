// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { journalEntryFromTrip, type JournalEntry } from '../../core/journal';
import type { RoundTrip } from '../../core/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../services/idb', () => ({
  idb: { all: async () => [], set: async () => undefined, delete: async () => undefined, get: async () => undefined, modify: async () => undefined },
}));

afterEach(() => {
  document.body.innerHTML = '';
});

let n = 0;
/** A closed one-share trade of session `sessionId`, journaled (`blind`: in blind mode). */
function entry(sessionId: string, blind: boolean): JournalEntry {
  const t = 1_710_252_000 + n * 600;
  const trip: RoundTrip = {
    ...{ id: `t${++n}`, symbol: 'SPY', direction: 'long', entryTime: t, exitTime: t + 300, maxQuantity: 1, avgEntry: 100, avgExit: 101 },
    ...{ entryQtyTotal: 1, exitQtyTotal: 1, pnl: 1, commission: 0, highWhileOpen: 101, lowWhileOpen: 99, fills: [], closed: true, source: 'DEMO' },
  };
  return journalEntryFromTrip(trip, { sessionId, mode: 'replay', rewound: false, blind });
}

/** The Journal page over `entries`, with the blind sessions whose dates are still hidden (start dates by id). */
async function mount(entries: JournalEntry[], hidden: Record<string, string>) {
  const { JournalPage } = await import('./JournalPage');
  const { useJournal } = await import('../state/journalStore');
  const { useLiveBlind } = await import('../state/liveBlind');
  useJournal.setState({ entries, loaded: true });
  useLiveBlind.setState({ sessions: hidden });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(JournalPage, { focusId: null })));
  const note = () => [...host.querySelectorAll('span')].map((s) => s.textContent).find((s) => s?.startsWith('Exports'));
  return { note, done: () => act(() => root.unmount()) };
}

describe('the journal’s exports', () => {
  it('say how many trades they leave out until their blind sessions end, running or saved, one or several', async () => {
    let v = await mount([entry('a', true), entry('b', true), entry('b', true), entry('c', false)], { a: '2024-03-12', b: '2024-05-01' });
    expect(v.note()).toBe('Exports leave out 3 trades until their blind sessions end.');
    v.done();
    v = await mount([entry('a', true), entry('a', true), entry('c', false)], { a: '2024-03-12' });
    expect(v.note()).toBe('Exports leave out 2 trades until their blind session ends.');
    v.done();
    v = await mount([entry('a', true), entry('c', false)], { a: '2024-03-12' });
    expect(v.note()).toBe('Exports leave out 1 trade until its blind session ends.');
    v.done();
    // A blind session that has ended leaves nothing out.
    v = await mount([entry('a', true), entry('c', false)], {});
    expect(v.note()).toBeUndefined();
    v.done();
  });
});
