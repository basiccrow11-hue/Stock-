/** What the README says about layout and loading that follows from the code, checked against it. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STACKED } from './components/useBottomDock';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const readme = read('../../README.md');
/** The README's paragraph that starts with the bold `title`. */
const paragraph = (title: string) => readme.split('\n').find((line) => line.startsWith(`**${title}.**`)) ?? '';

const css = read('../styles.css');
/** The rules styles.css gives the one-column layout of phones (STACKED, as ChartView and useBottomDock use it). */
function stackedRules(): string {
  const start = css.indexOf(`@media ${STACKED} {`);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error('unclosed @media block');
}

describe('the README', () => {
  it('says how much backtest warm-up history is loaded at a time', () => {
    const chunk = Number(/const WARMUP_CHUNK_DAYS = (\d+);/.exec(read('./pages/BacktestPage.tsx'))?.[1]);
    expect(chunk).toBe(50);
    expect(paragraph('Backtester')).toContain(`loaded ${chunk} trading days (about ten weeks) at a time, newest first`);
  });

  it('places the drawing tools, the panel’s resize edge and the submit button as each layout does', () => {
    const stacked = stackedRules();
    // Wider screens: the drawing tools are a column at the chart's left edge. One column: a row above it.
    expect(css).toMatch(/\n\.draw-tools \{[^}]*flex-direction: column;/);
    expect(stacked).toMatch(/\.draw-tools \{[^}]*flex-direction: row;/);
    const chart = paragraph('Chart');
    expect(chart).toContain('There the drawing tools are a row above the chart');
    expect(chart).toContain("On other screens the drawing tools are a narrow column at the chart's left edge");
    expect(chart).not.toContain('left edge, so the toolbar keeps to one row');
    // The bottom panel has no resize edge in the column, and the submit button does not stick there.
    expect(stacked).toMatch(/\.dock-resize \{ display: none; \}/);
    expect(chart).toContain('Outside the one scrolling column, drag its top edge to resize it');
    expect(stacked).toMatch(/\.ticket-submit \{ position: static;/);
    expect(paragraph('Orders')).toContain('stays in view at the bottom of the column while the rest of the ticket scrolls, except on a phone');
  });
});
