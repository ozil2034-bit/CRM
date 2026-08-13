/**
 * What financial operations are permitted, and why one is refused.
 *
 * Every rule here is enforced **server-side** inside the transaction that posts
 * the event. The same functions run in the browser so a control can be disabled
 * with an explanation instead of failing on click — but the browser copy is a
 * courtesy, and the server never trusts a figure it did not compute.
 *
 * Refusals are codes, not sentences. The interface translates them; the
 * Functions log them; a test can assert the exact reason a payment was rejected
 * rather than matching on prose.
 *
 * Pure: no I/O, no clock.
 */

import { type Baisa } from './money';
import type { FinancialPosition } from './ledger';

/* ------------------------------------------------------------------------ *
 * Payments
 * ------------------------------------------------------------------------ */

export type PaymentRefusal =
  | 'AMOUNT_NOT_POSITIVE'
  | 'AMOUNT_NOT_WHOLE_BAISA'
  | 'AMOUNT_EXCEEDS_OUTSTANDING'
  | 'NOTHING_OUTSTANDING';

export const PAYMENT_REFUSAL_MESSAGES: Readonly<Record<PaymentRefusal, string>> = {
  AMOUNT_NOT_POSITIVE: 'A payment must be greater than zero.',
  AMOUNT_NOT_WHOLE_BAISA: 'A payment must be a whole number of baisa.',
  AMOUNT_EXCEEDS_OUTSTANDING: 'That is more than the outstanding balance.',
  NOTHING_OUTSTANDING: 'This reservation has nothing outstanding.',
};

/**
 * May this rental payment be recorded?
 *
 * **Overpayment is refused by default** (§17). A payment larger than the
 * balance is almost always a typing error — a extra zero, or the deposit
 * entered on the wrong tab — and accepting it creates a credit the boutique
 * then has to explain and refund. If the boutique later wants to hold credit
 * deliberately, that is a designed feature with its own event kind, not an
 * accident of a permissive validator.
 */
export function refusePayment(amount: number, position: FinancialPosition): PaymentRefusal | null {
  if (!Number.isFinite(amount) || amount <= 0) return 'AMOUNT_NOT_POSITIVE';
  if (!Number.isInteger(amount)) return 'AMOUNT_NOT_WHOLE_BAISA';
  if (position.outstanding <= 0) return 'NOTHING_OUTSTANDING';
  if (amount > position.outstanding) return 'AMOUNT_EXCEEDS_OUTSTANDING';
  return null;
}

/* ------------------------------------------------------------------------ *
 * Security deposit collection
 * ------------------------------------------------------------------------ */

export type DepositPaymentRefusal =
  'AMOUNT_NOT_POSITIVE' | 'AMOUNT_NOT_WHOLE_BAISA' | 'EXCEEDS_DEPOSIT_DUE';

export const DEPOSIT_PAYMENT_REFUSAL_MESSAGES: Readonly<Record<DepositPaymentRefusal, string>> = {
  AMOUNT_NOT_POSITIVE: 'A deposit must be greater than zero.',
  AMOUNT_NOT_WHOLE_BAISA: 'A deposit must be a whole number of baisa.',
  EXCEEDS_DEPOSIT_DUE: 'That is more than the security deposit for this reservation.',
};

export function refuseDepositPayment(
  amount: number,
  position: FinancialPosition,
): DepositPaymentRefusal | null {
  if (!Number.isFinite(amount) || amount <= 0) return 'AMOUNT_NOT_POSITIVE';
  if (!Number.isInteger(amount)) return 'AMOUNT_NOT_WHOLE_BAISA';

  // Collecting more deposit than the reservation calls for is over-collection,
  // and the boutique would simply owe it straight back.
  const alreadyCollected = position.depositPaid;
  if (amount + alreadyCollected > position.depositDue) return 'EXCEEDS_DEPOSIT_DUE';

  return null;
}

/* ------------------------------------------------------------------------ *
 * Refunds
 * ------------------------------------------------------------------------ */

