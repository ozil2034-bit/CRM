/**
 * Customer domain rules.
 *
 * Measurements, language preference, archiving and — the part that carries real
 * operational weight — how duplicate phone numbers are handled.
 *
 * Pure: no I/O, no Firebase, no clock.
 */

export const PREFERRED_LANGUAGES = ['en', 'ar', 'bilingual'] as const;
export type PreferredLanguage = (typeof PREFERRED_LANGUAGES)[number];

export function isPreferredLanguage(value: unknown): value is PreferredLanguage {
  return typeof value === 'string' && (PREFERRED_LANGUAGES as readonly string[]).includes(value);
}

export const CUSTOMER_SOURCES = [
  'Walk-in',
  'Referral',
  'Instagram',
  'WhatsApp',
  'Wedding fair',
  'Returning customer',
  'Other',
] as const;

export type CustomerSource = (typeof CUSTOMER_SOURCES)[number];

/* ------------------------------------------------------------------------ *
 * Measurements
 * ------------------------------------------------------------------------ */

export interface CustomerMeasurements {
  readonly bust: number | null;
  readonly waist: number | null;
  readonly hips: number | null;
  readonly height: number | null;
  readonly shoeSize: number | null;
}

export const EMPTY_CUSTOMER_MEASUREMENTS: CustomerMeasurements = {
  bust: null,
  waist: null,
  hips: null,
  height: null,
  shoeSize: null,
};

/**
 * Bounds are generous by design. These reject a misplaced decimal point or a
 * value typed into the wrong field — not an unusual body.
 */
export const MEASUREMENT_BOUNDS = {
  bust: { min: 40, max: 250 },
  waist: { min: 30, max: 250 },
  hips: { min: 40, max: 250 },
  height: { min: 80, max: 250 },
  shoeSize: { min: 20, max: 55 },
} as const;

export type MeasurementField = keyof CustomerMeasurements;

export function isValidCustomerMeasurement(field: MeasurementField, value: number | null): boolean {
  if (value === null) return true;
  if (!Number.isFinite(value)) return false;

  const bounds = MEASUREMENT_BOUNDS[field];
  return value >= bounds.min && value <= bounds.max;
}

export function findMeasurementProblems(measurements: CustomerMeasurements): MeasurementField[] {
  const problems: MeasurementField[] = [];

  for (const field of Object.keys(MEASUREMENT_BOUNDS) as MeasurementField[]) {
    if (!isValidCustomerMeasurement(field, measurements[field])) {
      problems.push(field);
    }
  }

  return problems;
}

/* ------------------------------------------------------------------------ *
 * Names
 * ------------------------------------------------------------------------ */

/**
 * A customer must be identifiable by at least one name.
 *
 * Either script satisfies this. Requiring both would force staff to
 * transliterate on the spot, which produces inconsistent records and slows down
 * the counter.
 */
export function hasUsableName(nameEn: string, nameAr: string): boolean {
  return nameEn.trim().length > 0 || nameAr.trim().length > 0;
}

/** The name to show, given the interface language and what the record holds. */
export function displayName(
  customer: { readonly nameEn: string; readonly nameAr: string },
  language: 'en' | 'ar',
): string {
  const preferred = language === 'ar' ? customer.nameAr : customer.nameEn;
  const fallback = language === 'ar' ? customer.nameEn : customer.nameAr;

  return preferred.trim().length > 0 ? preferred.trim() : fallback.trim();
}

export function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/* ------------------------------------------------------------------------ *
 * Duplicate phone handling
 * ------------------------------------------------------------------------ */

export interface ExistingCustomerSummary {
  readonly id: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly phoneNormalized: string;
  readonly archived: boolean;
}

export type DuplicateSeverity = 'none' | 'warn' | 'block';

export interface DuplicateVerdict {
  readonly severity: DuplicateSeverity;
  readonly matches: readonly ExistingCustomerSummary[];
  readonly reason: 'NONE' | 'SHARED_NUMBER' | 'SAME_RECORD';
}

/**
 * Decide what to do about a phone number that already exists.
 *
 * The specification is explicit in both directions: never silently create a
 * second customer on the same number, but never block legitimate family or
 * shared numbers either. So this **warns and names the existing customers**,
 * and the employee decides.
 *
 * A sister booking on the family landline is ordinary; a staff member creating
 * the same bride twice because search did not find her is the actual failure
 * this prevents. Showing who already holds the number lets them tell the
 * difference — a bare "duplicate" warning would not.
 *
 * `block` is reserved for the one genuinely wrong case: editing a customer to
 * take a number that is already on a *different* record would leave two records
 * indistinguishable by the field staff search by most.
 */
export function evaluateDuplicatePhone(
  phoneNormalized: string,
  existing: readonly ExistingCustomerSummary[],
  options: { readonly editingCustomerId?: string | undefined } = {},
): DuplicateVerdict {
  const matches = existing.filter((candidate) => candidate.phoneNormalized === phoneNormalized);

  if (matches.length === 0) {
    return { severity: 'none', matches: [], reason: 'NONE' };
  }

  const editingId = options.editingCustomerId;

  if (editingId !== undefined) {
    const others = matches.filter((match) => match.id !== editingId);

    if (others.length === 0) {
      // The only match is the record being edited — the number has not changed.
      return { severity: 'none', matches: [], reason: 'SAME_RECORD' };
    }

    return { severity: 'warn', matches: others, reason: 'SHARED_NUMBER' };
  }

  return { severity: 'warn', matches, reason: 'SHARED_NUMBER' };
}

/* ------------------------------------------------------------------------ *
 * Event date
 * ------------------------------------------------------------------------ */

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a `YYYY-MM-DD` calendar date.
 *
 * Checks the parts round-trip, so `2026-02-30` is rejected rather than silently
 * becoming 2 March.
 */
export function isValidCalendarDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;

  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Is an event date plausible?
 *
 * A wedding date in the past is accepted — staff enter historical customers, and
 * a dress is often returned after the event. Absurdly distant dates are
 * rejected as typos.
 */
export function isPlausibleEventDate(value: string, today: string): boolean {
  if (!isValidCalendarDate(value)) return false;
  if (!isValidCalendarDate(today)) return false;

  const eventYear = Number(value.slice(0, 4));
  const currentYear = Number(today.slice(0, 4));

  return eventYear >= currentYear - 10 && eventYear <= currentYear + 10;
}

/* ------------------------------------------------------------------------ *
 * Archiving
 * ------------------------------------------------------------------------ */

/**
 * Customers are archived, never deleted.
 *
 * Reservations, payments and invoices reference a customer, and those records
 * must stay resolvable for the financial history to mean anything. Archiving
 * removes them from everyday lists and leaves the history intact.
 */
export function isSelectableForNewWork(customer: { readonly archived: boolean }): boolean {
  return !customer.archived;
}

/* ------------------------------------------------------------------------ *
 * Search text
 * ------------------------------------------------------------------------ */

export interface CustomerSearchableFields {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly phoneNormalized: string;
  readonly email: string;
}

/**
 * The fields fed to `buildSearchTokens` when a customer is written.
 *
 * National ID is deliberately absent. It identifies a person to the state and
 * has no business being reachable by a partial-match search from any staff
 * screen.
 */
export function customerSearchFields(customer: CustomerSearchableFields): string[] {
  return [
    customer.code,
    customer.nameEn,
    customer.nameAr,
    customer.phoneNormalized,
    customer.email,
  ];
}
