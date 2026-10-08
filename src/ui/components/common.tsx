import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { DataSourceKind } from '../../core/types';
import { useToasts } from '../state/toasts';

/** Open modals, innermost last. Only the topmost one reacts to Escape and traps Tab. */
const modalStack: { id: string; el: HTMLElement }[] = [];
const modalListeners = new Set<() => void>();

function modalsChanged(): void {
  for (const l of modalListeners) l();
}

/** True while any modal dialog is open (global shortcuts stand down). */
export function modalOpen(): boolean {
  return modalStack.length > 0;
}

/**
 * Whether a global shortcut should leave this key alone: a dialog or a toolbar menu is open (focus
 * can stay on the menu's button, or nowhere), a dialog or popover has already handled it (Escape),
 * or focus is in a text field, a dialog or a popover.
 */
export function keyBelongsElsewhere(e: KeyboardEvent): boolean {
  if (modalOpen() || e.defaultPrevented || document.querySelector('.popover')) return true;
  const el = e.target instanceof Element ? e.target : null;
  return !!el?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], .popover');
}

/** Number of open modal dialogs, as React state. */
export function useModalCount(): number {
  return useSyncExternalStore(
    (l) => {
      modalListeners.add(l);
      return () => modalListeners.delete(l);
    },
    () => modalStack.length,
  );
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable=""], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/**
 * Whether an element is on screen: laid out, and not in the terminal while a page covers it (the
 * terminal keeps its layout there, only hidden).
 */
export const isShown = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

/**
 * Where focus goes when a dialog closes and the control that opened it is gone (the empty-state
 * button after a session starts, a position row after its trade closes): the trading terminal if
 * it is showing, otherwise the current page's tab in the top bar.
 */
