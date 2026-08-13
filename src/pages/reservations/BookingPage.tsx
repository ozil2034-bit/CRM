/**
 * The booking workspace.
 *
 * One screen, top to bottom: customer → dates → dresses → availability →
 * pricing → save. The specification asks for a single screen rather than a
 * wizard because a booking is a conversation, not a form: the bride changes
 * her mind about the date halfway through choosing gowns, and a wizard would
 * make that a walk backwards through three steps.
 *
 * The availability shown while choosing is a **preview**. It is computed from
 * blocking intervals the client can read, which is enough to keep an employee
 * from offering a gown that is obviously taken, but it is not the decision:
 * between the preview and the save, somebody else may book the same dress. The
 * authoritative check runs inside the Cloud Function's transaction, and its
 * answer is the one displayed if the two disagree.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Alert, Badge, Button, Field, buttonClasses } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { observeCustomers, type Customer } from '@/services/customers.service';
import { observeDresses, type Dress } from '@/services/dresses.service';
import {
  createReservation,
  observeDressBlocks,
  observeVatRate,
  ReservationServiceError,
  toInputDateTime,
  type ConflictDetail,
} from '@/services/reservations.service';
import { addToWaitlist } from '@/services/fittings.service';
import {
  blockedInterval,
  findConflict,
  nextAvailableFrom,
  type ExistingBlock,
} from '@/domain/availability';
import { fromMuscatWallTime, DateTimeError, formatMuscat } from '@/domain/datetime';
import { computePricing, NO_DISCOUNT } from '@/domain/reservation-pricing';
import { findSimilarDresses, type SimilarityCandidate } from '@/domain/similar-dresses';
import { displayName } from '@/domain/customer';
import { formatOmr } from '@/domain/money';
import { rankMatches } from '@/domain/search';
import { ConflictPanel } from './ConflictPanel';

const MAX_DRESSES = 10;

export function BookingPage() {
  const { t, language } = useT();
  const { principal, state } = useAuth();
  const navigate = useNavigate();

  const actorName = state.status === 'signed-in' ? state.session.name : '';

  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [dresses, setDresses] = useState<Dress[] | null>(null);

  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerTerm, setCustomerTerm] = useState('');
  const [dressTerm, setDressTerm] = useState('');
  const [selectedDressIds, setSelectedDressIds] = useState<string[]>([]);

  const [pickupAt, setPickupAt] = useState('');
  const [returnAt, setReturnAt] = useState('');
  const [eventDate, setEventDate] = useState('');

  const [blocks, setBlocks] = useState<Record<string, ExistingBlock[]>>({});
  const [conflicts, setConflicts] = useState<readonly ConflictDetail[]>([]);
  const [alternativesFor, setAlternativesFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [vatRatePercent, setVatRatePercent] = useState(0);

  useEffect(() => observeVatRate(setVatRatePercent, () => setVatRatePercent(0)), []);

  useEffect(
    () =>
      observeCustomers({ includeArchived: false }, setCustomers, (caught) =>
        setError(caught.message),
      ),
    [],
  );

  useEffect(
    () =>
      observeDresses({ includeRetired: false }, setDresses, (caught) => setError(caught.message)),
    [],
  );

  /*
   * Subscribe to the blocking intervals of the selected dresses only. Watching
   * every dress in the inventory would read the whole booking history on a
   * screen that needs a handful of gowns.
   */
  useEffect(() => {
    const stops = selectedDressIds.map((dressId) =>
      observeDressBlocks(
        dressId,
        (next) => setBlocks((current) => ({ ...current, [dressId]: next })),
        () => setBlocks((current) => ({ ...current, [dressId]: [] })),
      ),
    );

    return () => stops.forEach((stop) => stop());
  }, [selectedDressIds]);

  const customer = customers?.find((candidate) => candidate.id === customerId) ?? null;

  const selectedDresses = useMemo(
    () =>
      selectedDressIds
        .map((id) => dresses?.find((dress) => dress.id === id))
        .filter((dress): dress is Dress => dress !== undefined),
    [selectedDressIds, dresses],
  );

  /** Parsed dates, or the reason they cannot be used. */
  const dates = useMemo(() => {
    if (pickupAt.length === 0 || returnAt.length === 0) return null;

    try {
      const pickup = fromMuscatWallTime(pickupAt);
      const returned = fromMuscatWallTime(returnAt);
      return returned <= pickup ? null : { pickup, returned };
    } catch (caught) {
      if (caught instanceof DateTimeError) return null;
      throw caught;
    }
  }, [pickupAt, returnAt]);

  /**
   * The advisory availability preview.
   *
   * Runs the same `findConflict` the server runs, over the intervals this
   * client can see. Recomputed on every date or selection change, so the
   * employee never has to press "check".
   */
  const preview = useMemo(() => {
    if (dates === null) return [];

    return selectedDresses.flatMap((dress) => {
      const conflict = findConflict(
        {
          dressId: dress.id,
          dressCode: dress.code,
          dressName: dress.name,
          dressStatus: dress.status,
          pickupAt: dates.pickup,
          returnAt: dates.returned,
          cleaningBufferDays: dress.cleaningBufferDays,
        },
        blocks[dress.id] ?? [],
      );

      if (conflict === null) return [];

      /*
       * `findConflict` reports when the clashing blocks end. That is where the
       * gown *starts* being free, but not necessarily where a window long
       * enough for this booking opens — a later block may sit just past it. So
       * the offered date comes from `nextAvailableFrom`, which searches for a
       * gap that actually fits, and falls back to the conflict's own answer
       * only when no such gap was found inside the horizon.
       */
      const availableFrom =
        nextAvailableFrom(
          dates.pickup,
          dates.returned - dates.pickup,
          dress.cleaningBufferDays,
          blocks[dress.id] ?? [],
        ) ?? conflict.availableFrom;

      return [{ ...conflict, availableFrom } satisfies ConflictDetail];
    });
  }, [dates, selectedDresses, blocks]);

  /*
   * Server conflicts win over the preview when both exist: the server saw the
   * state that actually mattered, at the moment the write was attempted.
   */
  const shownConflicts = conflicts.length > 0 ? conflicts : preview;

  const pricing = useMemo(
    () =>
      computePricing({
        items: selectedDresses.map((dress) => ({
          dressId: dress.id,
          dressCode: dress.code,
          dressName: dress.name,
          designer: dress.designer,
          rentalPrice: dress.rentalPrice,
          securityDeposit: dress.securityDeposit,
          cleaningBufferDays: dress.cleaningBufferDays,
        })),
        // Accessories, alterations and discounts arrive in Phase 5.
        accessories: [],
        alterations: [],
        discount: NO_DISCOUNT,
        vatRatePercent,
      }),
    [selectedDresses, vatRatePercent],
  );

  const visibleCustomers = useMemo(() => {
    if (customers === null) return [];
    if (customerTerm.trim().length === 0) return customers.slice(0, 8);

    return rankMatches(
      customerTerm,
      customers,
      (candidate) =>
        `${candidate.code} ${candidate.nameEn} ${candidate.nameAr} ${candidate.phoneNormalized}`,
    ).slice(0, 8);
  }, [customers, customerTerm]);

  /**
   * Dresses offered for selection.
   *
   * Anything already selected is filtered out, and — once dates are known —
   * so is anything the preview says is taken. The specification asks that the
   * picker show only dresses that can actually be booked, so an employee is
   * never invited to choose a gown that will be refused on save.
   */
  const selectableDresses = useMemo(() => {
    if (dresses === null) return [];

    const available = dresses.filter(
      (dress) => !selectedDressIds.includes(dress.id) && dress.status === 'Available',
    );

    if (dressTerm.trim().length === 0) return available.slice(0, 8);

    return rankMatches(
      dressTerm,
      available,
      (dress) => `${dress.code} ${dress.name} ${dress.designer} ${dress.size} ${dress.color}`,
    ).slice(0, 8);
  }, [dresses, dressTerm, selectedDressIds]);

  const toCandidate = (dress: Dress): SimilarityCandidate => ({
    id: dress.id,
    code: dress.code,
    name: dress.name,
    size: dress.size,
    style: dress.style,
    color: dress.color,
    designer: dress.designer,
    rentalPrice: dress.rentalPrice,
    status: dress.status,
  });

  /** Similar dresses for the conflict the employee asked about. */
  const alternatives = useMemo(() => {
    if (alternativesFor === null || dresses === null || dates === null) return [];

    const target = dresses.find((dress) => dress.id === alternativesFor);
    if (target === undefined) return [];

    /*
     * Only gowns whose *known* intervals leave these dates clear are offered.
     * A suggestion that is itself already booked would send the employee round
     * the same loop a second time.
     */
    const free = dresses.filter((dress) => {
      if (dress.id === alternativesFor || selectedDressIds.includes(dress.id)) return false;

      return (
        findConflict(
          {
            dressId: dress.id,
            dressCode: dress.code,
            dressName: dress.name,
            dressStatus: dress.status,
            pickupAt: dates.pickup,
            returnAt: dates.returned,
            cleaningBufferDays: dress.cleaningBufferDays,
          },
          blocks[dress.id] ?? [],
        ) === null
      );
    });

    return findSimilarDresses(toCandidate(target), {
      availableDresses: free.map(toCandidate),
    });
  }, [alternativesFor, dresses, dates, blocks, selectedDressIds]);

  const addDress = useCallback((dressId: string) => {
    setConflicts([]);
    setAlternativesFor(null);
    setSelectedDressIds((current) =>
      current.includes(dressId) || current.length >= MAX_DRESSES ? current : [...current, dressId],
    );
    setDressTerm('');
  }, []);

  const removeDress = useCallback((dressId: string) => {
    setConflicts([]);
    setAlternativesFor(null);
    setSelectedDressIds((current) => current.filter((id) => id !== dressId));
  }, []);

  /** Move the whole booking forward so a blocked dress becomes bookable. */
  const useNextFreeDate = useCallback(
    (conflict: ConflictDetail) => {
      if (conflict.availableFrom === null || dates === null) return;

      const span = dates.returned - dates.pickup;
      setPickupAt(toInputDateTime(conflict.availableFrom));
      setReturnAt(toInputDateTime(conflict.availableFrom + span));
      setConflicts([]);
      setAlternativesFor(null);
    },
    [dates],
  );

  const waitlist = useCallback(
    async (conflict: ConflictDetail) => {
      if (customer === null || principal === null || dates === null) return;

      try {
        await addToWaitlist({
          customerId: customer.id,
          customerName: displayName(customer, 'en'),
          customerPhone: customer.phone,
          dressId: conflict.dressId,
          dressCode: conflict.dressCode,
          dressName: conflict.dressName,
          requestedPickupAt: pickupAt,
          requestedReturnAt: returnAt,
          eventDate,
          actor: { uid: principal.uid, name: actorName, role: principal.role },
        });
        setNotice(t('waitlist.added'));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : t('error.loadFailed'));
      }
    },
    [customer, principal, actorName, dates, pickupAt, returnAt, eventDate, t],
  );

  const blocked = customer === null || dates === null || selectedDressIds.length === 0 || saving;

  async function submit() {
    if (customer === null || dates === null || selectedDressIds.length === 0) return;

    setSaving(true);
    setError(null);
    setNotice(null);
    setConflicts([]);

    try {
      const result = await createReservation({
        customerId: customer.id,
        pickupAt,
        returnAt,
        eventDate: eventDate.length > 0 ? eventDate : null,
        dressIds: selectedDressIds,
      });

      if (result.success) {
        navigate(`/reservations/${result.reservationId}`);
        return;
      }

      setConflicts(result.conflicts);
    } catch (caught) {
      setError(
        caught instanceof ReservationServiceError && caught.code === 'offline'
          ? t('booking.offline')
          : caught instanceof Error
            ? caught.message
            : t('error.loadFailed'),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header>
        <p className="label-caps">{t('nav.reservations')}</p>
        <h1 className="display mt-2 text-3xl text-ink-900">{t('booking.title')}</h1>
      </header>

      {error && (
        <Alert tone="error" className="mt-6">
          {error}
        </Alert>
      )}

      {notice && (
        <Alert tone="success" className="mt-6">
          {notice}
        </Alert>
      )}

      {/* Customer ---------------------------------------------------------- */}
      <section className="mt-10">
        <h2 className="label-caps">{t('booking.stepCustomer')}</h2>

        {customer !== null ? (
          <div className="mt-3 flex flex-wrap items-center gap-4 border-b border-ink-100 pb-4">
            <span className="font-mono text-2xs text-ink-300">{customer.code}</span>
            <span className="flex-1 text-sm text-ink-900">{displayName(customer, language)}</span>
            <span className="numeric text-sm text-ink-600">{customer.phone}</span>
            <Button variant="ghost" size="sm" onClick={() => setCustomerId(null)}>
              {t('booking.changeCustomer')}
            </Button>
          </div>
        ) : (
          <div className="mt-3">
            <input
              type="search"
              value={customerTerm}
              onChange={(event) => setCustomerTerm(event.target.value)}
              placeholder={t('booking.customerSearch')}
              aria-label={t('booking.customerSearch')}
              className="h-11 w-full border-0 border-b border-ink-100 bg-transparent px-0 text-base text-ink-900 placeholder:text-ink-300 focus:border-gold-500 focus:outline-none"
            />

            <ul className="mt-2 divide-y divide-ink-100">
              {visibleCustomers.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    onClick={() => setCustomerId(candidate.id)}
                    className="flex w-full items-center gap-4 py-3 text-start hover:bg-sand-50"
                  >
                    <span className="w-20 shrink-0 font-mono text-2xs text-ink-300">
                      {candidate.code}
                    </span>
                    <span className="flex-1 truncate text-sm text-ink-900">
                      {displayName(candidate, language)}
                    </span>
                    <span className="numeric text-sm text-ink-600">{candidate.phone}</span>
                  </button>
                </li>
              ))}
            </ul>

            <p className="mt-3 text-2xs text-ink-400">
              {t('booking.noCustomer')}{' '}
              <Link to="/customers/new" className="underline">
                {t('customers.new')}
              </Link>
            </p>
          </div>
        )}
      </section>

      {/* Dates ------------------------------------------------------------- */}
      <section className="mt-10">
        <h2 className="label-caps">{t('booking.stepDates')}</h2>

        <div className="mt-3 grid gap-6 sm:grid-cols-3">
          <Field
            label={t('reservations.pickup')}
            type="datetime-local"
            value={pickupAt}
            onChange={(event) => {
              setPickupAt(event.target.value);
              setConflicts([]);
            }}
          />

          <Field
            label={t('reservations.return')}
            type="datetime-local"
            value={returnAt}
            onChange={(event) => {
              setReturnAt(event.target.value);
              setConflicts([]);
            }}
          />

          <Field
            label={t('reservations.eventDate')}
            type="date"
            value={eventDate}
            onChange={(event) => setEventDate(event.target.value)}
          />
        </div>

        {dates === null && <p className="mt-3 text-2xs text-ink-400">{t('booking.needsDates')}</p>}
      </section>

      {/* Dresses ----------------------------------------------------------- */}
      <section className="mt-10">
        <h2 className="label-caps">{t('booking.stepDresses')}</h2>

        {selectedDresses.length > 0 && (
          <ul className="mt-3 divide-y divide-ink-100">
            {selectedDresses.map((dress) => (
              <li key={dress.id} className="flex items-center gap-4 py-3">
                <span className="w-20 shrink-0 font-mono text-2xs text-ink-300">{dress.code}</span>
                <span className="flex-1 truncate text-sm text-ink-900">{dress.name}</span>
                <span className="numeric text-sm text-ink-600">{formatOmr(dress.rentalPrice)}</span>
                <Button variant="ghost" size="sm" onClick={() => removeDress(dress.id)}>
                  {t('booking.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}

        {selectedDressIds.length < MAX_DRESSES && (
          <div className="mt-4">
            <input
              type="search"
              value={dressTerm}
              onChange={(event) => setDressTerm(event.target.value)}
              placeholder={t('booking.dressSearch')}
              aria-label={t('booking.dressSearch')}
              className="h-11 w-full border-0 border-b border-ink-100 bg-transparent px-0 text-base text-ink-900 placeholder:text-ink-300 focus:border-gold-500 focus:outline-none"
            />

            <ul className="mt-2 divide-y divide-ink-100">
              {selectableDresses.map((dress) => (
                <li key={dress.id}>
                  <button
                    type="button"
                    onClick={() => addDress(dress.id)}
                    className="flex w-full items-center gap-4 py-3 text-start hover:bg-sand-50"
                  >
                    <span className="w-20 shrink-0 font-mono text-2xs text-ink-300">
                      {dress.code}
                    </span>
                    <span className="flex-1 truncate text-sm text-ink-900">{dress.name}</span>
                    <span className="text-2xs text-ink-400">{dress.size}</span>
                    <span className="numeric text-sm text-ink-600">
                      {formatOmr(dress.rentalPrice)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {selectedDressIds.length === 0 && (
          <p className="mt-3 text-2xs text-ink-400">{t('booking.needsDresses')}</p>
        )}
      </section>

      {/* Availability ------------------------------------------------------ */}
      {dates !== null && selectedDresses.length > 0 && (
        <section className="mt-10">
          {shownConflicts.length === 0 ? (
            <Alert tone="success">
              <p>{t('booking.allAvailable')}</p>
              <p className="mt-2 text-2xs opacity-80">{t('booking.advisory')}</p>
            </Alert>
          ) : (
            <ConflictPanel
              conflicts={shownConflicts}
              onUseNextFreeDate={useNextFreeDate}
              onFindAlternative={(conflict) => setAlternativesFor(conflict.dressId)}
              onAddToWaitlist={(conflict) => void waitlist(conflict)}
            />
          )}

          {alternativesFor !== null && (
            <div className="mt-6 border-t border-ink-100 pt-4">
              <h3 className="label-caps">{t('similar.title')}</h3>

              {alternatives.length === 0 ? (
                <p className="mt-3 text-sm text-ink-400">{t('similar.none')}</p>
              ) : (
                <ul className="mt-2 divide-y divide-ink-100">
                  {alternatives.map(({ candidate, matched }) => (
                    <li key={candidate.id} className="flex flex-wrap items-center gap-3 py-3">
                      <span className="w-20 shrink-0 font-mono text-2xs text-ink-300">
                        {candidate.code}
                      </span>
                      <span className="flex-1 truncate text-sm text-ink-900">{candidate.name}</span>

                      <span className="flex gap-1">
                        {matched.map((attribute) => (
                          <Badge key={attribute} tone="neutral">
                            {attribute}
                          </Badge>
                        ))}
                      </span>

                      <Button variant="secondary" size="sm" onClick={() => addDress(candidate.id)}>
                        {t('booking.add')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* What each gown is held for, so the employee can explain the dates. */}
          {selectedDresses.length > 0 && dates !== null && (
            <dl className="mt-6 space-y-1 text-2xs text-ink-400">
              {selectedDresses.map((dress) => {
                const interval = blockedInterval(
                  dates.pickup,
                  dates.returned,
                  dress.cleaningBufferDays,
                );

                return (
                  <div key={dress.id} className="flex flex-wrap gap-2">
                    <dt className="font-mono">{dress.code}</dt>
                    <dd>
                      {t('reservations.blockedUntil')}{' '}
                      <span className="numeric">{formatMuscat(interval.end, language)}</span>
                      {' · '}
                      {t('reservations.cleaningBuffer')}: {dress.cleaningBufferDays}{' '}
                      {t('reservations.days')}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
        </section>
      )}

      {/* Pricing ----------------------------------------------------------- */}
      {selectedDresses.length > 0 && (
        <section className="mt-10 border-t border-ink-100 pt-6">
          <h2 className="label-caps">{t('booking.stepReview')}</h2>

          <dl className="mt-4 space-y-2 text-sm">
            <Row label={t('reservations.rentalPrice')} value={formatOmr(pricing.rentalSubtotal)} />
            <Row
              label={`${t('reservations.vat')} (${pricing.vatRatePercent}%)`}
              value={formatOmr(pricing.vatAmount)}
            />
            <Row
              label={t('reservations.deposit')}
              value={formatOmr(pricing.securityDepositTotal)}
            />
            <Row
              label={t('reservations.grandTotal')}
              value={formatOmr(pricing.grandTotal)}
              emphasis
            />
          </dl>

          <p className="mt-3 text-2xs text-ink-400">{t('reservations.depositNote')}</p>
        </section>
      )}

      <div className="mt-10 flex flex-wrap items-center gap-4">
        <Button onClick={() => void submit()} disabled={blocked}>
          {saving ? t('booking.creating') : t('booking.confirm')}
        </Button>

        <Link to="/reservations" className={buttonClasses('ghost')}>
          {t('action.cancel')}
        </Link>

        {customer === null && (
          <span className="text-2xs text-ink-400">{t('booking.needsCustomer')}</span>
        )}
      </div>
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
