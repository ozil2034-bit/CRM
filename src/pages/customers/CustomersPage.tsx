import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Alert, Badge, EmptyState, Toggle, buttonClasses } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { observeCustomers, type Customer } from '@/services/customers.service';
import { displayName } from '@/domain/customer';
import { rankMatches } from '@/domain/search';
import { tryParseOmanPhone } from '@/domain/phone';

export function CustomersPage() {
  const { t, language } = useT();
  const { can } = useAuth();

  const [snapshot, setSnapshot] = useState<{
    key: string;
    customers: Customer[];
    error: string | null;
  } | null>(null);
  const [term, setTerm] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);

  const filterKey = String(includeArchived);
  const current = snapshot !== null && snapshot.key === filterKey ? snapshot : null;
  const customers = current?.customers ?? null;
  const error = current?.error ?? null;

  useEffect(() => {
    const key = String(includeArchived);

    return observeCustomers(
      { includeArchived },
      (next) => setSnapshot({ key, customers: next, error: null }),
      (caught) => setSnapshot({ key, customers: [], error: caught.message }),
    );
  }, [includeArchived]);

  const visible = useMemo(() => {
    if (customers === null) return null;
    if (term.trim().length === 0) return customers;

    return rankMatches(
      term,
      customers,
      (customer) =>
        `${customer.code} ${customer.nameEn} ${customer.nameAr} ${customer.phoneNormalized}`,
    );
  }, [customers, term]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-caps">{t('nav.customers')}</p>
          <h1 className="display mt-2 text-3xl text-ink-900">{t('customers.title')}</h1>
        </div>

        {can('customers.create') && (
          <Link to="/customers/new" className={buttonClasses()}>
            {t('customers.new')}
          </Link>
        )}
      </header>

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-ink-100 pb-4">
        <input
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t('customers.searchPlaceholder')}
          aria-label={t('action.search')}
          className="h-11 min-w-0 flex-1 border-0 border-b border-transparent bg-transparent px-0 text-base text-ink-900 placeholder:text-ink-300 focus:border-gold-500 focus:outline-none"
        />

        <Toggle
          label={t('customers.showArchived')}
          checked={includeArchived}
          onChange={setIncludeArchived}
        />
      </div>

      {error && (
        <Alert tone="error" className="mt-6">
          {error}
        </Alert>
      )}

      {visible === null && <p className="mt-10 text-sm text-ink-400" role="status">{t('state.loading')}</p>}

      {visible !== null && visible.length === 0 && (
        <EmptyState
          title={term.trim().length > 0 ? t('customers.noResults') : t('customers.empty')}
          {...(term.trim().length === 0 ? { hint: t('customers.emptyHint') } : {})}
          action={
            term.trim().length === 0 && can('customers.create') ? (
              <Link to="/customers/new" className={buttonClasses()}>
                {t('customers.new')}
              </Link>
            ) : undefined
          }
        />
      )}

      {visible !== null && visible.length > 0 && (
        <ul className="mt-4 divide-y divide-ink-100">
          {visible.map((customer) => {
            const phone = tryParseOmanPhone(customer.phone);

            return (
              <li key={customer.id}>
                <Link
                  to={`/customers/${customer.id}`}
                  className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-1 py-3 hover:bg-sand-50"
                >
                  <span className="w-20 shrink-0 code text-2xs text-ink-300">
                    {customer.code}
                  </span>

                  <span className="user-text min-w-0 flex-1 truncate text-sm text-ink-900">
                    {displayName(customer, language)}
                  </span>

                  <span className="numeric shrink-0 text-sm text-ink-600">
                    {phone?.formatted ?? customer.phone}
                  </span>

                  {customer.hasWhatsapp && <Badge tone="success">WhatsApp</Badge>}

                  {customer.archived && <Badge tone="neutral">{t('customers.archived')}</Badge>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
