// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataProviderError } from '../../core/data/provider';

vi.mock('../chart/offscreenSnapshot', () => ({ offscreenSnapshot: () => Promise.resolve('data:image/jpeg;base64,BB==') }));

vi.mock('../services/idb', () => ({
  idb: {
    all: async () => [],
    set: async () => undefined,
    delete: async () => undefined,
    get: async () => undefined,
    modify: async (_s: string, _k: string, fn: (v: unknown) => unknown) => fn(undefined),
  },
}));

afterEach(async () => {
  const store = await import('./tradingStore');
  vi.restoreAllMocks();
  (await import('./credentials')).useCredentials.setState({ creds: {} });
  await store.endSession();
  store.setBrowseSource('demo');
  store.setActiveSymbol('SPY');
  store.setTimeframe('1m');
  store.dismissError();
});

/** Keys for both vendors, and each vendor serving the demo's bars (there is no network here), its requests noted. */
async function vendorsServeDemo() {
  const reg = await import('./dataRegistry');
  (await import('./credentials')).useCredentials.setState({ creds: { polygonApiKey: 'k', alpacaKeyId: 'id', alpacaSecret: 'sec' } });
  const asked: string[] = [];
  for (const p of [reg.polygonProvider, reg.alpacaProvider]) {
    vi.spyOn(p, 'getBars').mockImplementation((req, signal) => {
      asked.push(`${p.id}:${req.symbol}`);
      return reg.demoProvider.getBars(req, signal);
    });
    vi.spyOn(p, 'getCoarseBars').mockImplementation((req, tf, signal) => reg.demoProvider.getCoarseBars(req, tf, signal));
  }
  return { reg, asked };
}

/** The browsing chart's error once its load for `symbol` has finished (the chart asks for its bars, which starts it). */
async function browseError(symbol: string): Promise<string | null> {
  const store = await import('./tradingStore');
  await vi.waitFor(
    () => {
      store.getBaseBars(symbol);
      const b = store.useTrading.getState().browse;
      expect(b.loading).toBe(false);
      expect(b.error !== null || store.getBaseBars(symbol).length > 0).toBe(true);
    },
    { timeout: 20_000 },
  );
  return store.useTrading.getState().browse.error;
}

describe('choosing what the chart shows with no session (symbol search, watchlist)', () => {
  it('switches symbol and data source in one change, so nothing is loaded for the old symbol from the new source', async () => {
    const store = await import('./tradingStore');
    const { useSettings } = await import('./settingsStore');
    const { asked } = await vendorsServeDemo();
    expect(await browseError('SPY')).toBeNull();
    // As the chart does: each reset redraws the symbol shown, which asks for its bars.
    const off = store.onChartEvent((e) => void (e.type === 'reset' && store.getBaseBars(store.useTrading.getState().activeSymbol)));
    store.browseSymbol('polygon', ' qqq ');
    off();
    expect(store.useTrading.getState()).toMatchObject({ activeSymbol: 'QQQ', browse: { providerId: 'polygon', error: null } });
    // Kept for the next visit and the next replay set up.
    expect(useSettings.getState().replay).toMatchObject({ providerId: 'polygon', symbol: 'QQQ' });
    expect(await browseError('QQQ')).toBeNull();
    expect(store.getBaseBars('QQQ').length).toBeGreaterThan(0);
    // Polygon was asked for QQQ only (each request spends the visitor's rate limit), never for SPY.
    expect(new Set(asked)).toEqual(new Set(['polygon:QQQ']));
  }, 30_000);

  it('does nothing during a session, whose own symbols are switched instead', async () => {
    const store = await import('./tradingStore');
    expect(await store.startReplay({ providerId: 'demo', symbol: 'AAPL', extraSymbols: ['SPY'], date: '2024-03-12', startTime: '09:30', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m', speed: 60, blind: false })).toBe(true);
    store.browseSymbol('polygon', 'QQQ');
    expect(store.useTrading.getState()).toMatchObject({ activeSymbol: 'AAPL', browse: { providerId: 'demo' } });
  }, 30_000);

  it('says plainly when a vendor has no bars for a ticker, and keeps a vendor’s other errors in their own words', async () => {
    const store = await import('./tradingStore');
    const { reg } = await vendorsServeDemo();
    // An unknown or mistyped ticker: Polygon answers with no bars at all.
    vi.mocked(reg.polygonProvider.getBars).mockResolvedValue([]);
    store.browseSymbol('polygon', 'XYZQ');
    expect(await browseError('XYZQ')).toBe('Polygon has no bars for XYZQ. Check the ticker.');
    expect(store.getBaseBars('XYZQ')).toEqual([]);
    // Alpaca refuses one it does not take (an "invalid symbol" answer, see vendorProviders).
    vi.mocked(reg.alpacaProvider.getBars).mockRejectedValue(new DataProviderError('Alpaca does not know this ticker.', 'not_found'));
    store.browseSymbol('alpaca', 'XYZQ');
    expect(await browseError('XYZQ')).toBe('Alpaca has no bars for XYZQ. Check the ticker.');

    // A rejected key and the rate limit are no ticker's fault: they read as the vendor's own messages.
    vi.mocked(reg.polygonProvider.getBars).mockRejectedValue(new DataProviderError('Polygon rejected the API key (HTTP 401). Check it in Data & Settings.', 'auth'));
    store.browseSymbol('polygon', 'AAPL');
    expect(await browseError('AAPL')).toBe('Polygon rejected the API key (HTTP 401). Check it in Data & Settings.');
    // Chosen again, it is tried again.
    vi.mocked(reg.polygonProvider.getBars).mockRejectedValue(new DataProviderError('Polygon rate limit reached. Wait a minute and try again.', 'rate_limit'));
    store.browseSymbol('polygon', 'AAPL');
    expect(await browseError('AAPL')).toBe('Polygon rate limit reached. Wait a minute and try again.');
  }, 30_000);

  it('says the same when a replay of such a ticker cannot start, a blind one without its date', async () => {
    const store = await import('./tradingStore');
    const { reg } = await vendorsServeDemo();
    vi.mocked(reg.polygonProvider.getBars).mockResolvedValue([]);
    const setup = { providerId: 'polygon', symbol: 'xyzq', date: '2024-03-12', startTime: '09:30', endTime: '16:00', startingBalance: 25_000, lookbackDays: 1, timeframe: '1m' as const, speed: 60, blind: false };
    expect(await store.startReplay(setup)).toBe(false);
    expect(store.useTrading.getState().error).toBe('Polygon has no bars for XYZQ around 2024-03-12. Check the ticker, or pick another date.');
    expect(await store.startReplay({ ...setup, blind: true })).toBe(false);
    expect(store.useTrading.getState().error).toBe('Polygon has no bars for XYZQ around this day. Check the ticker, or pick another date.');
    vi.mocked(reg.polygonProvider.getBars).mockRejectedValue(new DataProviderError('Polygon rate limit reached. Wait a minute and try again.', 'rate_limit'));
    expect(await store.startReplay(setup)).toBe(false);
    expect(store.useTrading.getState().error).toBe('Polygon rate limit reached. Wait a minute and try again.');
    // The demo's own words stay as they were: it lists its tickers, so the setup form flags an unknown one first.
    expect(await store.startReplay({ ...setup, providerId: 'demo', symbol: 'SPY', date: '2018-03-12' })).toBe(false);
    expect(store.useTrading.getState().error).toBe('No SPY data for 2018-03-12. Pick another date or data source.');
    expect(store.useTrading.getState().session).toBeNull();
  }, 30_000);
});
