/**
 * Cancellation.
 *
 * When a booking is cancelled the boutique keeps a share of the rental,
 * decided by how close to the event the cancellation falls. The tiers are
 * **configured, never hard-coded** — the percentages are a commercial decision
 * belonging to the boutique, and burying them in code would make changing them
 * a deployment.
 *
 * The output is deliberately explicit: what was paid, what is kept, what goes
 * back, and how the deposit is treated. An employee has to be able to read the
 * result to a customer on the telephone.
 *
 * Pure: the cancellation date is a parameter.
 */

import { calendarDaysBetween, startOfMuscatDay, type EpochMs } from './datetime';
import { baisa, clampToZero, percentOf, subtract, ZERO, type Baisa } from './money';

export class CancellationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CancellationError';
  }
}

/**
 * One rung of the cancellation scale.
 *
 * `daysBeforeEvent` is the **minimum** notice this tier requires;
 * `refundPercent` is how much of the rental comes back at that notice.
 */
export interface CancellationTier {
  readonly daysBeforeEvent: number;
  readonly refundPercent: number;
  readonly label: { readonly en: string; readonly ar: string };
}

/**
 * Choose the tier that applies to a given notice period.
 *
 * Tiers are evaluated **most generous notice first**: with 30 days' notice and
 * tiers at 30, 14 and 7 days, the 30-day tier applies. A cancellation with less
 * notice than the shortest tier gets no refund, which is the correct default —
 * silently refunding when no rule matches would give money away on a
 * misconfiguration.
 */
export function selectTier(
  tiers: readonly CancellationTier[],
  daysOfNotice: number,
): CancellationTier | null {
  const applicable = tiers
    .filter((tier) => daysOfNotice >= tier.daysBeforeEvent)
    .sort((a, b) => b.daysBeforeEvent - a.daysBeforeEvent);

  return applicable[0] ?? null;
}

/**
 * How the deposit is handled on cancellation.
 *
 * Cancelling does not damage a dress, so the deposit goes back in full. It is
 * the customer's money and the boutique has no claim on it merely because a
 * booking ended — forfeiture requires an actual reason, recorded separately.
 */
export type DepositTreatment = 'Returned in full';

export interface CancellationQuote {
  readonly cancelledAt: EpochMs;
  readonly eventAt: EpochMs;
  readonly daysOfNotice: number;
  readonly tier: CancellationTier | null;
  readonly refundPercent: number;

  /** What the customer was liable for before cancelling. */
  readonly chargesBeforeCancellation: Baisa;
  /** The share the boutique keeps. */
  readonly cancellationCharge: Baisa;
  /** Charges lifted — posted to the ledger as a `ChargeWaiver`. */
  readonly waivedCharges: Baisa;

  /** Rental money already held. */
  readonly paidBeforeCancellation: Baisa;
  /** Rental money that must go back, once the waiver is applied. */
  readonly rentalRefundDue: Baisa;
  /** Rental still owed even after cancelling — the fee, if it was never paid. */
  readonly stillOwed: Baisa;

  readonly depositTreatment: DepositTreatment;
  readonly depositRefundDue: Baisa;

  /** Everything the customer gets back: rental refund plus deposit. */
  readonly totalRefundDue: Baisa;
}

/**
 * Quote a cancellation.
 *
 * Notice is measured in **calendar days in Muscat**, from the day of
 * cancellation to the day of the event, so a cancellation at 23:00 and one at
 * 08:00 the same morning get the same answer. Measuring in elapsed hours would
 * make the tier depend on the time of the telephone call, which no customer
 * would accept as fair.
 *
 * A cancellation after the event date has passed carries zero notice, and
 * therefore the least generous tier.
 */
export function quoteCancellation(input: {
  readonly cancelledAt: EpochMs;
  readonly eventAt: EpochMs;
  readonly tiers: readonly CancellationTier[];
  readonly chargesBeforeCancellation: Baisa;
  readonly paidBeforeCancellation: Baisa;
  readonly depositHeld: Baisa;
}): CancellationQuote {
  for (const tier of input.tiers) {
    if (
      !Number.isFinite(tier.refundPercent) ||
      tier.refundPercent < 0 ||
      tier.refundPercent > 100
    ) {
      throw new CancellationError(
        `A cancellation tier must refund between 0% and 100%, received: ${tier.refundPercent}`,
      );
    }
    if (!Number.isFinite(tier.daysBeforeEvent) || tier.daysBeforeEvent < 0) {
      throw new CancellationError(
        `A cancellation tier's notice period must be non-negative, received: ${tier.daysBeforeEvent}`,
      );
    }
  }

  const daysOfNotice = Math.max(0, calendarDaysBetween(input.cancelledAt, input.eventAt));

  const tier = selectTier(input.tiers, daysOfNotice);
  const refundPercent = tier?.refundPercent ?? 0;

  /*
   * The refunded share is computed first and the retained share is the
   * remainder, rather than computing both by percentage. Rounding each half
   * independently can make them miss the total by a baisa — and that baisa is
   * exactly the kind of discrepancy that makes a customer distrust the invoice.
   */
  const refundableShare = percentOf(input.chargesBeforeCancellation, refundPercent);
  const cancellationCharge = subtract(input.chargesBeforeCancellation, refundableShare);

  /*
   * The waiver is the relief posted to the ledger. After it, what the customer
   * owes is exactly the cancellation charge, and the refund falls out of the
   * ordinary balance arithmetic rather than being computed a second way.
   */
  const waivedCharges = refundableShare;

  const rentalRefundDue = clampToZero(subtract(input.paidBeforeCancellation, cancellationCharge));
  const stillOwed = clampToZero(subtract(cancellationCharge, input.paidBeforeCancellation));

  const depositRefundDue = input.depositHeld;

  return {
    cancelledAt: input.cancelledAt,
    eventAt: input.eventAt,
    daysOfNotice,
    tier,
    refundPercent,
    chargesBeforeCancellation: input.chargesBeforeCancellation,
    cancellationCharge,
    waivedCharges,
    paidBeforeCancellation: input.paidBeforeCancellation,
    rentalRefundDue,
    stillOwed,
    depositTreatment: 'Returned in full',
    depositRefundDue,
    totalRefundDue: baisa(rentalRefundDue + depositRefundDue),
  };
}

/**
 * Days of notice, for showing on screen before the employee commits.
 *
 * Exposed separately so the booking screen can display "14 days' notice —
 * 50% refund" while the customer is still deciding.
 */
export function daysOfNotice(cancelledAt: EpochMs, eventAt: EpochMs): number {
  return Math.max(0, calendarDaysBetween(cancelledAt, eventAt));
}

/** An event date given as `YYYY-MM-DD`, resolved to the start of that Muscat day. */
export function eventInstant(eventDate: string): EpochMs {
  return startOfMuscatDay(eventDate);
}

export const NO_TIERS: readonly CancellationTier[] = [];
export const ZERO_REFUND = ZERO;
