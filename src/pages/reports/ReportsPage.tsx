import { useEffect, useMemo, useState } from 'react';

import { Alert, Button, Select } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { formatOmr, type Baisa } from '@/domain/money';
import { monthOf, nextMonth, previousMonth, startOfMonth } from '@/domain/calendar';
import {
  summarise,
  totalDepositsHeld,
  totalOutstanding,
  type Period,
} from '@/domain/financial-reporting';
import {
  ancillaryRevenue,
  cancellationCounts,
  revenueByDress,
  topRented,
  type RentedLine,
  type ReportedReservation,
} from '@/domain/operational-reporting';
import {
  averageUtilization,
  computeUtilization,
  type DressUtilization,
} from '@/domain/utilization';
import { observeLiveReservations, type LiveReservation } from '@/services/operations.service';
import { observeFinancialEventsForAll, type DisplayEvent } from '@/services/payments.service';
import {
  observeAllReservationItems,
  type ReservationItem,
} from '@/services/reservations.service';
import { observeDresses, type Dress } from '@/services/dresses.service';

/**
 * Reports.
 *
 * Every money figure on this page comes from the ledger through
 * `summarise()` and `reduceLedger()`. None is derived from a reservation's
 * status, from a dress's current price, or from a total shown on a card
 * elsewhere in the interface.
 *
 * Security deposits are excluded from revenue throughout and shown in their own
 * line. A deposit is the customer's money held against damage; counting it as
 * income would overstate what the boutique earned and understate what it owes
 * back.
 *
 * Where a figure cannot be computed the page prints **N/A**, not zero.
 */
