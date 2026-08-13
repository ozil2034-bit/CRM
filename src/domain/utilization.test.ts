import { describe, expect, it } from 'vitest';

import { fromMuscatWallTime, startOfMuscatDay } from './datetime';
import {
  averageUtilization,
  computeUtilization,
  type BlockedSpan,
  type DressUtilization,
  type UtilizationPeriod,
} from './utilization';

/** September 2026: 30 days. */
const SEPTEMBER: UtilizationPeriod = {
  from: startOfMuscatDay('2026-09-01'),
  to: startOfMuscatDay('2026-10-01'),
};

const at = (wall: string) => fromMuscatWallTime(wall);

function span(from: string, to: string, blocking = true): BlockedSpan {
  return { blockStartAt: at(from), blockEndAt: at(to), blocking };
}

const compute = (input: {
  spans?: BlockedSpan[];
  availableFrom?: number;
  retiredAt?: number | null;
  period?: UtilizationPeriod;
}) =>
  computeUtilization({
    period: input.period ?? SEPTEMBER,
    spans: input.spans ?? [],
    availableFrom: input.availableFrom ?? startOfMuscatDay('2020-01-01'),
    retiredAt: input.retiredAt ?? null,
  });

/* ------------------------------------------------------------------------ *
 * The thing that must never be fabricated
 * ------------------------------------------------------------------------ */

describe('a dress with no operating days', () => {
  it('reports N/A, NOT 0%', () => {
    /*
     * Load-bearing. 0% is a judgement about a gown — "available all month and
     * never booked". A dress that did not exist yet deserves no judgement, and
     * printing one would misinform the owner about her own stock.
     */
    const result = compute({ availableFrom: startOfMuscatDay('2026-10-15') });

    expect(result.percent).toBeNull();
    expect(result.operatingDays).toBe(0);
  });

  it('reports N/A for a dress retired before the period', () => {
    const result = compute({ retiredAt: startOfMuscatDay('2026-08-01') });

    expect(result.percent).toBeNull();
  });

  it('reports N/A for an inverted period rather than throwing', () => {
    // A report must render even when its inputs are odd.
    const result = compute({
      period: { from: startOfMuscatDay('2026-10-01'), to: startOfMuscatDay('2026-09-01') },
    });

    expect(result.percent).toBeNull();
  });

  it('distinguishes N/A from a real zero', () => {
    const neverBooked = compute({ spans: [] });

    expect(neverBooked.percent).toBe(0);
    expect(neverBooked.operatingDays).toBe(30);
  });
});

/* ------------------------------------------------------------------------ *
 * The arithmetic
 * ------------------------------------------------------------------------ */

