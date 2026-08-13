/**
 * Availability — the rule that stops a boutique promising the same gown twice.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * INTERVAL SEMANTICS — the exact definition everything else depends on
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A reservation blocks a dress over the **half-open** interval:
 *
 *     [ pickupAt , returnAt + cleaningBufferDays )
 *
 * - It **starts** at the pickup instant. The dress leaves the rail then.
 * - It **ends** after the cleaning buffer has elapsed following the scheduled
 *   return. A returned gown is not immediately rentable: it has to be cleaned.
 * - The end is **exclusive**. A dress whose buffer expires at 15 Sep 00:00 may
 *   be collected at exactly 15 Sep 00:00.
 *
 * Two reservations conflict when their blocked intervals overlap:
 *
 *     aStart < bEnd  &&  bStart < aEnd
 *
 * Both sides use the same definition, so the relation is symmetric. Comparing a
 * *bare* requested range against a *buffered* existing range would not be: B
 * booked before A would be judged by a different rule than A booked before B,
 * and the answer would depend on data-entry order.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *
 * This module is pure and is compiled into **both** the browser bundle and the
 * Cloud Functions build, so the availability shown to an employee and the
 * availability enforced on the server are the same code — not two
 * implementations that can drift apart.
 *
 * The browser's answer is only ever a hint. The authoritative check runs inside
 * a server-side transaction, because a client cannot read a query atomically
 * with its write.
 */

import { addDays, type EpochMs } from './datetime';
import type { DressStatus } from './dress';

/** The specification's default. A dress-level value overrides it. */
export const DEFAULT_CLEANING_BUFFER_DAYS = 3;

export interface Interval {
  /** Inclusive. */
  readonly start: EpochMs;
  /** Exclusive. */
  readonly end: EpochMs;
}

export const RESERVATION_STATUSES = [
  'Inquiry',
  'Reserved',
  'Fitting Scheduled',
  'Fitted',
  'Picked Up',
  'Returned',
  'Closed',
  'Cancelled',
  'No-Show',
] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export function isReservationStatus(value: unknown): value is ReservationStatus {
  return typeof value === 'string' && (RESERVATION_STATUSES as readonly string[]).includes(value);
}

/**
 * Statuses whose reservation holds the dress.
 *
 * `Returned` and `Closed` are included because the cleaning buffer runs from the
 * scheduled return — the garment is in the wash, not on the rail. They stop
 * blocking on their own, without any status change, once `blockEndAt` passes:
 * the interval, not the status, is what expires.
 *
 * `Inquiry` is absent by design. An enquiry is a conversation, not a hold; if it
 * blocked the dress, a browsing customer would take a gown off the market.
 *
 * `Cancelled` and `No-Show` never block.
 */
export const BLOCKING_STATUSES: readonly ReservationStatus[] = [
  'Reserved',
  'Fitting Scheduled',
  'Fitted',
  'Picked Up',
  'Returned',
  'Closed',
];

export function statusBlocks(status: ReservationStatus): boolean {
  return BLOCKING_STATUSES.includes(status);
}

/**
 * Dress statuses that make a dress unbookable regardless of dates.
 *
 * Distinct from date conflicts: no future window makes a retired gown bookable.
 */
export const OPERATIONALLY_BLOCKED_DRESS_STATUSES: readonly DressStatus[] = [
  'In Alteration',
  'Under Repair',
  'Retired',
];

export function isDressOperationallyBlocked(status: DressStatus): boolean {
  return OPERATIONALLY_BLOCKED_DRESS_STATUSES.includes(status);
}

/* ------------------------------------------------------------------------ *
 * Intervals
 * ------------------------------------------------------------------------ */

/**
 * The interval a booking blocks: pickup through return plus the cleaning buffer.
 *
 * Materialised on every `reservationItem` at write time, because Firestore
 * cannot filter on a computed expression — the query has to compare a stored
 * field.
 */
export function blockedInterval(
  pickupAt: EpochMs,
  returnAt: EpochMs,
  cleaningBufferDays: number,
): Interval {
  if (!Number.isInteger(cleaningBufferDays) || cleaningBufferDays < 0) {
    throw new Error(
      `Cleaning buffer must be a whole number of days, received: ${cleaningBufferDays}`,
    );
  }
  if (returnAt < pickupAt) {
    throw new Error('Return cannot be before pickup.');
  }

  return { start: pickupAt, end: addDays(returnAt, cleaningBufferDays) };
}

/**
 * Do two half-open intervals overlap?
 *
 * Half-open is what makes back-to-back bookings work: an interval ending at
 * exactly the instant another begins does not overlap, so a dress free from
 * 15 Sep 00:00 can be collected at 15 Sep 00:00.
 *
 * An empty or inverted interval overlaps nothing.
 */
export function overlaps(a: Interval, b: Interval): boolean {
  if (a.start >= a.end || b.start >= b.end) return false;
  return a.start < b.end && b.start < a.end;
}

/* ------------------------------------------------------------------------ *
 * Conflict detection
 * ------------------------------------------------------------------------ */

/** An existing booking of one dress, as stored on `reservationItems`. */
export interface ExistingBlock {
  readonly itemId: string;
  readonly reservationId: string;
  readonly reservationCode: string;
  readonly dressId: string;
  readonly pickupAt: EpochMs;
  readonly returnAt: EpochMs;
  readonly blockStartAt: EpochMs;
  readonly blockEndAt: EpochMs;
  readonly blocking: boolean;
}

