import { describe, it, expect } from 'vitest';
import { baisa, formatOmr, parseOmr, type Baisa } from './money';
import {
  NO_DISCOUNT,
  PricingError,
  computePricing,
  eligibleRentalTotal,
  outstandingBalance,
  resolveDiscount,
  type PricingInput,
} from './reservation-pricing';

const item = (rental: string, deposit: string) => ({
  dressId: 'd1',
  dressCode: 'WD-0001',
  dressName: 'Aurora',
  designer: 'Elie Saab',
  rentalPrice: parseOmr(rental),
  securityDeposit: parseOmr(deposit),
  cleaningBufferDays: 3,
});

const base: PricingInput = {
  items: [item('180.000', '100.000')],
  accessories: [],
  alterations: [],
  discount: NO_DISCOUNT,
  vatRatePercent: 5,
};

describe('computePricing()', () => {
  it('computes a simple rental', () => {
    const pricing = computePricing(base);

    expect(formatOmr(pricing.rentalSubtotal)).toBe('OMR 180.000');
    expect(formatOmr(pricing.taxableSubtotal)).toBe('OMR 180.000');
    expect(formatOmr(pricing.vatAmount)).toBe('OMR 9.000');
    expect(formatOmr(pricing.securityDepositTotal)).toBe('OMR 100.000');
    expect(formatOmr(pricing.grandTotal)).toBe('OMR 289.000');
  });

  it('excludes the security deposit from the VAT base', () => {
    // The deposit is a refundable holding, not a sale. Taxing it would
    // overcharge every customer.
    const pricing = computePricing(base);

    const vatIfDepositWereTaxed = computePricing({
      ...base,
      items: [item('280.000', '0.000')],
    }).vatAmount;

    expect(pricing.vatAmount).not.toBe(vatIfDepositWereTaxed);
    expect(formatOmr(pricing.vatAmount)).toBe('OMR 9.000');
  });

  it('sums several dresses', () => {
    const pricing = computePricing({
      ...base,
      items: [item('180.000', '100.000'), item('220.500', '150.000')],
    });

    expect(formatOmr(pricing.rentalSubtotal)).toBe('OMR 400.500');
    expect(formatOmr(pricing.securityDepositTotal)).toBe('OMR 250.000');
  });

  it('multiplies accessories by quantity', () => {
    const pricing = computePricing({
      ...base,
      accessories: [
        {
          accessoryId: 'a1',
          name: 'Veil',
          unitPrice: parseOmr('15.000'),
          quantity: 3,
          securityDeposit: parseOmr('5.000'),
        },
      ],
    });

    expect(formatOmr(pricing.accessorySubtotal)).toBe('OMR 45.000');
    expect(formatOmr(pricing.securityDepositTotal)).toBe('OMR 115.000');
  });

  it('adds alterations to the taxable base', () => {
    const pricing = computePricing({
      ...base,
      alterations: [{ description: 'Hem', amount: parseOmr('12.500') }],
    });

    expect(formatOmr(pricing.alterationSubtotal)).toBe('OMR 12.500');
    expect(formatOmr(pricing.taxableSubtotal)).toBe('OMR 192.500');
  });

  it('applies a discount BEFORE VAT', () => {
    /*
     * Discounting after VAT would have the customer paying tax on money they
     * never handed over.
     */
    const pricing = computePricing({
      ...base,
      discount: { kind: 'amount', value: parseOmr('30.000') },
    });

    expect(formatOmr(pricing.discountAmount)).toBe('OMR 30.000');
    expect(formatOmr(pricing.taxableSubtotal)).toBe('OMR 150.000');
    expect(formatOmr(pricing.vatAmount)).toBe('OMR 7.500');
    expect(formatOmr(pricing.grandTotal)).toBe('OMR 257.500');
  });

  it('applies a percentage discount to the pre-VAT total', () => {
    const pricing = computePricing({ ...base, discount: { kind: 'percent', value: 10 } });

    expect(formatOmr(pricing.discountAmount)).toBe('OMR 18.000');
    expect(formatOmr(pricing.taxableSubtotal)).toBe('OMR 162.000');
    expect(formatOmr(pricing.vatAmount)).toBe('OMR 8.100');
  });

  it('yields no VAT at a zero rate', () => {
    const pricing = computePricing({ ...base, vatRatePercent: 0 });

    expect(pricing.vatAmount).toBe(0);
    expect(formatOmr(pricing.grandTotal)).toBe('OMR 280.000');
  });

  it('rounds VAT once, at the end', () => {
    // 5% of 12.345 is 0.61725 — rounded a single time, to 617 baisa.
    const pricing = computePricing({
      ...base,
      items: [item('12.345', '0.000')],
    });

    expect(pricing.vatAmount).toBe(617);
  });

  it('keeps every amount an integer number of baisa', () => {
    const pricing = computePricing({
      ...base,
      items: [item('12.345', '7.777')],
      alterations: [{ description: 'Hem', amount: parseOmr('3.333') }],
      discount: { kind: 'percent', value: 7.5 },
    });

    for (const value of [
      pricing.rentalSubtotal,
      pricing.accessorySubtotal,
      pricing.alterationSubtotal,
      pricing.discountAmount,
      pricing.taxableSubtotal,
      pricing.vatAmount,
      pricing.securityDepositTotal,
      pricing.grandTotal,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('has a grand total that equals its own parts exactly', () => {
    const pricing = computePricing({
      ...base,
      items: [item('12.345', '7.777'), item('99.999', '11.111')],
      accessories: [
        {
          accessoryId: 'a1',
          name: 'Tiara',
          unitPrice: parseOmr('33.333'),
          quantity: 2,
          securityDeposit: parseOmr('1.111'),
        },
      ],
      alterations: [{ description: 'Hem', amount: parseOmr('3.333') }],
      discount: { kind: 'amount', value: parseOmr('5.555') },
    });

    expect(pricing.grandTotal).toBe(
      pricing.taxableSubtotal + pricing.vatAmount + pricing.securityDepositTotal,
    );
    expect(pricing.taxableSubtotal).toBe(
      pricing.rentalSubtotal +
        pricing.accessorySubtotal +
        pricing.alterationSubtotal -
        pricing.discountAmount,
    );
  });

  it('freezes the VAT rate it was given', () => {
    const pricing = computePricing({ ...base, vatRatePercent: 5 });
    // Stored on the snapshot, so a later settings change cannot alter it.
    expect(pricing.vatRatePercent).toBe(5);
  });

  it('rejects a negative VAT rate', () => {
    expect(() => computePricing({ ...base, vatRatePercent: -1 })).toThrow(PricingError);
  });

  it('rejects a fractional accessory quantity', () => {
    expect(() =>
      computePricing({
        ...base,
        accessories: [
          {
            accessoryId: 'a1',
            name: 'Veil',
            unitPrice: parseOmr('15.000'),
            quantity: 1.5,
            securityDeposit: baisa(0),
          },
        ],
      }),
    ).toThrow(PricingError);
  });

  it('handles an empty reservation without producing NaN', () => {
    const pricing = computePricing({
      items: [],
      accessories: [],
      alterations: [],
      discount: NO_DISCOUNT,
      vatRatePercent: 5,
    });

    expect(pricing.grandTotal).toBe(0);
    expect(pricing.vatAmount).toBe(0);
  });
});

describe('resolveDiscount()', () => {
  const total = parseOmr('180.000');

  it('caps a discount larger than the bill', () => {
    // A reservation the boutique owes money on is a data-entry error.
    expect(resolveDiscount({ kind: 'amount', value: parseOmr('500.000') }, total)).toBe(total);
  });

  it('rejects a negative discount', () => {
    expect(() => resolveDiscount({ kind: 'amount', value: -1 }, total)).toThrow(PricingError);
  });

  it('rejects a percentage above 100', () => {
    expect(() => resolveDiscount({ kind: 'percent', value: 101 }, total)).toThrow(PricingError);
  });

  it('allows a full 100% discount', () => {
    expect(resolveDiscount({ kind: 'percent', value: 100 }, total)).toBe(total);
  });

  it('never produces a negative taxable subtotal', () => {
    const pricing = computePricing({
      ...base,
      discount: { kind: 'amount', value: parseOmr('999.000') },
    });
    expect(pricing.taxableSubtotal).toBe(0);
    expect(pricing.vatAmount).toBe(0);
  });
});

describe('outstandingBalance()', () => {
  const pricing = computePricing(base);

  it('is the whole total when nothing has been paid', () => {
    expect(outstandingBalance(pricing, baisa(0))).toBe(pricing.grandTotal);
  });

  it('reduces by what has been paid', () => {
    expect(formatOmr(outstandingBalance(pricing, parseOmr('100.000')))).toBe('OMR 189.000');
  });

  it('is zero, never negative, when overpaid', () => {
    expect(outstandingBalance(pricing, parseOmr('500.000'))).toBe(0);
  });
});

describe('eligibleRentalTotal()', () => {
  it('excludes the security deposit', () => {
    // Phase 5 uses this for the pickup payment threshold: the deposit is
    // required separately, not counted toward the rental percentage.
    const pricing = computePricing(base);
    expect(formatOmr(eligibleRentalTotal(pricing))).toBe('OMR 189.000');
  });
});

describe('money type discipline', () => {
  it('accepts only branded Baisa amounts', () => {
    const amount: Baisa = parseOmr('1.000');
    expect(Number.isInteger(amount)).toBe(true);
  });
});
