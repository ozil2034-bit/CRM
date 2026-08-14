/**
 * Preview, then issue.
 *
 * An employee chooses the document and the language, sees exactly what will be
 * printed, and only then commits. Once issued the snapshot is frozen, so the
 * review has to happen before rather than after.
 *
 * The preview is built with the same `documentFinancialsFrom` the server uses,
 * over the same `reduceLedger` position, so it cannot flatter the real thing.
 * The number is shown as a dash because it does not exist yet — inventing one
 * and having the server allocate a different one would be worse than none.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import { Alert, Button, Select, TextArea, buttonClasses } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import {
  buildPreview,
  issueDocument,
  newDocumentKey,
  observeDocumentsForReservation,
  DocumentServiceError,
  type StoredDocument,
} from '@/services/documents.service';
import { observeFinancialEvents, positionOf, type DisplayEvent } from '@/services/payments.service';
import { observeReservation, type Reservation } from '@/services/reservations.service';
import { observeReservationItems, type ReservationItem } from '@/services/reservations.service';
import { observeCustomer, type Customer } from '@/services/customers.service';
import {
  observeActiveTermsVersionId,
  observeBusinessProfile,
  observeTermsVersions,
  resolveStorageUrl,
  EMPTY_BUSINESS,
  type TermsVersion,
} from '@/services/business.service';
import { snapshotTerms } from '@/domain/terms';
import {
  defaultDocumentLanguage,
  DOCUMENT_LANGUAGES,
  DOCUMENT_TYPES,
  type BusinessSnapshot,
  type DocumentLanguage,
  type DocumentSnapshot,
  type DocumentType,
} from '@/domain/document';
import { DocumentView } from './DocumentView';
import '@/print/print.css';

export function DocumentPreviewPage() {
  const { reservationId = '' } = useParams();
  const [params] = useSearchParams();
  const { t } = useT();
  const { state } = useAuth();

  const issuedByName = state.status === 'signed-in' ? state.session.name : '';

  const [reservation, setReservation] = useState<Reservation | null | undefined>(undefined);
  const [items, setItems] = useState<ReservationItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [events, setEvents] = useState<DisplayEvent[]>([]);
  const [business, setBusiness] = useState<BusinessSnapshot>(EMPTY_BUSINESS);
  const [termsVersions, setTermsVersions] = useState<TermsVersion[]>([]);
  const [activeTermsId, setActiveTermsId] = useState<string | null>(null);
  const [existing, setExisting] = useState<StoredDocument[]>([]);

  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});

  const [documentType, setDocumentType] = useState<DocumentType>('Tax Invoice');
  const [language, setLanguage] = useState<DocumentLanguage | null>(null);
  const [notes, setNotes] = useState('');
  const [forEventId, setForEventId] = useState<string>(params.get('event') ?? '');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * One key per preview session. Every attempt to issue *this* preview carries
   * it, so a double click or a retry after a timeout cannot burn a second
   * invoice number.
   */
  const [requestKey, setRequestKey] = useState(() => newDocumentKey());

  useEffect(
    () =>
      observeReservation(reservationId, setReservation, (caught) => {
        setReservation(null);
        setError(caught.message);
      }),
    [reservationId],
  );

  useEffect(
    () => observeReservationItems(reservationId, setItems, () => setItems([])),
    [reservationId],
  );

  useEffect(
    () => observeFinancialEvents(reservationId, setEvents, () => setEvents([])),
    [reservationId],
  );

  useEffect(
    () => observeDocumentsForReservation(reservationId, setExisting, () => setExisting([])),
    [reservationId],
  );

  useEffect(() => observeBusinessProfile(setBusiness, () => setBusiness(EMPTY_BUSINESS)), []);
  useEffect(() => observeTermsVersions(setTermsVersions, () => setTermsVersions([])), []);
  useEffect(() => observeActiveTermsVersionId(setActiveTermsId, () => setActiveTermsId(null)), []);

  const customerId = reservation?.customerId ?? '';

  useEffect(() => {
    if (customerId.length === 0) return;
    return observeCustomer(customerId, setCustomer, () => setCustomer(null));
  }, [customerId]);

  /* Resolve the images the document needs. */
  useEffect(() => {
    let cancelled = false;

    void resolveStorageUrl(business.logoPath).then((url) => {
      if (!cancelled) setLogoUrl(url);
    });

    return () => {
      cancelled = true;
    };
  }, [business.logoPath]);

  /*
   * Joined into a single string so the effect's dependency is a stable scalar.
   * A fresh array every render would re-resolve every image on every keystroke.
   */
  const photoKey = items
    .map((item) => item.dressPhotoPath)
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
    .join('|');

  useEffect(() => {
    let cancelled = false;

    void Promise.all(
      photoKey
        .split('|')
        .filter((path) => path.length > 0)
        .map(async (path) => [path, await resolveStorageUrl(path)] as const),
    ).then((entries) => {
      if (cancelled) return;

      const resolved: Record<string, string> = {};
      for (const [path, url] of entries) {
        if (url !== null) resolved[path] = url;
      }
      setPhotoUrls(resolved);
    });

    return () => {
      cancelled = true;
    };
  }, [photoKey]);

  /*
   * The document's language follows the customer unless the employee overrides
   * it. Keyed by the customer's preference rather than reset in an effect, so
   * an override is not silently undone when the record reloads.
   */
  const suggested = defaultDocumentLanguage(customer?.preferredLanguage ?? '', 'bilingual');
  const effectiveLanguage = language ?? suggested;

  const terms = useMemo(() => {
    if (activeTermsId === null) return null;
    const version = termsVersions.find((candidate) => candidate.id === activeTermsId);
    if (version === undefined) return null;

    const frozen = snapshotTerms(version.id, version.label, version.sections);
    return frozen.sections.length > 0 ? frozen : null;
  }, [activeTermsId, termsVersions]);

  const preview: DocumentSnapshot | null = useMemo(() => {
    if (reservation === null || reservation === undefined) return null;

    return buildPreview({
      documentType,
      language: effectiveLanguage,
      business,
      customer: {
        code: customer?.code ?? '',
        nameEn: customer?.nameEn ?? reservation.customerName,
        nameAr: customer?.nameAr ?? reservation.customerNameAr,
        phone: customer?.phone ?? reservation.customerPhone,
        email: customer?.email ?? '',
        preferredLanguage: customer?.preferredLanguage ?? '',
      },
      reservationId: reservation.id,
      reservationCode: reservation.code,
      eventDate: reservation.eventDate,
      pickupAt: reservation.pickupAt,
      returnAt: reservation.returnAt,
      dresses: items.map((item) => ({
        dressCode: item.dressCode,
        dressName: item.dressName,
        designer: item.designer,
        rentalPrice: item.rentalPriceSnapshot,
        securityDeposit: item.securityDepositSnapshot,
        photoPath: item.dressPhotoPath,
      })),
      pricing: reservation.pricing,
      position: positionOf(reservation.pricing, events),
      events,
      terms,
      notes,
      issuedByName,
      receiptForEventId: forEventId.length > 0 ? forEventId : null,
    });
  }, [
    reservation,
    documentType,
    effectiveLanguage,
    business,
    customer,
    items,
    events,
    terms,
    notes,
    issuedByName,
    forEventId,
  ]);

  const issue = useCallback(async () => {
    if (reservation === null || reservation === undefined) return;

    setBusy(true);
    setError(null);

    try {
      await issueDocument({
        reservationId: reservation.id,
        documentType,
        language: effectiveLanguage,
        notes,
        forEventId: forEventId.length > 0 ? forEventId : null,
        idempotencyKey: requestKey,
      });

      // A fresh key, so the next document is a new intent rather than a
      // duplicate of this one.
      setRequestKey(newDocumentKey());
    } catch (caught) {
      setError(
        caught instanceof DocumentServiceError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : t('error.loadFailed'),
      );
    } finally {
      setBusy(false);
    }
  }, [reservation, documentType, effectiveLanguage, notes, forEventId, requestKey, t]);

  if (reservation === undefined) {
    return <main className="mx-auto max-w-5xl px-6 py-10 text-sm text-ink-400" role="status">{t('state.loading')}</main>;
  }

  if (reservation === null) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <Alert tone="error">{error ?? t('error.notFound')}</Alert>
        <Link to="/reservations" className={buttonClasses('ghost', 'md', 'mt-6')}>
          {t('action.back')}
        </Link>
      </main>
    );
  }

  const payableEvents = events.filter(
    (event) => event.kind === 'Payment' || event.kind === 'SecurityDepositPayment',
  );

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      {/* Everything in this block disappears when printing. */}
      <div className="doc-toolbar no-print">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="label-caps">{t('document.title')}</p>
            <h1 className="display mt-2 code text-3xl text-ink-900">{reservation.code}</h1>
          </div>

          <Link to={`/reservations/${reservation.id}`} className={buttonClasses('ghost')}>
            {t('action.back')}
          </Link>
        </header>

        {error && (
          <Alert tone="error" className="mt-6">
            {error}
          </Alert>
        )}

        <section className="mt-8 grid gap-6 sm:grid-cols-3">
          <Select
            label={t('document.type')}
            value={documentType}
            onChange={(event) => setDocumentType(event.target.value as DocumentType)}
            options={DOCUMENT_TYPES.map((value) => ({
              value,
              label: t(`documentType.${value}`),
            }))}
          />

          <Select
            label={t('document.language')}
            value={effectiveLanguage}
            onChange={(event) => setLanguage(event.target.value as DocumentLanguage)}
            options={DOCUMENT_LANGUAGES.map((value) => ({
              value,
              label: t(`docLanguage.${value}`),
            }))}
          />

          {documentType === 'Payment Receipt' && (
            <Select
              label={t('document.forPayment')}
              value={forEventId}
              onChange={(event) => setForEventId(event.target.value)}
              options={[
                { value: '', label: '—' },
                ...payableEvents.map((event) => ({
                  value: event.id,
                  label: `${t(`event.${event.kind}`)} · ${event.amount / 1000}`,
                })),
              ]}
            />
          )}
        </section>

        <div className="mt-6">
          <TextArea
            label={t('document.notes')}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
          />
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-4">
          <Button
            disabled={busy || (documentType === 'Payment Receipt' && forEventId.length === 0)}
            onClick={() => void issue()}
          >
            {busy ? t('document.issuing') : t('document.confirmIssue')}
          </Button>

          <span className="text-2xs text-ink-400">{t('document.immutableNote')}</span>
        </div>

        {existing.length > 0 && (
          <section className="mt-8 border-t border-ink-100 pt-6">
            <h2 className="label-caps">{t('document.issued')}</h2>

            <ul className="mt-3 divide-y divide-ink-100">
              {existing.map((document) => (
                <li key={document.id}>
                  <Link
                    to={`/documents/${document.id}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 hover:bg-sand-50"
                  >
                    <span className="w-32 shrink-0 code text-2xs text-ink-300">
                      {document.documentNumber}
                    </span>
                    <span className="flex-1 text-sm text-ink-900">
                      {t(`documentType.${document.documentType}`)}
                    </span>
                    <span className="text-2xs text-ink-400">
                      {t(`docLanguage.${document.language}`)}
                    </span>
                    {document.status === 'Voided' && (
                      <span className="text-2xs text-danger">{t('document.voided')}</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="mt-8 text-2xs text-ink-400">{t('document.previewOnly')}</p>
      </div>

      {preview !== null && (
        <div className="mt-6">
          <DocumentView document={preview} logoUrl={logoUrl} photoUrls={photoUrls} />
        </div>
      )}
    </main>
  );
}
