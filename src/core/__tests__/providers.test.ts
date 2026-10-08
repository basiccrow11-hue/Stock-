import { describe, expect, it, vi } from 'vitest';
import { parseCsv, parseTimestamp } from '../data/csv';
import { CsvDataProvider } from '../data/csvProvider';
import { AlpacaProvider, PolygonProvider } from '../data/vendorProviders';
import { SimulationDataProvider } from '../data/simulationProvider';
import { et } from './helpers';

describe('CSV import', () => {
  it('parses a TradingView-style export with unix seconds', () => {
    const t = et('2025-01-15', '09:30');
    const csv = `time,open,high,low,close,Volume\n${t},100,101,99.5,100.5,1200\n${t + 60},100.5,101.2,100.1,101,900\n`;
    const r = parseCsv(csv);
    expect(r.bars).toHaveLength(2);
    expect(r.baseTimeframe).toBe('1m');
    expect(r.bars[0]).toEqual({ time: t, open: 100, high: 101, low: 99.5, close: 100.5, volume: 1200 });
  });

  it('parses naive exchange-time strings, separate date/time columns, and US dates', () => {
    expect(parseTimestamp('2025-01-15 09:30:00', 'exchange').t).toBe(et('2025-01-15', '09:30'));
    expect(parseTimestamp('01/15/2025 9:31 AM', 'exchange').t).toBe(et('2025-01-15', '09:31'));
    expect(parseTimestamp('2025-01-15T14:30:00Z', 'exchange').t).toBe(et('2025-01-15', '09:30'));
    expect(parseTimestamp('2025-01-15 14:30', 'utc').t).toBe(et('2025-01-15', '09:30'));
    expect(parseTimestamp('1736951400000', 'exchange').t).toBe(et('2025-01-15', '09:30'));
    const csv = 'Date;Time;Open;High;Low;Close;Vol\n2025-01-15;09:30;10;11;9;10.5;100\n2025-01-15;09:35;10.5;11;10;10.8;100\n2025-01-15;09:40;10.8;11;10;10.1;100\n';
    const r = parseCsv(csv);
    expect(r.baseTimeframe).toBe('5m');
    expect(r.bars[1].time).toBe(et('2025-01-15', '09:35'));
  });

  it('detects daily data and validates rows', () => {
    const csv = 'Date,Open,High,Low,Close,Adj Close,Volume\n2025-01-13,10,11,9,10.5,10.4,100\n2025-01-14,10,9,9,10.5,10.4,100\n2025-01-15,abc,11,9,10.5,10.4,100\n2025-01-16,10.5,12,10,11.5,11.4,100\n';
    const r = parseCsv(csv);
    expect(r.baseTimeframe).toBe('1D');
    expect(r.bars).toHaveLength(2);
    expect(r.rowsSkipped).toBe(2);
    expect(r.bars[1].close).toBe(11.5); // uses Close, not Adj Close
    expect(r.warnings.join(' ')).toMatch(/2 invalid/);
  });

  it('can shift close-stamped bars to open time', () => {
    const csv = 'datetime,open,high,low,close,volume\n2025-01-15 09:31,1,1,1,1,1\n2025-01-15 09:32,1,1,1,1,1\n';
    expect(parseCsv(csv, { timestampsAreBarClose: true }).bars[0].time).toBe(et('2025-01-15', '09:30'));
  });

  it('rejects files without required columns', () => {
    expect(() => parseCsv('time,price\n1,2\n')).toThrow(/Missing column/);
  });

  it('serves imported bars as HISTORICAL data', async () => {
    const p = new CsvDataProvider();
    expect(p.unavailableReason()).toMatch(/No CSV/);
    const t = et('2025-01-15', '09:30');
    p.upsert({ symbol: 'abc', name: 'ABC', baseTimeframe: '1m', importedAt: 0, fileName: 'a.csv', bars: [0, 1, 2].map((i) => ({ time: t + i * 60, open: 1, high: 1, low: 1, close: 1, volume: 1 })) });
    expect(p.source).toBe('HISTORICAL');
    expect(await p.getBars({ symbol: 'ABC', from: t + 60, to: t + 180 })).toHaveLength(2);
  });
});

