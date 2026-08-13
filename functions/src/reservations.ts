/**
 * Reservations — the trusted server-side operations.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS RUNS ON THE SERVER
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Deciding whether a dress is free means running a *query* — "are there
 * blocking items for this dress overlapping these dates?" — and then writing
 * based on the answer. The Firestore **client** SDK cannot read a query inside a
 * transaction, so any browser-side check is a time-of-check/time-of-use race:
 * two employees both see "free" and both book.
 *
 * The Admin SDK can. `transaction.get(query)` runs inside the transaction, so
 * the check and the write commit together.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A QUERY ALONE IS STILL NOT ENOUGH
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A transactional query locks the documents it *returns*. When two employees
 * book the first-ever reservation for a dress, the query returns nothing —
 * there is nothing to lock — and both transactions can commit. That is a
 * phantom read, and it is exactly the double-booking this phase exists to
 * prevent.
 *
 * The fix is to give every dress a document that each booking transaction both
 * **reads and writes**: the dress record itself, carrying `bookingVersion`.
 * Reading it inside the transaction takes a lock; writing it makes two
 * concurrent bookings of the same dress a write-write conflict, so Firestore
 * aborts one and retries it. On retry the loser re-runs the query, now sees the
 * winner's item, and returns a structured conflict.
 *
 * Bookings of *different* dresses touch different documents and proceed in
 * parallel.
 */

import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore';

import { callerFrom, db, readProfile, writeAudit } from './lib/firestore';
import { effectiveRole, type Verdict } from './lib/guards';
import {
  findMissingDresses,
  validateCreateRequest,
  validateCustomer,
  validateStatusChangeRequest,
  hasOtherActiveHold,
  type CreateReservationRequest,
  type StatusChangeRequest,
} from './lib/reservation-guards';

import {
  blockedInterval,
  findConflicts,
  isReservationStatus,
  statusBlocks,
  type AvailabilityRequest,
  type DressConflict,
  type ExistingBlock,
  type ReservationStatus,
} from '../../src/domain/availability';
import {
  canEditBooking,
  dressStatusAfterRelease,
  dressStatusForTransition,
  findDateProblems,
  refuseStatusChange,
  DATE_PROBLEM_MESSAGES,
  TRANSITION_REFUSAL_MESSAGES,
} from '../../src/domain/reservation';
import {
  computePricing,
  NO_DISCOUNT,
  type PricingInput,
} from '../../src/domain/reservation-pricing';
import { fromMuscatWallTime, startOfMuscatDay, toMuscatDate } from '../../src/domain/datetime';
import { formatFor, counterIdFor } from '../../src/domain/numbering';
import { baisa, type Baisa } from '../../src/domain/money';
import type { DressStatus } from '../../src/domain/dress';

function enforce(verdict: Verdict): void {
  if (!verdict.ok) {
    throw new HttpsError(verdict.code as never, verdict.message);
  }
}

/** Confirm the caller is an active employee. Never trusts the token alone. */
async function requireEmployee(request: CallableRequest<unknown>): Promise<{
  uid: string;
  name: string;
  role: 'OWNER' | 'STAFF';
}> {
  const caller = callerFrom(request.auth);

  if (caller.uid === null) {
    throw new HttpsError('unauthenticated', 'Sign in to perform this action.');
  }

  const profile = await readProfile(caller.uid);
  const role = effectiveRole(caller, profile);

  if (role === null) {
    throw new HttpsError('permission-denied', 'This account is not an active employee.');
  }

  return {
    uid: caller.uid,
    name: (request.auth?.token['name'] as string | undefined) ?? 'Employee',
    role,
  };
}

/* ------------------------------------------------------------------------ *
 * Shared reading
 * ------------------------------------------------------------------------ */

interface LoadedDress {
  readonly id: string;
  readonly exists: boolean;
  readonly code: string;
  readonly name: string;
  readonly designer: string;
  readonly status: DressStatus;
  readonly rentalPrice: Baisa;
  readonly securityDeposit: Baisa;
  readonly cleaningBufferDays: number;
  /** Storage path of the primary photograph, snapshotted onto each item. */
  readonly primaryPhotoPath: string | null;
}

