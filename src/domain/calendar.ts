/**
 * The calendar grid.
 *
 * Pure date arithmetic in Muscat wall time, producing the cells a month or week
 * view renders. No React, no Firestore, no `Date.now()` — the anchor is always a
 * parameter, so a test can assert February 2028's leap day without waiting four
 * years.
 *
 * Deliberately not a library. A month grid is forty-two cells and a week is
 * seven; the arithmetic is small, and a dependency would bring a locale system
 * that fights the one already established.
 */

import {
  addDays,
  MS_PER_DAY,
  startOfMuscatDay,
  toMuscatDate,
  type EpochMs,
} from './datetime';
import type { ReservationStatus } from './availability';

/* ------------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------------ */

/**
 * The four things that appear on a boutique's calendar.
 *
 * Each is a distinct kind rather than a colour, because **status must never be
 * conveyed by colour alone**: the interface renders a label and an icon for
 * each, and a colour-blind employee reads the same information.
 */
export const CALENDAR_EVENT_KINDS = ['pickup', 'return', 'fitting', 'event'] as const;
export type CalendarEventKind = (typeof CALENDAR_EVENT_KINDS)[number];

export interface CalendarEvent {
  readonly id: string;
  readonly kind: CalendarEventKind;
  readonly at: EpochMs;
  /** `YYYY-MM-DD` in Muscat — the cell this belongs in. */
  readonly day: string;
  readonly reservationId: string;
  readonly reservationCode: string;
  readonly customerName: string;
  readonly dressCode: string;
  readonly status: ReservationStatus | null;
}

/* ------------------------------------------------------------------------ *
 * Grids
 * ------------------------------------------------------------------------ */

export interface CalendarDay {
  /** `YYYY-MM-DD` in Muscat. */
  readonly date: string;
  readonly startsAt: EpochMs;
  /** False for the leading and trailing days that pad a month grid. */
  readonly inMonth: boolean;
  readonly isToday: boolean;
  readonly events: readonly CalendarEvent[];
}

export interface MonthGrid {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly days: readonly CalendarDay[];
  /** Day-of-week index the grid starts on, 0 = Sunday. */
  readonly firstWeekday: number;
}

/**
 * The week starts on **Saturday** in Oman.
 *
 * Friday and Saturday are the weekend, so a grid beginning on Monday — or on
 * Sunday, as most Western calendars do — would split the weekend across two
 * rows and make a bridal boutique's busiest days hardest to read.
 */
export const WEEK_STARTS_ON = 6;

/** `YYYY-MM` for the month containing an instant. */
export function monthOf(instant: EpochMs): string {
  return toMuscatDate(instant).slice(0, 7);
}

/** The first instant of the given `YYYY-MM`, in Muscat. */
export function startOfMonth(month: string): EpochMs {
  return startOfMuscatDay(`${month}-01`);
}

/** The `YYYY-MM` that follows, rolling the year over in December. */
export function nextMonth(month: string): string {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return index === 12
    ? `${year + 1}-01`
    : `${year}-${String(index + 1).padStart(2, '0')}`;
}

export function previousMonth(month: string): string {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return index === 1
    ? `${year - 1}-12`
    : `${year}-${String(index - 1).padStart(2, '0')}`;
}

/** Day of week for a Muscat day, 0 = Sunday. */
function weekdayOf(startsAt: EpochMs): number {
  // Shift into Muscat before asking, so 23:00 UTC is not yesterday.
  return new Date(startsAt + 4 * 60 * 60 * 1000).getUTCDay();
}

/**
 * Build a month grid, padded to whole weeks.
 *
 * Always six rows. A month that fits in five would otherwise make the grid
 * change height as the employee pages through the year, which is a small thing
 * that makes a calendar feel cheap.
 */
export function buildMonthGrid(input: {
  readonly month: string;
  readonly events: readonly CalendarEvent[];
  readonly now: EpochMs;
}): MonthGrid {
  const first = startOfMonth(input.month);
  const firstWeekday = weekdayOf(first);

  // How many trailing days of the previous month to show.
  const lead = (firstWeekday - WEEK_STARTS_ON + 7) % 7;
  const gridStart = addDays(first, -lead);

  const today = toMuscatDate(input.now);
  const byDay = groupByDay(input.events);

  const days: CalendarDay[] = [];

  for (let offset = 0; offset < 42; offset += 1) {
    const startsAt = addDays(gridStart, offset);
    const date = toMuscatDate(startsAt);

    days.push({
      date,
      startsAt,
      inMonth: date.slice(0, 7) === input.month,
      isToday: date === today,
      events: byDay.get(date) ?? [],
    });
  }

  return { month: input.month, days, firstWeekday };
}

