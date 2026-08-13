/**
 * Negative testing for the financial guards (§39).
 *
 * Almost every test here asserts a **refusal**. That is the point: a financial
 * validator that only proves the happy path proves nothing, because the whole
 * job is stopping the amounts that should never be posted.
 */

import { describe, expect, it } from 'vitest';

import { baisa } from './money';
import { computePricing, NO_DISCOUNT } from './reservation-pricing';
import {
  emptyPosition,
  reduceLedger,
  type FinancialEvent,
  type FinancialEventKind,
} from './ledger';
import {
  isPermittedVatRate,
  isUsableIdempotencyKey,
  OWNER_ONLY_FINANCIAL_OPERATIONS,
  PERMITTED_VAT_RATES,
  refuseDepositPayment,
  refuseDepositSettlement,
  refusePayment,
  refuseRefund,
  refuseReversal,
  requiresOwner,
} from './financial-operations';

let sequence = 0;

function event(kind: FinancialEventKind, amount: number): FinancialEvent {
  sequence += 1;
  return {
    id: `e-${sequence}`,
    reservationId: 'rsv-1',
    kind,
    amount: baisa(amount),
    method: 'Cash',
    type: null,
    occurredAt: 1_700_000_000_000,
    reference: '',
    reason: '',
    employeeId: 'staff-1',
    reversesEventId: null,
    idempotencyKey: `k-${sequence}`,
  };
}

/** OMR 200.000 rental, OMR 100.000 deposit, 5% VAT → 210.000 chargeable. */
const PRICING = computePricing({
  items: [
    {
      dressId: 'd-1',
      dressCode: 'WD-0001',
      dressName: 'Aurora',
      designer: '',
      rentalPrice: baisa(200_000),
      securityDeposit: baisa(100_000),
      cleaningBufferDays: 3,
    },
  ],
  accessories: [],
  alterations: [],
  discount: NO_DISCOUNT,
  vatRatePercent: 5,
});

const UNPAID = emptyPosition(PRICING);

/* ------------------------------------------------------------------------ *
 * Payments
 * ------------------------------------------------------------------------ */

describe('recording a payment', () => {
  it('accepts a payment within the balance', () => {
    expect(refusePayment(100_000, UNPAID)).toBeNull();
  });

  it('accepts a payment for exactly the balance', () => {
    expect(refusePayment(210_000, UNPAID)).toBeNull();
  });

  it('accepts a single baisa', () => {
    expect(refusePayment(1, UNPAID)).toBeNull();
  });

  it('REFUSES a zero payment', () => {
    expect(refusePayment(0, UNPAID)).toBe('AMOUNT_NOT_POSITIVE');
  });

  it('REFUSES a negative payment', () => {
    expect(refusePayment(-100_000, UNPAID)).toBe('AMOUNT_NOT_POSITIVE');
  });

  it('REFUSES a fractional baisa', () => {
    expect(refusePayment(100.5, UNPAID)).toBe('AMOUNT_NOT_WHOLE_BAISA');
  });

  it('REFUSES NaN and Infinity', () => {
    expect(refusePayment(Number.NaN, UNPAID)).toBe('AMOUNT_NOT_POSITIVE');
    expect(refusePayment(Number.POSITIVE_INFINITY, UNPAID)).toBe('AMOUNT_NOT_POSITIVE');
  });

  it('REFUSES an overpayment — almost always a typing error', () => {
    expect(refusePayment(210_001, UNPAID)).toBe('AMOUNT_EXCEEDS_OUTSTANDING');
  });

  it('REFUSES a payment ten times too large', () => {
    expect(refusePayment(2_100_000, UNPAID)).toBe('AMOUNT_EXCEEDS_OUTSTANDING');
  });

  it('REFUSES a payment against a settled reservation', () => {
    const settled = reduceLedger(PRICING, [event('Payment', 210_000)]);

    expect(refusePayment(1, settled)).toBe('NOTHING_OUTSTANDING');
  });

  it('narrows the ceiling as payments accumulate', () => {
    const partly = reduceLedger(PRICING, [event('Payment', 200_000)]);

    expect(refusePayment(10_000, partly)).toBeNull();
    expect(refusePayment(10_001, partly)).toBe('AMOUNT_EXCEEDS_OUTSTANDING');
  });

  it('allows a payment again once a late fee reopens the balance', () => {
    const reopened = reduceLedger(PRICING, [event('Payment', 210_000), event('LateFee', 20_000)]);

    expect(refusePayment(20_000, reopened)).toBeNull();
    expect(refusePayment(20_001, reopened)).toBe('AMOUNT_EXCEEDS_OUTSTANDING');
  });
});

