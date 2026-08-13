/**
 * Reporting foundations.
 *
 * Phase 7 builds the reports screen. This module is what it will read: the
 * aggregations themselves, as pure functions over events, so the figures on a
 * report are produced by the same code that produces the figures on a
 * reservation. A report with its own arithmetic is a report that disagrees with
 * the ledger, and the disagreement is always discovered in front of the owner.
 *
 * Pure: no I/O, no clock. The period is a parameter.
 */

import { baisa, sum, type Baisa } from './money';
import type { EpochMs } from './datetime';
import type { FinancialEvent } from './ledger';

export interface Period {
  /** Inclusive. */
  readonly from: EpochMs;
  /** Exclusive, so consecutive periods neither overlap nor leave a gap. */
  readonly to: EpochMs;
}

/** Half-open, for the same reason booking intervals are. */
export function withinPeriod(instant: EpochMs, period: Period): boolean {
  return instant >= period.from && instant < period.to;
}

/**
 * What the boutique took, gave back and is holding over a period.
 *
 * Every figure is a **cash movement**, dated by when it happened rather than by
 * which reservation it belongs to. A payment in March for a September wedding
 * is March's collection: that is what reconciles against the till.
 */
export interface FinancialSummary {
  /** Rental money received, before reversals. */
  readonly grossCollected: Baisa;
  /** Payments cancelled as recording errors — never money that moved. */
  readonly reversed: Baisa;
  /** Money returned on the rental account. */
  readonly refunded: Baisa;
  /** What the boutique actually kept: gross − reversals − refunds. */
  readonly netCollected: Baisa;

  /** Security deposits taken in. Not revenue. */
  readonly depositsCollected: Baisa;
  readonly depositsReturned: Baisa;
  readonly depositsForfeited: Baisa;
  /** Deposits still in hand from movements in this period. */
  readonly depositsNet: Baisa;

  /** Late fees charged (not necessarily paid). */
  readonly lateFeesCharged: Baisa;
  /** Charges relieved by cancellation. */
  readonly chargesWaived: Baisa;

  readonly eventCount: number;
}

/**
 * Summarise a period.
 *
 * Deposits are reported separately from revenue throughout. A deposit is the
 * customer's money; counting it as income would overstate what the boutique
 * earned and understate what it owes back.
 */
export function summarise(events: readonly FinancialEvent[], period: Period): FinancialSummary {
  const inPeriod = events.filter((event) => withinPeriod(event.occurredAt, period));

  const total = (kind: FinancialEvent['kind']): Baisa =>
    sum(inPeriod.filter((event) => event.kind === kind).map((event) => event.amount));

  const grossCollected = total('Payment');
  const reversed = total('PaymentReversal');
  const refunded = total('Refund');

  const depositsCollected = total('SecurityDepositPayment');
  const depositsReturned = total('SecurityDepositRefund');
  const depositsForfeited = total('SecurityDepositForfeiture');

  return {
    grossCollected,
    reversed,
    refunded,
    netCollected: baisa(grossCollected - reversed - refunded),
    depositsCollected,
    depositsReturned,
    depositsForfeited,
    depositsNet: baisa(depositsCollected - depositsReturned - depositsForfeited),
    lateFeesCharged: total('LateFee'),
    chargesWaived: total('ChargeWaiver'),
    eventCount: inPeriod.length,
  };
}

/** Cash taken, split by how it was tendered — for reconciling the till. */
export function collectedByMethod(
  events: readonly FinancialEvent[],
  period: Period,
): Record<string, Baisa> {
  const totals: Record<string, number> = {};

  for (const event of events) {
    if (!withinPeriod(event.occurredAt, period)) continue;
    if (event.method === null) continue;

    /*
     * Money in counts positive and money out negative, so each method's line is
     * what that tender should actually be up by. A cash drawer counted at the
     * end of the day has to match this, not the gross figure.
     */
    const direction =
      event.kind === 'Payment' || event.kind === 'SecurityDepositPayment'
        ? 1
        : event.kind === 'Refund' ||
            event.kind === 'PaymentReversal' ||
            event.kind === 'SecurityDepositRefund'
          ? -1
          : 0;

    if (direction === 0) continue;

    totals[event.method] = (totals[event.method] ?? 0) + direction * event.amount;
  }

  const result: Record<string, Baisa> = {};
  for (const [method, value] of Object.entries(totals)) {
    result[method] = baisa(value);
  }
  return result;
}

/**
 * One reservation's contribution to what is still owed.
 *
 * Kept as a shape rather than a number so the Phase 7 report can list the
 * bookings behind an outstanding total — an owner asking "who owes us OMR 400"
 * needs the names, not the sum.
 */
export interface OutstandingRow {
  readonly reservationId: string;
  readonly reservationCode: string;
  readonly customerId: string;
  readonly outstanding: Baisa;
  readonly depositHeld: Baisa;
}

export function totalOutstanding(rows: readonly OutstandingRow[]): Baisa {
  return sum(rows.map((row) => row.outstanding));
}

export function totalDepositsHeld(rows: readonly OutstandingRow[]): Baisa {
  return sum(rows.map((row) => row.depositHeld));
}
