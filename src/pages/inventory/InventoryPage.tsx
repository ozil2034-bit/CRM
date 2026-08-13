import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Alert, Badge, EmptyState, Toggle, buttonClasses } from '@/design-system';
import { DressPhoto } from '@/components/DressPhoto';
import { DressCard } from './DressCard';
import { STATUS_TONE } from './status-tone';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { observeDresses, type Dress } from '@/services/dresses.service';
import { rankMatches } from '@/domain/search';
import { resolvePrimaryPhoto } from '@/domain/dress';
import { formatOmr } from '@/domain/money';
import { cn } from '@/lib/utils/cn';

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
    error: string | null;
  } | null>(null);
  const [term, setTerm] = useState('');
  const [includeRetired, setIncludeRetired] = useState(false);
  const [view, setView] = useState<ViewMode>('gallery');

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
      (caught) => setSnapshot({ key, dresses: [], error: caught.message }),
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
    if (term.trim().length === 0) return dresses;

    return rankMatches(
      term,
      dresses,
      (dress) => `${dress.code} ${dress.name} ${dress.designer} ${dress.brand} ${dress.color}`,
    );
  }, [dresses, term]);

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

        <div className="flex items-center gap-1" role="group" aria-label="View">
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

      {error && (
        <Alert tone="error" className="mt-6">
          {error}
        </Alert>
      )}

      {visible === null && <p className="mt-10 text-sm text-ink-400">…</p>}

      {visible !== null && visible.length === 0 && (
        <EmptyState
          title={term.trim().length > 0 ? t('inventory.noResults') : t('inventory.empty')}
          {...(term.trim().length === 0 ? { hint: t('inventory.emptyHint') } : {})}
          action={
            term.trim().length === 0 && can('dresses.create') ? (
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
              <td className="py-2 font-mono text-2xs text-ink-500">{dress.code}</td>
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
                <Badge tone={STATUS_TONE[dress.status]}>{dress.status}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