export type RefundRefusal =
  'AMOUNT_NOT_POSITIVE' | 'AMOUNT_NOT_WHOLE_BAISA' | 'NOTHING_REFUNDABLE' | 'EXCEEDS_REFUNDABLE';

export const REFUND_REFUSAL_MESSAGES: Readonly<Record<RefundRefusal, string>> = {
  AMOUNT_NOT_POSITIVE: 'A refund must be greater than zero.',
  AMOUNT_NOT_WHOLE_BAISA: 'A refund must be a whole number of baisa.',
  NOTHING_REFUNDABLE: 'There is nothing to refund on this reservation.',
  EXCEEDS_REFUNDABLE: 'That is more than the refundable amount.',
};

/**
 * May this refund be paid out?
 *
 * The ceiling is `refundable` — money held beyond what the customer owes. It
 * already accounts for every earlier refund, because those reduced `netPaid`,
 * so "refunding twice" is not a special case to detect: the second attempt
 * simply finds nothing left. That is the whole reason the ledger is reduced
 * rather than a `refundedTotal` field being maintained by hand.
 */
export function refuseRefund(amount: number, position: FinancialPosition): RefundRefusal | null {
  if (!Number.isFinite(amount) || amount <= 0) return 'AMOUNT_NOT_POSITIVE';
  if (!Number.isInteger(amount)) return 'AMOUNT_NOT_WHOLE_BAISA';
  if (position.refundable <= 0) return 'NOTHING_REFUNDABLE';
  if (amount > position.refundable) return 'EXCEEDS_REFUNDABLE';
  return null;
}

/* ------------------------------------------------------------------------ *
 * Deposit settlement
 * ------------------------------------------------------------------------ */

export type DepositSettlementRefusal =
  | 'AMOUNT_NOT_POSITIVE'
  | 'AMOUNT_NOT_WHOLE_BAISA'
  | 'NOTHING_HELD'
  | 'EXCEEDS_HELD'
  | 'REASON_REQUIRED';

export const DEPOSIT_SETTLEMENT_REFUSAL_MESSAGES: Readonly<
  Record<DepositSettlementRefusal, string>
> = {
  AMOUNT_NOT_POSITIVE: 'The amount must be greater than zero.',
  AMOUNT_NOT_WHOLE_BAISA: 'The amount must be a whole number of baisa.',
  NOTHING_HELD: 'No deposit is being held for this reservation.',
  EXCEEDS_HELD: 'That is more than the deposit still held.',
  REASON_REQUIRED: 'A reason is required before keeping any part of a deposit.',
};

/**
 * May this much of the deposit be returned or kept?
 *
 * One function for both directions, because the invariant is the same and
 * splitting it invites the two copies to drift:
 *
 *     refunded + forfeited ≤ deposit paid
 *
 * Both draw on `depositHeld`, which is what remains after everything already
 * returned or kept — so an over-refund and an over-forfeit are the same
 * arithmetic failure and are caught by the same comparison.
 *
 * Forfeiture additionally demands a reason. Keeping a customer's money without
 * recording why is indefensible if it is ever questioned, and it will be.
 */
export function refuseDepositSettlement(input: {
  readonly amount: number;
  readonly position: FinancialPosition;
  readonly forfeiting: boolean;
  readonly reason: string;
}): DepositSettlementRefusal | null {
  if (!Number.isFinite(input.amount) || input.amount <= 0) return 'AMOUNT_NOT_POSITIVE';
  if (!Number.isInteger(input.amount)) return 'AMOUNT_NOT_WHOLE_BAISA';
  if (input.position.depositHeld <= 0) return 'NOTHING_HELD';
  if (input.amount > input.position.depositHeld) return 'EXCEEDS_HELD';
  if (input.forfeiting && input.reason.trim().length === 0) return 'REASON_REQUIRED';
  return null;
}

/* ------------------------------------------------------------------------ *
 * Reversal
 * ------------------------------------------------------------------------ */

