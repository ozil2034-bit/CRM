import { describe, it, expect } from 'vitest';
import {
  BLOCKING_STATUSES,
  DEFAULT_CLEANING_BUFFER_DAYS,
  blockedInterval,
  findConflict,
  findConflicts,
  isDressOperationallyBlocked,
  nextAvailableFrom,
  overlaps,
  statusBlocks,
  type AvailabilityRequest,
  type ExistingBlock,
  type ReservationStatus,
} from './availability';
import { addDays, fromMuscatWallTime, MS_PER_DAY } from './datetime';
import type { DressStatus } from './dress';

const at = (wall: string) => fromMuscatWallTime(wall);

/** Existing booking: 10 Sep 10:00 → 12 Sep 10:00, buffer 3 days. */
function existingBlock(overrides: Partial<ExistingBlock> = {}): ExistingBlock {
  const pickupAt = at('2026-09-10T10:00');
  const returnAt = at('2026-09-12T10:00');

  return {
    itemId: 'item-1',
    reservationId: 'rsv-1',
    reservationCode: 'RSV-0012',
    dressId: 'dress-1',
    pickupAt,
    returnAt,
    blockStartAt: pickupAt,
    blockEndAt: addDays(returnAt, DEFAULT_CLEANING_BUFFER_DAYS),
    blocking: true,
    ...overrides,
  };
}

function request(overrides: Partial<AvailabilityRequest> = {}): AvailabilityRequest {
  return {
    dressId: 'dress-1',
    dressCode: 'WD-0001',
    dressName: 'Aurora',
    dressStatus: 'Available' as DressStatus,
    pickupAt: at('2026-09-10T10:00'),
    returnAt: at('2026-09-12T10:00'),
    cleaningBufferDays: DEFAULT_CLEANING_BUFFER_DAYS,
    ...overrides,
  };
}

describe('the cleaning buffer default', () => {
  it('is three days', () => {
    expect(DEFAULT_CLEANING_BUFFER_DAYS).toBe(3);
  });
});

describe('blockedInterval()', () => {
  it('runs from pickup to return plus the buffer', () => {
    const interval = blockedInterval(at('2026-09-10T11:00'), at('2026-09-12T11:00'), 3);

    expect(interval.start).toBe(at('2026-09-10T11:00'));
    expect(interval.end).toBe(at('2026-09-15T11:00'));
  });

  it('ends at the return instant when the buffer is zero', () => {
    const interval = blockedInterval(at('2026-09-10T11:00'), at('2026-09-12T11:00'), 0);
    expect(interval.end).toBe(at('2026-09-12T11:00'));
  });

  it('refuses a negative or fractional buffer', () => {
    expect(() => blockedInterval(at('2026-09-10T11:00'), at('2026-09-12T11:00'), -1)).toThrow();
    expect(() => blockedInterval(at('2026-09-10T11:00'), at('2026-09-12T11:00'), 1.5)).toThrow();
  });

  it('refuses a return before pickup', () => {
    expect(() => blockedInterval(at('2026-09-12T11:00'), at('2026-09-10T11:00'), 3)).toThrow();
  });
});

describe('overlaps()', () => {
  const day = (n: number) => n * MS_PER_DAY;

  it('detects overlap in both directions — the relation is symmetric', () => {
    const a = { start: day(10), end: day(15) };
    const b = { start: day(12), end: day(20) };

    expect(overlaps(a, b)).toBe(true);
    expect(overlaps(b, a)).toBe(true);
  });

  it('treats intervals as half-open, so touching ends do not overlap', () => {
    // This is what lets a dress free at 15 Sep 00:00 be collected at 15 Sep 00:00.
    const a = { start: day(10), end: day(15) };
    const b = { start: day(15), end: day(20) };

    expect(overlaps(a, b)).toBe(false);
    expect(overlaps(b, a)).toBe(false);
  });

  it('detects an overlap of a single millisecond', () => {
    const a = { start: day(10), end: day(15) };
    const b = { start: day(15) - 1, end: day(20) };
    expect(overlaps(a, b)).toBe(true);
  });

  it('reports no overlap for an empty or inverted interval', () => {
    expect(overlaps({ start: day(10), end: day(10) }, { start: day(5), end: day(20) })).toBe(false);
    expect(overlaps({ start: day(20), end: day(10) }, { start: day(5), end: day(30) })).toBe(false);
  });
});

