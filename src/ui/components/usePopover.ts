/**
 * Shared behaviour for toolbar popovers: close on a press outside or on Escape (returning focus to
 * the button that opened it), and shift the panel sideways so it never runs off the screen.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const MARGIN = 8;

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
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
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
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  return { open, toggle: () => (open ? close(false) : setOpen(true)), close, boxRef, triggerRef, popRef };
}
