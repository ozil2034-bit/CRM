/**
 * Tax Invoice.
 *
 * The document a customer keeps for their records and the boutique keeps for
 * the tax authority. It shows what was rented, what it cost, what VAT applied,
 * what has been paid and what is left.
 *
 * Every figure comes from the snapshot. Nothing on this page is calculated.
 */

import { documentDirection, type DocumentLanguage, type DocumentSnapshot } from '@/domain/document';
import {
  BusinessInfo,
  CustomerInfo,
  DocumentFooter,
  DocumentHeader,
  DressInfo,
  AmendmentLines,
  FinancialSummary,
  Label,
  PaymentSummary,
  ReservationInfo,
  TermsAndConditions,
  VoidedNotice,
} from './parts';

export interface DocumentProps {
  readonly document: DocumentSnapshot;
  /** Resolved download URLs, keyed by the storage path on the snapshot. */
  readonly logoUrl: string | null;
  readonly photoUrls: Readonly<Record<string, string>>;
  /** Overrides the snapshot's language for preview. Issued documents pass none. */
  readonly language?: DocumentLanguage;
  readonly voidReason?: string;
}

export function TaxInvoice({
  document,
  logoUrl,
  photoUrls,
  language,
  voidReason = '',
}: DocumentProps) {
  const lang = language ?? document.language;

  return (
    <article className={`doc doc--${lang}`} dir={documentDirection(lang)}>
      {document.status === 'Voided' && <VoidedNotice reason={voidReason} language={lang} />}

      <DocumentHeader
        business={document.business}
        logoUrl={logoUrl}
        language={lang}
        titleEn="Tax Invoice"
        titleAr="فاتورة ضريبية"
        documentNumber={document.documentNumber}
        issuedAt={document.issuedAt}
      />

      <div style={{ marginTop: '2mm' }}>
        <BusinessInfo business={document.business} language={lang} />
      </div>

      <hr className="doc__rule" />

      <div className="doc__grid-2">
        <CustomerInfo customer={document.customer} language={lang} />
        <ReservationInfo
          reservationCode={document.reservationCode}
          eventDate={document.eventDate}
          pickupAt={document.pickupAt}
          returnAt={document.returnAt}
          language={lang}
        />
      </div>

      <DressInfo dresses={document.dresses} photoUrls={photoUrls} language={lang} />

      <AmendmentLines
        accessories={document.accessories}
        alterations={document.alterations}
        language={lang}
      />

      <FinancialSummary financials={document.financials} language={lang} />

      <PaymentSummary
        payments={document.payments}
        financials={document.financials}
        language={lang}
      />

      {document.notes.trim().length > 0 && (
        <section className="doc__section doc__keep">
          <h2>
            <Label en="Notes" ar="ملاحظات" language={lang} />
          </h2>
          <p className="doc__small">{document.notes}</p>
        </section>
      )}

      <TermsAndConditions terms={document.terms} language={lang} />

      <DocumentFooter business={document.business} language={lang} />
    </article>
  );
}