describe('vendor providers (mocked HTTP)', () => {
  it('Polygon: sends the key as a bearer header, follows pagination through the proxy, maps bars', async () => {
    const t = et('2025-01-15', '09:30');
    const fetchFn = vi.fn(async (url: string) => {
      const page2 = url.includes('cursor=abc');
      const body = page2
        ? { results: [{ t: (t + 60) * 1000, o: 2, h: 2, l: 2, c: 2, v: 5 }] }
        : { results: [{ t: t * 1000, o: 1, h: 1, l: 1, c: 1, v: 5 }], next_url: 'https://api.polygon.io/v2/aggs/ticker/AAPL/range/1/minute/x/y?cursor=abc' };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const p = new PolygonProvider(() => ({ polygonApiKey: 'k123' }), '/api/polygon', fetchFn as unknown as typeof fetch);
    const bars = await p.getBars({ symbol: 'aapl', from: t, to: t + 600 });
    expect(bars.map((b) => b.close)).toEqual([1, 2]);
    expect(fetchFn.mock.calls[0][0]).toMatch(/^\/api\/polygon\/v2\/aggs\/ticker\/AAPL\/range\/1\/minute\//);
    expect(fetchFn.mock.calls[1][0]).toMatch(/^\/api\/polygon\/v2\/aggs.*cursor=abc/);
    expect((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toEqual({ Authorization: 'Bearer k123' });
  });

  it('Polygon: maps auth failures to a helpful error', async () => {
    const p = new PolygonProvider(() => ({ polygonApiKey: 'bad' }), '/api/polygon', (async () => new Response('{"status":"ERROR"}', { status: 401 })) as unknown as typeof fetch);
    await expect(p.getBars({ symbol: 'AAPL', from: 0, to: 60 })).rejects.toThrow(/rejected the API key/);
  });

  it('tells a missing data proxy apart from an unknown symbol', async () => {
    const req = { symbol: 'AAPL', from: 1736935200, to: 1736958600 };
    // A static host answers /api/... with its HTML 404 page.
    const html = (async () => new Response('<!doctype html><title>404</title>', { status: 404, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    await expect(new PolygonProvider(() => ({ polygonApiKey: 'k123' }), '/api/polygon', html).getBars(req)).rejects.toMatchObject({ kind: 'network', message: expect.stringMatching(/no market-data proxy/) });
    await expect(new AlpacaProvider(() => ({ alpacaKeyId: 'id', alpacaSecret: 'sec' }), '/api/alpaca', html).getBars(req)).rejects.toMatchObject({ kind: 'network' });
    // Hosts that fall back to the app serve its index.html with 200 for every unknown path.
    const spa = (async () => new Response('<!doctype html><html><div id="root"></div></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    await expect(new PolygonProvider(() => ({ polygonApiKey: 'k123' }), '/api/polygon', spa).getBars(req)).rejects.toMatchObject({ kind: 'network', message: expect.stringMatching(/no market-data proxy/) });
    await expect(new AlpacaProvider(() => ({ alpacaKeyId: 'id', alpacaSecret: 'sec' }), '/api/alpaca', spa).getBars(req)).rejects.toMatchObject({ kind: 'network', message: expect.stringMatching(/no market-data proxy/) });
    // The vendor's own 404 is JSON.
    const json = (async () => new Response('{"message":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    await expect(new PolygonProvider(() => ({ polygonApiKey: 'k123' }), '/api/polygon', json).getBars(req)).rejects.toMatchObject({ kind: 'not_found' });
    // Anything else that is not JSON is still reported as a bad vendor response.
    const junk = (async () => new Response('upstream said no', { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch;
    await expect(new PolygonProvider(() => ({ polygonApiKey: 'k123' }), '/api/polygon', junk).getBars(req)).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('Alpaca: sends key headers and pages with next_page_token', async () => {
    const calls: [string, RequestInit][] = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      const body = url.includes('page_token=p2')
        ? { bars: [{ t: '2025-01-15T14:31:00Z', o: 2, h: 2, l: 2, c: 2, v: 1 }], next_page_token: null }
        : { bars: [{ t: '2025-01-15T14:30:00Z', o: 1, h: 1, l: 1, c: 1, v: 1 }], next_page_token: 'p2' };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const p = new AlpacaProvider(() => ({ alpacaKeyId: 'id', alpacaSecret: 'sec', alpacaFeed: 'iex' }), '/api/alpaca', fetchFn as unknown as typeof fetch);
    const bars = await p.getBars({ symbol: 'SPY', from: et('2025-01-15', '09:30'), to: et('2025-01-15', '09:40') });
    expect(bars.map((b) => b.time)).toEqual([et('2025-01-15', '09:30'), et('2025-01-15', '09:31')]);
    expect(calls[0][1].headers).toEqual({ 'APCA-API-KEY-ID': 'id', 'APCA-API-SECRET-KEY': 'sec' });
    expect(calls[0][0]).toContain('feed=iex');
  });

  it('reports missing credentials instead of failing silently', () => {
    expect(new PolygonProvider(() => ({})).unavailableReason()).toMatch(/Polygon API key/);
    expect(new AlpacaProvider(() => ({ alpacaKeyId: 'x' })).unavailableReason()).toMatch(/Alpaca/);
    expect(new PolygonProvider(() => ({ serverHasPolygonKey: true })).unavailableReason()).toBeNull();
  });
});

describe('simulation provider', () => {
  it('streams SIMULATED updates to subscribers', async () => {
    const p = SimulationDataProvider.create('2026-10-08');
    expect(p.source).toBe('SIMULATED');
    const seen: string[] = [];
    const unsub = p.subscribe(['NOVA'], (u) => seen.push(u.symbol));
    p.advance(60);
    unsub();
    p.advance(60);
    expect(seen.length).toBe(12); // 60s / 5s ticks, NOVA only, before unsubscribing
    expect((await p.listSymbols()).map((s) => s.symbol)).toContain('SIMX');
  });
});