/** Seven days beginning on the boutique's week start. */
export function buildWeekGrid(input: {
  readonly anchor: EpochMs;
  readonly events: readonly CalendarEvent[];
  readonly now: EpochMs;
}): CalendarDay[] {
  const anchorDay = startOfMuscatDay(toMuscatDate(input.anchor));
  const back = (weekdayOf(anchorDay) - WEEK_STARTS_ON + 7) % 7;
  const start = addDays(anchorDay, -back);

  const today = toMuscatDate(input.now);
  const byDay = groupByDay(input.events);

  return Array.from({ length: 7 }, (_unused, offset) => {
    const startsAt = addDays(start, offset);
    const date = toMuscatDate(startsAt);

    return {
      date,
      startsAt,
      inMonth: true,
      isToday: date === today,
      events: byDay.get(date) ?? [],
    };
  });
}

/** One day's events, in time order — the agenda view. */
export function buildAgenda(input: {
  readonly day: string;
  readonly events: readonly CalendarEvent[];
}): CalendarEvent[] {
  return input.events
    .filter((event) => event.day === input.day)
    .slice()
    .sort((a, b) => a.at - b.at);
}

function groupByDay(events: readonly CalendarEvent[]): Map<string, CalendarEvent[]> {
  const byDay = new Map<string, CalendarEvent[]>();

  for (const event of events) {
    const bucket = byDay.get(event.day);
    if (bucket === undefined) {
      byDay.set(event.day, [event]);
    } else {
      bucket.push(event);
    }
  }

  for (const bucket of byDay.values()) {
    bucket.sort((a, b) => a.at - b.at);
  }

  return byDay;
}

/* ------------------------------------------------------------------------ *
 * Building events from reservations
 * ------------------------------------------------------------------------ */

export interface CalendarSource {
  readonly id: string;
  readonly code: string;
  readonly customerName: string;
  readonly status: ReservationStatus;
  readonly pickupAt: EpochMs;
  readonly returnAt: EpochMs;
  readonly eventDate: string;
  readonly dressCode: string;
}

/** Bookings that are over contribute nothing to a forward-looking calendar. */
const FINISHED: ReadonlySet<ReservationStatus> = new Set(['Cancelled', 'No-Show']);

/**
 * Turn reservations into calendar events.
 *
 * A cancelled booking is omitted entirely: it holds no dress and nobody is
 * coming, so leaving it on the calendar would have staff preparing for a
 * customer who will not arrive.
 */
export function eventsFromReservations(
  reservations: readonly CalendarSource[],
): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  for (const reservation of reservations) {
    if (FINISHED.has(reservation.status)) continue;

    events.push({
      id: `${reservation.id}-pickup`,
      kind: 'pickup',
      at: reservation.pickupAt,
      day: toMuscatDate(reservation.pickupAt),
      reservationId: reservation.id,
      reservationCode: reservation.code,
      customerName: reservation.customerName,
      dressCode: reservation.dressCode,
      status: reservation.status,
    });

    events.push({
      id: `${reservation.id}-return`,
      kind: 'return',
      at: reservation.returnAt,
      day: toMuscatDate(reservation.returnAt),
      reservationId: reservation.id,
      reservationCode: reservation.code,
      customerName: reservation.customerName,
      dressCode: reservation.dressCode,
      status: reservation.status,
    });

    if (reservation.eventDate.length > 0) {
      const at = startOfMuscatDay(reservation.eventDate);

      events.push({
        id: `${reservation.id}-event`,
        kind: 'event',
        at,
        day: reservation.eventDate,
        reservationId: reservation.id,
        reservationCode: reservation.code,
        customerName: reservation.customerName,
        dressCode: reservation.dressCode,
        status: reservation.status,
      });
    }
  }

  return events;
}

export interface FittingSource {
  readonly id: string;
  readonly reservationId: string;
  readonly reservationCode: string;
  readonly customerName: string;
  readonly scheduledAt: EpochMs;
  readonly status: string;
}

/** Cancelled fittings are omitted for the same reason cancelled bookings are. */
export function eventsFromFittings(fittings: readonly FittingSource[]): CalendarEvent[] {
  return fittings
    .filter((fitting) => fitting.status !== 'Cancelled')
    .map((fitting) => ({
      id: `${fitting.id}-fitting`,
      kind: 'fitting' as const,
      at: fitting.scheduledAt,
      day: toMuscatDate(fitting.scheduledAt),
      reservationId: fitting.reservationId,
      reservationCode: fitting.reservationCode,
      customerName: fitting.customerName,
      dressCode: '',
      status: null,
    }));
}

/**
 * The window a month view needs to fetch.
 *
 * A month grid shows up to six weeks, so a query scoped to the calendar month
 * alone would leave the leading and trailing cells empty. Returned as instants
 * so the service can bound its Firestore query rather than reading everything.
 */
export function monthQueryRange(month: string): { from: EpochMs; to: EpochMs } {
  const first = startOfMonth(month);
  const lead = (weekdayOf(first) - WEEK_STARTS_ON + 7) % 7;
  const from = addDays(first, -lead);

  return { from, to: from + 42 * MS_PER_DAY };
}
