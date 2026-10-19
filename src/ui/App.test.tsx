// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { SettingsCard } from './services/focusRequest';

vi.mock('./services/idb', () => ({
  STORAGE_UPGRADED: 'stock-replay-storage-upgraded',
  idb: {
    all: async () => [],
    set: async () => undefined,
    delete: async () => undefined,
    get: async () => undefined,
    modify: async (_s: string, _k: string, fn: (v: unknown) => unknown) => fn(undefined),
  },
}));

// The terminal's panels draw charts jsdom cannot: stand-ins, the chart's with the symbol search's two
// ways into Data & Settings ("Import a CSV file", "Add a Polygon or Alpaca API key").
vi.mock('./components/Watchlist', () => ({ Watchlist: () => null }));
vi.mock('./components/RightPanel', () => ({ RightPanel: () => null }));
vi.mock('./components/BottomPanel', () => ({ BottomPanel: () => null }));
vi.mock('./components/ChartPanel', () => ({
  ChartPanel: ({ onOpenSettingsAt }: { onOpenSettingsAt?: (card: SettingsCard) => void }) =>
    createElement(
      'section',
      { className: 'panel area-chart' },
      createElement('button', { onClick: () => onOpenSettingsAt?.('csv-import') }, 'Import a CSV file'),
      createElement('button', { onClick: () => onOpenSettingsAt?.('api-keys') }, 'Add an API key'),
    ),
}));
vi.mock('./components/Appearance', async (real) => ({ ...(await real<object>()), AppearanceCard: () => null }));
vi.mock('./components/BackupCard', () => ({ BackupCard: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = '';
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
}

const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!;

describe('the app', () => {
  it('opens Data & Settings at the card the symbol search points to, that card focused', { timeout: 20_000 }, async () => {
    // jsdom has no scrolling.
    Element.prototype.scrollIntoView = () => undefined;
    const { App } = await import('./App');
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(createElement(App)));
    await settle();

    act(() => button('Import a CSV file').click());
    expect(document.querySelector('.terminal')!.classList.contains('offstage')).toBe(true);
    // The page loads on its first visit.
    await vi.waitFor(() => expect(document.getElementById('csv-import')).not.toBeNull(), { timeout: 10_000 });
    await settle();
    expect(document.activeElement).toBe(document.getElementById('csv-import'));

    act(() => button('Trade').click());
    await settle();
    expect(document.getElementById('api-keys')).toBeNull();
    act(() => button('Add an API key').click());
    await settle();
    expect(document.activeElement).toBe(document.getElementById('api-keys'));
  });
});
