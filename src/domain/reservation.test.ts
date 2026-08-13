import { describe, it, expect } from 'vitest';
import {
  allowedTransitionsFrom,
  canEditBooking,
  dressStatusAfterRelease,
  dressStatusForTransition,
  findDateProblems,
  isActive,
  refuseStatusChange,
} from './reservation';
import { RESERVATION_STATUSES, type ReservationStatus } from './availability';
import { addDays, fromMuscatWallTime } from './datetime';
import type { DressStatus } from './dress';

const at = (wall: string) => fromMuscatWallTime(wall);
const NOW = at('2026-09-01T09:00');

describe('the reservation status set', () => {
  it('is exactly the nine specified statuses, with no alternatives', () => {
    expect(RESERVATION_STATUSES).toEqual([
      'Inquiry',
      'Reserved',
      'Fitting Scheduled',
      'Fitted',
      'Picked Up',
      'Returned',
      'Closed',
      'Cancelled',
      'No-Show',
    ]);
  });
});

describe('refuseStatusChange()', () => {
  it('allows the specification’s forward path', () => {
    const path: [ReservationStatus, ReservationStatus][] = [
      ['Inquiry', 'Reserved'],
      ['Reserved', 'Fitting Scheduled'],
      ['Fitting Scheduled', 'Fitted'],
      ['Fitted', 'Picked Up'],
      ['Picked Up', 'Returned'],
      ['Returned', 'Closed'],
    ];

    for (const [from, to] of path) {
      expect(refuseStatusChange(from, to), `${from} → ${to}`).toBeNull();
    }
  });

  it('allows collection without a fitting — not every rental has one', () => {
    // Forcing a fictional fitting through the system would put a lie in the record.
    expect(refuseStatusChange('Reserved', 'Picked Up')).toBeNull();
    expect(refuseStatusChange('Fitting Scheduled', 'Picked Up')).toBeNull();
  });

  it('allows a second fitting to be scheduled after one is completed', () => {
    expect(refuseStatusChange('Fitted', 'Fitting Scheduled')).toBeNull();
  });

  it('allows cancellation from every pre-collection state', () => {
    for (const from of ['Inquiry', 'Reserved', 'Fitting Scheduled', 'Fitted'] as ReservationStatus[]) {
      expect(refuseStatusChange(from, 'Cancelled'), from).toBeNull();
    }
  });

  it('allows no-show only where the customer was expected', () => {
    for (const from of ['Reserved', 'Fitting Scheduled', 'Fitted'] as ReservationStatus[]) {
      expect(refuseStatusChange(from, 'No-Show'), from).toBeNull();
    }
    // You cannot fail to collect a gown you already hold.
    expect(refuseStatusChange('Picked Up', 'No-Show')).toBe('PICKED_UP_IS_IRREVERSIBLE');
    expect(refuseStatusChange('Inquiry', 'No-Show')).toBe('NOT_PERMITTED');
  });

  it('refuses arbitrary jumps', () => {
    expect(refuseStatusChange('Inquiry', 'Picked Up')).toBe('NOT_PERMITTED');
    expect(refuseStatusChange('Inquiry', 'Returned')).toBe('NOT_PERMITTED');
    expect(refuseStatusChange('Reserved', 'Closed')).toBe('NOT_PERMITTED');
    expect(refuseStatusChange('Reserved', 'Returned')).toBe('NOT_PERMITTED');
  });

  it('refuses cancelling a collected reservation', () => {
    // It would mark the dress available while a customer still has it.
    expect(refuseStatusChange('Picked Up', 'Cancelled')).toBe('PICKED_UP_IS_IRREVERSIBLE');
  });

  it('refuses moving backwards', () => {
    expect(refuseStatusChange('Returned', 'Picked Up')).toBe('NOT_PERMITTED');
    expect(refuseStatusChange('Reserved', 'Inquiry')).toBe('NOT_PERMITTED');
  });

  it('treats Closed, Cancelled and No-Show as terminal', () => {
    for (const from of ['Closed', 'Cancelled', 'No-Show'] as ReservationStatus[]) {
      for (const to of RESERVATION_STATUSES) {
        if (from === to) continue;
        expect(refuseStatusChange(from, to), `${from} → ${to}`).toBe('TERMINAL');
      }
    }
  });

  it('reports a no-op rather than silently accepting it', () => {
    for (const status of RESERVATION_STATUSES) {
      expect(refuseStatusChange(status, status)).toBe('SAME_STATUS');
    }
  });

  it('gives a defined answer for every pair', () => {
    for (const from of RESERVATION_STATUSES) {
      for (const to of RESERVATION_STATUSES) {
        const verdict = refuseStatusChange(from, to);
        expect(verdict === null || typeof verdict === 'string').toBe(true);
      }
    }
  });

  it('lists transitions consistently with the refusal function', () => {
    for (const from of RESERVATION_STATUSES) {
      for (const to of allowedTransitionsFrom(from)) {
        expect(refuseStatusChange(from, to), `${from} → ${to}`).toBeNull();
      }
    }
  });
});

