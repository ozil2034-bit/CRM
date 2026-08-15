/**
 * The shared pieces every document is assembled from.
 *
 * Three documents — tax invoice, rental agreement, receipt — compose these
 * rather than one component branching on a type. A single conditional document
 * would grow a thicket of "if receipt hide this, if agreement show that", and
 * the one thing a printed document must be is predictable.
 *
 * Every part takes its data from the **snapshot**, never from live records. A
 * document reprinted next year must look exactly as it did on the day it was
 * issued.
 */

import type { ReactNode } from 'react';

import {
  businessLines,
  businessNameFor,
  customerNameFor,
  registrationLines,
  showsArabic,
  showsEnglish,
  type BusinessSnapshot,
  type CustomerSnapshot,
  type DocumentAccessoryLine,
  type DocumentAlterationLine,
  type DocumentDressLine,
  type DocumentFinancials,
  type DocumentLanguage,
  type DocumentPaymentLine,
  type TermsSnapshot,
} from '@/domain/document';
import { formatMuscat, formatMuscatDate, type EpochMs } from '@/domain/datetime';
import { formatOmr, type Baisa } from '@/domain/money';

/* ------------------------------------------------------------------------ *
 * Bilingual labelling
 * ------------------------------------------------------------------------ */

/**
 * A label in the document's language.
 *
 * In bilingual mode both are shown, the Arabic quieter and beneath, so the pair
 * reads as one label rather than two competing ones.
 */
export function Label({
  en,
  ar,
  language,
}: {
  en: string;
  ar: string;
  language: DocumentLanguage;
}) {
  if (language === 'en') return <>{en}</>;
  if (language === 'ar') return <span className="doc__ar-text">{ar}</span>;

  return (
    <>
      {en}
      <span className="doc__ar-text doc__muted doc__small" style={{ display: 'block' }}>
        {ar}
      </span>
    </>
  );
}

