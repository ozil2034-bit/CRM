/**
 * Money — the application layer.
 *
 * Reads come from Firestore; **every write goes through a Cloud Function**.
 * There is deliberately no function here that writes a financial event, and the
 * rules refuse it too, so the Function is not merely the convenient path — it is
 * the only one.
 *
 * The position shown on screen is computed by `reduceLedger`, the same function
 * the server runs. That is the point of keeping the domain shared: the balance
 * an employee reads to a customer is the balance the server will enforce.
 */

import {
  collection,
  doc,
  onSnapshot,
  query,
  Timestamp,
  where,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

import { getFirebaseClient } from '@/lib/firebase/client';
import { baisa, type Baisa } from '@/domain/money';
import {
  isFinancialEventKind,
  isPaymentMethod,
  isPaymentType,
  reduceLedger,
  type FinancialEvent,
  type FinancialPosition,
  type PaymentMethod,
  type PaymentType,
} from '@/domain/ledger';
import type { PricingSnapshot } from '@/domain/reservation-pricing';
import type { EpochMs } from '@/domain/datetime';

export class PaymentServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PaymentServiceError';
    this.code = code;
  }
}

function db(): Firestore {
  return getFirebaseClient().db;
}

const EVENTS = 'financialEvents';

const millis = (value: unknown): EpochMs =>
  value instanceof Timestamp ? value.toMillis() : typeof value === 'number' ? value : 0;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const int = (value: unknown): Baisa =>
  typeof value === 'number' && Number.isInteger(value) ? baisa(value) : baisa(0);

/* ------------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------------ */

/** An event as displayed, carrying the employee's name for the statement. */
export interface DisplayEvent extends FinancialEvent {
  readonly employeeName: string;
  readonly reservationCode: string;
  readonly snapshot: Record<string, unknown> | null;
}

function toEvent(snapshot: QueryDocumentSnapshot): DisplayEvent {
  const data = snapshot.data();
  const kind = data['kind'];

  return {
    id: snapshot.id,
    reservationId: str(data['reservationId']),
    reservationCode: str(data['reservationCode']),
    /*
     * An unrecognised kind is shown as a charge waiver rather than a payment.
     * If corrupt data ever arrives, understating what the boutique has been
     * paid is the safe direction to be wrong in — overstating it would have an
     * employee tell a customer they owe nothing.
     */
    kind: isFinancialEventKind(kind) ? kind : 'ChargeWaiver',
    amount: int(data['amount']),
    method: isPaymentMethod(data['method']) ? data['method'] : null,
    type: isPaymentType(data['type']) ? data['type'] : null,
    occurredAt: millis(data['occurredAt']),
    reference: str(data['reference']),
    reason: str(data['reason']),
    employeeId: str(data['employeeId']),
    employeeName: str(data['employeeName']),
    reversesEventId:
      (data['reversesEventId'] ?? null) === null ? null : str(data['reversesEventId']),
    idempotencyKey: str(data['idempotencyKey']),
    snapshot: (data['snapshot'] ?? null) as Record<string, unknown> | null,
  };
}

/**
 * Watch one reservation's ledger.
 *
 * Ordered on the client rather than in the query, so an event written moments
 * ago — whose server timestamp has not landed yet — still appears rather than
 * being dropped from an `orderBy` until the round trip completes.
 */
export function observeFinancialEvents(
  reservationId: string,
  onChange: (events: DisplayEvent[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    query(collection(db(), EVENTS), where('reservationId', '==', reservationId)),
    (snapshot) => onChange(snapshot.docs.map(toEvent).sort((a, b) => a.occurredAt - b.occurredAt)),
    onError,
  );
}

/**
 * Every event in the boutique, grouped by reservation.
 *
 * One listener for the whole ledger, because the dashboard needs a balance for
 * every live booking and forty per-reservation queries would be forty round
 * trips. See `operations.service.ts` for the scale this assumes and what to
 * change when it no longer holds.
 */
export function observeFinancialEventsForAll(
  onChange: (byReservation: Map<string, DisplayEvent[]>) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    collection(db(), EVENTS),
    (snapshot) => {
      const grouped = new Map<string, DisplayEvent[]>();

      for (const document of snapshot.docs) {
        const event = toEvent(document);
        const bucket = grouped.get(event.reservationId);

        if (bucket === undefined) {
          grouped.set(event.reservationId, [event]);
        } else {
          bucket.push(event);
        }
      }

      for (const bucket of grouped.values()) {
        bucket.sort((a, b) => a.occurredAt - b.occurredAt);
      }

      onChange(grouped);
    },
    onError,
  );
}

/**
 * The reservation's financial position.
 *
 * Derived, never stored. A stored balance is a cache that goes stale the moment
 * an event is appended, and a stale balance is how a customer gets asked to pay
 * twice.
 */
export function positionOf(
  pricing: PricingSnapshot,
  events: readonly FinancialEvent[],
): FinancialPosition {
  return reduceLedger(pricing, events);
}

/* ------------------------------------------------------------------------ *
 * Idempotency
 * ------------------------------------------------------------------------ */

/**
 * A key for one financial intent, generated when the form opens.
 *
 * The same key travels with every retry of that one intent — a double click, a
 * resubmission after a timeout, a replayed request — and the server uses it as
 * the event's document id, so all of them converge on a single event. Generating
 * it at submission time instead would give each retry its own key and defeat the
 * entire mechanism.
 *
 * Restricted to the characters a Firestore document id accepts.
 */
export function newIdempotencyKey(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

  return uuid.replace(/[^A-Za-z0-9_-]/g, '');
}

/* ------------------------------------------------------------------------ *
 * Trusted operations
 * ------------------------------------------------------------------------ */

