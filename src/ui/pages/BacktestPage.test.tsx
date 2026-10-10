// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { BacktestParams } from '../../core/backtest/Backtester';
import type { BarRequest } from '../../core/data/provider';

const { runs } = vi.hoisted(() => ({ runs: [] as BacktestParams[] }));

// The backtest runs on this thread, and every run's settings are kept for the test to read.
vi.mock('../services/backtestClient', async () => {
  const { runBacktest } = await import('../../core/backtest/Backtester');
  return {
    runBacktestAsync: async (p: BacktestParams) => {
      runs.push(p);
      return runBacktest(p);
    },
    cancelBacktests: () => undefined,
  };
});

// jsdom has no canvas: the result charts get a stand-in that accepts any call.
vi.mock('lightweight-charts', async (original) => {
  const actual = await original<typeof import('lightweight-charts')>();
  const fake: unknown = new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => 0 : fake),
    apply: () => fake,
  });
  return { ...actual, createChart: () => fake, createSeriesMarkers: () => fake };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = '';
  runs.length = 0;
  vi.restoreAllMocks();
});

/** Opens the page on demo data, recording its requests for bars; `fails` makes the nth request (from 0) fail. */
async function open(fails?: (n: number) => Error | null) {
  const { BacktestPage } = await import('./BacktestPage');
  const { demoProvider } = await import('../state/dataRegistry');
  const requests: BarRequest[] = [];
  const getBars = demoProvider.getBars.bind(demoProvider);
  vi.spyOn(demoProvider, 'getBars').mockImplementation(async (req) => {
    const failure = fails?.(requests.length);
    requests.push(req);
    if (failure) throw failure;
    return getBars(req);
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(BacktestPage, { active: true })));
  return { root, requests };
}

/** Set a React-controlled select the way the browser does. */
function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const selectNamed = (label: string) =>
  [...document.querySelectorAll<HTMLSelectElement>('select')].find((s) => s.getAttribute('aria-label') === label || s.closest('label')?.textContent?.startsWith(label))!;

async function runAndWait() {
  const before = runs.length;
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Run backtest')!;
  await act(async () => button.click());
  for (let i = 0; i < 400 && (runs.length === before || document.body.textContent!.includes('Cancel')); i++) {
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
  }
  expect(document.body.textContent).not.toContain('Cancel');
}

describe('the backtest page', () => {
  it('loads the warm-up history the rules need on daily candles, a piece at a time', async () => {
    const { requests } = await open();
    const { exchangeDate, prevTradingDay } = await import('../../core/time');
    // MACD 12/26/9 on daily candles: 105 candles for its signal line to settle, one more for the cross, a day to spare.
    choose(selectNamed('Load a strategy preset'), 'MACD signal-line cross');
    choose(selectNamed('Signal timeframe'), '1D');
    await runAndWait();
    const p = runs[0];
    const start = exchangeDate(p.tradeFrom);
    let warm = start;
    for (let i = 0; i < 107; i++) warm = prevTradingDay(warm);
    // The test's own bars come first, then the warm-up in pieces of at most 50 trading days, newest
    // first, each ending where the one before began.
    const warmup = requests.slice(1);
    expect(exchangeDate(requests[0].from)).toBe(start);
    expect(warmup.length).toBe(3);
    expect(warmup[0].to).toBe(requests[0].from);
    expect(warmup[1].to).toBe(warmup[0].from);
    expect(warmup[2].to).toBe(warmup[1].from);
    expect(exchangeDate(warmup[2].from)).toBe(warm);
    expect(p.bars[0].time).toBeGreaterThanOrEqual(p.tradeFrom);
    expect(p.warmupCandles!.length).toBe(107);
    expect(document.body.textContent).not.toContain('Not enough history');
    expect(document.body.textContent).toContain('MACD signal-line cross · SPY');
  });

  it('runs on the recent warm-up history already loaded when the rest fails to load, and says so', async () => {
    // The second piece of warm-up history hits a free plan's rate limit.
    const { requests } = await open((n) => (n === 2 ? new Error('Polygon rate limit reached. Wait a minute and try again.') : null));
    const { exchangeDate } = await import('../../core/time');
    choose(selectNamed('Load a strategy preset'), 'MACD signal-line cross');
    choose(selectNamed('Signal timeframe'), '1D');
    await runAndWait();
    const p = runs[0];
    // The 50 trading days just before the start, with no gap before it.
    expect(p.warmupCandles!.length).toBe(50);
    expect(exchangeDate(p.warmupCandles![0].time)).toBe(exchangeDate(requests[1].from));
    const text = document.body.textContent!;
    expect(text).toContain(
      `Only 50 of 107 trading days of warm-up history could be loaded (from ${exchangeDate(requests[1].from)} on), so the test started with less: Polygon rate limit reached. Wait a minute and try again.`,
    );
    expect(text).toContain('Not enough history before');
    expect(text).toContain('MACD signal (9) (needs 105) had values from the start, but they were still settling');
    expect(text).toContain('MACD signal-line cross · SPY');
  });

  it('labels the results of edited preset rules as custom rules based on the preset', async () => {
    await open();
    choose(selectNamed('Load a strategy preset'), 'MACD signal-line cross');
    choose(selectNamed('Signal timeframe'), '1D');
    choose(document.querySelector<HTMLSelectElement>('select[aria-label="Comparison"]')!, 'above');
    await runAndWait();
    expect(document.body.textContent).toContain('Custom rules based on MACD signal-line cross · SPY');
  });

  it('explains next to the option that the flatten before the close does not apply to the 1D signal timeframe', async () => {
    await open();
    const flatten = [...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find((c) => c.closest('label')?.textContent?.includes('Flatten before the close'))!;
    expect(flatten.getAttribute('aria-describedby')).toBeNull();
    choose(selectNamed('Signal timeframe'), '1D');
    const note = document.getElementById(flatten.getAttribute('aria-describedby')!);
    expect(note?.textContent).toBe('Not used with the 1D signal timeframe: each candle is a whole session, so positions are held overnight.');
    choose(selectNamed('Signal timeframe'), '4h');
    expect(flatten.getAttribute('aria-describedby')).toBeNull();
  });
});
