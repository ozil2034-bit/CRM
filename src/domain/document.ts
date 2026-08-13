/**
 * Documents — invoices, rental agreements and receipts.
 *
 * ## The rule that governs this whole module
 *
 * **A document computes nothing.** Every figure on an invoice is copied from
 * the authoritative sources: the reservation's frozen `PricingSnapshot` and the
 * `FinancialPosition` produced by `reduceLedger` over the ledger. There is no
 * VAT calculation here, no balance arithmetic, no summing of payments.
 *
 * That is not tidiness. A document that recomputes its own totals is a second
 * implementation of the financial engine, and the moment the two disagree the
 * copy that is wrong is the one the customer is holding.
 *
 * ## Immutability
 *
 * An issued document is a **snapshot**. It captures the business details, the
 * customer, the dresses, the money and the terms exactly as they stood at the
 * moment of issue. Changing a price, a logo, a customer's name, the VAT rate or
 * the terms afterwards cannot reach back into it — which is the entire point of
 * a document the customer keeps.
 *
 * Pure: no I/O, no Firebase, no clock. Shared with the Cloud Functions build.
 */

import type { Baisa } from './money';
import type { EpochMs } from './datetime';
import type { FinancialPosition, PaymentMethod, PaymentType } from './ledger';
import type { PricingSnapshot } from './reservation-pricing';

/* ------------------------------------------------------------------------ *
 * Kinds, languages, statuses
 * ------------------------------------------------------------------------ */

export const DOCUMENT_TYPES = ['Tax Invoice', 'Rental Agreement', 'Payment Receipt'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value);
}

/**
 * How a document is rendered.
 *
 * `bilingual` is not the English document followed by the Arabic one. It is a
 * single document whose labels are paired and whose contractual clauses sit
 * side by side, because a contract signed in two languages must show that both
 * texts describe the same agreement.
 */
export const DOCUMENT_LANGUAGES = ['en', 'ar', 'bilingual'] as const;
export type DocumentLanguage = (typeof DOCUMENT_LANGUAGES)[number];

