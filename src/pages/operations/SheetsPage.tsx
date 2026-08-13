import { useEffect, useMemo, useState } from 'react';

import { Alert, Button, Field, Select } from '@/design-system';
import { useT } from '@/hooks/useT';
import { formatMuscatDate, toMuscatDate } from '@/domain/datetime';
import { formatOmr } from '@/domain/money';
import { dayOperations, readyToCollect, type OperationalReservation } from '@/domain/operations';
import { observeLiveReservations, type LiveReservation } from '@/services/operations.service';
import {
  observeAllReservationItems,
  type ReservationItem,
} from '@/services/reservations.service';
import { observePickupThreshold } from '@/services/payments.service';
import { observeDresses, type Dress } from '@/services/dresses.service';

import '@/print/print.css';

type Sheet = 'pickup' | 'return' | 'cleaning' | 'alteration';

/**
 * Printable operational sheets.
 *
 * The paper an employee carries to the rail. Four of them, each answering one
 * question: what leaves today, what comes back today, what is in the wash, what
 * is waiting on a seamstress.
 *
 * Built on the A4 stylesheet the invoices use, so a sheet prints on the same
 * paper with the same margins and the same brand. Nothing here computes money —
 * balances come from the ledger through `observeLiveReservations`.
 */
export function SheetsPage() {
  const { t, language } = useT();

  const [sheet, setSheet] = useState<Sheet>('pickup');
  const [date, setDate] = useState(() => toMuscatDate(Date.now()));

  const [reservations, setReservations] = useState<LiveReservation[] | null>(null);
  const [items, setItems] = useState<ReservationItem[]>([]);
  const [dresses, setDresses] = useState<Dress[]>([]);
  const [threshold, setThreshold] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return observeLiveReservations(setReservations, (caught) => {
      setReservations([]);
      setError(caught.message);
    });
  }, []);

  useEffect(() => {
    return observeAllReservationItems(setItems, () => setItems([]));
  }, []);

  useEffect(() => {
    return observeDresses({ includeRetired: true }, setDresses, () => setDresses([]));
  }, []);

  useEffect(() => {
    return observePickupThreshold(setThreshold, () => setThreshold(0));
  }, []);

  /*
   * The chosen day at noon. Any instant inside the Muscat day works —
   * `dayOperations` compares calendar dates — and noon keeps it unambiguous
   * either side of a boundary.
   */
  const at = useMemo(() => new Date(`${date}T12:00:00+04:00`).getTime(), [date]);

  const day = useMemo(
    () =>
      reservations === null
        ? null
        : dayOperations({
            reservations,
            fittings: [],
            now: at,
            minPickupPaymentPercent: threshold,
          }),
    [reservations, at, threshold],
  );

  const itemsFor = (reservationId: string) =>
    items.filter((item) => item.reservationId === reservationId);

  /** Gowns whose cleaning buffer has not yet expired: physically in the wash. */
  const cleaning = useMemo(
    () => dresses.filter((dress) => dress.status === 'In Cleaning'),
    [dresses],
  );

  const alterations = useMemo(
    () => dresses.filter((dress) => dress.status === 'In Alteration'),
    [dresses],
  );

  const rows = day === null ? [] : sheet === 'pickup' ? day.pickups : day.returns;

  return (
    <main className="mx-auto max-w-4xl px-5 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-end justify-between gap-4 print:hidden">
        <div>
          <p className="label-caps">{t('nav.sheets')}</p>
          <h1 className="display mt-2 text-3xl text-ink-900">{t('sheets.title')}</h1>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Select
            label={t('sheets.title')}
            value={sheet}
            onChange={(event) => setSheet(event.target.value as Sheet)}
            options={[
              { value: 'pickup', label: t('sheets.pickup') },
              { value: 'return', label: t('sheets.return') },
              { value: 'cleaning', label: t('sheets.cleaning') },
              { value: 'alteration', label: t('sheets.alteration') },
            ]}
            className="w-44"
          />

          {(sheet === 'pickup' || sheet === 'return') && (
            <Field
              label={t('sheets.forDate')}
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="w-44"
            />
          )}

          <Button variant="secondary" size="sm" onClick={() => window.print()}>
            {t('reports.print')}
          </Button>
        </div>
      </header>

      {error !== null && (
        <Alert tone="error" className="mt-6 print:hidden">
          {error}
        </Alert>
      )}

      {reservations === null && (
        <p className="mt-10 text-sm text-ink-400 print:hidden" role="status">
          {t('state.loading')}
        </p>
      )}

      {reservations !== null && (
        <article className={`doc mt-8 ${language === 'ar' ? 'doc--ar' : ''}`}>
          <header className="doc__header">
            <div className="doc__identity">
              <h1>{t(`sheets.${sheet}`)}</h1>
              <p className="doc__small doc__muted">
                {sheet === 'pickup' || sheet === 'return'
                  ? `${t('sheets.forDate')} ${formatMuscatDate(at, language)}`
                  : t('sheets.printedFrom')}
              </p>
            </div>
          </header>

          <hr className="doc__rule" />

          {(sheet === 'pickup' || sheet === 'return') && (
            <ReservationSheet
              rows={rows}
              sheet={sheet}
              threshold={threshold}
              itemsFor={itemsFor}
            />
          )}

          {sheet === 'cleaning' && <DressSheet dresses={cleaning} />}
          {sheet === 'alteration' && <DressSheet dresses={alterations} />}

          <footer className="doc__footer">
            <span className="doc__small doc__muted">{t('sheets.printedFrom')}</span>
          </footer>
        </article>
      )}
    </main>
  );
}

