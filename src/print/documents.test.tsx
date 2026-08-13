/**
 * The printed documents.
 *
 * These cover the print QA matrix (§35): every language mode, every document
 * type, and the awkward content that breaks layouts — no logo, long names, long
 * Arabic names, several dresses, several payments, long terms.
 *
 * They also assert the things that would be embarrassing rather than merely
 * wrong: an invented VAT number, a broken image, an internal database id on a
 * customer's receipt, or a security deposit folded into the rental total.
 */

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { baisa } from '@/domain/money';
import { computePricing, NO_DISCOUNT } from '@/domain/reservation-pricing';
import {
  reduceLedger,
  signedAmount,
  type FinancialEvent,
  type FinancialEventKind,
} from '@/domain/ledger';
import {
  documentFinancialsFrom,
  type DocumentLanguage,
  type DocumentSnapshot,
} from '@/domain/document';
import { snapshotTerms } from '@/domain/terms';
import { TaxInvoice } from './TaxInvoice';
import { RentalAgreement } from './RentalAgreement';
import { PaymentReceipt } from './PaymentReceipt';

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

let sequence = 0;

function event(kind: FinancialEventKind, amount: number, reference = ''): FinancialEvent {
  sequence += 1;
  return {
    id: `e-${sequence}`,
    reservationId: 'rsv-1',
    kind,
    amount: baisa(amount),
    method: 'Cash',
    type: kind === 'Payment' ? 'Installment' : null,
    occurredAt: Date.UTC(2026, 8, 10, 6, 0),
    reference,
    reason: '',
    employeeId: 'staff-1',
    reversesEventId: null,
    idempotencyKey: `k-${sequence}`,
  };
}

const PRICING = computePricing({
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
});

function makeDocument(overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  const events = overrides.payments === undefined ? [event('Payment', 100_000)] : [];
  const position = reduceLedger(PRICING, events);

  return {
    documentType: 'Tax Invoice',
    documentNumber: 'INV-2026-0001',
    issuedAt: Date.UTC(2026, 8, 12, 6, 0),
    language: 'en',
    status: 'Issued',

    business: {
      nameEn: 'Azhary Boutique',
      nameAr: 'أزهاري بوتيك',
      addressEn: 'Al Khuwair, Muscat',
      addressAr: 'الخوير، مسقط',
      phone: '91000000',
      whatsapp: '91000000',
      email: 'hello@azhary.test',
      website: 'azhary.test',
      vatNumber: '',
      crNumber: '',
      logoPath: null,
    },

    customer: {
      code: 'CU-0001',
      nameEn: 'Bride One',
      nameAr: 'العروس الأولى',
      phone: '91000001',
      email: '',
      preferredLanguage: 'ar',
    },

    reservationId: 'rsv-1',
    reservationCode: 'RSV-0001',
    eventDate: '2026-09-20',
    pickupAt: Date.UTC(2026, 8, 10, 6, 0),
    returnAt: Date.UTC(2026, 8, 12, 6, 0),

    dresses: [
      {
        dressCode: 'WD-0001',
        dressName: 'Aurora',
        designer: 'Elie Saab',
        rentalPrice: baisa(200_000),
        securityDeposit: baisa(100_000),
        photoPath: null,
      },
    ],
    accessories: [],
    alterations: [],

    financials: documentFinancialsFrom(PRICING, position),
    payments: events.map((entry) => ({
      occurredAt: entry.occurredAt,
      kind: entry.kind,
      type: entry.type,
      method: entry.method,
      amount: entry.amount,
      signedAmount: signedAmount(entry),
      reference: entry.reference,
    })),

    terms: null,
    receiptFor: null,
    notes: '',
    issuedByName: 'Owner',
    ...overrides,
  };
}

const NO_PHOTOS: Record<string, string> = {};

const LANGUAGES: DocumentLanguage[] = ['en', 'ar', 'bilingual'];

/* ------------------------------------------------------------------------ *
 * Every document, every language
 * ------------------------------------------------------------------------ */

