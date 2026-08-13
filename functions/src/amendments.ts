/**
 * Amendments — accessories and alterations added to a live reservation.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS RUNS ON THE SERVER
 * ─────────────────────────────────────────────────────────────────────────
 *
 * An amendment changes what the customer owes. Deciding whether it is permitted
 * means reading the reservation's status, its issued documents and its existing
 * lines, and then writing a new pricing snapshot based on the answer — the same
 * read-then-write shape as booking and as payment, and the same reason the
 * client SDK cannot do it: it cannot read a query inside a transaction.
 *
 * Two employees adding a veil at the same moment must not each write a snapshot
 * computed from a list that lacks the other's line. So every amendment reads and
 * writes the reservation document, incrementing `financialVersion` — the lock
 * Phase 5 established for exactly this. Concurrent amendments on one booking
 * become a write-write conflict, Firestore aborts and retries the loser, and the
 * retry reprices against a list that now contains the winner's line.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ONE PRICING ENGINE
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Nothing here does arithmetic on money. The new snapshot comes from
 * `reprice()`, which calls the same `computePricing` the booking used, with
 * every previously frozen figure passed straight back in. The balance continues
 * to come from `reduceLedger`. There is no second calculation to disagree.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IDEMPOTENCY
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The client generates a key when the dialog opens and it becomes the line's
 * own id. A duplicate submission finds a line already carrying that id and
 * returns the existing state without repricing, so a double click cannot bill a
 * bride for two veils she asked for once.
 */

import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore';

import { callerFrom, db, readProfile, writeAudit } from './lib/firestore';
import { effectiveRole } from './lib/guards';

import {
  chargeDelta,
  refuseAccessory,
  refuseAlteration,
  refuseAmendment,
  withAccessory,
  withAlteration,
  withoutAccessory,
  withoutAlteration,
  AMENDMENT_REFUSAL_MESSAGES,
  type AmendedPricing,
  type AmendmentContext,
  type AmendmentRefusal,
  type ReservationAccessory,
  type ReservationAlteration,
} from '../../src/domain/amendment';
import { isReservationStatus, type ReservationStatus } from '../../src/domain/availability';
import { isUsableIdempotencyKey } from '../../src/domain/financial-operations';
import type { PricingSnapshot, ReservationLineItem } from '../../src/domain/reservation-pricing';
import { baisa, type Baisa } from '../../src/domain/money';

const INVOICES = 'invoices';

/* ------------------------------------------------------------------------ *
 * Callers
 * ------------------------------------------------------------------------ */

interface Actor {
  readonly uid: string;
  readonly name: string;
  readonly role: 'OWNER' | 'STAFF';
}

/**
 * Staff may amend.
 *
 * Adding a veil or recording a hem is shop-floor work — the alteration is
 * discovered at the fitting, by the person doing the fitting. Requiring the
 * owner would mean either the charge goes unrecorded or the owner is
 * interrupted several times a day. Every amendment is audited with the actor's
 * name, which is the control that actually fits the workflow.
 */
async function requireEmployee(request: CallableRequest<unknown>): Promise<Actor> {
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

function refuse(refusal: AmendmentRefusal): never {
  const code =
    refusal === 'RESERVATION_FINISHED' || refusal === 'DOCUMENT_ISSUED'
      ? 'failed-precondition'
      : refusal === 'NOT_FOUND'
        ? 'not-found'
        : 'invalid-argument';

  throw new HttpsError(code, AMENDMENT_REFUSAL_MESSAGES[refusal]);
}

/* ------------------------------------------------------------------------ *
 * Reading the reservation
 * ------------------------------------------------------------------------ */

const int = (value: unknown): Baisa =>
  typeof value === 'number' && Number.isInteger(value) ? baisa(value) : baisa(0);

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function readItems(pricing: Record<string, unknown>): ReservationLineItem[] {
  const items = pricing['items'];
  if (!Array.isArray(items)) return [];

  return items.map((raw: unknown) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    return {
      dressId: str(item['dressId']),
      dressCode: str(item['dressCode']),
      dressName: str(item['dressName']),
      designer: str(item['designer']),
      rentalPrice: int(item['rentalPrice']),
      securityDeposit: int(item['securityDeposit']),
      cleaningBufferDays:
        typeof item['cleaningBufferDays'] === 'number' ? item['cleaningBufferDays'] : 3,
    };
  });
}

