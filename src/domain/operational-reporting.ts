/**
 * Operational reporting.
 *
 * The figures an owner asks for that the financial summary alone cannot answer:
 * which gowns earn, which are rented most, how many bookings fell through, and
 * what accessories and alterations contribute.
 *
 * ## Where revenue comes from
 *
 * From the **ledger**, always. Never from a reservation's status, never from a
 * dress's current price, never from a total shown on a card. `summarise()` in
 * `financial-reporting.ts` reduces the events; this module attributes what it
 * found to the things that earned it.
 *
 * Security deposits are excluded from every revenue figure here. A deposit is
 * the customer's money held against damage; counting it as income would
 * overstate what the boutique earned and understate what it owes back.
 *
 * ## Attributing a payment to a dress
 *
 * A payment is made against a *reservation*, not a dress, and a reservation may
 * carry three gowns. So a reservation's net collection is **split in proportion
 * to the frozen rental prices of its lines** — the prices agreed at booking, not
 * today's catalogue.
 *
 * The split is done in integer baisa by largest remainder, so the parts sum
 * exactly to the whole. Attributing by any other rule (equal shares, or the
 * first dress taking everything) would make a cheap veil-and-gown booking look
 * like two equal earners.
 *
 * This is an attribution, not a measurement, and the report says so. It is the
 * best available answer to "which gowns pay for themselves"; it is not a claim
 * that a particular customer paid a particular sum for a particular dress.
 *
 * Pure: no I/O, no clock. The period is a parameter.
 */

import { baisa, sum, type Baisa } from './money';
import type { EpochMs } from './datetime';
import type { ReservationStatus } from './availability';
import { withinPeriod, type Period } from './financial-reporting';

/* ------------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------------ */

/** One dress on one booking, as `reservationItems` froze it. */
export interface RentedLine {
  readonly reservationId: string;
  readonly dressId: string;
  readonly dressCode: string;
  readonly dressName: string;
  /** The price agreed at booking. Never re-read from the catalogue. */
  readonly rentalPriceSnapshot: Baisa;
  readonly pickupAt: EpochMs;
}

/** A booking, reduced to what reporting needs. */
export interface ReportedReservation {
  readonly id: string;
  readonly code: string;
  readonly status: ReservationStatus;
  readonly pickupAt: EpochMs;
  /** Net rental collected against this booking within the period. */
  readonly netCollected: Baisa;
  readonly accessorySubtotal: Baisa;
  readonly alterationSubtotal: Baisa;
}

/* ------------------------------------------------------------------------ *
 * Weighted allocation
 * ------------------------------------------------------------------------ */

/**
 * Split an amount in proportion to weights, in whole baisa, losing nothing.
 *
 * Largest remainder: every part gets its floor, then the baisa left over go to
 * the parts with the largest fractional remainders. The result always sums to
 * the input, which is the property that matters — a report whose rows do not
 * add up to its own total destroys confidence in every other figure on the page.
 *
 * With no weight at all (every line free of charge) the amount is spread as
 * evenly as it divides, because it did come from somewhere.
 */
