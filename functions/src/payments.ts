/**
 * Money — the trusted server-side operations.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY EVERY FINANCIAL WRITE RUNS HERE
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A balance is not a stored number; it is a reduction over every event ever
 * posted against a reservation. Deciding whether a payment is permitted means
 * reading that whole event list and then writing based on the answer — the same
 * read-then-write shape as booking, and the same reason the client SDK cannot
 * do it: it cannot read a query inside a transaction.
 *
 * A browser that computes "outstanding: 110.000" and then posts 110.000 is
 * working from a figure that may be seconds stale. Two employees at two tills
 * both see the same balance and both take it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE QUERY ALONE IS NOT ENOUGH — AGAIN
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A transactional query locks the documents it *returns*. Two simultaneous
 * payments against a reservation with no events yet both read an empty list,
 * both conclude the full balance is outstanding, and both commit. The
 * reservation ends up doubly paid with neither transaction ever conflicting.
 *
 * So every financial transaction **reads and writes the reservation document**,
 * incrementing `financialVersion`. Concurrent financial operations on one
 * reservation become a write-write conflict that Firestore aborts and retries;
 * the loser re-reads the ledger, now sees the winner's event, and is judged
 * against the true balance. Operations on *different* reservations touch
 * different documents and run in parallel.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IDEMPOTENCY
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The client generates a key when the form opens. That key **is** the event's
 * document id, so a duplicate submission is not a race to detect — it is a
 * document that already exists. The transaction reads it first and, if present,
 * returns the original outcome without posting anything. A double click, a
 * retry after a timeout and a replayed request all converge on one event.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * APPEND-ONLY
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Nothing here updates or deletes a financial event. A mistake is corrected by
 * appending an event that offsets it. The rules refuse client writes entirely,
 * and refuse update and delete to every role including the owner.
 */

import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore';

import { callerFrom, db, readProfile, writeAudit } from './lib/firestore';
import { effectiveRole } from './lib/guards';

import {
  reduceLedger,
  isPaymentMethod,
  isPaymentType,
  type FinancialEvent,
  type FinancialEventKind,
  type FinancialPosition,
  type PaymentMethod,
  type PaymentType,
} from '../../src/domain/ledger';
import {
  isUsableIdempotencyKey,
  refuseDepositPayment,
  refuseDepositSettlement,
  refusePayment,
  refuseRefund,
  refuseReversal,
  DEPOSIT_PAYMENT_REFUSAL_MESSAGES,
  DEPOSIT_SETTLEMENT_REFUSAL_MESSAGES,
  PAYMENT_REFUSAL_MESSAGES,
  REFUND_REFUSAL_MESSAGES,
  REVERSAL_REFUSAL_MESSAGES,
} from '../../src/domain/financial-operations';
import { computeLateFee, isChargeable } from '../../src/domain/late-fee';
import { quoteCancellation, type CancellationTier } from '../../src/domain/cancellation';
import type { PricingSnapshot } from '../../src/domain/reservation-pricing';
import { baisa, type Baisa } from '../../src/domain/money';
import { fromMuscatWallTime } from '../../src/domain/datetime';

/* ------------------------------------------------------------------------ *
 * Callers
 * ------------------------------------------------------------------------ */

interface Actor {
  readonly uid: string;
  readonly name: string;
  readonly role: 'OWNER' | 'STAFF';
}

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

/**
 * Money leaving the till, and corrections to posted history, need the owner.
 *
 * Staff record payments — refusing that would stop the shop working. Refunds,
 * forfeitures and reversals are the operations that could be used to conceal a
 * shortfall, and separating them is the ordinary control any boutique keeps
 * over its own cash.
 */
async function requireOwnerActor(request: CallableRequest<unknown>): Promise<Actor> {
  const actor = await requireEmployee(request);

  if (actor.role !== 'OWNER') {
    throw new HttpsError(
      'permission-denied',
      'Only the owner may refund, reverse or forfeit. Ask the owner to approve this.',
    );
  }

  return actor;
}

/* ------------------------------------------------------------------------ *
 * Loading a reservation's financial state, inside a transaction
 * ------------------------------------------------------------------------ */

const EVENTS = 'financialEvents';

interface LoadedReservation {
  readonly id: string;
  readonly code: string;
  readonly customerId: string;
  readonly status: string;
  readonly pricing: PricingSnapshot;
  readonly returnAt: number;
  readonly eventDate: string;
  readonly events: readonly FinancialEvent[];
  readonly position: FinancialPosition;
}

