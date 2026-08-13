/**
 * Reservation lifecycle and validation.
 *
 * Pure. Compiled into both the browser bundle and the Cloud Functions build, so
 * the transitions the interface offers are the transitions the server enforces.
 */

import { addDays, type EpochMs } from './datetime';
import type { ReservationStatus } from './availability';

/**
 * Legal transitions.
 *
 * The forward path is the specification's:
 *
 *   Inquiry → Reserved → Fitting Scheduled → Fitted → Picked Up → Returned → Closed
 *
 * Deliberate additions, each for a situation that happens in a real boutique:
 *
 * - `Reserved → Picked Up` and `Fitting Scheduled → Picked Up`: not every rental
 *   involves a fitting, and a gown that fits off the rail is collected directly.
 *   Forcing a fictional fitting through the system to enable collection would
 *   put a lie in the record.
 * - `Fitted → Fitting Scheduled`: a second fitting is ordinary.
 * - Cancellation from any pre-collection state.
 * - `No-Show` only from states where the customer was expected — you cannot fail
 *   to collect a gown you already hold.
 *
 * Everything absent is refused. `Inquiry → Picked Up` is not a shortcut; it is a
 * gown leaving the boutique with no booking behind it.
 */
const TRANSITIONS: Readonly<Record<ReservationStatus, readonly ReservationStatus[]>> = {
  Inquiry: ['Reserved', 'Cancelled'],
  Reserved: ['Fitting Scheduled', 'Fitted', 'Picked Up', 'Cancelled', 'No-Show'],
  'Fitting Scheduled': ['Fitted', 'Picked Up', 'Cancelled', 'No-Show'],
  Fitted: ['Fitting Scheduled', 'Picked Up', 'Cancelled', 'No-Show'],
  'Picked Up': ['Returned'],
  Returned: ['Closed'],
  Closed: [],
  Cancelled: [],
  'No-Show': [],
};

export type TransitionRefusal =
  'SAME_STATUS' | 'TERMINAL' | 'NOT_PERMITTED' | 'PICKED_UP_IS_IRREVERSIBLE';

/**
 * May this reservation move to that status?
 *
 * Returns `null` when the move is legal, or the reason it is refused.
 */
export function refuseStatusChange(
  from: ReservationStatus,
  to: ReservationStatus,
): TransitionRefusal | null {
  if (from === to) return 'SAME_STATUS';

  if (TRANSITIONS[from].length === 0) return 'TERMINAL';

  if (!TRANSITIONS[from].includes(to)) {
    /*
     * Once a gown has physically left the boutique, the only honest next step is
     * recording its return. Cancelling a collected reservation would leave the
     * dress marked available while a customer still has it.
     */
    if (from === 'Picked Up') return 'PICKED_UP_IS_IRREVERSIBLE';
    return 'NOT_PERMITTED';
  }

  return null;
}

export function allowedTransitionsFrom(status: ReservationStatus): readonly ReservationStatus[] {
  return TRANSITIONS[status];
}

export const TRANSITION_REFUSAL_MESSAGES: Readonly<Record<TransitionRefusal, string>> = {
  SAME_STATUS: 'The reservation already has this status.',
  TERMINAL: 'This reservation is closed and cannot change status.',
  NOT_PERMITTED: 'That is not a valid next step for this reservation.',
  PICKED_UP_IS_IRREVERSIBLE:
    'The dress is with the customer. Record its return before anything else.',
};

/** Statuses in which a reservation is still live work for the boutique. */
export function isActive(status: ReservationStatus): boolean {
  return status !== 'Closed' && status !== 'Cancelled' && status !== 'No-Show';
}

/** Statuses from which dates or dresses may still be changed. */
export function canEditBooking(status: ReservationStatus): boolean {
  return (
    status === 'Inquiry' ||
    status === 'Reserved' ||
    status === 'Fitting Scheduled' ||
    status === 'Fitted'
  );
}

/* ------------------------------------------------------------------------ *
 * Date validation
 * ------------------------------------------------------------------------ */

export type DateProblem =
  | 'PICKUP_IN_PAST'
  | 'RETURN_BEFORE_PICKUP'
  | 'RETURN_EQUALS_PICKUP'
  | 'EVENT_BEFORE_PICKUP'
  | 'RENTAL_TOO_LONG'
  | 'PICKUP_TOO_FAR_AHEAD';

