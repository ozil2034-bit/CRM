import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Alert, Badge, Button, Select, buttonClasses } from '@/design-system';
import { DressPhoto } from '@/components/DressPhoto';
import { STATUS_TONE } from './status-tone';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import {
  changeDressStatus,
  observeDress,
  readPurchaseCost,
  type Dress,
} from '@/services/dresses.service';
import { removeDressPhoto, setPrimaryPhoto, uploadDressPhoto } from '@/services/photos.service';
import { DRESS_STATUSES, refuseManualStatusChange, resolvePrimaryPhoto } from '@/domain/dress';
import { formatOmr, type Baisa } from '@/domain/money';
import { cn } from '@/lib/utils/cn';

export function DressDetailPage() {
  const { dressId } = useParams<{ dressId: string }>();
  const { t } = useT();
  const { principal, state, can } = useAuth();

  const [dress, setDress] = useState<Dress | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null);
  const [purchaseCost, setPurchaseCost] = useState<Baisa | null>(null);
  const [banner, setBanner] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);

  const actor = {
    uid: principal?.uid ?? '',
    name: state.status === 'signed-in' ? state.session.name : '',
    role: principal?.role ?? ('STAFF' as const),
  };

  useEffect(() => {
    if (dressId === undefined) return;

    return observeDress(
      dressId,
      (next) => {
        setDress(next);
        setLoading(false);
      },
      () => {
        setLoading(false);
        setBanner({ tone: 'error', text: t('error.loadFailed') });
      },
    );
  }, [dressId, t]);

  useEffect(() => {
    if (dressId === undefined || !can('dresses.viewPurchaseCost')) return;
    void readPurchaseCost(dressId).then(setPurchaseCost);
  }, [dressId, can]);

  if (loading) {
    return <main className="mx-auto max-w-5xl px-6 py-16 text-sm text-ink-400" role="status">{t('state.loading')}</main>;
  }

  if (dress === null) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-16">
        <p className="text-sm text-ink-500">{t('error.notFound')}</p>
        <Link to="/inventory" className="mt-6 inline-block text-sm text-gold-700 underline">
          {t('action.back')}
        </Link>
      </main>
    );
  }

  const shown =
    dress.photos.find((photo) => photo.id === selectedPhotoId) ??
    resolvePrimaryPhoto(dress.photos, dress.primaryPhotoId);

  async function handleUpload(files: FileList | null): Promise<void> {
    if (files === null || files.length === 0 || dress === null) return;
    if (uploading) return;

    setUploading(true);
    setBanner(null);

    try {
      for (const file of Array.from(files)) {
        await uploadDressPhoto({
          dressId: dress.id,
          dressCode: dress.code,
          file,
          actor,
          makePrimary: dress.photos.length === 0,
        });
      }
    } catch (caught) {
      setBanner({
        tone: 'error',
        text: (caught as { message?: string }).message ?? 'The photo could not be uploaded.',
      });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function handleStatus(next: string): Promise<void> {
    if (dress === null || busy) return;

    const refusal = refuseManualStatusChange(dress.status, next as (typeof DRESS_STATUSES)[number]);
    if (refusal === 'NO_CHANGE') return;

    setBusy(true);
    setBanner(null);

    try {
      const outcome = await changeDressStatus({
        dress,
        status: next as (typeof DRESS_STATUSES)[number],
        actor,
      });
      if (outcome.status === 'pending') {
        setBanner({ tone: 'info', text: t('write.pending') });
      }
    } catch (caught) {
      setBanner({
        tone: 'error',
        text: (caught as { message?: string }).message ?? t('error.loadFailed'),
      });
    } finally {
      setBusy(false);
    }
  }

  const selectableStatuses = DRESS_STATUSES.filter(
    (status) => status === dress.status || refuseManualStatusChange(dress.status, status) === null,
  );

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link to="/inventory" className="text-xs text-ink-400 hover:text-ink-700">
        ← {t('inventory.title')}
      </Link>

      {banner && (
        <Alert tone={banner.tone} className="mt-6">
          {banner.text}
        </Alert>
      )}

      <div className="mt-6 grid gap-10 lg:grid-cols-[minmax(0,22rem)_1fr]">
        {/* Gallery */}
        <div>
          <DressPhoto
            photo={shown}
            alt={dress.name}
            prefer="large"
            eager
            className="aspect-[3/4] w-full"
          />

          {dress.photos.length > 0 && (
            <div className="mt-3 grid grid-cols-4 gap-2">
              {dress.photos.map((photo) => (
                <button
                  key={photo.id}
                  type="button"
                  onClick={() => setSelectedPhotoId(photo.id)}
                  className={cn(
                    'aspect-[3/4] overflow-hidden',
                    photo.id === (shown?.id ?? '') && 'ring-1 ring-gold-500',
                  )}
                >
                  <DressPhoto photo={photo} alt="" className="size-full" />
                </button>
              ))}
            </div>
          )}

          {dress.photos.length === 0 && (
            <p className="mt-3 text-xs text-ink-400">{t('dress.noPhotos')}</p>
          )}

          {can('dresses.edit') && (
            <div className="mt-4 flex flex-wrap gap-2">
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="sr-only"
                onChange={(event) => void handleUpload(event.target.files)}
              />
              <Button
                variant="secondary"
                size="sm"
                loading={uploading}
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? t('action.uploading') : t('dress.addPhoto')}
              </Button>

              {shown && dress.photos.length > 1 && shown.id !== dress.primaryPhotoId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void setPrimaryPhoto({ dressId: dress.id, photoId: shown.id, actor })
                  }
                >
                  {t('dress.makePrimary')}
                </Button>
              )}

              {shown && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void removeDressPhoto({
                      dressId: dress.id,
                      dressCode: dress.code,
                      photo: shown,
                      photos: dress.photos,
                      primaryPhotoId: dress.primaryPhotoId,
                      actor,
                    }).then(() => setSelectedPhotoId(null))
                  }
                >
                  {t('dress.removePhoto')}
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Details */}
        <div>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="display text-3xl text-ink-900">{dress.name}</h1>
              <p className="mt-1 code text-xs text-ink-400">{dress.code}</p>
            </div>

            <div className="flex items-center gap-3">
              <Badge tone={STATUS_TONE[dress.status]}>{dress.status}</Badge>
              {can('dresses.edit') && (
                <Link
                  to={`/inventory/${dress.id}/edit`}
                  className={buttonClasses('secondary', 'sm')}
                >
                  {t('action.edit')}
                </Link>
              )}
            </div>
          </div>

          <hr className="rule-gold mt-6 w-16" />

          <dl className="mt-8 grid gap-x-8 gap-y-5 sm:grid-cols-2">
            <Detail label={t('dress.designer')}>{dress.designer || '—'}</Detail>
            <Detail label={t('dress.brand')}>{dress.brand || '—'}</Detail>
            <Detail label={t('dress.size')}>{dress.size || '—'}</Detail>
            <Detail label={t('dress.color')}>{dress.color || '—'}</Detail>
            <Detail label={t('dress.style')}>{dress.style || '—'}</Detail>
            <Detail label={t('dress.condition')}>{dress.condition}</Detail>
            <Detail label={t('dress.rentalPrice')} numeric>
              {formatOmr(dress.rentalPrice)}
            </Detail>
            <Detail label={t('dress.securityDeposit')} numeric>
              {formatOmr(dress.securityDeposit)}
            </Detail>
            <Detail label={t('dress.salePrice')} numeric>
              {dress.salePrice === null ? '—' : formatOmr(dress.salePrice)}
            </Detail>
            {can('dresses.viewPurchaseCost') && (
              <Detail label={t('dress.purchaseCost')} numeric>
                {purchaseCost === null ? '—' : formatOmr(purchaseCost)}
              </Detail>
            )}
            <Detail label={t('dress.location')}>{dress.location || '—'}</Detail>
            <Detail label={t('dress.cleaningBuffer')}>
              {dress.cleaningBufferDays} {t('dress.days')}
            </Detail>
          </dl>

          <section className="mt-10">
            <h2 className="label-caps">{t('dress.measurements')}</h2>
            <dl className="mt-3 grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
              {(['bust', 'waist', 'hips', 'length'] as const).map((key) => (
                <Detail key={key} label={t(`dress.${key}` as const)} numeric>
                  {dress.measurements[key] === null ? '—' : `${dress.measurements[key]} cm`}
                </Detail>
              ))}
            </dl>
          </section>

          {dress.notes && (
            <section className="mt-10">
              <h2 className="label-caps">{t('dress.notes')}</h2>
              <p className="user-text mt-3 whitespace-pre-wrap text-sm text-ink-700">{dress.notes}</p>
            </section>
          )}

          {can('dresses.edit') && selectableStatuses.length > 1 && (
            <section className="mt-10 max-w-xs">
              <Select
                label={t('dress.changeStatus')}
                value={dress.status}
                disabled={busy}
                onChange={(event) => void handleStatus(event.target.value)}
                options={selectableStatuses.map((status) => ({
                  value: status,
                  label: status,
                }))}
              />
            </section>
          )}

          <section className="mt-12">
            <h2 className="label-caps">{t('dress.rentalHistory')}</h2>
            {/* Reservations arrive in Phase 4. Nothing is invented here. */}
            <p className="mt-3 text-sm text-ink-400">{t('dress.noRentalHistory')}</p>
          </section>
        </div>
      </div>
    </main>
  );
}

function Detail({
  label,
  children,
  numeric,
}: {
  label: string;
  children: React.ReactNode;
  numeric?: boolean;
}) {
  return (
    <div>
      <dt className="label-caps">{label}</dt>
      <dd className={cn('mt-1 text-sm text-ink-900', numeric && 'numeric')}>{children}</dd>
    </div>
  );
}
