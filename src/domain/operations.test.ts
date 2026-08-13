import { describe, expect, it } from 'vitest';

import { fromMuscatWallTime } from './datetime';
import { baisa } from './money';
import { RESERVATION_STATUSES, type ReservationStatus } from './availability';
import {
  actionsFor,
  alertsFor,
  dayOperations,
  daysOverdue,
  primaryActionFor,
  readyToCollect,
  upcomingPickups,
  type OperationalFitting,
  type OperationalReservation,
} from './operations';

const at = (wall: string) => fromMuscatWallTime(wall);

/** Mid-morning on 12 September. */
const NOW = at('2026-09-12T10:00');

let sequence = 0;

function reservation(overrides: Partial<OperationalReservation> = {}): OperationalReservation {
  sequence += 1;
  return {
    id: `r-${sequence}`,
    code: `RSV-${String(sequence).padStart(4, '0')}`,
    customerId: 'c-1',
    customerName: 'Bride One',
    customerNameAr: 'العروس',
    customerPhone: '91000001',
    status: 'Reserved',
    pickupAt: at('2026-09-12T11:00'),
    returnAt: at('2026-09-14T18:00'),
    eventDate: '2026-09-13',
    outstanding: baisa(0),
    depositHeld: baisa(100_000),
    depositDue: baisa(100_000),
    ...overrides,
  };
}

function fitting(overrides: Partial<OperationalFitting> = {}): OperationalFitting {
  sequence += 1;
  return {
    id: `f-${sequence}`,
    reservationId: 'r-1',
    reservationCode: 'RSV-0001',
    customerName: 'Bride One',
    scheduledAt: at('2026-09-12T15:00'),
    status: 'Scheduled',
    ...overrides,
  };
}

const day = (input: {
  reservations?: OperationalReservation[];
  fittings?: OperationalFitting[];
  now?: number;
  threshold?: number;
}) =>
  dayOperations({
    reservations: input.reservations ?? [],
    fittings: input.fittings ?? [],
    now: input.now ?? NOW,
    minPickupPaymentPercent: input.threshold ?? 100,
  });

/* ------------------------------------------------------------------------ *
 * Contextual actions (§7)
 * ------------------------------------------------------------------------ */

describe('what an employee can do next', () => {
  const expected: Record<ReservationStatus, string[]> = {
    Inquiry: ['review'],
    Reserved: ['scheduleFitting', 'collectPayment', 'notifyCustomer'],
    'Fitting Scheduled': ['confirmFitting', 'viewReservation'],
    Fitted: ['preparePickup', 'collectPayment'],
    'Picked Up': ['processReturn'],
    Returned: ['settleDeposit', 'closeReservation'],
    Closed: ['viewHistory'],
    Cancelled: ['viewCancellation'],
    'No-Show': ['review'],
  };

  for (const status of RESERVATION_STATUSES) {
    it(`offers exactly the right actions for ${status}`, () => {
      expect([...actionsFor(status)]).toEqual(expected[status]);
    });
  }

  it('covers every status — no booking is ever left with nothing to do', () => {
    for (const status of RESERVATION_STATUSES) {
      expect(actionsFor(status).length).toBeGreaterThan(0);
    }
  });

  it('promotes the action an employee reaches for most', () => {
    expect(primaryActionFor('Reserved')).toBe('scheduleFitting');
    expect(primaryActionFor('Picked Up')).toBe('processReturn');
    expect(primaryActionFor('Returned')).toBe('settleDeposit');
  });

  it('does NOT offer collection actions on a finished booking', () => {
    for (const status of ['Closed', 'Cancelled', 'No-Show'] as ReservationStatus[]) {
      expect(actionsFor(status)).not.toContain('collectPayment');
      expect(actionsFor(status)).not.toContain('processReturn');
    }
  });

  it('does NOT offer a return before the gown has left the shop', () => {
    for (const status of ['Reserved', 'Fitting Scheduled', 'Fitted'] as ReservationStatus[]) {
      expect(actionsFor(status)).not.toContain('processReturn');
    }
  });
});

/* ------------------------------------------------------------------------ *
 * The day's work (§6)
 * ------------------------------------------------------------------------ */

