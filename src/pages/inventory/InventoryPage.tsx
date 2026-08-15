import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Alert, Badge, Button, EmptyState, Select, Toggle, buttonClasses } from '@/design-system';
import { DressPhoto } from '@/components/DressPhoto';
import { DressCard } from './DressCard';
import { STATUS_TONE } from './status-tone';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { observeDresses, type Dress } from '@/services/dresses.service';
import { rankMatches } from '@/domain/search';
import { DRESS_STATUSES, resolvePrimaryPhoto, type DressStatus } from '@/domain/dress';
import { formatOmr } from '@/domain/money';
import { cn } from '@/lib/utils/cn';
import { toFriendlyError, type ErrorKind } from '@/domain/firebase-errors';

type ViewMode = 'gallery' | 'list';

/**
 * The inventory.
 *
 * Gallery by default — 3 columns on desktop, 2 on tablet, 2 on a phone in
 * portrait. A table is offered as an alternative for staff comparing prices or
 * locations across many dresses, but it is not the primary experience: for a
 * bridal boutique the photograph *is* the record.
 */
export function InventoryPage() {
  const { t } = useT();
  const { can } = useAuth();

  const [snapshot, setSnapshot] = useState<{
    key: string;
    dresses: Dress[];
    error: ErrorKind | null;
  } | null>(null);
  const [term, setTerm] = useState('');
  const [includeRetired, setIncludeRetired] = useState(false);
  const [view, setView] = useState<ViewMode>('gallery');

  const [status, setStatus] = useState<DressStatus | ''>('');
  const [designer, setDesigner] = useState('');
  const [size, setSize] = useState('');
  const [colour, setColour] = useState('');
  const [style, setStyle] = useState('');

  // Keyed by the filter that produced it, so changing the filter shows the
  // loading state without a synchronous setState inside the effect.
  const filterKey = String(includeRetired);
  const current = snapshot !== null && snapshot.key === filterKey ? snapshot : null;
  const dresses = current?.dresses ?? null;
  const error = current?.error ?? null;

  useEffect(() => {
    const key = String(includeRetired);

    return observeDresses(
      { includeRetired },
      (next) => setSnapshot({ key, dresses: next, error: null }),
      (caught) => setSnapshot({ key, dresses: [], error: toFriendlyError(caught).kind }),
    );
  }, [includeRetired]);

  /*
   * Filtering happens in memory over the already-loaded inventory, which is a
   * live subscription the screen is holding anyway. `searchDresses` (an indexed
   * query) exists for global search across the whole collection; issuing it on
   * every keystroke here would be a network round trip for data already present.
   */
  const visible = useMemo(() => {
    if (dresses === null) return null;

    const matches = (value: string, wanted: string) =>
      wanted === '' || value === wanted;

    const inScope = dresses.filter(
      (dress) =>
        (status === '' || dress.status === status) &&
        matches(dress.designer, designer) &&
        matches(dress.size, size) &&
        matches(dress.color, colour) &&
        matches(dress.style, style),
    );

    if (term.trim().length === 0) return inScope;

    return rankMatches(
      term,
      inScope,
      (dress) => `${dress.code} ${dress.name} ${dress.designer} ${dress.brand} ${dress.color}`,
    );
  }, [dresses, term, status, designer, size, colour, style]);

  /*
   * The filter lists are built from the inventory itself rather than from a
   * fixed vocabulary. A boutique's designers and sizes are whatever it stocks;
   * offering an option that matches nothing wastes the employee's time, and
   * omitting one it does stock hides the gown.
   */
  const options = useMemo(() => {
    const distinct = (pick: (dress: Dress) => string) =>
      [...new Set((dresses ?? []).map(pick).filter((value) => value.length > 0))].sort();

    return {
      designers: distinct((dress) => dress.designer),
      sizes: distinct((dress) => dress.size),
      colours: distinct((dress) => dress.color),
      styles: distinct((dress) => dress.style),
    };
  }, [dresses]);

  const filtersActive =
    status !== '' || designer !== '' || size !== '' || colour !== '' || style !== '';

  function clearFilters(): void {
    setStatus('');
    setDesigner('');
    setSize('');
    setColour('');
    setStyle('');
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-caps">{t('nav.inventory')}</p>
          <h1 className="display mt-2 text-3xl text-ink-900">{t('inventory.title')}</h1>
        </div>

        {can('dresses.create') && (
          <Link to="/inventory/new" className={buttonClasses()}>
            {t('inventory.new')}
          </Link>
        )}
      </header>

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-ink-100 pb-4">
        <input
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t('inventory.searchPlaceholder')}
          aria-label={t('action.search')}
          className="h-11 min-w-0 flex-1 border-0 border-b border-transparent bg-transparent px-0 text-base text-ink-900 placeholder:text-ink-300 focus:border-gold-500 focus:outline-none"
        />

        <Toggle
          label={t('inventory.showRetired')}
          checked={includeRetired}
          onChange={setIncludeRetired}
        />

        <div className="flex items-center gap-1" role="group" aria-label={t('inventory.viewGallery')}>
          {(['gallery', 'list'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              aria-pressed={view === mode}
              className={cn(
                'min-h-11 rounded-xs px-3 text-xs transition-colors',
                view === mode ? 'text-ink-900' : 'text-ink-400 hover:text-ink-700',
              )}
            >
              {mode === 'gallery' ? t('inventory.viewGallery') : t('inventory.viewList')}
            </button>
          ))}
        </div>
      </div>

      {/*
       * Filters below the search line, not above it. Search is what an employee
       * reaches for nine times in ten; the filters are for the tenth.
       */}
      <div className="mt-4 flex flex-wrap items-end gap-x-5 gap-y-3">
        <Select
          label={t('dress.status')}
          value={status}
          onChange={(event) => setStatus(event.target.value as DressStatus | '')}
          options={[
            { value: '', label: t('reservations.filterAll') },
            ...DRESS_STATUSES.map((value) => ({ value, label: t(`dressStatus.${value}`) })),
          ]}
          className="w-40"
        />

        <FilterSelect
          label={t('dress.designer')}
          value={designer}
          onChange={setDesigner}
          values={options.designers}
        />
        <FilterSelect label={t('dress.size')} value={size} onChange={setSize} values={options.sizes} />
        <FilterSelect
          label={t('dress.color')}
          value={colour}
          onChange={setColour}
          values={options.colours}
        />
        <FilterSelect
          label={t('dress.style')}
          value={style}
          onChange={setStyle}
          values={options.styles}
        />

        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            {t('reservations.clearFilters')}
          </Button>
        )}
      </div>

      {error && (
        <Alert tone="error" className="mt-6">
          {t(`errorKind.${error}`)}
        </Alert>
      )}

      {visible === null && <p className="mt-10 text-sm text-ink-400" role="status">{t('state.loading')}</p>}

      {visible !== null && visible.length === 0 && (
        <EmptyState
          title={
            term.trim().length > 0 || filtersActive
              ? t('inventory.noResults')
              : t('inventory.empty')
          }
          {...(term.trim().length === 0 && !filtersActive
            ? { hint: t('inventory.emptyHint') }
            : {})}
          action={
            term.trim().length === 0 && !filtersActive && can('dresses.create') ? (
              <Link to="/inventory/new" className={buttonClasses()}>
                {t('inventory.new')}
              </Link>
            ) : undefined
          }
        />
      )}

      {visible !== null && visible.length > 0 && (
        <>
          <p className="mt-6 text-xs text-ink-400">
            {visible.length} {t('inventory.count')}
          </p>

          {view === 'gallery' ? (
            <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-2 lg:grid-cols-3">
              {visible.map((dress) => (
                <DressCard key={dress.id} dress={dress} />
              ))}
            </div>
          ) : (
            <DressTable dresses={visible} />
          )}
        </>
      )}
    </main>
  );
}