export type ConflictReason =
  | 'DATE_OVERLAP'
  | 'CLEANING_BUFFER'
  | 'DRESS_RETIRED'
  | 'DRESS_UNDER_REPAIR'
  | 'DRESS_IN_ALTERATION'
  | 'DRESS_NOT_FOUND';

export interface DressConflict {
  readonly dressId: string;
  readonly dressCode: string;
  readonly dressName: string;
  readonly reason: ConflictReason;
  readonly conflictingReservationId: string | null;
  readonly conflictingReservationCode: string | null;
  readonly conflictingPickupAt: EpochMs | null;
  readonly conflictingReturnAt: EpochMs | null;
  /** When the dress next becomes free, given the conflicts found. */
  readonly availableFrom: EpochMs | null;
}

export interface AvailabilityRequest {
  readonly dressId: string;
  readonly dressCode: string;
  readonly dressName: string;
  readonly dressStatus: DressStatus;
  readonly pickupAt: EpochMs;
  readonly returnAt: EpochMs;
  readonly cleaningBufferDays: number;
  /**
   * Items belonging to the reservation being edited, which must not conflict
   * with themselves. Empty when creating.
   */
  readonly excludeReservationId?: string | undefined;
}

/**
 * Decide whether one dress is free for a requested window.
 *
 * Returns `null` when available, or the conflict that makes it unavailable.
 *
 * Operational blocks are checked first: "this gown is retired" is a more useful
 * answer than "it clashes with RSV-0012", and the date comparison is irrelevant
 * once the dress cannot be rented at all.
 */
export function findConflict(
  request: AvailabilityRequest,
  existing: readonly ExistingBlock[],
): DressConflict | null {
  const operational = operationalReason(request.dressStatus);

  if (operational !== null) {
    return {
      dressId: request.dressId,
      dressCode: request.dressCode,
      dressName: request.dressName,
      reason: operational,
      conflictingReservationId: null,
      conflictingReservationCode: null,
      conflictingPickupAt: null,
      conflictingReturnAt: null,
      availableFrom: null,
    };
  }

  const requested = blockedInterval(request.pickupAt, request.returnAt, request.cleaningBufferDays);

  const clashes = existing.filter((block) => {
    if (!block.blocking) return false;
    if (block.dressId !== request.dressId) return false;
    if (
      request.excludeReservationId !== undefined &&
      block.reservationId === request.excludeReservationId
    ) {
      return false;
    }

    return overlaps(requested, { start: block.blockStartAt, end: block.blockEndAt });
  });

  if (clashes.length === 0) {
    return null;
  }

  // Report the clash that starts earliest — the one an employee will recognise
  // as "the booking already in the diary".
  const first = [...clashes].sort((a, b) => a.blockStartAt - b.blockStartAt)[0]!;

  /*
   * Distinguish a true date overlap from a buffer collision. "It is still being
   * cleaned until Friday" and "someone else has it" call for different
   * conversations with the customer.
   */
  const bareOverlap = overlaps(requested, { start: first.pickupAt, end: first.returnAt });

  return {
    dressId: request.dressId,
    dressCode: request.dressCode,
    dressName: request.dressName,
    reason: bareOverlap ? 'DATE_OVERLAP' : 'CLEANING_BUFFER',
    conflictingReservationId: first.reservationId,
    conflictingReservationCode: first.reservationCode,
    conflictingPickupAt: first.pickupAt,
    conflictingReturnAt: first.returnAt,
    availableFrom: Math.max(...clashes.map((block) => block.blockEndAt)),
  };
}

function operationalReason(status: DressStatus): ConflictReason | null {
  switch (status) {
    case 'Retired':
      return 'DRESS_RETIRED';
    case 'Under Repair':
      return 'DRESS_UNDER_REPAIR';
    case 'In Alteration':
      return 'DRESS_IN_ALTERATION';
    default:
      return null;
  }
}

/**
 * Check several dresses at once.
 *
 * Returns every conflict, not just the first: an employee choosing three gowns
 * should be told about all the problems in one pass rather than discovering
 * them one save at a time.
 */
export function findConflicts(
  requests: readonly AvailabilityRequest[],
  existing: readonly ExistingBlock[],
): DressConflict[] {
  const conflicts: DressConflict[] = [];

  for (const request of requests) {
    const conflict = findConflict(request, existing);
    if (conflict !== null) {
      conflicts.push(conflict);
    }
  }

  return conflicts;
}

/**
 * The earliest instant at or after `notBefore` when a dress is free for a stay
 * of `durationMs`, given its known blocks.
 *
 * Used to answer "when *can* we do it?" instead of only "no". Considers the end
 * of each blocking interval as a candidate start, which is sufficient because a
 * window can only open where one closes.
 */
export function nextAvailableFrom(
  notBefore: EpochMs,
  durationMs: number,
  cleaningBufferDays: number,
  existing: readonly ExistingBlock[],
  horizonMs: number = 365 * 24 * 60 * 60 * 1000,
): EpochMs | null {
  const blocks = existing
    .filter((block) => block.blocking && block.blockEndAt > notBefore)
    .sort((a, b) => a.blockStartAt - b.blockStartAt);

  const candidates = [notBefore, ...blocks.map((block) => block.blockEndAt)];

  for (const start of candidates) {
    if (start > notBefore + horizonMs) break;

    const requested = blockedInterval(start, start + durationMs, cleaningBufferDays);
    const clashes = blocks.some((block) =>
      overlaps(requested, { start: block.blockStartAt, end: block.blockEndAt }),
    );

    if (!clashes) return start;
  }

  return null;
}