/* ------------------------------------------------------------------------ *
 * The two shapes of sheet
 * ------------------------------------------------------------------------ */

function ReservationSheet({
  rows,
  sheet,
  threshold,
  itemsFor,
}: {
  rows: readonly OperationalReservation[];
  sheet: 'pickup' | 'return';
  threshold: number;
  itemsFor: (reservationId: string) => ReservationItem[];
}) {
  const { t } = useT();

  if (rows.length === 0) {
    return <p className="doc__muted">{t('sheets.empty')}</p>;
  }

  return (
    <table className="doc__table">
      <thead>
        <tr>
          <th>{t('sheets.checked')}</th>
          <th>{t('reservations.code')}</th>
          <th>{t('customer.nameEn')}</th>
          <th>{t('reports.dress')}</th>
          <th className="doc__col-amount">
            {sheet === 'pickup' ? t('reservations.balance') : t('sheets.condition')}
          </th>
          <th>{t('sheets.signature')}</th>
        </tr>
      </thead>

      <tbody>
        {rows.map((row) => {
          const gowns = itemsFor(row.id);
          const ready = readyToCollect(row, threshold);

          return (
            <tr key={row.id}>
              {/* A box to tick with a pen: the sheet is paper, not a form. */}
              <td aria-hidden="true">☐</td>
              <td className="doc__numeric">{row.code}</td>
              <td>
                {row.customerName}
                <br />
                <span className="doc__small doc__muted">{row.customerPhone}</span>
              </td>
              <td>
                {gowns.map((item) => (
                  <span key={item.id}>
                    {item.dressCode} · {item.dressName}
                    <br />
                  </span>
                ))}
              </td>
              <td className="doc__col-amount doc__numeric">
                {sheet === 'return' ? (
                  '—'
                ) : (
                  <>
                    {formatOmr(row.outstanding)}
                    {/*
                     * A word, not a colour: this sheet is printed, often in
                     * black and white, and "may not leave" must survive that.
                     */}
                    {!ready && (
                      <>
                        <br />
                        <span className="doc__small">{t('alert.unpaidPickupToday')}</span>
                      </>
                    )}
                  </>
                )}
              </td>
              <td>
                <span className="doc__signature-line" />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DressSheet({ dresses }: { dresses: readonly Dress[] }) {
  const { t } = useT();

  if (dresses.length === 0) {
    return <p className="doc__muted">{t('sheets.empty')}</p>;
  }

  return (
    <table className="doc__table">
      <thead>
        <tr>
          <th>{t('sheets.checked')}</th>
          <th>{t('dress.code')}</th>
          <th>{t('dress.name')}</th>
          <th>{t('dress.location')}</th>
          <th>{t('sheets.signature')}</th>
        </tr>
      </thead>
      <tbody>
        {dresses.map((dress) => (
          <tr key={dress.id}>
            <td aria-hidden="true">☐</td>
            <td className="doc__numeric">{dress.code}</td>
            <td>{dress.name}</td>
            <td>{dress.location}</td>
            <td>
              <span className="doc__signature-line" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
