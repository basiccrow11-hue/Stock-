// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary, moduleRetryUrl, retryableLazy } from './ErrorBoundary';

vi.mock('../services/idb', () => ({
  idb: {
    all: async () => [],
    set: async () => undefined,
    delete: async () => undefined,
    get: async () => undefined,
    modify: async (_s: string, _k: string, fn: (v: unknown) => unknown) => fn(undefined),
  },
}));

// The terminal's panels, as stand-ins that fail on demand (the real ones draw charts jsdom cannot).
const { failing } = vi.hoisted(() => ({ failing: new Set<string>() }));
const panel = (name: string, area: string) => () => {
  if (failing.has(name)) throw new Error(`${name} broke`);
  return createElement('section', { className: `panel ${area}` }, `${name} is fine`);
};
vi.mock('./Watchlist', () => ({ Watchlist: panel('Watchlist', 'area-watch') }));
vi.mock('./ChartPanel', () => ({ ChartPanel: panel('Chart', 'area-chart') }));
vi.mock('./RightPanel', () => ({ RightPanel: panel('Ticket', 'area-right') }));
vi.mock('./BottomPanel', () => ({ BottomPanel: panel('Positions', 'area-bottom') }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  failing.clear();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  const store = await import('../state/tradingStore');
  store.pause();
  await store.endSession();
});

function mount(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return root;
}

const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)!;
/** React reports an error a boundary caught on the console; these tests make such errors on purpose. */
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
}