function toEvent(id: string, data: FirebaseFirestore.DocumentData): FinancialEvent {
  const at = data['occurredAt'];

  return {
    id,
    reservationId: String(data['reservationId'] ?? ''),
    kind: data['kind'] as FinancialEventKind,
    amount: baisa(Number(data['amount'] ?? 0)),
    method: isPaymentMethod(data['method']) ? data['method'] : null,
    type: isPaymentType(data['type']) ? data['type'] : null,
    occurredAt: at instanceof Timestamp ? at.toMillis() : 0,
    reference: String(data['reference'] ?? ''),
    reason: String(data['reason'] ?? ''),
    employeeId: String(data['employeeId'] ?? ''),
    reversesEventId:
      (data['reversesEventId'] ?? null) === null ? null : String(data['reversesEventId']),
    idempotencyKey: String(data['idempotencyKey'] ?? ''),
  };
}

function readPricing(data: FirebaseFirestore.DocumentData | undefined): PricingSnapshot {
  const pricing = (data?.['pricing'] ?? {}) as Record<string, unknown>;
  const int = (value: unknown): Baisa =>
    typeof value === 'number' && Number.isInteger(value) ? baisa(value) : baisa(0);

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

/**
 * Read the reservation and its whole event list inside the transaction.
 *
 * The reservation document is read here and written by the caller, which is
 * what serialises concurrent financial operations on one booking.
 */
async function loadForUpdate(
  transaction: Transaction,
  reservationId: string,
): Promise<LoadedReservation> {
  const reservationRef = db().doc(`reservations/${reservationId}`);
  const snapshot = await transaction.get(reservationRef);

  if (!snapshot.exists) {
    throw new HttpsError('not-found', 'That reservation no longer exists.');
  }

  const data = snapshot.data() ?? {};

  const eventsSnapshot = await transaction.get(
    db().collection(EVENTS).where('reservationId', '==', reservationId),
  );

  const events = eventsSnapshot.docs.map((document) => toEvent(document.id, document.data()));
  const pricing = readPricing(data);
  const returnAt = data['returnAt'];

  return {
    id: reservationId,
    code: String(data['code'] ?? ''),
    customerId: String(data['customerId'] ?? ''),
    status: String(data['status'] ?? ''),
    pricing,
    returnAt: returnAt instanceof Timestamp ? returnAt.toMillis() : 0,
    eventDate: String(data['eventDate'] ?? ''),
    events,
    position: reduceLedger(pricing, events),
  };
}

/**
 * Take the lock that serialises financial work on this reservation.
 *
 * Called by every mutating operation, after `loadForUpdate` has read the
 * document. Without the write, two concurrent transactions on one reservation
 * never conflict and both commit against the same stale balance.
 */
function bumpFinancialVersion(transaction: Transaction, reservationId: string, uid: string): void {
  transaction.update(db().doc(`reservations/${reservationId}`), {
    financialVersion: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: uid,
  });
}

/* ------------------------------------------------------------------------ *
 * Posting an event
 * ------------------------------------------------------------------------ */

interface PostInput {
  readonly reservationId: string;
  readonly reservationCode: string;
  readonly customerId: string;
  readonly kind: FinancialEventKind;
  readonly amount: Baisa;
  readonly method: PaymentMethod | null;
  readonly type: PaymentType | null;
  readonly occurredAt: number;
  readonly reference: string;
  readonly reason: string;
  readonly reversesEventId: string | null;
  readonly idempotencyKey: string;
  readonly actor: Actor;
  /** Extra frozen detail, e.g. the late-fee or cancellation calculation. */
  readonly snapshot?: Record<string, unknown>;
}

function eventRefFor(key: string) {
  return db().doc(`${EVENTS}/${key}`);
}

function postEvent(transaction: Transaction, input: PostInput): void {
  transaction.create(eventRefFor(input.idempotencyKey), {
    reservationId: input.reservationId,
    reservationCode: input.reservationCode,
    customerId: input.customerId,
    kind: input.kind,
    amount: input.amount,
    method: input.method,
    type: input.type,
    occurredAt: Timestamp.fromMillis(input.occurredAt),
    reference: input.reference,
    reason: input.reason,
    employeeId: input.actor.uid,
    employeeName: input.actor.name,
    reversesEventId: input.reversesEventId,
    idempotencyKey: input.idempotencyKey,
    ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
    createdAt: FieldValue.serverTimestamp(),
    createdBy: input.actor.uid,
  });
}

/**
 * Has this exact request already been handled?
 *
 * Read first, inside the transaction. A duplicate returns the original outcome
 * rather than failing: a retry after a network timeout is not an error, and
 * telling the employee "already recorded" when their payment did go through
 * would send them to record it a second time.
 */
async function alreadyPosted(transaction: Transaction, idempotencyKey: string): Promise<boolean> {
  const existing = await transaction.get(eventRefFor(idempotencyKey));
  return existing.exists;
}

function requireKey(value: unknown): string {
  if (!isUsableIdempotencyKey(value)) {
    throw new HttpsError(
      'invalid-argument',
      'A request key is required so a retry cannot post the same amount twice.',
    );
  }

  // The key becomes a document id, so it must be a safe one.
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(value)) {
    throw new HttpsError('invalid-argument', 'The request key contains unsupported characters.');
  }

  return value;
}

