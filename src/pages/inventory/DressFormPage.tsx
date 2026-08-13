import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Alert, Button, Field, Select, TextArea } from '@/design-system';
import { MoneyField } from '@/components/MoneyField';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import {
  createDress,
  observeDress,
  readPurchaseCost,
  updateDress,
  type Dress,
} from '@/services/dresses.service';
import { DRESS_CONDITIONS } from '@/domain/dress';
import { EMPTY_DRESS_FORM, dressFormSchema, type DressFormValues } from '@/schemas/dress';
import type { Baisa } from '@/domain/money';
import type { WriteOutcome } from '@/services/write';

/**
 * Create or edit a dress.
 *
 * Fields are grouped the way an employee thinks about a garment — identity,
 * appearance, pricing, measurements, where it hangs, operational settings,
 * notes — rather than in schema order.
 *
 * Only the name is required. A dress arrives at the boutique before anyone has
 * measured it or chosen a rail, and demanding every field would push staff into
 * typing placeholders, which is worse than an honest partial record.
 */
export function DressFormPage() {
  const { dressId } = useParams<{ dressId: string }>();
  const isEditing = dressId !== undefined && dressId !== 'new';

  const navigate = useNavigate();
  const { t } = useT();
  const { principal, state, can } = useAuth();

  const [values, setValues] = useState<DressFormValues>(EMPTY_DRESS_FORM);
  const [existing, setExisting] = useState<Dress | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ tone: 'error' | 'success' | 'info'; text: string } | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(isEditing);

  const canSeeCost = can('dresses.viewPurchaseCost');

  useEffect(() => {
    if (!isEditing || dressId === undefined) return;

    return observeDress(
      dressId,
      (dress) => {
        setLoading(false);
        if (dress === null) return;
        setExisting(dress);
        setValues((current) =>
          // Do not clobber edits in progress if the document updates underneath.
          current === EMPTY_DRESS_FORM ? fromDress(dress) : current,
        );
      },
      () => {
        setLoading(false);
        setBanner({ tone: 'error', text: t('error.loadFailed') });
      },
    );
  }, [dressId, isEditing, t]);

  useEffect(() => {
    if (!isEditing || dressId === undefined || !canSeeCost) return;

    void readPurchaseCost(dressId).then((cost) => {
      if (cost !== null) {
        setValues((current) => ({ ...current, purchaseCost: cost }));
      }
    });
  }, [dressId, isEditing, canSeeCost]);

  function set<K extends keyof DressFormValues>(key: K, value: DressFormValues[K]): void {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    const parsed = dressFormSchema.safeParse(values);

    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.');
        fieldErrors[key] ??= issue.message;
      }
      setErrors(fieldErrors);
      setBanner(null);
      return;
    }

    setErrors({});
    setSubmitting(true);
    setBanner(null);

    const actor = {
      uid: principal?.uid ?? '',
      name: state.status === 'signed-in' ? state.session.name : '',
      role: principal?.role ?? 'STAFF',
    };

    try {
      if (isEditing && existing !== null && dressId !== undefined) {
        const outcome = await updateDress(
          {
            dressId,
            before: existing,
            values: parsed.data,
            actor,
            canSetPurchaseCost: canSeeCost,
          },
          (error) => setBanner({ tone: 'error', text: error.message }),
        );
        reportOutcome(outcome);
        navigate(`/inventory/${dressId}`);
      } else {
        const created = await createDress({
          values: parsed.data,
          actor,
          canSetPurchaseCost: canSeeCost,
        });
        navigate(`/inventory/${created.id}`);
      }
    } catch (caught) {
      // Form values are untouched — nothing is retyped after a failure.
      setBanner({
        tone: 'error',
        text: (caught as { message?: string }).message ?? t('error.loadFailed'),
      });
    } finally {
      setSubmitting(false);
    }
  }

  function reportOutcome(outcome: WriteOutcome): void {
    if (outcome.status === 'pending') {
      setBanner({ tone: 'info', text: t('write.pending') });
    }
  }

  if (loading) {
    return <main className="mx-auto max-w-3xl px-6 py-16 text-sm text-ink-400">…</main>;
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <p className="label-caps">{t('nav.inventory')}</p>
      <h1 className="display mt-2 text-3xl text-ink-900">
        {isEditing ? t('dressForm.editTitle') : t('dressForm.newTitle')}
      </h1>
      {existing && <p className="mt-1 font-mono text-xs text-ink-400">{existing.code}</p>}

      {banner && (
        <Alert tone={banner.tone === 'success' ? 'success' : banner.tone} className="mt-6">
          {banner.text}
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-12" noValidate>
        <Section title={t('dressForm.identity')}>
          <Field
            label={t('dress.name')}
            required
            value={values.name}
            onChange={(event) => set('name', event.target.value)}
            error={errors['name']}
            disabled={submitting}
          />
          <Field
            label={t('dress.designer')}
            value={values.designer}
            onChange={(event) => set('designer', event.target.value)}
            disabled={submitting}
          />
          <Field
            label={t('dress.brand')}
            value={values.brand}
            onChange={(event) => set('brand', event.target.value)}
            disabled={submitting}
          />
          <Field
            label={t('dress.size')}
            value={values.size}
            onChange={(event) => set('size', event.target.value)}
            disabled={submitting}
          />
        </Section>

        <Section title={t('dressForm.appearance')}>
          <Field
            label={t('dress.color')}
            value={values.color}
            onChange={(event) => set('color', event.target.value)}
            disabled={submitting}
          />
          <Field
            label={t('dress.style')}
            value={values.style}
            onChange={(event) => set('style', event.target.value)}
            disabled={submitting}
          />
          <Select
            label={t('dress.condition')}
            value={values.condition}
            onChange={(event) =>
              set('condition', event.target.value as DressFormValues['condition'])
            }
            options={DRESS_CONDITIONS.map((condition) => ({
              value: condition,
              label: condition,
            }))}
            disabled={submitting}
          />
        </Section>

        <Section title={t('dressForm.pricing')}>
          <MoneyField
            label={t('dress.rentalPrice')}
            value={values.rentalPrice as Baisa}
            onChange={(next) => set('rentalPrice', (next ?? 0) as number)}
            error={errors['rentalPrice']}
            disabled={submitting}
          />
          <MoneyField
            label={t('dress.securityDeposit')}
            value={values.securityDeposit as Baisa}
            onChange={(next) => set('securityDeposit', (next ?? 0) as number)}
            error={errors['securityDeposit']}
            disabled={submitting}
          />
          <MoneyField
            label={t('dress.salePrice')}
            allowEmpty
            value={values.salePrice as Baisa | null}
            onChange={(next) => set('salePrice', next as number | null)}
            disabled={submitting}
          />

          {/* Owner only. The rules refuse a staff write to the subcollection
              this is stored in, so hiding it here is a courtesy, not the control. */}
          {canSeeCost && (
            <MoneyField
              label={t('dress.purchaseCost')}
              allowEmpty
              hint={t('dressForm.costHint')}
              value={values.purchaseCost as Baisa | null}
              onChange={(next) => set('purchaseCost', next as number | null)}
              disabled={submitting}
            />
          )}
        </Section>

        <Section title={t('dressForm.measurements')}>
          {(['bust', 'waist', 'hips', 'length'] as const).map((key) => (
            <Field
              key={key}
              label={t(`dress.${key}` as const)}
              type="number"
              inputMode="numeric"
              value={values.measurements[key] ?? ''}
              onChange={(event) =>
                set('measurements', {
                  ...values.measurements,
                  [key]: event.target.value === '' ? null : Number(event.target.value),
                })
              }
              error={errors[`measurements.${key}`]}
              disabled={submitting}
            />
          ))}
        </Section>

        <Section title={t('dressForm.storage')}>
          <Field
            label={t('dress.location')}
            value={values.location}
            onChange={(event) => set('location', event.target.value)}
            disabled={submitting}
          />
        </Section>

        <Section title={t('dressForm.operational')}>
          <Field
            label={`${t('dress.cleaningBuffer')} (${t('dress.days')})`}
            type="number"
            inputMode="numeric"
            value={values.cleaningBufferDays}
            onChange={(event) => set('cleaningBufferDays', Number(event.target.value))}
            error={errors['cleaningBufferDays']}
            disabled={submitting}
          />
        </Section>

        <div>
          <h2 className="label-caps">{t('dressForm.notes')}</h2>
          <TextArea
            label={t('dress.notes')}
            className="mt-4"
            value={values.notes}
            onChange={(event) => set('notes', event.target.value)}
            disabled={submitting}
          />
        </div>

        {!isEditing && <p className="text-xs text-ink-400">{t('dressForm.photosHint')}</p>}

        <div className="flex flex-wrap gap-3">
          <Button type="submit" size="lg" loading={submitting}>
            {submitting ? t('action.saving') : t('action.save')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            onClick={() => navigate(-1)}
            disabled={submitting}
          >
            {t('action.cancel')}
          </Button>
        </div>
      </form>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="label-caps">{title}</h2>
      <div className="mt-4 grid gap-6 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function fromDress(dress: Dress): DressFormValues {
  return {
    name: dress.name,
    designer: dress.designer,
    brand: dress.brand,
    size: dress.size,
    color: dress.color,
    style: dress.style,
    condition: dress.condition,
    measurements: dress.measurements,
    rentalPrice: dress.rentalPrice,
    salePrice: dress.salePrice,
    securityDeposit: dress.securityDeposit,
    purchaseCost: null,
    location: dress.location,
    cleaningBufferDays: dress.cleaningBufferDays,
    notes: dress.notes,
  };
}
