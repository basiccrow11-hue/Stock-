/**
 * Whether a disclosure in the trade screen's right column is open (the order ticket's More options,
 * the account's details), remembered per browser as the bottom panel's size is (useBottomDock). They
 * start closed, so the column shows what most orders need; one the user opened is still open after a
 * reload, so nobody has to open it again every time. Storage that is blocked or full only means the
 * choice lasts until the page is reloaded.
 */
import { useCallback, useState } from 'react';

export const OPEN_KEY = 'stock-replay-open-panels';

export type DisclosureId = 'ticket-more' | 'account-details';

/** The stored choices, ignoring anything malformed (an older version's or a hand-edited value). */
export function readOpen(): Partial<Record<DisclosureId, boolean>> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, open]) => typeof open === 'boolean'));
  } catch {
    return {};
  }
}

/**
 * [open, setOpen] for one disclosure. Give it to a <details> (open and onToggle), so its summary
 * opens and closes it with a click, Enter or Space, and focus stays on the summary when it closes.
 */
export function useRememberedOpen(id: DisclosureId): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => readOpen()[id] === true);
  const remember = useCallback(
    (next: boolean) => {
      setOpen(next);
      try {
        // Read again first: another disclosure may have saved its own choice since.
        localStorage.setItem(OPEN_KEY, JSON.stringify({ ...readOpen(), [id]: next }));
      } catch {
        /* storage blocked or full: the choice still applies until the page is reloaded */
      }
    },
    [id],
  );
  return [open, remember];
}