function requireReservationId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('/')) {
    throw new HttpsError('invalid-argument', 'A reservation is required.');
  }
  return value;
}

function occurredAtFrom(value: unknown): number {
  if (value === undefined || value === null || value === '') return Date.now();

  if (typeof value !== 'string') {
    throw new HttpsError('invalid-argument', 'The payment date is not valid.');
  }

  try {
    return fromMuscatWallTime(value);
  } catch {
    throw new HttpsError('invalid-argument', 'The payment date is not valid.');
  }
}

/**
 * The client sends an amount; the server never takes it on trust.
 *
 * Parsed to a whole number of baisa here and validated against the position the
 * server computed, not the one the browser displayed.
 */
function amountFrom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpsError('invalid-argument', 'The amount is not valid.');
  }
  return value;
}

/* ------------------------------------------------------------------------ *
 * recordPayment
 * ------------------------------------------------------------------------ */

interface PaymentRequest {
  readonly reservationId?: unknown;
  readonly amount?: unknown;
  readonly method?: unknown;
  readonly type?: unknown;
  readonly reference?: unknown;
  readonly occurredAt?: unknown;
  readonly idempotencyKey?: unknown;
}

export interface PostResult {
  readonly success: boolean;
  readonly eventId: string;
  readonly duplicate: boolean;
  readonly outstanding: number;
  readonly depositHeld: number;
  readonly status: string;
}

/** Record money received against the rental account. */
export const recordPayment = onCall(async (request: CallableRequest<PaymentRequest>) => {
  const actor = await requireEmployee(request);
  const data = request.data ?? {};

  const reservationId = requireReservationId(data.reservationId);
  const idempotencyKey = requireKey(data.idempotencyKey);
  const amount = amountFrom(data.amount);
  const occurredAt = occurredAtFrom(data.occurredAt);

  if (!isPaymentMethod(data.method)) {
    throw new HttpsError('invalid-argument', 'Choose how the payment was made.');
  }
  if (!isPaymentType(data.type)) {
    throw new HttpsError('invalid-argument', 'Choose the kind of payment.');
  }

  const method = data.method;
  const type = data.type;

  return db().runTransaction(async (transaction): Promise<PostResult> => {
    if (await alreadyPosted(transaction, idempotencyKey)) {
      const loaded = await loadForUpdate(transaction, reservationId);
      return duplicateResult(idempotencyKey, loaded.position);
    }

    const loaded = await loadForUpdate(transaction, reservationId);

    const refusal = refusePayment(amount, loaded.position);
    if (refusal !== null) {
      throw new HttpsError('failed-precondition', PAYMENT_REFUSAL_MESSAGES[refusal]);
    }

    postEvent(transaction, {
      reservationId,
      reservationCode: loaded.code,
      customerId: loaded.customerId,
      kind: 'Payment',
      amount: baisa(amount),
      method,
      type,
      occurredAt,
      reference: String(data.reference ?? ''),
      reason: '',
      reversesEventId: null,
      idempotencyKey,
      actor,
    });

    bumpFinancialVersion(transaction, reservationId, actor.uid);

    writeAudit(transaction, {
      actorUid: actor.uid,
      actorName: actor.name,
      actorRole: actor.role,
      action: 'payment.recorded',
      entityType: 'reservation',
      entityId: reservationId,
      entityCode: loaded.code,
      before: null,
      after: { kind: 'Payment', amount, method, type },
    });

    return resultAfter(idempotencyKey, loaded, [
      syntheticEvent('Payment', baisa(amount), idempotencyKey, reservationId),
    ]);
  });
});

/* ------------------------------------------------------------------------ *
 * recordSecurityDeposit
 * ------------------------------------------------------------------------ */

