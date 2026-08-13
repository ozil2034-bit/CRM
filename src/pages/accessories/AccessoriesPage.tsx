import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Alert, Badge, EmptyState, Select, Toggle, buttonClasses } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { formatOmr } from '@/domain/money';
import { rankMatches } from '@/domain/search';
import {
  ACCESSORY_CATEGORIES,
  selectableAccessories,
  type Accessory,
  type AccessoryCategory,
} from '@/domain/accessory';
import { observeAccessories } from '@/services/accessories.service';

/**
 * The accessory catalogue.
 *
 * A list, not a gallery: an accessory is identified by its name and its price
 * far more often than by a photograph, and a grid of veils all photographed on
 * the same white wall is harder to scan than a column of names.
 */
export function AccessoriesPage() {
  const { t, language } = useT();
  const { can } = useAuth();

  const [snapshot, setSnapshot] = useState<{
    accessories: Accessory[];
    error: string | null;
  } | null>(null);
  const [term, setTerm] = useState('');
  const [category, setCategory] = useState<AccessoryCategory | ''>('');
  const [includeRetired, setIncludeRetired] = useState(false);

  useEffect(() => {
    return observeAccessories(
      (next) => setSnapshot({ accessories: next, error: null }),
      (caught) => setSnapshot({ accessories: [], error: caught.message }),
    );
  }, []);

  const accessories = snapshot?.accessories ?? null;

  const visible = useMemo(() => {
    if (accessories === null) return null;

    const inScope = selectableAccessories(accessories, {
      includeRetired,
      category: category === '' ? null : category,
    });

    if (term.trim().length === 0) return inScope;

    return rankMatches(
      term,
      inScope,
      (accessory) => `${accessory.code} ${accessory.name} ${accessory.nameAr}`,
    );
  }, [accessories, term, category, includeRetired]);

  return (
    <main className="mx-auto max-w-4xl px-5 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-caps">{t('nav.accessories')}</p>
          <h1 className="display mt-2 text-3xl text-ink-900">{t('accessories.title')}</h1>
        </div>

        {can('accessories.manage') && (
          <Link to="/accessories/new" className={buttonClasses()}>
            {t('accessories.new')}
          </Link>
        )}
      </header>

      <div className="mt-8 flex flex-wrap items-end gap-x-6 gap-y-3 border-b border-ink-100 pb-4">
        <input
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t('action.search')}
          aria-label={t('action.search')}
          className="h-11 min-w-0 flex-1 border-0 border-b border-transparent bg-transparent px-0 text-base text-ink-900 placeholder:text-ink-300 focus:border-gold-500 focus:outline-none"
        />

        <Select
          label={t('accessory.category')}
          value={category}
          onChange={(event) => setCategory(event.target.value as AccessoryCategory | '')}
          options={[
            { value: '', label: t('reservations.filterAll') },
            ...ACCESSORY_CATEGORIES.map((value) => ({ value, label: value })),
          ]}
          className="w-40"
        />

        <Toggle
          label={t('accessories.showRetired')}
          checked={includeRetired}
          onChange={setIncludeRetired}
        />
      </div>

      {snapshot?.error !== null && snapshot?.error !== undefined && (
        <Alert tone="error" className="mt-6">
          {snapshot.error}
        </Alert>
      )}

      {visible === null && (
        <p className="mt-10 text-sm text-ink-400" role="status">
          {t('state.loading')}
        </p>
      )}

      {visible !== null && visible.length === 0 && (
        <EmptyState
          title={term.trim().length > 0 ? t('accessories.noResults') : t('accessories.empty')}
          {...(term.trim().length === 0 ? { hint: t('accessories.emptyHint') } : {})}
          action={
            term.trim().length === 0 && can('accessories.manage') ? (
              <Link to="/accessories/new" className={buttonClasses()}>
                {t('accessories.new')}
              </Link>
            ) : undefined
          }
        />
      )}

      {visible !== null && visible.length > 0 && (
        <ul className="mt-4 divide-y divide-ink-100">
          {visible.map((accessory) => (
            <li key={accessory.id}>
              <Link
                to={`/accessories/${accessory.id}`}
                className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-1 py-3 hover:bg-sand-50"
              >
                <span className="w-24 shrink-0 font-mono text-2xs text-ink-300">
                  {accessory.code}
                </span>

                <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                  {language === 'ar' && accessory.nameAr.length > 0
                    ? accessory.nameAr
                    : accessory.name}
                </span>

                <span className="shrink-0 text-2xs text-ink-400">{accessory.category}</span>

                <span className="numeric shrink-0 text-sm text-ink-600">
                  {formatOmr(accessory.rentalPrice)}
                </span>

                {accessory.status === 'Retired' && (
                  <Badge tone="neutral">{t('accessoryStatus.Retired')}</Badge>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
