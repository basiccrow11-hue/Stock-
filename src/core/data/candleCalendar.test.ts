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
});