/**
 * Collect the security deposit.
 *
 * Separate from `recordPayment` because it is separate money: it is not
 * revenue, it is not VAT-taxable, and it does not reduce the rental balance.
 * One function taking a flag would make it far too easy to post a deposit as a
 * payment and show a reservation as settled when nothing has been paid for it.
 */
export const recordSecurityDeposit = onCall(async (request: CallableRequest<PaymentRequest>) => {
  const actor = await requireEmployee(request);
  const data = request.data ?? {};

  const reservationId = requireReservationId(data.reservationId);
  const idempotencyKey = requireKey(data.idempotencyKey);
  const amount = amountFrom(data.amount);
  const occurredAt = occurredAtFrom(data.occurredAt);

  if (!isPaymentMethod(data.method)) {
    throw new HttpsError('invalid-argument', 'Choose how the deposit was paid.');
  }
  const method = data.method;

  return db().runTransaction(async (transaction): Promise<PostResult> => {
    if (await alreadyPosted(transaction, idempotencyKey)) {
      const loaded = await loadForUpdate(transaction, reservationId);
      return duplicateResult(idempotencyKey, loaded.position);
    }

    const loaded = await loadForUpdate(transaction, reservationId);

    const refusal = refuseDepositPayment(amount, loaded.position);
    if (refusal !== null) {
      throw new HttpsError('failed-precondition', DEPOSIT_PAYMENT_REFUSAL_MESSAGES[refusal]);
    }

    postEvent(transaction, {
      reservationId,
      reservationCode: loaded.code,
      customerId: loaded.customerId,
      kind: 'SecurityDepositPayment',
      amount: baisa(amount),
      method,
      type: null,
      occurredAt,
      reference: String(data.reference ?? ''),
      reason: '',
      reversesEventId: null,
      idempotencyKey,
      actor,
    });

    bumpFinancialVersion(transaction, reservationId, actor.uid);

    writeAudit(transaction, {
      actorUid: actor.uid,
      actorName: actor.name,
      actorRole: actor.role,
      action: 'deposit.collected',
      entityType: 'reservation',
      entityId: reservationId,
      entityCode: loaded.code,
      before: null,
      after: { kind: 'SecurityDepositPayment', amount, method },
    });

    return resultAfter(idempotencyKey, loaded, [
      syntheticEvent('SecurityDepositPayment', baisa(amount), idempotencyKey, reservationId),
    ]);
  });
});

/* ------------------------------------------------------------------------ *
 * refundPayment
 * ------------------------------------------------------------------------ */

interface RefundRequest extends PaymentRequest {
  readonly reason?: unknown;
}

/**
 * Return money to the customer on the rental account.
 *
 * A refund is a **new event**, never an edit to the payment it relates to. The
 * original stays exactly as posted; the statement shows money in and money out,
 * which is what lets anyone reading it later reconstruct what happened.
 */
export const refundPayment = onCall(async (request: CallableRequest<RefundRequest>) => {
  const actor = await requireOwnerActor(request);
  const data = request.data ?? {};

  const reservationId = requireReservationId(data.reservationId);
  const idempotencyKey = requireKey(data.idempotencyKey);
  const amount = amountFrom(data.amount);
  const occurredAt = occurredAtFrom(data.occurredAt);

  if (!isPaymentMethod(data.method)) {
    throw new HttpsError('invalid-argument', 'Choose how the refund was paid.');
  }
  const method = data.method;
  const reason = String(data.reason ?? '');

  return db().runTransaction(async (transaction): Promise<PostResult> => {
    if (await alreadyPosted(transaction, idempotencyKey)) {
      const loaded = await loadForUpdate(transaction, reservationId);
      return duplicateResult(idempotencyKey, loaded.position);
    }

    const loaded = await loadForUpdate(transaction, reservationId);

    const refusal = refuseRefund(amount, loaded.position);
    if (refusal !== null) {
      throw new HttpsError('failed-precondition', REFUND_REFUSAL_MESSAGES[refusal]);
    }

    postEvent(transaction, {
      reservationId,
      reservationCode: loaded.code,
      customerId: loaded.customerId,
      kind: 'Refund',
      amount: baisa(amount),
      method,
      type: null,
      occurredAt,
      reference: String(data.reference ?? ''),
      reason,
      reversesEventId: null,
      idempotencyKey,
      actor,
    });

    bumpFinancialVersion(transaction, reservationId, actor.uid);

    writeAudit(transaction, {
      actorUid: actor.uid,
      actorName: actor.name,
      actorRole: actor.role,
      action: 'payment.refunded',
      entityType: 'reservation',
      entityId: reservationId,
      entityCode: loaded.code,
      before: null,
      after: { kind: 'Refund', amount, method },
      reason,
    });

    return resultAfter(idempotencyKey, loaded, [
      syntheticEvent('Refund', baisa(amount), idempotencyKey, reservationId),
    ]);
  });
});

