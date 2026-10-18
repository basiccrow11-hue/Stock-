// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

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
