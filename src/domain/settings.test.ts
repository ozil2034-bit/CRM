import { describe, expect, it } from 'vitest';

import {
  criticalChanges,
  isPermittedVatRate,
  validatePrefix,
  validateReminder,
  validateSettings,
  validateTiers,
  DEFAULT_REMINDERS,
  DEFAULT_SETTINGS,
  type AppSettings,
} from './settings';
import type { CancellationTier } from './cancellation';

const tier = (daysBeforeEvent: number, refundPercent: number): CancellationTier => ({
  daysBeforeEvent,
  refundPercent,
  label: { en: `${String(daysBeforeEvent)} days`, ar: `${String(daysBeforeEvent)} يوم` },
});

const settings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  ...DEFAULT_SETTINGS,
  ...overrides,
});

/* ------------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------------ */

describe('what an unconfigured boutique gets', () => {
  it('invents NO VAT, NO late fee and NO cancellation scale', () => {
    /*
     * Load-bearing. Inventing 5% would put a tax on an invoice nobody set, and
     * inventing a cancellation scale would let the system keep a customer's
     * money under a rule the boutique never agreed.
     */
    expect(DEFAULT_SETTINGS.vatRatePercent).toBe(0);
    expect(DEFAULT_SETTINGS.lateFeePerDay).toBe(0);
    expect(DEFAULT_SETTINGS.cancellationTiers).toEqual([]);
  });

  it('is itself valid, so a fresh boutique is never in an error state', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * VAT
 * ------------------------------------------------------------------------ */

describe('the VAT rate', () => {
  it('permits only 0% and 5%', () => {
    expect(isPermittedVatRate(0)).toBe(true);
    expect(isPermittedVatRate(5)).toBe(true);
  });

  it('REFUSES any other rate — an invoice with the wrong VAT is a tax matter', () => {
    for (const rate of [1, 4.9, 5.5, 10, 15, -5, Number.NaN]) {
      expect(isPermittedVatRate(rate)).toBe(false);
    }
  });

  it('reports the refusal through validateSettings', () => {
    expect(validateSettings(settings({ vatRatePercent: 15 }))).toContain('VAT_NOT_PERMITTED');
  });
});

/* ------------------------------------------------------------------------ *
 * Money and percentages
 * ------------------------------------------------------------------------ */

describe('the late fee', () => {
  it('must be whole baisa', () => {
    expect(validateSettings(settings({ lateFeePerDay: 10_000.5 }))).toContain(
      'LATE_FEE_NOT_WHOLE',
    );
  });

  it('cannot be negative — a late return does not earn the customer money', () => {
    expect(validateSettings(settings({ lateFeePerDay: -1 }))).toContain('LATE_FEE_NEGATIVE');
  });

  it('may be zero, for a boutique that does not charge one', () => {
    expect(validateSettings(settings({ lateFeePerDay: 0 }))).toEqual([]);
  });
});

describe('the minimum pickup payment', () => {
  it('must be between 0 and 100', () => {
    expect(validateSettings(settings({ minPickupPaymentPercent: 101 }))).toContain(
      'PICKUP_PERCENT_OUT_OF_RANGE',
    );
    expect(validateSettings(settings({ minPickupPaymentPercent: -1 }))).toContain(
      'PICKUP_PERCENT_OUT_OF_RANGE',
    );
  });

  it('accepts both ends', () => {
    expect(validateSettings(settings({ minPickupPaymentPercent: 0 }))).toEqual([]);
    expect(validateSettings(settings({ minPickupPaymentPercent: 100 }))).toEqual([]);
  });
});

describe('the cleaning buffer', () => {
  it('must be a whole, non-negative number of days', () => {
    expect(validateSettings(settings({ defaultCleaningBufferDays: 1.5 }))).toContain(
      'BUFFER_NOT_WHOLE',
    );
    expect(validateSettings(settings({ defaultCleaningBufferDays: -1 }))).toContain(
      'BUFFER_NEGATIVE',
    );
  });
});

/* ------------------------------------------------------------------------ *
 * The cancellation scale
 * ------------------------------------------------------------------------ */

describe('the cancellation scale', () => {
  it('accepts a coherent scale', () => {
    expect(validateTiers([tier(30, 100), tier(14, 50), tier(7, 25)])).toEqual([]);
  });

  it('accepts an empty scale — a boutique may refund nothing by default', () => {
    expect(validateTiers([])).toEqual([]);
  });

  it('REFUSES two tiers with the same notice period', () => {
    /*
     * selectTier takes the most generous match. With a duplicate, which one
     * applies depends on array order — so a customer's refund would depend on
     * the order somebody typed rows in.
     */
    expect(validateTiers([tier(14, 50), tier(14, 25)])).toContain('TIER_DAYS_DUPLICATED');
  });

  it('REFUSES a scale where cancelling EARLIER refunds LESS', () => {
    // Punishing the considerate customer is invariably a data-entry error.
    expect(validateTiers([tier(30, 25), tier(7, 50)])).toContain('TIER_ORDER_INCOHERENT');
  });

  it('accepts equal percentages at different notice periods', () => {
    // Flat within a band is a policy, not an error.
    expect(validateTiers([tier(30, 50), tier(14, 50)])).toEqual([]);
  });

  it('validates regardless of the order the tiers were entered in', () => {
    expect(validateTiers([tier(7, 25), tier(30, 100), tier(14, 50)])).toEqual([]);
    expect(validateTiers([tier(7, 50), tier(30, 25)])).toContain('TIER_ORDER_INCOHERENT');
  });

  it('refuses a refund above 100% — the boutique would return more than it took', () => {
    expect(validateTiers([tier(30, 150)])).toContain('TIER_PERCENT_OUT_OF_RANGE');
  });

  it('refuses a negative refund', () => {
    expect(validateTiers([tier(30, -10)])).toContain('TIER_PERCENT_OUT_OF_RANGE');
  });

  it('refuses negative or fractional notice periods', () => {
    expect(validateTiers([tier(-5, 50)])).toContain('TIER_DAYS_NEGATIVE');
    expect(validateTiers([tier(7.5, 50)])).toContain('TIER_DAYS_NOT_WHOLE');
  });

  it('accepts a zero-day tier — cancelling on the day itself is a real case', () => {
    expect(validateTiers([tier(30, 100), tier(0, 0)])).toEqual([]);
  });

  it('reports each distinct problem once, however many rows are wrong', () => {
    const problems = validateTiers([tier(30, 150), tier(14, 200)]);

    expect(problems.filter((entry) => entry === 'TIER_PERCENT_OUT_OF_RANGE')).toHaveLength(1);
  });

  it('surfaces tier problems through validateSettings', () => {
    expect(validateSettings(settings({ cancellationTiers: [tier(30, 150)] }))).toContain(
      'TIER_PERCENT_OUT_OF_RANGE',
    );
  });
});

/* ------------------------------------------------------------------------ *
 * Critical changes
 * ------------------------------------------------------------------------ */

describe('which changes need a confirmation', () => {
  it('reports nothing when nothing moved', () => {
    expect(criticalChanges(DEFAULT_SETTINGS, DEFAULT_SETTINGS)).toEqual([]);
  });

  it('catches a VAT change', () => {
    expect(criticalChanges(DEFAULT_SETTINGS, settings({ vatRatePercent: 5 }))).toEqual([
      'vatRatePercent',
    ]);
  });

  it('catches a late-fee, threshold or tier change', () => {
    expect(criticalChanges(DEFAULT_SETTINGS, settings({ lateFeePerDay: 5_000 }))).toEqual([
      'lateFeePerDay',
    ]);
    expect(
      criticalChanges(DEFAULT_SETTINGS, settings({ minPickupPaymentPercent: 50 })),
    ).toEqual(['minPickupPaymentPercent']);
    expect(
      criticalChanges(DEFAULT_SETTINGS, settings({ cancellationTiers: [tier(30, 100)] })),
    ).toEqual(['cancellationTiers']);
  });

  it('does NOT treat the cleaning buffer as critical — it is not money', () => {
    expect(
      criticalChanges(DEFAULT_SETTINGS, settings({ defaultCleaningBufferDays: 5 })),
    ).toEqual([]);
  });

  it('notices a tier whose percentage changed but whose days did not', () => {
    const before = settings({ cancellationTiers: [tier(30, 100)] });
    const after = settings({ cancellationTiers: [tier(30, 50)] });

    expect(criticalChanges(before, after)).toEqual(['cancellationTiers']);
  });

  it('reports several at once', () => {
    const after = settings({ vatRatePercent: 5, lateFeePerDay: 5_000 });

    expect(criticalChanges(DEFAULT_SETTINGS, after)).toEqual([
      'vatRatePercent',
      'lateFeePerDay',
    ]);
  });
});

/* ------------------------------------------------------------------------ *
 * Prefixes
 * ------------------------------------------------------------------------ */

describe('a record-number prefix', () => {
  it('accepts ordinary letters', () => {
    expect(validatePrefix('RSV')).toBeNull();
    expect(validatePrefix('INV')).toBeNull();
  });

  it('refuses an empty prefix', () => {
    expect(validatePrefix('   ')).toBe('PREFIX_EMPTY');
  });

  it('refuses digits — they make a code ambiguous to read and to parse', () => {
    expect(validatePrefix('RSV1')).toBe('PREFIX_INVALID_CHARACTERS');
    expect(validatePrefix('R-V')).toBe('PREFIX_INVALID_CHARACTERS');
  });

  it('refuses an over-long prefix', () => {
    expect(validatePrefix('ABCDEFG')).toBe('PREFIX_TOO_LONG');
  });
});

/* ------------------------------------------------------------------------ *
 * Reminders
 * ------------------------------------------------------------------------ */

describe('reminder preferences', () => {
  it('accepts the shipped defaults', () => {
    for (const preference of DEFAULT_REMINDERS) {
      expect(validateReminder(preference)).toBe(true);
    }
  });

  it('accepts a zero offset — a reminder on the day itself', () => {
    expect(validateReminder({ kind: 'pickup', enabled: true, daysOffset: 0 })).toBe(true);
  });

  it('refuses a negative or fractional offset', () => {
    expect(validateReminder({ kind: 'pickup', enabled: true, daysOffset: -1 })).toBe(false);
    expect(validateReminder({ kind: 'pickup', enabled: true, daysOffset: 1.5 })).toBe(false);
  });

  it('refuses an absurd horizon', () => {
    expect(validateReminder({ kind: 'pickup', enabled: true, daysOffset: 365 })).toBe(false);
  });
});