const DEFAULT_BUFFER_DAYS = 3;

function toLoadedDress(id: string, data: FirebaseFirestore.DocumentData | undefined): LoadedDress {
  if (data === undefined) {
    return {
      id,
      exists: false,
      code: '',
      name: '',
      designer: '',
      status: 'Retired',
      rentalPrice: baisa(0),
      securityDeposit: baisa(0),
      cleaningBufferDays: DEFAULT_BUFFER_DAYS,
      primaryPhotoPath: null,
    };
  }

  return {
    id,
    exists: true,
    code: typeof data['code'] === 'string' ? data['code'] : '',
    name: typeof data['name'] === 'string' ? data['name'] : '',
    designer: typeof data['designer'] === 'string' ? data['designer'] : '',
    // An unrecognised status is treated as Retired: presenting an unknown state
    // as bookable is the dangerous direction to fail in.
    status: isDressStatus(data['status']) ? data['status'] : 'Retired',
    rentalPrice: safeBaisa(data['rentalPrice']),
    securityDeposit: safeBaisa(data['securityDeposit']),
    cleaningBufferDays:
      typeof data['cleaningBufferDays'] === 'number' && Number.isInteger(data['cleaningBufferDays'])
        ? data['cleaningBufferDays']
        : DEFAULT_BUFFER_DAYS,
    primaryPhotoPath: readPrimaryPhotoPath(data),
  };
}

/**
 * The storage path of the dress's main photograph, or null.
 *
 * Falls back to the first photograph when no primary has been chosen, and to
 * null when there are none — a document renders nothing rather than a broken
 * image.
 */
function readPrimaryPhotoPath(data: FirebaseFirestore.DocumentData): string | null {
  const photos = data['photos'];
  if (!Array.isArray(photos) || photos.length === 0) return null;

  const primaryId = typeof data['primaryPhotoId'] === 'string' ? data['primaryPhotoId'] : null;

  const chosen =
    (primaryId === null
      ? undefined
      : photos.find(
          (photo: unknown) =>
            typeof photo === 'object' &&
            photo !== null &&
            (photo as Record<string, unknown>)['id'] === primaryId,
        )) ?? photos[0];

  const path = (chosen as Record<string, unknown> | undefined)?.['storagePath'];
  return typeof path === 'string' && path.length > 0 ? path : null;
}

function isDressStatus(value: unknown): value is DressStatus {
  return (
    value === 'Available' ||
    value === 'Reserved' ||
    value === 'Out with Customer' ||
    value === 'In Cleaning' ||
    value === 'In Alteration' ||
    value === 'Under Repair' ||
    value === 'Retired'
  );
}

const safeBaisa = (value: unknown): Baisa =>
  typeof value === 'number' && Number.isInteger(value) ? baisa(value) : baisa(0);

/**
 * Read every blocking item for a set of dresses, inside the transaction.
 *
 * One query per dress: Firestore's `in` operator is capped, and a per-dress
 * query keeps the locked document set precise.
 *
 * `blockEndAt > requestedStart` is the only inequality, so the index stays
 * simple; the rest of the overlap test happens in the domain over a small
 * candidate set.
 */
async function readBlocks(
  transaction: Transaction,
  dressIds: readonly string[],
  fromInstant: number,
): Promise<ExistingBlock[]> {
  const blocks: ExistingBlock[] = [];

  for (const dressId of dressIds) {
    const snapshot = await transaction.get(
      db()
        .collection('reservationItems')
        .where('dressId', '==', dressId)
        .where('blocking', '==', true)
        .where('blockEndAt', '>', Timestamp.fromMillis(fromInstant)),
    );

    for (const document of snapshot.docs) {
      const data = document.data();
      blocks.push({
        itemId: document.id,
        reservationId: String(data['reservationId'] ?? ''),
        reservationCode: String(data['reservationCode'] ?? ''),
        dressId: String(data['dressId'] ?? ''),
        pickupAt: toMillis(data['pickupAt']),
        returnAt: toMillis(data['returnAt']),
        blockStartAt: toMillis(data['blockStartAt']),
        blockEndAt: toMillis(data['blockEndAt']),
        blocking: data['blocking'] === true,
      });
    }
  }

  return blocks;
}

