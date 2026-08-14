/**
 * Configurable settings.
 *
 * The commercial decisions that belong to the boutique rather than to the code:
 * the VAT rate, what share of a rental must be paid before a gown leaves, what
 * a late day costs, and the cancellation scale.
 *
 * ## Changes apply forward only
 *
 * Every one of these is **read once and frozen** onto the record it affects: the
 * VAT rate onto the reservation's pricing snapshot, the cancellation tier onto
 * the cancellation event, the late-fee rate onto the fee. Changing a setting
 * therefore cannot reach back into a booking a customer already agreed to, and
 * nothing here needs to know that — the engines that read these values already
 * snapshot them.
 *
 * That is why this module validates but never migrates.
 *
 * ## Why the VAT rate is a closed set
 *
 * Oman's standard rate is 5%, with zero-rating for some supplies. A rate outside
 * that set is a configuration mistake, not a commercial decision — and an
 * invoice carrying the wrong VAT rate is a matter for the tax authority. The
 * rules enforce the same constraint, because a screen is not a control.
 *
 * Pure: no I/O, no Firebase, no clock.
 */

import type { CancellationTier } from './cancellation';

/* ------------------------------------------------------------------------ *
 * The shape
 * ------------------------------------------------------------------------ */

/** The VAT rates the boutique may actually charge. */
export const PERMITTED_VAT_RATES = [0, 5] as const;
export type VatRate = (typeof PERMITTED_VAT_RATES)[number];

export function isPermittedVatRate(value: unknown): value is VatRate {
  return value === 0 || value === 5;
}

export interface AppSettings {
  /** Percent. Only 0 or 5; see the module note. */
  readonly vatRatePercent: number;
  /** Baisa per day a gown is late. */
  readonly lateFeePerDay: number;
  /** Share of the rental required before a gown may leave, 0–100. */
  readonly minPickupPaymentPercent: number;
  /** Days a returned gown is unavailable while it is cleaned. */
  readonly defaultCleaningBufferDays: number;
  readonly cancellationTiers: readonly CancellationTier[];
}

/**
 * What an unconfigured boutique gets.
 *
 * **Zero VAT, zero late fee, no cancellation tiers.** Every one of those is the
 * honest default: inventing 5% would put a tax on an invoice nobody set, and
 * inventing a cancellation scale would let the system keep a customer's money
 * under a rule the boutique never agreed. A buffer of 2 days is an operational
 * convenience, not money, and is the one value it is safe to suggest.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  vatRatePercent: 0,
  lateFeePerDay: 0,
  minPickupPaymentPercent: 0,
  defaultCleaningBufferDays: 2,
  cancellationTiers: [],
};

/**
 * The settings a **critical-change confirmation** must be shown for.
 *
 * Each one silently changes what a future customer is charged or what the
 * boutique may keep. An employee should have to acknowledge that before it
 * takes effect — not because they might not mean it, but because they should
 * know the change is forward-only.
 */
export const CRITICAL_SETTINGS = [
  'vatRatePercent',
  'lateFeePerDay',
  'minPickupPaymentPercent',
  'cancellationTiers',
] as const;

export type CriticalSetting = (typeof CRITICAL_SETTINGS)[number];

/** Which critical settings differ between two versions. */
export function criticalChanges(
  before: AppSettings,
  after: AppSettings,
): CriticalSetting[] {
  const changed: CriticalSetting[] = [];

  if (before.vatRatePercent !== after.vatRatePercent) changed.push('vatRatePercent');
  if (before.lateFeePerDay !== after.lateFeePerDay) changed.push('lateFeePerDay');
  if (before.minPickupPaymentPercent !== after.minPickupPaymentPercent) {
    changed.push('minPickupPaymentPercent');
  }
  if (!sameTiers(before.cancellationTiers, after.cancellationTiers)) {
    changed.push('cancellationTiers');
  }

  return changed;
}

function sameTiers(
  a: readonly CancellationTier[],
  b: readonly CancellationTier[],
): boolean {
  if (a.length !== b.length) return false;

  return a.every((tier, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      tier.daysBeforeEvent === other.daysBeforeEvent &&
      tier.refundPercent === other.refundPercent
    );
  });
}