export const DATE_PROBLEM_MESSAGES: Readonly<Record<DateProblem, string>> = {
  PICKUP_IN_PAST: 'Pickup cannot be in the past.',
  RETURN_BEFORE_PICKUP: 'Return must be after pickup.',
  RETURN_EQUALS_PICKUP: 'Return must be after pickup, not the same moment.',
  EVENT_BEFORE_PICKUP: 'The event is before the dress would be collected.',
  RENTAL_TOO_LONG: 'That rental period is longer than a year.',
  PICKUP_TOO_FAR_AHEAD: 'That pickup date is more than two years away.',
};

export interface ReservationDates {
  readonly pickupAt: EpochMs;
  readonly returnAt: EpochMs;
  readonly eventAt: EpochMs | null;
}

export interface DateValidationOptions {
  /** Current instant. Always passed in, never read from a clock in here. */
  readonly now: EpochMs;
  /**
   * Allow a pickup already in the past.
   *
   * Needed when back-filling a historical reservation, and when *editing* one
   * whose pickup has passed — an employee changing the return date of a
   * collected gown must not be blocked by its pickup being yesterday.
   */
  readonly allowPastPickup?: boolean;
  /**
   * Allow an event date before pickup. Off by default: it almost always means
   * the two fields were entered the wrong way round.
   */
  readonly allowEventBeforePickup?: boolean;
}

const MAX_RENTAL_DAYS = 365;
const MAX_LEAD_DAYS = 730;

/**
 * Validate a reservation's dates.
 *
 * Returns every problem found, so the employee sees them all at once rather
 * than fixing one and discovering the next.
 */
export function findDateProblems(
  dates: ReservationDates,
  options: DateValidationOptions,
): DateProblem[] {
  const problems: DateProblem[] = [];

  if (options.allowPastPickup !== true && dates.pickupAt < options.now) {
    problems.push('PICKUP_IN_PAST');
  }

  if (dates.returnAt === dates.pickupAt) {
    problems.push('RETURN_EQUALS_PICKUP');
  } else if (dates.returnAt < dates.pickupAt) {
    problems.push('RETURN_BEFORE_PICKUP');
  }

  if (
    options.allowEventBeforePickup !== true &&
    dates.eventAt !== null &&
    dates.eventAt < dates.pickupAt
  ) {
    problems.push('EVENT_BEFORE_PICKUP');
  }

  if (dates.returnAt > addDays(dates.pickupAt, MAX_RENTAL_DAYS)) {
    problems.push('RENTAL_TOO_LONG');
  }

  if (dates.pickupAt > addDays(options.now, MAX_LEAD_DAYS)) {
    problems.push('PICKUP_TOO_FAR_AHEAD');
  }

  return problems;
}

/* ------------------------------------------------------------------------ *
 * Dress status driven by the reservation
 * ------------------------------------------------------------------------ */

import type { DressStatus } from './dress';

/**
 * The dress status a reservation transition implies — or `null` to leave it
 * alone.
 *
 * Two rules keep this from corrupting the inventory:
 *
 * 1. **Operational states are never overwritten.** A gown marked Under Repair or
 *    Retired keeps that status; those are physical facts about the garment, not
 *    consequences of a booking.
 * 2. **Reserved is only applied to an Available dress.** A dress may carry
 *    several future bookings, and its status describes where the garment is
 *    now — not that a booking exists somewhere in the diary. Booking December
 *    must not change the status of a gown that is currently out with an October
 *    customer.
 */
export function dressStatusForTransition(
  current: DressStatus,
  to: ReservationStatus,
): DressStatus | null {
  if (current === 'Retired' || current === 'Under Repair' || current === 'In Alteration') {
    return null;
  }

  switch (to) {
    case 'Reserved':
      return current === 'Available' ? 'Reserved' : null;
    case 'Picked Up':
      return 'Out with Customer';
    case 'Returned':
      return 'In Cleaning';
    default:
      return null;
  }
}

/**
 * The dress status when a reservation stops holding it — cancellation or
 * no-show.
 *
 * Only releases a dress that was merely Reserved, and only when nothing else
 * holds it. A gown Out with Customer is not freed by cancelling some other
 * booking.
 */
export function dressStatusAfterRelease(
  current: DressStatus,
  hasOtherActiveHold: boolean,
): DressStatus | null {
  if (current !== 'Reserved') return null;
  if (hasOtherActiveHold) return null;
  return 'Available';
}