describe("today's operations", () => {
  it('is empty, and says so, with no data at all', () => {
    const result = day({});

    expect(result.isEmpty).toBe(true);
    expect(result.pickups).toEqual([]);
    expect(result.returns).toEqual([]);
    expect(result.fittings).toEqual([]);
    expect(result.overdue).toEqual([]);
  });

  it('lists collections due today', () => {
    const result = day({ reservations: [reservation()] });

    expect(result.pickups).toHaveLength(1);
    expect(result.isEmpty).toBe(false);
  });

  it('ignores collections on another day', () => {
    const result = day({
      reservations: [reservation({ pickupAt: at('2026-09-14T11:00') })],
    });

    expect(result.pickups).toHaveLength(0);
  });

  it('treats late evening as still today in Muscat', () => {
    // 23:00 Muscat is 19:00 UTC — a UTC-based day boundary would say tomorrow.
    const result = day({
      reservations: [reservation({ pickupAt: at('2026-09-12T23:00') })],
      now: at('2026-09-12T09:00'),
    });

    expect(result.pickups).toHaveLength(1);
  });

  it('orders collections by time', () => {
    const result = day({
      reservations: [
        reservation({ pickupAt: at('2026-09-12T16:00') }),
        reservation({ pickupAt: at('2026-09-12T09:00') }),
        reservation({ pickupAt: at('2026-09-12T12:00') }),
      ],
    });

    expect(result.pickups.map((entry) => entry.pickupAt)).toEqual([
      at('2026-09-12T09:00'),
      at('2026-09-12T12:00'),
      at('2026-09-12T16:00'),
    ]);
  });

  it('does not list a collection for a gown already picked up', () => {
    const result = day({ reservations: [reservation({ status: 'Picked Up' })] });

    expect(result.pickups).toHaveLength(0);
  });

  it('lists returns due today, but only for gowns actually out', () => {
    const out = reservation({ status: 'Picked Up', returnAt: at('2026-09-12T18:00') });
    const notOut = reservation({ status: 'Reserved', returnAt: at('2026-09-12T18:00') });

    const result = day({ reservations: [out, notOut] });

    expect(result.returns).toHaveLength(1);
    expect(result.returns[0]!.id).toBe(out.id);
  });

  it("lists today's fittings in time order", () => {
    const result = day({
      fittings: [
        fitting({ scheduledAt: at('2026-09-12T16:00') }),
        fitting({ scheduledAt: at('2026-09-12T10:00') }),
        fitting({ scheduledAt: at('2026-09-13T10:00') }),
      ],
    });

    expect(result.fittings).toHaveLength(2);
    expect(result.fittings[0]!.scheduledAt).toBe(at('2026-09-12T10:00'));
  });
});

/* ------------------------------------------------------------------------ *
 * Overdue
 * ------------------------------------------------------------------------ */