/* ------------------------------------------------------------------------ *
 * Deposit collection
 * ------------------------------------------------------------------------ */

describe('collecting a security deposit', () => {
  it('accepts the full deposit', () => {
    expect(refuseDepositPayment(100_000, UNPAID)).toBeNull();
  });

  it('accepts it in instalments', () => {
    const half = reduceLedger(PRICING, [event('SecurityDepositPayment', 60_000)]);

    expect(refuseDepositPayment(40_000, half)).toBeNull();
  });

  it('REFUSES zero and negative amounts', () => {
    expect(refuseDepositPayment(0, UNPAID)).toBe('AMOUNT_NOT_POSITIVE');
    expect(refuseDepositPayment(-1, UNPAID)).toBe('AMOUNT_NOT_POSITIVE');
  });

  it('REFUSES a fractional baisa', () => {
    expect(refuseDepositPayment(0.5, UNPAID)).toBe('AMOUNT_NOT_WHOLE_BAISA');
  });

  it('REFUSES collecting more than the deposit for this reservation', () => {
    expect(refuseDepositPayment(100_001, UNPAID)).toBe('EXCEEDS_DEPOSIT_DUE');
  });

  it('REFUSES an instalment that would over-collect', () => {
    const most = reduceLedger(PRICING, [event('SecurityDepositPayment', 90_000)]);

    expect(refuseDepositPayment(10_000, most)).toBeNull();
    expect(refuseDepositPayment(10_001, most)).toBe('EXCEEDS_DEPOSIT_DUE');
  });

  it('REFUSES collecting again once the deposit is fully held', () => {
    const held = reduceLedger(PRICING, [event('SecurityDepositPayment', 100_000)]);

    expect(refuseDepositPayment(1, held)).toBe('EXCEEDS_DEPOSIT_DUE');
  });
});

/* ------------------------------------------------------------------------ *
 * Refunds
 * ------------------------------------------------------------------------ */

describe('paying a refund', () => {
  /** Paid in full, then cancelled with a full waiver — 210.000 refundable. */
  const refundable = reduceLedger(PRICING, [
    event('Payment', 210_000),
    event('ChargeWaiver', 210_000),
  ]);

  it('accepts a refund within the refundable amount', () => {
    expect(refuseRefund(100_000, refundable)).toBeNull();
  });

  it('accepts a refund for exactly the refundable amount', () => {
    expect(refuseRefund(210_000, refundable)).toBeNull();
  });

  it('REFUSES zero and negative refunds', () => {
    expect(refuseRefund(0, refundable)).toBe('AMOUNT_NOT_POSITIVE');
    expect(refuseRefund(-100_000, refundable)).toBe('AMOUNT_NOT_POSITIVE');
  });

  it('REFUSES a fractional baisa', () => {
    expect(refuseRefund(1.5, refundable)).toBe('AMOUNT_NOT_WHOLE_BAISA');
  });

  it('REFUSES refunding more than was ever held', () => {
    expect(refuseRefund(210_001, refundable)).toBe('EXCEEDS_REFUNDABLE');
  });

  it('REFUSES a refund when the customer still owes money', () => {
    const owing = reduceLedger(PRICING, [event('Payment', 50_000)]);

    expect(refuseRefund(1, owing)).toBe('NOTHING_REFUNDABLE');
  });

  it('REFUSES a refund on a reservation where nothing was paid', () => {
    expect(refuseRefund(1, UNPAID)).toBe('NOTHING_REFUNDABLE');
  });

  it('REFUSES the SECOND full refund — no double refunding', () => {
    const alreadyRefunded = reduceLedger(PRICING, [
      event('Payment', 210_000),
      event('ChargeWaiver', 210_000),
      event('Refund', 210_000),
    ]);

    expect(refuseRefund(1, alreadyRefunded)).toBe('NOTHING_REFUNDABLE');
  });

  it('REFUSES a second refund that would exceed what remains', () => {
    const partly = reduceLedger(PRICING, [
      event('Payment', 210_000),
      event('ChargeWaiver', 210_000),
      event('Refund', 150_000),
    ]);

    expect(refuseRefund(60_000, partly)).toBeNull();
    expect(refuseRefund(60_001, partly)).toBe('EXCEEDS_REFUNDABLE');
  });
});

