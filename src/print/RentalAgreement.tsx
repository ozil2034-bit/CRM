/**
 * Rental Agreement.
 *
 * The contract. Unlike the invoice, its centre of gravity is the terms and the
 * signatures rather than the money — the financial summary is present because a
 * customer signing an agreement should see what they are agreeing to pay, but
 * the payment history is not, because a contract records an undertaking rather
 * than a settlement.
 *
 * Signatures are always present on this document, which is what makes it a
 * separate template rather than an invoice with a flag.
 */

import { documentDirection } from '@/domain/document';
import {
  BusinessInfo,
  CustomerInfo,
  DocumentFooter,
  DocumentHeader,
  DressInfo,
  FinancialSummary,
  Label,
  ReservationInfo,
  SignatureSection,
  TermsAndConditions,
  VoidedNotice,
} from './parts';
import type { DocumentProps } from './TaxInvoice';

export function RentalAgreement({
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
        titleEn="Rental Agreement"
        titleAr="عقد إيجار"
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

      <FinancialSummary financials={document.financials} language={lang} />

      {document.notes.trim().length > 0 && (
        <section className="doc__section doc__keep">
          <h2>
            <Label en="Notes" ar="ملاحظات" language={lang} />
          </h2>
          <p className="doc__small">{document.notes}</p>
        </section>
      )}

      <TermsAndConditions terms={document.terms} language={lang} />

      {/*
       * The acknowledgement sits immediately above the signature lines, because
       * a signature under a page break with nothing above it is not evidence of
       * agreeing to anything. Both are inside blocks that cannot be split.
       */}
      <section className="doc__section doc__keep">
        <p className="doc__small">
          {(lang === 'en' || lang === 'bilingual') && (
            <span style={{ display: 'block' }}>
              By signing below, the customer confirms they have read and accepted the terms and
              conditions above, and agree to the amounts shown.
            </span>
          )}
          {(lang === 'ar' || lang === 'bilingual') && (
            <span className="doc__ar-text" style={{ display: 'block' }}>
              بالتوقيع أدناه، تُقرّ العميلة بأنها قرأت الشروط والأحكام الواردة أعلاه ووافقت عليها،
              وعلى المبالغ الموضحة.
            </span>
          )}
        </p>

        <SignatureSection language={lang} />
      </section>

      <DocumentFooter business={document.business} language={lang} />
    </article>
  );
}
