/**
 * Shared behaviour for toolbar popovers: one open at a time; close on a press outside, when focus
 * moves elsewhere, or on Escape (returning focus to the button that opened it); and keep the panel
 * on screen: shifted sideways; when it does not fit below its button, the scrolling layout around
 * it (the phone terminal) moves up to make room, else it opens above when there is more room there;
 * whatever room it gets, it scrolls inside. Room is measured inside whatever clips the panel (the
 * terminal's scroll box, not just the window), and the side it opens on is chosen only on open and
 * resize, never while the user scrolls.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { modalOpen } from './common';

const MARGIN = 8;
/** Space between the button row and the panel (styles.css .popover top is the row height plus this). */
const GAP = 4;

/** The nearest ancestor the user can scroll vertically, if any. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** The part of the window `el` can be seen in: the viewport cut by every ancestor that clips. */
function visibleBand(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = document.documentElement.clientHeight;
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (getComputedStyle(p).overflowY === 'visible') continue;
    const r = p.getBoundingClientRect();
    top = Math.max(top, r.top + p.clientTop);
    bottom = Math.min(bottom, r.top + p.clientTop + p.clientHeight);
  }
  return { top, bottom };
}

/** Closes the popover that is currently open, if any. */
let closeOpen: (() => void) | null = null;

export function usePopover() {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  /** Close; `refocus` returns keyboard focus to the trigger (not wanted when the user clicked elsewhere). */
  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const mine = () => close(false);
    closeOpen?.();
    closeOpen = mine;
    const box = boxRef.current;
    const onDown = (e: PointerEvent) => {
      if (box && !box.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // A dialog that opened on top (a trade review) handles its own Escape. Otherwise Escape closes
      // the popover and nothing else: this runs first (capture phase) and marks the key as used, so
      // chart shortcuts behind it (reset the drawing tool, cancel a price pick) stand down.
      if (e.key === 'Escape' && !modalOpen() && !e.defaultPrevented) {
        e.preventDefault();
        close(true);
      }
    };
    // Tabbing out of the panel closes it, so two popovers never overlap. Focus that moves to an
    // ancestor (a click on plain text in the panel focuses the terminal around it) is not leaving.
    const onFocusOut = (e: FocusEvent) => {
      const to = e.relatedTarget;
      if (to instanceof Node && box && !box.contains(to) && !to.contains(box)) close(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    box?.addEventListener('focusout', onFocusOut);
    return () => {
      if (closeOpen === mine) closeOpen = null;
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
      box?.removeEventListener('focusout', onFocusOut);
    };
  }, [open, close]);

  useLayoutEffect(() => {
    if (!open) return;
    /** Whether the panel opened above its button. */
    let up = false;
    /** Room for the panel on its side of the button. A panel running past it would make the layout scroll (styles.css .popover). */
    const room = (pop: HTMLElement, box: HTMLElement) => {
      const band = visibleBand(pop);
      return Math.max(0, up ? box.getBoundingClientRect().top - GAP - MARGIN - band.top : band.bottom - MARGIN - pop.getBoundingClientRect().top);
    };
    /** Choose the side and size, and scroll the layout to make room if needed. On open and resize only. */
    const place = () => {
      const pop = popRef.current;
      const box = boxRef.current;
      if (!pop || !box) return;
      const vw = document.documentElement.clientWidth;
      // Below the button, at its natural height (CSS caps it), to measure. Measuring drops the
      // panel's own scroll position, which is put back below.
      const scrolled = pop.scrollTop;
      pop.style.left = '0px';
      pop.style.top = '';
      pop.style.bottom = '';
      pop.style.removeProperty('--pop-room');
      const want = pop.offsetHeight;
      let band = visibleBand(pop);
      const top = pop.getBoundingClientRect().top;
      if (top + want > band.bottom - MARGIN) {
        const scroller = scrollParent(box);
        if (scroller) {
          // Move up as far as needed, but never past the button or the end of the layout.
          const by = Math.min(top + want - (band.bottom - MARGIN), box.getBoundingClientRect().top - band.top - MARGIN, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
          if (by > 0) {
            scroller.scrollTop += by;
            band = visibleBand(pop);
          }
        }
      }
      const boxTop = box.getBoundingClientRect().top;
      const below = band.bottom - MARGIN - pop.getBoundingClientRect().top;
      const above = boxTop - GAP - MARGIN - band.top;
      up = want > below && above > below;
      if (up) {
        pop.style.top = 'auto';
        pop.style.bottom = `calc(100% + ${GAP}px)`;
      }
      pop.style.setProperty('--pop-room', `${room(pop, box)}px`);
      pop.scrollTop = scrolled;
      const r = pop.getBoundingClientRect();
      let shift = 0;
      if (r.right > vw - MARGIN) shift = vw - MARGIN - r.right;
      if (r.left + shift < MARGIN) shift = MARGIN - r.left;
      pop.style.left = `${shift}px`;
    };
    place();
    const onResize = () => {
      place();
      // A field being edited stays in view when the window shrinks (an on-screen keyboard opening).
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && popRef.current?.contains(focused)) focused.scrollIntoView({ block: 'nearest' });
    };
    // The stacked layout scrolls the terminal, which moves the panel up or down: keep it inside
    // what can be seen, on the same side. The panel's own scrolling changes nothing.
    const onScroll = (e: Event) => {
      const pop = popRef.current;
      const box = boxRef.current;
      if (!pop || !box || (e.target instanceof Node && pop.contains(e.target))) return;
      pop.style.setProperty('--pop-room', `${room(pop, box)}px`);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  return { open, toggle: () => (open ? close(false) : setOpen(true)), close, boxRef, triggerRef, popRef };
}
