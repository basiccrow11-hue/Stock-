// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { Bar, Fill } from '../../core/types';
import type { SimEvent } from '../../core/sim/SimMarket';
import { exchangeTimeToUnix } from '../../core/time';
import { toChartTime } from './ChartView';

/** What the off-screen chart was handed: each series' data, in the order they were added, and the markers. */
const handed = vi.hoisted(() => ({ series: [] as { time: number }[][], markers: [] as { time: number; text?: string }[][] }));

// jsdom has no canvas: a stand-in chart keeps what it is handed and accepts any other call.
vi.mock('lightweight-charts', async (original) => {
  const actual = await original<typeof import('lightweight-charts')>();
  const any: unknown = new Proxy(function () {}, {
    get: (_t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => 0 : any),
    apply: () => any,
  });
  const series = () => {
    const data: { time: number }[] = [];
    handed.series.push(data);
    return new Proxy({}, { get: (_t, k) => (k === 'setData' ? (d: { time: number }[]) => data.push(...d) : any) });
  };
  const chart = {
    addSeries: series,
    panes: () => [any, any, any, any],
    priceScale: () => any,
    timeScale: () => any,
    takeScreenshot: () => ({ width: 960, height: 480, toDataURL: () => 'data:image/jpeg;base64,AA==' }),
    remove: () => undefined,
  };
  return {
    ...actual,
    createChart: () => chart,
    createSeriesMarkers: (_s: unknown, markers: { time: number }[]) => (handed.markers.push(markers), any),
    createTextWatermark: () => any,
  };
});

const DAY = '2025-03-10';
const at = (minute: number) => exchangeTimeToUnix(DAY, 9 * 60 + 30 + minute);

/** 1-minute bars from 09:30 on. */
function bars(n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => ({ time: at(i), open: 100 + i / 100, high: 100.5 + i / 100, low: 99.5 + i / 100, close: 100.2 + i / 100, volume: 1000 }));
}

function fill(minute: number, side: 'buy' | 'sell'): Fill {
  return {
    id: `f${minute}`,
    orderId: `o${minute}`,
    symbol: 'MSFT',
    action: side,
    side,
    quantity: 100,
    price: 100 + minute / 100,
    commission: 0,
    slippage: 0,
    spreadCost: 0,
    time: at(minute) + 30,
    realizedPnl: 0,
  };
}

const news = (minute: number): SimEvent => ({ id: `n${minute}`, time: at(minute) + 10, symbol: 'MARKET', type: 'economic_news', headline: `[SIMULATED] News at ${minute}`, impactPct: 0.5, simulated: true });

describe('a journal snapshot drawn off screen', () => {
  it("leaves out fills and news from before its first candle rather than piling them on it", async () => {
    const { offscreenSnapshot } = await import('./offscreenSnapshot');
    // An earlier trade at 09:40-09:45 with news at 09:50, then this trade from 13:40 (minute 250) to 13:50.
    const img = await offscreenSnapshot({
      symbol: 'MSFT',
      timeframe: '1m',
      baseTimeframe: '1m',
      bars: bars(261),
      fills: [fill(10, 'buy'), fill(15, 'sell'), fill(250, 'buy'), fill(260, 'sell')],
      news: [news(20), news(255)],
      entryTime: at(250) + 30,
      source: 'DEMO',
      blind: null,
    });
    expect(img).toBe('data:image/jpeg;base64,AA==');
    const first = handed.series[0][0].time;
    // The newest 101 candles: at least 100 before the last, more than 30 before the entry's.
    expect(first).toBe(toChartTime(at(160)));
    const markers = handed.markers[0];
    expect(markers.map((m) => m.time)).toEqual([at(250), at(255), at(260)].map((t) => toChartTime(t)));
    expect(markers.map((m) => m.text)).toEqual(['BUY 100 @ 102.50', 'SIM NEWS: News at 255', 'SELL 100 @ 102.60']);
  });
});
