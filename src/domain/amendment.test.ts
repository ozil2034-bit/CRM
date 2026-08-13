import { describe, expect, it } from 'vitest';

import {
  chargeDelta,
  refuseAccessory,
  refuseAlteration,
  refuseAmendment,
  reprice,
  withAccessory,
  withAlteration,
  withoutAccessory,
  withoutAlteration,
  type AmendmentContext,
  type ReservationAccessory,
  type ReservationAlteration,
} from './amendment';
import { computePricing, type ReservationLineItem } from './reservation-pricing';
import { baisa } from './money';
import type { ReservationStatus } from './availability';

const GOWN: ReservationLineItem = {
  dressId: 'd-1',
  dressCode: 'WD-0001',
  dressName: 'Aurora',
  designer: 'Elie Saab',
  rentalPrice: baisa(400_000),
  securityDeposit: baisa(100_000),
  cleaningBufferDays: 3,
};

const VEIL: ReservationAccessory = {
  lineId: 'line-1',
  accessoryId: 'a-1',
  name: 'Cathedral veil',
  nameAr: 'طرحة',
  unitPrice: baisa(20_000),
  quantity: 1,
  securityDeposit: baisa(5_000),
};

const HEM: ReservationAlteration = {
  id: 'alt-1',
  description: 'Hem taken up 4cm',
  descriptionAr: '',
  amount: baisa(15_000),
  notes: '',
  employeeId: 'u-1',
  employeeName: 'Fatma',
  createdAt: 1_700_000_000_000,
};

