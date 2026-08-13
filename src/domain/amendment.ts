/**
 * Amending a reservation's charges.
 *
 * Phase 4 created reservations with empty `accessories` and `alterations` and
 * left the workflow deferred. This module completes it — and it is the delicate
 * one, because Phase 5 froze the pricing snapshot at creation and this changes
 * it.
 *
 * ## Why amending is not the same as recomputing
 *
 * The rule Phase 5 established is that a reservation's figures must never
 * *drift*: a price rise in the master catalogue, or a VAT change next quarter,
 * must not reach back into a booking a customer already agreed to. That rule is
 * about the boutique's data changing underneath a customer. It is not about the
 * customer buying a veil.
 *
 * So an amendment:
 *
 * - **Reuses every frozen figure.** Existing dress lines keep their snapshotted
 *   rental price and deposit. Existing accessories and alterations keep theirs.
 *   Nothing already agreed is re-read from master data.
 * - **Keeps the reservation's own VAT rate**, not today's. A booking taken at 0%
 *   stays at 0% even if the owner configures 5% tomorrow.
 * - **Keeps the discount as an absolute amount.** A discount was agreed as a sum
 *   of money off this booking; re-applying it as a percentage of a larger bill
 *   would silently enlarge a concession nobody granted.
 * - Adds exactly the new line, and recomputes the totals through
 *   {@link computePricing} — the same and only pricing engine.
 *
 * The result is that VAT is still computed once, on the discounted base, by the
 * one function that knows how; and {@link reduceLedger} continues to be the one
 * place a balance comes from.
 *
 * ## Why an issued invoice stops it
 *
 * A document is a copy, frozen at issue. Amending a reservation that has a live
 * invoice would leave the customer holding a piece of paper the system no longer
 * agrees with — precisely the discrepancy `reconcileDocument` exists to detect.
 * The correction path is to void the invoice and issue a new one, which leaves
 * both on the record.
 *
 * Pure: no I/O, no clock, no Firebase.
 */

import { baisa, type Baisa } from './money';
import {
  computePricing,
  type AccessoryLine,
  type AlterationLine,
  type PricingSnapshot,
  type ReservationLineItem,
} from './reservation-pricing';
import type { ReservationStatus } from './availability';

/* ------------------------------------------------------------------------ *
 * The lines
 * ------------------------------------------------------------------------ */

/**
 * An accessory as it sits on a reservation.
 *
 * Wider than {@link AccessoryLine}, which is only what pricing needs. The extra
 * fields are the snapshot: a veil renamed or repriced next month must not change
 * what this booking says it sold.
 */
export interface ReservationAccessory extends AccessoryLine {
  /**
   * Stable within the reservation, and distinct from `accessoryId`.
   *
   * The request key becomes this, which is what makes a retry a line that
   * already exists. The catalogue id stays a catalogue id so reporting can still
   * ask which accessories earn their keep — and so a bride can take two veils
   * from the same catalogue entry at different agreed prices.
   */
  readonly lineId: string;
  readonly nameAr: string;
}

/** An alteration as it sits on a reservation. */
export interface ReservationAlteration extends AlterationLine {
  /** Stable within the reservation, so one line can be removed by name. */
  readonly id: string;
  readonly descriptionAr: string;
  readonly notes: string;
  readonly employeeId: string;
  readonly employeeName: string;
  readonly createdAt: number;
}

/** Everything an amendment needs to know about the reservation it is changing. */
export interface AmendmentContext {
  readonly status: ReservationStatus;
  /** True when an issued, un-voided document exists for this reservation. */
  readonly hasActiveDocument: boolean;
  readonly items: readonly ReservationLineItem[];
  readonly accessories: readonly ReservationAccessory[];
  readonly alterations: readonly ReservationAlteration[];
  /** The rate frozen onto the reservation — never the current setting. */
  readonly vatRatePercent: number;
  /** The discount already agreed, in baisa. Carried across unchanged. */
  readonly discountAmount: Baisa;
}

/* ------------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------------ */

