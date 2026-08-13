import { describe, expect, it } from 'vitest';

import { baisa, type Baisa } from './money';
import { computePricing, NO_DISCOUNT, type PricingSnapshot } from './reservation-pricing';
import {
  emptyPosition,
  FINANCIAL_EVENT_KINDS,
  isFinancialEventKind,
  pickupEligibility,
  reconcile,
  reduceLedger,
  signedAmount,
  type FinancialEvent,
  type FinancialEventKind,
} from './ledger';

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

let sequence = 0;

function event(
  kind: FinancialEventKind,
  amount: number,
  overrides: Partial<FinancialEvent> = {},
): FinancialEvent {
  sequence += 1;
  return {
    id: `evt-${sequence}`,
    reservationId: 'rsv-1',
    kind,
    amount: baisa(amount),
    method: 'Cash',
    type: kind === 'Payment' ? 'Installment' : null,
    occurredAt: 1_700_000_000_000,
    reference: '',
    reason: '',
    employeeId: 'staff-1',
    reversesEventId: null,
    idempotencyKey: `key-${sequence}`,
    ...overrides,
  };
}

/** A reservation of OMR 200.000 rental, OMR 100.000 deposit, 5% VAT. */
function pricing(overrides: Partial<Parameters<typeof computePricing>[0]> = {}): PricingSnapshot {
  return computePricing({
    items: [
      {
        dressId: 'd-1',
        dressCode: 'WD-0001',
        dressName: 'Aurora',
        designer: 'Elie Saab',
        rentalPrice: baisa(200_000),
        securityDeposit: baisa(100_000),
        cleaningBufferDays: 3,
      },
    ],
    accessories: [],
    alterations: [],
    discount: NO_DISCOUNT,
    vatRatePercent: 5,
    ...overrides,
  });
}

/* ------------------------------------------------------------------------ *
 * The shape of the ledger
 * ------------------------------------------------------------------------ */

