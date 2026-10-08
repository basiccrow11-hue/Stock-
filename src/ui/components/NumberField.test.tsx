// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NumberField } from './common';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function leave(input: HTMLInputElement) {
  act(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
}

/** A setting that always holds a number, like those on the Settings page: an empty box is ignored. */
function setup(initial: number, min?: number, max?: number) {
  const saved: number[] = [];
  function Setting() {
    const [v, setV] = useState(initial);
    return createElement(NumberField, {
      label: 'Spread',
      value: v,
      min,
      max,
      onChange: (n: number | '') => {
        if (n === '') return;
        saved.push(n);
        setV(n);
      },
    });
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(Setting)));
  return { root, field: () => host.querySelector<HTMLInputElement>('input')!, saved };
}

describe('number fields', () => {
  it('can be emptied and retyped, instead of appending to the old value', () => {
    const { root, field, saved } = setup(2, 0);
    type(field(), '');
    expect(field().value).toBe('');
    type(field(), '3');
    expect(field().value).toBe('3');
    expect(saved).toEqual([3]);
    leave(field());
    expect(field().value).toBe('3');
    act(() => root.unmount());
  });

  it('shows the value again when left empty, and brings a number outside its range within it', () => {
    const { root, field, saved } = setup(25_000, 100, 1_000_000);
    type(field(), '');
    leave(field());
    expect(field().value).toBe('25000');
    expect(saved).toEqual([]);
    // Nothing outside the range is saved, even for a moment while typing.
    type(field(), '5');
    expect(saved).toEqual([]);
    leave(field());
    expect(field().value).toBe('100');
    type(field(), '5000000');
    leave(field());
    expect(field().value).toBe('1000000');
    expect(saved).toEqual([100, 1_000_000]);
    act(() => root.unmount());
  });
});
