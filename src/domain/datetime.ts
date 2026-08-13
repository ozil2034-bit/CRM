/**
 * Time, in one timezone.
 *
 * The boutique is in Oman. **Asia/Muscat is UTC+04:00 and observes no daylight
 * saving**, which means a fixed offset is exact rather than an approximation —
 * there is no transition to get wrong.
 *
 * The storage/display split:
 *
 * - Firestore stores an **instant** (a UTC `Timestamp`). Instants are what make
 *   range queries and ordering correct.
 * - The interface reads and writes **boutique-local wall time**, because an
 *   employee typing "10:00" means ten o'clock in the shop.
 * - Every conversion between the two goes through this module. Nothing else
 *   mixes `new Date()`, UTC strings and Timestamps.
 *
 * The rule that keeps this honest: **no other module constructs a Date from a
 * local string**. Doing so silently adopts the browser's timezone, which for a
 * tablet set to another region would place a pickup on the wrong day.
 *
 * Pure: no I/O, no Firebase. `now` is always a parameter.
 */

/** Asia/Muscat, in minutes east of UTC. Fixed — Oman has never observed DST. */
export const MUSCAT_UTC_OFFSET_MINUTES = 4 * 60;

export const MUSCAT_TIMEZONE = 'Asia/Muscat';

const MS_PER_MINUTE = 60_000;
export const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

export class DateTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateTimeError';
  }
}

/** An instant, as epoch milliseconds. What Firestore stores. */
export type EpochMs = number;

/* ------------------------------------------------------------------------ *
 * Parsing boutique-local wall time
 * ------------------------------------------------------------------------ */

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Convert boutique wall time (`2026-09-10T11:00`) to an instant.
 *
 * Deliberately does NOT use `new Date(string)`: that interprets the value in the
 * runtime's timezone, so the same input would produce a different instant on a
 * tablet set to Europe than on one set to Muscat.
 */
export function fromMuscatWallTime(value: string): EpochMs {
  const match = LOCAL_DATE_TIME.exec(value.trim());

  if (!match) {
    throw new DateTimeError(`Expected a date and time like 2026-09-10T11:00, received: ${value}`);
  }

  const [, year, month, day, hour, minute] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  assertRealDate(year, month, day);

  if (hour > 23 || minute > 59) {
    throw new DateTimeError(`Invalid time in: ${value}`);
  }

  return Date.UTC(year, month - 1, day, hour, minute) - MUSCAT_UTC_OFFSET_MINUTES * MS_PER_MINUTE;
}

/** Midnight at the start of a boutique-local calendar day, as an instant. */
export function startOfMuscatDay(isoDate: string): EpochMs {
  const match = LOCAL_DATE.exec(isoDate.trim());

  if (!match) {
    throw new DateTimeError(`Expected a date like 2026-09-10, received: ${isoDate}`);
  }

  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  assertRealDate(year, month, day);

  return Date.UTC(year, month - 1, day) - MUSCAT_UTC_OFFSET_MINUTES * MS_PER_MINUTE;
}

function assertRealDate(year: number, month: number, day: number): void {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new DateTimeError(`Invalid date: ${year}-${month}-${day}`);
  }

  const probe = new Date(Date.UTC(year, month - 1, day));

  // Rejects 2026-02-30 rather than letting it roll over to 2 March.
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new DateTimeError(`That date does not exist: ${year}-${month}-${day}`);
  }
}

/* ------------------------------------------------------------------------ *
 * Rendering boutique-local wall time
 * ------------------------------------------------------------------------ */

/** The boutique-local calendar day an instant falls on, as `YYYY-MM-DD`. */
export function toMuscatDate(instant: EpochMs): string {
  const shifted = new Date(instant + MUSCAT_UTC_OFFSET_MINUTES * MS_PER_MINUTE);

  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/** Boutique-local wall time as `HH:MM`. */
export function toMuscatTime(instant: EpochMs): string {
  const shifted = new Date(instant + MUSCAT_UTC_OFFSET_MINUTES * MS_PER_MINUTE);

  const hour = String(shifted.getUTCHours()).padStart(2, '0');
  const minute = String(shifted.getUTCMinutes()).padStart(2, '0');

  return `${hour}:${minute}`;
}

/** Boutique-local wall time as `YYYY-MM-DDTHH:MM`, for form inputs. */
export function toMuscatWallTime(instant: EpochMs): string {
  return `${toMuscatDate(instant)}T${toMuscatTime(instant)}`;
}

/* ------------------------------------------------------------------------ *
 * Arithmetic
 * ------------------------------------------------------------------------ */

/**
 * Add whole days.
 *
 * Because Oman has no DST, adding 24-hour blocks and adding calendar days are
 * the same operation — there is no hour that repeats or goes missing. In a
 * DST-observing timezone this would need calendar arithmetic instead, and the
 * cleaning buffer would drift by an hour twice a year.
 */
export function addDays(instant: EpochMs, days: number): EpochMs {
  if (!Number.isInteger(days)) {
    throw new DateTimeError(`Days must be a whole number, received: ${days}`);
  }
  return instant + days * MS_PER_DAY;
}

/**
 * Whole days from `from` to `to`, rounded **up**.
 *
 * Used for late fees: a dress returned three hours late is one day late, not
 * zero. Returns 0 when `to` is at or before `from`.
 */
export function daysLate(scheduled: EpochMs, actual: EpochMs): number {
  if (actual <= scheduled) return 0;
  return Math.ceil((actual - scheduled) / MS_PER_DAY);
}

/** Calendar days between two boutique-local dates, ignoring time of day. */
export function calendarDaysBetween(from: EpochMs, to: EpochMs): number {
  const fromMidnight = startOfMuscatDay(toMuscatDate(from));
  const toMidnight = startOfMuscatDay(toMuscatDate(to));
  return Math.round((toMidnight - fromMidnight) / MS_PER_DAY);
}

/** Format an instant for display, e.g. `10 Sep 2026, 11:00`. */
export function formatMuscat(instant: EpochMs, language: 'en' | 'ar' = 'en'): string {
  return new Intl.DateTimeFormat(language === 'ar' ? 'ar-OM' : 'en-GB', {
    timeZone: MUSCAT_TIMEZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    // Latin digits even in Arabic: a date on an invoice must be unambiguous.
    numberingSystem: 'latn',
  }).format(new Date(instant));
}

/** Format the date part only. */
export function formatMuscatDate(instant: EpochMs, language: 'en' | 'ar' = 'en'): string {
  return new Intl.DateTimeFormat(language === 'ar' ? 'ar-OM' : 'en-GB', {
    timeZone: MUSCAT_TIMEZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    numberingSystem: 'latn',
  }).format(new Date(instant));
}
