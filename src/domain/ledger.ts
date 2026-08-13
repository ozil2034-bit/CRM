/**
 * The financial ledger.
 *
 * **This is the single authoritative financial calculation in the platform.**
 * The reservation screen, the payment dialog, the dashboard and — in Phase 6 —
 * the invoice all reduce the same event list through the same function. There
 * is deliberately no second place where a balance is worked out, because two
 * implementations of one formula eventually disagree, and the one on the
 * invoice is the one the customer keeps.
 *
 * ## Append-only
 *
 * Financial history is never destroyed and never edited. A mistake is corrected
 * by appending an event that offsets it, leaving both visible. That is what
 * makes the ledger answer "what happened" and not merely "what do we currently
 * believe". Firestore rules enforce it: no client may write these documents at
 * all, and no role may update or delete one.
 *
 * ## Two separate sides
 *
 * The rental account and the security deposit are tracked apart, and the
 * separation is not cosmetic. A security deposit is the customer's money held
 * against damage — it is not revenue, it is not VAT-taxable, and it must never
 * be quietly consumed to make a rental balance look settled. A customer who has
 * paid a deposit and nothing else owes the full rental.
 *
 * Pure: no I/O, no Firebase, no clock. Shared with the Cloud Functions build,
 * so the figure previewed in the browser is the figure the server computes.
 */

import { add, baisa, clampToZero, subtract, sum, ZERO, type Baisa } from './money';
import type { EpochMs } from './datetime';
import type { PricingSnapshot } from './reservation-pricing';

/* ------------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------------ */

/**
 * The kinds of financial event.
 *
 * Every event carries a **positive** `amount`; the kind decides the direction.
 * Storing a signed amount would make a mistyped minus sign into a silent
 * reversal, and would let "amount must be greater than zero" pass on a value
 * that takes money out of the till.
 */
export const FINANCIAL_EVENT_KINDS = [
  /** Money in, against the rental account. */
  'Payment',
  /** Cancels a specific earlier `Payment` that should not have been recorded. */
  'PaymentReversal',
  /** Money out, against the rental account — an actual refund to the customer. */
  'Refund',
  /** Money in, against the security deposit. Never revenue. */
  'SecurityDepositPayment',
  /** Money out, returning the customer's deposit. */
  'SecurityDepositRefund',
  /** Deposit retained by the boutique, against damage or loss. */
  'SecurityDepositForfeiture',
  /** A charge added after creation — a late return. */
  'LateFee',
  /** A charge removed — cancellation relieves the customer of part of the rental. */
  'ChargeWaiver',
] as const;

export type FinancialEventKind = (typeof FINANCIAL_EVENT_KINDS)[number];

export function isFinancialEventKind(value: unknown): value is FinancialEventKind {
  return typeof value === 'string' && (FINANCIAL_EVENT_KINDS as readonly string[]).includes(value);
}

/** How money physically moved. */
export const PAYMENT_METHODS = ['Cash', 'Card', 'Bank Transfer'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === 'string' && (PAYMENT_METHODS as readonly string[]).includes(value);
}

/**
 * Where a rental payment sits in the sequence.
 *
 * `Deposit` here means an **advance against the rental** — the first payment a
 * bride makes to hold the booking. It is not the security deposit, which has
 * its own event kinds. The two are separate money and the naming keeps them so.
 */
export const PAYMENT_TYPES = ['Deposit', 'Installment', 'Final Payment'] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

export function isPaymentType(value: unknown): value is PaymentType {
  return typeof value === 'string' && (PAYMENT_TYPES as readonly string[]).includes(value);
}

export interface FinancialEvent {
  readonly id: string;
  readonly reservationId: string;
  readonly kind: FinancialEventKind;
  /** Always positive. The kind decides whether it adds or subtracts. */
  readonly amount: Baisa;
  readonly method: PaymentMethod | null;
  readonly type: PaymentType | null;
  readonly occurredAt: EpochMs;
  readonly reference: string;
  readonly reason: string;
  readonly employeeId: string;
  /** Set on `PaymentReversal`: the event being cancelled. */
  readonly reversesEventId: string | null;
  readonly idempotencyKey: string;
}

