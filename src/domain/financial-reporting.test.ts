import { describe, expect, it } from 'vitest';

import { fromMuscatWallTime } from './datetime';
import { baisa } from './money';
import {
  collectedByMethod,
  summarise,
  totalDepositsHeld,
  totalOutstanding,
  withinPeriod,
  type Period,
} from './financial-reporting';
import type { FinancialEvent, FinancialEventKind, PaymentMethod } from './ledger';

const MARCH: Period = {
  from: fromMuscatWallTime('2026-03-01T00:00'),
  to: fromMuscatWallTime('2026-04-01T00:00'),
};

let sequence = 0;

function event(
  kind: FinancialEventKind,
  amount: number,
  on: string,
  method: PaymentMethod | null = 'Cash',
): FinancialEvent {
  sequence += 1;
  return {
    id: `e-${sequence}`,
    reservationId: 'rsv-1',
    kind,
    amount: baisa(amount),
    method,
    type: null,
    occurredAt: fromMuscatWallTime(on),
    reference: '',
    reason: '',
    employeeId: 'staff-1',
    reversesEventId: null,
    idempotencyKey: `k-${sequence}`,
  };
}

describe('period boundaries', () => {
  it('includes the first instant of the period', () => {
    expect(withinPeriod(MARCH.from, MARCH)).toBe(true);
  });

  it('EXCLUDES the first instant of the next period', () => {
    // Half-open, so consecutive months neither double-count nor lose a payment.
    expect(withinPeriod(MARCH.to, MARCH)).toBe(false);
  });

  it('excludes anything before the period', () => {
    expect(withinPeriod(MARCH.from - 1, MARCH)).toBe(false);
  });
});