/* ------------------------------------------------------------------------ *
 * Deposit settlement
 * ------------------------------------------------------------------------ */

describe('returning or keeping a deposit', () => {
  const held = reduceLedger(PRICING, [event('SecurityDepositPayment', 100_000)]);

  const settle = (amount: number, forfeiting = false, reason = 'Torn hem') =>
    refuseDepositSettlement({ amount, position: held, forfeiting, reason });

  it('accepts returning the whole deposit', () => {
    expect(settle(100_000)).toBeNull();
  });

  it('accepts keeping part of it with a reason', () => {
    expect(settle(30_000, true, 'Beading damaged')).toBeNull();
  });

  it('REFUSES zero and negative amounts', () => {
    expect(settle(0)).toBe('AMOUNT_NOT_POSITIVE');
    expect(settle(-30_000)).toBe('AMOUNT_NOT_POSITIVE');
  });

  it('REFUSES a fractional baisa', () => {
    expect(settle(0.25)).toBe('AMOUNT_NOT_WHOLE_BAISA');
  });

  it('REFUSES returning more than is held', () => {
    expect(settle(100_001)).toBe('EXCEEDS_HELD');
  });

  it('REFUSES keeping more than is held', () => {
    expect(settle(100_001, true)).toBe('EXCEEDS_HELD');
  });

  it('REFUSES anything when no deposit was collected', () => {
    expect(
      refuseDepositSettlement({ amount: 1, position: UNPAID, forfeiting: false, reason: '' }),
    ).toBe('NOTHING_HELD');
  });

  it('REFUSES a second settlement that would exceed what remains', () => {
    const partly = reduceLedger(PRICING, [
      event('SecurityDepositPayment', 100_000),
      event('SecurityDepositRefund', 70_000),
    ]);

    const remaining = (amount: number) =>
      refuseDepositSettlement({ amount, position: partly, forfeiting: false, reason: '' });

    expect(remaining(30_000)).toBeNull();
    expect(remaining(30_001)).toBe('EXCEEDS_HELD');
  });

  it('REFUSES forfeiture without a reason', () => {
    expect(settle(30_000, true, '')).toBe('REASON_REQUIRED');
    expect(settle(30_000, true, '   ')).toBe('REASON_REQUIRED');
  });

  it('does not demand a reason to give the money back', () => {
    expect(settle(30_000, false, '')).toBeNull();
  });

  it('enforces refunded + forfeited ≤ deposit across a mixed sequence', () => {
    const mixed = reduceLedger(PRICING, [
      event('SecurityDepositPayment', 100_000),
      event('SecurityDepositForfeiture', 40_000),
      event('SecurityDepositRefund', 50_000),
    ]);

    const remaining = (amount: number, forfeiting: boolean) =>
      refuseDepositSettlement({ amount, position: mixed, forfeiting, reason: 'x' });

    expect(mixed.depositHeld).toBe(10_000);
    expect(remaining(10_000, false)).toBeNull();
    expect(remaining(10_001, false)).toBe('EXCEEDS_HELD');
    expect(remaining(10_001, true)).toBe('EXCEEDS_HELD');
  });
});

/* ------------------------------------------------------------------------ *
 * Reversal
 * ------------------------------------------------------------------------ */

