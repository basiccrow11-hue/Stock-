import { describe, expect, it, vi } from 'vitest';
import { combineBars, parseCsv, parseTimestamp } from '../data/csv';
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

  it('reads dates with the year last in the order the file uses, and rejects days that do not exist', () => {
    const rows = (dates: string[]) => `Date,Open,High,Low,Close,Volume\n${dates.map((d) => `${d},10,11,9,10.5,100`).join('\n')}\n`;
    // Day first (a UK or European export): 16/01 settles it for the file, so 02/01 is 2 January.
    const dmy = parseCsv(rows(['02/01/2024', '03/01/2024', '16/01/2024', '17/01/2024']));
    expect(dmy.bars.map((b) => new Date(b.time * 1000).toISOString().slice(0, 10))).toEqual(['2024-01-02', '2024-01-03', '2024-01-16', '2024-01-17']);
    expect(dmy.warnings).toContain('Dates were read as day/month/year (13/01/2024 is 13 January).');
    // Month first: 01/16 settles it the other way.
    const mdy = parseCsv(rows(['01/02/2024', '01/16/2024']));
    expect(mdy.bars.map((b) => new Date(b.time * 1000).toISOString().slice(0, 10))).toEqual(['2024-01-02', '2024-01-16']);
    expect(mdy.warnings).toEqual([]);
    // Both orders in one file cannot be read.
    expect(() => parseCsv(rows(['16/01/2024', '01/17/2024']))).toThrow(/mix day\/month and month\/day/);
    // Every date could be either: month first, with a note; dotted dates are day first.
    expect(parseCsv(rows(['01/02/2024', '01/03/2024'])).warnings.join(' ')).toMatch(/01\/02\/2024 can be read either way; they were read as month\/day \(US\)/);
    const dotted = parseCsv(rows(['02.01.2024', '03.01.2024']));
    expect(dotted.bars.map((b) => new Date(b.time * 1000).toISOString().slice(0, 10))).toEqual(['2024-01-02', '2024-01-03']);
    // A day that does not exist is an invalid row, never rolled into another month or year.
    expect(parseTimestamp('2024-02-30', 'exchange').t).toBeNaN();
    expect(parseTimestamp('13/13/2024', 'exchange').t).toBeNaN();
    expect(parseTimestamp('04/31/2024', 'exchange').t).toBeNaN();
    expect(parseTimestamp('2024-01-16 25:00', 'exchange').t).toBeNaN();
    expect(parseCsv(rows(['01/02/2024', '02/30/2024', '01/03/2024'])).rowsSkipped).toBe(1);
  });

  it('reads decimal commas and abbreviated volumes, and says what happens without volume', () => {
    const eu = parseCsv('Date;Open;High;Low;Close;Volume\n2024-01-02 09:30;185,50;186,00;184,10;185,64;1.000\n2024-01-02 09:31;185,64;186,5;185,1;186,2;2.500\n');
    expect(eu.bars.map((b) => [b.open, b.high, b.low, b.close, b.volume])).toEqual([
      [185.5, 186, 184.1, 185.64, 1000],
      [185.64, 186.5, 185.1, 186.2, 2500],
    ]);
    expect(eu.warnings).toContain('Numbers use a decimal comma: 185,64 was read as 185.64.');
    expect(() => parseCsv('Date;Open;High;Low;Close\n2024-01-02 09:30;185,50;186,00;184,10;185,64\n2024-01-02 09:31;185.64;186.5;185.1;186.2\n')).toThrow(/mix decimal commas and decimal points/);
    // Thousands separators in a decimal-point file still read as before.
    expect(parseCsv('Date,Open,High,Low,Close\n2024-01-02,"1,234.50","1,240.00","1,230.25","1,238.75"\n').bars[0].close).toBe(1238.75);
    const abbreviated = parseCsv('Date,Price,Open,High,Low,Vol.\n01/02/2024,10.5,10,11,9,82.49M\n01/03/2024,10.6,10.5,11,10,1.2K\n');
    expect(abbreviated.bars.map((b) => b.volume)).toEqual([82_490_000, 1200]);
    const none = parseCsv('Date,Open,High,Low,Close\n2024-01-02,10,11,9,10.5\n');
    expect(none.warnings).toContain('No volume column: the volume pane is empty, VWAP is not meaningful, and fills are not limited by bar volume.');
    const zero = parseCsv('Date,Open,High,Low,Close,Volume\n2024-01-02,10,11,9,10.5,0\n2024-01-03,10,11,9,10.5,\n');
    expect(zero.warnings).toContain('Every volume is 0 or unreadable: the volume pane is empty, VWAP is not meaningful, and fills are not limited by bar volume.');
  });

  it('keeps daily rows on days the NYSE traded in their year, and lists the days it skips', () => {
    // MLK Day closed the market only from 1998; Juneteenth from 2022; Memorial Day was May 30 before 1971.
    const days = ['1995-01-16', '1996-01-15', '1997-01-20', '1998-01-19', '2021-06-18', '2023-06-19', '1969-05-26', '1969-05-30'];
    const r = parseCsv(`Date,Open,High,Low,Close,Volume\n${days.map((d) => `${d},10,11,9,10.5,100`).join('\n')}\n`);
    expect(r.bars.map((b) => new Date(b.time * 1000).toISOString().slice(0, 10))).toEqual(['1969-05-26', '1995-01-16', '1996-01-15', '1997-01-20', '2021-06-18']);
    expect(r.warnings).toContain('3 daily bar(s) dated on a weekend or market holiday were skipped: 1969-05-30, 1998-01-19, 2023-06-19.');
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

  it('files daily bars under the day they name, whatever time of day they are stamped with', () => {
    const days = ['2024-03-01', '2024-03-04', '2024-03-05'];
    const row = (stamp: string, i: number) => `${stamp},${100 + i},${101 + i},${99 + i},${100.5 + i},1000`;
    const styles: Record<string, (d: string) => string> = {
      'date only': (d) => d,
      'UTC midnight': (d) => `${d}T00:00:00Z`,
      'UTC midnight offset': (d) => `${d} 00:00:00+00:00`,
      'New York midnight': (d) => `${d} 00:00:00-05:00`,
      'New York midnight as UTC': (d) => `${d}T05:00:00Z`,
      'naive midnight': (d) => `${d} 00:00`,
      'naive close': (d) => `${d} 16:00`,
      'epoch seconds at UTC midnight': (d) => String(Date.parse(`${d}T00:00:00Z`) / 1000),
      'epoch ms at New York midnight': (d) => String(Date.parse(`${d}T05:00:00Z`)),
    };
    for (const [name, stamp] of Object.entries(styles)) {
      for (const naiveTimezone of ['exchange', 'utc'] as const) {
        const r = parseCsv(`date,open,high,low,close,volume\n${days.map((d, i) => row(stamp(d), i)).join('\n')}\n`, { naiveTimezone });
        expect([name, r.baseTimeframe]).toEqual([name, '1D']);
        expect([name, r.bars.map((b) => b.time)]).toEqual([name, days.map((d) => et(d, '09:30'))]);
        expect(r.bars[1].close).toBe(101.5);
      }
    }
    // A weekend day (a vendor's off-by-one, or a stray row) is not a session: dropped with a warning.
    const weekend = parseCsv('date,open,high,low,close\n2024-03-01,1,1,1,1\n2024-03-02,1,1,1,1\n2024-03-04,1,1,1,1\n');
    expect(weekend.bars.map((b) => b.time)).toEqual([et('2024-03-01', '09:30'), et('2024-03-04', '09:30')]);
    expect(weekend.warnings.join(' ')).toMatch(/1 daily bar\(s\) dated on a weekend or market holiday were skipped/);
  });

  it('adds a second file for a ticker to the first, the newer file winning where they overlap', () => {
    const b = (t: number, c: number) => ({ time: t, open: c, high: c, low: c, close: c, volume: 1 });
    const r = combineBars([b(1, 1), b(3, 1), b(5, 1)], [b(2, 2), b(3, 2), b(6, 2)]);
    expect(r.bars.map((x) => [x.time, x.close])).toEqual([[1, 1], [2, 2], [3, 2], [5, 1], [6, 2]]);
    expect(r.replaced).toBe(1);
    expect(combineBars([], [b(1, 1)]).bars).toHaveLength(1);
    expect(combineBars([b(1, 1)], []).bars).toHaveLength(1);
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