function toMillis(value: unknown): number {
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof value === 'number') return value;
  return 0;
}

/* ------------------------------------------------------------------------ *
 * createReservation
 * ------------------------------------------------------------------------ */

export interface ConflictResponse {
  readonly success: false;
  readonly reason: 'DRESS_UNAVAILABLE';
  readonly conflicts: readonly ConflictDetail[];
}

export interface ConflictDetail {
  readonly dressId: string;
  readonly dressCode: string;
  readonly dressName: string;
  readonly reason: string;
  readonly conflictingReservationId: string | null;
  readonly conflictingReservationCode: string | null;
  readonly conflictingPickupAt: number | null;
  readonly conflictingReturnAt: number | null;
  readonly availableFrom: number | null;
}

function toConflictDetail(conflict: DressConflict): ConflictDetail {
  return {
    dressId: conflict.dressId,
    dressCode: conflict.dressCode,
    dressName: conflict.dressName,
    reason: conflict.reason,
    conflictingReservationId: conflict.conflictingReservationId,
    conflictingReservationCode: conflict.conflictingReservationCode,
    conflictingPickupAt: conflict.conflictingPickupAt,
    conflictingReturnAt: conflict.conflictingReturnAt,
    availableFrom: conflict.availableFrom,
  };
}

/**
 * Create a reservation.
 *
 * Atomic across every dress: if one of three gowns is unavailable, **no**
 * reservation is created. Booking two and leaving the customer to find another
 * for the third would produce a half-reservation nobody asked for.
 *
 * Returns a structured conflict response rather than throwing, so the interface
 * can name the clashing booking and offer alternatives — "unavailable" alone is
 * not an answer an employee can act on.
 */