/* ------------------------------------------------------------------------ *
 * reversePayment
 * ------------------------------------------------------------------------ */

interface ReversalRequest {
  readonly reservationId?: unknown;
  readonly eventId?: unknown;
  readonly reason?: unknown;
  readonly idempotencyKey?: unknown;
}

/**
 * Cancel a payment that should never have been recorded.
 *
 * Not a refund: no money moves. This is for the wrong reservation, the wrong
 * amount, or a double entry. Using it where money genuinely went back would
 * leave the balance right and the cash position wrong.
 *
 * The original event is untouched and stays visible. The pair — payment and
 * reversal — nets to zero on the statement, which is the honest record.
 */
export const reversePayment = onCall(async (request: CallableRequest<ReversalRequest>) => {
  const actor = await requireOwnerActor(request);
  const data = request.data ?? {};

  const reservationId = requireReservationId(data.reservationId);
  const idempotencyKey = requireKey(data.idempotencyKey);
  const reason = String(data.reason ?? '');

  if (typeof data.eventId !== 'string' || data.eventId.length === 0) {
    throw new HttpsError('invalid-argument', 'Choose the payment to reverse.');
  }
  const targetId = data.eventId;

  return db().runTransaction(async (transaction): Promise<PostResult> => {
    if (await alreadyPosted(transaction, idempotencyKey)) {
      const loaded = await loadForUpdate(transaction, reservationId);
      return duplicateResult(idempotencyKey, loaded.position);
    }

    const loaded = await loadForUpdate(transaction, reservationId);

    const target = loaded.events.find((event) => event.id === targetId) ?? null;
    const alreadyReversed = loaded.events.some((event) => event.reversesEventId === targetId);

    const refusal = refuseReversal({
      targetKind: target?.kind ?? null,
      alreadyReversed,
      reason,
    });

    if (refusal !== null) {
      const code = refusal === 'EVENT_NOT_FOUND' ? 'not-found' : 'failed-precondition';
      throw new HttpsError(code, REVERSAL_REFUSAL_MESSAGES[refusal]);
    }

    const reversed = target as FinancialEvent;

    postEvent(transaction, {
      reservationId,
      reservationCode: loaded.code,
      customerId: loaded.customerId,
      // A deposit payment reverses on the deposit side, a rental payment on the
      // rental side. Reversing across accounts would move money between them.
      kind: reversed.kind === 'Payment' ? 'PaymentReversal' : 'SecurityDepositRefund',
      amount: reversed.amount,
      method: reversed.method,
      type: null,
      occurredAt: Date.now(),
      reference: '',
      reason,
      reversesEventId: targetId,
      idempotencyKey,
      actor,
    });

    bumpFinancialVersion(transaction, reservationId, actor.uid);

    writeAudit(transaction, {
      actorUid: actor.uid,
      actorName: actor.name,
      actorRole: actor.role,
      action: 'payment.reversed',
      entityType: 'reservation',
      entityId: reservationId,
      entityCode: loaded.code,
      before: { eventId: targetId, kind: reversed.kind, amount: reversed.amount },
      after: null,
      reason,
    });

    return resultAfter(idempotencyKey, loaded, [
      syntheticEvent(
        reversed.kind === 'Payment' ? 'PaymentReversal' : 'SecurityDepositRefund',
        reversed.amount,
        idempotencyKey,
        reservationId,
      ),
    ]);
  });
});

/* ------------------------------------------------------------------------ *
 * settleDeposit
 * ------------------------------------------------------------------------ */

interface SettleDepositRequest {
  readonly reservationId?: unknown;
  readonly amount?: unknown;
  readonly forfeit?: unknown;
  readonly reason?: unknown;
  readonly method?: unknown;
  readonly reference?: unknown;
  readonly idempotencyKey?: unknown;
}

/**
 * Return the deposit, or keep part of it against damage.
 *
 * Both directions go through one function because they share one invariant —
 * refunded plus forfeited may never exceed what was collected — and two
 * implementations of that invariant would eventually disagree.
 *
 * Neither direction edits the original deposit event. A forfeiture is its own
 * auditable record with its own reason, which is the only defensible way to
 * keep a customer's money.
 */
