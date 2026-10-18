// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { journalEntryFromTrip, type JournalEntry } from '../../core/journal';
import type { RoundTrip } from '../../core/types';

vi.mock('../services/download', () => ({ download: () => undefined }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const backupFile = JSON.stringify({ format: 'stock-replay-backup', version: 1, createdAt: 1, journal: [], settings: { defaultBalance: 50_000 } });

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  document.body.innerHTML = '';
});

async function mount() {
  const { BackupCard } = await import('./BackupCard');
  const { useSettings } = await import('../state/settingsStore');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(BackupCard)));
  return { host, useSettings, unmount: () => act(() => root.unmount()) };
}

/** Choose a backup file in the card's file box. */
async function choose(host: HTMLElement, text: string) {
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { value: [new File([text], 'backup.json', { type: 'application/json' })], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await vi.waitFor(() => expect(host.textContent).toContain('A backup from'));
}

const replaceSettingsBox = (host: HTMLElement) =>
  [...host.querySelectorAll('label.check')].find((l) => l.textContent?.includes('replace my settings'))!.querySelector('input')!;

describe('restoring settings from a backup', () => {
  it('ticks “replace my settings” at first only in a browser with no settings of its own', async () => {
    const fresh = await mount();
    await choose(fresh.host, backupFile);
    expect(replaceSettingsBox(fresh.host).checked).toBe(true);
    // A setting changed here since the card opened: the backup's no longer replace them unless asked.
    act(() => fresh.useSettings.getState().update({ defaultBalance: 30_000 }));
    await choose(fresh.host, backupFile);
    expect(replaceSettingsBox(fresh.host).checked).toBe(false);
    fresh.unmount();
  });
});

let n = 0;
/** A closed one-share trade of session `sessionId`, journaled (`blind`: in blind mode). */
function entry(sessionId: string, blind: boolean): JournalEntry {
  const t = 1_710_252_000 + n * 600;
  const trip: RoundTrip = {
    ...{ id: `t${++n}`, symbol: 'SPY', direction: 'long', entryTime: t, exitTime: t + 300, maxQuantity: 1, avgEntry: 100, avgExit: 101 },
    ...{ entryQtyTotal: 1, exitQtyTotal: 1, pnl: 1, commission: 0, highWhileOpen: 101, lowWhileOpen: 99, fills: [], closed: true, source: 'DEMO' },
  };
  return journalEntryFromTrip(trip, { sessionId, mode: 'replay', rewound: false, blind });
}

describe('backing up while blind sessions have not ended', () => {
  it('says how many trades are left out until their blind sessions end, one or several', async () => {
    const card = await mount();
    const { useJournal } = await import('../state/journalStore');
    const { useLiveBlind } = await import('../state/liveBlind');
    const { useToasts } = await import('../state/toasts');
    const backUp = async (entries: JournalEntry[], hidden: Record<string, string>) => {
      useToasts.setState({ toasts: [] });
      act(() => {
        useJournal.setState({ entries, loaded: true });
        useLiveBlind.setState({ sessions: hidden });
      });
      await act(async () => [...card.host.querySelectorAll('button')].find((b) => b.textContent === 'Download backup')!.click());
      await vi.waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
      return useToasts.getState().toasts[0].text;
    };
    expect(await backUp([entry('a', true), entry('b', true), entry('b', true), entry('c', false)], { a: '2024-03-12', b: '2024-05-01' })).toBe(
      'Backup saved with 1 trade. 3 trades are left out until their blind sessions end.',
    );
    expect(await backUp([entry('a', true), entry('a', true), entry('c', false)], { a: '2024-03-12' })).toBe('Backup saved with 1 trade. 2 trades are left out until their blind session ends.');
    expect(await backUp([entry('a', true), entry('c', false)], { a: '2024-03-12' })).toBe('Backup saved with 1 trade. 1 trade is left out until its blind session ends.');
    card.unmount();
  });
});

describe('restoring a backup', () => {
  afterEach(() => vi.doUnmock('../services/backup'));

  /** Restores a chosen file through the card, with `restore` doing the restoring; what the card says then. */
  async function restoreWith(restore: () => Promise<unknown>) {
    vi.doMock('../services/backup', async (original) => ({ ...(await original<typeof import('../services/backup')>()), restoreBackup: restore }));
    const card = await mount();
    await choose(card.host, backupFile);
    await act(async () => [...card.host.querySelectorAll('button')].find((b) => b.textContent === 'Restore')!.click());
    const said = `${card.host.querySelector('[role=status]')!.textContent}${card.host.querySelector('[role=alert]')!.textContent}`;
    card.unmount();
    vi.resetModules();
    return said;
  }

  const result = { journalAdded: 0, journalKept: 2, snapshotsAdded: 0, challengesAdded: 0, drawingsAdded: 0, datasetsAdded: [], datasetsKept: [], settings: false, streakDays: 0 };

  it('says how many missing chart snapshots it added to trades already there, when it added any', async () => {
    expect(await restoreWith(async () => ({ ...result, snapshotsAdded: 2 }))).toBe(
      'Restored: 0 trades added to your journal (2 already there, kept as they were); 2 missing chart snapshots added to trades already there.',
    );
    expect(await restoreWith(async () => result)).toBe('Restored: 0 trades added to your journal (2 already there, kept as they were).');
  });

  it('says restoring again adds the rest, after a reload when a newer version of the app has updated storage', async () => {
    const { STORAGE_UPGRADED } = await import('../services/idb');
    expect(await restoreWith(() => Promise.reject(new Error('The storage quota has been exceeded')))).toBe(
      'Restoring stopped partway: The storage quota has been exceeded. What was restored before that is kept, and restoring the same file again adds the rest.',
    );
    expect(await restoreWith(() => Promise.reject(new Error(STORAGE_UPGRADED)))).toBe(
      `Restoring stopped partway: ${STORAGE_UPGRADED}. What was restored before that is kept, and restoring the same file again once the page is reloaded adds the rest.`,
    );
  });
});
