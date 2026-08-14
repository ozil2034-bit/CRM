import { useEffect, useMemo, useState } from 'react';

import { Alert, Button, Field, Select, TextArea } from '@/design-system';
import { MoneyField } from '@/components/MoneyField';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { formatMuscatDate } from '@/domain/datetime';
import { formatOmr, type Baisa } from '@/domain/money';
import { chargeDelta, refuseAmendment, withAccessory, withAlteration } from '@/domain/amendment';
import { depositFor, priceFor, selectableAccessories, type Accessory } from '@/domain/accessory';
import { observeAccessories } from '@/services/accessories.service';
import { observeDocumentsForReservation } from '@/services/documents.service';
import {
  addReservationAccessory,
  addReservationAlteration,
  newAmendmentKey,
  removeReservationAccessory,
  removeReservationAlteration,
} from '@/services/amendments.service';
import type { Reservation } from '@/services/reservations.service';

/**
 * Accessories and alterations on one booking.
 *
 * Both change what the customer owes, so both go through a Cloud Function and
 * neither is computed here. What this panel *does* compute is the preview —
 * "this adds 21.000" — using the same `reprice` the server will run, so an
 * employee is never surprised by the total after they commit.
 *
 * When an invoice has been issued the panel says so and offers nothing. The
 * customer is holding a document; the way back is to void it and reissue.
 */
