/**
 * The money on one reservation.
 *
 * Everything an employee needs at the counter: what is owed, what is held,
 * where the deposit stands, and every event that got it there. The figures come
 * from `reduceLedger` — the same function the server runs — so what is read to
 * a customer is what the server will enforce when the payment is posted.
 *
 * The deposit is shown in its own block, never folded into the rental balance.
 * A bride who has paid a deposit and nothing else owes the full rental, and the
 * screen has to say so plainly or an employee will hand over a dress.
 */

import { useCallback, useEffect, useState } from 'react';

import { Alert, Badge, Button, Field, Select, TextArea } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import {
  cancelReservationFinancially,
  newIdempotencyKey,
  observeFinancialEvents,
  positionOf,
  postLateFee,
  quoteCancellation,
  recordPayment,
  recordSecurityDeposit,
  refundPayment,
  reversePayment,
  settleDeposit,
  PaymentServiceError,
  type CancellationQuoteResult,
  type DisplayEvent,
} from '@/services/payments.service';
import {
  PAYMENT_METHODS,
  PAYMENT_TYPES,
  pickupEligibility,
  signedAmount,
  type PaymentMethod,
  type PaymentType,
} from '@/domain/ledger';
import { formatMuscat, toMuscatWallTime } from '@/domain/datetime';
import { baisa, formatOmr, type Baisa } from '@/domain/money';
import type { Reservation } from '@/services/reservations.service';
import { MoneyField } from '@/components/MoneyField';

/** Which action form is open. Only one at a time — this is a counter, not a form. */
type OpenForm =
  | 'none'
  | 'payment'
  | 'deposit'
  | 'refund'
  | 'returnDeposit'
  | 'keepDeposit'
  | 'lateFee'
  | 'cancel';

export interface MoneyPanelProps {
  readonly reservation: Reservation;
  readonly minPickupPaymentPercent: number;
}

