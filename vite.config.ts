import { defineConfig } from 'vitest/config';
import { loadEnv, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Market-data proxy.
 *
 * The browser calls same-origin paths (/api/polygon, /api/alpaca) and this server forwards them to
 * the vendor. Two ways to supply keys:
 *  1. Server-side (most secure): put POLYGON_API_KEY or ALPACA_KEY_ID + ALPACA_SECRET in .env.local.
 *     They are injected here and never reach the browser bundle (no VITE_ prefix).
 *  2. Browser-side: enter keys in Data & Settings; they are sent per request as headers.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  const proxy: Record<string, ProxyOptions> = {
    '/api/polygon': {
      target: env.POLYGON_BASE_URL || 'https://api.polygon.io',
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/api\/polygon/, ''),
      configure: (p) =>
        p.on('proxyReq', (req) => {
          if (env.POLYGON_API_KEY && !req.getHeader('authorization')) req.setHeader('authorization', `Bearer ${env.POLYGON_API_KEY}`);
        }),
    },
    '/api/alpaca': {
      target: 'https://data.alpaca.markets',
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/api\/alpaca/, ''),
      configure: (p) =>
        p.on('proxyReq', (req) => {
          if (env.ALPACA_KEY_ID && env.ALPACA_SECRET && !req.getHeader('apca-api-key-id')) {
            req.setHeader('APCA-API-KEY-ID', env.ALPACA_KEY_ID);
            req.setHeader('APCA-API-SECRET-KEY', env.ALPACA_SECRET);
          }
        }),
    },
  };

  /** Tells the app WHETHER server-side keys exist (never the keys themselves). */
  const serverKeyStatus: Plugin = {
    name: 'server-key-status',
    configureServer(server) {
      server.middlewares.use('/api/server-keys', (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ polygon: !!env.POLYGON_API_KEY, alpaca: !!(env.ALPACA_KEY_ID && env.ALPACA_SECRET) }));
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/server-keys', (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ polygon: !!env.POLYGON_API_KEY, alpaca: !!(env.ALPACA_KEY_ID && env.ALPACA_SECRET) }));
      });
    },
  };

  return {
    plugins: [react(), serverKeyStatus],
    server: { proxy },
    preview: { proxy },
    // The trading screen bundle is React + lightweight-charts + the engine (~170 kB gzipped); secondary pages are split out.
    build: { chunkSizeWarningLimit: 700 },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    },
  };
});
