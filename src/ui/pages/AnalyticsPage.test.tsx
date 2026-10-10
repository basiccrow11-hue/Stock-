// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { journalEntryFromTrip, type JournalEntry } from '../../core/journal';
import type { DataSourceKind, RoundTrip } from '../../core/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../services/idb', () => ({
  idb: { all: async () => [], set: async () => undefined, delete: async () => undefined, get: async () => undefined, modify: async () => undefined },
}));
// The equity curve needs a canvas; its numbers are what is tested here.
vi.mock('../chart/LineChart', () => ({ LineChart: () => null }));

afterEach(() => {
  document.body.innerHTML = '';
});

let n = 0;
/** A closed one-share trade from `source` that made `pnl`, journaled. */
function entry(source: DataSourceKind, pnl: number): JournalEntry {
  const t = 1_710_000_000 + n * 3600;
  const trip: RoundTrip = {
    ...{ id: `t${++n}`, symbol: 'SPY', direction: 'long', entryTime: t, exitTime: t + 600, maxQuantity: 1, avgEntry: 100, avgExit: 100 + pnl },
    ...{ entryQtyTotal: 1, exitQtyTotal: 1, pnl, commission: 0, highWhileOpen: 101, lowWhileOpen: 99, fills: [], closed: true, source },
  };
  return journalEntryFromTrip(trip, { sessionId: `s-${source}`, mode: source === 'SIMULATED' ? 'sim' : 'replay', rewound: false });
}

async function mount(entries: JournalEntry[]) {
  const { AnalyticsPage } = await import('./AnalyticsPage');
  const { useJournal } = await import('../state/journalStore');
  useJournal.setState({ entries, loaded: true });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(AnalyticsPage)));
  /** The journal card's stat values by label. */
  const stat = (k: string) => [...host.querySelectorAll('.stat')].find((s) => s.querySelector('.k')?.textContent === k)?.querySelector('.v')?.textContent;
  const rows = () => [...host.querySelectorAll('table')].find((t) => t.querySelector('th')?.textContent === 'Source');
  const pick = (value: string) =>
    act(() => {
      const select = host.querySelector<HTMLSelectElement>('select[aria-label="Data source"]')!;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  return { host, stat, rows, pick, done: () => act(() => root.unmount()) };
}

describe('analytics over several data sources', () => {
  it('says which sources are added together and shows each on its own', async () => {
    const v = await mount([entry('HISTORICAL', 50), entry('HISTORICAL', -20), entry('DEMO', 30), entry('SIMULATED', -10), entry('SIMULATED', -5), entry('SIMULATED', 40)]);
    const note = v.host.querySelector('.alert')!;
    expect(note.textContent).toContain('This view adds together trades from 3 data sources:');
    expect([...note.querySelectorAll('.badge')].map((b) => b.className)).toEqual(['badge HISTORICAL', 'badge DEMO', 'badge SIMULATED']);
    expect(note.textContent).toContain('Their prices are real, synthetic and fictional');
    const table = v.rows()!;
    expect([...table.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['Source', 'Trades', 'Won', 'Lost', 'Win %', 'Avg R', 'Profit factor', 'Expectancy', 'Net P/L']);
    const cells = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
    expect(cells.map((c) => c.slice(0, 5))).toEqual([
      ['HISTORICAL DATA', '2', '1', '1', '50.0%'],
      ['DEMO DATA · SYNTHETIC', '1', '1', '0', '100.0%'],
      ['SIMULATED · FICTIONAL', '3', '1', '2', '33.3%'],
    ]);
    expect(cells.map((c) => c[6])).toEqual(['2.50', '∞ (no losses)', '2.67']);
    expect(cells.map((c) => c[8])).toEqual(['+$30.00', '+$30.00', '+$25.00']);
    // The combined numbers below say how many won and lost.
    expect([v.stat('Trades'), v.stat('Winning trades'), v.stat('Losing trades'), v.stat('Breakeven trades')]).toEqual(['6 (6L / 0S)', '3', '3', undefined]);

    // One source picked: no mix to explain, only which source it is.
    v.pick('DEMO');
    expect(v.host.querySelector('.alert')).toBeNull();
    expect(v.rows()).toBeUndefined();
    expect(v.host.textContent).toContain('Data source:');
    expect([...v.host.querySelectorAll('.card .badge')].map((b) => b.className)).toEqual(['badge DEMO']);
    expect([v.stat('Trades'), v.stat('Winning trades'), v.stat('Losing trades')]).toEqual(['1 (1L / 0S)', '1', '0']);
    v.done();
  });

  it('counts breakeven trades, and adds a column for them, only when there are some', async () => {
    const v = await mount([entry('HISTORICAL', 10), entry('HISTORICAL', 0), entry('DEMO', -10)]);
    expect([v.stat('Winning trades'), v.stat('Losing trades'), v.stat('Breakeven trades')]).toEqual(['1', '1', '1']);
    expect([...v.rows()!.querySelectorAll('th')].map((th) => th.textContent)).toContain('Breakeven');
    expect([...v.rows()!.querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('td')[4].textContent)).toEqual(['1', '0']);
    v.done();
  });

  it('lets a section heading wrap, so the current session’s source badge stays inside its card on a narrow phone', async () => {
    // The badge never breaks its words: on a 320px phone the heading, the session's name and the badge
    // only fit on two lines. jsdom has no layout, so this checks the rule that allows the second line.
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../styles.css'), 'utf8');
    document.head.appendChild(style);
    const store = await import('../state/tradingStore');
    await store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 1 });
    const v = await mount([]);
    try {
      const badge = v.host.querySelector('.section-title .badge.SIMULATED')!;
      expect(badge.closest('.section-title')!.textContent).toContain('Current session');
      expect(getComputedStyle(badge).whiteSpace).toBe('nowrap');
      // The page's other heading wraps too: one rule serves every section heading, the journal's as well.
      const titles = [...v.host.querySelectorAll('.section-title')];
      expect(titles).toHaveLength(2);
      for (const title of titles) expect(getComputedStyle(title).flexWrap).toBe('wrap');
    } finally {
      v.done();
      await store.endSession();
      style.remove();
    }
  });
});