export const settleDeposit = onCall(async (request: CallableRequest<SettleDepositRequest>) => {
  const actor = await requireOwnerActor(request);
  const data = request.data ?? {};

  const reservationId = requireReservationId(data.reservationId);
  const idempotencyKey = requireKey(data.idempotencyKey);
  const amount = amountFrom(data.amount);
  const forfeiting = data.forfeit === true;
  const reason = String(data.reason ?? '');

  const method: PaymentMethod = isPaymentMethod(data.method) ? data.method : 'Cash';

  return db().runTransaction(async (transaction): Promise<PostResult> => {
    if (await alreadyPosted(transaction, idempotencyKey)) {
      const loaded = await loadForUpdate(transaction, reservationId);
      return duplicateResult(idempotencyKey, loaded.position);
    }

    const loaded = await loadForUpdate(transaction, reservationId);

    const refusal = refuseDepositSettlement({
      amount,
      position: loaded.position,
      forfeiting,
      reason,
    });

    if (refusal !== null) {
      throw new HttpsError('failed-precondition', DEPOSIT_SETTLEMENT_REFUSAL_MESSAGES[refusal]);
    }

    const kind: FinancialEventKind = forfeiting
      ? 'SecurityDepositForfeiture'
      : 'SecurityDepositRefund';

    postEvent(transaction, {
      reservationId,
      reservationCode: loaded.code,
      customerId: loaded.customerId,
      kind,
      amount: baisa(amount),
      method: forfeiting ? null : method,
      type: null,
      occurredAt: Date.now(),
      reference: String(data.reference ?? ''),
      reason,
      reversesEventId: null,
      idempotencyKey,
      actor,
    });

    bumpFinancialVersion(transaction, reservationId, actor.uid);

    writeAudit(transaction, {
      actorUid: actor.uid,
      actorName: actor.name,
      actorRole: actor.role,
      action: forfeiting ? 'deposit.forfeited' : 'deposit.refunded',
      entityType: 'reservation',
      entityId: reservationId,
      entityCode: loaded.code,
      before: { depositHeld: loaded.position.depositHeld },
      after: { kind, amount },
      reason,
    });

    return resultAfter(idempotencyKey, loaded, [
      syntheticEvent(kind, baisa(amount), idempotencyKey, reservationId),
    ]);
  });
});

/* ------------------------------------------------------------------------ *
 * postLateFee
 * ------------------------------------------------------------------------ */

interface LateFeeRequest {
  readonly reservationId?: unknown;
  readonly actualReturnAt?: unknown;
  readonly idempotencyKey?: unknown;
}

/**
 * Charge for a late return.
 *
 * The rate comes from settings and the calculation is **frozen onto the event**
 * — rate, days and the instants it was computed between. Raising the daily rate
 * next month must not silently re-price a fee already agreed with a customer.
 *
 * Charged once. A second attempt on a reservation that already carries a late
 * fee is refused rather than added, because a gown is only returned late once.
 */
export const postLateFee = onCall(async (request: CallableRequest<LateFeeRequest>) => {
  const actor = await requireEmployee(request);
  const data = request.data ?? {};

  const reservationId = requireReservationId(data.reservationId);
  const idempotencyKey = requireKey(data.idempotencyKey);
  const actualReturnAt = occurredAtFrom(data.actualReturnAt);

  return db().runTransaction(async (transaction): Promise<PostResult> => {
    if (await alreadyPosted(transaction, idempotencyKey)) {
      const loaded = await loadForUpdate(transaction, reservationId);
      return duplicateResult(idempotencyKey, loaded.position);
    }

    const settingsSnapshot = await transaction.get(db().doc('settings/app'));
    const loaded = await loadForUpdate(transaction, reservationId);

    if (loaded.events.some((event) => event.kind === 'LateFee')) {
      throw new HttpsError(
        'failed-precondition',
        'A late fee has already been charged for this reservation.',
      );
    }

    const dailyRate = readLateFeeRate(settingsSnapshot.data());

    const fee = computeLateFee({
      scheduledReturnAt: loaded.returnAt,
      actualReturnAt,
      dailyRate,
      calculatedAt: Date.now(),
    });

    if (!isChargeable(fee)) {
      throw new HttpsError(
        'failed-precondition',
        fee.lateDays === 0
          ? 'This reservation was not returned late.'
          : 'No late fee is configured, so there is nothing to charge.',
      );
    }

    postEvent(transaction, {
      reservationId,
      reservationCode: loaded.code,
      customerId: loaded.customerId,
      kind: 'LateFee',
      amount: fee.amount,
      method: null,
      type: null,
      occurredAt: fee.calculatedAt,
      reference: '',
      reason: `${fee.lateDays} day(s) late`,
      reversesEventId: null,
      idempotencyKey,
      actor,
      snapshot: {
        lateDays: fee.lateDays,
        dailyRate: fee.dailyRate,
        amount: fee.amount,
        scheduledReturnAt: fee.scheduledReturnAt,
        actualReturnAt: fee.actualReturnAt,
        calculatedAt: fee.calculatedAt,
      },
    });

    bumpFinancialVersion(transaction, reservationId, actor.uid);

    writeAudit(transaction, {
      actorUid: actor.uid,
      actorName: actor.name,
      actorRole: actor.role,
      action: 'latefee.charged',
      entityType: 'reservation',
      entityId: reservationId,
      entityCode: loaded.code,
      before: null,
      after: { lateDays: fee.lateDays, dailyRate: fee.dailyRate, amount: fee.amount },
    });

    return resultAfter(idempotencyKey, loaded, [
      syntheticEvent('LateFee', fee.amount, idempotencyKey, reservationId),
    ]);
  });
});

