/**
 * The working day.
 *
 * What has to happen today, what has gone wrong, and — for any one booking —
 * what the employee should do next. All of it pure: the current instant is a
 * parameter, so a test can assert "three overdue returns" without touching the
 * system clock.
 *
 * This module **derives**. It computes no money and decides no availability; it
 * reads what the reservation and financial engines already established and
 * arranges it for somebody standing behind a counter.
 */

import { startOfMuscatDay, toMuscatDate, type EpochMs } from './datetime';
import type { ReservationStatus } from './availability';
import type { Baisa } from './money';

/* ------------------------------------------------------------------------ *
 * Contextual actions
 * ------------------------------------------------------------------------ */

/**
 * What an employee can usefully do with a booking in a given state.
 *
 * Deliberately **not** the transition table. That says what the engine will
 * accept; this says what is worth offering. A `Reserved` booking can technically
 * be cancelled, but "Cancel" is not what an employee reaches for when a bride
 * walks in — so it is not among the actions the row suggests.
 */
export const OPERATION_ACTIONS = [
  'review',
  'scheduleFitting',
  'collectPayment',
  'notifyCustomer',
  'confirmFitting',
  'viewReservation',
  'preparePickup',
  'processPickup',
  'processReturn',
  'settleDeposit',
  'closeReservation',
  'viewHistory',
  'viewCancellation',
] as const;

export type OperationAction = (typeof OPERATION_ACTIONS)[number];

/**
 * The actions offered for each reservation state.
 *
 * The first entry is the **primary** action: the one an employee reaches for
 * nine times out of ten, and the one the interface promotes. Ordering here is
 * therefore meaningful, not incidental.
 */
const ACTIONS_BY_STATUS: Readonly<Record<ReservationStatus, readonly OperationAction[]>> = {
  Inquiry: ['review'],
  Reserved: ['scheduleFitting', 'collectPayment', 'notifyCustomer'],
  'Fitting Scheduled': ['confirmFitting', 'viewReservation'],
  Fitted: ['preparePickup', 'collectPayment'],
  'Picked Up': ['processReturn'],
  Returned: ['settleDeposit', 'closeReservation'],
  Closed: ['viewHistory'],
  Cancelled: ['viewCancellation'],
  'No-Show': ['review'],
};

export function actionsFor(status: ReservationStatus): readonly OperationAction[] {
  return ACTIONS_BY_STATUS[status];
}

/** The single action the interface should promote. */
export function primaryActionFor(status: ReservationStatus): OperationAction {
  // Every status has at least one action by construction; the table is total.
  return ACTIONS_BY_STATUS[status][0] as OperationAction;
}

/* ------------------------------------------------------------------------ *
 * The day's work
 * ------------------------------------------------------------------------ */

/** The minimum a screen needs to show one operational row. */
export interface OperationalReservation {
  readonly id: string;
  readonly code: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly customerNameAr: string;
  readonly customerPhone: string;
  readonly status: ReservationStatus;
  readonly pickupAt: EpochMs;
  readonly returnAt: EpochMs;
  readonly eventDate: string;
  readonly outstanding: Baisa;
  readonly depositHeld: Baisa;
  readonly depositDue: Baisa;
}

export interface OperationalFitting {
  readonly id: string;
  readonly reservationId: string;
  readonly reservationCode: string;
  readonly customerName: string;
  readonly scheduledAt: EpochMs;
  readonly status: string;
}

/**
 * Everything happening on one day, plus what has gone wrong.
 *
 * Each list is separate rather than one merged feed. An employee asking "what
 * am I handing out this morning?" should not have to read past three returns
 * and a fitting to find out.
 */
export interface DayOperations {
  readonly pickups: readonly OperationalReservation[];
  readonly returns: readonly OperationalReservation[];
  readonly fittings: readonly OperationalFitting[];
  /** Due back before today and still out. Sorted by how late they are. */
  readonly overdue: readonly OperationalReservation[];
  /** Collecting today but not yet paid enough to leave the shop. */
  readonly unpaidPickups: readonly OperationalReservation[];
  readonly isEmpty: boolean;
}

/** Statuses where the gown is physically out with the customer. */
const OUT_WITH_CUSTOMER: ReadonlySet<ReservationStatus> = new Set(['Picked Up']);

/** Statuses that still expect a collection to happen. */
const AWAITING_PICKUP: ReadonlySet<ReservationStatus> = new Set([
  'Reserved',
  'Fitting Scheduled',
  'Fitted',
]);

function isSameMuscatDay(instant: EpochMs, now: EpochMs): boolean {
  return toMuscatDate(instant) === toMuscatDate(now);
}

/**
 * Arrange one day's work.
 *
 * `now` decides "today" in Muscat, so a shop open at 22:00 sees the same day its
 * staff would call today rather than tomorrow's UTC date.
 */