function readAccessories(pricing: Record<string, unknown>): ReservationAccessory[] {
  const lines = pricing['accessories'];
  if (!Array.isArray(lines)) return [];

  return lines.map((raw: unknown) => {
    const line = (raw ?? {}) as Record<string, unknown>;
    return {
      lineId: str(line['lineId']),
      accessoryId: str(line['accessoryId']),
      name: str(line['name']),
      nameAr: str(line['nameAr']),
      unitPrice: int(line['unitPrice']),
      quantity: typeof line['quantity'] === 'number' ? line['quantity'] : 1,
      securityDeposit: int(line['securityDeposit']),
    };
  });
}

function readAlterations(pricing: Record<string, unknown>): ReservationAlteration[] {
  const lines = pricing['alterations'];
  if (!Array.isArray(lines)) return [];

  return lines.map((raw: unknown) => {
    const line = (raw ?? {}) as Record<string, unknown>;
    const createdAt = line['createdAt'];

    return {
      id: str(line['id']),
      description: str(line['description']),
      descriptionAr: str(line['descriptionAr']),
      amount: int(line['amount']),
      notes: str(line['notes']),
      employeeId: str(line['employeeId']),
      employeeName: str(line['employeeName']),
      createdAt: createdAt instanceof Timestamp ? createdAt.toMillis() : 0,
    };
  });
}

function readPricing(pricing: Record<string, unknown>): PricingSnapshot {
  return {
    rentalSubtotal: int(pricing['rentalSubtotal']),
    accessorySubtotal: int(pricing['accessorySubtotal']),
    alterationSubtotal: int(pricing['alterationSubtotal']),
    discountAmount: int(pricing['discountAmount']),
    taxableSubtotal: int(pricing['taxableSubtotal']),
    vatRatePercent: typeof pricing['vatRatePercent'] === 'number' ? pricing['vatRatePercent'] : 0,
    vatAmount: int(pricing['vatAmount']),
    securityDepositTotal: int(pricing['securityDepositTotal']),
    grandTotal: int(pricing['grandTotal']),
  };
}

interface Loaded {
  readonly id: string;
  readonly code: string;
  readonly status: ReservationStatus;
  readonly before: PricingSnapshot;
  readonly context: AmendmentContext;
}

/**
 * Read everything an amendment is judged against, inside the transaction.
 *
 * The issued-document query is part of this read set on purpose: an invoice
 * issued concurrently must not slip past the check. `issueDocument` writes the
 * invoice and reads the reservation, so the two transactions contend on the
 * reservation document either way.
 */
async function loadForAmendment(
  transaction: Transaction,
  reservationId: string,
): Promise<Loaded> {
  const snapshot = await transaction.get(db().doc(`reservations/${reservationId}`));

  if (!snapshot.exists) {
    throw new HttpsError('not-found', 'That reservation no longer exists.');
  }

  const data = snapshot.data() ?? {};
  const status = data['status'];

  if (!isReservationStatus(status)) {
    throw new HttpsError('failed-precondition', 'This reservation has an unrecognised status.');
  }

  const documents = await transaction.get(
    db()
      .collection(INVOICES)
      .where('reservationId', '==', reservationId)
      .where('voided', '==', false),
  );

  const pricing = (data['pricing'] ?? {}) as Record<string, unknown>;
  const before = readPricing(pricing);

  return {
    id: reservationId,
    code: str(data['code']),
    status,
    before,
    context: {
      status,
      hasActiveDocument: !documents.empty,
      items: readItems(pricing),
      accessories: readAccessories(pricing),
      alterations: readAlterations(pricing),
      vatRatePercent: before.vatRatePercent,
      discountAmount: before.discountAmount,
    },
  };
}

/**
 * Write the repriced snapshot and take the financial lock.
 *
 * `financialVersion` is incremented for the same reason every payment
 * increments it: without a write to the reservation document, two concurrent
 * amendments never conflict and the second silently overwrites the first.
 */
function commit(
  transaction: Transaction,
  loaded: Loaded,
  amended: AmendedPricing,
  actor: Actor,
): void {
  transaction.update(db().doc(`reservations/${loaded.id}`), {
    pricing: {
      ...amended.pricing,
      items: loaded.context.items,
      accessories: amended.accessories,
      alterations: amended.alterations.map((line) => ({
        ...line,
        createdAt: Timestamp.fromMillis(line.createdAt),
      })),
    },
    financialVersion: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: actor.uid,
  });
}

function auditPayload(loaded: Loaded, amended: AmendedPricing) {
  const delta = chargeDelta(loaded.before, amended.pricing);

  return {
    before: { grandTotal: loaded.before.grandTotal },
    after: {
      grandTotal: amended.pricing.grandTotal,
      chargeDelta: delta.charges,
      depositDelta: delta.deposit,
    },
  };
}