describe('counting blocked days', () => {
  it('counts a three-day block as three days of thirty', () => {
    const result = compute({ spans: [span('2026-09-10T10:00', '2026-09-13T10:00')] });

    expect(result.blockedDays).toBe(3);
    expect(result.operatingDays).toBe(30);
    expect(result.percent).toBe(10);
  });

  it('counts calendar days, not elapsed hours', () => {
    // Two hours on the clock, but it spans a day boundary and so consumed a day.
    const result = compute({ spans: [span('2026-09-07T23:00', '2026-09-08T01:00')] });

    expect(result.blockedDays).toBe(1);
  });

  it('counts a same-day block as one day, not zero', () => {
    // A gown out for three hours on a Saturday could not be rented that Saturday.
    const result = compute({ spans: [span('2026-09-07T10:00', '2026-09-07T13:00')] });

    expect(result.blockedDays).toBe(1);
  });

  it('does NOT let back-to-back bookings both claim the changeover day', () => {
    /*
     * Half-open intervals mean the second booking starts exactly where the
     * first ends. Counting the boundary twice would push a fully-booked gown
     * past 100%.
     */
    const result = compute({
      spans: [
        span('2026-09-01T10:00', '2026-09-05T10:00'),
        span('2026-09-05T10:00', '2026-09-09T10:00'),
      ],
    });

    expect(result.blockedDays).toBe(8);
  });

  it('includes the cleaning buffer, because the gown cannot earn during it', () => {
    // The span IS the blocked interval — rental plus buffer — as stored.
    const rentalOnly = compute({ spans: [span('2026-09-10T10:00', '2026-09-12T10:00')] });
    const withBuffer = compute({ spans: [span('2026-09-10T10:00', '2026-09-15T10:00')] });

    expect(withBuffer.blockedDays).toBeGreaterThan(rentalOnly.blockedDays);
  });

  it('ignores non-blocking spans — a cancelled booking occupied nothing', () => {
    const result = compute({
      spans: [span('2026-09-01T10:00', '2026-09-30T10:00', false)],
    });

    expect(result.blockedDays).toBe(0);
    expect(result.percent).toBe(0);
  });

  it('clamps a span that starts before the period', () => {
    const result = compute({ spans: [span('2026-08-25T10:00', '2026-09-03T10:00')] });

    // Only 1–3 September fall inside.
    expect(result.blockedDays).toBe(2);
  });

  it('clamps a span that runs past the period', () => {
    const result = compute({ spans: [span('2026-09-28T10:00', '2026-10-10T10:00')] });

    expect(result.blockedDays).toBe(3);
  });

  it('ignores a span entirely outside the period', () => {
    const result = compute({ spans: [span('2026-11-01T10:00', '2026-11-10T10:00')] });

    expect(result.blockedDays).toBe(0);
  });

  it('sums several separate bookings', () => {
    const result = compute({
      spans: [
        span('2026-09-01T10:00', '2026-09-04T10:00'),
        span('2026-09-10T10:00', '2026-09-13T10:00'),
      ],
    });

    expect(result.blockedDays).toBe(6);
    expect(result.percent).toBe(20);
  });

  it('merges overlapping spans instead of double-counting', () => {
    // Two spans covering the same days must not make a gown 200% busy.
    const result = compute({
      spans: [
        span('2026-09-01T10:00', '2026-09-10T10:00'),
        span('2026-09-05T10:00', '2026-09-15T10:00'),
      ],
    });

    expect(result.blockedDays).toBe(14);
    expect(result.percent).toBeLessThanOrEqual(100);
  });

  it('NEVER exceeds 100%, whatever the data says', () => {
    const result = compute({
      spans: [
        span('2026-09-01T00:00', '2026-10-01T00:00'),
        span('2026-09-01T00:00', '2026-10-01T00:00'),
        span('2026-09-01T00:00', '2026-10-01T00:00'),
      ],
    });

    expect(result.percent).toBe(100);
  });

  it('reports a fully booked month as 100%', () => {
    const result = compute({ spans: [span('2026-09-01T00:00', '2026-10-01T00:00')] });

    expect(result.percent).toBe(100);
  });
});

/* ------------------------------------------------------------------------ *
 * Part-period service
 * ------------------------------------------------------------------------ */

describe('a dress that was not in service all period', () => {
  it('measures only the days it was actually available', () => {
    // Bought on the 16th: fifteen operating days, not thirty.
    const result = compute({
      availableFrom: startOfMuscatDay('2026-09-16'),
      spans: [span('2026-09-20T10:00', '2026-09-23T10:00')],
    });

    expect(result.operatingDays).toBe(15);
    expect(result.percent).toBe(20);
  });

  it('does not punish a new dress for the days before it existed', () => {
    const wholeMonth = compute({ spans: [span('2026-09-20T10:00', '2026-09-23T10:00')] });
    const bought = compute({
      availableFrom: startOfMuscatDay('2026-09-16'),
      spans: [span('2026-09-20T10:00', '2026-09-23T10:00')],
    });

    expect(bought.percent).toBeGreaterThan(wholeMonth.percent ?? 0);
  });

  it('stops counting at retirement', () => {
    const result = compute({ retiredAt: startOfMuscatDay('2026-09-11') });

    expect(result.operatingDays).toBe(10);
  });

  it('ignores a booking recorded after retirement', () => {
    const result = compute({
      retiredAt: startOfMuscatDay('2026-09-11'),
      spans: [span('2026-09-20T10:00', '2026-09-25T10:00')],
    });

    expect(result.blockedDays).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Averaging
 * ------------------------------------------------------------------------ */

describe('the inventory average', () => {
  const row = (percent: number | null): DressUtilization => ({
    dressId: `d-${percent}`,
    dressCode: 'WD-0001',
    dressName: 'Aurora',
    result: { percent, blockedDays: 0, operatingDays: percent === null ? 0 : 30 },
  });

  it('averages the dresses that have an answer', () => {
    expect(averageUtilization([row(10), row(20), row(30)])).toBe(20);
  });

  it('EXCLUDES dresses with no operating days rather than counting them as zero', () => {
    // Including them would drag the average down every time the boutique bought
    // a gown, which is precisely backwards.
    expect(averageUtilization([row(60), row(null), row(null)])).toBe(60);
  });

  it('reports N/A when nothing was measurable', () => {
    expect(averageUtilization([row(null), row(null)])).toBeNull();
  });

  it('reports N/A for an empty inventory', () => {
    expect(averageUtilization([])).toBeNull();
  });
});
