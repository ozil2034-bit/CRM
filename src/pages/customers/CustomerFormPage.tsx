import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Alert, Button, Field, Select, TextArea, Toggle } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import {
  checkDuplicatePhone,
  createCustomer,
  observeCustomer,
  updateCustomer,
  type Customer,
} from '@/services/customers.service';
import {
  CUSTOMER_SOURCES,
  PREFERRED_LANGUAGES,
  displayName,
  type DuplicateVerdict,
} from '@/domain/customer';
import { PHONE_PROBLEM_MESSAGES, parseOmanPhone } from '@/domain/phone';
import {
  EMPTY_CUSTOMER_FORM,
  customerFormSchema,
  type CustomerFormValues,
} from '@/schemas/customer';

export function CustomerFormPage() {
  const { customerId } = useParams<{ customerId: string }>();
  const isEditing = customerId !== undefined && customerId !== 'new';

  const navigate = useNavigate();
  const { t, language } = useT();
  const { principal, state } = useAuth();

  const [values, setValues] = useState<CustomerFormValues>(EMPTY_CUSTOMER_FORM);
  const [existing, setExisting] = useState<Customer | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateVerdict | null>(null);
  const [acknowledgedDuplicate, setAcknowledgedDuplicate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(isEditing);

  useEffect(() => {
    if (!isEditing || customerId === undefined) return;

    return observeCustomer(
      customerId,
      (customer) => {
        setLoading(false);
        if (customer === null) return;
        setExisting(customer);
        setValues((current) =>
          current === EMPTY_CUSTOMER_FORM ? fromCustomer(customer) : current,
        );
      },
      () => {
        setLoading(false);
        setBanner({ tone: 'error', text: t('error.loadFailed') });
      },
    );
  }, [customerId, isEditing, t]);

  function set<K extends keyof CustomerFormValues>(key: K, value: CustomerFormValues[K]): void {
    setValues((current) => ({ ...current, [key]: value }));
    if (key === 'phone') {
      // A changed number invalidates a previous acknowledgement.
      setDuplicate(null);
      setAcknowledgedDuplicate(false);
    }
  }

  /**
   * Check for an existing customer on this number when the field loses focus.
   *
   * The warning names who already holds it. Family members share numbers, so
   * this never blocks — but it must never silently create a second record
   * either, which is why saving requires an explicit acknowledgement.
   */
  async function handlePhoneBlur(): Promise<void> {
    if (values.phone.trim().length === 0) return;
    if (!parseOmanPhone(values.phone).ok) return;

    const verdict = await checkDuplicatePhone(values.phone, existing?.id);
    setDuplicate(verdict.severity === 'none' ? null : verdict);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    const parsed = customerFormSchema.safeParse(values);

    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        fieldErrors[issue.path.join('.')] ??= issue.message;
      }
      setErrors(fieldErrors);
      return;
    }

    // Re-check at submit time, not only on blur: the employee may never have
    // left the field, and another device may have added the number since.
    const verdict = await checkDuplicatePhone(parsed.data.phone, existing?.id);
    if (verdict.severity !== 'none' && !acknowledgedDuplicate) {
      setDuplicate(verdict);
      setErrors({});
      return;
    }

    setErrors({});
    setSubmitting(true);
    setBanner(null);

    const actor = {
      uid: principal?.uid ?? '',
      name: state.status === 'signed-in' ? state.session.name : '',
      role: principal?.role ?? ('STAFF' as const),
    };

    try {
      if (isEditing && existing !== null && customerId !== undefined) {
        const outcome = await updateCustomer(
          { customerId, before: existing, values: parsed.data, actor },
          (error) => setBanner({ tone: 'error', text: error.message }),
        );
        if (outcome.status === 'pending') {
          setBanner({ tone: 'info', text: t('write.pending') });
        }
        navigate(`/customers/${customerId}`);
      } else {
        const created = await createCustomer({ values: parsed.data, actor });
        navigate(`/customers/${created.id}`);
      }
    } catch (caught) {
      setBanner({
        tone: 'error',
        text: (caught as { message?: string }).message ?? t('error.loadFailed'),
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <main className="mx-auto max-w-3xl px-6 py-16 text-sm text-ink-400" role="status">{t('state.loading')}</main>;
  }

  const phoneResult = values.phone.trim().length > 0 ? parseOmanPhone(values.phone) : null;
  const phoneError =
    errors['phone'] ??
    (phoneResult !== null && !phoneResult.ok
      ? PHONE_PROBLEM_MESSAGES[phoneResult.problem]
      : undefined);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <p className="label-caps">{t('nav.customers')}</p>
      <h1 className="display mt-2 text-3xl text-ink-900">
        {isEditing ? t('customerForm.editTitle') : t('customerForm.newTitle')}
      </h1>
      {existing && <p className="mt-1 code text-xs text-ink-400">{existing.code}</p>}

      {banner && (
        <Alert tone={banner.tone} className="mt-6">
          {banner.text}
        </Alert>
      )}

      {duplicate && duplicate.matches.length > 0 && (
        <Alert tone="warning" title={t('duplicate.title')} className="mt-6">
          <p>{t('duplicate.body')}</p>
          <ul className="mt-3 space-y-1">
            {duplicate.matches.map((match) => (
              <li key={match.id} className="text-sm">
                <Link
                  to={`/customers/${match.id}`}
                  className="text-ink-900 underline underline-offset-4 hover:text-gold-700"
                >
                  {match.code} · {displayName(match, language)}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <Toggle
              label={t('duplicate.continue')}
              checked={acknowledgedDuplicate}
              onChange={setAcknowledgedDuplicate}
            />
          </div>
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-12" noValidate>
        <Section title={t('customerForm.personal')}>
          <Field
            label={t('customer.nameEn')}
            value={values.nameEn}
            onChange={(event) => set('nameEn', event.target.value)}
            error={errors['nameEn']}
            disabled={submitting}
          />
          <Field
            label={t('customer.nameAr')}
            lang="ar"
            dir="rtl"
            value={values.nameAr}
            onChange={(event) => set('nameAr', event.target.value)}
            disabled={submitting}
          />
        </Section>

        <Section title={t('customerForm.contact')}>
          <Field
            label={t('customer.phone')}
            type="tel"
            inputMode="tel"
            required
            value={values.phone}
            onChange={(event) => set('phone', event.target.value)}
            onBlur={() => void handlePhoneBlur()}
            error={phoneError}
            hint="9123 4567"
            disabled={submitting}
          />
          <Field
            label={t('customer.email')}
            type="email"
            value={values.email}
            onChange={(event) => set('email', event.target.value)}
            error={errors['email']}
            disabled={submitting}
          />
          <Toggle
            label={t('customer.whatsapp')}
            checked={values.hasWhatsapp}
            onChange={(next) => set('hasWhatsapp', next)}
            disabled={submitting}
          />
          <Field
            label={t('customer.nationalId')}
            hint={t('customerForm.nationalIdHint')}
            value={values.nationalId}
            onChange={(event) => set('nationalId', event.target.value)}
            disabled={submitting}
          />
        </Section>

        <Section title={t('customerForm.event')}>
          <Field
            label={t('customer.eventDate')}
            type="date"
            value={values.eventDate}
            onChange={(event) => set('eventDate', event.target.value)}
            error={errors['eventDate']}
            disabled={submitting}
          />
        </Section>

        <Section title={t('customerForm.measurements')}>
          {(['bust', 'waist', 'hips', 'height', 'shoeSize'] as const).map((key) => (
            <Field
              key={key}
              label={t(`customer.${key}` as const)}
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

        <Section title={t('customerForm.preferences')}>
          <Select
            label={t('customer.preferredLanguage')}
            value={values.preferredLanguage}
            onChange={(event) =>
              set(
                'preferredLanguage',
                event.target.value as CustomerFormValues['preferredLanguage'],
              )
            }
            options={PREFERRED_LANGUAGES.map((value) => ({
              value,
              label: t(`language.${value}` as const),
            }))}
            disabled={submitting}
          />
          <Select
            label={t('customer.source')}
            value={values.source}
            onChange={(event) => set('source', event.target.value as CustomerFormValues['source'])}
            options={[
              { value: '', label: '—' },
              ...CUSTOMER_SOURCES.map((source) => ({ value: source, label: source })),
            ]}
            disabled={submitting}
          />
        </Section>

        <div>
          <h2 className="label-caps">{t('customerForm.notes')}</h2>
          <TextArea
            label={t('customer.notes')}
            className="mt-4"
            value={values.notes}
            onChange={(event) => set('notes', event.target.value)}
            disabled={submitting}
          />
        </div>

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

function fromCustomer(customer: Customer): CustomerFormValues {
  return {
    nameEn: customer.nameEn,
    nameAr: customer.nameAr,
    phone: customer.phone,
    hasWhatsapp: customer.hasWhatsapp,
    email: customer.email,
    nationalId: customer.nationalId,
    eventDate: customer.eventDate,
    measurements: customer.measurements,
    source: customer.source as CustomerFormValues['source'],
    preferredLanguage: customer.preferredLanguage,
    notes: customer.notes,
  };
}