export type AmendmentRefusal =
  | 'RESERVATION_FINISHED'
  | 'DOCUMENT_ISSUED'
  | 'EMPTY_DESCRIPTION'
  | 'AMOUNT_NOT_POSITIVE'
  | 'AMOUNT_NOT_WHOLE'
  | 'QUANTITY_NOT_POSITIVE'
  | 'QUANTITY_TOO_LARGE'
  | 'PRICE_NEGATIVE'
  | 'PRICE_NOT_WHOLE'
  | 'TOO_MANY_LINES'
  | 'NOT_FOUND';

/**
 * A sanity ceiling, not a business rule.
 *
 * Firestore documents are capped at 1 MiB and these arrays live inside the
 * reservation. A boutique adding a hundred veils to one booking has made a
 * mistake; refusing it here is kinder than a write that fails at the storage
 * layer with nothing an employee can read.
 */
const MAX_LINES = 50;
const MAX_QUANTITY = 99;

export const AMENDMENT_REFUSAL_MESSAGES: Readonly<Record<AmendmentRefusal, string>> = {
  RESERVATION_FINISHED: 'This reservation is finished and its charges can no longer be changed.',
  DOCUMENT_ISSUED:
    'An invoice has already been issued for this reservation. Void it before changing the charges.',
  EMPTY_DESCRIPTION: 'Describe the work before saving it.',
  AMOUNT_NOT_POSITIVE: 'The amount must be greater than zero.',
  AMOUNT_NOT_WHOLE: 'The amount must be a whole number of baisa.',
  QUANTITY_NOT_POSITIVE: 'The quantity must be at least one.',
  QUANTITY_TOO_LARGE: `The quantity must be ${String(MAX_QUANTITY)} or fewer.`,
  PRICE_NEGATIVE: 'A price cannot be negative.',
  PRICE_NOT_WHOLE: 'A price must be a whole number of baisa.',
  TOO_MANY_LINES: `A reservation can carry at most ${String(MAX_LINES)} of these.`,
  NOT_FOUND: 'That line is no longer on this reservation.',
};

/**
 * Statuses whose charges may still change.
 *
 * A gown out with the customer can still gain an alteration — a hem taken up at
 * the last fitting is billed after the dress has left. Once it comes back the
 * account is being settled, and a new charge appearing mid-settlement is how a
 * deposit gets refunded against a total that has since moved.
 */
const AMENDABLE: ReadonlySet<ReservationStatus> = new Set([
  'Inquiry',
  'Reserved',
  'Fitting Scheduled',
  'Fitted',
  'Picked Up',
]);

export function refuseAmendment(context: {
  readonly status: ReservationStatus;
  readonly hasActiveDocument: boolean;
}): AmendmentRefusal | null {
  if (!AMENDABLE.has(context.status)) return 'RESERVATION_FINISHED';
  if (context.hasActiveDocument) return 'DOCUMENT_ISSUED';
  return null;
}

/* ------------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------------ */

export interface AccessoryRequest {
  readonly accessoryId: string;
  readonly name: string;
  readonly nameAr: string;
  readonly unitPrice: number;
  readonly securityDeposit: number;
  readonly quantity: number;
}

export function refuseAccessory(
  request: AccessoryRequest,
  existing: readonly ReservationAccessory[],
): AmendmentRefusal | null {
  if (request.name.trim().length === 0) return 'EMPTY_DESCRIPTION';

  if (!Number.isInteger(request.quantity)) return 'QUANTITY_NOT_POSITIVE';
  if (request.quantity < 1) return 'QUANTITY_NOT_POSITIVE';
  if (request.quantity > MAX_QUANTITY) return 'QUANTITY_TOO_LARGE';

  for (const price of [request.unitPrice, request.securityDeposit]) {
    if (!Number.isInteger(price)) return 'PRICE_NOT_WHOLE';
    if (price < 0) return 'PRICE_NEGATIVE';
  }

  if (existing.length >= MAX_LINES) return 'TOO_MANY_LINES';

  return null;
}

export interface AlterationRequest {
  readonly description: string;
  readonly descriptionAr: string;
  readonly amount: number;
  readonly notes: string;
}

