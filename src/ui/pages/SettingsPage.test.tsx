// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../services/idb', () => ({
  STORAGE_UPGRADED: 'stock-replay-storage-upgraded',
  idb: {
    all: async () => [],
    set: async () => undefined,
    delete: async () => undefined,
    get: async () => undefined,
    modify: async (_s: string, _k: string, fn: (v: unknown) => unknown) => fn(undefined),
  },
}));
// The appearance card draws a sample chart on a canvas jsdom does not have; it is not what is tested here.
vi.mock('../components/Appearance', () => ({ AppearanceCard: () => null }));
vi.mock('../components/BackupCard', () => ({ BackupCard: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = '';
  (await import('../state/settingsStore')).useSettings.getState().update({ watchlist: ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META'] });
  vi.restoreAllMocks();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

async function mount() {
  const { SettingsPage } = await import('./SettingsPage');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(SettingsPage)));
  await act(async () => undefined);
  return host;
}

describe('Data & Settings', () => {
  it('opens at the card another screen asked for (the symbol search), scrolled to and focused', async () => {
    const { requestFocus } = await import('../services/focusRequest');
    const scrolled: string[] = [];
    // jsdom has no scrolling.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    requestFocus('csv-import');
    let host = await mount();
    expect(document.activeElement).toBe(host.querySelector('#csv-import'));
    expect(document.activeElement!.getAttribute('aria-labelledby')).toBe('csv-import-title');
    expect(scrolled).toEqual(['csv-import']);
    for (const r of roots.splice(0)) act(() => r.unmount());

    requestFocus('api-keys');
    host = await mount();
    expect(document.activeElement).toBe(host.querySelector('#api-keys'));
    expect(host.querySelector('#api-keys-title')!.textContent).toBe('Market data API keys (optional)');
    expect(scrolled).toEqual(['csv-import', 'api-keys']);
    for (const r of roots.splice(0)) act(() => r.unmount());

    // Only once per request: opened again from the top bar, the page takes no focus.
    (document.activeElement as HTMLElement).blur();
    await mount();
    expect(document.activeElement).toBe(document.body);
    expect(scrolled).toEqual(['csv-import', 'api-keys']);
  });

  it('keeps its watchlist field in step with the watchlist edited elsewhere, and saves what is typed in it', async () => {
    const { useSettings, addToWatchlist, removeFromWatchlist } = await import('../state/settingsStore');
    useSettings.getState().update({ watchlist: ['SPY', 'QQQ'] });
    const host = await mount();
    const field = [...host.querySelectorAll('label')].find((l) => l.textContent!.startsWith('Watchlist'))!.querySelector('input')!;
    expect(field.value).toBe('SPY, QQQ');
    // The watchlist's + and ×, or a star in the symbol search.
    act(() => addToWatchlist('PLTR'));
    act(() => removeFromWatchlist('SPY'));
    expect(field.value).toBe('QQQ, PLTR');

    // While being edited, the field shows what is typed; leaving it saves the list.
    act(() => field.focus());
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'qqq pltr, amd, qqq');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(field.value).toBe('qqq pltr, amd, qqq');
    expect(useSettings.getState().watchlist).toEqual(['QQQ', 'PLTR']);
    act(() => field.blur());
    expect(useSettings.getState().watchlist).toEqual(['QQQ', 'PLTR', 'AMD']);
    expect(field.value).toBe('QQQ, PLTR, AMD');

    // Reset settings puts the default list back in the field too.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Reset settings')!.click());
    expect(field.value).toBe('SPY, QQQ, AAPL, MSFT, NVDA, TSLA, AMZN, META');
  });
});