/* ------------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------------ */

/** Kinds that move money on the rental account. */
const RENTAL_CASH_IN: ReadonlySet<FinancialEventKind> = new Set(['Payment']);
const RENTAL_CASH_OUT: ReadonlySet<FinancialEventKind> = new Set(['Refund']);

/**
 * Kinds that move money on the deposit account.
 *
 * Money out is counted per kind rather than as one set: returning a deposit and
 * keeping it both reduce the holding, but a customer asking "what happened to
 * my deposit" needs the two told apart.
 */
const DEPOSIT_IN: ReadonlySet<FinancialEventKind> = new Set(['SecurityDepositPayment']);

/**
 * The signed value of an event, for display and for reporting.
 *
 * A reversal shows as a negative line beside the payment it cancels, which is
 * what makes the correction legible on a statement — the original stays, and
 * the pair nets to zero.
 */
export function signedAmount(event: FinancialEvent): Baisa {
  switch (event.kind) {
    case 'Payment':
    case 'SecurityDepositPayment':
    case 'LateFee':
      return event.amount;
    case 'PaymentReversal':
    case 'Refund':
    case 'SecurityDepositRefund':
    case 'SecurityDepositForfeiture':
    case 'ChargeWaiver':
      return baisa(-event.amount);
  }
}

/* ------------------------------------------------------------------------ *
 * The position
 * ------------------------------------------------------------------------ */

/**
 * Everything financial about one reservation, at one moment.
 *
 * Derived entirely from the pricing snapshot plus the event list. Nothing here
 * is stored: a stored balance is a cache that goes stale the moment an event is
 * appended, and a stale balance is how a customer gets asked to pay twice.
 */
export interface FinancialPosition {
  /* --- The rental account --- */
  /** Charges agreed at booking: taxable subtotal plus VAT. Excludes the deposit. */
  readonly agreedCharges: Baisa;
  /** Late fees posted after booking. */
  readonly lateFees: Baisa;
  /** Charges withdrawn — cancellation relief. */
  readonly waivedCharges: Baisa;
  /** What the customer owes in total: agreed + late fees − waivers. Never negative. */
  readonly totalChargeable: Baisa;

  /** Gross rental payments received, before reversals. */
  readonly grossPaid: Baisa;
  /** Payments cancelled as recording errors. */
  readonly reversed: Baisa;
  /** Money actually returned to the customer on the rental account. */
  readonly refunded: Baisa;
  /** What the boutique is actually holding against the rental. */
  readonly netPaid: Baisa;

  /** Still owed. Zero when settled or overpaid. */
  readonly outstanding: Baisa;
  /** Held beyond what is owed — the ceiling on any refund. Zero when not. */
  readonly refundable: Baisa;

  /* --- The deposit account, kept separate --- */
  readonly depositDue: Baisa;
  readonly depositPaid: Baisa;
  readonly depositRefunded: Baisa;
  readonly depositForfeited: Baisa;
  /** Still in the boutique's hands and still the customer's money. */
  readonly depositHeld: Baisa;
  /** The most that could still be returned or forfeited. */
  readonly depositRemaining: Baisa;

  readonly status: FinancialStatus;
}

/**
 * The financial state of a reservation.
 *
 * Deliberately **not** the reservation status. A booking can be `Picked Up` and
 * `Unpaid`, or `Cancelled` and `Paid`; conflating the two hides exactly the
 * situations an owner needs to see.
 */
export const FINANCIAL_STATUSES = [
  'Unpaid',
  'Partially Paid',
  'Paid',
  'Partially Refunded',
  'Refunded',
] as const;

export type FinancialStatus = (typeof FINANCIAL_STATUSES)[number];

export function isFinancialStatus(value: unknown): value is FinancialStatus {
  return typeof value === 'string' && (FINANCIAL_STATUSES as readonly string[]).includes(value);
}

