import { describe, expect, it } from 'vitest';
import { buildUpstream, handle } from '../../../api/proxy';

const req = (path: string, headers: Record<string, string> = {}, method = 'GET') => new Request(`https://app.example${path}`, { headers, method });

describe('Vercel market-data proxy', () => {
  it('forwards the Polygon bars endpoint with the browser key', () => {
    const up = buildUpstream(
      req('/api/proxy?vendor=polygon&path=v2/aggs/ticker/SPY/range/1/minute/1736951400000/1736974799999&adjusted=true&sort=asc&limit=50000&evil=1', { authorization: 'Bearer abcDEF123456' }),
      {},
    );
    expect(up).not.toBeInstanceOf(Response);
    const u = up as { url: string; headers: Record<string, string> };
    expect(u.url).toBe('https://api.polygon.io/v2/aggs/ticker/SPY/range/1/minute/1736951400000/1736974799999?adjusted=true&sort=asc&limit=50000');
    expect(u.headers.authorization).toBe('Bearer abcDEF123456');
  });

  it('refuses other endpoints, so it is not an open proxy', async () => {
    for (const path of ['v3/reference/tickers', '../../etc/passwd', 'v2/aggs/ticker/SPY/range/1/minute/1/2', 'https://evil.example/x']) {
      const r = buildUpstream(req(`/api/proxy?vendor=polygon&path=${encodeURIComponent(path)}`, { authorization: 'Bearer abcDEF123456' }), {});
      expect(r).toBeInstanceOf(Response);
      expect((r as Response).status).toBe(400);
    }
    const r = buildUpstream(req('/api/proxy?vendor=alpaca&path=v2/account', { 'apca-api-key-id': 'a', 'apca-api-secret-key': 'b' }), {});
    expect((r as Response).status).toBe(400);
    expect((await handle(req('/api/proxy?vendor=nope&path=x'), {})).status).toBe(404);
    expect((await handle(req('/api/proxy?vendor=keys', {}, 'POST'), {})).status).toBe(405);
  });

  it('never spends server keys unless explicitly allowed', async () => {
    const env = { POLYGON_API_KEY: 'serverkey123', ALPACA_KEY_ID: 'id', ALPACA_SECRET: 'sec' };
    const path = '/api/proxy?vendor=polygon&path=v2/aggs/ticker/SPY/range/1/minute/1736951400000/1736974799999';
    const denied = buildUpstream(req(path), env);
    expect((denied as Response).status).toBe(401);
    const keys = await (await handle(req('/api/proxy?vendor=keys'), env)).json();
    expect(keys).toEqual({ polygon: false, alpaca: false });

    const allowed = buildUpstream(req(path), { ...env, ALLOW_SERVER_KEYS: 'true' });
    expect((allowed as { headers: Record<string, string> }).headers.authorization).toBe('Bearer serverkey123');
    const keys2 = await (await handle(req('/api/proxy?vendor=keys'), { ...env, ALLOW_SERVER_KEYS: 'true' })).json();
    expect(keys2).toEqual({ polygon: true, alpaca: true });
  });

  it('forwards Alpaca bars with the browser key pair and passes vendor errors through', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response('{"message":"forbidden"}', { status: 403, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const res = await handle(
      req('/api/proxy?vendor=alpaca&path=v2/stocks/AAPL/bars&timeframe=1Min&feed=iex&page_token=abc', { 'apca-api-key-id': 'KID', 'apca-api-secret-key': 'SEC' }),
      {},
      fetchFn,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('{"message":"forbidden"}');
    expect(seen!.url).toBe('https://data.alpaca.markets/v2/stocks/AAPL/bars?timeframe=1Min&feed=iex&page_token=abc');
    expect(seen!.headers['APCA-API-KEY-ID']).toBe('KID');
  });

  it('reports an unreachable vendor as 502', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const res = await handle(req('/api/proxy?vendor=polygon&path=v2/aggs/ticker/SPY/range/1/minute/1736951400000/1736974799999', { authorization: 'Bearer abcDEF123456' }), {}, fetchFn);
    expect(res.status).toBe(502);
  });
});
