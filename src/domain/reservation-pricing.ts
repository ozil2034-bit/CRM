/**
 * Reservation pricing.
 *
 * Phase 4 establishes the structure and computes the totals a reservation
 * carries. Payment recording, deposit settlement and invoicing are Phase 5 and 6
 * — this module only says what the reservation is worth.
 *
 * Every amount is integer baisa. Nothing here touches floating point.
 *
 * Pure. Shared with the Cloud Functions build, so the total shown while booking
 * is the total the server stores.
 */

import { add, baisa, percentOf, subtract, sum, type Baisa } from './money';

export interface ReservationLineItem {
  readonly dressId: string;
  readonly dressCode: string;
  readonly dressName: string;
  readonly designer: string;
  readonly rentalPrice: Baisa;
  readonly securityDeposit: Baisa;
  readonly cleaningBufferDays: number;
}

export interface AccessoryLine {
  readonly accessoryId: string;
  readonly name: string;
  readonly unitPrice: Baisa;
  readonly quantity: number;
  readonly securityDeposit: Baisa;
}

export interface AlterationLine {
  readonly description: string;
  readonly amount: Baisa;
}

export type DiscountKind = 'amount' | 'percent';

export interface DiscountInput {
  readonly kind: DiscountKind;
  /** Baisa when `amount`; whole or fractional percent when `percent`. */
  readonly value: number;
}

export const NO_DISCOUNT: DiscountInput = { kind: 'amount', value: 0 };

export interface PricingInput {
  readonly items: readonly ReservationLineItem[];
  readonly accessories: readonly AccessoryLine[];
  readonly alterations: readonly AlterationLine[];
  readonly discount: DiscountInput;
  /** The rate in force when the reservation is created. Frozen thereafter. */
  readonly vatRatePercent: number;
}

/**
 * The immutable pricing snapshot stored on a reservation.
 *
 * Every figure is computed once, at creation, and never recomputed from master
 * data. A price change next month must not alter what a customer agreed to
 * today.
 */
export interface PricingSnapshot {
  readonly rentalSubtotal: Baisa;
  readonly accessorySubtotal: Baisa;
  readonly alterationSubtotal: Baisa;
  readonly discountAmount: Baisa;
  /** The VAT-taxable base: rentals + accessories + alterations − discount. */
  readonly taxableSubtotal: Baisa;
  readonly vatRatePercent: number;
  readonly vatAmount: Baisa;
  /** Deposits are **not** VAT-taxable and are shown separately. */
  readonly securityDepositTotal: Baisa;
  readonly grandTotal: Baisa;
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

/**
 * Compute a reservation's pricing snapshot.
 *
 * Order matters and is deliberate:
 *
 * 1. Sum the taxable components.
 * 2. Apply the discount to that sum — a discount reduces what is charged, so it
 *    reduces the VAT base with it. Applying VAT first and discounting after
 *    would have the customer paying tax on money they never paid.
 * 3. Compute VAT once, on the discounted base, rounding a single time.
 * 4. Add the security deposit outside the tax base entirely: it is a refundable
 *    holding, not a sale.
 */
export function computePricing(input: PricingInput): PricingSnapshot {
  if (!Number.isFinite(input.vatRatePercent) || input.vatRatePercent < 0) {
    throw new PricingError(`VAT rate must be a non-negative number, received: ${input.vatRatePercent}`);
  }

  const rentalSubtotal = sum(input.items.map((item) => item.rentalPrice));

  const accessorySubtotal = sum(
    input.accessories.map((accessory) => {
      if (!Number.isInteger(accessory.quantity) || accessory.quantity < 0) {
        throw new PricingError(`Accessory quantity must be a whole number, received: ${accessory.quantity}`);
      }
      return baisa(accessory.unitPrice * accessory.quantity);
    }),
  );

  const alterationSubtotal = sum(input.alterations.map((alteration) => alteration.amount));

  const beforeDiscount = sum([rentalSubtotal, accessorySubtotal, alterationSubtotal]);
  const discountAmount = resolveDiscount(input.discount, beforeDiscount);
  const taxableSubtotal = subtract(beforeDiscount, discountAmount);

  const vatAmount = percentOf(taxableSubtotal, input.vatRatePercent);

  const securityDepositTotal = sum([
    ...input.items.map((item) => item.securityDeposit),
    ...input.accessories.map((accessory) =>
      baisa(accessory.securityDeposit * accessory.quantity),
    ),
  ]);

  return {
    rentalSubtotal,
    accessorySubtotal,
    alterationSubtotal,
    discountAmount,
    taxableSubtotal,
    vatRatePercent: input.vatRatePercent,
    vatAmount,
    securityDepositTotal,
    grandTotal: sum([taxableSubtotal, vatAmount, securityDepositTotal]),
  };
}

/**
 * Resolve a discount to a baisa amount.
 *
 * Capped at the amount being discounted: a discount larger than the bill would
 * produce a negative subtotal, and a reservation the boutique owes money on is
 * a data-entry error, not a transaction.
 */
export function resolveDiscount(discount: DiscountInput, base: Baisa): Baisa {
  if (discount.value < 0) {
    throw new PricingError('A discount cannot be negative.');
  }

  if (discount.kind === 'percent') {
    if (discount.value > 100) {
      throw new PricingError('A percentage discount cannot exceed 100%.');
    }
    return percentOf(base, discount.value);
  }

  const requested = baisa(Math.round(discount.value));
  return requested > base ? base : requested;
}

/** The balance still owed, given what has been paid. Never negative. */
export function outstandingBalance(snapshot: PricingSnapshot, paid: Baisa): Baisa {
  const remaining = subtract(snapshot.grandTotal, paid);
  return remaining > 0 ? remaining : baisa(0);
}

/** The rental portion alone — the eligible balance for pickup rules in Phase 5. */
export function eligibleRentalTotal(snapshot: PricingSnapshot): Baisa {
  return add(snapshot.taxableSubtotal, snapshot.vatAmount);
}