describe('isActive() and canEditBooking()', () => {
  it('treats work-in-progress reservations as active', () => {
    for (const status of [
      'Inquiry',
      'Reserved',
      'Fitting Scheduled',
      'Fitted',
      'Picked Up',
      'Returned',
    ] as ReservationStatus[]) {
      expect(isActive(status), status).toBe(true);
    }
  });

  it('treats closed, cancelled and no-show as inactive', () => {
    expect(isActive('Closed')).toBe(false);
    expect(isActive('Cancelled')).toBe(false);
    expect(isActive('No-Show')).toBe(false);
  });

  it('allows editing dates only before the dress leaves', () => {
    expect(canEditBooking('Reserved')).toBe(true);
    expect(canEditBooking('Fitted')).toBe(true);
    // Once collected, the dates are a record of what happened.
    expect(canEditBooking('Picked Up')).toBe(false);
    expect(canEditBooking('Returned')).toBe(false);
    expect(canEditBooking('Cancelled')).toBe(false);
  });
});

describe('findDateProblems()', () => {
  const valid = {
    pickupAt: at('2026-09-10T10:00'),
    returnAt: at('2026-09-12T10:00'),
    eventAt: at('2026-09-11T18:00'),
  };

  it('accepts a well-formed booking', () => {
    expect(findDateProblems(valid, { now: NOW })).toEqual([]);
  });

  it('rejects a pickup in the past', () => {
    expect(
      findDateProblems({ ...valid, pickupAt: at('2026-08-01T10:00') }, { now: NOW }),
    ).toContain('PICKUP_IN_PAST');
  });

  it('allows a past pickup when back-filling or editing a collected reservation', () => {
    expect(
      findDateProblems(
        { ...valid, pickupAt: at('2026-08-01T10:00'), eventAt: at('2026-08-02T10:00'), returnAt: at('2026-08-05T10:00') },
        { now: NOW, allowPastPickup: true },
      ),
    ).toEqual([]);
  });

  it('rejects a return before pickup', () => {
    expect(
      findDateProblems({ ...valid, returnAt: at('2026-09-09T10:00'), eventAt: null }, { now: NOW }),
    ).toContain('RETURN_BEFORE_PICKUP');
  });

  it('rejects a return at exactly the pickup instant', () => {
    expect(
      findDateProblems({ ...valid, returnAt: valid.pickupAt, eventAt: null }, { now: NOW }),
    ).toContain('RETURN_EQUALS_PICKUP');
  });

  it('rejects an event before pickup — almost always transposed fields', () => {
    expect(
      findDateProblems({ ...valid, eventAt: at('2026-09-09T18:00') }, { now: NOW }),
    ).toContain('EVENT_BEFORE_PICKUP');
  });

  it('allows an event before pickup when explicitly permitted', () => {
    expect(
      findDateProblems(
        { ...valid, eventAt: at('2026-09-09T18:00') },
        { now: NOW, allowEventBeforePickup: true },
      ),
    ).toEqual([]);
  });

  it('accepts a null event date', () => {
    expect(findDateProblems({ ...valid, eventAt: null }, { now: NOW })).toEqual([]);
  });

  it('rejects an absurd rental length', () => {
    expect(
      findDateProblems(
        { ...valid, returnAt: addDays(valid.pickupAt, 400), eventAt: null },
        { now: NOW },
      ),
    ).toContain('RENTAL_TOO_LONG');
  });

  it('rejects a pickup absurdly far ahead', () => {
    const pickupAt = addDays(NOW, 800);
    expect(
      findDateProblems(
        { pickupAt, returnAt: addDays(pickupAt, 2), eventAt: null },
        { now: NOW },
      ),
    ).toContain('PICKUP_TOO_FAR_AHEAD');
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const problems = findDateProblems(
      {
        pickupAt: at('2026-08-01T10:00'),
        returnAt: at('2026-07-01T10:00'),
        eventAt: at('2026-06-01T10:00'),
      },
      { now: NOW },
    );

    expect(problems).toContain('PICKUP_IN_PAST');
    expect(problems).toContain('RETURN_BEFORE_PICKUP');
    expect(problems).toContain('EVENT_BEFORE_PICKUP');
  });

  it('accepts a pickup at exactly the current instant', () => {
    expect(
      findDateProblems(
        { pickupAt: NOW, returnAt: addDays(NOW, 2), eventAt: null },
        { now: NOW },
      ),
    ).toEqual([]);
  });
});

