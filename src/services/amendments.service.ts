/**
 * Amendments — the application layer.
 *
 * Every call here goes through a Cloud Function, for the same reason payments
 * do: adding a veil or a hem changes what the customer owes, and the new
 * pricing snapshot has to be computed from a list read inside a transaction.
 *
 * There is deliberately no client write path to `reservations.pricing`. The
 * rules refuse it, so the Function is not merely the convenient route — it is
 * the only one.
 */

import { httpsCallable } from 'firebase/functions';

import { getFirebaseClient } from '@/lib/firebase/client';
import { assertOnline } from './offline-guard';
import type { GuardedOperation } from '@/domain/connectivity';
import type { Baisa } from '@/domain/money';

export class AmendmentServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AmendmentServiceError';
    this.code = code;
  }
}

function callable<Request, Response>(name: string) {
  return httpsCallable<Request, Response>(getFirebaseClient().functions, name);
}

export interface AmendmentResult {
  readonly success: true;
  readonly duplicate?: boolean;
  readonly grandTotal: Baisa;
}

export interface AddAccessoryInput {
  readonly reservationId: string;
  /** The catalogue entry, kept for reporting. */
  readonly accessoryId: string;
  readonly name: string;
  readonly nameAr: string;
  readonly unitPrice: Baisa;
  readonly securityDeposit: Baisa;
  readonly quantity: number;
  /** Generated when the dialog opens. Becomes the line's id. */
  readonly idempotencyKey: string;
}

export async function addReservationAccessory(
  input: AddAccessoryInput,
): Promise<AmendmentResult> {
  requireConnection('reservation.amend');

  try {
    const result = await callable<AddAccessoryInput, AmendmentResult>('addReservationAccessory')(
      input,
    );
    return result.data;
  } catch (error) {
    throw toAmendmentError(error);
  }
}

export async function removeReservationAccessory(input: {
  readonly reservationId: string;
  readonly lineId: string;
}): Promise<AmendmentResult> {
  requireConnection('reservation.amend');

  try {
    const result = await callable<typeof input, AmendmentResult>('removeReservationAccessory')(
      input,
    );
    return result.data;
  } catch (error) {
    throw toAmendmentError(error);
  }
}

export interface AddAlterationInput {
  readonly reservationId: string;
  readonly description: string;
  readonly descriptionAr: string;
  readonly amount: Baisa;
  readonly notes: string;
  readonly idempotencyKey: string;
}

export async function addReservationAlteration(
  input: AddAlterationInput,
): Promise<AmendmentResult> {
  requireConnection('reservation.amend');

  try {
    const result = await callable<AddAlterationInput, AmendmentResult>(
      'addReservationAlteration',
    )(input);
    return result.data;
  } catch (error) {
    throw toAmendmentError(error);
  }
}

export async function removeReservationAlteration(input: {
  readonly reservationId: string;
  readonly lineId: string;
}): Promise<AmendmentResult> {
  requireConnection('reservation.amend');

  try {
    const result = await callable<typeof input, AmendmentResult>('removeReservationAlteration')(
      input,
    );
    return result.data;
  } catch (error) {
    throw toAmendmentError(error);
  }
}

/**
 * A new request key.
 *
 * Generated once when a dialog opens and reused for every retry of that
 * submission, so a double click converges on one line rather than two.
 */
export function newAmendmentKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `amend-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Refuse before the call, with the reason for THIS operation.
 *
 * Delegates to the shared guard so the wording comes from
 * `@/domain/connectivity` and every screen refuses in the same words. See
 * `src/services/offline-guard.ts`.
 */
function requireConnection(operation: GuardedOperation): void {
  assertOnline(operation, (message) => new AmendmentServiceError('offline', message));
}

const MESSAGES: Record<string, string> = {
  'functions/unauthenticated': 'Sign in and try again.',
  'functions/permission-denied': 'You do not have permission to do that.',
  'functions/not-found': 'That line is no longer on this reservation.',
  'functions/unavailable':
    'An internet connection is required to change what a reservation charges.',
};

function toAmendmentError(error: unknown): AmendmentServiceError {
  if (error instanceof AmendmentServiceError) return error;

  const code = (error as { code?: string }).code ?? 'unknown';

  /*
   * The Function's own message is preferred for the refusals it computes —
   * "void the invoice first" is far more useful than a generic failure, and the
   * domain owns that wording.
   */
  const message =
    MESSAGES[code] ?? (error as { message?: string }).message ?? 'That change could not be saved.';

  return new AmendmentServiceError(code, message);
}
