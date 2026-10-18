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

  it('puts a fill or headline whose own candle never formed on the candle of the last bar before it, as on screen', async () => {
    const { offscreenSnapshot } = await import('./offscreenSnapshot');
    const et = (date: string, hhmm: string, seconds = 0) => exchangeTimeToUnix(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) + seconds;
    /** 1-minute bars on `date` from `from` up to `to`. */
    const minutes = (date: string, from: string, to: string): Bar[] => {
      const out: Bar[] = [];
      for (let t = et(date, from); t < et(date, to); t += 60) out.push({ time: t, open: 100, high: 100.5, low: 99.5, close: 100.2, volume: 1000 });
      return out;
    };
    const at = (time: number, side: 'buy' | 'sell'): Fill => ({ ...fill(0, side), id: `f${time}${side}`, time });
    const D1 = '2025-03-10';
    const D2 = '2025-03-11';
    // The regular session only, with no bars from 14:30 to 15:34 on the first day: bought as the gap
    // begins, sold at the close after the last bar and bought again there, sold the next morning.
    // A headline comes in the gap.
    const rth = {
      bars: [...minutes(D1, '09:30', '14:30'), ...minutes(D1, '15:35', '16:00'), ...minutes(D2, '09:30', '09:45')],
      fills: [at(et(D1, '14:30'), 'buy'), at(et(D1, '16:00'), 'sell'), at(et(D1, '16:00'), 'buy'), at(et(D2, '09:40', 30), 'sell')],
      news: [{ ...news(0), time: et(D1, '14:47') }],
      entryTime: et(D1, '16:00'),
    };
    // Extended hours: bought at 20:00 after the last after-hours bar, sold in the next pre-market.
    const ext = {
      bars: [...minutes(D1, '09:30', '20:00'), ...minutes(D2, '04:00', '04:10')],
      fills: [at(et(D1, '20:00'), 'buy'), at(et(D2, '04:05', 30), 'sell')],
      news: [],
      entryTime: et(D1, '20:00'),
    };
    const cases = [
      { timeframe: '5m', scene: rth, want: [[D1, '14:25'], [D1, '14:25'], [D1, '15:55'], [D1, '15:55'], [D2, '09:40']] },
      { timeframe: '1h', scene: rth, want: [[D1, '13:30'], [D1, '13:30'], [D1, '15:30'], [D1, '15:30'], [D2, '09:30']] },
      { timeframe: '5m', scene: ext, want: [[D1, '19:55'], [D2, '04:05']] },
      { timeframe: '1h', scene: ext, want: [[D1, '19:30'], [D2, '03:30']] },
    ] as const;
    for (const { timeframe, scene, want } of cases) {
      handed.series.length = 0;
      handed.markers.length = 0;
      await offscreenSnapshot({ symbol: 'MSFT', timeframe, baseTimeframe: '1m', ...scene, fills: [...scene.fills], news: [...scene.news], bars: [...scene.bars], source: 'DEMO', blind: null });
      const candles = handed.series[0].map((c) => c.time);
      const markers = handed.markers[0].map((m) => m.time);
      expect(markers).toEqual(want.map(([d, hhmm]) => toChartTime(et(d, hhmm))));
      for (const m of markers) expect(candles).toContain(m);
    }
  });
});