export function refuseAlteration(
  request: AlterationRequest,
  existing: readonly ReservationAlteration[],
): AmendmentRefusal | null {
  if (request.description.trim().length === 0) return 'EMPTY_DESCRIPTION';

  if (!Number.isInteger(request.amount)) return 'AMOUNT_NOT_WHOLE';
  if (request.amount <= 0) return 'AMOUNT_NOT_POSITIVE';

  if (existing.length >= MAX_LINES) return 'TOO_MANY_LINES';

  return null;
}

/* ------------------------------------------------------------------------ *
 * Repricing
 * ------------------------------------------------------------------------ */

export interface AmendedPricing {
  readonly pricing: PricingSnapshot;
  readonly accessories: readonly ReservationAccessory[];
  readonly alterations: readonly ReservationAlteration[];
}

/**
 * Reprice a reservation with a new set of accessory and alteration lines.
 *
 * The single pricing engine, called again with more lines — **not** a second
 * calculation. Every frozen figure is passed straight back in; only the line
 * lists differ.
 *
 * The discount travels as an absolute amount for the reason given at the top of
 * this file. `computePricing` caps it at the bill, so a discount that once
 * covered the whole booking does not turn into a credit when the bill grows.
 */
export function reprice(
  context: AmendmentContext,
  next: {
    readonly accessories: readonly ReservationAccessory[];
    readonly alterations: readonly ReservationAlteration[];
  },
): AmendedPricing {
  const pricing = computePricing({
    items: context.items,
    accessories: next.accessories.map((accessory) => ({
      accessoryId: accessory.accessoryId,
      name: accessory.name,
      unitPrice: accessory.unitPrice,
      quantity: accessory.quantity,
      securityDeposit: accessory.securityDeposit,
    })),
    alterations: next.alterations.map((alteration) => ({
      description: alteration.description,
      amount: alteration.amount,
    })),
    discount: { kind: 'amount', value: context.discountAmount },
    vatRatePercent: context.vatRatePercent,
  });

  return { pricing, accessories: next.accessories, alterations: next.alterations };
}

/** Add one accessory line and reprice. */
export function withAccessory(
  context: AmendmentContext,
  accessory: ReservationAccessory,
): AmendedPricing {
  return reprice(context, {
    accessories: [...context.accessories, accessory],
    alterations: context.alterations,
  });
}

/** Add one alteration line and reprice. */
export function withAlteration(
  context: AmendmentContext,
  alteration: ReservationAlteration,
): AmendedPricing {
  return reprice(context, {
    accessories: context.accessories,
    alterations: [...context.alterations, alteration],
  });
}

/** Remove an accessory by line id and reprice. Refuses when absent. */
export function withoutAccessory(
  context: AmendmentContext,
  lineId: string,
): AmendedPricing | AmendmentRefusal {
  const remaining = context.accessories.filter((accessory) => accessory.lineId !== lineId);

  if (remaining.length === context.accessories.length) return 'NOT_FOUND';

  return reprice(context, { accessories: remaining, alterations: context.alterations });
}

/** Remove an alteration by line id and reprice. Refuses when absent. */
export function withoutAlteration(
  context: AmendmentContext,
  alterationId: string,
): AmendedPricing | AmendmentRefusal {
  const remaining = context.alterations.filter((alteration) => alteration.id !== alterationId);

  if (remaining.length === context.alterations.length) return 'NOT_FOUND';

  return reprice(context, { accessories: context.accessories, alterations: remaining });
}

/**
 * How much an amendment moves the bill.
 *
 * Shown to the employee before they commit, so "add a veil" is never a silent
 * change to what a customer owes. Positive means the customer owes more.
 */
export function chargeDelta(before: PricingSnapshot, after: PricingSnapshot): {
  readonly charges: Baisa;
  readonly deposit: Baisa;
  readonly total: Baisa;
} {
  const chargesBefore = before.taxableSubtotal + before.vatAmount;
  const chargesAfter = after.taxableSubtotal + after.vatAmount;

  return {
    charges: baisa(chargesAfter - chargesBefore),
    deposit: baisa(after.securityDepositTotal - before.securityDepositTotal),
    total: baisa(after.grandTotal - before.grandTotal),
  };
}