/**
 * Reduce a reservation's pricing snapshot and event list to its position.
 *
 * The single formula. Every screen and every document goes through here.
 */
export function reduceLedger(
  pricing: PricingSnapshot,
  events: readonly FinancialEvent[],
): FinancialPosition {
  const agreedCharges = add(pricing.taxableSubtotal, pricing.vatAmount);

  const lateFees = totalOf(events, 'LateFee');
  const waivedCharges = totalOf(events, 'ChargeWaiver');

  /*
   * Waivers are capped at what is actually chargeable. A waiver larger than the
   * bill would make the boutique owe the customer money it never took, which is
   * a data-entry error rather than a transaction.
   */
  const chargesBeforeWaiver = add(agreedCharges, lateFees);
  const totalChargeable = clampToZero(subtract(chargesBeforeWaiver, waivedCharges));

  const grossPaid = sumOf(events, RENTAL_CASH_IN);
  const reversed = totalOf(events, 'PaymentReversal');
  const refunded = sumOf(events, RENTAL_CASH_OUT);

  /*
   * Reversals and refunds both reduce what the boutique holds, but they mean
   * different things: a reversal says the payment never should have been
   * recorded, a refund says money genuinely went back. Both are subtracted;
   * both stay visible.
   */
  const netPaid = baisa(grossPaid - reversed - refunded);

  const depositDue = pricing.securityDepositTotal;
  const depositPaid = sumOf(events, DEPOSIT_IN);
  const depositRefunded = totalOf(events, 'SecurityDepositRefund');
  const depositForfeited = totalOf(events, 'SecurityDepositForfeiture');
  const depositHeld = baisa(depositPaid - depositRefunded - depositForfeited);

  return {
    agreedCharges,
    lateFees,
    waivedCharges,
    totalChargeable,
    grossPaid,
    reversed,
    refunded,
    netPaid,
    outstanding: clampToZero(subtract(totalChargeable, netPaid)),
    refundable: clampToZero(subtract(netPaid, totalChargeable)),
    depositDue,
    depositPaid,
    depositRefunded,
    depositForfeited,
    depositHeld: clampToZero(depositHeld),
    depositRemaining: clampToZero(depositHeld),
    status: financialStatus({ totalChargeable, netPaid, refunded, grossPaid }),
  };
}

function totalOf(events: readonly FinancialEvent[], kind: FinancialEventKind): Baisa {
  return sum(events.filter((event) => event.kind === kind).map((event) => event.amount));
}

function sumOf(events: readonly FinancialEvent[], kinds: ReadonlySet<FinancialEventKind>): Baisa {
  return sum(events.filter((event) => kinds.has(event.kind)).map((event) => event.amount));
}

/**
 * Classify the rental account.
 *
 * Refund states outrank payment states: once money has gone back to the
 * customer, "Paid" is a misleading thing to show, even if the arithmetic
 * happens to balance.
 */
function financialStatus(input: {
  totalChargeable: Baisa;
  netPaid: Baisa;
  refunded: Baisa;
  grossPaid: Baisa;
}): FinancialStatus {
  if (input.refunded > 0) {
    // Everything that came in has gone back out.
    return input.netPaid <= 0 ? 'Refunded' : 'Partially Refunded';
  }

  if (input.netPaid <= 0) return 'Unpaid';
  if (input.netPaid >= input.totalChargeable) return 'Paid';
  return 'Partially Paid';
}

/* ------------------------------------------------------------------------ *
 * Pickup eligibility
 * ------------------------------------------------------------------------ */

export interface PickupEligibility {
  readonly allowed: boolean;
  readonly reasons: readonly PickupBlocker[];
  /** How much of the rental has been paid, 0–100, for showing progress. */
  readonly paidPercent: number;
  readonly stillRequired: Baisa;
}

export type PickupBlocker = 'DEPOSIT_NOT_HELD' | 'BALANCE_BELOW_THRESHOLD';

