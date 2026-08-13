import { describe, it, expect } from 'vitest';
import {
  DateTimeError,
  MS_PER_DAY,
  MUSCAT_UTC_OFFSET_MINUTES,
  addDays,
  calendarDaysBetween,
  daysLate,
  formatMuscat,
  fromMuscatWallTime,
  startOfMuscatDay,
  toMuscatDate,
  toMuscatTime,
  toMuscatWallTime,
} from './datetime';

describe('the boutique timezone', () => {
  it('is UTC+4 with no daylight saving', () => {
    expect(MUSCAT_UTC_OFFSET_MINUTES).toBe(240);
  });
});

describe('fromMuscatWallTime()', () => {
  it('interprets wall time in Muscat, not in the runtime timezone', () => {
    // 10:00 in Muscat is 06:00 UTC. This must hold regardless of where the
    // tablet running the application thinks it is.
    const instant = fromMuscatWallTime('2026-09-10T10:00');
    expect(new Date(instant).toISOString()).toBe('2026-09-10T06:00:00.000Z');
  });

  it('round-trips through the wall-time renderer', () => {
    for (const wall of [
      '2026-01-01T00:00',
      '2026-06-15T13:45',
      '2026-12-31T23:59',
      '2028-02-29T12:00',
    ]) {
      expect(toMuscatWallTime(fromMuscatWallTime(wall))).toBe(wall);
    }
  });

  it('handles midnight, where a naive UTC conversion changes the day', () => {
    // 00:00 Muscat on 11 Sep is 20:00 UTC on 10 Sep. Reading the UTC date would
    // put the pickup on the wrong day.
    const instant = fromMuscatWallTime('2026-09-11T00:00');

    expect(new Date(instant).toISOString()).toBe('2026-09-10T20:00:00.000Z');
    expect(toMuscatDate(instant)).toBe('2026-09-11');
    expect(toMuscatTime(instant)).toBe('00:00');
  });

  it('handles the last minute of a day', () => {
    const instant = fromMuscatWallTime('2026-09-10T23:59');
    expect(toMuscatDate(instant)).toBe('2026-09-10');
    expect(toMuscatTime(instant)).toBe('23:59');
  });

  it('accepts a space instead of T', () => {
    expect(fromMuscatWallTime('2026-09-10 10:00')).toBe(fromMuscatWallTime('2026-09-10T10:00'));
  });

  it('rejects a malformed value', () => {
    for (const value of ['', '2026-09-10', '10:00', '2026-9-10T10:00', 'nonsense']) {
      expect(() => fromMuscatWallTime(value)).toThrow(DateTimeError);
    }
  });

  it('rejects a date that does not exist rather than rolling it over', () => {
    expect(() => fromMuscatWallTime('2026-02-30T10:00')).toThrow(/does not exist/);
    expect(() => fromMuscatWallTime('2026-13-01T10:00')).toThrow();
    expect(() => fromMuscatWallTime('2026-02-29T10:00')).toThrow(/does not exist/);
  });

  it('accepts a genuine leap day', () => {
    expect(() => fromMuscatWallTime('2028-02-29T10:00')).not.toThrow();
  });

  it('rejects an impossible time', () => {
    expect(() => fromMuscatWallTime('2026-09-10T24:00')).toThrow();
    expect(() => fromMuscatWallTime('2026-09-10T10:60')).toThrow();
  });
});

describe('startOfMuscatDay()', () => {
  it('is midnight in Muscat, not midnight UTC', () => {
    const instant = startOfMuscatDay('2026-09-10');
    expect(new Date(instant).toISOString()).toBe('2026-09-09T20:00:00.000Z');
    expect(toMuscatWallTime(instant)).toBe('2026-09-10T00:00');
  });

  it('rejects a malformed or impossible date', () => {
    expect(() => startOfMuscatDay('2026-9-10')).toThrow();
    expect(() => startOfMuscatDay('2026-02-30')).toThrow();
  });
});

