/**
 * One issued document, ready to print.
 *
 * Nothing on this screen can change the document. It renders the frozen
 * snapshot exactly as it was issued, and the only actions are printing it and —
 * for the owner — withdrawing it.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Alert, Badge, Button, Field, buttonClasses } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import {
  observeDocument,
  recordPrintIntent,
  voidDocument,
  DocumentServiceError,
  type StoredDocument,
} from '@/services/documents.service';
import { resolveStorageUrl } from '@/services/business.service';
import { formatMuscat } from '@/domain/datetime';
import { DocumentView } from './DocumentView';
import '@/print/print.css';

export function DocumentPage() {
  const { documentId = '' } = useParams();
  const { t, language } = useT();
  const { isOwner } = useAuth();

  const [document, setDocument] = useState<StoredDocument | null | undefined>(undefined);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(
    () =>
      observeDocument(documentId, setDocument, (caught) => {
        setDocument(null);
        setError(caught.message);
      }),
    [documentId],
  );

  const logoPath = document?.business.logoPath ?? null;

  useEffect(() => {
    let cancelled = false;

    void resolveStorageUrl(logoPath).then((url) => {
      if (!cancelled) setLogoUrl(url);
    });

    return () => {
      cancelled = true;
    };
  }, [logoPath]);

  const photoPaths = (document?.dresses ?? [])
    .map((dress) => dress.photoPath)
    .filter((path): path is string => path !== null);

  const photoKey = photoPaths.join('|');

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

  /**
   * Print.
   *
   * The audit note is recorded first and its failure ignored, because an
   * unrecorded note must never stop an employee handing a customer their
   * invoice. `window.print()` is the whole PDF story: the browser's own dialogue
   * offers Save as PDF, renders Arabic and bilingual text with the shaping the
   * platform already does correctly, and needs no font embedding. A PDF library
   * would add a dependency and a second text-shaping implementation to get
   * something the browser already does properly.
   */
  const print = useCallback(() => {
    void recordPrintIntent(documentId);
    window.print();
  }, [documentId]);

  const withdraw = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      await voidDocument({ documentId, reason });
      setVoiding(false);
      setReason('');
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
  }, [documentId, reason, t]);

  if (document === undefined) {
    return <main className="mx-auto max-w-5xl px-6 py-10 text-sm text-ink-400" role="status">{t('state.loading')}</main>;
  }

  if (document === null) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <Alert tone="error">{error ?? t('error.notFound')}</Alert>
        <Link to="/reservations" className={buttonClasses('ghost', 'md', 'mt-6')}>
          {t('action.back')}
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="doc-toolbar no-print">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="label-caps">{t(`documentType.${document.documentType}`)}</p>
            <h1 className="display mt-2 font-mono text-3xl text-ink-900">
              {document.documentNumber}
            </h1>
            <p className="numeric mt-1 text-2xs text-ink-400">
              {formatMuscat(document.issuedAt, language)} · {document.issuedByName}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {document.status === 'Voided' && <Badge tone="danger">{t('document.voided')}</Badge>}

            <Button onClick={print}>{t('document.print')}</Button>

            <Link to={`/reservations/${document.reservationId}`} className={buttonClasses('ghost')}>
              {t('action.back')}
            </Link>
          </div>
        </header>

        <p className="mt-3 text-2xs text-ink-400">{t('document.printHint')}</p>

        {error && (
          <Alert tone="error" className="mt-6">
            {error}
          </Alert>
        )}

        {/*
         * Voiding is the owner's, and the control is hidden rather than
         * disabled for staff — offering something that always refuses is worse
         * than not offering it. The Function refuses regardless.
         */}
        {isOwner && document.status !== 'Voided' && (
          <section className="mt-6">
            {voiding ? (
              <div className="flex flex-wrap items-end gap-3">
                <Field
                  label={t('document.voidReason')}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <Button
                  variant="danger"
                  disabled={busy || reason.trim().length === 0}
                  onClick={() => void withdraw()}
                >
                  {busy ? t('document.voiding') : t('document.void')}
                </Button>
                <Button variant="ghost" onClick={() => setVoiding(false)}>
                  {t('action.cancel')}
                </Button>
              </div>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setVoiding(true)}>
                {t('document.void')}
              </Button>
            )}

            <p className="mt-2 text-2xs text-ink-400">{t('document.voidNote')}</p>
          </section>
        )}
      </div>

      <div className="mt-6">
        <DocumentView
          document={document}
          logoUrl={logoUrl}
          photoUrls={photoUrls}
          voidReason={document.voidReason}
        />
      </div>
    </main>
  );
}
