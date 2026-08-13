/**
 * Operations — assembling what the boutique is doing.
 *
 * The dashboard, the calendar and the operational sheets all need the same
 * thing: reservations with their money attached. This module is the one place
 * that joins them, so no screen invents its own idea of "outstanding".
 *
 * ## Query cost, deliberately (§44)
 *
 * The balance of a reservation is a reduction over its financial events, and
 * those live in a flat `financialEvents` collection. Reducing one reservation
 * means one query; reducing forty would mean forty. So the dashboard reads the
 * **whole event collection once** and groups it in memory.
 *
 * That is the right trade at this scale and the wrong one at another. A boutique
 * running twenty bookings a month accumulates a few thousand events over several
 * years — kilobytes, read once per session and then kept live by one listener.
 * If the collection ever grows past that, the fix is a date-bounded query here,
 * not a stored balance: a stored balance is a cache that goes stale the moment
 * an event is appended, and a stale balance is how a customer gets asked to pay
 * twice.
 *
 * The reservation listener is likewise unbounded and deliberately so: an
 * operational day is assembled from every live booking, and "live" is not a
 * range a Firestore query can express without an index per status.
 */

import type { Unsubscribe } from 'firebase/firestore';

import { reduceLedger, type FinancialEvent } from '@/domain/ledger';
import type { OperationalReservation } from '@/domain/operations';
import type { Reservation } from './reservations.service';
import { observeReservations } from './reservations.service';
import { observeFinancialEventsForAll } from './payments.service';

/** A reservation with its ledger position folded in. */
export interface LiveReservation extends OperationalReservation {
  readonly reservation: Reservation;
}

/**
 * Fold a reservation and its events into the operational shape.
 *
 * `reduceLedger` is the only calculation. Nothing here adds, subtracts or
 * rounds — it reads what the one financial engine returned.
 */
export function toOperational(
  reservation: Reservation,
  events: readonly FinancialEvent[],
): LiveReservation {
  const position = reduceLedger(reservation.pricing, events);

  return {
    id: reservation.id,
    code: reservation.code,
    customerId: reservation.customerId,
    customerName: reservation.customerName,
    customerNameAr: reservation.customerNameAr,
    customerPhone: reservation.customerPhone,
    status: reservation.status,
    pickupAt: reservation.pickupAt,
    returnAt: reservation.returnAt,
    eventDate: reservation.eventDate,
    outstanding: position.outstanding,
    depositHeld: position.depositHeld,
    depositDue: position.depositDue,
    reservation,
  };
}

/**
 * Watch every reservation with its money attached.
 *
 * Two listeners, joined here. They fire independently, so the callback runs
 * whenever either changes and always with the latest of both — a payment
 * recorded at another till updates the dashboard without a reload.
 */
export function observeLiveReservations(
  onChange: (reservations: LiveReservation[]) => void,
  onError: (error: Error) => void,
): Unsubscribe {
  let reservations: Reservation[] = [];
  let eventsByReservation = new Map<string, FinancialEvent[]>();

  let haveReservations = false;
  let haveEvents = false;

  const emit = () => {
    // Nothing is published until both listeners have reported, so the interface
    // never briefly shows every booking as unpaid.
    if (!haveReservations || !haveEvents) return;

    onChange(
      reservations.map((reservation) =>
        toOperational(reservation, eventsByReservation.get(reservation.id) ?? []),
      ),
    );
  };

  const stopReservations = observeReservations((next) => {
    reservations = next;
    haveReservations = true;
    emit();
  }, onError);

  const stopEvents = observeFinancialEventsForAll((grouped) => {
    eventsByReservation = grouped;
    haveEvents = true;
    emit();
  }, onError);

  return () => {
    stopReservations();
    stopEvents();
  };
}

/*
 * The calendar deliberately has no query of its own.
 *
 * `monthQueryRange` exists in the calendar domain so a bounded read is possible,
 * but the dashboard already keeps every reservation live in one listener, and
 * the calendar renders from that same list. A second, range-bounded listener
 * would add a composite index and a round trip per month paged through, to
 * re-fetch documents the session already holds. When the collection outgrows one
 * listener, `monthQueryRange` is what the bounded query should use.
 */