describe('event kinds', () => {
  it('recognises every defined kind', () => {
    for (const kind of FINANCIAL_EVENT_KINDS) {
      expect(isFinancialEventKind(kind)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    for (const value of ['payment', 'Adjustment', '', null, 42]) {
      expect(isFinancialEventKind(value)).toBe(false);
    }
  });

  it('shows money in as positive and money out as negative', () => {
    expect(signedAmount(event('Payment', 50_000))).toBe(50_000);
    expect(signedAmount(event('SecurityDepositPayment', 50_000))).toBe(50_000);
    expect(signedAmount(event('LateFee', 5_000))).toBe(5_000);

    expect(signedAmount(event('PaymentReversal', 50_000))).toBe(-50_000);
    expect(signedAmount(event('Refund', 50_000))).toBe(-50_000);
    expect(signedAmount(event('SecurityDepositRefund', 50_000))).toBe(-50_000);
    expect(signedAmount(event('SecurityDepositForfeiture', 50_000))).toBe(-50_000);
    expect(signedAmount(event('ChargeWaiver', 50_000))).toBe(-50_000);
  });
});

/* ------------------------------------------------------------------------ *
 * Balances
 * ------------------------------------------------------------------------ */

describe('an unpaid reservation', () => {
  const position = emptyPosition(pricing());

  it('owes the rental plus VAT, and not the deposit', () => {
    // 200.000 rental + 5% VAT = 210.000. The 100.000 deposit is separate.
    expect(position.agreedCharges).toBe(210_000);
    expect(position.totalChargeable).toBe(210_000);
    expect(position.outstanding).toBe(210_000);
  });

  it('tracks the deposit as due but not held', () => {
    expect(position.depositDue).toBe(100_000);
    expect(position.depositHeld).toBe(0);
  });

  it('is Unpaid', () => {
    expect(position.status).toBe('Unpaid');
  });

  it('has nothing refundable', () => {
    expect(position.refundable).toBe(0);
  });
});

describe('payments against the rental', () => {
  it('reduces the outstanding balance', () => {
    const position = reduceLedger(pricing(), [event('Payment', 60_000)]);

    expect(position.netPaid).toBe(60_000);
    expect(position.outstanding).toBe(150_000);
    expect(position.status).toBe('Partially Paid');
  });

  it('settles the reservation when paid in full', () => {
    const position = reduceLedger(pricing(), [event('Payment', 210_000)]);

    expect(position.outstanding).toBe(0);
    expect(position.refundable).toBe(0);
    expect(position.status).toBe('Paid');
  });

  it('sums several payments exactly', () => {
    const position = reduceLedger(pricing(), [
      event('Payment', 70_000),
      event('Payment', 70_000),
      event('Payment', 70_000),
    ]);

    expect(position.netPaid).toBe(210_000);
    expect(position.outstanding).toBe(0);
  });

  it('does NOT count the security deposit toward the rental balance', () => {
    // The whole point of keeping the two accounts apart.
    const position = reduceLedger(pricing(), [event('SecurityDepositPayment', 100_000)]);

    expect(position.depositHeld).toBe(100_000);
    expect(position.netPaid).toBe(0);
    expect(position.outstanding).toBe(210_000);
    expect(position.status).toBe('Unpaid');
  });
});

describe('reversal', () => {
  it('undoes a payment without deleting it', () => {
    const payment = event('Payment', 60_000);
    const position = reduceLedger(pricing(), [
      payment,
      event('PaymentReversal', 60_000, { reversesEventId: payment.id }),
    ]);

    // Gross payment is still visible; the net position is as if it never was.
    expect(position.grossPaid).toBe(60_000);
    expect(position.reversed).toBe(60_000);
    expect(position.netPaid).toBe(0);
    expect(position.outstanding).toBe(210_000);
  });

  it('leaves the reservation Unpaid rather than Refunded — no money moved', () => {
    const payment = event('Payment', 60_000);
    const position = reduceLedger(pricing(), [
      payment,
      event('PaymentReversal', 60_000, { reversesEventId: payment.id }),
    ]);

    expect(position.status).toBe('Unpaid');
    expect(position.refunded).toBe(0);
  });

  it('reverses only the payment it names, not the others', () => {
    const first = event('Payment', 60_000);
    const position = reduceLedger(pricing(), [
      first,
      event('Payment', 50_000),
      event('PaymentReversal', 60_000, { reversesEventId: first.id }),
    ]);

    expect(position.netPaid).toBe(50_000);
  });
});

describe('refunds', () => {
  it('reduces what is held and marks the reservation refunded', () => {
    const position = reduceLedger(pricing(), [
      event('Payment', 210_000),
      event('ChargeWaiver', 210_000),
      event('Refund', 210_000),
    ]);

    expect(position.netPaid).toBe(0);
    expect(position.status).toBe('Refunded');
  });

  it('reports a partial refund as such', () => {
    const position = reduceLedger(pricing(), [
      event('Payment', 210_000),
      event('ChargeWaiver', 100_000),
      event('Refund', 60_000),
    ]);

    expect(position.status).toBe('Partially Refunded');
    expect(position.netPaid).toBe(150_000);
  });

  it('shrinks the refundable ceiling as refunds are paid', () => {
    const base = [event('Payment', 210_000), event('ChargeWaiver', 210_000)];

    expect(reduceLedger(pricing(), base).refundable).toBe(210_000);
    expect(reduceLedger(pricing(), [...base, event('Refund', 100_000)]).refundable).toBe(110_000);
    expect(reduceLedger(pricing(), [...base, event('Refund', 210_000)]).refundable).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * The deposit account
 * ------------------------------------------------------------------------ */

describe('the security deposit', () => {
  it('is held once collected', () => {
    const position = reduceLedger(pricing(), [event('SecurityDepositPayment', 100_000)]);

    expect(position.depositPaid).toBe(100_000);
    expect(position.depositHeld).toBe(100_000);
    expect(position.depositRemaining).toBe(100_000);
  });

  it('is reduced by a refund', () => {
    const position = reduceLedger(pricing(), [
      event('SecurityDepositPayment', 100_000),
      event('SecurityDepositRefund', 100_000),
    ]);

    expect(position.depositRefunded).toBe(100_000);
    expect(position.depositHeld).toBe(0);
  });

  it('is reduced by a forfeiture', () => {
    const position = reduceLedger(pricing(), [
      event('SecurityDepositPayment', 100_000),
      event('SecurityDepositForfeiture', 40_000),
    ]);

    expect(position.depositForfeited).toBe(40_000);
    expect(position.depositHeld).toBe(60_000);
  });

  it('handles a part refund and a part forfeiture together', () => {
    const position = reduceLedger(pricing(), [
      event('SecurityDepositPayment', 100_000),
      event('SecurityDepositForfeiture', 30_000),
      event('SecurityDepositRefund', 70_000),
    ]);

    expect(position.depositHeld).toBe(0);
    expect(position.depositForfeited + position.depositRefunded).toBe(100_000);
  });

  it('never reports a negative holding', () => {
    // Rules and Functions prevent this reaching storage; the reducer still
    // refuses to present a negative deposit if corrupt data ever arrives.
    const position = reduceLedger(pricing(), [
      event('SecurityDepositPayment', 50_000),
      event('SecurityDepositRefund', 90_000),
    ]);

    expect(position.depositHeld).toBe(0);
  });

  it('does not let a forfeited deposit settle the rental balance', () => {
    const position = reduceLedger(pricing(), [
      event('SecurityDepositPayment', 100_000),
      event('SecurityDepositForfeiture', 100_000),
    ]);

    expect(position.outstanding).toBe(210_000);
  });
});

/* ------------------------------------------------------------------------ *
 * Late fees and waivers
 * ------------------------------------------------------------------------ */

describe('late fees', () => {
  it('increases what the customer owes', () => {
    const position = reduceLedger(pricing(), [event('LateFee', 15_000)]);

    expect(position.lateFees).toBe(15_000);
    expect(position.totalChargeable).toBe(225_000);
    expect(position.outstanding).toBe(225_000);
  });

  it('can reopen a settled reservation', () => {
    const position = reduceLedger(pricing(), [event('Payment', 210_000), event('LateFee', 15_000)]);

    expect(position.status).toBe('Partially Paid');
    expect(position.outstanding).toBe(15_000);
  });
});

describe('charge waivers', () => {
  it('reduces what is chargeable', () => {
    const position = reduceLedger(pricing(), [event('ChargeWaiver', 110_000)]);

    expect(position.totalChargeable).toBe(100_000);
  });

  it('turns money already held into a refundable amount', () => {
    const position = reduceLedger(pricing(), [
      event('Payment', 210_000),
      event('ChargeWaiver', 110_000),
    ]);

    expect(position.outstanding).toBe(0);
    expect(position.refundable).toBe(110_000);
  });

  it('never drives what is chargeable below zero', () => {
    const position = reduceLedger(pricing(), [event('ChargeWaiver', 999_000)]);

    expect(position.totalChargeable).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Pickup eligibility
 * ------------------------------------------------------------------------ */

describe('pickup eligibility', () => {
  const full = pricing();

  it('refuses when neither the deposit nor the balance is settled', () => {
    const result = pickupEligibility(emptyPosition(full), 100);

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('DEPOSIT_NOT_HELD');
    expect(result.reasons).toContain('BALANCE_BELOW_THRESHOLD');
  });

  it('refuses when the deposit is held but nothing is paid', () => {
    const position = reduceLedger(full, [event('SecurityDepositPayment', 100_000)]);
    const result = pickupEligibility(position, 100);

    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(['BALANCE_BELOW_THRESHOLD']);
  });

  it('refuses when the balance is paid but the deposit is not held', () => {
    const position = reduceLedger(full, [event('Payment', 210_000)]);
    const result = pickupEligibility(position, 100);

    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(['DEPOSIT_NOT_HELD']);
  });

  it('allows when both are satisfied', () => {
    const position = reduceLedger(full, [
      event('SecurityDepositPayment', 100_000),
      event('Payment', 210_000),
    ]);

    expect(pickupEligibility(position, 100).allowed).toBe(true);
  });

  it('honours a 50% threshold', () => {
    const half = reduceLedger(full, [
      event('SecurityDepositPayment', 100_000),
      event('Payment', 105_000),
    ]);

    expect(pickupEligibility(half, 50).allowed).toBe(true);
    expect(pickupEligibility(half, 100).allowed).toBe(false);
  });

  it('rounds the required amount UP, so a baisa short is still short', () => {
    // 50% of 210_001 is 105_000.5 — the customer must pay 105_001.
    const odd = computePricing({
      items: [
        {
          dressId: 'd-1',
          dressCode: 'WD-0001',
          dressName: 'Odd',
          designer: '',
          rentalPrice: baisa(200_001),
          securityDeposit: baisa(0),
          cleaningBufferDays: 3,
        },
      ],
      accessories: [],
      alterations: [],
      discount: NO_DISCOUNT,
      vatRatePercent: 0,
    });

    const short = reduceLedger(odd, [event('Payment', 100_000)]);
    expect(pickupEligibility(short, 50).allowed).toBe(false);

    const exact = reduceLedger(odd, [event('Payment', 100_001)]);
    expect(pickupEligibility(exact, 50).allowed).toBe(true);
  });

  it('does NOT let the deposit count toward the rental threshold', () => {
    const depositOnly = reduceLedger(full, [event('SecurityDepositPayment', 100_000)]);

    expect(pickupEligibility(depositOnly, 50).allowed).toBe(false);
  });

  it('reports how much more is required', () => {
    const position = reduceLedger(full, [event('Payment', 10_000)]);

    expect(pickupEligibility(position, 100).stillRequired).toBe(200_000);
  });

  it('allows a zero-value reservation at any threshold', () => {
    const free = computePricing({
      items: [],
      accessories: [],
      alterations: [],
      discount: NO_DISCOUNT,
      vatRatePercent: 5,
    });

    expect(pickupEligibility(emptyPosition(free), 100).allowed).toBe(true);
  });

  it('rejects a nonsensical threshold rather than guessing', () => {
    expect(() => pickupEligibility(emptyPosition(full), -1)).toThrow();
  });
});

/* ------------------------------------------------------------------------ *
 * Reconciliation
 * ------------------------------------------------------------------------ */

describe('reconciliation', () => {
  const cases: { name: string; events: FinancialEvent[] }[] = [
    { name: 'no activity', events: [] },
    { name: 'a part payment', events: [event('Payment', 60_000)] },
    { name: 'payment in full', events: [event('Payment', 210_000)] },
    {
      name: 'deposit held',
      events: [event('SecurityDepositPayment', 100_000), event('Payment', 210_000)],
    },
    {
      name: 'a reversal',
      events: [event('Payment', 60_000), event('PaymentReversal', 60_000)],
    },
    {
      name: 'a late fee',
      events: [event('Payment', 210_000), event('LateFee', 15_000)],
    },
    {
      name: 'a cancellation with a refund',
      events: [
        event('Payment', 210_000),
        event('SecurityDepositPayment', 100_000),
        event('ChargeWaiver', 105_000),
        event('Refund', 105_000),
        event('SecurityDepositRefund', 100_000),
      ],
    },
    {
      name: 'a deposit partly kept',
      events: [
        event('SecurityDepositPayment', 100_000),
        event('SecurityDepositForfeiture', 25_000),
        event('SecurityDepositRefund', 75_000),
      ],
    },
  ];

  for (const { name, events } of cases) {
    it(`balances to zero difference with ${name}`, () => {
      const snapshot = pricing();
      const result = reconcile(snapshot, reduceLedger(snapshot, events));

      expect(result.problems).toEqual([]);
      expect(result.balanced).toBe(true);
    });
  }

  it('reports a grand total that does not equal its own parts', () => {
    const snapshot = pricing();
    const corrupted: PricingSnapshot = { ...snapshot, grandTotal: baisa(1) };

    const result = reconcile(corrupted, reduceLedger(corrupted, []));

    expect(result.balanced).toBe(false);
    expect(result.problems[0]).toMatch(/Grand total/);
  });

  it('reports a deposit returned beyond what was collected', () => {
    const snapshot = pricing();
    const position = reduceLedger(snapshot, [
      event('SecurityDepositPayment', 50_000),
      event('SecurityDepositRefund', 90_000),
    ]);

    expect(reconcile(snapshot, position).balanced).toBe(false);
  });

  it('reports refunds exceeding the money ever received', () => {
    const snapshot = pricing();
    const position = reduceLedger(snapshot, [event('Payment', 10_000), event('Refund', 90_000)]);

    expect(reconcile(snapshot, position).balanced).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * Precision
 * ------------------------------------------------------------------------ */

describe('three-decimal precision', () => {
  const amounts: number[] = [1, 2, 5, 999, 1_001, 999_999_999];

  for (const amount of amounts) {
    it(`carries ${amount} baisa through the ledger exactly`, () => {
      const snapshot = computePricing({
        items: [
          {
            dressId: 'd-1',
            dressCode: 'WD-0001',
            dressName: 'Precise',
            designer: '',
            rentalPrice: baisa(amount),
            securityDeposit: baisa(0),
            cleaningBufferDays: 3,
          },
        ],
        accessories: [],
        alterations: [],
        discount: NO_DISCOUNT,
        vatRatePercent: 0,
      });

      const position = reduceLedger(snapshot, [event('Payment', amount)]);

      expect(position.outstanding).toBe(0);
      expect(position.netPaid).toBe(amount);
      expect(Number.isInteger(position.netPaid)).toBe(true);
      expect(reconcile(snapshot, position).balanced).toBe(true);
    });
  }

  it('never produces a fractional baisa from a long chain of events', () => {
    const snapshot = pricing();
    const many: FinancialEvent[] = Array.from({ length: 97 }, () => event('Payment', 1));

    const position = reduceLedger(snapshot, many);

    expect(position.netPaid).toBe(97);
    expect(Number.isInteger(position.netPaid)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * Statuses
 * ------------------------------------------------------------------------ */

describe('financial status', () => {
  const snapshot = pricing();

  const expectations: { events: FinancialEvent[]; status: string; why: string }[] = [
    { events: [], status: 'Unpaid', why: 'nothing has been paid' },
    {
      events: [event('Payment', 1)],
      status: 'Partially Paid',
      why: 'a single baisa is still a payment',
    },
    { events: [event('Payment', 210_000)], status: 'Paid', why: 'the balance is settled' },
    {
      events: [event('Payment', 210_000), event('ChargeWaiver', 210_000), event('Refund', 100_000)],
      status: 'Partially Refunded',
      why: 'some money has gone back',
    },
    {
      events: [event('Payment', 210_000), event('ChargeWaiver', 210_000), event('Refund', 210_000)],
      status: 'Refunded',
      why: 'everything has gone back',
    },
  ];

  for (const { events, status, why } of expectations) {
    it(`is ${status} when ${why}`, () => {
      expect(reduceLedger(snapshot, events).status).toBe(status);
    });
  }

  it('is not confused by a reservation that is overpaid through a waiver', () => {
    const position = reduceLedger(snapshot, [
      event('Payment', 210_000),
      event('ChargeWaiver', 110_000),
    ]);

    // Money is held above what is owed, but none has gone back yet.
    expect(position.status).toBe('Paid');
    expect(position.refundable).toBe(110_000);
  });
});

/* ------------------------------------------------------------------------ *
 * A worked scenario, end to end
 * ------------------------------------------------------------------------ */

describe('a full rental, from booking to closure', () => {
  it('reconciles at every step', () => {
    const snapshot = pricing();
    const events: FinancialEvent[] = [];

    const check = (): ReturnType<typeof reduceLedger> => {
      const position = reduceLedger(snapshot, events);
      expect(reconcile(snapshot, position).balanced).toBe(true);
      return position;
    };

    check();

    // Bride pays a deposit against the rental, and the security deposit.
    events.push(event('Payment', 100_000, { type: 'Deposit' }));
    events.push(event('SecurityDepositPayment', 100_000));
    let position = check();
    expect(position.outstanding).toBe(110_000);
    expect(pickupEligibility(position, 100).allowed).toBe(false);

    // Balance settled at collection.
    events.push(event('Payment', 110_000, { type: 'Final Payment' }));
    position = check();
    expect(position.status).toBe('Paid');
    expect(pickupEligibility(position, 100).allowed).toBe(true);

    // Returned two days late.
    events.push(event('LateFee', 20_000));
    position = check();
    expect(position.outstanding).toBe(20_000);

    // Late fee taken out of the deposit is NOT how this works — the customer
    // pays it, and the deposit goes back whole.
    events.push(event('Payment', 20_000));
    events.push(event('SecurityDepositRefund', 100_000));
    position = check();

    expect(position.outstanding).toBe(0);
    expect(position.depositHeld).toBe(0);
    expect(position.netPaid).toBe(230_000);
    expect(position.totalChargeable).toBe(230_000);
  });
});

/** Compile-time guard: the reducer's return type is what the tests assume. */
const _typeCheck: Baisa = emptyPosition(pricing()).outstanding;
void _typeCheck;