describe('overdue returns', () => {
  it('flags a gown that should have come back yesterday', () => {
    const result = day({
      reservations: [reservation({ status: 'Picked Up', returnAt: at('2026-09-11T18:00') })],
    });

    expect(result.overdue).toHaveLength(1);
  });

  it('does NOT flag a gown due later the same day', () => {
    // Measured from the start of today, so 18:00 is not overdue at 10:00.
    const result = day({
      reservations: [reservation({ status: 'Picked Up', returnAt: at('2026-09-12T18:00') })],
    });

    expect(result.overdue).toHaveLength(0);
  });

  it('does not flag a gown that is already back', () => {
    const result = day({
      reservations: [reservation({ status: 'Returned', returnAt: at('2026-09-01T18:00') })],
    });

    expect(result.overdue).toHaveLength(0);
  });

  it('orders the worst offenders first', () => {
    const result = day({
      reservations: [
        reservation({ status: 'Picked Up', returnAt: at('2026-09-10T18:00') }),
        reservation({ status: 'Picked Up', returnAt: at('2026-09-01T18:00') }),
      ],
    });

    expect(result.overdue[0]!.returnAt).toBe(at('2026-09-01T18:00'));
  });

  it('counts whole days late from the day it was due', () => {
    const late = reservation({ status: 'Picked Up', returnAt: at('2026-09-09T18:00') });

    expect(daysOverdue(late, NOW)).toBe(3);
  });

  it('reports zero, never negative, for a gown not yet due', () => {
    const future = reservation({ status: 'Picked Up', returnAt: at('2026-09-20T18:00') });

    expect(daysOverdue(future, NOW)).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Readiness to collect
 * ------------------------------------------------------------------------ */

describe('readiness to collect', () => {
  it('allows a fully paid booking with the deposit held', () => {
    expect(readyToCollect(reservation(), 100)).toBe(true);
  });

  it('REFUSES when the deposit is not fully held', () => {
    expect(readyToCollect(reservation({ depositHeld: baisa(50_000) }), 100)).toBe(false);
  });

  it('REFUSES when the rental is not fully paid at a 100% threshold', () => {
    expect(readyToCollect(reservation({ outstanding: baisa(1) }), 100)).toBe(false);
  });

  it('still REFUSES on an unheld deposit below a 100% threshold', () => {
    // The deposit is the boutique's only protection; the threshold never waives it.
    expect(readyToCollect(reservation({ depositHeld: baisa(0) }), 50)).toBe(false);
  });

  it("flags today's collections that are not ready", () => {
    const ready = reservation();
    const notReady = reservation({ outstanding: baisa(50_000) });

    const result = day({ reservations: [ready, notReady] });

    expect(result.unpaidPickups).toHaveLength(1);
    expect(result.unpaidPickups[0]!.id).toBe(notReady.id);
  });
});

/* ------------------------------------------------------------------------ *
 * Alerts
 * ------------------------------------------------------------------------ */

describe('alerts', () => {
  const alerts = (reservations: OperationalReservation[], now = NOW) =>
    alertsFor({ reservations, now, minPickupPaymentPercent: 100 });

  it('is empty when nothing needs attention', () => {
    expect(alerts([reservation({ eventDate: '2026-12-01' })])).toEqual([]);
  });

  it('raises an overdue return', () => {
    const result = alerts([
      reservation({ status: 'Picked Up', returnAt: at('2026-09-05T18:00'), eventDate: '' }),
    ]);

    expect(result.map((entry) => entry.kind)).toContain('overdueReturn');
  });

  it('raises an unheld deposit ahead of an unpaid balance', () => {
    const noDeposit = alerts([reservation({ depositHeld: baisa(0), eventDate: '' })]);
    expect(noDeposit[0]!.kind).toBe('depositNotHeld');

    const unpaid = alerts([reservation({ outstanding: baisa(50_000), eventDate: '' })]);
    expect(unpaid[0]!.kind).toBe('unpaidPickupToday');
  });

  it('raises an event happening tomorrow', () => {
    const result = alerts([reservation({ eventDate: '2026-09-13', pickupAt: at('2026-09-20T10:00') })]);

    expect(result.map((entry) => entry.kind)).toContain('eventTomorrow');
  });

  it('sorts the most urgent first', () => {
    const result = alerts([
      reservation({ eventDate: '2026-09-13', pickupAt: at('2026-09-20T10:00') }),
      reservation({ status: 'Picked Up', returnAt: at('2026-09-01T18:00'), eventDate: '' }),
    ]);

    // An overdue gown outranks an event that has not happened yet.
    expect(result[0]!.kind).toBe('overdueReturn');
  });

  it('ranks a longer overdue above a shorter one', () => {
    const result = alerts([
      reservation({ status: 'Picked Up', returnAt: at('2026-09-11T18:00'), eventDate: '' }),
      reservation({ status: 'Picked Up', returnAt: at('2026-09-01T18:00'), eventDate: '' }),
    ]);

    expect(result[0]!.severity).toBeGreaterThan(result[1]!.severity);
  });
});

/* ------------------------------------------------------------------------ *
 * Upcoming
 * ------------------------------------------------------------------------ */

describe('upcoming collections', () => {
  it('includes today and the days ahead', () => {
    const result = upcomingPickups({
      reservations: [
        reservation({ pickupAt: at('2026-09-12T11:00') }),
        reservation({ pickupAt: at('2026-09-14T11:00') }),
      ],
      now: NOW,
      days: 7,
    });

    expect(result).toHaveLength(2);
  });

  it('excludes anything past the horizon', () => {
    const result = upcomingPickups({
      reservations: [reservation({ pickupAt: at('2026-09-30T11:00') })],
      now: NOW,
      days: 7,
    });

    expect(result).toHaveLength(0);
  });

  it('excludes collections that already happened', () => {
    const result = upcomingPickups({
      reservations: [reservation({ pickupAt: at('2026-09-01T11:00') })],
      now: NOW,
      days: 7,
    });

    expect(result).toHaveLength(0);
  });

  it('caps the list — a dashboard is not a report', () => {
    const many = Array.from({ length: 40 }, () =>
      reservation({ pickupAt: at('2026-09-13T11:00') }),
    );

    expect(upcomingPickups({ reservations: many, now: NOW, days: 7 })).toHaveLength(10);
    expect(upcomingPickups({ reservations: many, now: NOW, days: 7, limit: 3 })).toHaveLength(3);
  });

  it('orders by when the customer is coming', () => {
    const result = upcomingPickups({
      reservations: [
        reservation({ pickupAt: at('2026-09-15T11:00') }),
        reservation({ pickupAt: at('2026-09-13T11:00') }),
      ],
      now: NOW,
      days: 7,
    });

    expect(result[0]!.pickupAt).toBe(at('2026-09-13T11:00'));
  });
});
