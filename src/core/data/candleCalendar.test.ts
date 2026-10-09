import { describe, expect, it } from 'vitest';
import type { Bar, Timeframe } from '../types';
import { exchangeTimeToUnix, parseHHMM } from '../time';
import { candleCalendar } from './candleCalendar';

const at = (date: string, hhmm: string) => exchangeTimeToUnix(date, parseHHMM(hhmm));
const bar = (time: number): Bar => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 });

/** Candles every `minutes` from `from` to `to` (inclusive) on each date. */
function day(date: string, from: string, to: string, minutes: number): Bar[] {
  const out: Bar[] = [];
  for (let t = at(date, from); t <= at(date, to); t += minutes * 60) out.push(bar(t));
  return out;
}

describe('candle calendar past the data', () => {
  const extended5m = [...day('2024-03-12', '04:00', '19:55', 5), ...day('2024-03-13', '04:00', '19:40', 5)];

  it('continues the session, then skips the night to the next pre-market open', () => {
    const cal = candleCalendar(extended5m, '5m');
    expect(cal.next(at('2024-03-13', '19:40'))).toBe(at('2024-03-13', '19:45'));
    expect(cal.next(at('2024-03-13', '19:55'))).toBe(at('2024-03-14', '04:00'));
    expect(cal.slots(at('2024-03-13', '19:40'), at('2024-03-14', '04:00'))).toBe(4);
    expect(cal.after(at('2024-03-13', '19:40'), 4)).toBe(at('2024-03-14', '04:00'));
    // A time in the overnight gap belongs to the next session's first candle.
    expect(cal.slots(at('2024-03-13', '19:40'), at('2024-03-13', '23:00'))).toBe(4);
    // Inside a candle: its fraction.
    expect(cal.slots(at('2024-03-13', '19:40'), at('2024-03-13', '19:45') + 150)).toBe(1.5);
  });

  it('skips weekends and holidays', () => {
    const cal = candleCalendar(extended5m, '5m');
    expect(cal.next(at('2024-03-15', '19:55'))).toBe(at('2024-03-18', '04:00'));
    // 2024-03-29 is Good Friday.
    expect(cal.next(at('2024-03-28', '19:55'))).toBe(at('2024-04-01', '04:00'));
    const daily = candleCalendar([bar(at('2024-03-12', '09:30')), bar(at('2024-03-13', '09:30'))], '1D');
    expect(daily.after(at('2024-03-13', '09:30'), 3)).toBe(at('2024-03-18', '09:30'));
    expect(daily.slots(at('2024-03-13', '09:30'), at('2024-03-18', '09:30'))).toBe(3);
    // Saturday falls on Monday's candle.
    expect(daily.slots(at('2024-03-13', '09:30'), at('2024-03-16', '12:00'))).toBe(3);
    expect(daily.next(at('2024-03-28', '09:30'))).toBe(at('2024-04-01', '09:30'));
  });

  it('ends an early-close day four hours after its 13:00 close', () => {
    const data = [...day('2024-11-25', '04:00', '19:55', 5), ...day('2024-11-26', '04:00', '12:00', 5)];
    const cal = candleCalendar(data, '5m');
    // Thanksgiving (28th) is closed; the 29th closes at 13:00 and after-hours ends at 17:00.
    expect(cal.next(at('2024-11-27', '19:55'))).toBe(at('2024-11-29', '04:00'));
    expect(cal.next(at('2024-11-29', '16:50'))).toBe(at('2024-11-29', '16:55'));
    expect(cal.next(at('2024-11-29', '16:55'))).toBe(at('2024-12-02', '04:00'));
    const hourly = candleCalendar([...day('2024-11-25', '03:30', '19:30', 60), ...day('2024-11-26', '03:30', '10:30', 60)], '1h');
    expect(hourly.next(at('2024-11-29', '16:30'))).toBe(at('2024-12-02', '03:30'));
  });

  it('does not carry an early close over to normal days when the data ends on one', () => {
    // The last full day of data is the 13:00 close on 2024-11-29.
    const extended = candleCalendar([...day('2024-11-29', '01:30', '13:30', 240), ...day('2024-12-02', '01:30', '01:30', 240)], '4h');
    expect(extended.next(at('2024-12-02', '13:30'))).toBe(at('2024-12-02', '17:30'));
    expect(extended.next(at('2024-12-02', '17:30'))).toBe(at('2024-12-03', '01:30'));
    const regular = candleCalendar([...day('2024-11-29', '09:30', '09:30', 240), ...day('2024-12-02', '09:30', '09:30', 240)], '4h');
    expect(regular.next(at('2024-12-02', '09:30'))).toBe(at('2024-12-02', '13:30'));
    expect(regular.next(at('2024-12-02', '13:30'))).toBe(at('2024-12-03', '09:30'));
    // And the early-close day itself keeps one regular 4h candle.
    expect(regular.next(at('2024-11-29', '09:30'))).toBe(at('2024-12-02', '09:30'));
  });

  it('follows the hours the data has: regular session only', () => {
    const regular = [...day('2024-03-12', '09:30', '15:55', 5), ...day('2024-03-13', '09:30', '11:00', 5)];
    const cal = candleCalendar(regular, '5m');
    expect(cal.next(at('2024-03-13', '15:55'))).toBe(at('2024-03-14', '09:30'));
    // One partial day of regular-hours data: the standard session.
    const single = candleCalendar(day('2024-03-13', '10:00', '11:00', 5), '5m');
    expect(single.next(at('2024-03-13', '15:55'))).toBe(at('2024-03-14', '09:30'));
    const singleExt = candleCalendar(day('2024-03-13', '04:00', '11:00', 5), '5m');
    expect(singleExt.next(at('2024-03-13', '15:55'))).toBe(at('2024-03-13', '16:00'));
    expect(singleExt.next(at('2024-03-13', '19:55'))).toBe(at('2024-03-14', '04:00'));
  });

  it('counts slots and finds them again, over weeks, on every timeframe', () => {
    const tfs: [Timeframe, number, string, string][] = [
      ['1m', 1, '04:00', '19:59'],
      ['15m', 15, '04:00', '19:45'],
      ['4h', 240, '01:30', '17:30'],
    ];
    for (const [tf, minutes, open, close] of tfs) {
      const data = [...day('2024-03-11', open, close, minutes), ...day('2024-03-12', open, open, minutes)];
      const cal = candleCalendar(data, tf);
      const from = data[data.length - 1].time;
      for (const k of [0, 1, 7, 100, 999]) {
        const t = cal.after(from, k);
        expect(cal.slots(from, t)).toBe(k);
        expect(cal.after(from, k + 1)).toBe(cal.next(t));
      }
    }
  });

  it('agrees with a candle-by-candle walk across holidays and early closes', () => {
    const cases: [Timeframe, Bar[]][] = [
      ['5m', [...day('2024-11-18', '04:00', '19:55', 5), ...day('2024-11-19', '04:00', '04:00', 5)]],
      ['5m', [...day('2024-11-18', '09:30', '15:55', 5), ...day('2024-11-19', '09:30', '09:30', 5)]],
      ['1h', [...day('2024-11-18', '03:30', '19:30', 60), ...day('2024-11-19', '03:30', '03:30', 60)]],
      ['4h', [...day('2024-11-18', '01:30', '17:30', 240), ...day('2024-11-19', '01:30', '01:30', 240)]],
    ];
    for (const [tf, data] of cases) {
      const cal = candleCalendar(data, tf);
      const from = data[data.length - 1].time;
      // Through Thanksgiving, the 11-29 and 12-24 early closes, Christmas and New Year.
      let c = from;
      for (let i = 0; c < at('2025-01-06', '00:00'); i++, c = cal.next(c)) {
        expect(cal.slots(from, c)).toBe(i);
        expect(cal.after(from, i)).toBe(c);
      }
    }
  });

  it('counts years ahead without walking every candle', () => {
    const data = [...day('2019-03-11', '04:00', '19:59', 1), ...day('2019-03-12', '04:00', '04:00', 1)];
    const cal = candleCalendar(data, '1m');
    const from = data[data.length - 1].time;
    const far = at('2026-06-01', '12:00');
    const k = cal.slots(from, far);
    expect(cal.after(from, k)).toBe(far);
    const started = performance.now();
    for (let i = 0; i < 200; i++) {
      cal.slots(from, far + i * 60);
      cal.after(from, k + i);
    }
    // A chart projects every drawing point on every frame; this must stay far below a frame.
    expect((performance.now() - started) / 200).toBeLessThan(1);
  });

  /** Candles at the given times of day on each date. */
  const at_ = (dates: string[], times: string[]) => dates.flatMap((d) => times.map((t) => bar(at(d, t))));
  /** A candle-by-candle walk must find `want` (the real candles after `from`) slot by slot. */
  const walks = (cal: ReturnType<typeof candleCalendar>, from: number, want: number[]) => {
    want.forEach((t, k) => {
      expect(cal.after(from, k + 1)).toBe(t);
      expect(cal.slots(from, t)).toBe(k + 1);
    });
  };

  it("follows vendors' own bar times: clock-hour and 4-hour bars, half days included", () => {
    // Clock-hour hourly bars with a 09:30-10:00 first bar (IB style), through the 11-29 half day.
    const rth = ['09:30', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00'];
    const clock = candleCalendar(at_(['2024-11-25', '2024-11-26'], rth), '1h');
    expect(clock.next(at('2024-11-26', '09:30'))).toBe(at('2024-11-26', '10:00'));
    walks(clock, at('2024-11-26', '15:00'), [
      ...rth.map((t) => at('2024-11-27', t)),
      ...['09:30', '10:00', '11:00', '12:00'].map((t) => at('2024-11-29', t)),
      at('2024-12-02', '09:30'),
    ]);
    // A time inside the short first candle is that far through it.
    expect(clock.slots(at('2024-11-26', '15:00'), at('2024-11-27', '09:45'))).toBe(1.5);
    // 4-hour bars from 04:00 with extended hours: the half day keeps its 16:00-17:00 bar.
    const four = candleCalendar(at_(['2024-11-26', '2024-11-27'], ['04:00', '08:00', '12:00', '16:00']), '4h');
    walks(four, at('2024-11-27', '16:00'), [...['04:00', '08:00', '12:00', '16:00'].map((t) => at('2024-11-29', t)), at('2024-12-02', '04:00')]);
  });

  it('starts after-hours bars at an early close when the data starts them at the close', () => {
    // yfinance hourly with pre- and post-market: 04:00-09:00, 09:30-15:30, then 16:00-19:00.
    const yf = ['04:00', '05:00', '06:00', '07:00', '08:00', '09:00', '09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:30', '16:00', '17:00', '18:00', '19:00'];
    const cal = candleCalendar(at_(['2024-11-26', '2024-11-27'], yf), '1h');
    const half = ['04:00', '05:00', '06:00', '07:00', '08:00', '09:00', '09:30', '10:30', '11:30', '12:30', '13:00', '14:00', '15:00', '16:00'];
    walks(cal, at('2024-11-27', '19:00'), [...half.map((t) => at('2024-11-29', t)), ...yf.map((t) => at('2024-12-02', t))]);
    // And from a half day to a normal one.
    const fromHalf = candleCalendar(at_(['2024-11-29', '2024-12-02'], half).slice(0, half.length + 1), '1h');
    walks(fromHalf, at('2024-12-02', '04:00'), yf.slice(1).map((t) => at('2024-12-02', t)));
  });
});

