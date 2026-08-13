/**
 * One reservation, end to end.
 *
 * The screen an employee stands in front of while the bride is at the counter:
 * what was booked, when it is due, what it costs, where it is in its life, and
 * what may happen to it next.
 *
 * Every state-changing control here calls a Cloud Function. The status buttons
 * are drawn from the same transition table the server enforces, so the UI never
 * offers a move the server will refuse — but the server refuses it anyway if
 * the reservation moved underneath us.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Alert, Badge, Button, Field, TextArea, buttonClasses } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import {
  changeReservationStatus,
  observeReservation,
  observeReservationItems,
  ReservationServiceError,
  toInputDateTime,
  updateReservationDates,
  updateReservationNotes,
  type ConflictDetail,
  type Reservation,
  type ReservationItem,
} from '@/services/reservations.service';
import {
  observeFittingsForReservation,
  scheduleFitting,
  type Fitting,
} from '@/services/fittings.service';
import { observeAuditTrail, type AuditEntry } from '@/services/audit.service';
import { allowedTransitionsFrom } from '@/domain/reservation';
import { formatMuscat, formatMuscatDate } from '@/domain/datetime';
import { formatOmr } from '@/domain/money';
import { observePickupThreshold } from '@/services/payments.service';
import { ConflictPanel } from './ConflictPanel';
import { MoneyPanel } from './MoneyPanel';
import { AmendmentsPanel } from './AmendmentsPanel';
import { FITTING_STATUS_TONE, RESERVATION_STATUS_TONE } from './status-tone';

export function ReservationDetailPage() {
  const { reservationId = '' } = useParams();
  const { t, language } = useT();
  const { can, principal, state } = useAuth();

  const actorName = state.status === 'signed-in' ? state.session.name : '';

  const [reservation, setReservation] = useState<Reservation | null | undefined>(undefined);
  const [items, setItems] = useState<ReservationItem[]>([]);
  const [fittings, setFittings] = useState<Fitting[]>([]);
  const [trail, setTrail] = useState<AuditEntry[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<readonly ConflictDetail[]>([]);

  const [editingDates, setEditingDates] = useState(false);
  const [pickupAt, setPickupAt] = useState('');
  const [returnAt, setReturnAt] = useState('');
  const [notes, setNotes] = useState<string | null>(null);

  const [fittingAt, setFittingAt] = useState('');
  const [pickupThreshold, setPickupThreshold] = useState(100);

  useEffect(() => observePickupThreshold(setPickupThreshold, () => setPickupThreshold(100)), []);

  useEffect(
    () =>
      observeReservation(reservationId, setReservation, (caught) => {
        setReservation(null);
        setError(caught.message);
      }),
    [reservationId],
  );

  useEffect(
    () => observeReservationItems(reservationId, setItems, () => setItems([])),
    [reservationId],
  );

  useEffect(
    () => observeFittingsForReservation(reservationId, setFittings, () => setFittings([])),
    [reservationId],
  );

  useEffect(() => observeAuditTrail(reservationId, setTrail, () => setTrail([])), [reservationId]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);

    try {
      await action();
    } catch (caught) {
      setError(
        caught instanceof ReservationServiceError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : 'Something went wrong.',
      );
    } finally {
      setBusy(false);
    }
  }, []);

  if (reservation === undefined) {
    return <main className="mx-auto max-w-3xl px-6 py-10 text-sm text-ink-400">…</main>;
  }

  if (reservation === null) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <Alert tone="error">{error ?? t('error.notFound')}</Alert>
        <Link to="/reservations" className={buttonClasses('ghost', 'md', 'mt-6')}>
          {t('action.back')}
        </Link>
      </main>
    );
  }

  const booking = reservation;
  const nextStatuses = allowedTransitionsFrom(booking.status);
  const notesValue = notes ?? booking.notes;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-caps">{t('reservations.detailTitle')}</p>
          <h1 className="display mt-2 font-mono text-3xl text-ink-900">{booking.code}</h1>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={RESERVATION_STATUS_TONE[booking.status]}>
            {t(`status.${booking.status}`)}
          </Badge>

          {can('invoices.issue') && (
            <Link
              to={`/reservations/${booking.id}/documents`}
              className={buttonClasses('secondary', 'sm')}
            >
              {t('document.issue')}
            </Link>
          )}
        </div>
      </header>

      {error && (
        <Alert tone="error" className="mt-6">
          {error}
        </Alert>
      )}

      <ConflictPanel
        conflicts={conflicts}
        onUseNextFreeDate={(conflict) => {
          if (conflict.availableFrom === null) return;
          const span = booking.returnAt - booking.pickupAt;
          setPickupAt(toInputDateTime(conflict.availableFrom));
          setReturnAt(toInputDateTime(conflict.availableFrom + span));
          setEditingDates(true);
        }}
        onFindAlternative={() => setConflicts([])}
      />

      {/* Customer and dates ------------------------------------------------ */}
      <section className="mt-10 grid gap-6 sm:grid-cols-2">
        <div>
          <p className="label-caps">{t('reservations.customer')}</p>
          <p className="mt-2 text-sm text-ink-900">
            <Link to={`/customers/${booking.customerId}`} className="underline">
              {language === 'ar' && booking.customerNameAr.length > 0
                ? booking.customerNameAr
                : booking.customerName}
            </Link>
          </p>
          <p className="numeric mt-1 text-sm text-ink-600">{booking.customerPhone}</p>
        </div>

        <div>
          <p className="label-caps">{t('reservations.eventDate')}</p>
          <p className="numeric mt-2 text-sm text-ink-900">{booking.eventDate || '—'}</p>
        </div>

        <div>
          <p className="label-caps">{t('reservations.pickup')}</p>
          <p className="numeric mt-2 text-sm text-ink-900">
            {formatMuscat(booking.pickupAt, language)}
          </p>
        </div>

        <div>
          <p className="label-caps">{t('reservations.return')}</p>
          <p className="numeric mt-2 text-sm text-ink-900">
            {formatMuscat(booking.returnAt, language)}
          </p>
        </div>
      </section>

      {can('reservations.edit') && (
        <section className="mt-6">
          {editingDates ? (
            <div className="grid gap-6 sm:grid-cols-2">
              <Field
                label={t('reservations.pickup')}
                type="datetime-local"
                value={pickupAt}
                onChange={(event) => setPickupAt(event.target.value)}
              />

              <Field
                label={t('reservations.return')}
                type="datetime-local"
                value={returnAt}
                onChange={(event) => setReturnAt(event.target.value)}
              />

              <div className="flex gap-3 sm:col-span-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await updateReservationDates({
                        reservationId,
                        pickupAt,
                        returnAt,
                        eventDate: booking.eventDate.length > 0 ? booking.eventDate : null,
                      });

                      if (result.success) {
                        setConflicts([]);
                        setEditingDates(false);
                        return;
                      }

                      // The original dates stand; the server changed nothing.
                      setConflicts(result.conflicts);
                    })
                  }
                >
                  {t('reservations.saveDates')}
                </Button>

                <Button variant="ghost" onClick={() => setEditingDates(false)}>
                  {t('action.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setPickupAt(toInputDateTime(booking.pickupAt));
                setReturnAt(toInputDateTime(booking.returnAt));
                setEditingDates(true);
              }}
            >
              {t('reservations.editDates')}
            </Button>
          )}
        </section>
      )}

      {/* Dresses ----------------------------------------------------------- */}
      <section className="mt-10">
        <h2 className="label-caps">{t('reservations.dresses')}</h2>

        <ul className="mt-3 divide-y divide-ink-100">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
              <Link
                to={`/inventory/${item.dressId}`}
                className="w-20 shrink-0 font-mono text-2xs text-ink-300 underline"
              >
                {item.dressCode}
              </Link>

              <span className="min-w-0 flex-1 truncate text-sm text-ink-900">{item.dressName}</span>

              <span className="text-2xs text-ink-400">
                {t('reservations.blockedUntil')}{' '}
                <span className="numeric">{formatMuscatDate(item.blockEndAt, language)}</span>
              </span>

              <span className="numeric text-sm text-ink-600">
                {formatOmr(item.rentalPriceSnapshot)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* Pricing ----------------------------------------------------------- */}
      <section className="mt-10 border-t border-ink-100 pt-6">
        <dl className="space-y-2 text-sm">
          <Row
            label={t('reservations.rentalPrice')}
            value={formatOmr(booking.pricing.rentalSubtotal)}
          />
          {booking.pricing.discountAmount > 0 && (
            <Row
              label={t('reservations.discount')}
              value={`− ${formatOmr(booking.pricing.discountAmount)}`}
            />
          )}
          <Row
            label={`${t('reservations.vat')} (${booking.pricing.vatRatePercent}%)`}
            value={formatOmr(booking.pricing.vatAmount)}
          />
          <Row
            label={t('reservations.deposit')}
            value={formatOmr(booking.pricing.securityDepositTotal)}
          />
          <Row
            label={t('reservations.grandTotal')}
            value={formatOmr(booking.pricing.grandTotal)}
            emphasis
          />
        </dl>

        <p className="mt-3 text-2xs text-ink-400">{t('reservations.depositNote')}</p>
      </section>

      {/*
       * The money. Separate from the pricing block above deliberately: that one
       * says what was agreed and never changes, this one says what has actually
       * happened since.
       */}
      <MoneyPanel reservation={booking} minPickupPaymentPercent={pickupThreshold} />

      {/*
       * Accessories and alterations. Below the money on purpose: they change
       * what is owed, so the balance they affect should already be on screen.
       */}
      <AmendmentsPanel reservation={booking} />

      {/* Status ------------------------------------------------------------ */}
      {can('reservations.edit') && nextStatuses.length > 0 && (
        <section className="mt-10">
          <h2 className="label-caps">{t('reservations.changeStatus')}</h2>

          <div className="mt-3 flex flex-wrap gap-2">
            {nextStatuses.map((status) => (
              <Button
                key={status}
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void run(() => changeReservationStatus({ reservationId, status }))}
              >
                {t(`status.${status}`)}
              </Button>
            ))}
          </div>
        </section>
      )}

      {/* Fittings ---------------------------------------------------------- */}
      <section className="mt-10">
        <h2 className="label-caps">{t('fittings.title')}</h2>

        {fittings.length === 0 ? (
          <p className="mt-3 text-sm text-ink-400">{t('fittings.none')}</p>
        ) : (
          <ul className="mt-3 divide-y divide-ink-100">
            {fittings.map((fitting) => (
              <li key={fitting.id} className="flex flex-wrap items-center gap-4 py-3">
                <span className="numeric flex-1 text-sm text-ink-900">
                  {formatMuscat(fitting.scheduledAt, language)}
                </span>
                <span className="text-2xs text-ink-400">
                  {fitting.durationMinutes} {t('fittings.duration')}
                </span>
                <Badge tone={FITTING_STATUS_TONE[fitting.status]}>
                  {t(`fittingStatus.${fitting.status}`)}
                </Badge>
              </li>
            ))}
          </ul>
        )}

        {can('fittings.manage') && principal !== null && (
          <div className="mt-4 flex flex-wrap items-end gap-4">
            <Field
              label={t('fittings.scheduledAt')}
              type="datetime-local"
              value={fittingAt}
              onChange={(event) => setFittingAt(event.target.value)}
            />

            <Button
              variant="secondary"
              disabled={busy || fittingAt.length === 0}
              onClick={() =>
                void run(async () => {
                  await scheduleFitting({
                    reservationId,
                    reservationCode: booking.code,
                    customerId: booking.customerId,
                    customerName: booking.customerName,
                    scheduledAt: fittingAt,
                    durationMinutes: 60,
                    notes: '',
                    actor: { uid: principal.uid, name: actorName, role: principal.role },
                  });
                  setFittingAt('');
                })
              }
            >
              {t('fittings.schedule')}
            </Button>
          </div>
        )}

        <p className="mt-3 text-2xs text-ink-400">{t('fittings.noHold')}</p>
      </section>

      {/* Notes ------------------------------------------------------------- */}
      {can('reservations.edit') && principal !== null && (
        <section className="mt-10">
          <TextArea
            label={t('reservations.notes')}
            value={notesValue}
            onChange={(event) => setNotes(event.target.value)}
            onBlur={() => {
              if (notes === null || notes === booking.notes) return;
              void run(() => updateReservationNotes(reservationId, notes, principal.uid));
            }}
            rows={3}
          />
        </section>
      )}

      {/* History ----------------------------------------------------------- */}
      <section className="mt-10 border-t border-ink-100 pt-6">
        <h2 className="label-caps">{t('reservations.timeline')}</h2>

        <ol className="mt-3 space-y-3">
          {trail.map((entry) => (
            <li key={entry.id} className="flex flex-wrap gap-x-4 gap-y-1 text-2xs">
              <span className="numeric w-40 shrink-0 text-ink-400">
                {entry.at === Number.MAX_SAFE_INTEGER ? '…' : formatMuscat(entry.at, language)}
              </span>
              <span className="text-ink-900">{entry.action}</span>
              <span className="text-ink-400">{entry.actorName}</span>
            </li>
          ))}
        </ol>
      </section>

      <Link to="/reservations" className={buttonClasses('ghost', 'md', 'mt-10')}>
        {t('action.back')}
      </Link>
    </main>
  );
}

function Row({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`flex justify-between gap-4 ${emphasis ? 'border-t border-ink-100 pt-2 font-medium text-ink-900' : 'text-ink-600'}`}
    >
      <dt>{label}</dt>
      <dd className="numeric">{value}</dd>
    </div>
  );
}
