// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../services/idb', () => ({
  idb: {
    all: async () => [],
    set: async () => undefined,
    delete: async () => undefined,
    get: async () => undefined,
    modify: async (_s: string, _k: string, fn: (v: unknown) => unknown) => fn(undefined),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = '';
});

async function open() {
  const { SessionSetup } = await import('./SessionSetup');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(SessionSetup, { mode: 'replay', onClose: () => undefined })));
  const dateField = () => document.querySelector<HTMLInputElement>('input[type=date]')!;
  return { root, dateField };
}

describe('the new replay form and blind replays', () => {
  it('does not show the date a running blind replay is hiding, from this tab or another', async () => {
    const { useSettings } = await import('../state/settingsStore');
    const { useLiveBlind } = await import('../state/liveBlind');
    useSettings.getState().updateReplay({ date: '2024-08-30' });
    useLiveBlind.setState({ sessions: { 'replay_other-tab': '2024-08-30' } });
    const hidden = await open();
    expect(hidden.dateField().value).toBe('');
    expect(document.body.textContent).toContain('belongs to a blind replay still running, so it stays hidden');
    expect(document.body.textContent).not.toContain('2024-08-30');
    act(() => hidden.root.unmount());

    // Once that replay is over, the date is the usual default again.
    useLiveBlind.setState({ sessions: {} });
    const shown = await open();
    expect(shown.dateField().value).toBe('2024-08-30');
    act(() => shown.root.unmount());
  });

  it('does not save a blind replay’s date as the next default', async () => {
    const { useSettings } = await import('../state/settingsStore');
    const store = await import('../state/tradingStore');
    useSettings.getState().updateReplay({ date: '2024-03-12', blind: false, providerId: 'demo', symbol: 'SPY', multiDay: false, startTime: '10:00', endTime: '16:00', includeWatchlist: false });
    const form = await open();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      set.call(form.dateField(), '2024-03-13');
      form.dateField().dispatchEvent(new Event('input', { bubbles: true }));
    });
    const blind = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('Blind mode'))!.querySelector('input')!;
    act(() => blind.click());
    const start = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Start replay')!;
    await act(async () => start.click());
    await vi.waitFor(() => expect(store.useTrading.getState().session?.blind).toBe(true));
    expect(store.useTrading.getState().session?.startDate).toBe('2024-03-13');
    expect(useSettings.getState().replay).toMatchObject({ date: '2024-03-12', blind: true, startTime: '10:00' });
    act(() => form.root.unmount());
    await store.endSession();
  });
});
