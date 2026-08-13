import { describe, expect, it } from 'vitest';

import { fromMuscatWallTime, startOfMuscatDay } from './datetime';
import { baisa } from './money';
import {
  CancellationError,
  daysOfNotice,
  eventInstant,
  quoteCancellation,
  selectTier,
  type CancellationTier,
} from './cancellation';

/** A representative scale. The boutique configures its own; nothing is hard-coded. */
const TIERS: CancellationTier[] = [
  {
    daysBeforeEvent: 30,
    refundPercent: 100,
    label: { en: '30 days or more', ar: '٣٠ يومًا أو أكثر' },
  },
  { daysBeforeEvent: 14, refundPercent: 50, label: { en: '14–29 days', ar: '١٤–٢٩ يومًا' } },
  { daysBeforeEvent: 7, refundPercent: 25, label: { en: '7–13 days', ar: '٧–١٣ يومًا' } },
];

const EVENT = startOfMuscatDay('2026-09-20');
const on = (date: string) => fromMuscatWallTime(`${date}T10:00`);

function quote(
  cancelledOn: string,
  overrides: Partial<Parameters<typeof quoteCancellation>[0]> = {},
) {
  return quoteCancellation({
    cancelledAt: on(cancelledOn),
    eventAt: EVENT,
    tiers: TIERS,
    chargesBeforeCancellation: baisa(200_000),
    paidBeforeCancellation: baisa(200_000),
    depositHeld: baisa(100_000),
    ...overrides,
  });
}

/* ------------------------------------------------------------------------ *
 * Tier selection
 * ------------------------------------------------------------------------ */

describe('selecting a tier', () => {
  it('picks the most generous tier the notice qualifies for', () => {
    expect(selectTier(TIERS, 45)?.refundPercent).toBe(100);
    expect(selectTier(TIERS, 30)?.refundPercent).toBe(100);
    expect(selectTier(TIERS, 29)?.refundPercent).toBe(50);
    expect(selectTier(TIERS, 14)?.refundPercent).toBe(50);
    expect(selectTier(TIERS, 13)?.refundPercent).toBe(25);
    expect(selectTier(TIERS, 7)?.refundPercent).toBe(25);
  });

  it('matches no tier below the shortest notice', () => {
    expect(selectTier(TIERS, 6)).toBeNull();
    expect(selectTier(TIERS, 0)).toBeNull();
  });

  it('matches no tier when the boutique has configured none', () => {
    // Refunding by default on a misconfiguration would give money away.
    expect(selectTier([], 365)).toBeNull();
  });

  it('does not depend on the order the tiers were configured in', () => {
    const shuffled = [TIERS[2]!, TIERS[0]!, TIERS[1]!];
    expect(selectTier(shuffled, 20)?.refundPercent).toBe(50);
  });
});

/* ------------------------------------------------------------------------ *
 * Notice
 * ------------------------------------------------------------------------ */

describe('measuring notice', () => {
  it('counts calendar days in Muscat, not elapsed hours', () => {
    // Both are "the 6th", so both give the same answer regardless of the hour.
    expect(daysOfNotice(fromMuscatWallTime('2026-09-06T08:00'), EVENT)).toBe(14);
    expect(daysOfNotice(fromMuscatWallTime('2026-09-06T23:00'), EVENT)).toBe(14);
  });

  it('is zero on the day of the event', () => {
    expect(daysOfNotice(on('2026-09-20'), EVENT)).toBe(0);
  });

  it('is one the day before the event', () => {
    expect(daysOfNotice(on('2026-09-19'), EVENT)).toBe(1);
  });

  it('is zero, never negative, after the event has passed', () => {
    expect(daysOfNotice(on('2026-10-01'), EVENT)).toBe(0);
  });

  it('resolves an event date string to the start of that Muscat day', () => {
    expect(eventInstant('2026-09-20')).toBe(EVENT);
  });
});

/* ------------------------------------------------------------------------ *
 * Tier boundaries — the cases that get argued about
 * ------------------------------------------------------------------------ */

