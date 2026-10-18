// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Drawing } from './drawings';

const line = (id: string, price = 100): Drawing => ({ id, type: 'hline', points: [{ time: 1, price }], color: '#fff' });
const KEY = 'stock-replay-drawings:';

/** The drawings store as a freshly opened tab has it. */
async function tab() {
  vi.resetModules();
  return (await import('./drawings')).useDrawings;
}

/** Another open tab of the app saving `symbol`'s drawings (as its edits and restores do), or clearing storage (null). */
function otherTabSaves(symbol: string | null, list: Drawing[] = []) {
  if (symbol === null) localStorage.clear();
  else localStorage.setItem(KEY + symbol, JSON.stringify(list));
  window.dispatchEvent(new StorageEvent('storage', { key: symbol === null ? null : KEY + symbol }));
}

const ids = (list: Drawing[]) => list.map((d) => d.id);
const stored = (symbol: string) => ids(JSON.parse(localStorage.getItem(KEY + symbol) ?? '[]') as Drawing[]);

beforeEach(() => localStorage.clear());

describe('drawings changed in another tab', () => {
  it('are taken in for the symbol shown, so the next drawing here keeps them', async () => {
    const drawings = await tab();
    drawings.getState().setSymbol('TSLA');
    // A backup restored in the other tab adds two.
    otherTabSaves('TSLA', [line('d1'), line('d2')]);
    expect(ids(drawings.getState().drawings)).toEqual(['d1', 'd2']);
    drawings.getState().add(line('d3'));
    expect(stored('TSLA')).toEqual(['d1', 'd2', 'd3']);
    // Moved there, then removed here: the move is kept.
    otherTabSaves('TSLA', [line('d1', 120), line('d2'), line('d3')]);
    drawings.getState().remove('d2');
    expect(JSON.parse(localStorage.getItem(`${KEY}TSLA`)!)).toEqual([line('d1', 120), line('d3')]);
  });

  it('keep the selection only while the selected drawing is still there', async () => {
    const drawings = await tab();
    drawings.getState().setSymbol('TSLA');
    drawings.getState().add(line('d1'));
    drawings.getState().add(line('d2'));
    expect(drawings.getState().selectedId).toBe('d2');
    otherTabSaves('TSLA', [line('d1', 90), line('d2')]);
    expect(drawings.getState().selectedId).toBe('d2');
    otherTabSaves('TSLA', [line('d1', 90)]);
    expect(drawings.getState()).toMatchObject({ drawings: [line('d1', 90)], selectedId: null });
  });

  it('of another symbol leave the shown one alone, and storage cleared in another tab clears them here too', async () => {
    const drawings = await tab();
    drawings.getState().setSymbol('TSLA');
    drawings.getState().add(line('d1'));
    const before = drawings.getState().drawings;
    otherTabSaves('AAPL', [line('a1')]);
    expect(drawings.getState().drawings).toBe(before);
    drawings.getState().setSymbol('AAPL');
    expect(ids(drawings.getState().drawings)).toEqual(['a1']);
    otherTabSaves(null);
    expect(drawings.getState()).toMatchObject({ drawings: [], selectedId: null });
    drawings.getState().add(line('a2'));
    expect(stored('AAPL')).toEqual(['a2']);
  });
});