describe('reversing a payment', () => {
  it('accepts reversing a payment with a reason', () => {
    expect(
      refuseReversal({ targetKind: 'Payment', alreadyReversed: false, reason: 'Wrong booking' }),
    ).toBeNull();
  });

  it('accepts reversing a deposit payment', () => {
    expect(
      refuseReversal({
        targetKind: 'SecurityDepositPayment',
        alreadyReversed: false,
        reason: 'Entered twice',
      }),
    ).toBeNull();
  });

  it('REFUSES reversing an event that does not exist', () => {
    expect(refuseReversal({ targetKind: null, alreadyReversed: false, reason: 'x' })).toBe(
      'EVENT_NOT_FOUND',
    );
  });

  it('REFUSES reversing a refund — money genuinely moved', () => {
    expect(refuseReversal({ targetKind: 'Refund', alreadyReversed: false, reason: 'x' })).toBe(
      'NOT_REVERSIBLE',
    );
  });

  it('REFUSES reversing a reversal', () => {
    expect(
      refuseReversal({ targetKind: 'PaymentReversal', alreadyReversed: false, reason: 'x' }),
    ).toBe('NOT_REVERSIBLE');
  });

  it('REFUSES reversing a late fee or a waiver', () => {
    expect(refuseReversal({ targetKind: 'LateFee', alreadyReversed: false, reason: 'x' })).toBe(
      'NOT_REVERSIBLE',
    );
    expect(
      refuseReversal({ targetKind: 'ChargeWaiver', alreadyReversed: false, reason: 'x' }),
    ).toBe('NOT_REVERSIBLE');
  });

  it('REFUSES reversing the same payment twice', () => {
    expect(refuseReversal({ targetKind: 'Payment', alreadyReversed: true, reason: 'x' })).toBe(
      'ALREADY_REVERSED',
    );
  });

  it('REFUSES a reversal with no reason', () => {
    expect(refuseReversal({ targetKind: 'Payment', alreadyReversed: false, reason: '  ' })).toBe(
      'REASON_REQUIRED',
    );
  });
});

/* ------------------------------------------------------------------------ *
 * Idempotency
 * ------------------------------------------------------------------------ */

describe('idempotency keys', () => {
  it('accepts a key of usable length', () => {
    expect(isUsableIdempotencyKey('a1b2c3d4e5f6')).toBe(true);
  });

  it('REFUSES a missing key rather than inventing one', () => {
    // A server-generated key would make every retry a fresh payment, which is
    // exactly what the mechanism exists to prevent.
    expect(isUsableIdempotencyKey(undefined)).toBe(false);
    expect(isUsableIdempotencyKey(null)).toBe(false);
  });

  it('REFUSES a blank or trivially short key', () => {
    expect(isUsableIdempotencyKey('')).toBe(false);
    expect(isUsableIdempotencyKey('        ')).toBe(false);
    expect(isUsableIdempotencyKey('abc')).toBe(false);
  });

  it('REFUSES an absurdly long key', () => {
    expect(isUsableIdempotencyKey('x'.repeat(201))).toBe(false);
  });

  it('REFUSES a non-string key', () => {
    expect(isUsableIdempotencyKey(12_345_678)).toBe(false);
    expect(isUsableIdempotencyKey({ key: 'abcdefgh' })).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * VAT configuration
 * ------------------------------------------------------------------------ */

describe('permitted VAT rates', () => {
  it('permits zero and the standard Omani rate', () => {
    expect(PERMITTED_VAT_RATES).toEqual([0, 5]);
    expect(isPermittedVatRate(0)).toBe(true);
    expect(isPermittedVatRate(5)).toBe(true);
  });

  it('REFUSES a rate outside the configured set', () => {
    for (const rate of [1, 4.9, 5.1, 10, 15, 100]) {
      expect(isPermittedVatRate(rate)).toBe(false);
    }
  });

  it('REFUSES a negative rate', () => {
    expect(isPermittedVatRate(-5)).toBe(false);
  });

  it('REFUSES a non-numeric rate', () => {
    expect(isPermittedVatRate('5')).toBe(false);
    expect(isPermittedVatRate(null)).toBe(false);
    expect(isPermittedVatRate(Number.NaN)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * Separation of duties
 * ------------------------------------------------------------------------ */

describe('which operations need the owner', () => {
  it('requires the owner for every operation that moves money OUT', () => {
    for (const operation of ['refund', 'refundDeposit', 'forfeitDeposit', 'cancelWithRefund']) {
      expect(requiresOwner(operation)).toBe(true);
    }
  });

  it('requires the owner to correct posted history', () => {
    expect(requiresOwner('reverse')).toBe(true);
  });

  it('does NOT require the owner to take money in — that is the job', () => {
    for (const operation of ['recordPayment', 'recordDeposit', 'postLateFee']) {
      expect(requiresOwner(operation)).toBe(false);
    }
  });

  it('lists exactly the operations the rules and Functions enforce', () => {
    expect([...OWNER_ONLY_FINANCIAL_OPERATIONS]).toEqual([
      'refund',
      'reverse',
      'forfeitDeposit',
      'refundDeposit',
      'cancelWithRefund',
    ]);
  });
});
