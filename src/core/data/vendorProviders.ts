/**
 * Vendor API providers (real HISTORICAL data). Requests go to same-origin proxy paths
 * (/api/polygon, /api/alpaca) served by the Vite dev/preview server, which forwards them upstream.
 * That avoids browser CORS limits and lets keys live server-side in .env.local if you prefer.
 *
 * Keys are never hardcoded: they are read through a getter at request time.
 */
import type { Bar, Timeframe, UnixSeconds } from '../types';
import { DataProviderError, type BarRequest, type HistoricalDataProvider, type SymbolInfo } from './provider';
import { DEMO_TICKERS } from './demoProvider';

export interface VendorCredentials {
  polygonApiKey?: string;
  alpacaKeyId?: string;
  alpacaSecret?: string;
  /** Alpaca data feed: 'iex' (free) or 'sip' (paid, consolidated tape). */
  alpacaFeed?: 'iex' | 'sip';
  /** True when the dev server has keys in .env.local (browser does not see them). */
  serverHasPolygonKey?: boolean;
  serverHasAlpacaKey?: boolean;
}

type CredGetter = () => VendorCredentials;
type FetchFn = typeof fetch;

const COMMON_SYMBOLS: SymbolInfo[] = DEMO_TICKERS.map((t) => ({ symbol: t.symbol, name: t.name.replace(' (demo)', ''), kind: t.kind }));

function httpError(status: number, body: string, vendor: string): DataProviderError {
  if (status === 401 || status === 403) return new DataProviderError(`${vendor} rejected the API key (HTTP ${status}). Check it in Data & Settings.`, 'auth');
  if (status === 429) return new DataProviderError(`${vendor} rate limit reached. Wait a minute and try again.`, 'rate_limit');
  if (status === 404) return new DataProviderError(`${vendor}: symbol or data not found.`, 'not_found');
  if (status === 502 || status === 503 || status === 504)
    return new DataProviderError(`Could not reach ${vendor} (HTTP ${status}). Check your internet connection, and run the app with npm run dev or npm run preview so the local data proxy is available.`, 'network');
  const detail = body.trim().slice(0, 200);
  return new DataProviderError(`${vendor} request failed (HTTP ${status})${detail ? `: ${detail}` : '.'}`, 'network');
}

export class PolygonProvider implements HistoricalDataProvider {
  readonly id = 'polygon';
  readonly name = 'Polygon.io / Massive (API key)';
  readonly source = 'HISTORICAL' as const;
  readonly requiresCredentials = true;

  constructor(
    private creds: CredGetter,
    private baseUrl = '/api/polygon',
    private fetchFn: FetchFn = (...a) => fetch(...a),
  ) {}

  unavailableReason(): string | null {
    const c = this.creds();
    return c.polygonApiKey || c.serverHasPolygonKey ? null : 'Add a Polygon API key in Data & Settings.';
  }

  async listSymbols(): Promise<SymbolInfo[]> {
    return COMMON_SYMBOLS;
  }

  baseTimeframe(): Timeframe {
    return '1m';
  }

  async availableRange(): Promise<{ from: UnixSeconds; to: UnixSeconds } | null> {
    return null;
  }

  async getBars(req: BarRequest, signal?: AbortSignal): Promise<Bar[]> {
    const key = this.creds().polygonApiKey;
    const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
    let url: string | null = `${this.baseUrl}/v2/aggs/ticker/${encodeURIComponent(req.symbol.toUpperCase())}/range/1/minute/${req.from * 1000}/${req.to * 1000 - 1}?adjusted=true&sort=asc&limit=50000`;
    const out: Bar[] = [];
    for (let page = 0; url && page < 50; page++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, { headers, signal });
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        throw new DataProviderError(`Could not reach Polygon through the local proxy (${(e as Error).message}). Run the app with "npm run dev".`, 'network');
      }
      const text = await res.text();
      if (!res.ok) throw httpError(res.status, text, 'Polygon');
      let json: { results?: { t: number; o: number; h: number; l: number; c: number; v: number }[]; next_url?: string; status?: string; error?: string };
      try {
        json = JSON.parse(text);
      } catch {
        throw new DataProviderError('Polygon returned a non-JSON response.', 'invalid');
      }
      if (json.status === 'ERROR') throw new DataProviderError(`Polygon: ${json.error ?? 'error'}`, 'unknown');
      for (const r of json.results ?? []) {
        const t = Math.floor(r.t / 1000);
        if (t >= req.from && t < req.to) out.push({ time: t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v ?? 0 });
      }
      // next_url points at the vendor host; route it back through the proxy.
      url = json.next_url ? json.next_url.replace(/^https?:\/\/[^/]+/, this.baseUrl) : null;
    }
    return out;
  }
}

export class AlpacaProvider implements HistoricalDataProvider {
  readonly id = 'alpaca';
  readonly name = 'Alpaca Market Data (API key)';
  readonly source = 'HISTORICAL' as const;
  readonly requiresCredentials = true;

  constructor(
    private creds: CredGetter,
    private baseUrl = '/api/alpaca',
    private fetchFn: FetchFn = (...a) => fetch(...a),
  ) {}

  unavailableReason(): string | null {
    const c = this.creds();
    return (c.alpacaKeyId && c.alpacaSecret) || c.serverHasAlpacaKey ? null : 'Add an Alpaca key ID and secret in Data & Settings.';
  }

  async listSymbols(): Promise<SymbolInfo[]> {
    return COMMON_SYMBOLS;
  }

  baseTimeframe(): Timeframe {
    return '1m';
  }

  async availableRange(): Promise<{ from: UnixSeconds; to: UnixSeconds } | null> {
    return null;
  }

  async getBars(req: BarRequest, signal?: AbortSignal): Promise<Bar[]> {
    const c = this.creds();
    const headers: Record<string, string> = {};
    if (c.alpacaKeyId && c.alpacaSecret) {
      headers['APCA-API-KEY-ID'] = c.alpacaKeyId;
      headers['APCA-API-SECRET-KEY'] = c.alpacaSecret;
    }
    const out: Bar[] = [];
    let token: string | undefined;
    for (let page = 0; page < 100; page++) {
      const qs = new URLSearchParams({
        timeframe: '1Min',
        start: new Date(req.from * 1000).toISOString(),
        end: new Date((req.to - 1) * 1000).toISOString(),
        limit: '10000',
        adjustment: 'split',
        feed: c.alpacaFeed ?? 'iex',
        sort: 'asc',
      });
      if (token) qs.set('page_token', token);
      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseUrl}/v2/stocks/${encodeURIComponent(req.symbol.toUpperCase())}/bars?${qs}`, { headers, signal });
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        throw new DataProviderError(`Could not reach Alpaca through the local proxy (${(e as Error).message}). Run the app with "npm run dev".`, 'network');
      }
      const text = await res.text();
      if (!res.ok) throw httpError(res.status, text, 'Alpaca');
      let json: { bars?: { t: string; o: number; h: number; l: number; c: number; v: number }[] | null; next_page_token?: string | null };
      try {
        json = JSON.parse(text);
      } catch {
        throw new DataProviderError('Alpaca returned a non-JSON response.', 'invalid');
      }
      for (const b of json.bars ?? []) {
        const t = Math.floor(Date.parse(b.t) / 1000);
        out.push({ time: t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v ?? 0 });
      }
      token = json.next_page_token ?? undefined;
      if (!token) break;
    }
    return out;
  }
}