export function ReportsPage() {
  const { t } = useT();
  const { can } = useAuth();

  const [month, setMonth] = useState(() => monthOf(Date.now()));
  const [reservations, setReservations] = useState<LiveReservation[] | null>(null);
  const [events, setEvents] = useState<DisplayEvent[]>([]);
  const [items, setItems] = useState<ReservationItem[]>([]);
  const [dresses, setDresses] = useState<Dress[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return observeLiveReservations(setReservations, (caught) => {
      setReservations([]);
      setError(caught.message);
    });
  }, []);

  useEffect(() => {
    return observeFinancialEventsForAll(
      (grouped) => setEvents([...grouped.values()].flat()),
      () => setEvents([]),
    );
  }, []);

  useEffect(() => {
    return observeAllReservationItems(setItems, () => setItems([]));
  }, []);

  useEffect(() => {
    /*
     * Retired gowns are included: they may have earned during the period, and
     * the utilisation table reports them as N/A rather than silently omitting
     * stock the owner still remembers buying.
     */
    return observeDresses({ includeRetired: true }, setDresses, () => setDresses([]));
  }, []);

  /** The revenue view of an item: which dress, at what agreed price. */
  const lines: RentedLine[] = useMemo(
    () =>
      items.map((item) => ({
        reservationId: item.reservationId,
        dressId: item.dressId,
        dressCode: item.dressCode,
        dressName: item.dressName,
        rentalPriceSnapshot: item.rentalPriceSnapshot,
        pickupAt: item.pickupAt,
      })),
    [items],
  );

  const period: Period = useMemo(
    () => ({ from: startOfMonth(month), to: startOfMonth(nextMonth(month)) }),
    [month],
  );

  const summary = useMemo(() => summarise(events, period), [events, period]);

  /** Per-booking net collection **within the period**, from the ledger alone. */
  const reported: ReportedReservation[] = useMemo(() => {
    if (reservations === null) return [];

    const byReservation = new Map<string, DisplayEvent[]>();
    for (const event of events) {
      const bucket = byReservation.get(event.reservationId);
      if (bucket === undefined) byReservation.set(event.reservationId, [event]);
      else bucket.push(event);
    }

    return reservations.map((row) => {
      const own = (byReservation.get(row.id) ?? []).filter(
        (event) => event.occurredAt >= period.from && event.occurredAt < period.to,
      );

      const total = (kind: DisplayEvent['kind']) =>
        own.filter((event) => event.kind === kind).reduce((running, e) => running + e.amount, 0);

      return {
        id: row.id,
        code: row.code,
        status: row.status,
        pickupAt: row.pickupAt,
        // Deposits are deliberately absent: they are not revenue.
        netCollected: (total('Payment') - total('PaymentReversal') - total('Refund')) as Baisa,
        accessorySubtotal: row.reservation.pricing.accessorySubtotal,
        alterationSubtotal: row.reservation.pricing.alterationSubtotal,
      };
    });
  }, [reservations, events, period]);

  const byDress = useMemo(
    () => revenueByDress({ reservations: reported, lines, period }),
    [reported, lines, period],
  );

  const cancellations = useMemo(
    () => cancellationCounts(reported, period),
    [reported, period],
  );

  const ancillary = useMemo(() => ancillaryRevenue(reported, period), [reported, period]);

  const outstandingRows = useMemo(
    () =>
      (reservations ?? []).map((row) => ({
        reservationId: row.id,
        reservationCode: row.code,
        customerId: row.customerId,
        outstanding: row.outstanding,
        depositHeld: row.depositHeld,
      })),
    [reservations],
  );

  const utilization: DressUtilization[] = useMemo(
    () =>
      dresses.map((dress) => ({
        dressId: dress.id,
        dressCode: dress.code,
        dressName: dress.name,
        result: computeUtilization({
          period,
          /*
           * The stored blocked interval is the authority — rental plus cleaning
           * buffer, exactly as the availability engine computed it at booking.
           * Recomputing a buffer here would be a second implementation of the
           * rule that decides double-booking.
           */
          spans: items
            .filter((item) => item.dressId === dress.id)
            .map((item) => ({
              blockStartAt: item.blockStartAt,
              blockEndAt: item.blockEndAt,
              blocking: item.blocking,
            })),
          /*
           * A dress with no recorded acquisition date is measured over the whole
           * period. Guessing a later one would fabricate an N/A; guessing an
           * earlier one changes nothing.
           */
          availableFrom: dress.createdAt > 0 ? dress.createdAt : period.from,
          /*
           * A retired gown has no operating days left, so it reports N/A rather
           * than 0% — it was not idle, it was gone.
           */
          retiredAt: dress.status === 'Retired' ? period.from : null,
        }),
      })),
    [dresses, items, period],
  );

  const loading = reservations === null;

  return (
    <main className="mx-auto max-w-5xl px-5 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-caps">{t('nav.reports')}</p>
          <h1 className="display mt-2 text-3xl text-ink-900">{t('reports.title')}</h1>
        </div>

        <div className="flex items-end gap-2 print:hidden">
          <Button variant="ghost" size="sm" onClick={() => setMonth(previousMonth(month))}>
            {t('calendar.previous')}
          </Button>
          <Select
            label={t('reports.period')}
            value={month}
            onChange={(event) => setMonth(event.target.value)}
            options={monthOptions(month)}
            className="w-40"
          />
          <Button variant="ghost" size="sm" onClick={() => setMonth(nextMonth(month))}>
            {t('calendar.next')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => window.print()}>
            {t('reports.print')}
          </Button>
        </div>
      </header>

      {error !== null && (
        <Alert tone="error" className="mt-6">
          {error}
        </Alert>
      )}

      {loading && (
        <p className="mt-10 text-sm text-ink-400" role="status">
          {t('state.loading')}
        </p>
      )}

      {!loading && can('reports.financial') && (
        <Block title={t('reports.revenue')}>
          {summary.eventCount === 0 ? (
            <Quiet>{t('reports.noData')}</Quiet>
          ) : (
            <>
              <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-3">
                <Figure
                  label={t('reports.grossCollected')}
                  value={formatOmr(summary.grossCollected)}
                />
                <Figure label={t('reports.refunded')} value={formatOmr(summary.refunded)} />
                <Figure
                  label={t('reports.netRevenue')}
                  value={formatOmr(summary.netCollected)}
                  emphasis
                />
              </dl>

              <dl className="mt-6 grid gap-x-8 gap-y-5 sm:grid-cols-3">
                <Figure
                  label={t('reports.deposits')}
                  value={formatOmr(summary.depositsNet)}
                />
                <Figure label={t('reports.lateFees')} value={formatOmr(summary.lateFeesCharged)} />
                <Figure label={t('reports.waived')} value={formatOmr(summary.chargesWaived)} />
              </dl>

              <p className="mt-4 text-2xs text-ink-400">{t('reports.depositsExcluded')}</p>
            </>
          )}
        </Block>
      )}

      {!loading && (
        <Block title={t('reports.outstanding')}>
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            <Figure
              label={t('reports.outstanding')}
              value={formatOmr(totalOutstanding(outstandingRows))}
            />
            <Figure
              label={t('reports.deposits')}
              value={formatOmr(totalDepositsHeld(outstandingRows))}
            />
          </dl>
        </Block>
      )}

      {!loading && (
        <Block title={t('reports.revenueByDress')}>
          {byDress.length === 0 ? (
            <Quiet>{t('reports.noData')}</Quiet>
          ) : (
            <Table
              head={[t('reports.dress'), t('reports.rentals'), t('reports.revenue')]}
              rows={byDress.map((row) => [
                `${row.dressCode} · ${row.dressName}`,
                String(row.rentals),
                formatOmr(row.revenue),
              ])}
            />
          )}
        </Block>
      )}

      {!loading && (
        <Block title={t('reports.topRented')}>
          {topRented(byDress).length === 0 ? (
            <Quiet>{t('reports.noData')}</Quiet>
          ) : (
            <Table
              head={[t('reports.dress'), t('reports.rentals')]}
              rows={topRented(byDress).map((row) => [
                `${row.dressCode} · ${row.dressName}`,
                String(row.rentals),
              ])}
            />
          )}
        </Block>
      )}

      {!loading && (
        <Block title={t('reports.utilization')}>
          <p className="text-2xs text-ink-400">{t('reports.utilizationFormula')}</p>

          {utilization.length === 0 ? (
            <Quiet>{t('reports.noData')}</Quiet>
          ) : (
            <>
              <p className="numeric mt-4 text-lg text-ink-900">
                {formatPercent(averageUtilization(utilization), t('reports.notApplicable'))}
              </p>
              <Table
                className="mt-4"
                head={[t('reports.dress'), t('reports.utilization')]}
                rows={utilization.map((row) => [
                  `${row.dressCode} · ${row.dressName}`,
                  formatPercent(row.result.percent, t('reports.notApplicable')),
                ])}
              />
            </>
          )}
        </Block>
      )}

      {!loading && (
        <Block title={t('reports.cancellations')}>
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-3">
            <Figure label={t('reports.cancelled')} value={String(cancellations.cancelled)} />
            <Figure label={t('reports.noShow')} value={String(cancellations.noShow)} />
            <Figure
              label={t('reports.rate')}
              value={formatPercent(cancellations.ratePercent, t('reports.notApplicable'))}
            />
          </dl>
        </Block>
      )}

      {!loading && (
        <Block title={t('reports.accessoryRevenue')}>
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-3">
            <Figure label={t('amend.accessories')} value={formatOmr(ancillary.accessories)} />
            <Figure label={t('amend.alterations')} value={formatOmr(ancillary.alterations)} />
            <Figure label={t('reports.revenue')} value={formatOmr(ancillary.total)} emphasis />
          </dl>
        </Block>
      )}
    </main>
  );
}

