/**
 * Shared behaviour for toolbar popovers: one open at a time; close on a press outside, when focus
 * moves elsewhere, or on Escape (returning focus to the button that opened it); and keep the panel
 * on screen: shifted sideways; when it does not fit below its button, the scrolling layout around
 * it (the phone terminal) moves up to make room, else it opens above when there is more room there;
 * whatever room it gets, it scrolls inside.
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
    /** `reveal`: may scroll the layout to fit the panel (on open and resize, never while the user scrolls). */
    const place = (reveal: boolean) => {
      const pop = popRef.current;
      const box = boxRef.current;
      if (!pop || !box) return;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      // Below the button, at its natural height (CSS caps it), to measure.
      pop.style.left = '0px';
      pop.style.top = '';
      pop.style.bottom = '';
      pop.style.removeProperty('--pop-room');
      const want = pop.offsetHeight;
      let top = pop.getBoundingClientRect().top;
      if (reveal && top + want > vh - MARGIN) {
        const scroller = scrollParent(box);
        if (scroller) {
          // Move up as far as needed, but never past the button or the end of the layout.
          const boxTop = box.getBoundingClientRect().top;
          const by = Math.min(top + want - (vh - MARGIN), boxTop - Math.max(0, scroller.getBoundingClientRect().top) - MARGIN, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
          if (by > 0) {
            scroller.scrollTop += by;
            top = pop.getBoundingClientRect().top;
          }
        }
      }
      const below = vh - top - MARGIN;
      const above = box.getBoundingClientRect().top - GAP - MARGIN;
      const up = want > below && above > below;
      if (up) {
        pop.style.top = 'auto';
        pop.style.bottom = `calc(100% + ${GAP}px)`;
      }
      // A panel running past the screen edge would make the whole app scroll (styles.css .popover).
      pop.style.setProperty('--pop-room', `${Math.max(0, up ? above : below)}px`);
      const r = pop.getBoundingClientRect();
      let shift = 0;
      if (r.right > vw - MARGIN) shift = vw - MARGIN - r.right;
      if (r.left + shift < MARGIN) shift = MARGIN - r.left;
      pop.style.left = `${shift}px`;
    };
    place(true);
    const onResize = () => place(true);
    // The stacked layout scrolls the terminal, which moves the panel up or down.
    const onScroll = () => place(false);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  return { open, toggle: () => (open ? close(false) : setOpen(true)), close, boxRef, triggerRef, popRef };
}
