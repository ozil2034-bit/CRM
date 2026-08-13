import { describe, expect, it } from 'vitest';

import {
  allocateByWeight,
  ancillaryRevenue,
  cancellationCounts,
  revenueByDress,
  topRented,
  type RentedLine,
  type ReportedReservation,
} from './operational-reporting';
import { baisa } from './money';
import { startOfMuscatDay } from './datetime';
import type { Period } from './financial-reporting';

const SEPTEMBER: Period = {
  from: startOfMuscatDay('2026-09-01'),
  to: startOfMuscatDay('2026-10-01'),
};

const IN = startOfMuscatDay('2026-09-10');
const OUT = startOfMuscatDay('2026-11-10');

function reservation(overrides: Partial<ReportedReservation> = {}): ReportedReservation {
  return {
    id: 'r-1',
    code: 'RSV-0001',
    status: 'Closed',
    pickupAt: IN,
    netCollected: baisa(0),
    accessorySubtotal: baisa(0),
    alterationSubtotal: baisa(0),
    ...overrides,
  };
}

function line(overrides: Partial<RentedLine> = {}): RentedLine {
  return {
    reservationId: 'r-1',
    dressId: 'd-1',
    dressCode: 'WD-0001',
    dressName: 'Aurora',
    rentalPriceSnapshot: baisa(300_000),
    pickupAt: IN,
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ *
 * Allocation
 * ------------------------------------------------------------------------ */

describe('splitting an amount by weight', () => {
  it('LOSES NOTHING — the parts always sum to the whole', () => {
    /*
     * Load-bearing. A report whose rows do not add up to its own total destroys
     * confidence in every other figure on the page.
     */
    const parts = allocateByWeight(baisa(100_000), [1, 1, 1]);

    expect(parts.reduce((total, part) => total + part, 0)).toBe(100_000);
  });

  it('splits in proportion, not equally', () => {
    expect(allocateByWeight(baisa(100_000), [3, 1])).toEqual([75_000, 25_000]);
  });

  it('gives the odd baisa to the largest remainder, deterministically', () => {
    const parts = allocateByWeight(baisa(10), [1, 1, 1]);

    expect(parts.reduce((total, part) => total + part, 0)).toBe(10);
    expect(parts).toEqual([4, 3, 3]);
  });

  it('spreads evenly when every line is free of charge', () => {
    // The money did come from somewhere; dropping it would lose it.
    const parts = allocateByWeight(baisa(90), [0, 0, 0]);

    expect(parts).toEqual([30, 30, 30]);
  });

  it('returns zeros for a zero amount', () => {
    expect(allocateByWeight(baisa(0), [5, 5])).toEqual([0, 0]);
  });

  it('returns nothing for no weights', () => {
    expect(allocateByWeight(baisa(100), [])).toEqual([]);
  });

  it('ignores a negative weight rather than inverting a share', () => {
    const parts = allocateByWeight(baisa(100), [-5, 5]);

    expect(parts).toEqual([0, 100]);
  });
});

/* ------------------------------------------------------------------------ *
 * Revenue by dress
 * ------------------------------------------------------------------------ */

describe('revenue by dress', () => {
  it('attributes a single-gown booking entirely to that gown', () => {
    const rows = revenueByDress({
      reservations: [reservation({ netCollected: baisa(300_000) })],
      lines: [line()],
      period: SEPTEMBER,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.revenue).toBe(300_000);
    expect(rows[0]!.rentals).toBe(1);
  });

  it('splits a two-gown booking by their AGREED prices, not equally', () => {
    const rows = revenueByDress({
      reservations: [reservation({ netCollected: baisa(400_000) })],
      lines: [
        line({ dressId: 'd-1', rentalPriceSnapshot: baisa(300_000) }),
        line({ dressId: 'd-2', dressCode: 'WD-0002', rentalPriceSnapshot: baisa(100_000) }),
      ],
      period: SEPTEMBER,
    });

    const byId = new Map(rows.map((row) => [row.dressId, row.revenue]));

    expect(byId.get('d-1')).toBe(300_000);
    expect(byId.get('d-2')).toBe(100_000);
  });

  it('never invents revenue for a booking with no lines', () => {
    const rows = revenueByDress({
      reservations: [reservation({ netCollected: baisa(500_000) })],
      lines: [],
      period: SEPTEMBER,
    });

    expect(rows).toEqual([]);
  });

  it('counts a rental only when its pickup falls inside the period', () => {
    const rows = revenueByDress({
      reservations: [
        reservation({ id: 'r-1', netCollected: baisa(100_000) }),
        reservation({ id: 'r-2', pickupAt: OUT, netCollected: baisa(100_000) }),
      ],
      lines: [
        line({ reservationId: 'r-1' }),
        line({ reservationId: 'r-2', pickupAt: OUT }),
      ],
      period: SEPTEMBER,
    });

    expect(rows[0]!.rentals).toBe(1);
  });

  it('accumulates several bookings of one gown', () => {
    const rows = revenueByDress({
      reservations: [
        reservation({ id: 'r-1', netCollected: baisa(100_000) }),
        reservation({ id: 'r-2', netCollected: baisa(150_000) }),
      ],
      lines: [line({ reservationId: 'r-1' }), line({ reservationId: 'r-2' })],
      period: SEPTEMBER,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.revenue).toBe(250_000);
    expect(rows[0]!.rentals).toBe(2);
  });

  it('sorts by revenue, highest first', () => {
    const rows = revenueByDress({
      reservations: [
        reservation({ id: 'r-1', netCollected: baisa(50_000) }),
        reservation({ id: 'r-2', netCollected: baisa(500_000) }),
      ],
      lines: [
        line({ reservationId: 'r-1', dressId: 'd-1', dressCode: 'WD-0001' }),
        line({ reservationId: 'r-2', dressId: 'd-2', dressCode: 'WD-0002' }),
      ],
      period: SEPTEMBER,
    });

    expect(rows.map((row) => row.dressId)).toEqual(['d-2', 'd-1']);
  });

  it('reports an empty inventory as no rows, not as zeroes', () => {
    expect(revenueByDress({ reservations: [], lines: [], period: SEPTEMBER })).toEqual([]);
  });
});

describe('most rented', () => {
  const rows = [
    { dressId: 'd-1', dressCode: 'WD-0001', dressName: 'A', rentals: 1, revenue: baisa(900_000) },
    { dressId: 'd-2', dressCode: 'WD-0002', dressName: 'B', rentals: 5, revenue: baisa(100_000) },
    { dressId: 'd-3', dressCode: 'WD-0003', dressName: 'C', rentals: 0, revenue: baisa(0) },
  ];

  it('ranks by COUNT, not by revenue — they are different questions', () => {
    expect(topRented(rows).map((row) => row.dressId)).toEqual(['d-2', 'd-1']);
  });

  it('omits gowns that were never rented in the period', () => {
    expect(topRented(rows).some((row) => row.dressId === 'd-3')).toBe(false);
  });

  it('honours the limit', () => {
    expect(topRented(rows, 1)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------ *
 * Cancellations
 * ------------------------------------------------------------------------ */

describe('cancellations and no-shows', () => {
  it('counts each kind separately', () => {
    const counts = cancellationCounts(
      [
        reservation({ id: 'a', status: 'Cancelled' }),
        reservation({ id: 'b', status: 'No-Show' }),
        reservation({ id: 'c', status: 'Closed' }),
        reservation({ id: 'd', status: 'Returned' }),
      ],
      SEPTEMBER,
    );

    expect(counts).toMatchObject({ cancelled: 1, noShow: 1, completed: 2 });
  });

  it('computes the rate over bookings that actually concluded', () => {
    const counts = cancellationCounts(
      [
        reservation({ id: 'a', status: 'Cancelled' }),
        reservation({ id: 'b', status: 'Closed' }),
        reservation({ id: 'c', status: 'Closed' }),
        reservation({ id: 'd', status: 'Closed' }),
      ],
      SEPTEMBER,
    );

    expect(counts.ratePercent).toBe(25);
  });

  it('EXCLUDES bookings still in progress from the rate', () => {
    // A live booking has not failed; counting it as a success is equally wrong.
    const counts = cancellationCounts(
      [
        reservation({ id: 'a', status: 'Cancelled' }),
        reservation({ id: 'b', status: 'Picked Up' }),
      ],
      SEPTEMBER,
    );

    expect(counts.ratePercent).toBe(100);
  });

  it('reports N/A rather than 0% when nothing concluded', () => {
    const counts = cancellationCounts([reservation({ status: 'Reserved' })], SEPTEMBER);

    expect(counts.ratePercent).toBeNull();
  });

  it('reports N/A for an empty period', () => {
    expect(cancellationCounts([], SEPTEMBER).ratePercent).toBeNull();
  });

  it('ignores bookings outside the period', () => {
    const counts = cancellationCounts(
      [reservation({ status: 'Cancelled', pickupAt: OUT })],
      SEPTEMBER,
    );

    expect(counts.cancelled).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Accessories and alterations
 * ------------------------------------------------------------------------ */

describe('accessory and alteration revenue', () => {
  it('totals what was agreed on the period’s bookings', () => {
    const result = ancillaryRevenue(
      [
        reservation({ accessorySubtotal: baisa(20_000), alterationSubtotal: baisa(15_000) }),
        reservation({ id: 'r-2', accessorySubtotal: baisa(5_000) }),
      ],
      SEPTEMBER,
    );

    expect(result).toMatchObject({
      accessories: 25_000,
      alterations: 15_000,
      total: 40_000,
      bookings: 2,
    });
  });

  it('EXCLUDES cancelled and no-show bookings — nothing was supplied', () => {
    const result = ancillaryRevenue(
      [
        reservation({ status: 'Cancelled', accessorySubtotal: baisa(20_000) }),
        reservation({ id: 'r-2', status: 'No-Show', alterationSubtotal: baisa(9_000) }),
      ],
      SEPTEMBER,
    );

    expect(result.total).toBe(0);
    expect(result.bookings).toBe(0);
  });

  it('ignores bookings outside the period', () => {
    const result = ancillaryRevenue(
      [reservation({ pickupAt: OUT, accessorySubtotal: baisa(20_000) })],
      SEPTEMBER,
    );

    expect(result.total).toBe(0);
  });

  it('reports zero for a period with no ancillary sales at all', () => {
    // Genuinely zero here: bookings existed and none carried an accessory.
    const result = ancillaryRevenue([reservation()], SEPTEMBER);

    expect(result.total).toBe(0);
    expect(result.bookings).toBe(0);
  });
});
