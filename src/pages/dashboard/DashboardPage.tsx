import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Alert, Badge, EmptyState, buttonClasses } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { formatMuscatDate, toMuscatTime } from '@/domain/datetime';
import { formatOmr, sum } from '@/domain/money';
import {
  alertsFor,
  dayOperations,
  daysOverdue,
  primaryActionFor,
  upcomingPickups,
  type OperationalFitting,
  type OperationalReservation,
} from '@/domain/operations';
import { observeLiveReservations, type LiveReservation } from '@/services/operations.service';
import { observeUpcomingFittings } from '@/services/fittings.service';
import { observePickupThreshold } from '@/services/payments.service';
import { RESERVATION_STATUS_TONE } from '@/pages/reservations/status-tone';

/**
 * The employee dashboard.
 *
 * Ordered by what somebody standing behind a counter at 09:00 needs, not by
 * what is easiest to compute: **today's work first**, then what has gone wrong,
 * then what is coming, and only then any money. There is deliberately no row of
 * KPI cards at the top — a dashboard that opens with twelve numbers is a
 * dashboard whose first screen answers no question anybody asked.
 *
 * Every figure comes from the ledger through `reduceLedger`. Nothing here
 * computes money, and nothing renders unless the boutique actually recorded it:
 * with no data the screen says so rather than showing zeroes that look like
 * measurements.
 */
export interface DashboardPageProps {
  /**
   * Shown as a badge when false.
   *
   * An employee looking at a screen full of real-looking bookings should be
   * able to tell at a glance whether they are the boutique's actual records.
   */
  readonly isProduction: boolean;
}