/* ------------------------------------------------------------------------ *
 * addReservationAccessory
 * ------------------------------------------------------------------------ */

interface AddAccessoryRequest {
  readonly reservationId?: unknown;
  readonly accessoryId?: unknown;
  readonly name?: unknown;
  readonly nameAr?: unknown;
  readonly unitPrice?: unknown;
  readonly securityDeposit?: unknown;
  readonly quantity?: unknown;
  readonly idempotencyKey?: unknown;
}

/**
 * Add an accessory to a reservation at a snapshotted price.
 *
 * The price is taken from the request, not re-read from the catalogue, because
 * the employee may have agreed a different figure with the customer and because
 * the price shown when they pressed the button is the price they meant. The
 * catalogue id travels alongside so reporting can still attribute the revenue.
 */
export const addReservationAccessory = onCall(
  async (request: CallableRequest<AddAccessoryRequest>) => {
    const actor = await requireEmployee(request);
    const data = request.data ?? {};

    const reservationId = str(data.reservationId);
    if (reservationId.length === 0) {
      throw new HttpsError('invalid-argument', 'A reservation is required.');
    }

    const key = str(data.idempotencyKey);
    if (!isUsableIdempotencyKey(key)) {
      throw new HttpsError('invalid-argument', 'A valid request key is required.');
    }

    const line = {
      accessoryId: str(data.accessoryId),
      name: str(data.name),
      nameAr: str(data.nameAr),
      unitPrice: typeof data.unitPrice === 'number' ? data.unitPrice : Number.NaN,
      securityDeposit: typeof data.securityDeposit === 'number' ? data.securityDeposit : Number.NaN,
      quantity: typeof data.quantity === 'number' ? data.quantity : Number.NaN,
    };

    return db().runTransaction(async (transaction) => {
      const loaded = await loadForAmendment(transaction, reservationId);

      /*
       * Idempotency first, and before the state checks. A retry of a request
       * that already succeeded must return the same answer even if the
       * reservation has since moved to a status that would refuse a new one.
       */
      const already = loaded.context.accessories.find((existing) => existing.lineId === key);

      if (already !== undefined) {
        return { success: true as const, duplicate: true, grandTotal: loaded.before.grandTotal };
      }

      const blocked = refuseAmendment(loaded.context);
      if (blocked !== null) refuse(blocked);

      const invalid = refuseAccessory(line, loaded.context.accessories);
      if (invalid !== null) refuse(invalid);

      const amended = withAccessory(loaded.context, {
        // The request key IS the line id, so a retry is a line that already
        // exists rather than a race to detect. The catalogue id is kept
        // alongside it, so reporting can still attribute the revenue.
        lineId: key,
        accessoryId: line.accessoryId,
        name: line.name.trim(),
        nameAr: line.nameAr.trim(),
        unitPrice: baisa(line.unitPrice),
        quantity: line.quantity,
        securityDeposit: baisa(line.securityDeposit),
      });

      commit(transaction, loaded, amended, actor);

      writeAudit(transaction, {
        actorUid: actor.uid,
        actorName: actor.name,
        actorRole: actor.role,
        action: 'reservation.accessory_added',
        entityType: 'reservation',
        entityId: reservationId,
        ...auditPayload(loaded, amended),
        reason: `${line.name.trim()} ×${String(line.quantity)}`,
      });

      return {
        success: true as const,
        duplicate: false,
        grandTotal: amended.pricing.grandTotal,
      };
    });
  },
);

/* ------------------------------------------------------------------------ *
 * removeReservationAccessory
 * ------------------------------------------------------------------------ */

export const removeReservationAccessory = onCall(
  async (request: CallableRequest<{ reservationId?: unknown; lineId?: unknown }>) => {
    const actor = await requireEmployee(request);
    const data = request.data ?? {};

    const reservationId = str(data.reservationId);
    const lineId = str(data.lineId);

    if (reservationId.length === 0 || lineId.length === 0) {
      throw new HttpsError('invalid-argument', 'A reservation and a line are required.');
    }

    return db().runTransaction(async (transaction) => {
      const loaded = await loadForAmendment(transaction, reservationId);

      const blocked = refuseAmendment(loaded.context);
      if (blocked !== null) refuse(blocked);

      const removed = loaded.context.accessories.find((line) => line.lineId === lineId);
      const result = withoutAccessory(loaded.context, lineId);

      if (typeof result === 'string') refuse(result);

      commit(transaction, loaded, result, actor);

      writeAudit(transaction, {
        actorUid: actor.uid,
        actorName: actor.name,
        actorRole: actor.role,
        action: 'reservation.accessory_removed',
        entityType: 'reservation',
        entityId: reservationId,
        ...auditPayload(loaded, result),
        reason: removed?.name ?? lineId,
      });

      return { success: true as const, grandTotal: result.pricing.grandTotal };
    });
  },
);