export function AmendmentsPanel({ reservation }: { reservation: Reservation }) {
  const { t, language } = useT();
  const { can } = useAuth();

  const [catalogue, setCatalogue] = useState<Accessory[]>([]);
  const [hasActiveDocument, setHasActiveDocument] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    return observeAccessories(setCatalogue, () => setCatalogue([]));
  }, []);

  useEffect(() => {
    return observeDocumentsForReservation(
      reservation.id,
      /*
       * "Active" means issued and not voided. The stored document carries both a
       * `status` and a `voided` flag, written together; the client reads
       * `status`, which is the one the document itself displays.
       */
      (documents) => setHasActiveDocument(documents.some((entry) => entry.status === 'Issued')),
      () => setHasActiveDocument(false),
    );
  }, [reservation.id]);

  const context = useMemo(
    () => ({
      status: reservation.status,
      hasActiveDocument,
      /*
       * The real frozen lines, not an empty list. The preview reprices the
       * whole booking and compares totals, so leaving the gowns out would quote
       * a change with the entire rental subtracted from it.
       */
      items: reservation.items,
      accessories: reservation.accessories,
      alterations: reservation.alterations,
      vatRatePercent: reservation.pricing.vatRatePercent,
      discountAmount: reservation.pricing.discountAmount,
    }),
    [reservation, hasActiveDocument],
  );

  const refusal = refuseAmendment({ status: reservation.status, hasActiveDocument });
  const editable = refusal === null && can('reservations.edit');

  async function run(operation: () => Promise<unknown>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      await operation();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-10 border-t border-ink-100 pt-6">
      <h2 className="label-caps">{t('amend.accessories')}</h2>

      {refusal !== null && (
        <Alert tone="info" className="mt-3">
          {refusal === 'DOCUMENT_ISSUED' ? t('amend.lockedInvoice') : t('amend.lockedStatus')}
        </Alert>
      )}

      {error !== null && (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      )}

      {/* ---- Accessory lines ---- */}
      {reservation.accessories.length === 0 ? (
        <p className="mt-3 text-sm text-ink-500">{t('amend.noAccessories')}</p>
      ) : (
        <ul className="mt-3 divide-y divide-ink-100">
          {reservation.accessories.map((line) => (
            <li
              key={line.lineId}
              className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 py-2"
            >
              <span className="user-text min-w-0 flex-1 truncate text-sm text-ink-900">
                {language === 'ar' && line.nameAr.length > 0 ? line.nameAr : line.name}
              </span>

              <span className="numeric shrink-0 text-sm text-ink-500">×{line.quantity}</span>

              <span className="numeric shrink-0 text-sm text-ink-600">
                {formatOmr((line.unitPrice * line.quantity) as Baisa)}
              </span>

              {editable && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      removeReservationAccessory({
                        reservationId: reservation.id,
                        lineId: line.lineId,
                      }),
                    )
                  }
                >
                  {t('amend.remove')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {editable && (
        <AddAccessoryForm
          catalogue={catalogue}
          busy={busy}
          preview={(accessory, quantity, unitPrice, deposit) =>
            chargeDelta(
              reservation.pricing,
              withAccessory(context, {
                lineId: 'preview',
                accessoryId: accessory.id,
                name: accessory.name,
                nameAr: accessory.nameAr,
                unitPrice,
                quantity,
                securityDeposit: deposit,
              }).pricing,
            )
          }
          onAdd={(accessory, quantity, unitPrice, deposit) =>
            run(() =>
              addReservationAccessory({
                reservationId: reservation.id,
                accessoryId: accessory.id,
                name: accessory.name,
                nameAr: accessory.nameAr,
                unitPrice,
                securityDeposit: deposit,
                quantity,
                idempotencyKey: newAmendmentKey(),
              }),
            )
          }
        />
      )}

      {/* ---- Alterations ---- */}
      <h2 className="label-caps mt-10">{t('amend.alterations')}</h2>

      {reservation.alterations.length === 0 ? (
        <p className="mt-3 text-sm text-ink-500">{t('amend.noAlterations')}</p>
      ) : (
        <ul className="mt-3 divide-y divide-ink-100">
          {reservation.alterations.map((line) => (
            <li key={line.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink-900">
                  {language === 'ar' && line.descriptionAr.length > 0
                    ? line.descriptionAr
                    : line.description}
                </p>
                {line.notes.length > 0 && (
                  <p className="mt-0.5 text-2xs text-ink-500">{line.notes}</p>
                )}
                <p className="mt-0.5 text-2xs text-ink-400">
                  {t('amend.recordedBy')} {line.employeeName}
                  {line.createdAt > 0 && ` · ${formatMuscatDate(line.createdAt, language)}`}
                </p>
              </div>

              <span className="numeric shrink-0 text-sm text-ink-600">
                {formatOmr(line.amount)}
              </span>

              {editable && can('alterations.record') && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      removeReservationAlteration({
                        reservationId: reservation.id,
                        lineId: line.id,
                      }),
                    )
                  }
                >
                  {t('amend.remove')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {editable && can('alterations.record') && (
        <AddAlterationForm
          busy={busy}
          preview={(amount) =>
            chargeDelta(
              reservation.pricing,
              withAlteration(context, {
                id: 'preview',
                description: 'preview',
                descriptionAr: '',
                amount,
                notes: '',
                employeeId: '',
                employeeName: '',
                createdAt: 0,
              }).pricing,
            )
          }
          onAdd={(description, descriptionAr, amount, notes) =>
            run(() =>
              addReservationAlteration({
                reservationId: reservation.id,
                description,
                descriptionAr,
                amount,
                notes,
                idempotencyKey: newAmendmentKey(),
              }),
            )
          }
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------ *
 * Adding an accessory
 * ------------------------------------------------------------------------ */

type Delta = { readonly charges: Baisa; readonly deposit: Baisa; readonly total: Baisa };

function AddAccessoryForm({
  catalogue,
  busy,
  preview,
  onAdd,
}: {
  catalogue: readonly Accessory[];
  busy: boolean;
  preview: (accessory: Accessory, quantity: number, unitPrice: Baisa, deposit: Baisa) => Delta;
  onAdd: (
    accessory: Accessory,
    quantity: number,
    unitPrice: Baisa,
    deposit: Baisa,
  ) => Promise<void>;
}) {
  const { t, language } = useT();

  const available = useMemo(() => selectableAccessories(catalogue), [catalogue]);

  const [chosenId, setChosenId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [price, setPrice] = useState<Baisa | null>(null);

  const chosen = available.find((entry) => entry.id === chosenId) ?? null;

  /*
   * The catalogue price is a suggestion the employee may override — a customer
   * may have been quoted differently — but it is never invented. A rental-only
   * item has no rental price problem; a sale-only one being rented reports no
   * price rather than falling back to zero.
   */
  const cataloguePrice = chosen === null ? null : priceFor(chosen, 'Rental');
  const effectivePrice = price ?? cataloguePrice;
  const deposit = chosen === null ? (0 as Baisa) : depositFor(chosen, 'Rental');

  const delta =
    chosen !== null && effectivePrice !== null
      ? preview(chosen, quantity, effectivePrice, deposit)
      : null;

  if (available.length === 0) {
    return <p className="mt-4 text-2xs text-ink-400">{t('amend.catalogueEmpty')}</p>;
  }

  return (
    <div className="mt-5 flex flex-wrap items-end gap-4 border-t border-ink-100 pt-5">
      <Select
        label={t('amend.pickAccessory')}
        value={chosenId}
        onChange={(event) => {
          setChosenId(event.target.value);
          setPrice(null);
        }}
        options={[
          { value: '', label: '—' },
          ...available.map((entry) => ({
            value: entry.id,
            label: language === 'ar' && entry.nameAr.length > 0 ? entry.nameAr : entry.name,
          })),
        ]}
        className="min-w-48 flex-1"
      />

      <Field
        label={t('amend.quantity')}
        type="number"
        min={1}
        max={99}
        value={String(quantity)}
        onChange={(event) => setQuantity(Math.max(1, Number(event.target.value) || 1))}
        className="w-24"
      />

      <MoneyField
        label={t('amend.unitPrice')}
        value={effectivePrice}
        onChange={setPrice}
        allowEmpty
        className="w-36"
      />

      <Button
        disabled={busy || chosen === null || effectivePrice === null}
        onClick={() => {
          if (chosen === null || effectivePrice === null) return;
          void onAdd(chosen, quantity, effectivePrice, deposit).then(() => {
            setChosenId('');
            setPrice(null);
            setQuantity(1);
          });
        }}
      >
        {t('amend.addAccessory')}
      </Button>

      {chosen !== null && effectivePrice === null && (
        <p className="w-full text-2xs text-ink-500">{t('amend.noPrice')}</p>
      )}

      {delta !== null && <DeltaNote delta={delta} />}
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Recording an alteration
 * ------------------------------------------------------------------------ */

function AddAlterationForm({
  busy,
  preview,
  onAdd,
}: {
  busy: boolean;
  preview: (amount: Baisa) => Delta;
  onAdd: (
    description: string,
    descriptionAr: string,
    amount: Baisa,
    notes: string,
  ) => Promise<void>;
}) {
  const { t } = useT();

  const [description, setDescription] = useState('');
  const [descriptionAr, setDescriptionAr] = useState('');
  const [amount, setAmount] = useState<Baisa | null>(null);
  const [notes, setNotes] = useState('');

  const ready = description.trim().length > 0 && amount !== null && amount > 0;
  const delta = ready && amount !== null ? preview(amount) : null;

  return (
    <div className="mt-5 space-y-4 border-t border-ink-100 pt-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('amend.description')}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <Field
          label={t('amend.descriptionAr')}
          value={descriptionAr}
          onChange={(event) => setDescriptionAr(event.target.value)}
          dir="rtl"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <MoneyField label={t('amend.amount')} value={amount} onChange={setAmount} allowEmpty />
        <TextArea
          label={t('amend.notes')}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={2}
        />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Button
          disabled={busy || !ready}
          onClick={() => {
            if (amount === null) return;
            void onAdd(description.trim(), descriptionAr.trim(), amount, notes.trim()).then(() => {
              setDescription('');
              setDescriptionAr('');
              setAmount(null);
              setNotes('');
            });
          }}
        >
          {t('amend.addAlteration')}
        </Button>

        {delta !== null && <DeltaNote delta={delta} />}
      </div>
    </div>
  );
}

/**
 * What the change does to the bill, before it is committed.
 *
 * Computed with the same `reprice` the server runs, so "add a veil" is never a
 * silent change to what a customer owes.
 */
function DeltaNote({ delta }: { delta: Delta }) {
  const { t } = useT();

  return (
    <p className="text-2xs text-ink-500">
      {t('amend.willAdd')} <span className="numeric text-ink-900">{formatOmr(delta.charges)}</span>
      {delta.deposit > 0 && (
        <>
          {' '}
          {t('amend.willAddDeposit')}{' '}
          <span className="numeric text-ink-900">{formatOmr(delta.deposit)}</span>
        </>
      )}
    </p>
  );
}