export function DashboardPage({ isProduction }: DashboardPageProps) {
  const { t, language } = useT();
  const { can, state } = useAuth();
  const name = state.status === 'signed-in' ? state.session.name : '';

  const [snapshot, setSnapshot] = useState<{
    reservations: LiveReservation[];
    error: string | null;
  } | null>(null);
  const [fittings, setFittings] = useState<OperationalFitting[]>([]);
  const [threshold, setThreshold] = useState(0);

  /*
   * `now` is captured once per mount rather than ticking. A dashboard that
   * silently reclassifies a row from "today" to "overdue" while an employee is
   * reading it is worse than one that is a few hours stale; the page is
   * revisited many times a day.
   */
  const [now] = useState(() => Date.now());

  useEffect(() => {
    return observeLiveReservations(
      (next) => setSnapshot({ reservations: next, error: null }),
      (caught) => setSnapshot({ reservations: [], error: caught.message }),
    );
  }, []);

  useEffect(() => {
    return observeUpcomingFittings(
      (next) =>
        setFittings(
          next.map((fitting) => ({
            id: fitting.id,
            reservationId: fitting.reservationId,
            reservationCode: fitting.reservationCode,
            customerName: fitting.customerName,
            scheduledAt: fitting.scheduledAt,
            status: fitting.status,
          })),
        ),
      () => setFittings([]),
    );
  }, []);

  useEffect(() => {
    return observePickupThreshold(setThreshold, () => setThreshold(0));
  }, []);

  const reservations = snapshot?.reservations ?? null;

  const day = useMemo(
    () =>
      reservations === null
        ? null
        : dayOperations({
            reservations,
            fittings,
            now,
            minPickupPaymentPercent: threshold,
          }),
    [reservations, fittings, now, threshold],
  );

  const alerts = useMemo(
    () =>
      reservations === null
        ? []
        : alertsFor({ reservations, now, minPickupPaymentPercent: threshold }),
    [reservations, now, threshold],
  );

  const upcoming = useMemo(
    () =>
      reservations === null
        ? []
        : upcomingPickups({ reservations, now, days: 7, limit: 8 }),
    [reservations, now],
  );

  const money = useMemo(() => {
    if (reservations === null) return null;

    /*
     * A plain sum of what the ledger already computed per booking. `sum` keeps
     * it in integer baisa; no second calculation happens here, and security
     * deposits stay apart from what is owed because they are not revenue and
     * never settle a rental.
     */
    return {
      outstanding: sum(reservations.map((row) => row.outstanding)),
      depositsHeld: sum(reservations.map((row) => row.depositHeld)),
      owing: reservations.filter((row) => row.outstanding > 0).length,
    };
  }, [reservations]);

  return (
    <main className="mx-auto max-w-5xl px-5 py-8 sm:px-6 sm:py-10">
      <header>
        <p className="label-caps">{greetingKey(now, t)}</p>
        <h1 className="display mt-2 text-3xl text-ink-900 sm:text-4xl">{name}</h1>
        {!isProduction && (
          <p className="mt-3">
            <Badge tone="neutral">Development</Badge>
          </p>
        )}
      </header>

      {snapshot?.error !== null && snapshot?.error !== undefined && (
        <Alert tone="error" className="mt-8">
          {snapshot.error}
        </Alert>
      )}

      {reservations === null && (
        <p className="mt-10 text-sm text-ink-400" role="status">
          {t('state.loading')}
        </p>
      )}

      {reservations !== null && reservations.length === 0 && (
        <EmptyState
          className="mt-6"
          title={t('dash.emptyBoutique')}
          hint={t('dash.emptyBoutiqueHint')}
          action={
            can('reservations.create') ? (
              <Link to="/reservations/new" className={buttonClasses()}>
                {t('dash.newReservation')}
              </Link>
            ) : undefined
          }
        />
      )}

      {reservations !== null && reservations.length > 0 && day !== null && (
        <>
          {/* ---- 1. Today ---- */}
          <Section title={t('dash.today')}>
            {day.isEmpty ? (
              <Quiet title={t('dash.todayEmpty')} hint={t('dash.todayEmptyHint')} />
            ) : (
              <div className="space-y-8">
                <Group title={t('dash.pickups')} count={day.pickups.length}>
                  {day.pickups.map((row) => (
                    <OperationRow key={row.id} row={row} at={row.pickupAt} />
                  ))}
                </Group>

                <Group title={t('dash.returns')} count={day.returns.length}>
                  {day.returns.map((row) => (
                    <OperationRow key={row.id} row={row} at={row.returnAt} />
                  ))}
                </Group>

                <Group title={t('dash.fittings')} count={day.fittings.length}>
                  {day.fittings.map((fitting) => (
                    <li key={fitting.id}>
                      <Link
                        to={`/reservations/${fitting.reservationId}`}
                        className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 py-2 hover:bg-sand-50"
                      >
                        <span className="numeric w-14 shrink-0 text-sm text-ink-600">
                          {toMuscatTime(fitting.scheduledAt)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                          {fitting.customerName}
                        </span>
                        <span className="code text-2xs text-ink-300">
                          {fitting.reservationCode}
                        </span>
                      </Link>
                    </li>
                  ))}
                </Group>
              </div>
            )}
          </Section>

          {/* ---- 2. What has gone wrong ---- */}
          <Section title={t('dash.alerts')}>
            {alerts.length === 0 ? (
              <Quiet title={t('dash.noAlerts')} />
            ) : (
              <ul className="divide-y divide-ink-100">
                {alerts.map((alert) => {
                  const row = reservations.find((entry) => entry.id === alert.reservationId);
                  const late = row === undefined ? 0 : daysOverdue(row, now);

                  return (
                    <li key={`${alert.kind}-${alert.reservationId}`}>
                      <Link
                        to={`/reservations/${alert.reservationId}`}
                        className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-3 hover:bg-sand-50"
                      >
                        {/*
                         * A word, not only a colour. Status must never be
                         * conveyed by colour alone — a colour-blind employee
                         * reads exactly the same information here.
                         */}
                        <Badge tone={alert.kind === 'eventTomorrow' ? 'neutral' : 'danger'}>
                          {t(`alert.${alert.kind}`)}
                        </Badge>

                        <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                          {alert.customerName}
                        </span>

                        {alert.kind === 'overdueReturn' && late > 0 && (
                          <span className="numeric shrink-0 text-sm text-ink-600">
                            {late} {t(late === 1 ? 'alert.dayLate' : 'alert.daysLate')}
                          </span>
                        )}

                        <span className="code text-2xs text-ink-300">
                          {alert.reservationCode}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          {/* ---- 3. What is coming ---- */}
          <Section title={t('dash.upcoming')}>
            {upcoming.length === 0 ? (
              <Quiet title={t('dash.upcomingEmpty')} />
            ) : (
              <ul className="divide-y divide-ink-100">
                {upcoming.map((row) => (
                  <li key={row.id}>
                    <Link
                      to={`/reservations/${row.id}`}
                      className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 py-3 hover:bg-sand-50"
                    >
                      <span className="numeric w-28 shrink-0 text-sm text-ink-600">
                        {formatMuscatDate(row.pickupAt, language)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
                        {language === 'ar' && row.customerNameAr.length > 0
                          ? row.customerNameAr
                          : row.customerName}
                      </span>
                      <Badge tone={RESERVATION_STATUS_TONE[row.status]}>
                        {t(`status.${row.status}`)}
                      </Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* ---- 4. Money, last, and only what the ledger says ---- */}
          {can('payments.view') && money !== null && (
            <Section title={t('dash.money')}>
              <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-3">
                <Figure label={t('reports.outstanding')} value={formatOmr(money.outstanding)} />
                <Figure label={t('reports.deposits')} value={formatOmr(money.depositsHeld)} />
                <Figure
                  label={t('reservations.balance')}
                  value={`${String(money.owing)} / ${String(reservations.length)}`}
                />
              </dl>
              <p className="mt-4 text-2xs text-ink-400">{t('reports.depositsExcluded')}</p>
            </Section>
          )}
        </>
      )}

      {/* ---- Quick actions, always available ---- */}
      <Section title={t('dash.quickActions')}>
        <div className="flex flex-wrap gap-3">
          {can('reservations.create') && (
            <Link to="/reservations/new" className={buttonClasses('primary', 'sm')}>
              {t('dash.newReservation')}
            </Link>
          )}
          {can('customers.create') && (
            <Link to="/customers/new" className={buttonClasses('secondary', 'sm')}>
              {t('dash.addCustomer')}
            </Link>
          )}
          {can('dresses.create') && (
            <Link to="/inventory/new" className={buttonClasses('secondary', 'sm')}>
              {t('dash.addDress')}
            </Link>
          )}
          <Link to="/calendar" className={buttonClasses('ghost', 'sm')}>
            {t('dash.openCalendar')}
          </Link>
        </div>
      </Section>
    </main>
  );
}

/* ------------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="label-caps">{title}</h2>
      <hr className="rule-gold mt-3 w-12" />
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** A sub-list that renders nothing at all when it is empty. */
function Group({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;

  return (
    <div>
      <h3 className="text-2xs tracking-wide text-ink-400 uppercase">
        {title} · {count}
      </h3>
      <ul className="mt-2 divide-y divide-ink-100">{children}</ul>
    </div>
  );
}

function OperationRow({ row, at }: { row: OperationalReservation; at: number }) {
  const { t, language } = useT();
  const action = primaryActionFor(row.status);

  return (
    <li>
      <Link
        to={`/reservations/${row.id}`}
        className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 py-2 hover:bg-sand-50"
      >
        <span className="numeric w-14 shrink-0 text-sm text-ink-600">{toMuscatTime(at)}</span>

        <span className="min-w-0 flex-1 truncate text-sm text-ink-900">
          {language === 'ar' && row.customerNameAr.length > 0
            ? row.customerNameAr
            : row.customerName}
        </span>

        {row.outstanding > 0 && (
          <span className="numeric shrink-0 text-sm text-ink-600">{formatOmr(row.outstanding)}</span>
        )}

        {/* The next thing to do, named. */}
        <span className="shrink-0 text-2xs text-gold-700">{t(`op.${action}`)}</span>

        <span className="code text-2xs text-ink-300">{row.code}</span>
      </Link>
    </li>
  );
}

function Quiet({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="py-6">
      <p className="text-sm text-ink-500">{title}</p>
      {hint !== undefined && <p className="mt-1 text-2xs text-ink-400">{hint}</p>}
    </div>
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

/**
 * The greeting, from the hour in Muscat.
 *
 * Specification §39: the dashboard opens with a greeting, not a KPI row.
 */
function greetingKey(now: number, t: (key: 'dash.greeting.morning' | 'dash.greeting.afternoon' | 'dash.greeting.evening') => string): string {
  const hour = Number(toMuscatTime(now).slice(0, 2));

  if (hour < 12) return t('dash.greeting.morning');
  if (hour < 17) return t('dash.greeting.afternoon');
  return t('dash.greeting.evening');
}
