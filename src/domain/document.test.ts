/**
 * Documents.
 *
 * The most important assertion in this file is that a document's figures are
 * **identical** to the engine's — not close, not consistent, identical. §36
 * requires it and `reconcileDocument` is the mechanism.
 */

import { describe, expect, it } from 'vitest';

import { baisa } from './money';
import { computePricing, NO_DISCOUNT, type PricingSnapshot } from './reservation-pricing';
import { reduceLedger, type FinancialEvent, type FinancialEventKind } from './ledger';
import {
  businessLines,
  businessNameFor,
  customerNameFor,
  defaultDocumentLanguage,
  documentDirection,
  documentFinancialsFrom,
  DOCUMENT_LANGUAGES,
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  isDocumentLanguage,
  isDocumentStatus,
  isDocumentType,
  reconcileDocument,
  registrationLines,
  showsArabic,
  showsEnglish,
  type BusinessSnapshot,
  type CustomerSnapshot,
} from './document';

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

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

const BUSINESS: BusinessSnapshot = {
  nameEn: 'Azhary Boutique',
  nameAr: 'أزهاري بوتيك',
  addressEn: 'Muscat',
  addressAr: 'مسقط',
  phone: '91000000',
  whatsapp: '91000000',
  email: 'hello@example.test',
  website: 'example.test',
  vatNumber: '',
  crNumber: '',
  logoPath: null,
};

const CUSTOMER: CustomerSnapshot = {
  code: 'CU-0001',
  nameEn: 'Bride One',
  nameAr: 'العروس',
  phone: '91000001',
  email: '',
  preferredLanguage: 'ar',
};

/* ------------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------------ */

describe('document kinds', () => {
  it('recognises every defined type, language and status', () => {
    for (const value of DOCUMENT_TYPES) expect(isDocumentType(value)).toBe(true);
    for (const value of DOCUMENT_LANGUAGES) expect(isDocumentLanguage(value)).toBe(true);
    for (const value of DOCUMENT_STATUSES) expect(isDocumentStatus(value)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isDocumentType('Invoice')).toBe(false);
    expect(isDocumentLanguage('fr')).toBe(false);
    expect(isDocumentStatus('Deleted')).toBe(false);
  });

  it('offers exactly the three documents the boutique issues', () => {
    expect([...DOCUMENT_TYPES]).toEqual(['Tax Invoice', 'Rental Agreement', 'Payment Receipt']);
  });
});

/* ------------------------------------------------------------------------ *
 * §36 — the invoice never disagrees with the engine
 * ------------------------------------------------------------------------ */

describe('a document copies the engine rather than recomputing it', () => {
  const scenarios: { name: string; events: FinancialEvent[]; snapshot: PricingSnapshot }[] = [
    { name: 'nothing paid', events: [], snapshot: pricing() },
    { name: 'part payment', events: [event('Payment', 60_000)], snapshot: pricing() },
    { name: 'paid in full', events: [event('Payment', 210_000)], snapshot: pricing() },
    {
      name: 'deposit held and rental paid',
      events: [event('SecurityDepositPayment', 100_000), event('Payment', 210_000)],
      snapshot: pricing(),
    },
    {
      name: 'a reversal',
      events: [event('Payment', 60_000), event('PaymentReversal', 60_000)],
      snapshot: pricing(),
    },
    {
      name: 'a late fee',
      events: [event('Payment', 210_000), event('LateFee', 20_000)],
      snapshot: pricing(),
    },
    {
      name: 'a cancellation with a refund',
      events: [event('Payment', 210_000), event('ChargeWaiver', 210_000), event('Refund', 210_000)],
      snapshot: pricing(),
    },
    {
      name: 'a deposit partly kept',
      events: [
        event('SecurityDepositPayment', 100_000),
        event('SecurityDepositForfeiture', 30_000),
        event('SecurityDepositRefund', 70_000),
      ],
      snapshot: pricing(),
    },
    {
      name: 'zero-rated VAT',
      events: [event('Payment', 200_000)],
      snapshot: pricing({ vatRatePercent: 0 }),
    },
    {
      name: 'a discounted rental',
      events: [],
      snapshot: pricing({ discount: { kind: 'percent', value: 15 } }),
    },
  ];

  for (const { name, events, snapshot } of scenarios) {
    it(`reconciles exactly with ${name}`, () => {
      const position = reduceLedger(snapshot, events);
      const financials = documentFinancialsFrom(snapshot, position);

      expect(reconcileDocument(financials, snapshot, position)).toEqual([]);
    });
  }

  it('copies the VAT figures rather than deriving them', () => {
    const snapshot = pricing();
    const financials = documentFinancialsFrom(snapshot, reduceLedger(snapshot, []));

    expect(financials.vatAmount).toBe(snapshot.vatAmount);
    expect(financials.vatRatePercent).toBe(snapshot.vatRatePercent);
    expect(financials.taxableSubtotal).toBe(snapshot.taxableSubtotal);
  });

  it('copies the balance from the ledger rather than subtracting', () => {
    const snapshot = pricing();
    const position = reduceLedger(snapshot, [event('Payment', 60_000)]);
    const financials = documentFinancialsFrom(snapshot, position);

    expect(financials.totalPaid).toBe(position.netPaid);
    expect(financials.outstanding).toBe(position.outstanding);
  });

  it('keeps the security deposit out of the taxable total', () => {
    const snapshot = pricing();
    const financials = documentFinancialsFrom(snapshot, reduceLedger(snapshot, []));

    expect(financials.taxableSubtotal).toBe(200_000);
    expect(financials.securityDepositTotal).toBe(100_000);
    expect(financials.grandTotal).toBe(200_000 + 10_000 + 100_000);
  });

  it('DETECTS a document whose totals were tampered with', () => {
    // Proves the reconciliation is load-bearing rather than vacuously passing.
    const snapshot = pricing();
    const position = reduceLedger(snapshot, []);
    const honest = documentFinancialsFrom(snapshot, position);

    const tampered = { ...honest, grandTotal: baisa(1) };

    const problems = reconcileDocument(tampered, snapshot, position);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/grandTotal/);
  });

  it('DETECTS a document whose paid figure was inflated', () => {
    const snapshot = pricing();
    const position = reduceLedger(snapshot, [event('Payment', 10_000)]);
    const financials = { ...documentFinancialsFrom(snapshot, position), totalPaid: baisa(210_000) };

    expect(reconcileDocument(financials, snapshot, position)).not.toEqual([]);
  });

  it('DETECTS a mismatched financial status', () => {
    const snapshot = pricing();
    const position = reduceLedger(snapshot, []);
    const financials = { ...documentFinancialsFrom(snapshot, position), financialStatus: 'Paid' };

    expect(reconcileDocument(financials, snapshot, position)[0]).toMatch(/financialStatus/);
  });
});