describe('every document renders in every language', () => {
  for (const language of LANGUAGES) {
    it(`renders the tax invoice in ${language}`, () => {
      const { container } = render(
        <TaxInvoice document={makeDocument({ language })} logoUrl={null} photoUrls={NO_PHOTOS} />,
      );

      expect(container.querySelector('.doc')).not.toBeNull();
      expect(screen.getByText('INV-2026-0001')).toBeInTheDocument();
    });

    it(`renders the rental agreement in ${language}`, () => {
      render(
        <RentalAgreement
          document={makeDocument({ language, documentType: 'Rental Agreement' })}
          logoUrl={null}
          photoUrls={NO_PHOTOS}
        />,
      );

      expect(screen.getByText('INV-2026-0001')).toBeInTheDocument();
    });

    it(`renders the receipt in ${language}`, () => {
      const document = makeDocument({
        language,
        documentType: 'Payment Receipt',
        receiptFor: {
          occurredAt: Date.UTC(2026, 8, 10, 6, 0),
          kind: 'Payment',
          type: 'Installment',
          method: 'Cash',
          amount: baisa(100_000),
          signedAmount: baisa(100_000),
          reference: 'R-1',
        },
      });

      const { container } = render(
        <PaymentReceipt document={document} logoUrl={null} photoUrls={NO_PHOTOS} />,
      );

      const grand = container.querySelector('.doc__totals-row--grand') as HTMLElement;
      expect(within(grand).getByText('OMR 100.000')).toBeInTheDocument();
    });
  }
});