/**
 * May this gown leave the shop?
 *
 * Two independent conditions, both required (§22):
 *
 * 1. The security deposit is fully held. It is the boutique's only protection
 *    against a gown that does not come back.
 * 2. Enough of the **rental** has been paid. The deposit does not count toward
 *    this — it is not payment for anything, and treating it as payment would let
 *    a bride collect a dress having paid nothing for the rental itself.
 */
export function pickupEligibility(
  position: FinancialPosition,
  minPickupPaymentPercent: number,
): PickupEligibility {
  if (!Number.isFinite(minPickupPaymentPercent) || minPickupPaymentPercent < 0) {
    throw new Error(
      `Pickup threshold must be a non-negative number, received: ${minPickupPaymentPercent}`,
    );
  }

  const reasons: PickupBlocker[] = [];

  if (position.depositHeld < position.depositDue) {
    reasons.push('DEPOSIT_NOT_HELD');
  }

  /*
   * Required is computed in integer baisa and rounded up, so a 50% threshold on
   * an odd total requires the larger half. Rounding down would let a customer
   * take a dress a baisa short of the rule.
   */
  const required = baisa(Math.ceil((position.totalChargeable * minPickupPaymentPercent) / 100));

  if (position.netPaid < required) {
    reasons.push('BALANCE_BELOW_THRESHOLD');
  }

  const paidPercent =
    position.totalChargeable === 0
      ? 100
      : Math.min(100, (position.netPaid / position.totalChargeable) * 100);

  return {
    allowed: reasons.length === 0,
    reasons,
    paidPercent,
    stillRequired: clampToZero(subtract(required, position.netPaid)),
  };
}

/* ------------------------------------------------------------------------ *
 * Reconciliation
 * ------------------------------------------------------------------------ */

export interface ReconciliationResult {
  readonly balanced: boolean;
  readonly problems: readonly string[];
}

/**
 * Assert the invariants that must hold for every reservation, always.
 *
 * Run in tests and available to an operator. A failure here means a financial
 * record is internally inconsistent, which is a defect and not a business
 * situation — no sequence of legitimate operations can produce one.
 */
export function reconcile(
  pricing: PricingSnapshot,
  position: FinancialPosition,
): ReconciliationResult {
  const problems: string[] = [];

  // The grand total is the taxable charges, their VAT, and the untaxed deposit.
  const expectedGrandTotal = sum([
    pricing.taxableSubtotal,
    pricing.vatAmount,
    pricing.securityDepositTotal,
  ]);
  if (pricing.grandTotal !== expectedGrandTotal) {
    problems.push(
      `Grand total ${pricing.grandTotal} does not equal charges + VAT + deposit (${expectedGrandTotal}).`,
    );
  }

  // The deposit may never be over-returned.
  if (position.depositRefunded + position.depositForfeited > position.depositPaid) {
    problems.push(
      `Deposit returned and forfeited (${position.depositRefunded + position.depositForfeited}) exceeds deposit paid (${position.depositPaid}).`,
    );
  }

  if (position.depositHeld < 0) {
    problems.push(`Deposit held is negative (${position.depositHeld}).`);
  }

  // Money out on the rental account may never exceed money in.
  if (position.reversed + position.refunded > position.grossPaid) {
    problems.push(
      `Reversals and refunds (${position.reversed + position.refunded}) exceed gross payments (${position.grossPaid}).`,
    );
  }

  // Outstanding and refundable are mutually exclusive by construction.
  if (position.outstanding > 0 && position.refundable > 0) {
    problems.push('A reservation cannot be both owed and refundable.');
  }

  // The rental account must close.
  const expected = subtract(position.totalChargeable, position.netPaid);
  const actual = subtract(position.outstanding, position.refundable);
  if (expected !== actual) {
    problems.push(
      `Outstanding less refundable (${actual}) does not equal what remains (${expected}).`,
    );
  }

  return { balanced: problems.length === 0, problems };
}

/** An empty position, for a reservation with no events yet. */
export function emptyPosition(pricing: PricingSnapshot): FinancialPosition {
  return reduceLedger(pricing, []);
}

export const ZERO_BAISA = ZERO;