/**
 * The overlap matrix the specification enumerates, case by case.
 *
 * Existing booking throughout: 10 Sep 10:00 → 12 Sep 10:00, buffer 3 days, so
 * the dress is blocked until 15 Sep 10:00.
 */
describe('overlap matrix', () => {
  const existing = [existingBlock()];

  it('1. rejects exactly the same dates', () => {
    expect(findConflict(request(), existing)?.reason).toBe('DATE_OVERLAP');
  });

  it('2. rejects the same pickup with a different return', () => {
    const conflict = findConflict(
      request({ pickupAt: at('2026-09-10T10:00'), returnAt: at('2026-09-20T10:00') }),
      existing,
    );
    expect(conflict?.reason).toBe('DATE_OVERLAP');
  });

  it('3. rejects the same return with a different pickup', () => {
    const conflict = findConflict(
      request({ pickupAt: at('2026-09-05T10:00'), returnAt: at('2026-09-12T10:00') }),
      existing,
    );
    expect(conflict?.reason).toBe('DATE_OVERLAP');
  });

  it('4. rejects a request starting during the existing booking', () => {
    const conflict = findConflict(
      request({ pickupAt: at('2026-09-11T10:00'), returnAt: at('2026-09-20T10:00') }),
      existing,
    );
    expect(conflict?.reason).toBe('DATE_OVERLAP');
  });

  it('5. rejects a request ending during the existing booking', () => {
    const conflict = findConflict(
      request({ pickupAt: at('2026-09-05T10:00'), returnAt: at('2026-09-11T10:00') }),
      existing,
    );
    expect(conflict?.reason).toBe('DATE_OVERLAP');
  });

  it('6. rejects a request that completely contains the existing booking', () => {
    const conflict = findConflict(
      request({ pickupAt: at('2026-09-01T10:00'), returnAt: at('2026-09-25T10:00') }),
      existing,
    );
    expect(conflict?.reason).toBe('DATE_OVERLAP');
  });

  it('7. rejects a request completely contained by the existing booking', () => {
    const conflict = findConflict(
      request({ pickupAt: at('2026-09-11T00:00'), returnAt: at('2026-09-11T20:00') }),
      existing,
    );
    expect(conflict?.reason).toBe('DATE_OVERLAP');
  });

  it('8. rejects an adjacent request that lands inside the cleaning buffer', () => {
    // Return is 12 Sep; the gown is in the wash until 15 Sep.
    const conflict = findConflict(
      request({ pickupAt: at('2026-09-12T10:00'), returnAt: at('2026-09-14T10:00') }),
      existing,
    );
    expect(conflict?.reason).toBe('CLEANING_BUFFER');
  });

  it('9. rejects a pickup inside the cleaning buffer and names it as such', () => {
    const conflict = findConflict(
      request({ pickupAt: at('2026-09-14T10:00'), returnAt: at('2026-09-18T10:00') }),
      existing,
    );

    expect(conflict?.reason).toBe('CLEANING_BUFFER');
    expect(conflict?.conflictingReservationCode).toBe('RSV-0012');
    expect(conflict?.availableFrom).toBe(at('2026-09-15T10:00'));
  });

  it('9b. ACCEPTS a pickup exactly when the cleaning buffer expires', () => {
    // Half-open intervals: the dress is free at 15 Sep 10:00 sharp.
    expect(
      findConflict(
        request({ pickupAt: at('2026-09-15T10:00'), returnAt: at('2026-09-18T10:00') }),
        existing,
      ),
    ).toBeNull();
  });

  it('9c. ACCEPTS a pickup after the cleaning buffer', () => {
    expect(
      findConflict(
        request({ pickupAt: at('2026-09-16T10:00'), returnAt: at('2026-09-18T10:00') }),
        existing,
      ),
    ).toBeNull();
  });

  it('9d. rejects a request one millisecond before the buffer expires', () => {
    const conflict = findConflict(
      request({
        pickupAt: at('2026-09-15T10:00') - 1,
        returnAt: at('2026-09-18T10:00'),
      }),
      existing,
    );
    expect(conflict).not.toBeNull();
  });

  it('10. reports every unavailable dress in a multi-dress request', () => {
    const blocks = [
      existingBlock({ dressId: 'dress-1', reservationCode: 'RSV-0001' }),
      existingBlock({ dressId: 'dress-3', itemId: 'item-3', reservationCode: 'RSV-0003' }),
    ];

    const conflicts = findConflicts(
      [
        request({ dressId: 'dress-1', dressCode: 'WD-0001' }),
        request({ dressId: 'dress-2', dressCode: 'WD-0002' }),
        request({ dressId: 'dress-3', dressCode: 'WD-0003' }),
      ],
      blocks,
    );

    // Two of three clash, and the employee is told about both at once.
    expect(conflicts).toHaveLength(2);
    expect(conflicts.map((conflict) => conflict.dressCode)).toEqual(['WD-0001', 'WD-0003']);
  });

  it('11. ACCEPTS dates held only by a cancelled reservation', () => {
    const cancelled = [existingBlock({ blocking: false })];
    expect(findConflict(request(), cancelled)).toBeNull();
  });

  it('12. ACCEPTS dates held only by a no-show reservation', () => {
    const noShow = [existingBlock({ blocking: false })];
    expect(findConflict(request(), noShow)).toBeNull();
  });

  it('13. rejects a request while a returned dress is still being cleaned', () => {
    // Returned still blocks: the gown is in the wash, not on the rail.
    const returned = [existingBlock({ blocking: true })];
    const conflict = findConflict(
      request({ pickupAt: at('2026-09-13T10:00'), returnAt: at('2026-09-14T10:00') }),
      returned,
    );
    expect(conflict?.reason).toBe('CLEANING_BUFFER');
  });

  it('14. ACCEPTS a request once the cleaning period has expired', () => {
    const closed = [existingBlock({ blocking: true })];
    expect(
      findConflict(
        request({ pickupAt: at('2026-09-20T10:00'), returnAt: at('2026-09-22T10:00') }),
        closed,
      ),
    ).toBeNull();
  });

  it('15. ACCEPTS a different dress on the same dates', () => {
    expect(findConflict(request({ dressId: 'dress-9' }), existing)).toBeNull();
  });

  it('16. rejects a dress Under Repair regardless of dates', () => {
    const conflict = findConflict(
      request({
        dressStatus: 'Under Repair',
        pickupAt: at('2027-01-01T10:00'),
        returnAt: at('2027-01-03T10:00'),
      }),
      [],
    );
    expect(conflict?.reason).toBe('DRESS_UNDER_REPAIR');
  });

  it('17. rejects a dress In Alteration regardless of dates', () => {
    const conflict = findConflict(request({ dressStatus: 'In Alteration' }), []);
    expect(conflict?.reason).toBe('DRESS_IN_ALTERATION');
  });

  it('18. rejects a Retired dress regardless of dates', () => {
    const conflict = findConflict(request({ dressStatus: 'Retired' }), []);
    expect(conflict?.reason).toBe('DRESS_RETIRED');
  });

  it('reports an operational block before looking at dates', () => {
    // "This gown is retired" is more useful than "it clashes with RSV-0012".
    const conflict = findConflict(request({ dressStatus: 'Retired' }), existing);
    expect(conflict?.reason).toBe('DRESS_RETIRED');
    expect(conflict?.conflictingReservationCode).toBeNull();
  });

  it('ACCEPTS a dress that is Out with Customer on dates after it returns', () => {
    // The physical status is not a date conflict; the interval decides.
    expect(
      findConflict(
        request({
          dressStatus: 'Out with Customer',
          pickupAt: at('2026-10-01T10:00'),
          returnAt: at('2026-10-03T10:00'),
        }),
        existing,
      ),
    ).toBeNull();
  });
});