export type ReversalRefusal =
  'EVENT_NOT_FOUND' | 'NOT_REVERSIBLE' | 'ALREADY_REVERSED' | 'REASON_REQUIRED';

export const REVERSAL_REFUSAL_MESSAGES: Readonly<Record<ReversalRefusal, string>> = {
  EVENT_NOT_FOUND: 'That payment no longer exists.',
  NOT_REVERSIBLE: 'Only a payment can be reversed. Refund or settle the deposit instead.',
  ALREADY_REVERSED: 'That payment has already been reversed.',
  REASON_REQUIRED: 'A reason is required to reverse a payment.',
};

/**
 * May this payment be reversed?
 *
 * Reversal is for a payment that **should never have been recorded** — the
 * wrong reservation, the wrong amount, a double entry. It is not a refund: no
 * money moves, and using it where money genuinely went back would make the cash
 * position wrong even though the balance looked right.
 *
 * A payment may be reversed once. A second reversal would credit the customer
 * twice for one error.
 */
export function refuseReversal(input: {
  readonly targetKind: string | null;
  readonly alreadyReversed: boolean;
  readonly reason: string;
}): ReversalRefusal | null {
  if (input.targetKind === null) return 'EVENT_NOT_FOUND';
  if (input.targetKind !== 'Payment' && input.targetKind !== 'SecurityDepositPayment') {
    return 'NOT_REVERSIBLE';
  }
  if (input.alreadyReversed) return 'ALREADY_REVERSED';
  if (input.reason.trim().length === 0) return 'REASON_REQUIRED';
  return null;
}

/* ------------------------------------------------------------------------ *
 * Idempotency
 * ------------------------------------------------------------------------ */

/**
 * Whether a supplied idempotency key is usable.
 *
 * The key is generated when the form opens, so a double click, a retry after a
 * timeout and an offline replay all carry the same one. Disabling the button is
 * UX; this is the guarantee.
 *
 * A blank or absurd key is refused outright rather than defaulted, because a
 * silently-generated server-side key would make every retry a fresh payment —
 * precisely the failure the mechanism exists to prevent.
 */
export function isUsableIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && key.trim().length >= 8 && key.length <= 200;
}

/* ------------------------------------------------------------------------ *
 * VAT
 * ------------------------------------------------------------------------ */

/**
 * VAT rates the boutique may configure.
 *
 * Oman's standard rate is 5%, and zero-rating applies to some supplies. A rate
 * outside this set is a configuration error, not a business choice, and is
 * refused rather than applied — a wrong VAT rate on an issued invoice is a
 * matter for the tax authority.
 */
export const PERMITTED_VAT_RATES: readonly number[] = [0, 5];

export function isPermittedVatRate(value: unknown): value is number {
  return typeof value === 'number' && PERMITTED_VAT_RATES.includes(value);
}

/* ------------------------------------------------------------------------ *
 * Who may do what
 * ------------------------------------------------------------------------ */

/**
 * Financial operations that only an owner may perform.
 *
 * Staff record money coming in — that is the job, and refusing it would stop
 * the shop working. Money going **out**, and any correction to posted history,
 * needs the owner: those are the operations that can be used to conceal a
 * shortfall, and separating them is the ordinary control any boutique would
 * expect over its till.
 *
 * Mirrored in `firestore.rules` and enforced in the Functions. The list here is
 * so the interface can hide what it must not offer.
 */
export const OWNER_ONLY_FINANCIAL_OPERATIONS = [
  'refund',
  'reverse',
  'forfeitDeposit',
  'refundDeposit',
  'cancelWithRefund',
] as const;

export type OwnerOnlyFinancialOperation = (typeof OWNER_ONLY_FINANCIAL_OPERATIONS)[number];

export function requiresOwner(operation: string): operation is OwnerOnlyFinancialOperation {
  return (OWNER_ONLY_FINANCIAL_OPERATIONS as readonly string[]).includes(operation);
}

/** Baisa re-export so callers guarding amounts need only one import. */
export type { Baisa };