describe('summarising a period', () => {
  const events: FinancialEvent[] = [
    event('Payment', 100_000, '2026-03-05T10:00'),
    event('Payment', 50_000, '2026-03-20T10:00'),
    event('PaymentReversal', 50_000, '2026-03-21T10:00'),
    event('Refund', 20_000, '2026-03-25T10:00'),
    event('SecurityDepositPayment', 80_000, '2026-03-05T10:00'),
    event('SecurityDepositRefund', 30_000, '2026-03-28T10:00'),
    event('SecurityDepositForfeiture', 10_000, '2026-03-28T10:00'),
    event('LateFee', 15_000, '2026-03-27T10:00', null),
    event('ChargeWaiver', 40_000, '2026-03-29T10:00', null),
    // Outside the period, and must not appear anywhere.
    event('Payment', 999_000, '2026-04-01T00:00'),
    event('Payment', 888_000, '2026-02-28T23:59'),
  ];

  const summary = summarise(events, MARCH);

  it('counts only events inside the period', () => {
    expect(summary.eventCount).toBe(9);
  });

  it('reports gross collection before reversals', () => {
    expect(summary.grossCollected).toBe(150_000);
  });

  it('reports reversals and refunds separately', () => {
    expect(summary.reversed).toBe(50_000);
    expect(summary.refunded).toBe(20_000);
  });

  it('nets what the boutique actually kept', () => {
    expect(summary.netCollected).toBe(150_000 - 50_000 - 20_000);
  });

  it('keeps deposits entirely out of revenue', () => {
    expect(summary.depositsCollected).toBe(80_000);
    expect(summary.depositsNet).toBe(80_000 - 30_000 - 10_000);

    // The revenue lines are computed from rental events only, so the 80.000
    // deposit is absent from both.
    expect(summary.grossCollected).toBe(150_000);
    expect(summary.netCollected).toBe(150_000 - 50_000 - 20_000);
  });

  it('does not move a deposit into revenue when the rental total happens to match', () => {
    // Guards against a reducer that adds deposits to `netCollected`: here the
    // two are deliberately different numbers, so the bug cannot hide.
    const summaryAlt = summarise(
      [
        event('Payment', 11_000, '2026-03-05T10:00'),
        event('SecurityDepositPayment', 77_000, '2026-03-05T10:00'),
      ],
      MARCH,
    );

    expect(summaryAlt.grossCollected).toBe(11_000);
    expect(summaryAlt.netCollected).toBe(11_000);
    expect(summaryAlt.depositsNet).toBe(77_000);
  });

  it('separates deposits returned from deposits kept', () => {
    expect(summary.depositsReturned).toBe(30_000);
    expect(summary.depositsForfeited).toBe(10_000);
  });

  it('reports late fees charged and charges waived', () => {
    expect(summary.lateFeesCharged).toBe(15_000);
    expect(summary.chargesWaived).toBe(40_000);
  });

  it('returns zeroes for an empty period rather than NaN', () => {
    const empty = summarise([], MARCH);

    expect(empty.grossCollected).toBe(0);
    expect(empty.netCollected).toBe(0);
    expect(empty.depositsNet).toBe(0);
    expect(empty.eventCount).toBe(0);
  });

  it('keeps every figure a whole number of baisa', () => {
    for (const value of Object.values(summary)) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

describe('collection by tender', () => {
  it('nets money in against money out for each method', () => {
    const totals = collectedByMethod(
      [
        event('Payment', 100_000, '2026-03-05T10:00', 'Cash'),
        event('Payment', 60_000, '2026-03-06T10:00', 'Card'),
        event('Refund', 20_000, '2026-03-07T10:00', 'Cash'),
        event('SecurityDepositPayment', 50_000, '2026-03-08T10:00', 'Cash'),
      ],
      MARCH,
    );

    // What the cash drawer should actually be up by.
    expect(totals['Cash']).toBe(100_000 - 20_000 + 50_000);
    expect(totals['Card']).toBe(60_000);
  });

  it('treats a reversal as reducing the tender it was recorded against', () => {
    const totals = collectedByMethod(
      [
        event('Payment', 100_000, '2026-03-05T10:00', 'Cash'),
        event('PaymentReversal', 100_000, '2026-03-05T11:00', 'Cash'),
      ],
      MARCH,
    );

    expect(totals['Cash']).toBe(0);
  });

  it('ignores events with no tender — a late fee is a charge, not cash', () => {
    const totals = collectedByMethod([event('LateFee', 15_000, '2026-03-05T10:00', null)], MARCH);

    expect(Object.keys(totals)).toHaveLength(0);
  });

  it('ignores a forfeiture — no money moved, it merely stopped being owed back', () => {
    const totals = collectedByMethod(
      [event('SecurityDepositForfeiture', 15_000, '2026-03-05T10:00', 'Cash')],
      MARCH,
    );

    expect(totals['Cash'] ?? 0).toBe(0);
  });

  it('excludes events outside the period', () => {
    const totals = collectedByMethod(
      [event('Payment', 100_000, '2026-04-05T10:00', 'Cash')],
      MARCH,
    );

    expect(Object.keys(totals)).toHaveLength(0);
  });
});

describe('outstanding rollups', () => {
  const rows = [
    {
      reservationId: 'a',
      reservationCode: 'RSV-0001',
      customerId: 'c1',
      outstanding: baisa(100_000),
      depositHeld: baisa(50_000),
    },
    {
      reservationId: 'b',
      reservationCode: 'RSV-0002',
      customerId: 'c2',
      outstanding: baisa(250_000),
      depositHeld: baisa(0),
    },
    {
      reservationId: 'c',
      reservationCode: 'RSV-0003',
      customerId: 'c3',
      outstanding: baisa(0),
      depositHeld: baisa(75_000),
    },
  ];

  it('totals what is still owed', () => {
    expect(totalOutstanding(rows)).toBe(350_000);
  });

  it('totals deposits held', () => {
    expect(totalDepositsHeld(rows)).toBe(125_000);
  });

  it('returns zero for no reservations', () => {
    expect(totalOutstanding([])).toBe(0);
    expect(totalDepositsHeld([])).toBe(0);
  });
});