export const createReservation = onCall(
  async (request: CallableRequest<CreateReservationRequest>) => {
    const actor = await requireEmployee(request);
    const data = request.data ?? ({} as CreateReservationRequest);

    enforce(validateCreateRequest(data));

    const customerId = data.customerId as string;
    const dressIds = data.dressIds as string[];

    // Wall time from the boutique, converted once, here.
    let pickupAt: number;
    let returnAt: number;
    let eventAt: number | null;

    try {
      pickupAt = fromMuscatWallTime(data.pickupAt as string);
      returnAt = fromMuscatWallTime(data.returnAt as string);
      eventAt =
        typeof data.eventDate === 'string' && data.eventDate.length > 0
          ? startOfMuscatDay(data.eventDate)
          : null;
    } catch (error) {
      throw new HttpsError('invalid-argument', (error as Error).message);
    }

    const now = Date.now();
    const dateProblems = findDateProblems({ pickupAt, returnAt, eventAt }, { now });

    if (dateProblems.length > 0) {
      throw new HttpsError('invalid-argument', DATE_PROBLEM_MESSAGES[dateProblems[0]!]);
    }

    const outcome = await db().runTransaction(async (transaction) => {
      /*
       * READS FIRST. Firestore requires every read in a transaction to precede
       * every write, and reading the dress documents is what takes the locks that
       * serialise concurrent bookings of the same gown.
       */
      const customerRef = db().doc(`customers/${customerId}`);
      const customerSnapshot = await transaction.get(customerRef);

      enforce(
        validateCustomer({
          exists: customerSnapshot.exists,
          archived: customerSnapshot.data()?.['archived'],
          code: customerSnapshot.data()?.['code'],
        }),
      );

      const dressRefs = dressIds.map((id) => db().doc(`dresses/${id}`));
      const dressSnapshots = await transaction.getAll(...dressRefs);
      const dresses = dressSnapshots.map((snapshot, index) =>
        toLoadedDress(dressIds[index]!, snapshot.exists ? snapshot.data() : undefined),
      );

      const missing = findMissingDresses(dresses);
      if (missing.length > 0) {
        throw new HttpsError('not-found', 'One of the selected dresses no longer exists.');
      }

      const blocks = await readBlocks(transaction, dressIds, pickupAt);

      const counterRef = db().doc(`counters/${counterIdFor('reservation')}`);
      const counterSnapshot = await transaction.get(counterRef);

      const settingsSnapshot = await transaction.get(db().doc('settings/app'));
      const vatRatePercent = readVatRate(settingsSnapshot.data());

      /* ---- DECIDE (pure, shared with the browser) ---- */

      const availabilityRequests: AvailabilityRequest[] = dresses.map((dress) => ({
        dressId: dress.id,
        dressCode: dress.code,
        dressName: dress.name,
        dressStatus: dress.status,
        pickupAt,
        returnAt,
        cleaningBufferDays: dress.cleaningBufferDays,
      }));

      const conflicts = findConflicts(availabilityRequests, blocks);

      if (conflicts.length > 0) {
        // Nothing has been written; returning here commits an empty transaction.
        return {
          success: false as const,
          reason: 'DRESS_UNAVAILABLE' as const,
          conflicts: conflicts.map(toConflictDetail),
        };
      }

      const pricingInput: PricingInput = {
        items: dresses.map((dress) => ({
          dressId: dress.id,
          dressCode: dress.code,
          dressName: dress.name,
          designer: dress.designer,
          rentalPrice: dress.rentalPrice,
          securityDeposit: dress.securityDeposit,
          cleaningBufferDays: dress.cleaningBufferDays,
        })),
        accessories: [],
        alterations: [],
        discount: NO_DISCOUNT,
        vatRatePercent,
      };

      const pricing = computePricing(pricingInput);

      /* ---- WRITE ---- */

      const current = counterSnapshot.exists ? Number(counterSnapshot.data()?.['current'] ?? 0) : 0;
      const next = current + 1;
      const code = formatFor('reservation', next);

      if (counterSnapshot.exists) {
        transaction.update(counterRef, { current: next, updatedAt: FieldValue.serverTimestamp() });
      } else {
        transaction.set(counterRef, { current: next, updatedAt: FieldValue.serverTimestamp() });
      }

      const reservationRef = db().collection('reservations').doc();
      const customer = customerSnapshot.data() ?? {};

      transaction.set(reservationRef, {
        code,
        customerId,
        customerSnapshot: {
          code: customer['code'] ?? '',
          nameEn: customer['nameEn'] ?? '',
          nameAr: customer['nameAr'] ?? '',
          phone: customer['phone'] ?? '',
          preferredLanguage: customer['preferredLanguage'] ?? 'bilingual',
        },
        status: 'Reserved' satisfies ReservationStatus,
        pickupAt: Timestamp.fromMillis(pickupAt),
        returnAt: Timestamp.fromMillis(returnAt),
        actualReturnAt: null,
        eventDate: eventAt === null ? '' : toMuscatDate(eventAt),
        eventAt: eventAt === null ? null : Timestamp.fromMillis(eventAt),
        // Frozen at creation. A later price or VAT change cannot reach back in.
        pricing: {
          ...pricing,
          items: pricingInput.items,
          accessories: [],
          alterations: [],
        },
        notes: typeof data.notes === 'string' ? data.notes : '',
        voided: false,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: actor.uid,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: actor.uid,
      });

      for (const dress of dresses) {
        const interval = blockedInterval(pickupAt, returnAt, dress.cleaningBufferDays);

        transaction.set(db().collection('reservationItems').doc(), {
          reservationId: reservationRef.id,
          reservationCode: code,
          dressId: dress.id,
          dressCode: dress.code,
          dressName: dress.name,
          /*
           * The designer, the deposit and the photograph are snapshotted here
           * alongside the price, because documents are built from these items
           * and a document must show the gown as it was when it was booked.
           * Reading them from the dress at invoice time would let a later edit
           * change an invoice the customer already holds.
           */
          designer: dress.designer,
          pickupAt: Timestamp.fromMillis(pickupAt),
          returnAt: Timestamp.fromMillis(returnAt),
          cleaningBufferDays: dress.cleaningBufferDays,
          blockStartAt: Timestamp.fromMillis(interval.start),
          blockEndAt: Timestamp.fromMillis(interval.end),
          blocking: true,
          rentalPriceSnapshot: dress.rentalPrice,
          securityDepositSnapshot: dress.securityDeposit,
          dressPhotoPath: dress.primaryPhotoPath,
          createdAt: FieldValue.serverTimestamp(),
          createdBy: actor.uid,
        });

        /*
         * Writing the dress document is what makes concurrent bookings of the
         * same gown conflict. `bookingVersion` exists purely to guarantee a write
         * even when the status does not change.
         */
        const nextStatus = dressStatusForTransition(dress.status, 'Reserved');

        transaction.update(db().doc(`dresses/${dress.id}`), {
          bookingVersion: FieldValue.increment(1),
          ...(nextStatus === null ? {} : { status: nextStatus }),
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: actor.uid,
        });
      }

      writeAudit(transaction, {
        actorUid: actor.uid,
        actorName: actor.name,
        actorRole: actor.role,
        action: 'reservation.created',
        entityType: 'reservation',
        entityId: reservationRef.id,
        before: null,
        after: {
          code,
          status: 'Reserved',
          dressCount: dresses.length,
          grandTotal: pricing.grandTotal,
        },
      });

      return {
        success: true as const,
        reservationId: reservationRef.id,
        reservationNumber: code,
        items: dresses.map((dress) => ({
          dressId: dress.id,
          dressCode: dress.code,
          dressName: dress.name,
          rentalPrice: dress.rentalPrice,
        })),
        total: pricing.grandTotal,
        conflicts: [] as ConflictDetail[],
      };
    });

    if (outcome.success) {
      logger.info('Reservation created', {
        code: outcome.reservationNumber,
        dresses: outcome.items.length,
        by: actor.uid,
      });
    }

    return outcome;
  },
);

