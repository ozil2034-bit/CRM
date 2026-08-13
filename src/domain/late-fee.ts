/**
 * Late return fees.
 *
 * A gown returned late costs the boutique the next booking, so the fee is real
 * money and must be computed the same way every time. The rate is configured,
 * never hard-coded, and the result is **snapshotted** when it is posted: raising
 * the daily rate next month must not silently re-price a fee already agreed with
 * a customer last month.
 *
 * Pure: `now` is a parameter, so a test can assert a three-day fee without
 * touching the system clock.
 */

import { daysLate, type EpochMs } from './datetime';
import { baisa, multiply, ZERO, type Baisa } from './money';

export class LateFeeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LateFeeError';
  }
}

/**
 * A computed late fee, frozen at the moment it is posted.
 *
 * `dailyRate` and `lateDays` are kept alongside `amount` so the charge can be
 * explained to a customer months later, and so a rate change cannot make the
 * stored figure unexplainable.
 */
export interface LateFeeSnapshot {
  readonly lateDays: number;
  readonly dailyRate: Baisa;
  readonly amount: Baisa;
  readonly scheduledReturnAt: EpochMs;
  readonly actualReturnAt: EpochMs;
  readonly calculatedAt: EpochMs;
}

/**
 * Work out what a late return costs.
 *
 * Late days are counted by `daysLate`, which rounds **up**: a gown eleven hours
 * overdue is a day late, because the boutique has lost the day either way. A
 * return on or before the scheduled instant is not late at all, and produces a
 * zero fee rather than a negative one.
 *
 * @throws LateFeeError if the rate is not a whole, non-negative number of baisa.
 */
export function computeLateFee(input: {
  readonly scheduledReturnAt: EpochMs;
  readonly actualReturnAt: EpochMs;
  readonly dailyRate: Baisa;
  readonly calculatedAt: EpochMs;
}): LateFeeSnapshot {
  if (!Number.isInteger(input.dailyRate) || input.dailyRate < 0) {
    throw new LateFeeError(
      `The daily late fee must be a whole, non-negative number of baisa, received: ${input.dailyRate}`,
    );
  }

  const lateDays = daysLate(input.scheduledReturnAt, input.actualReturnAt);

  return {
    lateDays,
    dailyRate: input.dailyRate,
    amount: lateDays === 0 ? ZERO : multiply(input.dailyRate, lateDays),
    scheduledReturnAt: input.scheduledReturnAt,
    actualReturnAt: input.actualReturnAt,
    calculatedAt: input.calculatedAt,
  };
}

/**
 * Is there anything to charge?
 *
 * Posting a zero-baisa fee would put a line on an invoice that says the customer
 * was late and owes nothing, which invites an argument the boutique does not
 * need. A zero fee is simply not posted.
 */
export function isChargeable(snapshot: LateFeeSnapshot): boolean {
  return snapshot.amount > 0;
}

/** Restore a stored snapshot, validating it rather than trusting it. */
export function parseLateFeeSnapshot(value: unknown): LateFeeSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;

  const record = value as Record<string, unknown>;
  const numbers = [
    'lateDays',
    'dailyRate',
    'amount',
    'scheduledReturnAt',
    'actualReturnAt',
    'calculatedAt',
  ];

  for (const key of numbers) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) return null;
  }

  return {
    lateDays: record['lateDays'] as number,
    dailyRate: baisa(record['dailyRate'] as number),
    amount: baisa(record['amount'] as number),
    scheduledReturnAt: record['scheduledReturnAt'] as number,
    actualReturnAt: record['actualReturnAt'] as number,
    calculatedAt: record['calculatedAt'] as number,
  };
}
