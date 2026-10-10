// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ChartLegend, type LegendModel, type LegendSource } from './ChartLegend';
import { indicatorName } from './chartParts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = '';
});

const bar = { time: 1_736_951_400, open: 100, high: 101.5, low: 99.25, close: 101, volume: 12_500 };

function model(over: Partial<LegendModel> = {}): LegendModel {
  return {
    symbol: 'AAPL',
    timeframe: '5m',
    bar,
    prevClose: 100,
    dayLabel: null,
    overlays: [{ id: 'ema9', name: 'EMA 9', values: [{ text: '100.40', color: '#f5a623' }] }],
    panes: [{ id: 'rsi', name: 'RSI 14', values: [{ text: '55.10', color: '#b39ddb' }], top: 300 }],
    note: null,
    compact: false,
    right: 120,
    ...over,
  };
}

/** A source the test changes as the chart would: a new model, then a new version. */
function source(initial: LegendModel | null) {
  let current = initial;
  let version = 0;
  const listeners = new Set<() => void>();
  const s: LegendSource = {
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    version: () => version,
    read: () => current,
  };
  const set = (m: LegendModel | null) => {
    current = m;
    version++;
    for (const fn of listeners) fn();
  };
  return { s, set };
}

function render(s: LegendSource): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => createRoot(host).render(createElement(ChartLegend, { source: s })));
  return host;
}

describe('chart legend', () => {
  it('shows the candle, each overlay by name with its value in its colour, and a title at the top of each lower pane', () => {
    const { s } = source(model({ note: 'Loading earlier history…' }));
    const host = render(s);
    const [main, pane] = [...host.querySelectorAll<HTMLElement>('.chart-legend')];
    expect(main.querySelector('.legend-row')!.textContent).toBe('AAPL5mO 100.00H 101.50L 99.25C 101.00V 12.5K+1.00%');
    const ema = main.querySelector('.legend-ind')!;
    expect(ema.querySelector('.legend-name')!.textContent).toBe('EMA 9');
    expect(ema.querySelector('b')!.textContent).toBe('100.40');
    expect(ema.querySelector('b')!.style.color).toBe('rgb(245, 166, 35)');
    expect(main.querySelector('.legend-note')!.textContent).toBe('Loading earlier history…');
    // Clear of the price axis and the names on its labels.
    expect(main.style.maxWidth).toBe('calc(100% - 120px)');
    expect(pane.classList.contains('pane-legend')).toBe(true);
    expect(pane.style.top).toBe('304px');
    expect(pane.textContent).toBe('RSI 1455.10');
  });

  it('follows the chart without the chart re-rendering it, and flows compactly when asked', () => {
    const { s, set } = source(model());
    const host = render(s);
    act(() => set(model({ bar: { ...bar, close: 99 }, compact: true, overlays: [{ id: 'ema9', name: 'EMA 9', values: [{ text: '—', color: '#f5a623' }] }] })));
    const main = host.querySelector<HTMLElement>('.chart-legend')!;
    expect(main.classList.contains('compact')).toBe(true);
    expect(main.querySelector('.legend-row')!.textContent).toContain('C 99.00');
    expect(main.querySelector('.legend-row')!.textContent).toContain('-1.00%');
    expect(main.querySelector('.legend-ind b')!.textContent).toBe('—');
    act(() => set(null));
    expect(host.innerHTML).toBe('');
  });
});

describe('indicator names', () => {
  it('carry their parameters, with the defaults the chart computes when a saved indicator has none', () => {
    const name = (cfg: object) => indicatorName({ id: 'x', enabled: true, color: '#fff', ...cfg } as Parameters<typeof indicatorName>[0]);
    expect(name({ type: 'ema', period: 9 })).toBe('EMA 9');
    expect(name({ type: 'sma' })).toBe('SMA 20');
    expect(name({ type: 'rsi' })).toBe('RSI 14');
    expect(name({ type: 'bb', period: 20, mult: 2 })).toBe('BB 20 2');
    expect(name({ type: 'macd' })).toBe('MACD 12 26 9');
    expect(name({ type: 'vwap' })).toBe('VWAP');
    expect(name({ type: 'volume' })).toBe('Volume');
  });
});
