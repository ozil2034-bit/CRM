import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Alert, Badge, Button, EmptyState, Field, Select, Toggle, buttonClasses } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { formatMuscatDate, startOfMuscatDay, toMuscatDate } from '@/domain/datetime';
import { formatOmr } from '@/domain/money';
import { rankMatches } from '@/domain/search';
import { RESERVATION_STATUSES, type ReservationStatus } from '@/domain/availability';
import { primaryActionFor } from '@/domain/operations';
import { observeLiveReservations, type LiveReservation } from '@/services/operations.service';
import {
  observeAllReservationItems,
  type ReservationItem,
} from '@/services/reservations.service';
import { RESERVATION_STATUS_TONE } from './status-tone';

/** Bookings that are over, and would otherwise bury the live ones. */
const FINISHED = new Set<ReservationStatus>(['Closed', 'Cancelled', 'No-Show']);

type Grouping = 'date' | 'dress';

/**
 * The reservations workspace.
 *
 * A working list rather than a table dump: every row carries the two things an
 * employee actually needs — what is still owed, and what to do next — so the
 * common question is answered without opening anything.
 *
 * The balance comes from the ledger through `observeLiveReservations`. Nothing
 * on this screen computes money.
 */
export function ReservationsPage() {
  const { t, language } = useT();
  const { can } = useAuth();

  const [snapshot, setSnapshot] = useState<{
    reservations: LiveReservation[];
    error: string | null;
  } | null>(null);
  const [items, setItems] = useState<ReservationItem[]>([]);

  const [term, setTerm] = useState('');
  const [includeFinished, setIncludeFinished] = useState(false);
  const [status, setStatus] = useState<ReservationStatus | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [grouping, setGrouping] = useState<Grouping>('date');

  useEffect(() => {
    return observeLiveReservations(
      (next) => setSnapshot({ reservations: next, error: null }),
      (caught) => setSnapshot({ reservations: [], error: caught.message }),
    );
  }, []);

  useEffect(() => {
    return observeAllReservationItems(setItems, () => setItems([]));
  }, []);

  const reservations = snapshot?.reservations ?? null;

  const dressesFor = useMemo(() => {
    const byReservation = new Map<string, ReservationItem[]>();

    for (const item of items) {
      const bucket = byReservation.get(item.reservationId);
      if (bucket === undefined) byReservation.set(item.reservationId, [item]);
      else bucket.push(item);
    }

    return byReservation;
  }, [items]);

  const filtersActive =
    term.trim().length > 0 || status !== '' || from !== '' || to !== '' || includeFinished;

  const visible = useMemo(() => {
    if (reservations === null) return null;

    let inScope = includeFinished
      ? reservations
      : reservations.filter((reservation) => !FINISHED.has(reservation.status));

    if (status !== '') {
      inScope = inScope.filter((reservation) => reservation.status === status);
    }

    /*
     * The range is inclusive of both ends, on Muscat calendar days, and matched
     * against the pickup. An employee asking for "10–14 September" means the
     * days they would write on a calendar, not a half-open interval.
     */
    if (from !== '') {
      const start = startOfMuscatDay(from);
      inScope = inScope.filter((reservation) => reservation.pickupAt >= start);
    }

    if (to !== '') {
      const end = startOfMuscatDay(to) + 24 * 60 * 60 * 1000;
      inScope = inScope.filter((reservation) => reservation.pickupAt < end);
    }

    if (term.trim().length === 0) return inScope;

    return rankMatches(term, inScope, (reservation) => {
      const gowns = (dressesFor.get(reservation.id) ?? [])
        .map((item) => `${item.dressCode} ${item.dressName}`)
        .join(' ');

      return `${reservation.code} ${reservation.customerName} ${reservation.customerNameAr} ${reservation.customerPhone} ${gowns}`;
    });
  }, [reservations, term, includeFinished, status, from, to, dressesFor]);

  const grouped = useMemo(() => {
    if (visible === null) return null;

    if (grouping === 'date') {
      return groupBy(visible, (row) => toMuscatDate(row.pickupAt)).sort((a, b) =>
        a.key.localeCompare(b.key),
      );
    }

    // By dress: a booking with two gowns appears under each, which is what
    // "show me everything this dress is committed to" means.
    const byDress: { key: string; rows: LiveReservation[] }[] = [];
    const index = new Map<string, LiveReservation[]>();

    for (const row of visible) {
      for (const item of dressesFor.get(row.id) ?? []) {
        const key = `${item.dressCode} · ${item.dressName}`;
        const bucket = index.get(key);
        if (bucket === undefined) index.set(key, [row]);
        else bucket.push(row);
      }
    }

    for (const [key, rows] of index) byDress.push({ key, rows });

    return byDress.sort((a, b) => a.key.localeCompare(b.key));
  }, [visible, grouping, dressesFor]);

  function clearFilters(): void {
    setTerm('');
    setStatus('');
    setFrom('');
    setTo('');
    setIncludeFinished(false);
  }

  return (
    <main className="mx-auto max-w-5xl px-5 py-8 sm:px-6 sm:py-10">
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

      <div className="mt-8 space-y-4 border-b border-ink-100 pb-4">
        <input
          type="search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t('reservations.searchPlaceholder')}
          aria-label={t('action.search')}
          className="h-11 w-full border-0 border-b border-transparent bg-transparent px-0 text-base text-ink-900 placeholder:text-ink-300 focus:border-gold-500 focus:outline-none"
        />

        <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
          <Select
            label={t('reservations.filterStatus')}
            value={status}
            onChange={(event) => setStatus(event.target.value as ReservationStatus | '')}
            options={[
              { value: '', label: t('reservations.filterAll') },
              ...RESERVATION_STATUSES.map((value) => ({
                value,
                label: t(`status.${value}`),
              })),
            ]}
            className="w-40"
          />

          <Field
            label={t('reservations.filterFrom')}
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="w-40"
          />

          <Field
            label={t('reservations.filterTo')}
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="w-40"
          />

          <Toggle
            label={t('reservations.showClosed')}
            checked={includeFinished}
            onChange={setIncludeFinished}
          />

          {filtersActive && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              {t('reservations.clearFilters')}
            </Button>
          )}
        </div>

        <div role="tablist" aria-label={t('reservations.filters')} className="flex gap-1">
          {(['date', 'dress'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={grouping === option}
              onClick={() => setGrouping(option)}
              className={
                grouping === option
                  ? 'min-h-11 rounded-xs px-3 text-sm text-ink-900'
                  : 'min-h-11 rounded-xs px-3 text-sm text-ink-400 hover:text-ink-900'
              }
            >
              {option === 'date' ? t('reservations.byDate') : t('reservations.byDress')}
            </button>
          ))}
        </div>
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
          title={filtersActive ? t('reservations.noneMatch') : t('reservations.empty')}
          {...(filtersActive ? {} : { hint: t('reservations.emptyHint') })}
          action={
            filtersActive ? (
              <Button variant="secondary" onClick={clearFilters}>
                {t('reservations.clearFilters')}
              </Button>
            ) : can('reservations.create') ? (
              <Link to="/reservations/new" className={buttonClasses()}>
                {t('reservations.new')}
              </Link>
            ) : undefined
          }
        />
      )}

      {grouped !== null && grouped.length > 0 && (
        <div className="mt-6 space-y-8">
          {grouped.map((group) => (
            <section key={group.key}>
              <h2 className="text-2xs tracking-wide text-ink-400 uppercase">
                {grouping === 'date'
                  ? formatMuscatDate(startOfMuscatDay(group.key), language)
                  : group.key}
              </h2>

              <ul className="mt-2 divide-y divide-ink-100">
                {group.rows.map((reservation) => (
                  <li key={`${group.key}-${reservation.id}`}>
                    <Link
                      to={`/reservations/${reservation.id}`}
                      className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-1 py-3 hover:bg-sand-50"
                    >
                      <span className="w-24 shrink-0 code text-2xs text-ink-300">
                        {reservation.code}
                      </span>

                      <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                        {language === 'ar' && reservation.customerNameAr.length > 0
                          ? reservation.customerNameAr
                          : reservation.customerName}
                      </span>

                      {/* What is still owed — from the ledger, not from pricing. */}
                      <span className="numeric w-24 shrink-0 text-end text-sm text-ink-600">
                        {reservation.outstanding > 0
                          ? formatOmr(reservation.outstanding)
                          : t('reservations.settled')}
                      </span>

                      {/* What to do next, named rather than implied. */}
                      <span className="w-28 shrink-0 text-2xs text-gold-700">
                        {t(`op.${primaryActionFor(reservation.status)}`)}
                      </span>

                      <Badge tone={RESERVATION_STATUS_TONE[reservation.status]}>
                        {t(`status.${reservation.status}`)}
                      </Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): { key: string; rows: T[] }[] {
  const index = new Map<string, T[]>();

  for (const row of rows) {
    const bucket = index.get(key(row));
    if (bucket === undefined) index.set(key(row), [row]);
    else bucket.push(row);
  }

  return [...index].map(([groupKey, groupRows]) => ({ key: groupKey, rows: groupRows }));
}
