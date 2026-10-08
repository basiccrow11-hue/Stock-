// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { IndicatorMenu } from './IndicatorMenu';
import { DEFAULT_INDICATORS, useSettings } from '../state/settingsStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  useSettings.setState({ indicators: DEFAULT_INDICATORS.map((i) => ({ ...i })) });
});
afterEach(() => {
  document.body.innerHTML = '';
});

/** Type into a React-controlled input the way the browser does: set the value, fire input. */
function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function setup() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(IndicatorMenu)));
  act(() => host.querySelector<HTMLButtonElement>('button')!.click());
  // The first period box belongs to EMA 9 (volume, listed first, has none). Its name follows the period.
  const field = () => host.querySelector<HTMLInputElement>('input[type=number]')!;
  const period = () => useSettings.getState().indicators.find((i) => i.id === 'ema9')!.period;
  return { host, root, field, period };
}

describe('indicator settings', () => {
  it('lets periods be typed one digit at a time', () => {
    const { root, field, period } = setup();
    expect(period()).toBe(9);
    // "1" is below the minimum on its own: it stays in the box and is not applied.
    type(field(), '1');
    expect(field().value).toBe('1');
    expect(period()).toBe(9);
    type(field(), '14');
    expect(period()).toBe(14);
    expect(field().value).toBe('14');
    // Clearing the box and leaving it restores the value instead of applying the minimum.
    type(field(), '');
    act(() => field().dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(period()).toBe(14);
    expect(field().value).toBe('14');
    // Too small a value is raised to the minimum when the box is left.
    type(field(), '1');
    act(() => field().dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(period()).toBe(2);
    act(() => root.unmount());
  });

  it('names every control after its indicator', () => {
    const { host, root } = setup();
    const names = [...host.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label'));
    expect(names).toContain('Remove EMA 9');
    expect(names).toContain('EMA 21 colour');
    expect(names).toContain('EMA 21 period');
    expect(names.filter((n) => n === 'Period' || n === '✕')).toEqual([]);
    act(() => root.unmount());
  });
});