export function MoneyPanel({ reservation, minPickupPaymentPercent }: MoneyPanelProps) {
  const { t, language } = useT();
  const { isOwner } = useAuth();

  const [events, setEvents] = useState<DisplayEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<OpenForm>('none');

  useEffect(
    () =>
      observeFinancialEvents(reservation.id, setEvents, (caught) => {
        setEvents([]);
        setError(caught.message);
      }),
    [reservation.id],
  );

  const position = positionOf(reservation.pricing, events);
  const eligibility = pickupEligibility(position, minPickupPaymentPercent);

  /**
   * Run one financial action.
   *
   * The idempotency key is generated **here**, once per attempt, and reused by
   * nothing else. A retry driven by the user pressing the button again is a new
   * intent and gets a new key; a retry inside the SDK carries the same one.
   */
  const run = useCallback(
    async (action: () => Promise<{ duplicate: boolean }>) => {
      setBusy(true);
      setError(null);
      setNotice(null);

      try {
        const result = await action();
        setNotice(result.duplicate ? t('money.alreadyRecorded') : t('money.recorded'));
        setOpen('none');
      } catch (caught) {
        setError(
          caught instanceof PaymentServiceError
            ? caught.message
            : caught instanceof Error
              ? caught.message
              : t('error.loadFailed'),
        );
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  return (
    <section className="mt-10 border-t border-ink-100 pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="label-caps">{t('money.title')}</h2>
        <Badge tone={toneFor(position.status)}>{t(`financial.${position.status}`)}</Badge>
      </div>

      {error && (
        <Alert tone="error" className="mt-4">
          {error}
        </Alert>
      )}

      {notice && (
        <Alert tone="success" className="mt-4">
          {notice}
        </Alert>
      )}

      {/* The two accounts, side by side and never mixed --------------------- */}
      <div className="mt-6 grid gap-8 sm:grid-cols-2">
        <div>
          <p className="label-caps text-ink-400">{t('money.balance')}</p>

          <dl className="mt-3 space-y-2 text-sm">
            <Row label={t('money.charges')} value={formatOmr(position.agreedCharges)} />
            {position.lateFees > 0 && (
              <Row label={t('money.lateFees')} value={formatOmr(position.lateFees)} />
            )}
            {position.waivedCharges > 0 && (
              <Row label={t('money.waived')} value={`− ${formatOmr(position.waivedCharges)}`} />
            )}
            <Row label={t('money.totalChargeable')} value={formatOmr(position.totalChargeable)} />
            <Row label={t('money.paid')} value={formatOmr(position.netPaid)} />
            <Row
              label={position.refundable > 0 ? t('money.refundable') : t('money.outstanding')}
              value={formatOmr(
                position.refundable > 0 ? position.refundable : position.outstanding,
              )}
              emphasis
            />
          </dl>
        </div>

        <div>
          <p className="label-caps text-ink-400">{t('money.depositHeld')}</p>

          <dl className="mt-3 space-y-2 text-sm">
            <Row label={t('money.depositDue')} value={formatOmr(position.depositDue)} />
            {position.depositRefunded > 0 && (
              <Row label={t('money.depositReturned')} value={formatOmr(position.depositRefunded)} />
            )}
            {position.depositForfeited > 0 && (
              <Row label={t('money.depositKept')} value={formatOmr(position.depositForfeited)} />
            )}
            <Row label={t('money.depositHeld')} value={formatOmr(position.depositHeld)} emphasis />
          </dl>

          <p className="mt-3 text-2xs text-ink-400">{t('money.depositSeparate')}</p>
        </div>
      </div>

      {/* Collection readiness ---------------------------------------------- */}
      <Alert tone={eligibility.allowed ? 'success' : 'warning'} className="mt-6">
        <p className="font-medium">{t('pickup.title')}</p>

        {eligibility.allowed ? (
          <p className="mt-1 text-2xs">{t('pickup.allowed')}</p>
        ) : (
          <ul className="mt-1 space-y-1 text-2xs">
            {eligibility.reasons.map((reason) => (
              <li key={reason}>
                {reason === 'DEPOSIT_NOT_HELD'
                  ? t('pickup.depositNotHeld')
                  : t('pickup.balanceBelowThreshold')}
              </li>
            ))}
            {eligibility.stillRequired > 0 && (
              <li className="numeric">
                {t('pickup.stillRequired')}: {formatOmr(eligibility.stillRequired)}
              </li>
            )}
          </ul>
        )}
      </Alert>

      {/* Actions ------------------------------------------------------------ */}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || position.outstanding === 0}
          onClick={() => setOpen(open === 'payment' ? 'none' : 'payment')}
        >
          {t('money.recordPayment')}
        </Button>

        <Button
          variant="secondary"
          size="sm"
          disabled={busy || position.depositPaid >= position.depositDue}
          onClick={() => setOpen(open === 'deposit' ? 'none' : 'deposit')}
        >
          {t('money.collectDeposit')}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          disabled={busy || position.lateFees > 0}
          onClick={() => setOpen(open === 'lateFee' ? 'none' : 'lateFee')}
        >
          {t('money.chargeLateFee')}
        </Button>

        {/*
         * Money leaving the till and corrections to posted history are the
         * owner's. Hidden rather than disabled for staff — offering a control
         * that always refuses is worse than not offering it.
         */}
        {isOwner && (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || position.refundable === 0}
              onClick={() => setOpen(open === 'refund' ? 'none' : 'refund')}
            >
              {t('money.refund')}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              disabled={busy || position.depositHeld === 0}
              onClick={() => setOpen(open === 'returnDeposit' ? 'none' : 'returnDeposit')}
            >
              {t('money.returnDeposit')}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              disabled={busy || position.depositHeld === 0}
              onClick={() => setOpen(open === 'keepDeposit' ? 'none' : 'keepDeposit')}
            >
              {t('money.keepDeposit')}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              disabled={busy || position.waivedCharges > 0}
              onClick={() => setOpen(open === 'cancel' ? 'none' : 'cancel')}
            >
              {t('money.cancelFinancially')}
            </Button>
          </>
        )}
      </div>

      {open === 'payment' && (
        <AmountForm
          label={t('money.recordPayment')}
          max={position.outstanding}
          withType
          busy={busy}
          onSubmit={(values) =>
            void run(() =>
              recordPayment({
                reservationId: reservation.id,
                amount: values.amount,
                method: values.method,
                type: values.type ?? 'Installment',
                reference: values.reference,
                idempotencyKey: newIdempotencyKey(),
              }),
            )
          }
          onCancel={() => setOpen('none')}
        />
      )}

      {open === 'deposit' && (
        <AmountForm
          label={t('money.collectDeposit')}
          max={baisa(position.depositDue - position.depositPaid)}
          busy={busy}
          onSubmit={(values) =>
            void run(() =>
              recordSecurityDeposit({
                reservationId: reservation.id,
                amount: values.amount,
                method: values.method,
                reference: values.reference,
                idempotencyKey: newIdempotencyKey(),
              }),
            )
          }
          onCancel={() => setOpen('none')}
        />
      )}

      {open === 'refund' && (
        <AmountForm
          label={t('money.refund')}
          max={position.refundable}
          withReason
          busy={busy}
          onSubmit={(values) =>
            void run(() =>
              refundPayment({
                reservationId: reservation.id,
                amount: values.amount,
                method: values.method,
                reference: values.reference,
                reason: values.reason,
                idempotencyKey: newIdempotencyKey(),
              }),
            )
          }
          onCancel={() => setOpen('none')}
        />
      )}

      {open === 'returnDeposit' && (
        <AmountForm
          label={t('money.returnDeposit')}
          max={position.depositHeld}
          busy={busy}
          onSubmit={(values) =>
            void run(() =>
              settleDeposit({
                reservationId: reservation.id,
                amount: values.amount,
                forfeit: false,
                reason: values.reason,
                method: values.method,
                idempotencyKey: newIdempotencyKey(),
              }),
            )
          }
          onCancel={() => setOpen('none')}
        />
      )}

      {open === 'keepDeposit' && (
        <AmountForm
          label={t('money.keepDeposit')}
          max={position.depositHeld}
          withReason
          requireReason
          hint={t('money.forfeitNote')}
          busy={busy}
          onSubmit={(values) =>
            void run(() =>
              settleDeposit({
                reservationId: reservation.id,
                amount: values.amount,
                forfeit: true,
                reason: values.reason,
                idempotencyKey: newIdempotencyKey(),
              }),
            )
          }
          onCancel={() => setOpen('none')}
        />
      )}

      {open === 'lateFee' && (
        <LateFeeForm
          busy={busy}
          defaultReturn={toMuscatWallTime(reservation.returnAt)}
          onSubmit={(actualReturnAt) =>
            void run(() =>
              postLateFee({
                reservationId: reservation.id,
                actualReturnAt,
                idempotencyKey: newIdempotencyKey(),
              }),
            )
          }
          onCancel={() => setOpen('none')}
        />
      )}

      {open === 'cancel' && (
        <CancellationForm
          reservationId={reservation.id}
          busy={busy}
          onConfirm={(reason) =>
            void run(() =>
              cancelReservationFinancially({
                reservationId: reservation.id,
                reason,
                idempotencyKey: newIdempotencyKey(),
              }),
            )
          }
          onCancel={() => setOpen('none')}
        />
      )}

      {/* The statement ------------------------------------------------------ */}
      <div className="mt-8">
        <h3 className="label-caps">{t('money.statement')}</h3>

        {events.length === 0 ? (
          <p className="mt-3 text-sm text-ink-400">{t('money.noEvents')}</p>
        ) : (
          <ul className="mt-3 divide-y divide-ink-100">
            {events.map((event) => {
              const signed = signedAmount(event);

              return (
                <li key={event.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3">
                  <span className="numeric w-40 shrink-0 text-2xs text-ink-400">
                    {formatMuscat(event.occurredAt, language)}
                  </span>

                  <span className="min-w-0 flex-1 text-sm text-ink-900">
                    {t(`event.${event.kind}`)}
                    {event.method !== null && (
                      <span className="text-ink-400"> · {t(`method.${event.method}`)}</span>
                    )}
                    {event.reason.length > 0 && (
                      <span className="block text-2xs text-ink-400">{event.reason}</span>
                    )}
                  </span>

                  <span
                    className={`numeric shrink-0 text-sm ${signed < 0 ? 'text-danger' : 'text-ink-900'}`}
                  >
                    {formatOmr(signed, { signDisplay: true })}
                  </span>

                  {/*
                   * A reversal is offered only on the payment it could apply to,
                   * and only while nothing has reversed it yet — the server
                   * refuses a second one regardless.
                   */}
                  {isOwner &&
                    (event.kind === 'Payment' || event.kind === 'SecurityDepositPayment') &&
                    !events.some((other) => other.reversesEventId === event.id) && (
                      <ReverseButton
                        busy={busy}
                        onReverse={(reason) =>
                          void run(() =>
                            reversePayment({
                              reservationId: reservation.id,
                              eventId: event.id,
                              reason,
                              idempotencyKey: newIdempotencyKey(),
                            }),
                          )
                        }
                      />
                    )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------ *
 * Forms
 * ------------------------------------------------------------------------ */

interface AmountValues {
  readonly amount: Baisa;
  readonly method: PaymentMethod;
  readonly type: PaymentType | null;
  readonly reference: string;
  readonly reason: string;
}

function AmountForm({
  label,
  max,
  withType = false,
  withReason = false,
  requireReason = false,
  hint,
  busy,
  onSubmit,
  onCancel,
}: {
  label: string;
  max: Baisa;
  withType?: boolean;
  withReason?: boolean;
  requireReason?: boolean;
  hint?: string;
  busy: boolean;
  onSubmit: (values: AmountValues) => void;
  onCancel: () => void;
}) {
  const { t } = useT();

  const [amount, setAmount] = useState<Baisa | null>(null);
  const [method, setMethod] = useState<PaymentMethod>('Cash');
  const [type, setType] = useState<PaymentType>('Installment');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');

  /*
   * The ceiling is shown and the button disabled beyond it, but this is only a
   * courtesy: the server recomputes the balance inside its transaction and
   * refuses anything above it there. A browser figure is stale the moment a
   * second till is open.
   */
  const invalid =
    amount === null || amount <= 0 || amount > max || (requireReason && reason.trim().length === 0);

  return (
    <div className="mt-6 border-s-2 border-gold-400 ps-4">
      <p className="label-caps">{label}</p>

      {hint && <p className="mt-2 text-2xs text-ink-400">{hint}</p>}

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <MoneyField
          label={t('money.amount')}
          value={amount}
          onChange={setAmount}
          hint={`${t('money.balance')}: ${formatOmr(max)}`}
        />

        <Select
          label={t('money.method')}
          value={method}
          onChange={(event) => setMethod(event.target.value as PaymentMethod)}
          options={PAYMENT_METHODS.map((value) => ({ value, label: t(`method.${value}`) }))}
        />

        {withType && (
          <Select
            label={t('reservations.status')}
            value={type}
            onChange={(event) => setType(event.target.value as PaymentType)}
            options={PAYMENT_TYPES.map((value) => ({
              value,
              label: t(`paymentType.${value}`),
            }))}
          />
        )}

        <Field
          label={t('money.reference')}
          value={reference}
          onChange={(event) => setReference(event.target.value)}
        />

        {withReason && (
          <div className="sm:col-span-2">
            <TextArea
              label={t('money.reason')}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
            />
          </div>
        )}
      </div>

      <div className="mt-4 flex gap-3">
        <Button
          size="sm"
          disabled={busy || invalid}
          onClick={() =>
            onSubmit({
              amount: amount as Baisa,
              method,
              type: withType ? type : null,
              reference,
              reason,
            })
          }
        >
          {busy ? t('money.recording') : t('action.save')}
        </Button>

        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
      </div>
    </div>
  );
}

function LateFeeForm({
  busy,
  defaultReturn,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  defaultReturn: string;
  onSubmit: (actualReturnAt: string) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [actual, setActual] = useState(defaultReturn);

  return (
    <div className="mt-6 border-s-2 border-gold-400 ps-4">
      <p className="label-caps">{t('money.chargeLateFee')}</p>

      <div className="mt-3 max-w-xs">
        <Field
          label={t('money.actualReturn')}
          type="datetime-local"
          value={actual}
          onChange={(event) => setActual(event.target.value)}
        />
      </div>

      <div className="mt-4 flex gap-3">
        <Button size="sm" disabled={busy || actual.length === 0} onClick={() => onSubmit(actual)}>
          {busy ? t('money.recording') : t('action.save')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Cancellation: quote first, then commit.
 *
 * The employee sees the tier, what the boutique keeps and what goes back before
 * anything is posted, so the figure can be given to the customer on the
 * telephone rather than discovered afterwards.
 */
function CancellationForm({
  reservationId,
  busy,
  onConfirm,
  onCancel,
}: {
  reservationId: string;
  busy: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const { t } = useT();

  const [quote, setQuote] = useState<CancellationQuoteResult | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    quoteCancellation(reservationId)
      .then((result) => {
        if (!cancelled) setQuote(result);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not quote.');
      });

    return () => {
      cancelled = true;
    };
  }, [reservationId]);

  return (
    <div className="mt-6 border-s-2 border-gold-400 ps-4">
      <p className="label-caps">{t('cancel.title')}</p>

      {error && (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      )}

      {quote === null && error === null && <p className="mt-3 text-sm text-ink-400">…</p>}

      {quote !== null && (
        <>
          <dl className="mt-3 space-y-2 text-sm">
            <Row label={t('cancel.notice')} value={`${quote.daysOfNotice} ${t('cancel.days')}`} />
            <Row label={t('cancel.refundPercent')} value={`${quote.refundPercent}%`} />
            <Row label={t('cancel.charge')} value={formatOmr(baisa(quote.cancellationCharge))} />
            <Row label={t('cancel.rentalRefund')} value={formatOmr(baisa(quote.rentalRefundDue))} />
            <Row
              label={t('cancel.depositRefund')}
              value={formatOmr(baisa(quote.depositRefundDue))}
            />
            {quote.stillOwed > 0 && (
              <Row label={t('cancel.stillOwed')} value={formatOmr(baisa(quote.stillOwed))} />
            )}
            <Row
              label={t('cancel.totalRefund')}
              value={formatOmr(baisa(quote.totalRefundDue))}
              emphasis
            />
          </dl>

          <p className="mt-3 text-2xs text-ink-400">{t('cancel.noRefundPaid')}</p>

          <div className="mt-3 max-w-md">
            <TextArea
              label={t('money.reason')}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
            />
          </div>

          <div className="mt-4 flex gap-3">
            <Button size="sm" disabled={busy} onClick={() => onConfirm(reason)}>
              {busy ? t('money.recording') : t('cancel.confirm')}
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {t('action.cancel')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function ReverseButton({
  busy,
  onReverse,
}: {
  busy: boolean;
  onReverse: (reason: string) => void;
}) {
  const { t } = useT();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');

  if (!asking) {
    return (
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setAsking(true)}>
        {t('money.reverse')}
      </Button>
    );
  }

  return (
    <div className="w-full">
      <p className="text-2xs text-ink-400">{t('money.reversalNote')}</p>

      <div className="mt-2 flex flex-wrap items-end gap-3">
        <Field
          label={t('money.reason')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <Button
          size="sm"
          disabled={busy || reason.trim().length === 0}
          onClick={() => onReverse(reason)}
        >
          {t('money.reverse')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
          {t('action.cancel')}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Bits
 * ------------------------------------------------------------------------ */

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

function toneFor(status: string) {
  switch (status) {
    case 'Paid':
      return 'success' as const;
    case 'Partially Paid':
      return 'info' as const;
    case 'Refunded':
    case 'Partially Refunded':
      return 'warning' as const;
    default:
      return 'neutral' as const;
  }
}