function readLateFeeRate(settings: FirebaseFirestore.DocumentData | undefined): Baisa {
  const value = settings?.['lateFeePerDay'];
  // Absent settings mean the owner has not configured a late fee. Zero is the
  // honest default; inventing a rate would charge a customer for a rule the
  // boutique never set.
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? baisa(value)
    : baisa(0);
}

/* ------------------------------------------------------------------------ *
 * quoteCancellationFor / cancelReservationFinancially
 * ------------------------------------------------------------------------ */

interface CancellationRequest {
  readonly reservationId?: unknown;
  readonly idempotencyKey?: unknown;
  readonly reason?: unknown;
}

function readTiers(settings: FirebaseFirestore.DocumentData | undefined): CancellationTier[] {
  const raw = settings?.['cancellationTiers'];
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry): CancellationTier[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;

    const days = record['daysBeforeEvent'];
    const percent = record['refundPercent'];
    if (typeof days !== 'number' || typeof percent !== 'number') return [];

    const label = (record['label'] ?? {}) as Record<string, unknown>;

    return [
      {
        daysBeforeEvent: days,
        refundPercent: percent,
        label: { en: String(label['en'] ?? ''), ar: String(label['ar'] ?? '') },
      },
    ];
  });
}

/**
 * What would cancelling cost?
 *
 * Read-only. The employee sees the tier, the retained charge and the refund
 * before committing, so the customer can be told the figure on the telephone
 * rather than discovering it afterwards.
 */
export const quoteCancellationFor = onCall(
  async (request: CallableRequest<CancellationRequest>) => {
    await requireEmployee(request);

    const reservationId = requireReservationId((request.data ?? {}).reservationId);

    return db().runTransaction(async (transaction) => {
      const settingsSnapshot = await transaction.get(db().doc('settings/app'));
      const loaded = await loadForUpdate(transaction, reservationId);

      const quote = quoteCancellation({
        cancelledAt: Date.now(),
        eventAt: eventInstantFor(loaded),
        tiers: readTiers(settingsSnapshot.data()),
        chargesBeforeCancellation: loaded.position.totalChargeable,
        paidBeforeCancellation: loaded.position.netPaid,
        depositHeld: loaded.position.depositHeld,
      });

      return {
        daysOfNotice: quote.daysOfNotice,
        refundPercent: quote.refundPercent,
        tierLabel: quote.tier?.label ?? null,
        chargesBeforeCancellation: quote.chargesBeforeCancellation,
        cancellationCharge: quote.cancellationCharge,
        waivedCharges: quote.waivedCharges,
        paidBeforeCancellation: quote.paidBeforeCancellation,
        rentalRefundDue: quote.rentalRefundDue,
        stillOwed: quote.stillOwed,
        depositRefundDue: quote.depositRefundDue,
        totalRefundDue: quote.totalRefundDue,
      };
    });
  },
);

function eventInstantFor(loaded: LoadedReservation): number {
  // The event date is what the tiers are measured against. A reservation with
  // none falls back to the return date, which is the closest thing to it.
  if (loaded.eventDate.length > 0) {
    try {
      return fromMuscatWallTime(`${loaded.eventDate}T00:00`);
    } catch {
      return loaded.returnAt;
    }
  }
  return loaded.returnAt;
}