/* ------------------------------------------------------------------------ *
 * Never printing what the boutique has not configured
 * ------------------------------------------------------------------------ */

describe('unconfigured business fields', () => {
  it('omits an unconfigured VAT and CR number entirely', () => {
    expect(registrationLines(BUSINESS)).toEqual([]);
  });

  it('prints them once configured', () => {
    const configured = { ...BUSINESS, vatNumber: 'OM-REAL-1', crNumber: 'CR-REAL-1' };

    expect(registrationLines(configured)).toEqual([
      { labelKey: 'document.vatNumber', value: 'OM-REAL-1' },
      { labelKey: 'document.crNumber', value: 'CR-REAL-1' },
    ]);
  });

  it('treats a whitespace-only registration as unconfigured', () => {
    expect(registrationLines({ ...BUSINESS, vatNumber: '   ', crNumber: '\t' })).toEqual([]);
  });

  it('omits blank contact lines rather than printing empty rows', () => {
    const sparse = { ...BUSINESS, email: '', website: '', phone: '' };

    expect(businessLines(sparse, 'en')).toEqual(['Muscat']);
  });

  it('returns nothing at all for a wholly unconfigured business', () => {
    const blank: BusinessSnapshot = {
      ...BUSINESS,
      addressEn: '',
      addressAr: '',
      phone: '',
      email: '',
      website: '',
    };

    expect(businessLines(blank, 'en')).toEqual([]);
    expect(registrationLines(blank)).toEqual([]);
  });

  it('prefers the Arabic address on an Arabic document', () => {
    expect(businessLines(BUSINESS, 'ar')[0]).toBe('مسقط');
    expect(businessLines(BUSINESS, 'en')[0]).toBe('Muscat');
  });

  it('falls back to the other language rather than printing a blank address', () => {
    expect(businessLines({ ...BUSINESS, addressAr: '' }, 'ar')[0]).toBe('Muscat');
    expect(businessLines({ ...BUSINESS, addressEn: '' }, 'en')[0]).toBe('مسقط');
  });
});

/* ------------------------------------------------------------------------ *
 * Language
 * ------------------------------------------------------------------------ */

describe('document language', () => {
  it('follows the customer when they have a usable preference', () => {
    expect(defaultDocumentLanguage('ar', 'en')).toBe('ar');
    expect(defaultDocumentLanguage('en', 'bilingual')).toBe('en');
    expect(defaultDocumentLanguage('bilingual', 'en')).toBe('bilingual');
  });

  it('falls back to the boutique default when the customer has none', () => {
    expect(defaultDocumentLanguage('', 'bilingual')).toBe('bilingual');
    expect(defaultDocumentLanguage('fr', 'en')).toBe('en');
  });

  it('shows the right columns for each mode', () => {
    expect(showsEnglish('en')).toBe(true);
    expect(showsArabic('en')).toBe(false);

    expect(showsEnglish('ar')).toBe(false);
    expect(showsArabic('ar')).toBe(true);

    expect(showsEnglish('bilingual')).toBe(true);
    expect(showsArabic('bilingual')).toBe(true);
  });

  it('sets the page RTL only for a wholly Arabic document', () => {
    expect(documentDirection('ar')).toBe('rtl');
    expect(documentDirection('en')).toBe('ltr');
    // Mirroring a bilingual page would reverse its English column too.
    expect(documentDirection('bilingual')).toBe('ltr');
  });
});

describe('names on a document', () => {
  it('uses the language the document is written in', () => {
    expect(customerNameFor(CUSTOMER, 'ar')).toBe('العروس');
    expect(customerNameFor(CUSTOMER, 'en')).toBe('Bride One');
    expect(businessNameFor(BUSINESS, 'ar')).toBe('أزهاري بوتيك');
  });

  it('falls back rather than leaving the name blank', () => {
    // A document with no name where the customer should be is worse than one
    // showing the other language's spelling.
    expect(customerNameFor({ ...CUSTOMER, nameAr: '' }, 'ar')).toBe('Bride One');
    expect(customerNameFor({ ...CUSTOMER, nameEn: '' }, 'en')).toBe('العروس');
    expect(businessNameFor({ ...BUSINESS, nameAr: '' }, 'ar')).toBe('Azhary Boutique');
  });

  it('handles a very long Arabic name without throwing', () => {
    const long = 'ا'.repeat(400);
    expect(customerNameFor({ ...CUSTOMER, nameAr: long }, 'ar')).toBe(long);
  });
});
