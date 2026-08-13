/**
 * Pure decisions for the reservation Functions.
 *
 * The Functions do the I/O; these decide. Everything here is a function from
 * plain data to a verdict, so every refusal path is testable without an
 * emulator.
 */

import type { DressStatus } from '../../../src/domain/dress';
import type { ReservationStatus } from '../../../src/domain/availability';
import type { Verdict } from './guards';

const allow = (): Verdict => ({ ok: true });
const refuse = (code: string, message: string): Verdict => ({ ok: false, code, message });

/* ------------------------------------------------------------------------ *
 * Structured request/response contracts
 * ------------------------------------------------------------------------ */

export interface CreateReservationRequest {
  readonly customerId: unknown;
  /** Boutique-local wall time, `YYYY-MM-DDTHH:MM`. */
  readonly pickupAt: unknown;
  readonly returnAt: unknown;
  /** Calendar date, `YYYY-MM-DD`, or null. */
  readonly eventDate: unknown;
  readonly dressIds: unknown;
  readonly accessories?: unknown;
  readonly alterations?: unknown;
  readonly discount?: unknown;
  readonly notes?: unknown;
}

export const MAX_DRESSES_PER_RESERVATION = 10;

/**
 * Validate the shape of a creation request before any read.
 *
 * Everything here comes from a browser and is treated as hostile: ids are
 * strings until proven to name real documents, and the documents themselves are
 * read server-side rather than trusted from the payload.
 */
export function validateCreateRequest(request: CreateReservationRequest): Verdict {
  if (typeof request.customerId !== 'string' || request.customerId.trim().length === 0) {
    return refuse('invalid-argument', 'A customer is required.');
  }

  if (!Array.isArray(request.dressIds) || request.dressIds.length === 0) {
    return refuse('invalid-argument', 'Choose at least one dress.');
  }

  if (request.dressIds.length > MAX_DRESSES_PER_RESERVATION) {
    return refuse(
      'invalid-argument',
      `A reservation can hold at most ${MAX_DRESSES_PER_RESERVATION} dresses.`,
    );
  }

  if (!request.dressIds.every((id) => typeof id === 'string' && id.trim().length > 0)) {
    return refuse('invalid-argument', 'One of the selected dresses is not valid.');
  }

  if (new Set(request.dressIds as string[]).size !== request.dressIds.length) {
    // The same gown twice in one booking would double-count the price and make
    // the availability check contradict itself.
    return refuse('invalid-argument', 'The same dress was selected more than once.');
  }

  if (typeof request.pickupAt !== 'string' || typeof request.returnAt !== 'string') {
    return refuse('invalid-argument', 'Pickup and return date/time are required.');
  }

  if (
    request.eventDate !== null &&
    request.eventDate !== undefined &&
    typeof request.eventDate !== 'string'
  ) {
    return refuse('invalid-argument', 'The event date is not valid.');
  }

  return allow();
}

/* ------------------------------------------------------------------------ *
 * Referenced-entity validation
 * ------------------------------------------------------------------------ */

export interface CustomerRecord {
  readonly exists: boolean;
  readonly archived: unknown;
  readonly code: unknown;
}

/**
 * The customer must exist and be usable.
 *
 * An archived customer is refused: archiving means "no longer trading with
 * us", and quietly reactivating one by booking against it would defeat the
 * point of the archive.
 */
export function validateCustomer(customer: CustomerRecord): Verdict {
  if (!customer.exists) {
    return refuse('not-found', 'That customer no longer exists.');
  }
  if (customer.archived === true) {
    return refuse('failed-precondition', 'That customer is archived. Restore them first.');
  }
  return allow();
}

export interface DressRecord {
  readonly id: string;
  readonly exists: boolean;
  readonly status: unknown;
  readonly code: unknown;
}

/** Every requested dress must exist. Missing ids are named, not summarised. */
export function findMissingDresses(dresses: readonly DressRecord[]): string[] {
  return dresses.filter((dress) => !dress.exists).map((dress) => dress.id);
}

/* ------------------------------------------------------------------------ *
 * Status changes
 * ------------------------------------------------------------------------ */

export interface StatusChangeRequest {
  readonly reservationId: unknown;
  readonly status: unknown;
  readonly reason?: unknown;
}

export function validateStatusChangeRequest(request: StatusChangeRequest): Verdict {
  if (typeof request.reservationId !== 'string' || request.reservationId.trim().length === 0) {
    return refuse('invalid-argument', 'A reservation is required.');
  }
  if (typeof request.status !== 'string') {
    return refuse('invalid-argument', 'A status is required.');
  }
  return allow();
}

/* ------------------------------------------------------------------------ *
 * Dress status resolution after a release
 * ------------------------------------------------------------------------ */

/**
 * Whether any other blocking item still holds this dress *now*.
 *
 * Used when a reservation is cancelled: the dress only returns to Available if
 * nothing else is holding it. Compares against the current instant rather than
 * counting rows, because a booking whose interval has passed no longer holds
 * anything.
 */
export function hasOtherActiveHold(
  blocks: readonly {
    reservationId: string;
    blockStartAt: number;
    blockEndAt: number;
    blocking: boolean;
  }[],
  excludeReservationId: string,
  now: number,
): boolean {
  return blocks.some(
    (block) =>
      block.blocking && block.reservationId !== excludeReservationId && block.blockEndAt > now,
  );
}

/** Statuses a dress may be moved to when a reservation releases it. */
export function isReleasableDressStatus(status: unknown): status is DressStatus {
  return status === 'Reserved';
}

export type { ReservationStatus };
