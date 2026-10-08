import { describe, expect, it } from 'vitest';
import {
  EARLY_CLOSE,
  REGULAR_CLOSE,
  exchangeDate,
  exchangeOffsetSeconds,
  isTradingDay,
  marketSession,
  nextTradingDay,
  prevTradingDay,
  regularCloseMinute,
  tradingDaysBetween,
  withoutDates,
} from '../time';
import { et } from './helpers';

describe('exchange calendar', () => {
  it('handles DST: 09:30 ET is 14:30 UTC in winter and 13:30 UTC in summer', () => {
    expect(new Date(et('2025-01-15', '09:30') * 1000).toISOString()).toBe('2025-01-15T14:30:00.000Z');
    expect(new Date(et('2025-07-15', '09:30') * 1000).toISOString()).toBe('2025-07-15T13:30:00.000Z');
    // Day after spring-forward
    expect(new Date(et('2025-03-10', '09:30') * 1000).toISOString()).toBe('2025-03-10T13:30:00.000Z');
    expect(exchangeOffsetSeconds(et('2025-01-15', '12:00'))).toBe(-5 * 3600);
  });

  it('knows NYSE holidays and special closures', () => {
    expect(isTradingDay('2025-01-01')).toBe(false); // New Year
    expect(isTradingDay('2025-01-09')).toBe(false); // National Day of Mourning (Carter)
    expect(isTradingDay('2025-01-20')).toBe(false); // MLK
    expect(isTradingDay('2025-04-18')).toBe(false); // Good Friday
    expect(isTradingDay('2025-06-19')).toBe(false); // Juneteenth
    expect(isTradingDay('2025-07-04')).toBe(false);
    expect(isTradingDay('2025-11-27')).toBe(false); // Thanksgiving
    expect(isTradingDay('2025-12-25')).toBe(false);
    expect(isTradingDay('2026-07-03')).toBe(false); // July 4 2026 is a Saturday -> observed Friday
    expect(isTradingDay('2025-01-15')).toBe(true);
    expect(isTradingDay('2025-01-18')).toBe(false); // Saturday
    expect(isTradingDay('2022-12-31')).toBe(false); // Saturday New Year observed is not shifted
    expect(isTradingDay('2021-12-31')).toBe(true); // NYSE does not close Fri when Jan 1 is Saturday
  });

  it('knows early closes', () => {
    expect(regularCloseMinute('2024-11-29')).toBe(EARLY_CLOSE);
    expect(regularCloseMinute('2024-12-24')).toBe(EARLY_CLOSE);
    expect(regularCloseMinute('2025-07-03')).toBe(EARLY_CLOSE);
    expect(regularCloseMinute('2025-01-15')).toBe(REGULAR_CLOSE);
  });

  it('classifies market sessions', () => {
    expect(marketSession(et('2025-01-15', '03:59'))).toBe('closed');
    expect(marketSession(et('2025-01-15', '04:00'))).toBe('pre');
    expect(marketSession(et('2025-01-15', '09:29'))).toBe('pre');
    expect(marketSession(et('2025-01-15', '09:30'))).toBe('regular');
    expect(marketSession(et('2025-01-15', '15:59'))).toBe('regular');
    expect(marketSession(et('2025-01-15', '16:00'))).toBe('post');
    expect(marketSession(et('2025-01-15', '20:00'))).toBe('closed');
    expect(marketSession(et('2025-01-18', '10:00'))).toBe('closed');
    expect(marketSession(et('2024-11-29', '13:30'))).toBe('post');
  });

  it('walks trading days', () => {
    expect(nextTradingDay('2025-01-17')).toBe('2025-01-21'); // over weekend + MLK
    expect(prevTradingDay('2025-01-10')).toBe('2025-01-08'); // over Jan 9 closure
    expect(exchangeDate(et('2025-01-15', '23:59'))).toBe('2025-01-15');
  });
});

describe('calendar arithmetic', () => {
  it('counts trading days like a day-by-day walk, across years of weekends and holidays', () => {
    const walk = (from: string, to: string) => {
      let n = 0;
      for (let d = isTradingDay(from) ? from : nextTradingDay(from); d < to; d = nextTradingDay(d)) n++;
      return n;
    };
    const days = ['2019-01-01', '2019-12-24', '2020-03-14', '2021-07-02', '2022-12-26', '2024-03-28', '2024-11-27', '2025-01-01', '2026-06-01'];
    for (const a of days) for (const b of days) if (a <= b) expect(tradingDaysBetween(a, b)).toBe(walk(a, b));
  });
});

describe('blind-mode text', () => {
  it('replaces dates and ISO timestamps, and leaves other numbers alone', () => {
    expect(withoutDates('No QQQ data for 2024-03-13. Pick another date or data source.')).toBe('No QQQ data for this day. Pick another date or data source.');
    expect(withoutDates('start 2024-03-13T09:30:00.000Z invalid')).toBe('start this day invalid');
    expect(withoutDates('HTTP 429 after 1200 ms')).toBe('HTTP 429 after 1200 ms');
  });
});