describe('editing an existing reservation', () => {
  it('does not let a reservation conflict with itself', () => {
    const existing = [existingBlock({ reservationId: 'rsv-1' })];

    const conflict = findConflict(
      request({ excludeReservationId: 'rsv-1', returnAt: at('2026-09-13T10:00') }),
      existing,
    );

    expect(conflict).toBeNull();
  });

  it('still detects a conflict with a different reservation while editing', () => {
    const existing = [
      existingBlock({ reservationId: 'rsv-1' }),
      existingBlock({
        itemId: 'item-2',
        reservationId: 'rsv-2',
        reservationCode: 'RSV-0002',
        pickupAt: at('2026-09-20T10:00'),
        returnAt: at('2026-09-22T10:00'),
        blockStartAt: at('2026-09-20T10:00'),
        blockEndAt: at('2026-09-25T10:00'),
      }),
    ];

    const conflict = findConflict(
      request({
        excludeReservationId: 'rsv-1',
        pickupAt: at('2026-09-21T10:00'),
        returnAt: at('2026-09-23T10:00'),
      }),
      existing,
    );

    expect(conflict?.conflictingReservationCode).toBe('RSV-0002');
  });
});

describe('blocking statuses', () => {
  it('blocks the statuses that hold a dress', () => {
    for (const status of [
      'Reserved',
      'Fitting Scheduled',
      'Fitted',
      'Picked Up',
      'Returned',
      'Closed',
    ] as ReservationStatus[]) {
      expect(statusBlocks(status)).toBe(true);
    }
  });

  it('does not block on Inquiry — an enquiry is a conversation, not a hold', () => {
    expect(statusBlocks('Inquiry')).toBe(false);
  });

  it('does not block on Cancelled or No-Show', () => {
    expect(statusBlocks('Cancelled')).toBe(false);
    expect(statusBlocks('No-Show')).toBe(false);
  });

  it('lists exactly six blocking statuses', () => {
    expect(BLOCKING_STATUSES).toHaveLength(6);
  });
});

