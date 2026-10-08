import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from 'react';
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

const visible = (el: HTMLElement) => el.getClientRects().length > 0;

/**
 * Where focus goes when a dialog closes and the control that opened it is gone (the empty-state
 * button after a session starts, a position row after its trade closes): the trading terminal if
 * it is showing, otherwise the current page's tab in the top bar.
 */
function focusHome(): void {
  const first = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].find(visible);
  (first('[data-focus-home]') ?? first('[aria-current="page"]'))?.focus({ preventScroll: true });
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const id = useId();
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Read during the first render, before anything inside the dialog takes focus.
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  if (openerRef.current === undefined) openerRef.current = document.activeElement as HTMLElement | null;

  useEffect(() => {
    const dialog = dialogRef.current!;
    modalStack.push({ id, el: dialog });
    // The newest dialog is drawn on top, whatever its place in the page.
    backdropRef.current!.style.zIndex = String(50 + modalStack.length);
    modalsChanged();
    const opener = openerRef.current;
    const isTop = () => modalStack[modalStack.length - 1]?.id === id;
    const items = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
    // Focus moves into the dialog, to the control marked data-autofocus if there is one, so Tab
    // starts inside and Space or Enter acts on the dialog rather than on the page behind it.
    if (!dialog.contains(document.activeElement)) (dialog.querySelector<HTMLElement>('[data-autofocus]') ?? dialog).focus();
    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'Escape') {
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
    window.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      const i = modalStack.findIndex((m) => m.id === id);
      if (i >= 0) modalStack.splice(i, 1);
      modalsChanged();
      // Give focus back to whatever opened the dialog if it is still on the page and not hidden
      // behind another open dialog. Otherwise to the dialog that is now on top, or the terminal.
      const top = modalStack[modalStack.length - 1]?.el;
      if (opener && opener.isConnected && typeof opener.focus === 'function' && (!top || top.contains(opener))) opener.focus();
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
        <div key={t.id} className={`toast ${t.tone}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Stat({ k, v, cls }: { k: string; v: ReactNode; cls?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v ${cls ?? ''}`}>{v}</div>
    </div>
  );
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
  return (
    <label className="field">
      <span>
        {label}
        {suffix ? <span className="muted"> ({suffix})</span> : null}
      </span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    </label>
  );
}
