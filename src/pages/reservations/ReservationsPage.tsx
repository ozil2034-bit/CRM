import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Alert, Badge, EmptyState, Toggle, buttonClasses } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { observeReservations, type Reservation } from '@/services/reservations.service';
import { formatMuscatDate } from '@/domain/datetime';
import { formatOmr } from '@/domain/money';
import { rankMatches } from '@/domain/search';
import { RESERVATION_STATUS_TONE } from './status-tone';

/** Bookings that are over, and would otherwise bury the live ones. */
const FINISHED = new Set(['Closed', 'Cancelled', 'No-Show']);

export function ReservationsPage() {
  const { t, language } = useT();
  const { can } = useAuth();

  const [snapshot, setSnapshot] = useState<{
    reservations: Reservation[];
    error: string | null;
  } | null>(null);
  const [term, setTerm] = useState('');
  const [includeFinished, setIncludeFinished] = useState(false);

  useEffect(() => {
    return observeReservations(
      (next) => setSnapshot({ reservations: next, error: null }),
      (caught) => setSnapshot({ reservations: [], error: caught.message }),
    );
  }, []);

  const reservations = snapshot?.reservations ?? null;

  const visible = useMemo(() => {
    if (reservations === null) return null;

    const inScope = includeFinished
      ? reservations
      : reservations.filter((reservation) => !FINISHED.has(reservation.status));

    if (term.trim().length === 0) return inScope;

    return rankMatches(
      term,
      inScope,
      (reservation) =>
        `${reservation.code} ${reservation.customerName} ${reservation.customerNameAr} ${reservation.customerPhone}`,
    );
  }, [reservations, term, includeFinished]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-caps">{t('nav.reservations')}</p>
          <h1 className="display mt-2 text-3xl text-ink-900">{t('reservations.title')}</h1>
        </div>

        {can('reservations.create') && (
          <Link to="/reservations/new" className={buttonClasses()}>
            {t('reservations.new')}
          </Link>
        )}
      </header>

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-ink-100 pb-4">
        <input
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t('reservations.searchPlaceholder')}
          aria-label={t('action.search')}
          className="h-11 min-w-0 flex-1 border-0 border-b border-transparent bg-transparent px-0 text-base text-ink-900 placeholder:text-ink-300 focus:border-gold-500 focus:outline-none"
        />

        <Toggle
          label={t('reservations.showClosed')}
          checked={includeFinished}
          onChange={setIncludeFinished}
        />
      </div>

      {snapshot?.error && (
        <Alert tone="error" className="mt-6">
          {snapshot.error}
        </Alert>
      )}

      {visible === null && <p className="mt-10 text-sm text-ink-400">…</p>}

      {visible !== null && visible.length === 0 && (
        <EmptyState
          title={term.trim().length > 0 ? t('reservations.noResults') : t('reservations.empty')}
          {...(term.trim().length === 0 ? { hint: t('reservations.emptyHint') } : {})}
          action={
            term.trim().length === 0 && can('reservations.create') ? (
              <Link to="/reservations/new" className={buttonClasses()}>
                {t('reservations.new')}
              </Link>
            ) : undefined
          }
        />
      )}

      {visible !== null && visible.length > 0 && (
        <ul className="mt-4 divide-y divide-ink-100">
          {visible.map((reservation) => (
            <li key={reservation.id}>
              <Link
                to={`/reservations/${reservation.id}`}
                className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-1 py-3 hover:bg-sand-50"
              >
                <span className="w-24 shrink-0 font-mono text-2xs text-ink-300">
                  {reservation.code}
                </span>

                <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                  {language === 'ar' && reservation.customerNameAr.length > 0
                    ? reservation.customerNameAr
                    : reservation.customerName}
                </span>

                <span className="numeric shrink-0 text-sm text-ink-600">
                  {formatMuscatDate(reservation.pickupAt, language)} →{' '}
                  {formatMuscatDate(reservation.returnAt, language)}
                </span>

                <span className="numeric shrink-0 text-sm text-ink-600">
                  {formatOmr(reservation.pricing.grandTotal)}
                </span>

                <Badge tone={RESERVATION_STATUS_TONE[reservation.status]}>
                  {t(`status.${reservation.status}`)}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