/**
 * Apply the financial consequences of cancelling.
 *
 * Posts a `ChargeWaiver` for the relieved portion. It does **not** pay the
 * refund: money leaving the till is a separate, deliberate act with its own
 * method and reference, recorded when it actually happens. Posting both at once
 * would record a refund the customer had not yet received.
 *
 * After the waiver, what the customer owes is exactly the cancellation charge,
 * and the refundable amount falls out of the ordinary balance arithmetic rather
 * than being computed a second way.
 */
export const cancelReservationFinancially = onCall(
  async (request: CallableRequest<CancellationRequest>) => {
    const actor = await requireOwnerActor(request);
    const data = request.data ?? {};

    const reservationId = requireReservationId(data.reservationId);
    const idempotencyKey = requireKey(data.idempotencyKey);
    const reason = String(data.reason ?? '');

    return db().runTransaction(async (transaction): Promise<PostResult> => {
      if (await alreadyPosted(transaction, idempotencyKey)) {
        const loaded = await loadForUpdate(transaction, reservationId);
        return duplicateResult(idempotencyKey, loaded.position);
      }

      const settingsSnapshot = await transaction.get(db().doc('settings/app'));
      const loaded = await loadForUpdate(transaction, reservationId);

      if (loaded.events.some((event) => event.kind === 'ChargeWaiver')) {
        throw new HttpsError(
          'failed-precondition',
          'This reservation has already been cancelled financially.',
        );
      }

      const quote = quoteCancellation({
        cancelledAt: Date.now(),
        eventAt: eventInstantFor(loaded),
        tiers: readTiers(settingsSnapshot.data()),
        chargesBeforeCancellation: loaded.position.totalChargeable,
        paidBeforeCancellation: loaded.position.netPaid,
        depositHeld: loaded.position.depositHeld,
      });

      if (quote.waivedCharges > 0) {
        postEvent(transaction, {
          reservationId,
          reservationCode: loaded.code,
          customerId: loaded.customerId,
          kind: 'ChargeWaiver',
          amount: quote.waivedCharges,
          method: null,
          type: null,
          occurredAt: quote.cancelledAt,
          reference: '',
          reason,
          reversesEventId: null,
          idempotencyKey,
          actor,
          snapshot: {
            daysOfNotice: quote.daysOfNotice,
            refundPercent: quote.refundPercent,
            tierLabel: quote.tier?.label ?? null,
            chargesBeforeCancellation: quote.chargesBeforeCancellation,
            cancellationCharge: quote.cancellationCharge,
            calculatedAt: quote.cancelledAt,
          },
        });
      }

      bumpFinancialVersion(transaction, reservationId, actor.uid);

      writeAudit(transaction, {
        actorUid: actor.uid,
        actorName: actor.name,
        actorRole: actor.role,
        action: 'reservation.cancelled_financially',
        entityType: 'reservation',
        entityId: reservationId,
        entityCode: loaded.code,
        before: { totalChargeable: loaded.position.totalChargeable },
        after: {
          cancellationCharge: quote.cancellationCharge,
          waived: quote.waivedCharges,
          refundPercent: quote.refundPercent,
        },
        reason,
      });

      return resultAfter(
        idempotencyKey,
        loaded,
        quote.waivedCharges > 0
          ? [syntheticEvent('ChargeWaiver', quote.waivedCharges, idempotencyKey, reservationId)]
          : [],
      );
    });
  },
);

/* ------------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------------ */

/**
 * The position the caller will see, computed from the events plus the one just
 * posted.
 *
 * The transaction's own write is not visible to its reads, so the new event is
 * added in memory rather than re-queried. Returning a stale balance would have
 * the interface show the payment as not yet taken.
 */
function resultAfter(
  eventId: string,
  loaded: LoadedReservation,
  added: readonly FinancialEvent[],
): PostResult {
  const position = reduceLedger(loaded.pricing, [...loaded.events, ...added]);

  return {
    success: true,
    eventId,
    duplicate: false,
    outstanding: position.outstanding,
    depositHeld: position.depositHeld,
    status: position.status,
  };
}

function duplicateResult(eventId: string, position: FinancialPosition): PostResult {
  return {
    success: true,
    eventId,
    duplicate: true,
    outstanding: position.outstanding,
    depositHeld: position.depositHeld,
    status: position.status,
  };
}

function syntheticEvent(
  kind: FinancialEventKind,
  amount: Baisa,
  id: string,
  reservationId: string,
): FinancialEvent {
  return {
    id,
    reservationId,
    kind,
    amount,
    method: null,
    type: null,
    occurredAt: Date.now(),
    reference: '',
    reason: '',
    employeeId: '',
    reversesEventId: null,
    idempotencyKey: id,
  };
}