describe('each tier boundary', () => {
  const boundaries: { date: string; notice: number; percent: number }[] = [
    { date: '2026-08-21', notice: 30, percent: 100 },
    { date: '2026-08-22', notice: 29, percent: 50 },
    { date: '2026-09-06', notice: 14, percent: 50 },
    { date: '2026-09-07', notice: 13, percent: 25 },
    { date: '2026-09-13', notice: 7, percent: 25 },
    { date: '2026-09-14', notice: 6, percent: 0 },
  ];

  for (const { date, notice, percent } of boundaries) {
    it(`gives ${percent}% at ${notice} days' notice (cancelled ${date})`, () => {
      const result = quote(date);

      expect(result.daysOfNotice).toBe(notice);
      expect(result.refundPercent).toBe(percent);
    });
  }

  it('gives nothing back when cancelled the day before the event', () => {
    expect(quote('2026-09-19').refundPercent).toBe(0);
  });

  it('gives nothing back when cancelled on the event date', () => {
    expect(quote('2026-09-20').refundPercent).toBe(0);
  });

  it('gives nothing back when cancelled after the event', () => {
    expect(quote('2026-09-25').refundPercent).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * The money
 * ------------------------------------------------------------------------ */

describe('the amounts', () => {
  it('keeps nothing and returns everything at full notice', () => {
    const result = quote('2026-08-01');

    expect(result.cancellationCharge).toBe(0);
    expect(result.waivedCharges).toBe(200_000);
    expect(result.rentalRefundDue).toBe(200_000);
    expect(result.stillOwed).toBe(0);
  });

  it('splits the charge at a half-refund tier', () => {
    const result = quote('2026-09-06');

    expect(result.cancellationCharge).toBe(100_000);
    expect(result.waivedCharges).toBe(100_000);
    expect(result.rentalRefundDue).toBe(100_000);
  });

  it('keeps everything when no tier applies', () => {
    const result = quote('2026-09-19');

    expect(result.cancellationCharge).toBe(200_000);
    expect(result.waivedCharges).toBe(0);
    expect(result.rentalRefundDue).toBe(0);
  });

  it('returns the deposit in full — cancelling damages nothing', () => {
    const result = quote('2026-09-19');

    expect(result.depositTreatment).toBe('Returned in full');
    expect(result.depositRefundDue).toBe(100_000);
  });

  it('adds the deposit to the total the customer gets back', () => {
    const result = quote('2026-09-06');

    expect(result.totalRefundDue).toBe(100_000 + 100_000);
  });

  it('reports what is still owed when the customer had not paid in full', () => {
    const result = quote('2026-09-19', { paidBeforeCancellation: baisa(50_000) });

    expect(result.cancellationCharge).toBe(200_000);
    expect(result.stillOwed).toBe(150_000);
    expect(result.rentalRefundDue).toBe(0);
  });

  it('never reports both a refund and an amount owed', () => {
    for (const date of ['2026-08-01', '2026-09-06', '2026-09-19']) {
      for (const paid of [0, 50_000, 200_000]) {
        const result = quote(date, { paidBeforeCancellation: baisa(paid) });
        expect(result.rentalRefundDue > 0 && result.stillOwed > 0).toBe(false);
      }
    }
  });

  it('makes the charge and the waiver add up to the original exactly', () => {
    // Rounding each half independently could miss by a baisa. It must not.
    for (const charge of [1, 2, 5, 999, 1_001, 200_001, 999_999]) {
      const result = quote('2026-09-06', { chargesBeforeCancellation: baisa(charge) });

      expect(result.cancellationCharge + result.waivedCharges).toBe(charge);
    }
  });

  it('handles an odd amount at 25% without losing a baisa', () => {
    const result = quote('2026-09-10', { chargesBeforeCancellation: baisa(999) });

    expect(result.refundPercent).toBe(25);
    expect(result.cancellationCharge + result.waivedCharges).toBe(999);
  });

  it('handles a zero-value reservation', () => {
    const result = quote('2026-09-06', {
      chargesBeforeCancellation: baisa(0),
      paidBeforeCancellation: baisa(0),
      depositHeld: baisa(0),
    });

    expect(result.cancellationCharge).toBe(0);
    expect(result.totalRefundDue).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Bad configuration
 * ------------------------------------------------------------------------ */

describe('refusing bad tiers', () => {
  it('refuses a refund above 100%', () => {
    expect(() =>
      quote('2026-09-06', {
        tiers: [{ daysBeforeEvent: 1, refundPercent: 150, label: { en: '', ar: '' } }],
      }),
    ).toThrow(CancellationError);
  });

  it('refuses a negative refund percentage', () => {
    expect(() =>
      quote('2026-09-06', {
        tiers: [{ daysBeforeEvent: 1, refundPercent: -10, label: { en: '', ar: '' } }],
      }),
    ).toThrow(CancellationError);
  });

  it('refuses a negative notice period', () => {
    expect(() =>
      quote('2026-09-06', {
        tiers: [{ daysBeforeEvent: -5, refundPercent: 50, label: { en: '', ar: '' } }],
      }),
    ).toThrow(CancellationError);
  });
});