function readVatRate(settings: FirebaseFirestore.DocumentData | undefined): number {
  const value = settings?.['vatRatePercent'];
  // Absent settings mean the owner has not configured VAT yet. Zero is the
  // honest default; inventing 5% would put a tax on an invoice nobody set.
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/* ------------------------------------------------------------------------ *
 * updateReservationDates
 * ------------------------------------------------------------------------ */

interface UpdateDatesRequest {
  readonly reservationId?: unknown;
  readonly pickupAt?: unknown;
  readonly returnAt?: unknown;
  readonly eventDate?: unknown;
}

/**
 * Move a reservation's dates.
 *
 * Re-runs the whole availability check. An existing reservation is **not**
 * assumed still valid after its dates change: moving 10–14 Sep to 12–18 Sep can
 * collide with a booking that was previously clear of it, and its own blocking
 * items are excluded so it cannot conflict with itself.
 */
export const updateReservationDates = onCall(
  async (request: CallableRequest<UpdateDatesRequest>) => {
    const actor = await requireEmployee(request);
    const data = request.data ?? {};

    if (typeof data.reservationId !== 'string' || data.reservationId.length === 0) {
      throw new HttpsError('invalid-argument', 'A reservation is required.');
    }
    if (typeof data.pickupAt !== 'string' || typeof data.returnAt !== 'string') {
      throw new HttpsError('invalid-argument', 'Pickup and return date/time are required.');
    }

    let pickupAt: number;
    let returnAt: number;
    let eventAt: number | null;

    try {
      pickupAt = fromMuscatWallTime(data.pickupAt);
      returnAt = fromMuscatWallTime(data.returnAt);
      eventAt =
        typeof data.eventDate === 'string' && data.eventDate.length > 0
          ? startOfMuscatDay(data.eventDate)
          : null;
    } catch (error) {
      throw new HttpsError('invalid-argument', (error as Error).message);
    }

    const reservationId = data.reservationId;

    return db().runTransaction(async (transaction) => {
      const reservationRef = db().doc(`reservations/${reservationId}`);
      const reservationSnapshot = await transaction.get(reservationRef);

      if (!reservationSnapshot.exists) {
        throw new HttpsError('not-found', 'That reservation no longer exists.');
      }

      const reservation = reservationSnapshot.data() ?? {};
      const status = reservation['status'];

      if (!isReservationStatus(status) || !canEditBooking(status)) {
        throw new HttpsError(
          'failed-precondition',
          'This reservation can no longer have its dates changed.',
        );
      }

      const itemsSnapshot = await transaction.get(
        db().collection('reservationItems').where('reservationId', '==', reservationId),
      );

      const dressIds = itemsSnapshot.docs.map((document) => String(document.data()['dressId']));

      const dressSnapshots = await transaction.getAll(
        ...dressIds.map((id) => db().doc(`dresses/${id}`)),
      );
      const dresses = dressSnapshots.map((snapshot, index) =>
        toLoadedDress(dressIds[index]!, snapshot.exists ? snapshot.data() : undefined),
      );

      const blocks = await readBlocks(transaction, dressIds, pickupAt);

      const dateProblems = findDateProblems(
        { pickupAt, returnAt, eventAt },
        // Editing a booking whose pickup has already passed is legitimate.
        { now: Date.now(), allowPastPickup: true },
      );

      if (dateProblems.length > 0) {
        throw new HttpsError('invalid-argument', DATE_PROBLEM_MESSAGES[dateProblems[0]!]);
      }

      const conflicts = findConflicts(
        dresses.map((dress) => ({
          dressId: dress.id,
          dressCode: dress.code,
          dressName: dress.name,
          dressStatus: dress.status,
          pickupAt,
          returnAt,
          cleaningBufferDays: dress.cleaningBufferDays,
          excludeReservationId: reservationId,
        })),
        blocks,
      );

      if (conflicts.length > 0) {
        // The original reservation is left exactly as it was.
        return {
          success: false as const,
          reason: 'DRESS_UNAVAILABLE' as const,
          conflicts: conflicts.map(toConflictDetail),
        };
      }

      transaction.update(reservationRef, {
        pickupAt: Timestamp.fromMillis(pickupAt),
        returnAt: Timestamp.fromMillis(returnAt),
        eventDate: eventAt === null ? '' : toMuscatDate(eventAt),
        eventAt: eventAt === null ? null : Timestamp.fromMillis(eventAt),
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: actor.uid,
      });

      for (const document of itemsSnapshot.docs) {
        const dressId = String(document.data()['dressId']);
        const dress = dresses.find((candidate) => candidate.id === dressId);
        const buffer = dress?.cleaningBufferDays ?? DEFAULT_BUFFER_DAYS;
        const interval = blockedInterval(pickupAt, returnAt, buffer);

        transaction.update(document.ref, {
          pickupAt: Timestamp.fromMillis(pickupAt),
          returnAt: Timestamp.fromMillis(returnAt),
          blockStartAt: Timestamp.fromMillis(interval.start),
          blockEndAt: Timestamp.fromMillis(interval.end),
        });
      }

      writeAudit(transaction, {
        actorUid: actor.uid,
        actorName: actor.name,
        actorRole: actor.role,
        action: 'reservation.dates_changed',
        entityType: 'reservation',
        entityId: reservationId,
        before: {
          pickupAt: toMillis(reservation['pickupAt']),
          returnAt: toMillis(reservation['returnAt']),
        },
        after: { pickupAt, returnAt },
      });

      return {
        success: true as const,
        reservationId,
        reservationNumber: String(reservation['code'] ?? ''),
        conflicts: [] as ConflictDetail[],
      };
    });
  },
);

/* ------------------------------------------------------------------------ *
 * changeReservationStatus
 * ------------------------------------------------------------------------ */

/**
 * Move a reservation through its lifecycle, updating the dress with it.
 *
 * The transition table is the shared domain one, so the interface offers
 * exactly what the server accepts. Dress status follows the reservation, and
 * never overwrites an operational state.
 */
export const changeReservationStatus = onCall(
  async (request: CallableRequest<StatusChangeRequest>) => {
    const actor = await requireEmployee(request);
    const data = request.data ?? ({} as StatusChangeRequest);

    enforce(validateStatusChangeRequest(data));

    const reservationId = data.reservationId as string;
    const target = data.status;

    if (!isReservationStatus(target)) {
      throw new HttpsError('invalid-argument', 'That is not a valid reservation status.');
    }

    const reason = typeof data.reason === 'string' ? data.reason.trim() : '';

    return db().runTransaction(async (transaction) => {
      const reservationRef = db().doc(`reservations/${reservationId}`);
      const reservationSnapshot = await transaction.get(reservationRef);

      if (!reservationSnapshot.exists) {
        throw new HttpsError('not-found', 'That reservation no longer exists.');
      }

      const reservation = reservationSnapshot.data() ?? {};
      const from = reservation['status'];

      if (!isReservationStatus(from)) {
        throw new HttpsError('failed-precondition', 'This reservation has an unrecognised status.');
      }

      const refusal = refuseStatusChange(from, target);
      if (refusal !== null) {
        throw new HttpsError('failed-precondition', TRANSITION_REFUSAL_MESSAGES[refusal]);
      }

      const itemsSnapshot = await transaction.get(
        db().collection('reservationItems').where('reservationId', '==', reservationId),
      );

      const dressIds = itemsSnapshot.docs.map((document) => String(document.data()['dressId']));
      const dressSnapshots = await transaction.getAll(
        ...dressIds.map((id) => db().doc(`dresses/${id}`)),
      );

      const now = Date.now();
      const nowBlocking = statusBlocks(target);

      /*
       * When a reservation stops blocking, the dress only returns to Available
       * if nothing else holds it — so every other blocking item for that dress
       * has to be read before deciding.
       */
      const otherBlocks = nowBlocking ? [] : await readBlocks(transaction, dressIds, now);

      transaction.update(reservationRef, {
        status: target,
        ...(target === 'Returned' ? { actualReturnAt: FieldValue.serverTimestamp() } : {}),
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: actor.uid,
      });

      for (const document of itemsSnapshot.docs) {
        transaction.update(document.ref, { blocking: nowBlocking });
      }

      for (const [index, snapshot] of dressSnapshots.entries()) {
        if (!snapshot.exists) continue;

        const dressId = dressIds[index]!;
        const dress = toLoadedDress(dressId, snapshot.data());

        const nextStatus = nowBlocking
          ? dressStatusForTransition(dress.status, target)
          : dressStatusAfterRelease(
              dress.status,
              hasOtherActiveHold(otherBlocks, reservationId, now),
            );

        if (nextStatus === null) continue;

        transaction.update(snapshot.ref, {
          status: nextStatus,
          bookingVersion: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: actor.uid,
        });

        writeAudit(transaction, {
          actorUid: actor.uid,
          actorName: actor.name,
          actorRole: actor.role,
          action: 'dress.status_changed',
          entityType: 'dress',
          entityId: dressId,
          before: { status: dress.status },
          after: { status: nextStatus },
          reason: `Reservation ${String(reservation['code'] ?? '')} → ${target}`,
        });
      }

      writeAudit(transaction, {
        actorUid: actor.uid,
        actorName: actor.name,
        actorRole: actor.role,
        action: 'reservation.status_changed',
        entityType: 'reservation',
        entityId: reservationId,
        before: { status: from },
        after: { status: target },
        reason: reason.length > 0 ? reason : undefined,
      });

      return { success: true as const, reservationId, status: target };
    });
  },
);

/* ------------------------------------------------------------------------ *
 * releaseCleanedDresses
 * ------------------------------------------------------------------------ */

/**
 * Return dresses to the rail once their cleaning buffer has expired.
 *
 * A dress does not become available the instant it is returned — it becomes
 * available when the buffer runs out, which is a moment no user action
 * coincides with. This sweeps for those.
 *
 * Idempotent, and safe to call as often as you like. Only ever moves
 * `In Cleaning → Available`, so a gown that was sent for repair while in the
 * wash keeps its operational status.
 */
export const releaseCleanedDresses = onCall(async (request: CallableRequest<unknown>) => {
  await requireEmployee(request);

  const now = Date.now();

  const cleaning = await db()
    .collection('dresses')
    .where('status', '==', 'In Cleaning')
    .limit(200)
    .get();

  let released = 0;

  for (const dressDoc of cleaning.docs) {
    const stillBlocked = await db()
      .collection('reservationItems')
      .where('dressId', '==', dressDoc.id)
      .where('blocking', '==', true)
      .where('blockEndAt', '>', Timestamp.fromMillis(now))
      .limit(1)
      .get();

    if (!stillBlocked.empty) continue;

    await dressDoc.ref.update({
      status: 'Available',
      bookingVersion: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });

    released += 1;
  }

  if (released > 0) {
    logger.info('Released cleaned dresses', { released });
  }

  return { released };
});

/* ------------------------------------------------------------------------ *
 * checkAvailability — read-only, for the booking screen
 * ------------------------------------------------------------------------ */

interface CheckAvailabilityRequest {
  readonly dressIds?: unknown;
  readonly pickupAt?: unknown;
  readonly returnAt?: unknown;
  readonly excludeReservationId?: unknown;
}

/**
 * Report availability without booking anything.
 *
 * Purely advisory: it tells the employee what to expect while they fill in the
 * form. The answer can be stale by the time they save, which is why
 * `createReservation` re-checks inside its transaction and is the only thing
 * that decides.
 */
export const checkAvailability = onCall(
  async (request: CallableRequest<CheckAvailabilityRequest>) => {
    await requireEmployee(request);
    const data = request.data ?? {};

    if (!Array.isArray(data.dressIds) || data.dressIds.length === 0) {
      throw new HttpsError('invalid-argument', 'Select at least one dress.');
    }
    if (typeof data.pickupAt !== 'string' || typeof data.returnAt !== 'string') {
      throw new HttpsError('invalid-argument', 'Pickup and return date/time are required.');
    }

    let pickupAt: number;
    let returnAt: number;

    try {
      pickupAt = fromMuscatWallTime(data.pickupAt);
      returnAt = fromMuscatWallTime(data.returnAt);
    } catch (error) {
      throw new HttpsError('invalid-argument', (error as Error).message);
    }

    const dressIds = data.dressIds as string[];

    const dressSnapshots = await db().getAll(...dressIds.map((id) => db().doc(`dresses/${id}`)));
    const dresses = dressSnapshots.map((snapshot, index) =>
      toLoadedDress(dressIds[index]!, snapshot.exists ? snapshot.data() : undefined),
    );

    const blocks: ExistingBlock[] = [];

    for (const dressId of dressIds) {
      const snapshot = await db()
        .collection('reservationItems')
        .where('dressId', '==', dressId)
        .where('blocking', '==', true)
        .where('blockEndAt', '>', Timestamp.fromMillis(pickupAt))
        .get();

      for (const document of snapshot.docs) {
        const item = document.data();
        blocks.push({
          itemId: document.id,
          reservationId: String(item['reservationId'] ?? ''),
          reservationCode: String(item['reservationCode'] ?? ''),
          dressId: String(item['dressId'] ?? ''),
          pickupAt: toMillis(item['pickupAt']),
          returnAt: toMillis(item['returnAt']),
          blockStartAt: toMillis(item['blockStartAt']),
          blockEndAt: toMillis(item['blockEndAt']),
          blocking: item['blocking'] === true,
        });
      }
    }

    const conflicts = findConflicts(
      dresses.map((dress) => ({
        dressId: dress.id,
        dressCode: dress.code,
        dressName: dress.name,
        dressStatus: dress.status,
        pickupAt,
        returnAt,
        cleaningBufferDays: dress.cleaningBufferDays,
        excludeReservationId:
          typeof data.excludeReservationId === 'string' ? data.excludeReservationId : undefined,
      })),
      blocks,
    );

    return {
      available: conflicts.length === 0,
      conflicts: conflicts.map(toConflictDetail),
    };
  },
);