export function isDocumentLanguage(value: unknown): value is DocumentLanguage {
  return typeof value === 'string' && (DOCUMENT_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Which language a document should default to.
 *
 * The customer's own preference leads — a document is for them to read. An
 * employee may override at issue time, and the override is snapshotted, so
 * changing the boutique's default language later cannot alter a document that
 * has already been given to somebody.
 */
export function defaultDocumentLanguage(
  customerPreference: string,
  boutiqueDefault: DocumentLanguage,
): DocumentLanguage {
  if (isDocumentLanguage(customerPreference)) return customerPreference;
  return boutiqueDefault;
}

export const DOCUMENT_STATUSES = ['Draft', 'Issued', 'Voided'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export function isDocumentStatus(value: unknown): value is DocumentStatus {
  return typeof value === 'string' && (DOCUMENT_STATUSES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------------ *
 * The snapshot pieces
 * ------------------------------------------------------------------------ */

/**
 * The boutique, as it was.
 *
 * Every field is optional in practice: an unconfigured VAT number is **omitted**
 * from the document, never rendered as a placeholder. Printing an invented
 * registration number on a tax invoice would be a false statement to a customer
 * and to the tax authority.
 */
export interface BusinessSnapshot {
  readonly nameEn: string;
  readonly nameAr: string;
  readonly addressEn: string;
  readonly addressAr: string;
  readonly phone: string;
  readonly whatsapp: string;
  readonly email: string;
  readonly website: string;
  readonly vatNumber: string;
  readonly crNumber: string;
  /**
   * Storage path of the logo as it stood at issue.
   *
   * A path, not the bytes: Firestore documents are not an image store, and a
   * base64 logo repeated across every invoice would bloat the database for no
   * benefit. Replacing the logo uploads a **new object under a new path**, so
   * the path recorded here keeps resolving to the logo that was actually
   * printed.
   */
  readonly logoPath: string | null;
}

export interface CustomerSnapshot {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly phone: string;
  readonly email: string;
  readonly preferredLanguage: string;
}

export interface DocumentDressLine {
  readonly dressCode: string;
  readonly dressName: string;
  readonly designer: string;
  readonly rentalPrice: Baisa;
  readonly securityDeposit: Baisa;
  /** Storage path of the primary photograph, or null if the dress has none. */
  readonly photoPath: string | null;
}

export interface DocumentAccessoryLine {
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: Baisa;
  readonly lineTotal: Baisa;
}

export interface DocumentAlterationLine {
  readonly description: string;
  readonly amount: Baisa;
}

/** One line on the payment history, as printed. */
export interface DocumentPaymentLine {
  readonly occurredAt: EpochMs;
  readonly kind: string;
  readonly type: PaymentType | null;
  readonly method: PaymentMethod | null;
  readonly amount: Baisa;
  /** Signed for display: money out prints as a negative line. */
  readonly signedAmount: Baisa;
  readonly reference: string;
}

/**
 * The financial figures, **copied** from the authoritative sources.
 *
 * Every field here has exactly one origin, named in the comment. Nothing is
 * derived a second time.
 */
export interface DocumentFinancials {
  /* From the reservation's frozen PricingSnapshot */
  readonly rentalSubtotal: Baisa;
  readonly accessorySubtotal: Baisa;
  readonly alterationSubtotal: Baisa;
  readonly discountAmount: Baisa;
  readonly taxableSubtotal: Baisa;
  readonly vatRatePercent: number;
  readonly vatAmount: Baisa;
  readonly securityDepositTotal: Baisa;
  readonly grandTotal: Baisa;

  /* From reduceLedger over the financial events */
  readonly lateFees: Baisa;
  readonly waivedCharges: Baisa;
  readonly totalChargeable: Baisa;
  readonly totalPaid: Baisa;
  readonly outstanding: Baisa;
  readonly refundable: Baisa;
  readonly depositHeld: Baisa;
  readonly depositRefunded: Baisa;
  readonly depositForfeited: Baisa;
  readonly financialStatus: string;
}

export interface TermsSnapshot {
  readonly versionId: string;
  readonly versionLabel: string;
  readonly sections: readonly TermsSection[];
}

export interface TermsSection {
  readonly key: string;
  readonly titleEn: string;
  readonly titleAr: string;
  readonly bodyEn: string;
  readonly bodyAr: string;
}

/* ------------------------------------------------------------------------ *
 * The document
 * ------------------------------------------------------------------------ */

export interface DocumentSnapshot {
  readonly documentType: DocumentType;
  readonly documentNumber: string;
  readonly issuedAt: EpochMs;
  readonly language: DocumentLanguage;
  readonly status: DocumentStatus;

  readonly business: BusinessSnapshot;
  readonly customer: CustomerSnapshot;

  readonly reservationId: string;
  readonly reservationCode: string;
  readonly eventDate: string;
  readonly pickupAt: EpochMs;
  readonly returnAt: EpochMs;

  readonly dresses: readonly DocumentDressLine[];
  readonly accessories: readonly DocumentAccessoryLine[];
  readonly alterations: readonly DocumentAlterationLine[];

  readonly financials: DocumentFinancials;
  readonly payments: readonly DocumentPaymentLine[];

  readonly terms: TermsSnapshot | null;

  /** Set only on a Payment Receipt: the single event it acknowledges. */
  readonly receiptFor: DocumentPaymentLine | null;

  readonly notes: string;
  readonly issuedByName: string;
}

/* ------------------------------------------------------------------------ *
 * Building the financial section
 * ------------------------------------------------------------------------ */

/**
 * Copy the financial figures onto a document.
 *
 * **This function performs no arithmetic.** Every value is read from either the
 * frozen pricing snapshot or the position `reduceLedger` produced, so a
 * document cannot disagree with the ledger it was made from. `reconcileDocument`
 * below asserts exactly that, and is run in the tests over every document built.
 */
export function documentFinancialsFrom(
  pricing: PricingSnapshot,
  position: FinancialPosition,
): DocumentFinancials {
  return {
    rentalSubtotal: pricing.rentalSubtotal,
    accessorySubtotal: pricing.accessorySubtotal,
    alterationSubtotal: pricing.alterationSubtotal,
    discountAmount: pricing.discountAmount,
    taxableSubtotal: pricing.taxableSubtotal,
    vatRatePercent: pricing.vatRatePercent,
    vatAmount: pricing.vatAmount,
    securityDepositTotal: pricing.securityDepositTotal,
    grandTotal: pricing.grandTotal,

    lateFees: position.lateFees,
    waivedCharges: position.waivedCharges,
    totalChargeable: position.totalChargeable,
    totalPaid: position.netPaid,
    outstanding: position.outstanding,
    refundable: position.refundable,
    depositHeld: position.depositHeld,
    depositRefunded: position.depositRefunded,
    depositForfeited: position.depositForfeited,
    financialStatus: position.status,
  };
}

/**
 * Prove a document agrees with the engine it came from.
 *
 * Returns the discrepancies, empty when the document is faithful. Any finding
 * here means a document was built by something other than
 * `documentFinancialsFrom` — which is the failure this phase must not have.
 */
export function reconcileDocument(
  financials: DocumentFinancials,
  pricing: PricingSnapshot,
  position: FinancialPosition,
): string[] {
  const problems: string[] = [];

  const compare = (label: string, onDocument: number, authoritative: number): void => {
    if (onDocument !== authoritative) {
      problems.push(`${label}: document ${onDocument}, engine ${authoritative}`);
    }
  };

  compare('rentalSubtotal', financials.rentalSubtotal, pricing.rentalSubtotal);
  compare('accessorySubtotal', financials.accessorySubtotal, pricing.accessorySubtotal);
  compare('alterationSubtotal', financials.alterationSubtotal, pricing.alterationSubtotal);
  compare('discountAmount', financials.discountAmount, pricing.discountAmount);
  compare('taxableSubtotal', financials.taxableSubtotal, pricing.taxableSubtotal);
  compare('vatRatePercent', financials.vatRatePercent, pricing.vatRatePercent);
  compare('vatAmount', financials.vatAmount, pricing.vatAmount);
  compare('securityDepositTotal', financials.securityDepositTotal, pricing.securityDepositTotal);
  compare('grandTotal', financials.grandTotal, pricing.grandTotal);

  compare('lateFees', financials.lateFees, position.lateFees);
  compare('waivedCharges', financials.waivedCharges, position.waivedCharges);
  compare('totalChargeable', financials.totalChargeable, position.totalChargeable);
  compare('totalPaid', financials.totalPaid, position.netPaid);
  compare('outstanding', financials.outstanding, position.outstanding);
  compare('refundable', financials.refundable, position.refundable);
  compare('depositHeld', financials.depositHeld, position.depositHeld);
  compare('depositRefunded', financials.depositRefunded, position.depositRefunded);
  compare('depositForfeited', financials.depositForfeited, position.depositForfeited);

  if (financials.financialStatus !== position.status) {
    problems.push(
      `financialStatus: document ${financials.financialStatus}, engine ${position.status}`,
    );
  }

  return problems;
}

/* ------------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------------ */

/**
 * Fields the document should print, with blanks removed.
 *
 * An unconfigured VAT or CR number is **omitted entirely**, not rendered as
 * an empty row or a placeholder. `OM123456789` and the like are never printed:
 * a fabricated registration number on a tax invoice is a false statement.
 */
export function businessLines(business: BusinessSnapshot, language: DocumentLanguage): string[] {
  const arabic = language === 'ar';

  const candidates = [
    arabic ? business.addressAr || business.addressEn : business.addressEn || business.addressAr,
    business.phone,
    business.email,
    business.website,
  ];

  return candidates.map((value) => value.trim()).filter((value) => value.length > 0);
}

/** Registration identifiers, printed only when the boutique has configured them. */
export function registrationLines(
  business: BusinessSnapshot,
): { readonly labelKey: 'document.vatNumber' | 'document.crNumber'; readonly value: string }[] {
  const lines: { labelKey: 'document.vatNumber' | 'document.crNumber'; value: string }[] = [];

  if (business.vatNumber.trim().length > 0) {
    lines.push({ labelKey: 'document.vatNumber', value: business.vatNumber.trim() });
  }
  if (business.crNumber.trim().length > 0) {
    lines.push({ labelKey: 'document.crNumber', value: business.crNumber.trim() });
  }

  return lines;
}

/** Whether both language columns should render. */
export function showsEnglish(language: DocumentLanguage): boolean {
  return language === 'en' || language === 'bilingual';
}

export function showsArabic(language: DocumentLanguage): boolean {
  return language === 'ar' || language === 'bilingual';
}

/**
 * The text direction of the document as a whole.
 *
 * A bilingual document is laid out left-to-right, with the Arabic column
 * marked `dir="rtl"` internally. Setting the whole page RTL would mirror the
 * English column too, and an English address read right-to-left is not a
 * document anyone would accept.
 */
export function documentDirection(language: DocumentLanguage): 'ltr' | 'rtl' {
  return language === 'ar' ? 'rtl' : 'ltr';
}

/**
 * A customer's name in the document's language, falling back rather than
 * printing nothing.
 *
 * A document with a blank name where the customer should be is worse than one
 * showing the other language's spelling of it.
 */
export function customerNameFor(customer: CustomerSnapshot, language: DocumentLanguage): string {
  if (language === 'ar') return customer.nameAr || customer.nameEn;
  return customer.nameEn || customer.nameAr;
}

export function businessNameFor(business: BusinessSnapshot, language: DocumentLanguage): string {
  if (language === 'ar') return business.nameAr || business.nameEn;
  return business.nameEn || business.nameAr;
}