describe('dressStatusForTransition()', () => {
  it('reserves an available dress', () => {
    expect(dressStatusForTransition('Available', 'Reserved')).toBe('Reserved');
  });

  it('does not change a dress that already carries a booking', () => {
    // A dress may hold several future reservations; its status describes where
    // the garment is now, not that a booking exists somewhere in the diary.
    expect(dressStatusForTransition('Reserved', 'Reserved')).toBeNull();
    expect(dressStatusForTransition('Out with Customer', 'Reserved')).toBeNull();
    expect(dressStatusForTransition('In Cleaning', 'Reserved')).toBeNull();
  });

  it('sends a collected dress out with the customer', () => {
    expect(dressStatusForTransition('Reserved', 'Picked Up')).toBe('Out with Customer');
  });

  it('sends a returned dress to cleaning, never straight to available', () => {
    expect(dressStatusForTransition('Out with Customer', 'Returned')).toBe('In Cleaning');
  });

  it('never overwrites an operational status', () => {
    for (const current of ['Retired', 'Under Repair', 'In Alteration'] as DressStatus[]) {
      for (const to of ['Reserved', 'Picked Up', 'Returned'] as ReservationStatus[]) {
        expect(dressStatusForTransition(current, to), `${current} / ${to}`).toBeNull();
      }
    }
  });

  it('leaves the dress alone for transitions that do not move the garment', () => {
    expect(dressStatusForTransition('Reserved', 'Fitting Scheduled')).toBeNull();
    expect(dressStatusForTransition('Reserved', 'Fitted')).toBeNull();
    expect(dressStatusForTransition('In Cleaning', 'Closed')).toBeNull();
  });
});

describe('dressStatusAfterRelease()', () => {
  it('frees a reserved dress when nothing else holds it', () => {
    expect(dressStatusAfterRelease('Reserved', false)).toBe('Available');
  });

  it('keeps a dress reserved when another booking still holds it', () => {
    expect(dressStatusAfterRelease('Reserved', true)).toBeNull();
  });

  it('never frees a dress that is physically elsewhere', () => {
    // Cancelling some other booking does not bring a gown back from a customer.
    expect(dressStatusAfterRelease('Out with Customer', false)).toBeNull();
    expect(dressStatusAfterRelease('In Cleaning', false)).toBeNull();
  });

  it('never frees an operationally blocked dress', () => {
    for (const current of ['Retired', 'Under Repair', 'In Alteration'] as DressStatus[]) {
      expect(dressStatusAfterRelease(current, false)).toBeNull();
    }
  });
});