export function allocateByWeight(amount: Baisa, weights: readonly number[]): Baisa[] {
  if (weights.length === 0) return [];
  if (amount === 0) return weights.map(() => baisa(0));

  const total = weights.reduce((running, weight) => running + Math.max(0, weight), 0);

  const effective = total > 0 ? weights.map((weight) => Math.max(0, weight)) : weights.map(() => 1);
  const effectiveTotal = total > 0 ? total : weights.length;

  const exact = effective.map((weight) => (amount * weight) / effectiveTotal);
  const floors = exact.map((value) => Math.floor(value));

  let remainder = amount - floors.reduce((running, value) => running + value, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const parts = [...floors];

  for (const entry of order) {
    if (remainder <= 0) break;
    parts[entry.index] = (parts[entry.index] ?? 0) + 1;
    remainder -= 1;
  }

  return parts.map((value) => baisa(value));
}

/* ------------------------------------------------------------------------ *
 * Revenue by dress
 * ------------------------------------------------------------------------ */

export interface DressRevenueRow {
  readonly dressId: string;
  readonly dressCode: string;
  readonly dressName: string;
  /** Rentals whose pickup fell inside the period. */
  readonly rentals: number;
  /** Attributed net rental revenue. Deposits excluded. */
  readonly revenue: Baisa;
}

/**
 * Attribute each booking's net collection to the gowns on it.
 *
 * A booking with no lines contributes nothing rather than disappearing into a
 * rounding error — its revenue simply has no dress to attach to, and a row
 * that claimed otherwise would be an invention.
 */
export function revenueByDress(input: {
  readonly reservations: readonly ReportedReservation[];
  readonly lines: readonly RentedLine[];
  readonly period: Period;
}): DressRevenueRow[] {
  const byDress = new Map<string, { row: DressRevenueRow; revenue: number; rentals: number }>();

  const linesByReservation = new Map<string, RentedLine[]>();
  for (const line of input.lines) {
    const bucket = linesByReservation.get(line.reservationId);
    if (bucket === undefined) {
      linesByReservation.set(line.reservationId, [line]);
    } else {
      bucket.push(line);
    }
  }

  for (const reservation of input.reservations) {
    const lines = linesByReservation.get(reservation.id) ?? [];
    if (lines.length === 0) continue;

    const shares = allocateByWeight(
      reservation.netCollected,
      lines.map((line) => line.rentalPriceSnapshot),
    );

    lines.forEach((line, index) => {
      const counts = withinPeriod(line.pickupAt, input.period);

      const existing = byDress.get(line.dressId) ?? {
        row: {
          dressId: line.dressId,
          dressCode: line.dressCode,
          dressName: line.dressName,
          rentals: 0,
          revenue: baisa(0),
        },
        revenue: 0,
        rentals: 0,
      };

      byDress.set(line.dressId, {
        row: existing.row,
        revenue: existing.revenue + (shares[index] ?? 0),
        rentals: existing.rentals + (counts ? 1 : 0),
      });
    });
  }

  return [...byDress.values()]
    .map((entry) => ({
      ...entry.row,
      rentals: entry.rentals,
      revenue: baisa(entry.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue || a.dressCode.localeCompare(b.dressCode));
}

/**
 * The most rented gowns in a period, by count of collections.
 *
 * Ranked by rentals rather than revenue on purpose: "most rented" and "highest
 * earning" are different questions, and a boutique needs both. Ties break on
 * code so the order does not shuffle between renders.
 */
export function topRented(rows: readonly DressRevenueRow[], limit = 10): DressRevenueRow[] {
  return rows
    .filter((row) => row.rentals > 0)
    .slice()
    .sort((a, b) => b.rentals - a.rentals || a.dressCode.localeCompare(b.dressCode))
    .slice(0, limit);
}

/* ------------------------------------------------------------------------ *
 * Counts
 * ------------------------------------------------------------------------ */

export interface CancellationCounts {
  readonly cancelled: number;
  readonly noShow: number;
  readonly completed: number;
  /**
   * Cancellations and no-shows as a share of bookings that reached a
   * conclusion, 0–100. `null` when nothing concluded in the period — a rate
   * computed from no bookings is not zero, it is unanswerable.
   */
  readonly ratePercent: number | null;
}

export function cancellationCounts(
  reservations: readonly ReportedReservation[],
  period: Period,
): CancellationCounts {
  const inPeriod = reservations.filter((reservation) =>
    withinPeriod(reservation.pickupAt, period),
  );

  const cancelled = inPeriod.filter((entry) => entry.status === 'Cancelled').length;
  const noShow = inPeriod.filter((entry) => entry.status === 'No-Show').length;
  const completed = inPeriod.filter(
    (entry) => entry.status === 'Returned' || entry.status === 'Closed',
  ).length;

  const concluded = cancelled + noShow + completed;

  return {
    cancelled,
    noShow,
    completed,
    ratePercent: concluded === 0 ? null : Math.round(((cancelled + noShow) / concluded) * 100),
  };
}

/* ------------------------------------------------------------------------ *
 * Accessories and alterations
 * ------------------------------------------------------------------------ */

export interface AncillaryRevenue {
  /** Agreed accessory charges on bookings collected in the period. */
  readonly accessories: Baisa;
  readonly alterations: Baisa;
  readonly total: Baisa;
  /** How many bookings carried any of either. */
  readonly bookings: number;
}

/**
 * What accessories and alterations were agreed on the period's bookings.
 *
 * These are **agreed charges**, not cash — the ledger records payments against
 * a reservation as a whole and cannot say which part of a payment settled a
 * veil. Reporting them as agreed is honest; splitting a payment across the
 * lines of a bill would be arithmetic dressed up as fact.
 *
 * Cancelled and no-show bookings are excluded: nothing was supplied.
 */
export function ancillaryRevenue(
  reservations: readonly ReportedReservation[],
  period: Period,
): AncillaryRevenue {
  const inPeriod = reservations.filter(
    (reservation) =>
      withinPeriod(reservation.pickupAt, period) &&
      reservation.status !== 'Cancelled' &&
      reservation.status !== 'No-Show',
  );

  const accessories = sum(inPeriod.map((entry) => entry.accessorySubtotal));
  const alterations = sum(inPeriod.map((entry) => entry.alterationSubtotal));

  return {
    accessories,
    alterations,
    total: sum([accessories, alterations]),
    bookings: inPeriod.filter(
      (entry) => entry.accessorySubtotal > 0 || entry.alterationSubtotal > 0,
    ).length,
  };
}