function context(overrides: Partial<AmendmentContext> = {}): AmendmentContext {
  return {
    status: 'Reserved',
    hasActiveDocument: false,
    items: [GOWN],
    accessories: [],
    alterations: [],
    vatRatePercent: 5,
    discountAmount: baisa(0),
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ *
 * When amendment is allowed at all
 * ------------------------------------------------------------------------ */

describe('whether a reservation may be amended', () => {
  const amendable: ReservationStatus[] = [
    'Inquiry',
    'Reserved',
    'Fitting Scheduled',
    'Fitted',
    'Picked Up',
  ];

  it.each(amendable)('allows %s', (status) => {
    expect(refuseAmendment({ status, hasActiveDocument: false })).toBeNull();
  });

  const finished: ReservationStatus[] = ['Returned', 'Closed', 'Cancelled', 'No-Show'];

  it.each(finished)('refuses %s', (status) => {
    expect(refuseAmendment({ status, hasActiveDocument: false })).toBe('RESERVATION_FINISHED');
  });

  it('REFUSES once an invoice has been issued', () => {
    /*
     * Load-bearing. The customer is holding a document that says what they owe.
     * Changing the reservation underneath it would make the paper and the system
     * disagree, which is exactly the discrepancy reconcileDocument detects.
     */
    expect(refuseAmendment({ status: 'Reserved', hasActiveDocument: true })).toBe(
      'DOCUMENT_ISSUED',
    );
  });

  it('checks the reservation state before the document', () => {
    // Both wrong: the more fundamental refusal is reported.
    expect(refuseAmendment({ status: 'Closed', hasActiveDocument: true })).toBe(
      'RESERVATION_FINISHED',
    );
  });
});

/* ------------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------------ */

describe('validating an accessory line', () => {
  const request = {
    accessoryId: 'a-1',
    name: 'Veil',
    nameAr: '',
    unitPrice: 20_000,
    securityDeposit: 5_000,
    quantity: 1,
  };

  it('accepts a well-formed line', () => {
    expect(refuseAccessory(request, [])).toBeNull();
  });

  it('refuses a blank name — a line nobody can identify on an invoice', () => {
    expect(refuseAccessory({ ...request, name: '   ' }, [])).toBe('EMPTY_DESCRIPTION');
  });

  it('refuses a zero or negative quantity', () => {
    expect(refuseAccessory({ ...request, quantity: 0 }, [])).toBe('QUANTITY_NOT_POSITIVE');
    expect(refuseAccessory({ ...request, quantity: -1 }, [])).toBe('QUANTITY_NOT_POSITIVE');
  });

  it('refuses a fractional quantity', () => {
    expect(refuseAccessory({ ...request, quantity: 1.5 }, [])).toBe('QUANTITY_NOT_POSITIVE');
  });

  it('refuses a fractional price — money is whole baisa', () => {
    expect(refuseAccessory({ ...request, unitPrice: 20_000.5 }, [])).toBe('PRICE_NOT_WHOLE');
    expect(refuseAccessory({ ...request, securityDeposit: 0.1 }, [])).toBe('PRICE_NOT_WHOLE');
  });

  it('refuses a negative price', () => {
    expect(refuseAccessory({ ...request, unitPrice: -1 }, [])).toBe('PRICE_NEGATIVE');
  });

  it('allows a free accessory but not a negative one', () => {
    expect(refuseAccessory({ ...request, unitPrice: 0, securityDeposit: 0 }, [])).toBeNull();
  });

  it('refuses once the line ceiling is reached', () => {
    const many = Array.from({ length: 50 }, (_unused, index) => ({
      ...VEIL,
      lineId: `line-${String(index)}`,
    }));

    expect(refuseAccessory(request, many)).toBe('TOO_MANY_LINES');
  });
});

describe('validating an alteration line', () => {
  const request = { description: 'Hem', descriptionAr: '', amount: 15_000, notes: '' };

  it('accepts a well-formed line', () => {
    expect(refuseAlteration(request, [])).toBeNull();
  });

  it('refuses a blank description', () => {
    expect(refuseAlteration({ ...request, description: '  ' }, [])).toBe('EMPTY_DESCRIPTION');
  });

  it('refuses a zero amount — a charge of nothing is not a charge', () => {
    expect(refuseAlteration({ ...request, amount: 0 }, [])).toBe('AMOUNT_NOT_POSITIVE');
  });

  it('refuses a negative amount', () => {
    expect(refuseAlteration({ ...request, amount: -5_000 }, [])).toBe('AMOUNT_NOT_POSITIVE');
  });

  it('refuses a fractional amount before it can be judged positive', () => {
    expect(refuseAlteration({ ...request, amount: 15_000.5 }, [])).toBe('AMOUNT_NOT_WHOLE');
  });
});

/* ------------------------------------------------------------------------ *
 * Repricing — the part that must not become a second engine
 * ------------------------------------------------------------------------ */

describe('repricing', () => {
  it('produces exactly what computePricing would produce for the same lines', () => {
    /*
     * The whole point. If this ever diverges, the platform has two pricing
     * engines and the invoice will eventually disagree with the screen.
     */
    const amended = withAccessory(context(), VEIL);

    const direct = computePricing({
      items: [GOWN],
      accessories: [
        {
          accessoryId: VEIL.accessoryId,
          name: VEIL.name,
          unitPrice: VEIL.unitPrice,
          quantity: VEIL.quantity,
          securityDeposit: VEIL.securityDeposit,
        },
      ],
      alterations: [],
      discount: { kind: 'amount', value: 0 },
      vatRatePercent: 5,
    });

    expect(amended.pricing).toEqual(direct);
  });

  it('keeps the RESERVATION’s VAT rate, not the current one', () => {
    // A booking taken at 0% stays at 0% however settings change afterwards.
    const amended = withAlteration(context({ vatRatePercent: 0 }), HEM);

    expect(amended.pricing.vatRatePercent).toBe(0);
    expect(amended.pricing.vatAmount).toBe(0);
  });

  it('keeps every frozen dress price — master data is never re-read', () => {
    const amended = withAccessory(context(), VEIL);

    expect(amended.pricing.rentalSubtotal).toBe(400_000);
  });

  it('adds the accessory to the taxable base and its deposit outside it', () => {
    const before = reprice(context(), { accessories: [], alterations: [] });
    const after = withAccessory(context(), VEIL);

    expect(after.pricing.accessorySubtotal).toBe(20_000);
    expect(after.pricing.taxableSubtotal).toBe(before.pricing.taxableSubtotal + 20_000);
    expect(after.pricing.securityDepositTotal).toBe(105_000);
  });

  it('multiplies an accessory’s price AND deposit by its quantity', () => {
    const after = withAccessory(context(), { ...VEIL, quantity: 3 });

    expect(after.pricing.accessorySubtotal).toBe(60_000);
    expect(after.pricing.securityDepositTotal).toBe(100_000 + 15_000);
  });

  it('adds an alteration to the taxable base with no deposit', () => {
    const after = withAlteration(context(), HEM);

    expect(after.pricing.alterationSubtotal).toBe(15_000);
    expect(after.pricing.securityDepositTotal).toBe(100_000);
  });

  it('charges VAT on the amendment — once, through the one engine', () => {
    const before = reprice(context(), { accessories: [], alterations: [] });
    const after = withAlteration(context(), HEM);

    // 5% of 15.000 OMR is 750 baisa.
    expect(after.pricing.vatAmount - before.pricing.vatAmount).toBe(750);
  });

  it('carries an agreed discount across as an ABSOLUTE amount', () => {
    /*
     * A percentage would quietly enlarge the concession as the bill grows. The
     * boutique agreed to take 50.000 off; it did not agree to take 10% off
     * whatever the customer adds later.
     */
    const withDiscount = context({ discountAmount: baisa(50_000) });

    const before = reprice(withDiscount, { accessories: [], alterations: [] });
    const after = withAccessory(withDiscount, VEIL);

    expect(before.pricing.discountAmount).toBe(50_000);
    expect(after.pricing.discountAmount).toBe(50_000);
  });

  it('never lets a discount exceed a bill that has since shrunk', () => {
    const shrunk = context({
      items: [{ ...GOWN, rentalPrice: baisa(10_000) }],
      discountAmount: baisa(50_000),
    });

    const priced = reprice(shrunk, { accessories: [], alterations: [] });

    expect(priced.pricing.discountAmount).toBe(10_000);
    expect(priced.pricing.taxableSubtotal).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Removal
 * ------------------------------------------------------------------------ */

describe('removing a line', () => {
  it('removes an accessory and reprices back down', () => {
    const withVeil = context({ accessories: [VEIL] });
    const result = withoutAccessory(withVeil, 'line-1');

    expect(typeof result).not.toBe('string');
    if (typeof result === 'string') return;

    expect(result.accessories).toHaveLength(0);
    expect(result.pricing.accessorySubtotal).toBe(0);
    expect(result.pricing.securityDepositTotal).toBe(100_000);
  });

  it('removes one alteration and leaves the others priced', () => {
    const two = context({ alterations: [HEM, { ...HEM, id: 'alt-2', amount: baisa(5_000) }] });
    const result = withoutAlteration(two, 'alt-1');

    expect(typeof result).not.toBe('string');
    if (typeof result === 'string') return;

    expect(result.alterations.map((line) => line.id)).toEqual(['alt-2']);
    expect(result.pricing.alterationSubtotal).toBe(5_000);
  });

  it('refuses to remove something that is not there, rather than silently doing nothing', () => {
    expect(withoutAccessory(context(), 'line-9')).toBe('NOT_FOUND');
    expect(withoutAlteration(context(), 'alt-9')).toBe('NOT_FOUND');
  });

  it('round-trips: add then remove returns the original figures', () => {
    const base = reprice(context(), { accessories: [], alterations: [] });
    const added = withAccessory(context(), VEIL);
    const removed = withoutAccessory(context({ accessories: added.accessories }), 'line-1');

    expect(typeof removed).not.toBe('string');
    if (typeof removed === 'string') return;

    expect(removed.pricing).toEqual(base.pricing);
  });
});

/* ------------------------------------------------------------------------ *
 * What the employee is shown before committing
 * ------------------------------------------------------------------------ */

describe('the change an amendment makes', () => {
  it('separates the charge from the deposit', () => {
    const before = reprice(context(), { accessories: [], alterations: [] }).pricing;
    const after = withAccessory(context(), VEIL).pricing;

    const delta = chargeDelta(before, after);

    // 20.000 plus 5% VAT.
    expect(delta.charges).toBe(21_000);
    expect(delta.deposit).toBe(5_000);
    expect(delta.total).toBe(26_000);
  });

  it('reports a removal as a negative change', () => {
    const before = withAccessory(context(), VEIL).pricing;
    const after = reprice(context(), { accessories: [], alterations: [] }).pricing;

    expect(chargeDelta(before, after).charges).toBeLessThan(0);
  });

  it('is zero when nothing moved', () => {
    const same = reprice(context(), { accessories: [], alterations: [] }).pricing;

    expect(chargeDelta(same, same)).toEqual({ charges: 0, deposit: 0, total: 0 });
  });
});