describe('error boundaries', () => {
  it('show what failed in its place, while the rest stays on screen, and Try again draws it again', () => {
    quiet();
    let broken = true;
    const Watchlist = () => {
      if (broken) throw new Error('quote was undefined');
      return createElement('section', null, 'Watchlist is fine');
    };
    mount(
      createElement(
        'main',
        null,
        createElement(ErrorBoundary, { what: 'The watchlist', layout: 'panel', className: 'panel area-watch' }, createElement(Watchlist)),
        createElement('section', null, 'Chart is fine'),
      ),
    );
    const fallback = document.querySelector('.panel.area-watch')!;
    expect(fallback.textContent).toContain('The watchlist stopped because of an error');
    expect(fallback.textContent).toContain('The rest of the app still works.');
    expect(fallback.querySelector('[role="alert"]')).not.toBeNull();
    expect(fallback.textContent).toContain('Error: quote was undefined');
    expect(document.body.textContent).toContain('Chart is fine');
    // Focus was on the page body (nothing had it): it goes to the message, named by its title.
    expect(document.activeElement?.getAttribute('aria-labelledby')).toBe(fallback.querySelector('b')!.id);
    broken = false;
    act(() => button('Try again').click());
    expect(document.body.textContent).toContain('Watchlist is fine');
    expect(document.body.textContent).not.toContain('stopped because of an error');
  });

  it('download a lazy page again on Try again after its download failed once', async () => {
    quiet();
    let attempts = 0;
    const Page = retryableLazy(async () => {
      attempts++;
      // Safari's error, which names no module: the page's own import runs again.
      if (attempts === 1) throw new TypeError('Importing a module script failed.');
      return { BacktestPage: ({ label }: { label: string }) => createElement('div', { className: 'page' }, label) };
    }, 'BacktestPage');
    // jsdom lays nothing out: everything counts as shown, so focus can go to the current page's tab.
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([new DOMRect()] as unknown as DOMRectList);
    mount(
      createElement(
        'div',
        null,
        createElement('nav', null, createElement('button', { 'aria-current': 'page' }, 'Backtest')),
        createElement(
          Suspense,
          { fallback: 'Loading…' },
          createElement(ErrorBoundary, { what: 'The Backtest page', layout: 'page', onRetry: Page.retry }, createElement(Page, { label: 'Backtester ready' })),
        ),
      ),
    );
    await settle();
    expect(document.body.textContent).toContain('The Backtest page could not be loaded');
    expect(document.body.textContent).toContain('the app was updated since this tab opened it, and then only reloading helps');
    expect(attempts).toBe(1);
    button('Try again').focus();
    await act(async () => button('Try again').click());
    await settle();
    expect(attempts).toBe(2);
    expect(document.body.textContent).toContain('Backtester ready');
    // Try again went with the message: focus goes to the page's tab rather than the page body. The
    // page appears from behind the download's Loading… rather than in an update of the boundary.
    expect(document.activeElement?.textContent).toBe('Backtest');
    // A page that loaded is not downloaded again.
    Page.retry();
    await settle();
    expect(attempts).toBe(2);
  });

  it('ask again for the module the error names, at a new address, since browsers keep a failed download', async () => {
    quiet();
    let attempts = 0;
    // Any module of the app will do as the page: this one exports ErrorBoundary, which draws its children.
    const Page = retryableLazy(async (): Promise<typeof import('./ErrorBoundary')> => {
      attempts++;
      throw new TypeError(`Failed to fetch dynamically imported module: ${location.origin}/src/ui/components/ErrorBoundary.tsx`);
    }, 'ErrorBoundary');
    mount(
      createElement(
        Suspense,
        { fallback: 'Loading…' },
        createElement(
          ErrorBoundary,
          { what: 'The Backtest page', layout: 'page', onRetry: Page.retry },
          createElement(Page, { what: 'Inner', layout: 'panel' }, 'Backtester ready'),
        ),
      ),
    );
    await settle();
    expect(document.body.textContent).toContain('The Backtest page could not be loaded');
    await act(async () => button('Try again').click());
    // The module is downloaded (here, compiled) again, which takes longer than a settle.
    for (let i = 0; i < 100 && !document.body.textContent!.includes('Backtester ready'); i++) {
      await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    }
    expect(document.body.textContent).toBe('Backtester ready');
    // Calling the import again would fail at once in a browser, without asking the server.
    expect(attempts).toBe(1);
  });

  it('find the address of the module whose download failed in Chrome and Firefox errors', () => {
    const site = location.origin;
    expect(moduleRetryUrl(new TypeError(`Failed to fetch dynamically imported module: ${site}/assets/BacktestPage-1a2b3c.js`), 1)).toBe(
      '/assets/BacktestPage-1a2b3c.js?retry=1',
    );
    expect(moduleRetryUrl(new TypeError(`error loading dynamically imported module: ${site}/src/ui/pages/BacktestPage.tsx?t=17`), 2)).toBe(
      '/src/ui/pages/BacktestPage.tsx?t=17&retry=2',
    );
    // Safari names no module; another site's module, a stylesheet and other errors are not asked for again.
    expect(moduleRetryUrl(new TypeError('Importing a module script failed.'), 1)).toBeNull();
    expect(moduleRetryUrl(new TypeError('Failed to fetch dynamically imported module: https://example.com/x.js'), 1)).toBeNull();
    expect(moduleRetryUrl(new Error(`Unable to preload CSS for ${site}/assets/index.css`), 1)).toBeNull();
    expect(moduleRetryUrl('Failed to fetch dynamically imported module: /x.js', 1)).toBeNull();
  });

  it('say a reload ends the running session, and keep the session when a panel fails', async () => {
    quiet();
    const store = await import('../state/tradingStore');
    await store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 1 });
    const session = store.useTrading.getState().session!;
    failing.add('Watchlist');
    const { App } = await import('../App');
    mount(createElement(App));
    await settle();
    const fallback = document.querySelector('.panel.area-watch')!;
    expect(fallback.textContent).toContain('The watchlist stopped because of an error');
    expect(fallback.textContent).toContain('The rest of the app still works, and your simulated market session carries on.');
    expect(fallback.textContent).toContain(
      'Reloading ends your simulated market session: sessions are not restored after a reload. It keeps your journal, settings, imported data and drawings.',
    );
    expect(button('Reload the app').getAttribute('aria-describedby')).toBe(fallback.querySelector('p.small.muted')!.id);
    // The rest of the terminal and the top bar are drawn, and the session is the same one.
    for (const other of ['Chart is fine', 'Ticket is fine', 'Positions is fine']) expect(document.body.textContent).toContain(other);
    expect(document.querySelector('header.topbar nav')!.textContent).toContain('Backtest');
    expect(store.useTrading.getState().session).toBe(session);
    failing.delete('Watchlist');
    act(() => button('Try again').click());
    expect(document.body.textContent).toContain('Watchlist is fine');
  });

  it('pause playback when the chart panel fails, since the replay controls go with it', async () => {
    quiet();
    const store = await import('../state/tradingStore');
    await store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 1 });
    store.play();
    expect(store.useTrading.getState().playing).toBe(true);
    failing.add('Chart');
    const { App } = await import('../App');
    mount(createElement(App));
    await settle();
    expect(store.useTrading.getState().playing).toBe(false);
    expect(document.querySelector('.panel.area-chart')!.textContent).toContain('The rest of the app still works, and your simulated market session is paused.');
    expect(document.body.textContent).toContain('Watchlist is fine');
  });

  it('keep the session through a failure of the whole app, paused, and say Try again keeps it', async () => {
    quiet();
    const store = await import('../state/tradingStore');
    await store.startSim({ config: { seed: 7 }, startingBalance: 25_000, speed: 1 });
    store.play();
    let broken = true;
    const Shell = () => {
      if (broken) throw new Error('toast text was an object');
      return createElement('div', null, 'App is back');
    };
    mount(createElement(ErrorBoundary, { what: 'The app', layout: 'app', pausesPlayback: true }, createElement(Shell)));
    expect(document.querySelector('.app h2')!.textContent).toBe('The app stopped because of an error');
    expect(document.body.textContent).toContain('Your simulated market session is still held in memory, paused: Try again draws the app again without ending it.');
    expect(store.useTrading.getState().playing).toBe(false);
    broken = false;
    act(() => button('Try again').click());
    expect(document.body.textContent).toBe('App is back');
    expect(store.useTrading.getState().session).not.toBeNull();
  });

  it('show a failed dialog as a dialog whose Close clears what opened it', () => {
    quiet();
    const onClose = vi.fn();
    const Review = () => {
      throw new Error('entry was undefined');
    };
    mount(createElement(ErrorBoundary, { what: 'The trade review', layout: 'dialog', onClose }, createElement(Review)));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('The trade review stopped because of an error');
    act(() => button('Close').click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
