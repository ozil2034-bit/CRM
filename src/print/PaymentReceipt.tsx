/**
 * Payment Receipt.
 *
 * Deliberately short: it acknowledges **one** payment. A bride paying an
 * instalment at the counter wants a slip confirming what she just handed over
 * and what is left, not four pages of contract.
 *
 * It is **not** a substitute for the tax invoice. The invoice is the document
 * that carries the VAT breakdown and the full record of the rental; a receipt
 * says only that money was received. The document says so in both languages, so
 * a customer does not leave believing they have their invoice.
 */

import { documentDirection } from '@/domain/document';
import { formatMuscat } from '@/domain/datetime';
import { formatOmr } from '@/domain/money';
import { BusinessInfo, DocumentFooter, DocumentHeader, Field, Label, VoidedNotice } from './parts';
import type { DocumentProps } from './TaxInvoice';
import { customerNameFor } from '@/domain/document';

export function PaymentReceipt({ document, logoUrl, language, voidReason = '' }: DocumentProps) {
  const lang = language ?? document.language;
  const locale = lang === 'ar' ? 'ar' : 'en';
  const payment = document.receiptFor;

  return (
    <article className={`doc doc--${lang}`} dir={documentDirection(lang)}>
      {document.status === 'Voided' && <VoidedNotice reason={voidReason} language={lang} />}

      <DocumentHeader
        business={document.business}
        logoUrl={logoUrl}
        language={lang}
        titleEn="Payment Receipt"
        titleAr="إيصال استلام"
        documentNumber={document.documentNumber}
        issuedAt={document.issuedAt}
      />

      <div style={{ marginTop: '2mm' }}>
        <BusinessInfo business={document.business} language={lang} />
      </div>

      <hr className="doc__rule" />

      <div className="doc__grid-2 doc__keep">
        <Field
          en="Received from"
          ar="استُلم من"
          language={lang}
          value={customerNameFor(document.customer, lang)}
        />
        <Field
          en="Reservation"
          ar="الحجز"
          language={lang}
          numeric
          value={document.reservationCode}
        />
      </div>

      {payment !== null && (
        <section className="doc__section doc__keep">
          <div className="doc__grid-3">
            <Field
              en="Date"
              ar="التاريخ"
              language={lang}
              numeric
              value={formatMuscat(payment.occurredAt, locale)}
            />
            <Field en="Method" ar="الطريقة" language={lang} value={payment.method ?? '—'} />
            <Field
              en="Reference"
              ar="المرجع"
              language={lang}
              numeric
              value={payment.reference || '—'}
            />
          </div>

          <div className="doc__totals" style={{ marginTop: '5mm' }}>
            <div className="doc__totals-row doc__totals-row--grand">
              <span>
                <Label en="Amount received" ar="المبلغ المستلم" language={lang} />
              </span>
              <span className="doc__amount">{formatOmr(payment.amount)}</span>
            </div>
          </div>
        </section>
      )}

      {/*
       * What is still owed, copied from the snapshot. A receipt that shows only
       * what was handed over leaves the customer to work out the rest, and they
       * will work it out wrong.
       */}
      <section className="doc__section doc__keep">
        <div className="doc__totals">
          <div className="doc__totals-row">
            <span>
              <Label en="Total paid" ar="إجمالي المدفوع" language={lang} />
            </span>
            <span className="doc__amount">{formatOmr(document.financials.totalPaid)}</span>
          </div>

          <div className="doc__totals-row doc__totals-row--sum">
            <span>
              <Label en="Balance due" ar="المبلغ المستحق" language={lang} />
            </span>
            <span className="doc__amount">{formatOmr(document.financials.outstanding)}</span>
          </div>
        </div>

        {document.financials.depositHeld > 0 && (
          <div className="doc__deposit doc__keep">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6mm' }}>
              <strong>
                <Label en="Security deposit held" ar="مبلغ التأمين المحتفظ به" language={lang} />
              </strong>
              <span className="doc__amount">{formatOmr(document.financials.depositHeld)}</span>
            </div>
          </div>
        )}
      </section>

      <p className="doc__small doc__muted" style={{ marginTop: '6mm' }}>
        {(lang === 'en' || lang === 'bilingual') && (
          <span style={{ display: 'block' }}>
            This receipt acknowledges the payment shown. It is not a tax invoice.
          </span>
        )}
        {(lang === 'ar' || lang === 'bilingual') && (
          <span className="doc__ar-text" style={{ display: 'block' }}>
            يُقرّ هذا الإيصال باستلام المبلغ الموضح، وهو ليس فاتورة ضريبية.
          </span>
        )}
      </p>

      <DocumentFooter business={document.business} language={lang} />
    </article>
  );
}