describe('toMuscatDate() around boundaries', () => {
  it('reports the Muscat day for an instant late in the UTC day', () => {
    // 21:00 UTC on 10 Sep is 01:00 Muscat on 11 Sep.
    const instant = Date.parse('2026-09-10T21:00:00.000Z');
    expect(toMuscatDate(instant)).toBe('2026-09-11');
  });

  it('reports the Muscat day for an instant early in the UTC day', () => {
    // 01:00 UTC on 11 Sep is 05:00 Muscat on 11 Sep.
    const instant = Date.parse('2026-09-11T01:00:00.000Z');
    expect(toMuscatDate(instant)).toBe('2026-09-11');
  });

  it('crosses a year boundary correctly', () => {
    const instant = Date.parse('2026-12-31T20:00:00.000Z');
    expect(toMuscatDate(instant)).toBe('2027-01-01');
  });
});

describe('addDays()', () => {
  it('adds whole days', () => {
    const start = fromMuscatWallTime('2026-09-10T11:00');
    expect(toMuscatWallTime(addDays(start, 3))).toBe('2026-09-13T11:00');
  });

  it('keeps the wall-clock time, because Oman has no DST transitions', () => {
    // In a DST timezone this would drift by an hour twice a year, and the
    // cleaning buffer would expire at the wrong moment.
    for (const wall of ['2026-03-28T11:00', '2026-10-24T11:00']) {
      const start = fromMuscatWallTime(wall);
      expect(toMuscatTime(addDays(start, 1))).toBe('11:00');
    }
  });

  it('crosses month and year boundaries', () => {
    expect(toMuscatDate(addDays(fromMuscatWallTime('2026-09-30T11:00'), 1))).toBe('2026-10-01');
    expect(toMuscatDate(addDays(fromMuscatWallTime('2026-12-31T11:00'), 1))).toBe('2027-01-01');
  });

  it('subtracts with a negative value', () => {
    expect(toMuscatDate(addDays(fromMuscatWallTime('2026-09-10T11:00'), -1))).toBe('2026-09-09');
  });

  it('rejects a fractional number of days', () => {
    expect(() => addDays(0, 1.5)).toThrow(DateTimeError);
  });
});

describe('daysLate()', () => {
  const scheduled = fromMuscatWallTime('2026-09-12T11:00');

  it('is zero when returned on time or early', () => {
    expect(daysLate(scheduled, scheduled)).toBe(0);
    expect(daysLate(scheduled, scheduled - MS_PER_DAY)).toBe(0);
  });

  it('rounds up — three hours late is one day late', () => {
    // A boutique charges for the day, not the hour.
    expect(daysLate(scheduled, scheduled + 3 * 60 * 60 * 1000)).toBe(1);
  });

  it('counts exactly one day as one', () => {
    expect(daysLate(scheduled, scheduled + MS_PER_DAY)).toBe(1);
  });

  it('rounds a day and an hour up to two', () => {
    expect(daysLate(scheduled, scheduled + MS_PER_DAY + 60 * 60 * 1000)).toBe(2);
  });
});

describe('calendarDaysBetween()', () => {
  it('counts calendar days, ignoring the time of day', () => {
    const from = fromMuscatWallTime('2026-09-10T23:00');
    const to = fromMuscatWallTime('2026-09-11T01:00');

    // Two hours apart, but a different day — which is what a customer means.
    expect(calendarDaysBetween(from, to)).toBe(1);
  });

  it('is zero within one day', () => {
    expect(
      calendarDaysBetween(fromMuscatWallTime('2026-09-10T01:00'), fromMuscatWallTime('2026-09-10T23:00')),
    ).toBe(0);
  });
});

describe('formatMuscat()', () => {
  it('renders in the boutique timezone', () => {
    const instant = Date.parse('2026-09-10T06:00:00.000Z');
    expect(formatMuscat(instant)).toContain('10');
    expect(formatMuscat(instant)).toContain('10:00');
  });

  it('uses Latin digits in Arabic, so a date on an invoice is unambiguous', () => {
    const instant = fromMuscatWallTime('2026-09-10T10:00');
    expect(formatMuscat(instant, 'ar')).toMatch(/\d/);
  });
});
