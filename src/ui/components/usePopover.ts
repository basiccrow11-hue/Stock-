/**
 * Shared behaviour for toolbar popovers: one open at a time; close on a press outside, when focus
 * moves elsewhere, or on Escape (returning focus to the button that opened it); and keep the panel
 * on screen: shifted sideways, and scrolling inside when it is taller than the room below it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { modalOpen } from './common';

const MARGIN = 8;

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
    const place = () => {
      const pop = popRef.current;
      if (!pop) return;
      pop.style.left = '0px';
      const r = pop.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      let shift = 0;
      if (r.right > vw - MARGIN) shift = vw - MARGIN - r.right;
      if (r.left + shift < MARGIN) shift = MARGIN - r.left;
      pop.style.left = `${shift}px`;
      // A panel running past the bottom would make the whole app scroll (styles.css .popover).
      pop.style.setProperty('--pop-room', `${Math.max(240, document.documentElement.clientHeight - r.top - MARGIN)}px`);
    };
    place();
    window.addEventListener('resize', place);
    // The stacked layout scrolls the terminal, which moves the panel up or down.
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  return { open, toggle: () => (open ? close(false) : setOpen(true)), close, boxRef, triggerRef, popRef };
}
