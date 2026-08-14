import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Badge } from '@/design-system';
import { useT } from '@/hooks/useT';
import { formatMuscatDate } from '@/domain/datetime';
import { formatOmr, sum, type Baisa } from '@/domain/money';
import { signedAmount } from '@/domain/ledger';
import { observeLiveReservations, type LiveReservation } from '@/services/operations.service';
import { observeFinancialEventsForAll, type DisplayEvent } from '@/services/payments.service';
import { observeUpcomingFittings, type Fitting } from '@/services/fittings.service';
import { RESERVATION_STATUS_TONE } from '@/pages/reservations/status-tone';

/**
 * One customer's history: bookings, money, fittings.
 *
 * Every figure comes from the ledger. "Total spent" is what the boutique
 * actually **kept** — payments less reversals and refunds — not the sum of
 * agreed totals, which would count a cancelled booking as revenue and a
 * refunded one twice. Security deposits are excluded: that money is the
 * customer's, held against damage, and much of it goes back.
 */
export function CustomerHistory({ customerId }: { customerId: string }) {
  const { t, language } = useT();

  const [reservations, setReservations] = useState<LiveReservation[] | null>(null);
  const [events, setEvents] = useState<Map<string, DisplayEvent[]>>(new Map());
  const [fittings, setFittings] = useState<Fitting[]>([]);

  useEffect(() => {
    return observeLiveReservations(setReservations, () => setReservations([]));
  }, []);

  useEffect(() => {
    return observeFinancialEventsForAll(setEvents, () => setEvents(new Map()));
  }, []);

  useEffect(() => {
    return observeUpcomingFittings(setFittings, () => setFittings([]));
  }, []);

  const own = useMemo(
    () =>
      (reservations ?? [])
        .filter((reservation) => reservation.customerId === customerId)
        .sort((a, b) => b.pickupAt - a.pickupAt),
    [reservations, customerId],
  );

  const ownEvents = useMemo(() => {
    const ids = new Set(own.map((reservation) => reservation.id));

    return [...events.entries()]
      .filter(([reservationId]) => ids.has(reservationId))
      .flatMap(([, list]) => list)
      .sort((a, b) => b.occurredAt - a.occurredAt);
  }, [events, own]);

  const money = useMemo(() => {
    const total = (kind: DisplayEvent['kind']): Baisa =>
      sum(ownEvents.filter((event) => event.kind === kind).map((event) => event.amount));

    const gross = total('Payment');
    const reversed = total('PaymentReversal');
    const refunded = total('Refund');

    return {
      spent: (gross - reversed - refunded) as Baisa,
      outstanding: sum(own.map((reservation) => reservation.outstanding)),
      depositsHeld: sum(own.map((reservation) => reservation.depositHeld)),
    };
  }, [ownEvents, own]);

  const ownFittings = useMemo(() => {
    const ids = new Set(own.map((reservation) => reservation.id));

    return fittings
      .filter((fitting) => ids.has(fitting.reservationId))
      .sort((a, b) => b.scheduledAt - a.scheduledAt);
  }, [fittings, own]);

  if (reservations === null) {
    return (
      <section className="mt-10">
        <p className="text-sm text-ink-400" role="status">
          {t('state.loading')}
        </p>
      </section>
    );
  }

  if (own.length === 0) {
    return (
      <section className="mt-10">
        <h2 className="label-caps">{t('nav.reservations')}</h2>
        <p className="mt-3 text-sm text-ink-500">{t('reservations.empty')}</p>
      </section>
    );
  }

  return (
    <>
      <section className="mt-10">
        <h2 className="label-caps">{t('dash.money')}</h2>
        <dl className="mt-3 grid gap-x-8 gap-y-4 sm:grid-cols-3">
          <Figure label={t('reports.netRevenue')} value={formatOmr(money.spent)} />
          <Figure label={t('reports.outstanding')} value={formatOmr(money.outstanding)} />
          <Figure label={t('reports.deposits')} value={formatOmr(money.depositsHeld)} />
        </dl>
        <p className="mt-3 text-2xs text-ink-400">{t('reports.depositsExcluded')}</p>
      </section>

      <section className="mt-10">
        <h2 className="label-caps">{t('nav.reservations')}</h2>
        <ul className="mt-3 divide-y divide-ink-100">
          {own.map((reservation) => (
            <li key={reservation.id}>
              <Link
                to={`/reservations/${reservation.id}`}
                className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 py-3 hover:bg-sand-50"
              >
                <span className="w-24 shrink-0 code text-2xs text-ink-300">
                  {reservation.code}
                </span>
                <span className="numeric min-w-0 flex-1 text-sm text-ink-600">
                  {formatMuscatDate(reservation.pickupAt, language)}
                </span>
                <span className="numeric shrink-0 text-sm text-ink-600">
                  {reservation.outstanding > 0
                    ? formatOmr(reservation.outstanding)
                    : t('reservations.settled')}
                </span>
                <Badge tone={RESERVATION_STATUS_TONE[reservation.status]}>
                  {t(`status.${reservation.status}`)}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {ownFittings.length > 0 && (
        <section className="mt-10">
          <h2 className="label-caps">{t('dash.fittings')}</h2>
          <ul className="mt-3 divide-y divide-ink-100">
            {ownFittings.map((fitting) => (
              <li
                key={fitting.id}
                className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 py-2"
              >
                <span className="numeric min-w-0 flex-1 text-sm text-ink-600">
                  {formatMuscatDate(fitting.scheduledAt, language)}
                </span>
                <span className="shrink-0 text-2xs text-ink-500">
                  {t(`fittingStatus.${fitting.status}`)}
                </span>
                <span className="code text-2xs text-ink-300">{fitting.reservationCode}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {ownEvents.length > 0 && (
        <section className="mt-10">
          <h2 className="label-caps">{t('money.statement')}</h2>
          <ul className="mt-3 divide-y divide-ink-100">
            {ownEvents.map((event) => (
              <li
                key={event.id}
                className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 py-2"
              >
                <span className="numeric w-28 shrink-0 text-sm text-ink-600">
                  {formatMuscatDate(event.occurredAt, language)}
                </span>
                <span className="user-text min-w-0 flex-1 truncate text-sm text-ink-700">
                  {t(`event.${event.kind}`)}
                </span>
                {/*
                 * Reversals and refunds show as negative lines beside what they
                 * cancel. The original stays; the pair nets to zero, which is
                 * what makes a correction legible on a statement.
                 */}
                <span className="numeric shrink-0 text-sm text-ink-900">
                  {formatOmr(signedAmount(event))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs tracking-wide text-ink-400 uppercase">{label}</dt>
      <dd className="numeric mt-1 text-lg text-ink-900">{value}</dd>
    </div>
  );
}