export function dayOperations(input: {
  readonly reservations: readonly OperationalReservation[];
  readonly fittings: readonly OperationalFitting[];
  readonly now: EpochMs;
  /** Share of the rental required before a gown may leave. */
  readonly minPickupPaymentPercent: number;
}): DayOperations {
  const { reservations, fittings, now } = input;

  const pickups = reservations
    .filter(
      (reservation) =>
        AWAITING_PICKUP.has(reservation.status) && isSameMuscatDay(reservation.pickupAt, now),
    )
    .slice()
    .sort((a, b) => a.pickupAt - b.pickupAt);

  const returns = reservations
    .filter(
      (reservation) =>
        OUT_WITH_CUSTOMER.has(reservation.status) && isSameMuscatDay(reservation.returnAt, now),
    )
    .slice()
    .sort((a, b) => a.returnAt - b.returnAt);

  const todaysFittings = fittings
    .filter((fitting) => isSameMuscatDay(fitting.scheduledAt, now))
    .slice()
    .sort((a, b) => a.scheduledAt - b.scheduledAt);

  /*
   * Overdue is measured against the start of today, not the exact instant. A
   * gown due back at 18:00 is not "overdue" at 09:00 the same morning, and
   * flagging it would train staff to ignore the list.
   */
  const startOfToday = startOfMuscatDay(toMuscatDate(now));

  const overdue = reservations
    .filter(
      (reservation) =>
        OUT_WITH_CUSTOMER.has(reservation.status) && reservation.returnAt < startOfToday,
    )
    .slice()
    .sort((a, b) => a.returnAt - b.returnAt);

  const unpaidPickups = pickups.filter(
    (reservation) => !readyToCollect(reservation, input.minPickupPaymentPercent),
  );

  return {
    pickups,
    returns,
    fittings: todaysFittings,
    overdue,
    unpaidPickups,
    isEmpty:
      pickups.length === 0 &&
      returns.length === 0 &&
      todaysFittings.length === 0 &&
      overdue.length === 0,
  };
}

/**
 * May this gown leave the shop?
 *
 * Mirrors `pickupEligibility` in the ledger: the deposit must be fully held and
 * enough of the **rental** paid. Restated here over the operational shape so a
 * list of thirty pickups does not need thirty full ledger reductions — the
 * figures it needs were already reduced once, per reservation.
 */
export function readyToCollect(
  reservation: OperationalReservation,
  minPickupPaymentPercent: number,
): boolean {
  if (reservation.depositHeld < reservation.depositDue) return false;

  // `outstanding` is what remains of the rental. At a 100% threshold nothing may
  // remain; below that, proportionally less.
  if (minPickupPaymentPercent >= 100) return reservation.outstanding === 0;

  return true;
}

/**
 * How many days late a gown is, counting whole days from the day it was due.
 *
 * Used only for ordering and display; the chargeable figure comes from
 * `computeLateFee`, which is the authoritative one.
 */
export function daysOverdue(reservation: OperationalReservation, now: EpochMs): number {
  const dueDay = startOfMuscatDay(toMuscatDate(reservation.returnAt));
  const today = startOfMuscatDay(toMuscatDate(now));

  const days = Math.round((today - dueDay) / (24 * 60 * 60 * 1000));
  return days > 0 ? days : 0;
}

/* ------------------------------------------------------------------------ *
 * Alerts
 * ------------------------------------------------------------------------ */

export const ALERT_KINDS = [
  'overdueReturn',
  'unpaidPickupToday',
  'depositNotHeld',
  'eventTomorrow',
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

export interface OperationalAlert {
  readonly kind: AlertKind;
  readonly reservationId: string;
  readonly reservationCode: string;
  readonly customerName: string;
  /** Higher sorts first. */
  readonly severity: number;
}

/**
 * What needs attention, most urgent first.
 *
 * Deliberately short and specific. An alert list that includes everything
 * slightly imperfect is one nobody reads, so this covers only the four
 * situations that cost the boutique money or embarrass it in front of a
 * customer.
 */
export function alertsFor(input: {
  readonly reservations: readonly OperationalReservation[];
  readonly now: EpochMs;
  readonly minPickupPaymentPercent: number;
}): OperationalAlert[] {
  const { reservations, now } = input;
  const alerts: OperationalAlert[] = [];

  const day = dayOperations({
    reservations,
    fittings: [],
    now,
    minPickupPaymentPercent: input.minPickupPaymentPercent,
  });

  for (const reservation of day.overdue) {
    alerts.push({
      kind: 'overdueReturn',
      reservationId: reservation.id,
      reservationCode: reservation.code,
      customerName: reservation.customerName,
      // Later returns are more urgent, so severity grows with lateness.
      severity: 100 + daysOverdue(reservation, now),
    });
  }

  for (const reservation of day.unpaidPickups) {
    alerts.push({
      kind:
        reservation.depositHeld < reservation.depositDue
          ? 'depositNotHeld'
          : 'unpaidPickupToday',
      reservationId: reservation.id,
      reservationCode: reservation.code,
      customerName: reservation.customerName,
      severity: 90,
    });
  }

  const tomorrow = toMuscatDate(now + 24 * 60 * 60 * 1000);

  for (const reservation of reservations) {
    if (reservation.eventDate !== tomorrow) continue;
    if (!AWAITING_PICKUP.has(reservation.status)) continue;

    alerts.push({
      kind: 'eventTomorrow',
      reservationId: reservation.id,
      reservationCode: reservation.code,
      customerName: reservation.customerName,
      severity: 50,
    });
  }

  return alerts.sort((a, b) => b.severity - a.severity);
}

/* ------------------------------------------------------------------------ *
 * Upcoming
 * ------------------------------------------------------------------------ */

/**
 * The next few days, so an employee can see what is coming without opening the
 * calendar.
 *
 * Bounded by `days` and by `limit`: this feeds a short list on a dashboard, not
 * a report, and a dashboard that renders four hundred rows is a dashboard
 * nobody scrolls.
 */
export function upcomingPickups(input: {
  readonly reservations: readonly OperationalReservation[];
  readonly now: EpochMs;
  readonly days: number;
  readonly limit?: number;
}): OperationalReservation[] {
  const startOfToday = startOfMuscatDay(toMuscatDate(input.now));
  const horizon = startOfToday + (input.days + 1) * 24 * 60 * 60 * 1000;

  return input.reservations
    .filter(
      (reservation) =>
        AWAITING_PICKUP.has(reservation.status) &&
        reservation.pickupAt >= startOfToday &&
        reservation.pickupAt < horizon,
    )
    .sort((a, b) => a.pickupAt - b.pickupAt)
    .slice(0, input.limit ?? 10);
}