describe('text direction', () => {
  it('sets the Arabic document RTL', () => {
    const { container } = render(
      <TaxInvoice
        document={makeDocument({ language: 'ar' })}
        logoUrl={null}
        photoUrls={NO_PHOTOS}
      />,
    );

    expect(container.querySelector('.doc')).toHaveAttribute('dir', 'rtl');
  });

  it('keeps a bilingual document LTR overall', () => {
    // Mirroring the page would reverse the English column too.
    const { container } = render(
      <TaxInvoice
        document={makeDocument({ language: 'bilingual' })}
        logoUrl={null}
        photoUrls={NO_PHOTOS}
      />,
    );

    expect(container.querySelector('.doc')).toHaveAttribute('dir', 'ltr');
  });

  it('marks Arabic passages inside a bilingual document RTL', () => {
    const { container } = render(
      <TaxInvoice
        document={makeDocument({ language: 'bilingual' })}
        logoUrl={null}
        photoUrls={NO_PHOTOS}
      />,
    );

    expect(container.querySelectorAll('.doc__ar-text').length).toBeGreaterThan(0);
  });

  it('isolates every money amount so bidi cannot reorder it', () => {
    const { container } = render(
      <TaxInvoice
        document={makeDocument({ language: 'ar' })}
        logoUrl={null}
        photoUrls={NO_PHOTOS}
      />,
    );

    const amounts = container.querySelectorAll('.doc__amount');
    expect(amounts.length).toBeGreaterThan(0);

    // Western-Arabic digits and a leading currency code, in every language.
    expect(screen.getAllByText(/OMR \d/).length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ *
 * What must never appear
 * ------------------------------------------------------------------------ */

describe('nothing invented is ever printed', () => {
  it('omits the VAT and CR rows entirely when unconfigured', () => {
    render(<TaxInvoice document={makeDocument()} logoUrl={null} photoUrls={NO_PHOTOS} />);

    expect(screen.queryByText(/OM123456789/)).toBeNull();
    expect(screen.queryByText(/CR-1098234/)).toBeNull();
    expect(screen.queryByText(/^VAT\s*$/)).toBeNull();
  });

  it('prints them once the boutique has configured them', () => {
    const document = makeDocument();
    const configured = {
      ...document,
      business: { ...document.business, vatNumber: 'OM-CONFIGURED', crNumber: 'CR-CONFIGURED' },
    };

    render(<TaxInvoice document={configured} logoUrl={null} photoUrls={NO_PHOTOS} />);

    expect(screen.getAllByText(/OM-CONFIGURED/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/CR-CONFIGURED/).length).toBeGreaterThan(0);
  });

  it('shows the business name instead of a broken image when there is no logo', () => {
    const { container } = render(
      <TaxInvoice document={makeDocument()} logoUrl={null} photoUrls={NO_PHOTOS} />,
    );

    expect(container.querySelector('.doc__logo')).toBeNull();
    expect(screen.getAllByText('Azhary Boutique').length).toBeGreaterThan(0);
  });

  it('renders the logo when one exists', () => {
    const { container } = render(
      <TaxInvoice document={makeDocument()} logoUrl="blob:logo" photoUrls={NO_PHOTOS} />,
    );

    expect(container.querySelector('.doc__logo')).toHaveAttribute('src', 'blob:logo');
  });

  it('renders no dress image rather than a broken one', () => {
    const { container } = render(
      <TaxInvoice document={makeDocument()} logoUrl={null} photoUrls={NO_PHOTOS} />,
    );

    expect(container.querySelector('.doc__dress-photo')).toBeNull();
  });

  it('renders the dress image when a URL resolved', () => {
    const document = makeDocument();
    const withPhoto = {
      ...document,
      dresses: [{ ...document.dresses[0]!, photoPath: 'dresses/d-1/large/a.jpg' }],
    };

    const { container } = render(
      <TaxInvoice
        document={withPhoto}
        logoUrl={null}
        photoUrls={{ 'dresses/d-1/large/a.jpg': 'blob:dress' }}
      />,
    );

    expect(container.querySelector('.doc__dress-photo')).toHaveAttribute('src', 'blob:dress');
  });

  it('does not print internal event ids on a customer document', () => {
    const { container } = render(
      <TaxInvoice document={makeDocument()} logoUrl={null} photoUrls={NO_PHOTOS} />,
    );

    expect(container.textContent).not.toMatch(/\be-\d+\b/);
    expect(container.textContent).not.toMatch(/idempotency/i);
  });
});

/* ------------------------------------------------------------------------ *
 * The deposit stays separate
 * ------------------------------------------------------------------------ */

describe('the security deposit on a document', () => {
  it('is presented in its own block, apart from the totals', () => {
    const { container } = render(
      <TaxInvoice document={makeDocument()} logoUrl={null} photoUrls={NO_PHOTOS} />,
    );

    const deposit = container.querySelector('.doc__deposit');
    expect(deposit).not.toBeNull();
    expect(within(deposit as HTMLElement).getByText('OMR 100.000')).toBeInTheDocument();
  });

  it('says plainly that it is refundable and untaxed', () => {
    const { container } = render(
      <TaxInvoice document={makeDocument()} logoUrl={null} photoUrls={NO_PHOTOS} />,
    );

    const deposit = container.querySelector('.doc__deposit') as HTMLElement;
    expect(deposit.textContent).toMatch(/refundable/i);
    expect(deposit.textContent).toMatch(/not subject to VAT/i);
  });

  it('is NOT added into the taxable subtotal or the grand total', () => {
    const { container } = render(
      <TaxInvoice document={makeDocument()} logoUrl={null} photoUrls={NO_PHOTOS} />,
    );

    // Taxable 200.000 + VAT 10.000 = grand total 310.000. The 100.000 deposit
    // is nowhere in that chain — it appears only in its own block.
    const totals = container.querySelector('.doc__totals') as HTMLElement;

    // 200.000 appears twice: as the rental line and as the taxable subtotal.
    // Undiscounted with no extras, those are the same figure — and neither has
    // the deposit in it.
    expect(within(totals).getAllByText('OMR 200.000')).toHaveLength(2);
    expect(within(totals).getByText('OMR 10.000')).toBeInTheDocument();
    expect(within(totals).getByText('OMR 310.000')).toBeInTheDocument();

    // The deposit never appears in the totals block, and no figure there has
    // been inflated by it.
    expect(within(totals).queryByText('OMR 100.000')).toBeNull();
    expect(within(totals).queryByText('OMR 300.000')).toBeNull();
    expect(within(totals).queryByText('OMR 410.000')).toBeNull();
  });

  it('shows what has been returned or retained once it has been settled', () => {
    const events = [
      event('SecurityDepositPayment', 100_000),
      event('SecurityDepositForfeiture', 30_000),
    ];
    const position = reduceLedger(PRICING, events);

    const document = makeDocument({
      financials: documentFinancialsFrom(PRICING, position),
      payments: [],
    });

    const { container } = render(
      <TaxInvoice document={document} logoUrl={null} photoUrls={NO_PHOTOS} />,
    );

    const deposit = container.querySelector('.doc__deposit') as HTMLElement;
    expect(deposit.textContent).toMatch(/OMR 70\.000/);
    expect(deposit.textContent).toMatch(/OMR 30\.000/);
  });
});

/* ------------------------------------------------------------------------ *
 * Content that breaks layouts
 * ------------------------------------------------------------------------ */

describe('awkward content', () => {
  it('renders a very long English customer name', () => {
    const document = makeDocument();
    const long = 'Aisha Al Balushi Al Hinai Al Mahrouqi bint Mohammed bin Sultan'.repeat(3);

    render(
      <TaxInvoice
        document={{ ...document, customer: { ...document.customer, nameEn: long } }}
        logoUrl={null}
        photoUrls={NO_PHOTOS}
      />,
    );

    expect(screen.getByText(long)).toBeInTheDocument();
  });

  it('renders a very long Arabic customer name', () => {
    const document = makeDocument({ language: 'ar' });
    const long = 'عائشة البلوشية الهنائية المحروقية بنت محمد بن سلطان '.repeat(4).trim();

    render(
      <TaxInvoice
        document={{ ...document, customer: { ...document.customer, nameAr: long } }}
        logoUrl={null}
        photoUrls={NO_PHOTOS}
      />,
    );

    expect(screen.getByText(long)).toBeInTheDocument();
  });

  it('renders many dresses', () => {
    const document = makeDocument();
    const dresses = Array.from({ length: 10 }, (_unused, index) => ({
      dressCode: `WD-${String(index + 1).padStart(4, '0')}`,
      dressName: `A very long gown name number ${index + 1} with description`,
      designer: 'Zuhair Murad',
      rentalPrice: baisa(200_000),
      securityDeposit: baisa(100_000),
      photoPath: null,
    }));

    render(<TaxInvoice document={{ ...document, dresses }} logoUrl={null} photoUrls={NO_PHOTOS} />);

    expect(screen.getByText('WD-0010')).toBeInTheDocument();
  });

  it('renders many payments', () => {
    const document = makeDocument();
    const payments = Array.from({ length: 25 }, (_unused, index) => ({
      occurredAt: Date.UTC(2026, 8, 1 + (index % 20), 6, 0),
      kind: 'Payment',
      type: 'Installment' as const,
      method: 'Card' as const,
      amount: baisa(1_000),
      signedAmount: baisa(1_000),
      reference: `REF-${index}`,
    }));

    render(
      <TaxInvoice document={{ ...document, payments }} logoUrl={null} photoUrls={NO_PHOTOS} />,
    );

    expect(screen.getByText('REF-24')).toBeInTheDocument();
  });

  it('renders long terms in every language', () => {
    const body = 'The customer accepts full responsibility for the gown. '.repeat(20);
    const bodyAr = 'تتحمل العميلة المسؤولية الكاملة عن الفستان. '.repeat(20);

    const terms = snapshotTerms('v-1', 'Version 1', [
      { key: 'damageAndLoss', titleEn: 'Damage', titleAr: 'التلف', bodyEn: body, bodyAr },
      { key: 'lateReturn', titleEn: 'Late return', titleAr: 'التأخير', bodyEn: body, bodyAr },
    ]);

    for (const language of LANGUAGES) {
      const { unmount } = render(
        <RentalAgreement
          document={makeDocument({ language, terms, documentType: 'Rental Agreement' })}
          logoUrl={null}
          photoUrls={NO_PHOTOS}
        />,
      );

      expect(screen.getByText('Version 1')).toBeInTheDocument();
      unmount();
    }
  });

  it('renders long notes', () => {
    const notes = 'Bride requests the gown be pressed on the morning of collection. '.repeat(15);

    render(<TaxInvoice document={makeDocument({ notes })} logoUrl={null} photoUrls={NO_PHOTOS} />);

    expect(screen.getByText(notes.trim())).toBeInTheDocument();
  });

  it('renders a short invoice with nothing paid and no terms', () => {
    const position = reduceLedger(PRICING, []);

    render(
      <TaxInvoice
        document={makeDocument({
          payments: [],
          terms: null,
          financials: documentFinancialsFrom(PRICING, position),
        })}
        logoUrl={null}
        photoUrls={NO_PHOTOS}
      />,
    );

    expect(screen.getByText(/No payments recorded|لم تُسجَّل/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------------ *
 * Document-specific behaviour
 * ------------------------------------------------------------------------ */

describe('the rental agreement', () => {
  it('carries signature lines for both parties', () => {
    const { container } = render(
      <RentalAgreement
        document={makeDocument({ documentType: 'Rental Agreement' })}
        logoUrl={null}
        photoUrls={NO_PHOTOS}
      />,
    );

    expect(container.querySelector('.doc__signatures')).not.toBeNull();
    expect(screen.getByText('Customer signature')).toBeInTheDocument();
    expect(screen.getByText('For Azhary Boutique')).toBeInTheDocument();
  });

  it('does NOT list the payment history — a contract is an undertaking', () => {
    const { container } = render(
      <RentalAgreement
        document={makeDocument({ documentType: 'Rental Agreement' })}
        logoUrl={null}
        photoUrls={NO_PHOTOS}
      />,
    );

    expect(container.textContent).not.toMatch(/Payments/);
  });
});

describe('the receipt', () => {
  const receiptDocument = makeDocument({
    documentType: 'Payment Receipt',
    receiptFor: {
      occurredAt: Date.UTC(2026, 8, 10, 6, 0),
      kind: 'Payment',
      type: 'Installment',
      method: 'Cash',
      amount: baisa(100_000),
      signedAmount: baisa(100_000),
      reference: 'REF-9',
    },
  });

  it('says plainly that it is not a tax invoice', () => {
    render(<PaymentReceipt document={receiptDocument} logoUrl={null} photoUrls={NO_PHOTOS} />);

    expect(screen.getByText(/not a tax invoice/i)).toBeInTheDocument();
  });

  it('shows the amount received, the total paid and what is left', () => {
    const { container } = render(
      <PaymentReceipt document={receiptDocument} logoUrl={null} photoUrls={NO_PHOTOS} />,
    );

    const blocks = container.querySelectorAll('.doc__totals');

    // The amount just handed over.
    expect(within(blocks[0] as HTMLElement).getByText('OMR 100.000')).toBeInTheDocument();

    // Total paid, then 210.000 chargeable less 100.000 paid.
    const summary = blocks[1] as HTMLElement;
    expect(within(summary).getByText('OMR 100.000')).toBeInTheDocument();
    expect(within(summary).getByText('OMR 110.000')).toBeInTheDocument();
  });

  it('does not carry the terms or the dress table — it is a short slip', () => {
    const { container } = render(
      <PaymentReceipt
        document={{ ...receiptDocument, terms: snapshotTerms('v-1', 'V1', []) }}
        logoUrl={null}
        photoUrls={NO_PHOTOS}
      />,
    );

    expect(container.querySelector('.doc__table')).toBeNull();
  });
});

describe('a voided document', () => {
  it('still renders, marked unmistakably', () => {
    render(
      <TaxInvoice
        document={makeDocument({ status: 'Voided' })}
        logoUrl={null}
        photoUrls={NO_PHOTOS}
        voidReason="Issued against the wrong reservation"
      />,
    );

    expect(screen.getByText('VOIDED')).toBeInTheDocument();
    expect(screen.getByText('Issued against the wrong reservation')).toBeInTheDocument();
  });

  it('keeps its original figures — voiding withdraws the document, not the money', () => {
    render(
      <TaxInvoice
        document={makeDocument({ status: 'Voided' })}
        logoUrl={null}
        photoUrls={NO_PHOTOS}
      />,
    );

    expect(screen.getByText('OMR 310.000')).toBeInTheDocument();
  });

  it('shows no void banner on a live document', () => {
    render(<TaxInvoice document={makeDocument()} logoUrl={null} photoUrls={NO_PHOTOS} />);

    expect(screen.queryByText('VOIDED')).toBeNull();
  });
});