function DressTable({ dresses }: { dresses: readonly Dress[] }) {
  const { t } = useT();

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[42rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-ink-100 text-start">
            <th className="w-14 py-2" />
            <th className="label-caps py-2 text-start">{t('dress.code')}</th>
            <th className="label-caps py-2 text-start">{t('dress.name')}</th>
            <th className="label-caps py-2 text-start">{t('dress.designer')}</th>
            <th className="label-caps py-2 text-start">{t('dress.size')}</th>
            <th className="label-caps py-2 text-end">{t('dress.rentalPrice')}</th>
            <th className="label-caps py-2 text-start">{t('dress.status')}</th>
          </tr>
        </thead>
        <tbody>
          {dresses.map((dress) => (
            <tr key={dress.id} className="border-b border-ink-100/70">
              <td className="py-2">
                <Link to={`/inventory/${dress.id}`}>
                  <DressPhoto
                    photo={resolvePrimaryPhoto(dress.photos, dress.primaryPhotoId)}
                    alt={dress.name}
                    className="aspect-[3/4] w-10"
                  />
                </Link>
              </td>
              <td className="py-2 code text-2xs text-ink-500">{dress.code}</td>
              <td className="py-2">
                <Link to={`/inventory/${dress.id}`} className="text-ink-900 hover:text-gold-700">
                  {dress.name}
                </Link>
              </td>
              <td className="py-2 text-ink-600">{dress.designer || '—'}</td>
              <td className="py-2 text-ink-600">{dress.size || '—'}</td>
              <td className="numeric py-2 text-end text-ink-900">
                {formatOmr(dress.rentalPrice, { withCode: false })}
              </td>
              <td className="py-2">
                <Badge tone={STATUS_TONE[dress.status]}>{t(`dressStatus.${dress.status}`)}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A dropdown built from what the inventory actually contains.
 *
 * Renders nothing when the boutique has never recorded that attribute — an
 * empty "Designer" list is a control that can only disappoint.
 */
function FilterSelect({
  label,
  value,
  onChange,
  values,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  values: readonly string[];
}) {
  const { t } = useT();

  if (values.length === 0) return null;

  return (
    <Select
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      options={[
        { value: '', label: t('reservations.filterAll') },
        ...values.map((entry) => ({ value: entry, label: entry })),
      ]}
      className="w-36"
    />
  );
}
