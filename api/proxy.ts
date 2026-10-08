/**
 * Vercel function: same-origin proxy for market-data vendors (the browser cannot call them directly
 * because of CORS). Mirrors the dev/preview proxy in vite.config.ts.
 *
 * vercel.json rewrites
 *   /api/polygon/<path>  -> /api/proxy?vendor=polygon&path=<path>
 *   /api/alpaca/<path>   -> /api/proxy?vendor=alpaca&path=<path>
 *   /api/server-keys     -> /api/proxy?vendor=keys
 *
 * Security:
 *  - Only the two bar endpoints the app uses are forwarded; anything else is refused, so this is not
 *    an open proxy.
 *  - By default only keys sent by the user's own browser are forwarded. Keys stored on the server
 *    (POLYGON_API_KEY, ALPACA_KEY_ID + ALPACA_SECRET) are used only when ALLOW_SERVER_KEYS=true,
 *    because on a public deployment every visitor could otherwise spend them. Turn that on only for
 *    a deployment protected by Vercel Authentication or a password.
 *  - Keys are never logged or echoed back.
 *
 * Self-contained on purpose (no imports), so the function bundles the same everywhere.
 */

const POLYGON_PATH = /^v2\/aggs\/ticker\/[A-Za-z0-9.:%-]{1,32}\/range\/\d{1,4}\/(?:minute|hour|day)\/\d{10,13}\/\d{10,13}$/;
const ALPACA_PATH = /^v2\/stocks\/[A-Za-z0-9.%-]{1,32}\/bars$/;
const POLYGON_QUERY = new Set(['adjusted', 'sort', 'limit', 'cursor']);
const ALPACA_QUERY = new Set(['timeframe', 'start', 'end', 'limit', 'adjustment', 'feed', 'sort', 'page_token']);

type Env = Record<string, string | undefined>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

function serverKeysAllowed(env: Env): boolean {
  return env.ALLOW_SERVER_KEYS === 'true';
}

export interface Upstream {
  url: string;
  headers: Record<string, string>;
}

/** Validate a proxied request and build the upstream call. Returns a Response for refusals. */
export function buildUpstream(request: Request, env: Env): Upstream | Response {
  const url = new URL(request.url);
  const vendor = url.searchParams.get('vendor');
  const path = (url.searchParams.get('path') ?? '').replace(/^\/+/, '');
  const pick = (allowed: Set<string>) => {
    const q = new URLSearchParams();
    for (const [k, v] of url.searchParams) if (allowed.has(k)) q.append(k, v);
    const s = q.toString();
    return s ? `?${s}` : '';
  };

  if (vendor === 'polygon') {
    if (!POLYGON_PATH.test(path)) return json(400, { error: 'Unsupported Polygon endpoint.' });
    const headers: Record<string, string> = { accept: 'application/json' };
    const auth = request.headers.get('authorization');
    if (auth && /^Bearer [A-Za-z0-9_-]{8,128}$/.test(auth)) headers.authorization = auth;
    else if (serverKeysAllowed(env) && env.POLYGON_API_KEY) headers.authorization = `Bearer ${env.POLYGON_API_KEY}`;
    else return json(401, { error: 'No Polygon API key. Add yours in Data & Settings.' });
    const base = (env.POLYGON_BASE_URL || 'https://api.polygon.io').replace(/\/+$/, '');
    return { url: `${base}/${path}${pick(POLYGON_QUERY)}`, headers };
  }

  if (vendor === 'alpaca') {
    if (!ALPACA_PATH.test(path)) return json(400, { error: 'Unsupported Alpaca endpoint.' });
    const headers: Record<string, string> = { accept: 'application/json' };
    const id = request.headers.get('apca-api-key-id');
    const secret = request.headers.get('apca-api-secret-key');
    if (id && secret) {
      headers['APCA-API-KEY-ID'] = id;
      headers['APCA-API-SECRET-KEY'] = secret;
    } else if (serverKeysAllowed(env) && env.ALPACA_KEY_ID && env.ALPACA_SECRET) {
      headers['APCA-API-KEY-ID'] = env.ALPACA_KEY_ID;
      headers['APCA-API-SECRET-KEY'] = env.ALPACA_SECRET;
    } else return json(401, { error: 'No Alpaca key. Add your key ID and secret in Data & Settings.' });
    return { url: `https://data.alpaca.markets/${path}${pick(ALPACA_QUERY)}`, headers };
  }

  return json(404, { error: 'Unknown endpoint.' });
}

export async function handle(request: Request, env: Env, fetchFn: typeof fetch = fetch): Promise<Response> {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' });
  const vendor = new URL(request.url).searchParams.get('vendor');
  if (vendor === 'keys') {
    const allow = serverKeysAllowed(env);
    return json(200, { polygon: allow && !!env.POLYGON_API_KEY, alpaca: allow && !!(env.ALPACA_KEY_ID && env.ALPACA_SECRET) });
  }
  const up = buildUpstream(request, env);
  if (up instanceof Response) return up;
  let res: Response;
  try {
    res = await fetchFn(up.url, { headers: up.headers, signal: AbortSignal.timeout(25_000) });
  } catch {
    return json(502, { error: 'Could not reach the market-data vendor.' });
  }
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
  });
}

export function GET(request: Request): Promise<Response> {
  return handle(request, process.env);
}
