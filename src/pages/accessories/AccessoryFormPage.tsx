import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Alert, Button, Field, Select, TextArea } from '@/design-system';
import { MoneyField } from '@/components/MoneyField';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { ACCESSORY_CATEGORIES, ACCESSORY_KINDS, type Accessory } from '@/domain/accessory';
import {
  EMPTY_ACCESSORY_FORM,
  accessoryFormSchema,
  type AccessoryFormValues,
} from '@/schemas/accessory';
import {
  createAccessory,
  observeAccessories,
  setAccessoryStatus,
  updateAccessory,
} from '@/services/accessories.service';
import type { Baisa } from '@/domain/money';
import { useFriendlyError } from '@/hooks/useFriendlyError';

/**
 * Create or edit an accessory.
 *
 * Short, because an accessory is a short thing. The only field the form insists
 * on is the name; a box of veils arrives before anyone has decided what to
 * charge, and demanding a price up front would have staff type a placeholder
 * that later reaches an invoice.
 */
export function AccessoryFormPage() {
  const { accessoryId } = useParams<{ accessoryId: string }>();
  const isEditing = accessoryId !== undefined && accessoryId !== 'new';

  const navigate = useNavigate();
  const { t } = useT();
  const friendly = useFriendlyError();
  const { principal, state, can } = useAuth();

  const [values, setValues] = useState<AccessoryFormValues>(EMPTY_ACCESSORY_FORM);
  const [existing, setExisting] = useState<Accessory | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(isEditing);

  useEffect(() => {
    if (!isEditing) return;

    return observeAccessories(
      (all) => {
        setLoading(false);
        const found = all.find((entry) => entry.id === accessoryId) ?? null;
        if (found === null) return;

        setExisting(found);
        setValues((current) =>
          // Never clobber edits in progress if the document changes underneath.
          current === EMPTY_ACCESSORY_FORM ? fromAccessory(found) : current,
        );
      },
      () => {
        setLoading(false);
        setBanner({ tone: 'error', text: t('error.loadFailed') });
      },
    );
  }, [accessoryId, isEditing, t]);

  const actor =
    principal === null
      ? null
      : {
          uid: principal.uid,
          name: state.status === 'signed-in' ? state.session.name : '',
          role: principal.role,
        };

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (actor === null || submitting) return;

    const parsed = accessoryFormSchema.safeParse(values);

    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.');
        next[key] = issue.message;
      }
      setErrors(next);
      return;
    }

    setErrors({});
    setSubmitting(true);

    try {
      if (isEditing && accessoryId !== undefined && existing !== null) {
        const outcome = await updateAccessory({
          accessoryId,
          code: existing.code,
          values: parsed.data,
          actor,
        });

        if (outcome.status === 'failed') {
          setBanner({ tone: 'error', text: friendly(outcome.error).message });
          return;
        }

        setBanner({
          tone: 'success',
          text: outcome.status === 'pending' ? t('write.pending') : t('write.synced'),
        });
      } else {
        const created = await createAccessory({ values: parsed.data, actor });
        void navigate(`/accessories/${created.id}`, { replace: true });
      }
    } catch (error) {
      setBanner({ tone: 'error', text: (error as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleRetired(): Promise<void> {
    if (actor === null || existing === null || accessoryId === undefined) return;

    const outcome = await setAccessoryStatus({
      accessoryId,
      code: existing.code,
      status: existing.status === 'Retired' ? 'Active' : 'Retired',
      actor,
    });

    if (outcome.status === 'failed') {
      setBanner({ tone: 'error', text: friendly(outcome.error).message });
    }
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-2xl px-5 py-10 sm:px-6">
        <p className="text-sm text-ink-400" role="status">
          {t('state.loading')}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-5 py-8 sm:px-6 sm:py-10">
      <header>
        <p className="label-caps">{t('nav.accessories')}</p>
        <h1 className="display mt-2 text-3xl text-ink-900">
          {isEditing ? t('accessories.edit') : t('accessories.new')}
        </h1>
        {existing !== null && (
          <p className="mt-1 code text-2xs text-ink-300">{existing.code}</p>
        )}
      </header>

      {banner !== null && (
        <Alert tone={banner.tone === 'error' ? 'error' : 'success'} className="mt-6">
          {banner.text}
        </Alert>
      )}

      <form onSubmit={(event) => void handleSubmit(event)} className="mt-8 space-y-8" noValidate>
        <section className="grid gap-6 sm:grid-cols-2">
          <Field
            label={t('accessory.name')}
            value={values.name}
            onChange={(event) => setValues({ ...values, name: event.target.value })}
            error={errors['name']}
            required
          />
          <Field
            label={t('accessory.nameAr')}
            value={values.nameAr}
            onChange={(event) => setValues({ ...values, nameAr: event.target.value })}
            error={errors['nameAr']}
            dir="rtl"
          />

          <Select
            label={t('accessory.category')}
            value={values.category}
            onChange={(event) =>
              setValues({ ...values, category: event.target.value as AccessoryFormValues['category'] })
            }
            options={ACCESSORY_CATEGORIES.map((value) => ({
              value,
              label: t(`accessoryCategory.${value}`),
            }))}
          />

          <Select
            label={t('accessory.kind')}
            value={values.kind}
            onChange={(event) =>
              setValues({ ...values, kind: event.target.value as AccessoryFormValues['kind'] })
            }
            options={ACCESSORY_KINDS.map((value) => ({
              value,
              label: t(`accessoryKind.${value}`),
            }))}
          />
        </section>

        <section className="grid gap-6 sm:grid-cols-3">
          <MoneyField
            label={t('accessory.rentalPrice')}
            value={values.rentalPrice as Baisa}
            onChange={(next) => setValues({ ...values, rentalPrice: next ?? 0 })}
            error={errors['rentalPrice']}
          />
          <MoneyField
            label={t('accessory.salePrice')}
            value={values.salePrice as Baisa | null}
            onChange={(next) => setValues({ ...values, salePrice: next })}
            error={errors['salePrice']}
            allowEmpty
          />
          <MoneyField
            label={t('accessory.securityDeposit')}
            value={values.securityDeposit as Baisa}
            onChange={(next) => setValues({ ...values, securityDeposit: next ?? 0 })}
            error={errors['securityDeposit']}
          />
        </section>

        <section className="grid gap-6 sm:grid-cols-2">
          <TextArea
            label={t('accessory.description')}
            value={values.description}
            onChange={(event) => setValues({ ...values, description: event.target.value })}
            rows={3}
          />
          <TextArea
            label={t('accessory.descriptionAr')}
            value={values.descriptionAr}
            onChange={(event) => setValues({ ...values, descriptionAr: event.target.value })}
            rows={3}
            dir="rtl"
          />
        </section>

        <div className="flex flex-wrap items-center gap-3 border-t border-ink-100 pt-6">
          <Button type="submit" disabled={submitting}>
            {submitting ? t('action.saving') : t('action.save')}
          </Button>

          <Button type="button" variant="ghost" onClick={() => void navigate('/accessories')}>
            {t('action.cancel')}
          </Button>

          {/*
           * Retiring, never deleting. Past reservations reference accessories by
           * id; removing one would leave their revenue unattributable.
           */}
          {isEditing && existing !== null && can('accessories.retire') && (
            <Button
              type="button"
              variant="ghost"
              className="ms-auto"
              onClick={() => void toggleRetired()}
            >
              {existing.status === 'Retired' ? t('accessory.restore') : t('accessory.retire')}
            </Button>
          )}
        </div>
      </form>
    </main>
  );
}

function fromAccessory(accessory: Accessory): AccessoryFormValues {
  return {
    name: accessory.name,
    nameAr: accessory.nameAr,
    description: accessory.description,
    descriptionAr: accessory.descriptionAr,
    category: accessory.category,
    kind: accessory.kind,
    rentalPrice: accessory.rentalPrice,
    salePrice: accessory.salePrice,
    securityDeposit: accessory.securityDeposit,
  };
}