function focusHome(): void {
  const first = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].find(isShown);
  (first('[data-focus-home]') ?? first('[aria-current="page"]'))?.focus({ preventScroll: true });
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const id = useId();
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Read during the first render, before anything inside the dialog takes focus. A dialog that opened
  // on its own (the milestone celebration at page load) has no opener: focus was on the page body.
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  if (openerRef.current === undefined) {
    const active = document.activeElement as HTMLElement | null;
    openerRef.current = active && active !== document.body && active !== document.documentElement ? active : null;
  }

  useEffect(() => {
    const dialog = dialogRef.current!;
    modalStack.push({ id, el: dialog });
    // The newest dialog is drawn on top, whatever its place in the page.
    backdropRef.current!.style.zIndex = String(50 + modalStack.length);
    modalsChanged();
    const opener = openerRef.current;
    const isTop = () => modalStack[modalStack.length - 1]?.id === id;
    const items = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isShown);
    // Focus moves into the dialog, to the control marked data-autofocus if there is one, so Tab
    // starts inside and Space or Enter acts on the dialog rather than on the page behind it.
    if (!dialog.contains(document.activeElement)) (dialog.querySelector<HTMLElement>('[data-autofocus]') ?? dialog).focus();
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'Escape') {
        // Handled here, first (capture phase): Escape closes the dialog and nothing behind it.
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === 'Tab') {
        const list = items();
        if (!list.length) return;
        const first = list[0];
        const last = list[list.length - 1];
        const active = document.activeElement;
        if (!active || !dialog.contains(active)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (e.shiftKey && (active === first || active === dialog)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    // Focus that escapes the topmost dialog (a click on the page behind, a stray programmatic focus)
    // is brought back into it.
    const onFocusIn = (e: FocusEvent) => {
      if (!isTop() || !(e.target instanceof Node) || dialog.contains(e.target)) return;
      dialog.focus();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn);
      const i = modalStack.findIndex((m) => m.id === id);
      if (i >= 0) modalStack.splice(i, 1);
      modalsChanged();
      // Give focus back to whatever opened the dialog if it is still on the page and not hidden
      // behind another open dialog. Otherwise to the dialog that is now on top, or the terminal.
      const top = modalStack[modalStack.length - 1]?.el;
      if (opener && opener.isConnected && typeof opener.focus === 'function' && isShown(opener) && (!top || top.contains(opener))) opener.focus();
      else if (top) top.focus();
      else focusHome();
    };
  }, [id]);

  return (
    <div ref={backdropRef} className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <div className="modal-head">
          <h2 id={`${id}-title`}>{title}</h2>
          <div className="spacer" />
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

const SOURCE_TEXT: Record<DataSourceKind, string> = {
  LIVE: 'LIVE DATA',
  HISTORICAL: 'HISTORICAL DATA',
  DEMO: 'DEMO DATA · SYNTHETIC',
  SIMULATED: 'SIMULATED · FICTIONAL',
};

export const SOURCE_EXPLAIN: Record<DataSourceKind, string> = {
  LIVE: 'Real-time prices from a market-data vendor.',
  HISTORICAL: 'Real recorded market data (your CSV import or a vendor API), replayed with no look-ahead.',
  DEMO: 'Synthetic bars bundled for offline use. They behave like real tape but are NOT the real prices of these tickers on these dates.',
  SIMULATED: 'A fictional market generated by a stochastic model. Companies, prices and news are made up.',
};

export function SourceBadge({ source, title }: { source: DataSourceKind; title?: boolean }) {
  return (
    <span className={`badge ${source}`} title={title === false ? undefined : SOURCE_EXPLAIN[source]}>
      <span className="dot" />
      {SOURCE_TEXT[source]}
    </span>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        // Clicking a toast dismisses it without taking focus away from the dialog or control in use.
        <div key={t.id} className={`toast ${t.tone}`} onMouseDown={(e) => e.preventDefault()} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/**
 * Props for a clickable table row that keyboard users can reach with Tab and open with Enter. Space
 * opens it too unless `space` is false (rows on the trade screen, where Space plays and pauses).
 */
export function rowAction(onActivate: () => void, space = true) {
  return {
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      // Keys on a button inside the row (Close, Delete) belong to that button.
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || (space && e.key === ' ')) {
        e.preventDefault();
        onActivate();
      }
    },
  };
}

export function Stat({ k, v, cls }: { k: string; v: ReactNode; cls?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v ${cls ?? ''}`}>{v}</div>
    </div>
  );
}

/**
 * Keeps keyboard focus in a part of the page when the focused control there is disabled or removed
 * by what happened (Restart at the start, Close position, Remove rule, Play at the end): focus goes to
 * `home(root)` instead of dropping to the page body, where screen-reader users lose their place. Put
 * the returned ref on the part's root element.
 */
export function useFocusRescue<T extends HTMLElement>(home: (root: T) => HTMLElement | null | undefined): (root: T | null) => (() => void) | undefined {
  const rootRef = useRef<T | null>(null);
  const last = useRef<HTMLElement | null>(null);
  const homeRef = useRef(home);
  homeRef.current = home;
  const check = useRef(() => {
    const el = last.current;
    if (!el || (el.isConnected && !(el as HTMLButtonElement).disabled)) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== el) return;
    last.current = null;
    if (rootRef.current) homeRef.current(rootRef.current)?.focus();
  }).current;
  // A callback ref, so it also works on a root that is rendered later (or again).
  const ref = useCallback(
    (root: T | null) => {
      if (!root) return;
      rootRef.current = root;
      const onIn = (e: FocusEvent) => {
        last.current = e.target as HTMLElement;
      };
      // Chromium reports a disabled or removed control as a blur; a real move away (a click on the
      // chart, Tab out) leaves it usable, and then there is nothing to rescue.
      const onOut = (e: FocusEvent) => {
        const el = e.target as HTMLElement;
        requestAnimationFrame(() => {
          if (last.current === el && el.isConnected && !(el as HTMLButtonElement).disabled && document.activeElement !== el) last.current = null;
          else check();
        });
      };
      root.addEventListener('focusin', onIn);
      root.addEventListener('focusout', onOut);
      return () => {
        if (rootRef.current === root) rootRef.current = null;
        root.removeEventListener('focusin', onIn);
        root.removeEventListener('focusout', onOut);
      };
    },
    [check],
  );
  // Other browsers send no blur when a control goes: check after each render instead.
  useEffect(check);
  return ref;
}

/**
 * Text for a controlled number box that shows what is typed even while it is not a value yet (an
 * emptied box, "-" or "1." on the way to a number). Without it React puts the old value back at once
 * and the next digit is appended to it (2, cleared, then 3 gives 23). When the box loses focus it
 * shows the value again, after bringing a number typed outside [min, max] within it.
 */
export function useNumberDraft(value: number | '', commit: (v: number) => void, min = -Infinity, max = Infinity) {
  const [draft, setDraft] = useState<string | null>(null);
  return {
    text: draft ?? String(value),
    set: setDraft,
    finish: () => {
      if (draft === null) return;
      const n = Number(draft);
      if (draft.trim() !== '' && Number.isFinite(n)) {
        const c = Math.min(max, Math.max(min, n));
        if (c !== n) commit(c);
      }
      setDraft(null);
    },
  };
}

export function NumberField({
  label,
  value,
  onChange,
  step,
  min,
  max,
  suffix,
  disabled,
}: {
  label: string;
  value: number | '';
  onChange: (v: number | '') => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  disabled?: boolean;
}) {
  // Numbers within range are passed on as typed, and an empty box as '' (callers that always hold a
  // number ignore it). One outside the range waits, and is brought within it when the box is left.
  const draft = useNumberDraft(value, onChange, min, max);
  return (
    <label className="field">
      <span>
        {label}
        {suffix ? <span className="muted"> ({suffix})</span> : null}
      </span>
      <input
        type="number"
        value={draft.text}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => {
          draft.set(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value === '') onChange('');
          else if (Number.isFinite(n) && n >= (min ?? -Infinity) && n <= (max ?? Infinity)) onChange(n);
        }}
        onBlur={draft.finish}
      />
    </label>
  );
}