/* ------------------------------------------------------------------------ *
 * addReservationAlteration
 * ------------------------------------------------------------------------ */

interface AddAlterationRequest {
  readonly reservationId?: unknown;
  readonly description?: unknown;
  readonly descriptionAr?: unknown;
  readonly amount?: unknown;
  readonly notes?: unknown;
  readonly idempotencyKey?: unknown;
}

/**
 * Record an alteration and what it costs.
 *
 * The employee who did the fitting and the moment they recorded it are both
 * stored, and both are frozen. An alteration billed at 15.000 in September must
 * still read 15.000 next year, whatever the boutique charges for hemming by
 * then — the historical amount is the amount the customer agreed to.
 */
export const addReservationAlteration = onCall(
  async (request: CallableRequest<AddAlterationRequest>) => {
    const actor = await requireEmployee(request);
    const data = request.data ?? {};

    const reservationId = str(data.reservationId);
    if (reservationId.length === 0) {
      throw new HttpsError('invalid-argument', 'A reservation is required.');
    }

    const key = str(data.idempotencyKey);
    if (!isUsableIdempotencyKey(key)) {
      throw new HttpsError('invalid-argument', 'A valid request key is required.');
    }

    const line = {
      description: str(data.description),
      descriptionAr: str(data.descriptionAr),
      amount: typeof data.amount === 'number' ? data.amount : Number.NaN,
      notes: str(data.notes),
    };

    const now = Date.now();

    return db().runTransaction(async (transaction) => {
      const loaded = await loadForAmendment(transaction, reservationId);

      const already = loaded.context.alterations.find((existing) => existing.id === key);
      if (already !== undefined) {
        return { success: true as const, duplicate: true, grandTotal: loaded.before.grandTotal };
      }

      const blocked = refuseAmendment(loaded.context);
      if (blocked !== null) refuse(blocked);

      const invalid = refuseAlteration(line, loaded.context.alterations);
      if (invalid !== null) refuse(invalid);

      const amended = withAlteration(loaded.context, {
        id: key,
        description: line.description.trim(),
        descriptionAr: line.descriptionAr.trim(),
        amount: baisa(line.amount),
        notes: line.notes.trim(),
        employeeId: actor.uid,
        employeeName: actor.name,
        createdAt: now,
      });

      commit(transaction, loaded, amended, actor);

      writeAudit(transaction, {
        actorUid: actor.uid,
        actorName: actor.name,
        actorRole: actor.role,
        action: 'reservation.alteration_added',
        entityType: 'reservation',
        entityId: reservationId,
        ...auditPayload(loaded, amended),
        reason: line.description.trim(),
      });

      return {
        success: true as const,
        duplicate: false,
        grandTotal: amended.pricing.grandTotal,
      };
    });
  },
);

/* ------------------------------------------------------------------------ *
 * removeReservationAlteration
 * ------------------------------------------------------------------------ */

export const removeReservationAlteration = onCall(
  async (request: CallableRequest<{ reservationId?: unknown; lineId?: unknown }>) => {
    const actor = await requireEmployee(request);
    const data = request.data ?? {};

    const reservationId = str(data.reservationId);
    const lineId = str(data.lineId);

    if (reservationId.length === 0 || lineId.length === 0) {
      throw new HttpsError('invalid-argument', 'A reservation and a line are required.');
    }

    return db().runTransaction(async (transaction) => {
      const loaded = await loadForAmendment(transaction, reservationId);

      const blocked = refuseAmendment(loaded.context);
      if (blocked !== null) refuse(blocked);

      const removed = loaded.context.alterations.find((line) => line.id === lineId);
      const result = withoutAlteration(loaded.context, lineId);

      if (typeof result === 'string') refuse(result);

      commit(transaction, loaded, result, actor);

      writeAudit(transaction, {
        actorUid: actor.uid,
        actorName: actor.name,
        actorRole: actor.role,
        action: 'reservation.alteration_removed',
        entityType: 'reservation',
        entityId: reservationId,
        ...auditPayload(loaded, result),
        reason: removed?.description ?? lineId,
      });

      return { success: true as const, grandTotal: result.pricing.grandTotal };
    });
  },
);