/* ------------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------------ */

export type SettingsProblem =
  | 'VAT_NOT_PERMITTED'
  | 'LATE_FEE_NEGATIVE'
  | 'LATE_FEE_NOT_WHOLE'
  | 'PICKUP_PERCENT_OUT_OF_RANGE'
  | 'BUFFER_NEGATIVE'
  | 'BUFFER_NOT_WHOLE'
  | 'TIER_DAYS_NEGATIVE'
  | 'TIER_DAYS_NOT_WHOLE'
  | 'TIER_PERCENT_OUT_OF_RANGE'
  | 'TIER_DAYS_DUPLICATED'
  | 'TIER_ORDER_INCOHERENT';

export const SETTINGS_PROBLEM_MESSAGES: Readonly<Record<SettingsProblem, string>> = {
  VAT_NOT_PERMITTED: 'The VAT rate must be 0% or 5%.',
  LATE_FEE_NEGATIVE: 'A late fee cannot be negative.',
  LATE_FEE_NOT_WHOLE: 'The late fee must be a whole number of baisa.',
  PICKUP_PERCENT_OUT_OF_RANGE: 'The minimum pickup payment must be between 0% and 100%.',
  BUFFER_NEGATIVE: 'The cleaning buffer cannot be negative.',
  BUFFER_NOT_WHOLE: 'The cleaning buffer must be a whole number of days.',
  TIER_DAYS_NEGATIVE: 'A cancellation tier cannot use negative days.',
  TIER_DAYS_NOT_WHOLE: 'A cancellation tier must use a whole number of days.',
  TIER_PERCENT_OUT_OF_RANGE: 'A refund percentage must be between 0% and 100%.',
  TIER_DAYS_DUPLICATED:
    'Two cancellation tiers use the same notice period, so which one applies is ambiguous.',
  TIER_ORDER_INCOHERENT:
    'A shorter notice period refunds more than a longer one, which cancelling earlier should never do.',
};

/**
 * Validate the cancellation scale.
 *
 * Three things must hold, and each has a concrete failure behind it:
 *
 * 1. **No two tiers share a notice period.** `selectTier` takes the most
 *    generous match; with a duplicate, which one applies depends on array order,
 *    and a customer's refund would depend on the order somebody typed rows in.
 * 2. **Percentages are 0–100.** Above 100 the boutique refunds more than it
 *    took.
 * 3. **More notice never refunds less.** A scale where cancelling 30 days out
 *    returns 25% but 7 days out returns 50% punishes the considerate customer,
 *    and is invariably a data-entry error rather than a policy.
 *
 * Overlap is impossible by construction: a tier is a *minimum notice*, not a
 * range, so `selectTier` always has exactly one most-generous match. Duplicates
 * are the only way to make it ambiguous, and they are refused.
 */
export function validateTiers(tiers: readonly CancellationTier[]): SettingsProblem[] {
  const problems: SettingsProblem[] = [];

  for (const tier of tiers) {
    if (!Number.isInteger(tier.daysBeforeEvent)) {
      problems.push('TIER_DAYS_NOT_WHOLE');
    } else if (tier.daysBeforeEvent < 0) {
      problems.push('TIER_DAYS_NEGATIVE');
    }

    if (
      !Number.isFinite(tier.refundPercent) ||
      tier.refundPercent < 0 ||
      tier.refundPercent > 100
    ) {
      problems.push('TIER_PERCENT_OUT_OF_RANGE');
    }
  }

  const days = tiers.map((tier) => tier.daysBeforeEvent);
  if (new Set(days).size !== days.length) {
    problems.push('TIER_DAYS_DUPLICATED');
  }

  // Sorted by notice, most generous first: the refund must not increase as the
  // notice shortens.
  const sorted = [...tiers].sort((a, b) => b.daysBeforeEvent - a.daysBeforeEvent);

  for (let index = 1; index < sorted.length; index += 1) {
    const longer = sorted[index - 1];
    const shorter = sorted[index];

    if (longer !== undefined && shorter !== undefined && shorter.refundPercent > longer.refundPercent) {
      problems.push('TIER_ORDER_INCOHERENT');
      break;
    }
  }

  return [...new Set(problems)];
}