/** A value with its bilingual label, as one field. */
export function Field({
  en,
  ar,
  value,
  language,
  numeric = false,
}: {
  en: string;
  ar: string;
  value: ReactNode;
  language: DocumentLanguage;
  numeric?: boolean;
}) {
  return (
    <div>
      <div className="doc__small doc__muted">
        <Label en={en} ar={ar} language={language} />
      </div>
      <div className={numeric ? 'doc__numeric' : undefined}>{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Header
 * ------------------------------------------------------------------------ */

export interface DocumentHeaderProps {
  readonly business: BusinessSnapshot;
  readonly logoUrl: string | null;
  readonly language: DocumentLanguage;
  readonly titleEn: string;
  readonly titleAr: string;
  readonly documentNumber: string;
  readonly issuedAt: EpochMs;
}

export function DocumentHeader({
  business,
  logoUrl,
  language,
  titleEn,
  titleAr,
  documentNumber,
  issuedAt,
}: DocumentHeaderProps) {
  return (
    <header className="doc__header doc__keep">
      <div>
        {/*
         * No logo is a perfectly ordinary state for a boutique that has not
         * uploaded one. The name carries the header instead — a broken image
         * icon on a customer's invoice is worse than no image at all.
         */}
        {logoUrl !== null ? (
          <img src={logoUrl} alt={businessNameFor(business, language)} className="doc__logo" />
        ) : (
          <h1>{businessNameFor(business, language)}</h1>
        )}

        {logoUrl !== null && (
          <div style={{ marginTop: '2mm', fontWeight: 600 }}>
            {businessNameFor(business, language)}
          </div>
        )}
      </div>

      <div className="doc__identity">
        <h1>
          <Label en={titleEn} ar={titleAr} language={language} />
        </h1>
        <div className="doc__numeric" style={{ marginTop: '1.5mm', fontWeight: 600 }}>
          {documentNumber}
        </div>
        <div className="doc__small doc__muted doc__numeric">
          {formatMuscatDate(issuedAt, language === 'ar' ? 'ar' : 'en')}
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------------ *
 * Business
 * ------------------------------------------------------------------------ */

/**
 * The boutique's own details.
 *
 * Blank fields are omitted entirely. An unconfigured VAT or CR number prints as
 * nothing — never as a placeholder, and never as an invented registration.
 */
export function BusinessInfo({
  business,
  language,
}: {
  business: BusinessSnapshot;
  language: DocumentLanguage;
}) {
  const lines = businessLines(business, language);
  const registrations = registrationLines(business);

  if (lines.length === 0 && registrations.length === 0) return null;

  return (
    <div className="doc__small doc__muted">
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}

      {registrations.map((entry) => (
        <div key={entry.labelKey} className="doc__numeric">
          {entry.labelKey === 'document.vatNumber' ? 'VAT' : 'CR'} {entry.value}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Customer and reservation
 * ------------------------------------------------------------------------ */

export function CustomerInfo({
  customer,
  language,
}: {
  customer: CustomerSnapshot;
  language: DocumentLanguage;
}) {
  return (
    <div className="doc__keep">
      <h2>
        <Label en="Customer" ar="العميلة" language={language} />
      </h2>

      <div style={{ fontWeight: 600 }}>{customerNameFor(customer, language)}</div>

      {/* Both spellings on a bilingual document — a contract names the person
          in both languages it is written in. */}
      {language === 'bilingual' && customer.nameAr.trim().length > 0 && (
        <div className="doc__ar-text">{customer.nameAr}</div>
      )}

      {customer.code.trim().length > 0 && (
        <div className="doc__small doc__muted doc__numeric">{customer.code}</div>
      )}
      {customer.phone.trim().length > 0 && (
        <div className="doc__small doc__numeric">{customer.phone}</div>
      )}
      {customer.email.trim().length > 0 && <div className="doc__small">{customer.email}</div>}
    </div>
  );
}

export interface ReservationInfoProps {
  readonly reservationCode: string;
  readonly eventDate: string;
  readonly pickupAt: EpochMs;
  readonly returnAt: EpochMs;
  readonly language: DocumentLanguage;
}

export function ReservationInfo({
  reservationCode,
  eventDate,
  pickupAt,
  returnAt,
  language,
}: ReservationInfoProps) {
  const locale = language === 'ar' ? 'ar' : 'en';

  return (
    <div className="doc__keep">
      <h2>
        <Label en="Reservation" ar="الحجز" language={language} />
      </h2>

      <div className="doc__grid-2" style={{ gap: '3mm' }}>
        <Field en="Number" ar="الرقم" language={language} numeric value={reservationCode} />
        {eventDate.length > 0 && (
          <Field
            en="Event date"
            ar="تاريخ المناسبة"
            language={language}
            numeric
            value={eventDate}
          />
        )}
        <Field
          en="Collection"
          ar="الاستلام"
          language={language}
          numeric
          value={formatMuscat(pickupAt, locale)}
        />
        <Field
          en="Return"
          ar="الإرجاع"
          language={language}
          numeric
          value={formatMuscat(returnAt, locale)}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Dresses
 * ------------------------------------------------------------------------ */

export function DressInfo({
  dresses,
  photoUrls,
  language,
  showPhotos = true,
}: {
  dresses: readonly DocumentDressLine[];
  photoUrls: Readonly<Record<string, string>>;
  language: DocumentLanguage;
  showPhotos?: boolean;
}) {
  if (dresses.length === 0) return null;

  return (
    <section className="doc__section">
      <h2>
        <Label en="Dresses" ar="الفساتين" language={language} />
      </h2>

      <table className="doc__table">
        <thead>
          <tr>
            {showPhotos && <th style={{ width: '24mm' }} />}
            <th>
              <Label en="Code" ar="الرمز" language={language} />
            </th>
            <th>
              <Label en="Dress" ar="الفستان" language={language} />
            </th>
            <th>
              <Label en="Designer" ar="المصمم" language={language} />
            </th>
            <th className="doc__col-amount">
              <Label en="Rental" ar="الإيجار" language={language} />
            </th>
          </tr>
        </thead>

        <tbody>
          {dresses.map((dress) => {
            const url = dress.photoPath === null ? undefined : photoUrls[dress.photoPath];

            return (
              <tr key={`${dress.dressCode}-${dress.dressName}`}>
                {showPhotos && (
                  <td>
                    {/* No photograph is ordinary. Nothing is rendered rather
                        than a broken image. */}
                    {url !== undefined && (
                      <img src={url} alt={dress.dressName} className="doc__dress-photo" />
                    )}
                  </td>
                )}
                <td className="doc__numeric">{dress.dressCode}</td>
                <td>{dress.dressName}</td>
                <td className="doc__muted">{dress.designer}</td>
                <td className="doc__col-amount doc__amount">{formatOmr(dress.rentalPrice)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/* ------------------------------------------------------------------------ *
 * Accessories and alterations
 * ------------------------------------------------------------------------ */

/**
 * What the accessory and alteration charges were actually for.
 *
 * The summary below states `Accessories — OMR 59.000` as one figure. On a real
 * invoice that is not enough: a bride disputing a charge four months later, or
 * an accountant reconciling one, needs to see the veil, the comb, the quantity
 * and the unit price. A total with no line behind it is a number the boutique
 * cannot defend.
 *
 * Renders nothing when there is nothing — most reservations have no amendments,
 * and an empty table with a heading is worse than no section.
 */
export function AmendmentLines({
  accessories,
  alterations,
  language,
}: {
  accessories: readonly DocumentAccessoryLine[];
  alterations: readonly DocumentAlterationLine[];
  language: DocumentLanguage;
}) {
  if (accessories.length === 0 && alterations.length === 0) return null;

  return (
    <>
      {accessories.length > 0 && (
        <section className="doc__section">
          <h2>
            <Label en="Accessories" ar="الإكسسوارات" language={language} />
          </h2>

          <table className="doc__table">
            <thead>
              <tr>
                <th>
                  <Label en="Item" ar="الصنف" language={language} />
                </th>
                <th className="doc__col-amount">
                  <Label en="Qty" ar="الكمية" language={language} />
                </th>
                <th className="doc__col-amount">
                  <Label en="Unit price" ar="سعر الوحدة" language={language} />
                </th>
                <th className="doc__col-amount">
                  <Label en="Total" ar="الإجمالي" language={language} />
                </th>
              </tr>
            </thead>

            <tbody>
              {accessories.map((line, index) => (
                <tr key={`${line.name}-${String(index)}`}>
                  <td>{line.name}</td>
                  <td className="doc__col-amount doc__numeric">{line.quantity}</td>
                  <td className="doc__col-amount doc__amount">{formatOmr(line.unitPrice)}</td>
                  <td className="doc__col-amount doc__amount">{formatOmr(line.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {alterations.length > 0 && (
        <section className="doc__section">
          <h2>
            <Label en="Alterations" ar="التعديلات" language={language} />
          </h2>

          <table className="doc__table">
            <thead>
              <tr>
                <th>
                  <Label en="Work" ar="العمل" language={language} />
                </th>
                <th className="doc__col-amount">
                  <Label en="Amount" ar="المبلغ" language={language} />
                </th>
              </tr>
            </thead>

            <tbody>
              {alterations.map((line, index) => (
                <tr key={`${line.description}-${String(index)}`}>
                  <td>{line.description}</td>
                  <td className="doc__col-amount doc__amount">{formatOmr(line.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------ *
 * Financial summary
 * ------------------------------------------------------------------------ */

function TotalRow({
  en,
  ar,
  value,
  language,
  modifier,
}: {
  en: string;
  ar: string;
  value: Baisa;
  language: DocumentLanguage;
  modifier?: 'sum' | 'grand';
}) {
  const className = [
    'doc__totals-row',
    modifier === 'sum' ? 'doc__totals-row--sum' : '',
    modifier === 'grand' ? 'doc__totals-row--grand' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <span>
        <Label en={en} ar={ar} language={language} />
      </span>
      <span className="doc__amount">{formatOmr(value)}</span>
    </div>
  );
}

/**
 * The money.
 *
 * Every figure here is read straight off the snapshot, which was itself copied
 * from the pricing snapshot and `reduceLedger`. **No arithmetic happens in this
 * component** — not even a subtraction for a subtotal.
 */
export function FinancialSummary({
  financials,
  language,
}: {
  financials: DocumentFinancials;
  language: DocumentLanguage;
}) {
  return (
    <section className="doc__section doc__keep">
      <h2>
        <Label en="Summary" ar="الملخص" language={language} />
      </h2>

      <div className="doc__totals">
        <TotalRow en="Rental" ar="الإيجار" value={financials.rentalSubtotal} language={language} />

        {financials.accessorySubtotal > 0 && (
          <TotalRow
            en="Accessories"
            ar="الإكسسوارات"
            value={financials.accessorySubtotal}
            language={language}
          />
        )}

        {financials.alterationSubtotal > 0 && (
          <TotalRow
            en="Alterations"
            ar="التعديلات"
            value={financials.alterationSubtotal}
            language={language}
          />
        )}

        {financials.discountAmount > 0 && (
          <TotalRow
            en="Discount"
            ar="الخصم"
            value={financials.discountAmount}
            language={language}
          />
        )}

        {financials.lateFees > 0 && (
          <TotalRow
            en="Late return fee"
            ar="رسوم التأخير"
            value={financials.lateFees}
            language={language}
          />
        )}

        {financials.waivedCharges > 0 && (
          <TotalRow
            en="Cancellation relief"
            ar="إعفاء الإلغاء"
            value={financials.waivedCharges}
            language={language}
          />
        )}

        <TotalRow
          en="Taxable subtotal"
          ar="المجموع الخاضع للضريبة"
          value={financials.taxableSubtotal}
          language={language}
          modifier="sum"
        />

        <TotalRow
          en={`VAT ${financials.vatRatePercent}%`}
          ar={`ضريبة القيمة المضافة ${financials.vatRatePercent}%`}
          value={financials.vatAmount}
          language={language}
        />

        <TotalRow
          en="Total"
          ar="الإجمالي"
          value={financials.grandTotal}
          language={language}
          modifier="grand"
        />
      </div>

      {/*
       * The deposit sits outside the totals, visually and financially. It is
       * the customer's money held against damage: not revenue, not taxed, and
       * returnable. A document that lets it blend into the rental total invites
       * exactly the confusion the financial model exists to prevent.
       */}
      {financials.securityDepositTotal > 0 && (
        <div className="doc__deposit doc__keep">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6mm' }}>
            <strong>
              <Label en="Security deposit" ar="مبلغ التأمين" language={language} />
            </strong>
            <span className="doc__amount">{formatOmr(financials.securityDepositTotal)}</span>
          </div>

          <p className="doc__small doc__muted" style={{ marginTop: '1.5mm', marginBottom: 0 }}>
            {showsEnglish(language) && (
              <span style={{ display: 'block' }}>
                Held as a refundable deposit. It is not part of the rental charge and is not subject
                to VAT.
              </span>
            )}
            {showsArabic(language) && (
              <span className="doc__ar-text" style={{ display: 'block' }}>
                يُحتفظ به كمبلغ تأمين قابل للاسترداد. وهو ليس جزءًا من قيمة الإيجار ولا يخضع لضريبة
                القيمة المضافة.
              </span>
            )}
          </p>

          {financials.depositHeld !== financials.securityDepositTotal && (
            <div className="doc__small" style={{ marginTop: '2mm' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>
                  <Label en="Currently held" ar="المحتفظ به حاليًا" language={language} />
                </span>
                <span className="doc__amount">{formatOmr(financials.depositHeld)}</span>
              </div>

              {financials.depositRefunded > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>
                    <Label en="Returned" ar="المُعاد" language={language} />
                  </span>
                  <span className="doc__amount">{formatOmr(financials.depositRefunded)}</span>
                </div>
              )}

              {financials.depositForfeited > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>
                    <Label en="Retained" ar="المحتجز" language={language} />
                  </span>
                  <span className="doc__amount">{formatOmr(financials.depositForfeited)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------ *
 * Payments
 * ------------------------------------------------------------------------ */

/**
 * What has been paid, and what is left.
 *
 * The internal event ids are deliberately not printed. A customer's receipt has
 * no use for them, and putting database identifiers on a document that leaves
 * the building tells strangers about the shape of the system.
 */
export function PaymentSummary({
  payments,
  financials,
  language,
}: {
  payments: readonly DocumentPaymentLine[];
  financials: DocumentFinancials;
  language: DocumentLanguage;
}) {
  const locale = language === 'ar' ? 'ar' : 'en';

  return (
    <section className="doc__section">
      <h2>
        <Label en="Payments" ar="المدفوعات" language={language} />
      </h2>

      {payments.length === 0 ? (
        <p className="doc__small doc__muted">
          <Label en="No payments recorded." ar="لم تُسجَّل أي مدفوعات." language={language} />
        </p>
      ) : (
        <table className="doc__table">
          <thead>
            <tr>
              <th>
                <Label en="Date" ar="التاريخ" language={language} />
              </th>
              <th>
                <Label en="Type" ar="النوع" language={language} />
              </th>
              <th>
                <Label en="Method" ar="الطريقة" language={language} />
              </th>
              <th>
                <Label en="Reference" ar="المرجع" language={language} />
              </th>
              <th className="doc__col-amount">
                <Label en="Amount" ar="المبلغ" language={language} />
              </th>
            </tr>
          </thead>

          <tbody>
            {payments.map((payment, index) => (
              <tr key={`${payment.occurredAt}-${payment.kind}-${index}`}>
                <td className="doc__numeric">{formatMuscatDate(payment.occurredAt, locale)}</td>
                <td>{paymentLabel(payment, language)}</td>
                <td>{payment.method ?? '—'}</td>
                <td className="doc__numeric doc__muted">{payment.reference || '—'}</td>
                <td className="doc__col-amount doc__amount">
                  {formatOmr(payment.signedAmount, { signDisplay: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="doc__totals doc__keep" style={{ marginTop: '3mm' }}>
        <TotalRow
          en="Total paid"
          ar="إجمالي المدفوع"
          value={financials.totalPaid}
          language={language}
        />

        {financials.refundable > 0 ? (
          <TotalRow
            en="Refundable"
            ar="القابل للاسترداد"
            value={financials.refundable}
            language={language}
            modifier="grand"
          />
        ) : (
          <TotalRow
            en="Balance due"
            ar="المبلغ المستحق"
            value={financials.outstanding}
            language={language}
            modifier="grand"
          />
        )}
      </div>
    </section>
  );
}

function paymentLabel(payment: DocumentPaymentLine, language: DocumentLanguage): ReactNode {
  const pairs: Record<string, { en: string; ar: string }> = {
    Payment: { en: 'Payment', ar: 'دفعة' },
    PaymentReversal: { en: 'Payment reversed', ar: 'عكس دفعة' },
    Refund: { en: 'Refund', ar: 'مبلغ مسترد' },
    SecurityDepositPayment: { en: 'Security deposit', ar: 'مبلغ تأمين' },
    SecurityDepositRefund: { en: 'Deposit returned', ar: 'إعادة التأمين' },
    SecurityDepositForfeiture: { en: 'Deposit retained', ar: 'احتجاز التأمين' },
    LateFee: { en: 'Late return fee', ar: 'رسوم تأخير' },
    ChargeWaiver: { en: 'Cancellation relief', ar: 'إعفاء الإلغاء' },
  };

  const pair = pairs[payment.kind] ?? { en: payment.kind, ar: payment.kind };
  return <Label en={pair.en} ar={pair.ar} language={language} />;
}

/* ------------------------------------------------------------------------ *
 * Terms
 * ------------------------------------------------------------------------ */

/**
 * The terms, exactly as they were when the document was issued.
 *
 * Rendered from the frozen snapshot, so editing the boutique's current terms
 * cannot change what a customer already signed. The version is printed so a
 * dispute can be traced to the wording that actually applied.
 */
export function TermsAndConditions({
  terms,
  language,
}: {
  terms: TermsSnapshot | null;
  language: DocumentLanguage;
}) {
  if (terms === null || terms.sections.length === 0) return null;

  return (
    <section className="doc__section">
      <h2>
        <Label en="Terms and conditions" ar="الشروط والأحكام" language={language} />
      </h2>

      {terms.sections.map((section) => (
        <div key={section.key} className="doc__terms-section">
          {language === 'bilingual' ? (
            <div className="doc__terms-pair">
              <div>
                <h3>{section.titleEn}</h3>
                <p className="doc__small">{section.bodyEn}</p>
              </div>
              <div className="doc__ar-text">
                <h3>{section.titleAr}</h3>
                <p className="doc__small">{section.bodyAr}</p>
              </div>
            </div>
          ) : language === 'ar' ? (
            <div className="doc__ar-text">
              <h3>{section.titleAr || section.titleEn}</h3>
              <p className="doc__small">{section.bodyAr || section.bodyEn}</p>
            </div>
          ) : (
            <div>
              <h3>{section.titleEn || section.titleAr}</h3>
              <p className="doc__small">{section.bodyEn || section.bodyAr}</p>
            </div>
          )}
        </div>
      ))}

      <p className="doc__small doc__muted doc__numeric" style={{ marginTop: '2mm' }}>
        {terms.versionLabel || terms.versionId}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------------ *
 * Signatures
 * ------------------------------------------------------------------------ */

export function SignatureSection({ language }: { language: DocumentLanguage }) {
  return (
    <section className="doc__signatures">
      <div>
        <div className="doc__signature-line">
          <Label en="Customer signature" ar="توقيع العميلة" language={language} />
        </div>
        <div className="doc__signature-line" style={{ marginTop: '6mm' }}>
          <Label en="Date" ar="التاريخ" language={language} />
        </div>
      </div>

      <div>
        <div className="doc__signature-line">
          <Label en="For Azhary Boutique" ar="عن أزهاري بوتيك" language={language} />
        </div>
        <div className="doc__signature-line" style={{ marginTop: '6mm' }}>
          <Label en="Date" ar="التاريخ" language={language} />
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------ *
 * Footer
 * ------------------------------------------------------------------------ */

export function DocumentFooter({
  business,
  language,
}: {
  business: BusinessSnapshot;
  language: DocumentLanguage;
}) {
  const contact = [business.phone, business.email, business.website]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const registrations = registrationLines(business);

  return (
    <footer className="doc__footer">
      <div>
        <div>{businessNameFor(business, language)}</div>
        {contact.length > 0 && <div className="doc__numeric">{contact.join(' · ')}</div>}
        {registrations.length > 0 && (
          <div className="doc__numeric">
            {registrations
              .map(
                (entry) =>
                  `${entry.labelKey === 'document.vatNumber' ? 'VAT' : 'CR'} ${entry.value}`,
              )
              .join(' · ')}
          </div>
        )}
      </div>

      <div className="doc__page-number doc__numeric" />
    </footer>
  );
}

/* ------------------------------------------------------------------------ *
 * Voided overlay
 * ------------------------------------------------------------------------ */

/**
 * A voided document still prints — it is not deleted — but it must never be
 * mistaken for a live one.
 */
export function VoidedNotice({ reason, language }: { reason: string; language: DocumentLanguage }) {
  return (
    <div
      className="doc__keep"
      style={{
        marginBottom: '4mm',
        padding: '3mm 4mm',
        border: '0.4mm solid var(--color-danger, #b4402f)',
        color: 'var(--color-danger, #b4402f)',
      }}
    >
      <strong>
        <Label en="VOIDED" ar="ملغى" language={language} />
      </strong>
      {reason.trim().length > 0 && <div className="doc__small">{reason}</div>}
    </div>
  );
}