describe('operational dress blocks', () => {
  it('blocks alteration, repair and retirement', () => {
    expect(isDressOperationallyBlocked('In Alteration')).toBe(true);
    expect(isDressOperationallyBlocked('Under Repair')).toBe(true);
    expect(isDressOperationallyBlocked('Retired')).toBe(true);
  });

  it('does not block cleaning, reserved or out with customer — those are date questions', () => {
    expect(isDressOperationallyBlocked('In Cleaning')).toBe(false);
    expect(isDressOperationallyBlocked('Reserved')).toBe(false);
    expect(isDressOperationallyBlocked('Out with Customer')).toBe(false);
    expect(isDressOperationallyBlocked('Available')).toBe(false);
  });
});

describe('nextAvailableFrom()', () => {
  it('returns the requested start when nothing blocks it', () => {
    const from = at('2026-09-20T10:00');
    expect(nextAvailableFrom(from, 2 * MS_PER_DAY, 3, [])).toBe(from);
  });

  it('returns the end of the blocking interval when the request clashes', () => {
    const existing = [existingBlock()];
    const found = nextAvailableFrom(at('2026-09-10T10:00'), 2 * MS_PER_DAY, 3, existing);

    // Blocked until 15 Sep 10:00; the next opening is exactly then.
    expect(found).toBe(at('2026-09-15T10:00'));
  });

  it('skips past several consecutive bookings', () => {
    const existing = [
      existingBlock(),
      existingBlock({
        itemId: 'item-2',
        reservationId: 'rsv-2',
        pickupAt: at('2026-09-15T10:00'),
        returnAt: at('2026-09-17T10:00'),
        blockStartAt: at('2026-09-15T10:00'),
        blockEndAt: at('2026-09-20T10:00'),
      }),
    ];

    expect(nextAvailableFrom(at('2026-09-10T10:00'), 2 * MS_PER_DAY, 3, existing)).toBe(
      at('2026-09-20T10:00'),
    );
  });

  it('ignores non-blocking intervals', () => {
    const cancelled = [existingBlock({ blocking: false })];
    const from = at('2026-09-10T10:00');
    expect(nextAvailableFrom(from, 2 * MS_PER_DAY, 3, cancelled)).toBe(from);
  });

  it('returns null when nothing opens within the horizon', () => {
    const forever = [
      existingBlock({
        blockStartAt: at('2026-09-01T00:00'),
        blockEndAt: at('2030-01-01T00:00'),
      }),
    ];

    expect(
      nextAvailableFrom(at('2026-09-10T10:00'), 2 * MS_PER_DAY, 3, forever, 30 * MS_PER_DAY),
    ).toBeNull();
  });
});