/* ------------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------------ */

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-12 break-inside-avoid">
      <h2 className="label-caps">{title}</h2>
      <hr className="rule-gold mt-3 w-12" />
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Figure({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-2xs tracking-wide text-ink-400 uppercase">{label}</dt>
      <dd className={emphasis ? 'numeric mt-1 text-xl text-ink-900' : 'numeric mt-1 text-lg text-ink-700'}>
        {value}
      </dd>
    </div>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-ink-500">{children}</p>;
}

function Table({
  head,
  rows,
  className,
}: {
  head: readonly string[];
  rows: readonly (readonly string[])[];
  className?: string;
}) {
  return (
    // Wide tables scroll inside their own box; the page never scrolls sideways.
    <div className={`overflow-x-auto ${className ?? ''}`}>
      <table className="w-full min-w-96 text-sm">
        <thead>
          <tr className="border-b border-ink-200">
            {head.map((cell, index) => (
              <th
                key={cell}
                scope="col"
                className={
                  index === 0
                    ? 'py-2 text-start text-2xs tracking-wide text-ink-400 uppercase'
                    : 'py-2 text-end text-2xs tracking-wide text-ink-400 uppercase'
                }
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]} className="border-b border-ink-100">
              {row.map((cell, index) => (
                <td
                  key={`${row[0] ?? ''}-${String(index)}`}
                  className={index === 0 ? 'py-2 text-ink-900' : 'numeric py-2 text-end text-ink-600'}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A percentage, or N/A.
 *
 * `null` means the question does not apply. Printing 0% instead would be a
 * judgement about a gown that had no chance to be rented.
 */
function formatPercent(percent: number | null, notApplicable: string): string {
  return percent === null ? notApplicable : `${String(percent)}%`;
}

/** The last twelve months plus the selected one, so the list is never empty. */
function monthOptions(selected: string): { value: string; label: string }[] {
  const options: string[] = [];
  let cursor = monthOf(Date.now());

  for (let index = 0; index < 12; index += 1) {
    options.push(cursor);
    cursor = previousMonth(cursor);
  }

  if (!options.includes(selected)) options.unshift(selected);

  return options.map((value) => ({ value, label: value }));
}
