// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { installNumberWheelGuard } from './numberWheel';

installNumberWheelGuard();
afterEach(() => {
  document.body.innerHTML = '';
});

const wheel = (el: Element, init: WheelEventInit = { deltaY: 100 }) => {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e.defaultPrevented;
};

describe('wheel over a number box', () => {
  it('never steps a focused number box, and scrolls its container instead', () => {
    document.body.innerHTML = '<div id="panel" style="overflow-y:auto"><input type="number" value="380"></div>';
    const panel = document.getElementById('panel')!;
    const input = document.querySelector('input')!;
    Object.defineProperties(panel, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
    input.focus();
    expect(wheel(input)).toBe(true);
    expect(panel.scrollTop).toBe(100);
    // Line-based wheels scroll by lines.
    expect(wheel(input, { deltaY: 3, deltaMode: 1 })).toBe(true);
    expect(panel.scrollTop).toBe(148);
    expect(input.value).toBe('380');
  });

  it('leaves everything else to the browser: unfocused boxes, other inputs, sideways scrolls and zoom', () => {
    document.body.innerHTML = '<input type="number" value="1"><input type="text" value="a">';
    const [num, text] = document.querySelectorAll('input');
    expect(wheel(num)).toBe(false);
    text.focus();
    expect(wheel(text)).toBe(false);
    num.focus();
    expect(wheel(num, { deltaX: 50 })).toBe(false);
    expect(wheel(num, { deltaY: 100, ctrlKey: true })).toBe(false);
  });
});