/** Validate the whole settings document. Empty means it may be saved. */
export function validateSettings(settings: AppSettings): SettingsProblem[] {
  const problems: SettingsProblem[] = [];

  if (!isPermittedVatRate(settings.vatRatePercent)) {
    problems.push('VAT_NOT_PERMITTED');
  }

  if (!Number.isInteger(settings.lateFeePerDay)) {
    problems.push('LATE_FEE_NOT_WHOLE');
  } else if (settings.lateFeePerDay < 0) {
    problems.push('LATE_FEE_NEGATIVE');
  }

  if (
    !Number.isFinite(settings.minPickupPaymentPercent) ||
    settings.minPickupPaymentPercent < 0 ||
    settings.minPickupPaymentPercent > 100
  ) {
    problems.push('PICKUP_PERCENT_OUT_OF_RANGE');
  }

  if (!Number.isInteger(settings.defaultCleaningBufferDays)) {
    problems.push('BUFFER_NOT_WHOLE');
  } else if (settings.defaultCleaningBufferDays < 0) {
    problems.push('BUFFER_NEGATIVE');
  }

  return [...problems, ...validateTiers(settings.cancellationTiers)];
}

/* ------------------------------------------------------------------------ *
 * Numbering prefixes
 * ------------------------------------------------------------------------ */

export type PrefixProblem = 'PREFIX_EMPTY' | 'PREFIX_TOO_LONG' | 'PREFIX_INVALID_CHARACTERS';

export const PREFIX_PROBLEM_MESSAGES: Readonly<Record<PrefixProblem, string>> = {
  PREFIX_EMPTY: 'A prefix is required.',
  PREFIX_TOO_LONG: 'A prefix may be at most 6 characters.',
  PREFIX_INVALID_CHARACTERS: 'A prefix may contain only letters A–Z.',
};

const MAX_PREFIX_LENGTH = 6;

/**
 * Validate a record-number prefix.
 *
 * Letters only, because the digits after it are the sequence and a prefix
 * containing digits makes `INV-2026-0001` ambiguous to read and to parse.
 * Changing a prefix affects **future records only** — every existing code is
 * already stored on its record, and `parseRecordNumber` reads the format that
 * produced it.
 */
export function validatePrefix(prefix: string): PrefixProblem | null {
  const trimmed = prefix.trim();

  if (trimmed.length === 0) return 'PREFIX_EMPTY';
  if (trimmed.length > MAX_PREFIX_LENGTH) return 'PREFIX_TOO_LONG';
  if (!/^[A-Za-z]+$/.test(trimmed)) return 'PREFIX_INVALID_CHARACTERS';

  return null;
}

/* ------------------------------------------------------------------------ *
 * Notification preferences
 * ------------------------------------------------------------------------ */

/**
 * When a reminder would be due, relative to the thing it is about.
 *
 * **Stored, not scheduled.** There is no timer, no cron and no background
 * worker in this architecture, and a client-side `setTimeout` that fires only
 * while somebody happens to have the tab open is worse than nothing: it would
 * make reminders arrive for whichever employee left a browser running.
 *
 * So a preference records the boutique's *intent* — "remind two days before
 * pickup" — and the dashboard surfaces what is due. An employee still presses
 * the button. When scheduled execution becomes part of the architecture, these
 * values are what it reads.
 */
export interface ReminderPreference {
  readonly kind: 'fitting' | 'pickup' | 'return' | 'overdue' | 'balance';
  readonly enabled: boolean;
  /** Days before (or, for overdue, after) the event. */
  readonly daysOffset: number;
}

export const DEFAULT_REMINDERS: readonly ReminderPreference[] = [
  { kind: 'fitting', enabled: true, daysOffset: 1 },
  { kind: 'pickup', enabled: true, daysOffset: 1 },
  { kind: 'return', enabled: true, daysOffset: 1 },
  { kind: 'overdue', enabled: true, daysOffset: 1 },
  { kind: 'balance', enabled: false, daysOffset: 7 },
];

export function validateReminder(preference: ReminderPreference): boolean {
  return (
    Number.isInteger(preference.daysOffset) &&
    preference.daysOffset >= 0 &&
    preference.daysOffset <= 90
  );
}
