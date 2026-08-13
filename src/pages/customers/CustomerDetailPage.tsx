import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Alert, Badge, Button, buttonClasses } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { observeCustomer, setCustomerArchived, type Customer } from '@/services/customers.service';
import { displayName } from '@/domain/customer';
import { tryParseOmanPhone } from '@/domain/phone';
import { cn } from '@/lib/utils/cn';

export function CustomerDetailPage() {
  const { customerId } = useParams<{ customerId: string }>();
  const { t, language } = useT();
  const { principal, state, can } = useAuth();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (customerId === undefined) return;

    return observeCustomer(
      customerId,
      (next) => {
        setCustomer(next);
        setLoading(false);
      },
      () => {
        setLoading(false);
        setBanner({ tone: 'error', text: t('error.loadFailed') });
      },
    );
  }, [customerId, t]);

  if (loading) {
    return <main className="mx-auto max-w-3xl px-6 py-16 text-sm text-ink-400">…</main>;
  }

  if (customer === null) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <p className="text-sm text-ink-500">{t('error.notFound')}</p>
        <Link to="/customers" className="mt-6 inline-block text-sm text-gold-700 underline">
          {t('action.back')}
        </Link>
      </main>
    );
  }

  const phone = tryParseOmanPhone(customer.phone);

  async function toggleArchived(): Promise<void> {
    if (customer === null || busy) return;

    setBusy(true);
    setBanner(null);

    try {
      const outcome = await setCustomerArchived({
        customer,
        archived: !customer.archived,
        actor: {
          uid: principal?.uid ?? '',
          name: state.status === 'signed-in' ? state.session.name : '',
          role: principal?.role ?? 'STAFF',
        },
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

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link to="/customers" className="text-xs text-ink-400 hover:text-ink-700">
        ← {t('customers.title')}
      </Link>

      {banner && (
        <Alert tone={banner.tone} className="mt-6">
          {banner.text}
        </Alert>
      )}

      <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="display text-3xl text-ink-900">{displayName(customer, language)}</h1>
          <p className="mt-1 font-mono text-xs text-ink-400">{customer.code}</p>
          {customer.archived && (
            <Badge tone="neutral" className="mt-2">
              {t('customers.archived')}
            </Badge>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {can('customers.edit') && (
            <Link
              to={`/customers/${customer.id}/edit`}
              className={buttonClasses('secondary', 'sm')}
            >
              {t('action.edit')}
            </Link>
          )}
          {can('customers.edit') && (
            <Button variant="ghost" size="sm" loading={busy} onClick={() => void toggleArchived()}>
              {customer.archived ? t('customers.restore') : t('customers.archive')}
            </Button>
          )}
        </div>
      </div>

      <hr className="rule-gold mt-6 w-16" />

      <dl className="mt-8 grid gap-x-8 gap-y-5 sm:grid-cols-2">
        {customer.nameEn && <Detail label={t('customer.nameEn')}>{customer.nameEn}</Detail>}
        {customer.nameAr && (
          <Detail label={t('customer.nameAr')}>
            <span lang="ar" dir="rtl">
              {customer.nameAr}
            </span>
          </Detail>
        )}
        <Detail label={t('customer.phone')} numeric>
          {phone?.formatted ?? customer.phone}
          {customer.hasWhatsapp && (
            <Badge tone="success" className="ms-2">
              WhatsApp
            </Badge>
          )}
        </Detail>
        <Detail label={t('customer.email')}>{customer.email || '—'}</Detail>
        <Detail label={t('customer.eventDate')} numeric>
          {customer.eventDate || '—'}
        </Detail>
        <Detail label={t('customer.preferredLanguage')}>
          {t(`language.${customer.preferredLanguage}` as const)}
        </Detail>
        <Detail label={t('customer.source')}>{customer.source || '—'}</Detail>
        {/* National ID is shown only where it was entered, and never indexed. */}
        {customer.nationalId && (
          <Detail label={t('customer.nationalId')}>{customer.nationalId}</Detail>
        )}
      </dl>

      <section className="mt-10">
        <h2 className="label-caps">{t('customer.measurements')}</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-5">
          {(['bust', 'waist', 'hips', 'height', 'shoeSize'] as const).map((key) => (
            <Detail key={key} label={t(`customer.${key}` as const)} numeric>
              {customer.measurements[key] ?? '—'}
            </Detail>
          ))}
        </dl>
      </section>

      {customer.notes && (
        <section className="mt-10">
          <h2 className="label-caps">{t('customer.notes')}</h2>
          <p className="mt-3 whitespace-pre-wrap text-sm text-ink-700">{customer.notes}</p>
        </section>
      )}
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