export interface PostResult {
  readonly success: boolean;
  readonly eventId: string;
  /** True when this request had already been handled and nothing new was posted. */
  readonly duplicate: boolean;
  readonly outstanding: number;
  readonly depositHeld: number;
  readonly status: string;
}

function callable<Request, Response>(name: string) {
  return httpsCallable<Request, Response>(getFirebaseClient().functions, name);
}

/**
 * Financial writes require a connection, deliberately.
 *
 * Whether a payment is permitted depends on the balance now, so a payment
 * queued offline could be committed hours later against a reservation that has
 * since been refunded or cancelled. Nothing is stored for later; the employee is
 * told plainly and records it when the connection returns.
 */
function requireConnection(): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new PaymentServiceError(
      'offline',
      'An internet connection is required to record money. Nothing has been saved.',
    );
  }
}

async function post<Request>(name: string, input: Request): Promise<PostResult> {
  requireConnection();

  try {
    const result = await callable<Request, PostResult>(name)(input);
    return result.data;
  } catch (error) {
    throw toPaymentError(error);
  }
}

export interface RecordPaymentInput {
  readonly reservationId: string;
  readonly amount: Baisa;
  readonly method: PaymentMethod;
  readonly type: PaymentType;
  readonly reference: string;
  /** Boutique wall time, `YYYY-MM-DDTHH:MM`. Omitted means now. */
  readonly occurredAt?: string;
  readonly idempotencyKey: string;
}

export function recordPayment(input: RecordPaymentInput): Promise<PostResult> {
  return post('recordPayment', input);
}

export interface RecordDepositInput {
  readonly reservationId: string;
  readonly amount: Baisa;
  readonly method: PaymentMethod;
  readonly reference: string;
  readonly occurredAt?: string;
  readonly idempotencyKey: string;
}

export function recordSecurityDeposit(input: RecordDepositInput): Promise<PostResult> {
  return post('recordSecurityDeposit', input);
}

export interface RefundInput {
  readonly reservationId: string;
  readonly amount: Baisa;
  readonly method: PaymentMethod;
  readonly reference: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export function refundPayment(input: RefundInput): Promise<PostResult> {
  return post('refundPayment', input);
}

export interface ReversalInput {
  readonly reservationId: string;
  readonly eventId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export function reversePayment(input: ReversalInput): Promise<PostResult> {
  return post('reversePayment', input);
}

export interface SettleDepositInput {
  readonly reservationId: string;
  readonly amount: Baisa;
  /** `true` keeps the money against damage; `false` returns it. */
  readonly forfeit: boolean;
  readonly reason: string;
  readonly method?: PaymentMethod;
  readonly reference?: string;
  readonly idempotencyKey: string;
}

export function settleDeposit(input: SettleDepositInput): Promise<PostResult> {
  return post('settleDeposit', input);
}

export interface LateFeeInput {
  readonly reservationId: string;
  /** Boutique wall time the gown actually came back. */
  readonly actualReturnAt: string;
  readonly idempotencyKey: string;
}

export function postLateFee(input: LateFeeInput): Promise<PostResult> {
  return post('postLateFee', input);
}

export interface CancellationQuoteResult {
  readonly daysOfNotice: number;
  readonly refundPercent: number;
  readonly tierLabel: { en: string; ar: string } | null;
  readonly chargesBeforeCancellation: number;
  readonly cancellationCharge: number;
  readonly waivedCharges: number;
  readonly paidBeforeCancellation: number;
  readonly rentalRefundDue: number;
  readonly stillOwed: number;
  readonly depositRefundDue: number;
  readonly totalRefundDue: number;
}

/** What cancelling would cost. Read-only — nothing is posted. */
export async function quoteCancellation(reservationId: string): Promise<CancellationQuoteResult> {
  try {
    const result = await callable<{ reservationId: string }, CancellationQuoteResult>(
      'quoteCancellationFor',
    )({ reservationId });
    return result.data;
  } catch (error) {
    throw toPaymentError(error);
  }
}

export function cancelReservationFinancially(input: {
  readonly reservationId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}): Promise<PostResult> {
  return post('cancelReservationFinancially', input);
}

/* ------------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------------ */

const MESSAGES: Record<string, string> = {
  'functions/unauthenticated': 'Sign in and try again.',
  'functions/permission-denied': 'You do not have permission to do that.',
  'functions/not-found': 'That record no longer exists.',
  'functions/unavailable': 'An internet connection is required to record money.',
};

function toPaymentError(error: unknown): PaymentServiceError {
  if (error instanceof PaymentServiceError) return error;

  const code = (error as { code?: string }).code ?? 'unknown';

  /*
   * `failed-precondition` and `invalid-argument` carry the domain's own refusal
   * message — "That is more than the outstanding balance" — which is far more
   * use than a generic line. They are passed through rather than replaced.
   */
  const message =
    MESSAGES[code] ?? (error as { message?: string }).message ?? 'That could not be recorded.';

  return new PaymentServiceError(code, message);
}

/**
 * The configured share of the rental that must be paid before collection.
 *
 * Defaults to **100%** when unset — the strict direction. A missing setting
 * must not let a gown leave the shop for nothing, so an absent or malformed
 * value fails closed rather than open.
 */
export function observePickupThreshold(
  onChange: (percent: number) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db(), 'settings', 'app'),
    (snapshot) => {
      const value = snapshot.data()?.['minPickupPaymentPercent'];
      onChange(
        typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
          ? value
          : 100,
      );
    },
    onError,
  );
}

/** Reference the reservation document, for screens that need its id. */
export function reservationRef(reservationId: string) {
  return doc(db(), 'reservations', reservationId);
}
