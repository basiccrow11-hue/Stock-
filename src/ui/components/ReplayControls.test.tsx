// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Bar } from '../../core/types';

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

describe('the replay controls', () => {
  it('jump to a date and time from a menu, so the controls fit on one row', async () => {
    const store = await import('../state/tradingStore');
    const { ReplayControls } = await import('./ReplayControls');
    const { exchangeTimeToUnix, formatExchangeTime } = await import('../../core/time');
    const ok = await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false });
    expect(ok).toBe(true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(ReplayControls)));
    const trigger = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Jump to…')!;
    const menu = () => host.querySelector<HTMLElement>('[role="dialog"][aria-label="Jump to a time"]');
    const field = (label: string) => [...menu()!.querySelectorAll('label')].find((l) => l.textContent!.startsWith(label))!.querySelector('input')!;

    // The fields are not in the bar until the menu is opened.
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('input')).toBeNull();
    act(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // They start at the replay clock.
    expect(field('Date').value).toBe('2024-03-12');
    expect(field('Time (ET)').value).toBe(formatExchangeTime(store.useTrading.getState().now));

    // Escape closes the menu and gives focus back to its button.
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    act(() => trigger.click());
    act(() => {
      const time = field('Time (ET)');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(time, '10:30');
      time.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => [...menu()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Jump')!.click());
    expect(store.useTrading.getState().now).toBe(exchangeTimeToUnix('2024-03-12', 10 * 60 + 30));
    expect(menu()).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);

    act(() => root.unmount());
    await store.endSession();
  });

  it('run to the end time when the data stops before it, by Play or by Step, and only then end a blind replay', async () => {
    const store = await import('../state/tradingStore');
    const { csvProvider } = await import('../state/dataRegistry');
    const { useToasts } = await import('../state/toasts');
    const { ReplayControls } = await import('./ReplayControls');
    const { exchangeTimeToUnix } = await import('../../core/time');
    // THIN trades all of March 11 and on the 12th until its 15:39 bar, then not again before the close.
    const bars: Bar[] = [];
    for (const [d, n] of [['2024-03-11', 390], ['2024-03-12', 370]] as const) {
      for (let i = 0; i < n; i++) bars.push({ time: exchangeTimeToUnix(d, 570 + i), open: 10, high: 10.01, low: 9.99, close: 10, volume: 1000 });
    }
    csvProvider.upsert({ symbol: 'THIN', name: 'THIN', baseTimeframe: '1m', bars, importedAt: 0, fileName: 'THIN.csv' });
    const at = (hhmm: string) => exchangeTimeToUnix('2024-03-12', Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const find = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.includes(label));
    // Step forward one bar (of the data) is with the less used controls, behind the row's ⋯ button.
    const button = (label: string) => {
      if (!find(label)) act(() => find('More replay controls')!.click());
      return find(label)!;
    };
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    try {
      for (const how of ['step', 'play'] as const) {
        const blind = how === 'step';
        expect(await store.startReplay({ providerId: 'csv', symbol: 'THIN', date: '2024-03-12', startTime: '15:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 60, blind })).toBe(true);
        act(() => root.render(createElement(ReplayControls)));
        act(() => store.jumpTo(at('15:40')));
        // The last bar is in, but nothing says so before the clock gets to the end time.
        expect(store.getBaseBars('THIN').at(-1)!.time).toBe(at('15:39'));
        expect(store.useTrading.getState().finished).toBe(false);
        expect(host.textContent).not.toContain('END OF REPLAY');
        expect(button('Step forward one bar').disabled).toBe(false);
        expect(button('Play').disabled).toBe(false);
        expect(store.useTrading.getState().session!.blind).toBe(blind);
        useToasts.setState({ toasts: [] });
        if (how === 'step') {
          act(() => button('Step forward one bar').click());
          act(() => void vi.advanceTimersByTime(100));
        } else {
          act(() => button('Play').click());
          // A minute a second at 60x: 20 seconds to the end time, then Play stops there.
          for (let i = 0; i < 25; i++) {
            clock += 1000;
            act(() => void vi.advanceTimersByTime(50));
          }
          act(() => void vi.advanceTimersByTime(100));
          expect(store.useTrading.getState().playing).toBe(false);
          expect(useToasts.getState().toasts.map((t) => t.text)).toContain('Replay reached the end time.');
        }
        const s = store.useTrading.getState();
        expect(s.now, how).toBe(at('16:00'));
        expect(s.finished, how).toBe(true);
        expect(host.textContent, how).toContain('END OF REPLAY');
        expect(button('Step forward one bar').disabled, how).toBe(true);
        expect(s.session!.blind, how).toBe(false);
        await store.endSession();
      }
    } finally {
      act(() => root.unmount());
      vi.useRealTimers();
      now.mockRestore();
      csvProvider.remove('THIN');
      await store.endSession();
    }
  });

  it('keep the row simple, as TradingView does: Select bar, Play, Forward one candle, speed, clock and Exit, with the rest behind ⋯', async () => {
    const store = await import('../state/tradingStore');
    const { ReplayControls } = await import('./ReplayControls');
    const { exchangeTimeToUnix } = await import('../../core/time');
    const at = (hhmm: string) => exchangeTimeToUnix('2024-03-12', Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '5m', speed: 1, blind: false })).toBe(true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(ReplayControls)));
    const bar = host.querySelector('.replay-bar')!;
    /** What a control says: its label, or its text without the icons. */
    const label = (e: Element) =>
      e.tagName === 'SELECT' ? 'speed' : (e.getAttribute('aria-label') ?? [...e.childNodes].filter((c) => !(c instanceof Element && c.getAttribute('aria-hidden') === 'true')).map((c) => c.textContent).join('').trim());
    const row = () => [...bar.querySelectorAll(':scope > button, :scope > select, :scope > .replay-end > button, :scope > .replay-end > div > button')].map(label);
    expect(row()).toEqual(['Select bar', 'Play', 'Forward one 5m candle', 'speed', 'Jump to…', 'More replay controls', 'Exit replay']);
    expect(bar.querySelector('.clock')!.textContent).toBe('2024-03-12 10:00:00');
    const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => label(b) === text)!;
    const newest = () => store.getBaseBars('SPY').at(-1)!.time;

    // Forward shows the next whole candle of the chart: five bars of the 1-minute data.
    act(() => button('Forward one 5m candle').click());
    expect(newest()).toBe(at('10:04'));
    // The less used controls: the panel stays open while they are used.
    expect(host.querySelector('[role="dialog"][aria-label="More replay controls"]')).toBeNull();
    act(() => button('More replay controls').click());
    const panel = () => host.querySelector('[role="dialog"][aria-label="More replay controls"]');
    expect([...panel()!.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Restart', 'Step back one bar', 'Step forward one bar']);
    act(() => button('Step forward one bar').click());
    expect(newest()).toBe(at('10:05'));
    act(() => button('Step forward one bar').click());
    expect(newest()).toBe(at('10:06'));
    expect(panel()).not.toBeNull();
    act(() => button('Restart').click());
    expect(store.useTrading.getState().now).toBe(at('10:00'));

    // Select bar picks a bar on the chart to start a fresh replay from; pressed again it stops.
    act(() => button('Select bar').click());
    expect(store.useTrading.getState().selectingBar).toBe(true);
    expect(button('Select bar').getAttribute('aria-pressed')).toBe('true');
    act(() => button('Select bar').click());
    expect(store.useTrading.getState().selectingBar).toBe(false);

    // Exit asks first while a position is open, as a new start does; the chart then shows SPY on 5m with no session.
    act(() => void store.submitOrder({ symbol: 'SPY', action: 'buy', type: 'market', quantity: 10 }));
    act(() => store.stepForward());
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    act(() => button('Exit replay').click());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatch(/^Exiting ends this session\. Your open position \(SPY long 10\)/);
    expect(store.useTrading.getState().session).not.toBeNull();
    confirm.mockReturnValue(true);
    act(() => button('Exit replay').click());
    await vi.waitFor(() => expect(store.useTrading.getState().session).toBeNull());
    expect(store.useTrading.getState()).toMatchObject({ activeSymbol: 'SPY', timeframe: '5m' });
    expect(host.querySelector('.replay-bar')).toBeNull();
    confirm.mockRestore();
    act(() => root.unmount());
    store.setTimeframe('1m');
  });

  it('keep Jump to…, ⋯ and Exit together at the right end, and shorten the badges where the row is short of room', async () => {
    const store = await import('../state/tradingStore');
    const { ReplayControls } = await import('./ReplayControls');
    const { readFileSync } = await import('node:fs');
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '15:50', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false })).toBe(true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(ReplayControls)));
    const bar = host.querySelector('.replay-bar')!;
    // One group, so they wrap together if at all; the progress line stays on the whole row's top edge.
    const end = bar.querySelector(':scope > .replay-end')!;
    expect([...end.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Jump to…', 'More replay controls', 'Exit replay']);
    expect(bar.querySelector(':scope > .progress')).not.toBeNull();
    const css = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');
    expect(css).toMatch(/\n\.replay-end \{[^}]*flex-wrap: nowrap;[^}]*margin-left: auto;/);

    // The speed in short ("1m/s", not "60x · 1m/s"), to leave the row room; the full label is in its title.
    const speed = bar.querySelector('select')!;
    expect([...speed.options].map((o) => o.textContent)).toEqual(['1x', '5x', '10x', '30x', '1m/s', '2m/s', '5m/s', '10m/s', '30m/s', '1h/s', '2h/s', '6.5h/s']);
    act(() => store.setSpeed(60));
    expect(speed.title).toBe('Replay speed: 60x · 1m/s (simulated time per real second)');

    // A rewound replay at its end: both badges, each in full and shortened (CSS shows one), its full text in the title.
    act(() => store.stepForward());
    await act(async () => store.stepBack());
    await act(async () => undefined);
    const badges = () => [...bar.querySelectorAll('.replay-badge')].map((b) => [b.querySelector('.badge-full')!.textContent, b.querySelector('.badge-short')!.textContent, b.getAttribute('title')]);
    expect(badges()).toEqual([['REWOUND ×1', '↺ ×1', 'REWOUND ×1: you rewound this session; results are not blind.']]);
    act(() => store.jumpTo(store.useTrading.getState().session!.end!));
    // Shortened, both read as one badge, ↺ ×1 · END, its tooltip naming both.
    expect(badges()).toEqual([
      ['REWOUND ×1', '↺ ×1 · END', 'REWOUND ×1: you rewound this session; results are not blind.'],
      ['END OF REPLAY', 'END', 'END OF REPLAY'],
    ]);
    expect(bar.querySelector('.badge-short')!.getAttribute('title')).toBe('REWOUND ×1: you rewound this session; results are not blind. END OF REPLAY');
    expect(bar.querySelector('.badge-short')!.getAttribute('aria-hidden')).toBe('true');
    // Shortened on laptop screens, and wider ones while both show; then the END badge gives way to the
    // one ↺ ×1 · END shows, out of the row's flow and kept for screen readers.
    expect(css).toMatch(/@media \(max-width: 1366px\) \{\s*\.replay-badge \.badge-full \{[^}]*clip: rect\(0 0 0 0\)[^}]*\}\s*\.replay-badge \.badge-short \{ display: inline; \}/);
    expect(css).toMatch(/\n\.replay-badge \.badge-short \{ display: none; \}/);
    expect(css).toMatch(/@media \(max-width: 1519px\) \{[^@]*\.replay-bar \.replay-badge \+ \.replay-badge \{ position: absolute;[^}]*clip: rect\(0 0 0 0\)/);
    act(() => root.unmount());
    await store.endSession();
  });

  it('close the ⋯ panel once focus ends up outside it, step with its arrows, and never rescue focus into a closed or hidden panel', async () => {
    const store = await import('../state/tradingStore');
    const { ReplayControls } = await import('./ReplayControls');
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '15:55', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false })).toBe(true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(ReplayControls)));
    const find = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.includes(label))!;
    const panel = () => host.querySelector('.more-pop');
    const more = find('More replay controls');
    const start = store.useTrading.getState().now;
    const now = () => store.useTrading.getState().now;
    const key = (target: Element, k: string) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
    const flush = () => act(async () => void (await new Promise((r) => requestAnimationFrame(() => r(undefined)))));
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    // The arrows the panel shows beside its steps work with focus in it.
    act(() => more.click());
    act(() => find('Step forward one bar').focus());
    key(find('Step forward one bar'), 'ArrowRight');
    // The store publishes at most every 90 ms.
    await vi.waitFor(() => expect(now()).toBe(start + 60));
    expect(panel()).not.toBeNull();
    // Focus on an ancestor (a click on the panel's text focuses the terminal around it) is not leaving.
    host.tabIndex = -1;
    act(() => host.focus());
    expect(panel()).not.toBeNull();
    // Focus anywhere else closes it, and stays where it went.
    act(() => find('Play').focus());
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(find('Play'));

    // Step back to the start with a click: the button disables itself, which the browser reports as a blur
    // to nowhere. Nothing is left there to step back over, so the panel closes.
    act(() => more.click());
    let back = find('Step back one bar');
    act(() => back.focus());
    // A rewind takes effect once the journal has caught up (afterRewind).
    await act(async () => back.click());
    await act(async () => undefined);
    expect(now()).toBe(start);
    expect(back.disabled).toBe(true);
    expect(panel()).not.toBeNull();
    act(() => void back.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null })));
    expect(panel()).toBeNull();

    // The same by keyboard: focus goes on to Play, outside the panel, which closes. (The row rescues keyboard
    // focus only, which jsdom cannot tell from a script's: here all of it is.)
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' ? true : matches.call(this, selector);
    });
    act(() => store.stepForward());
    await vi.waitFor(() => expect(now()).toBe(start + 60));
    act(() => more.click());
    back = find('Step back one bar');
    act(() => back.focus());
    await act(async () => back.click());
    await act(async () => undefined);
    await flush();
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(find('Play'));

    // Forward to the end, by keyboard: Play and the steps disable, and focus goes to ⋯, not into its panel.
    const candle = find('Forward one 1m candle');
    act(() => candle.focus());
    for (let i = 0; i < 10 && !candle.disabled; i++) act(() => candle.click());
    await vi.waitFor(() => expect(candle.disabled).toBe(true));
    expect(store.useTrading.getState().finished).toBe(true);
    await flush();
    expect(document.activeElement).toBe(more);
    expect(panel()).toBeNull();
    act(() => root.unmount());
    vi.restoreAllMocks();
    await store.endSession();
  });

  it('step with ← and → while the ⋯ panel is open, focus still on ⋯ or on the page, but not while another menu is', async () => {
    const store = await import('../state/tradingStore');
    const { ReplayControls } = await import('./ReplayControls');
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '15:50', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false })).toBe(true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(ReplayControls)));
    const find = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.includes(label))!;
    const start = store.useTrading.getState().now;
    const now = () => store.useTrading.getState().now;
    const key = (target: Element, k: string) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k === ' ' ? 'Space' : k, bubbles: true, cancelable: true })));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const more = find('More replay controls');

    // A click on ⋯ leaves focus on it (Chrome) or on the page (Safari): the arrows its panel shows step all the same.
    act(() => more.focus());
    act(() => more.click());
    expect(host.querySelector('.more-pop')).not.toBeNull();
    key(more, 'ArrowRight');
    // The store publishes at most every 90 ms.
    await vi.waitFor(() => expect(now()).toBe(start + 60));
    act(() => more.blur());
    key(document.body, 'ArrowRight');
    await vi.waitFor(() => expect(now()).toBe(start + 120));
    key(more, 'ArrowLeft');
    await act(async () => undefined);
    await vi.waitFor(() => expect(now()).toBe(start + 60));
    expect(host.querySelector('.more-pop')).not.toBeNull();
    // Space is left to the focused control while the panel is open: it does not play.
    key(more, ' ');
    expect(store.useTrading.getState().playing).toBe(false);

    // Another menu keeps the keys: with Jump to… open, → steps nothing, on its button or on the page.
    act(() => find('Jump to…').click());
    expect(host.querySelector('.more-pop')).toBeNull();
    expect(host.querySelector('.jump-pop')).not.toBeNull();
    key(find('Jump to…'), 'ArrowRight');
    key(document.body, 'ArrowRight');
    await act(async () => void (await new Promise((r) => setTimeout(r, 200))));
    expect(now()).toBe(start + 60);
    act(() => root.unmount());
    vi.restoreAllMocks();
    await store.endSession();
  });

  it('give focus to the toolbar’s Replay button after Exit and after the menu’s Select bar, not to the page', async () => {
    const store = await import('../state/tradingStore');
    const { ReplayControls } = await import('./ReplayControls');
    const { ReplayMenu } = await import('./ReplayMenu');
    const { Fragment } = await import('react');
    // jsdom lays nothing out: focus goes only to a control on screen.
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList);
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: false })).toBe(true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(Fragment, null, createElement(ReplayMenu, { onNewSession: () => undefined }), createElement(ReplayControls))));
    const replay = host.querySelector<HTMLButtonElement>('.replay-btn')!;

    // The menu's Select bar: the Replay button, now pressed, has focus.
    act(() => host.querySelector<HTMLButtonElement>('.replay-more')!.click());
    const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === 'Select bar')!;
    expect(document.activeElement).toBe(item);
    act(() => item.click());
    expect(store.useTrading.getState().selectingBar).toBe(true);
    expect(document.activeElement).toBe(replay);
    expect(replay.getAttribute('aria-pressed')).toBe('true');
    act(() => store.setSelectingBar(false));

    // Exit: the row goes with the session, ✕ included.
    const exit = host.querySelector<HTMLButtonElement>('button[aria-label="Exit replay"]')!;
    act(() => exit.focus());
    await act(async () => exit.click());
    await vi.waitFor(() => expect(store.useTrading.getState().session).toBeNull());
    await act(async () => undefined);
    expect(host.querySelector('.replay-bar')).toBeNull();
    expect(document.activeElement).toBe(replay);
    act(() => root.unmount());
    vi.restoreAllMocks();
  });

  it('say why Select bar is not for a blind replay, and give the simulated market Exit but no Select bar', async () => {
    const store = await import('../state/tradingStore');
    const { useToasts } = await import('../state/toasts');
    const { ReplayControls } = await import('./ReplayControls');
    expect(await store.startReplay({ providerId: 'demo', symbol: 'SPY', date: '2024-03-12', startTime: '10:00', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 1, blind: true })).toBe(true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(ReplayControls)));
    const find = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === text || b.textContent!.trim() === text);
    const select = find('Select bar')!;
    expect(select.getAttribute('aria-disabled')).toBe('true');
    expect(select.title).toBe('A blind replay hides its dates, and picking a bar would show them. Exit the replay first.');
    useToasts.setState({ toasts: [] });
    act(() => select.click());
    expect(store.useTrading.getState().selectingBar).toBe(false);
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual([select.title]);

    expect(await store.startSim({ config: { seed: 4 }, startingBalance: 25_000, speed: 1 })).toBe(true);
    await act(async () => undefined);
    expect(find('Select bar')).toBeUndefined();
    expect(find('▶ Start market')).toBeDefined();
    act(() => find('Exit the simulated market')!.click());
    await vi.waitFor(() => expect(store.useTrading.getState().session).toBeNull());
    act(() => root.unmount());
  });
});
