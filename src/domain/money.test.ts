import { describe, it, expect } from 'vitest';
import {
  BAISA_PER_OMR,
  MAX_BAISA,
  MoneyError,
  OMR_DECIMALS,
  ZERO,
  abs,
  add,
  allocate,
  baisa,
  clampToZero,
  compare,
  formatOmr,
  formatOmrPlain,
  isBaisa,
  isNegative,
  isPositive,
  isZero,
  max,
  min,
  multiply,
  negate,
  parseOmr,
  percentOf,
  roundedDivide,
  subtract,
  sum,
  toInputValue,
  tryParseOmr,
  type Baisa,
} from './money';

/** Test helper: OMR value → baisa, bypassing string parsing. */
const omr = (rials: number): Baisa => baisa(Math.round(rials * BAISA_PER_OMR));

describe('money — constants', () => {
  it('models OMR as a three-decimal currency', () => {
    expect(BAISA_PER_OMR).toBe(1000);
    expect(OMR_DECIMALS).toBe(3);
    expect(ZERO).toBe(0);
  });
});

describe('baisa()', () => {
  it('accepts integers', () => {
    expect(baisa(180000)).toBe(180000);
    expect(baisa(0)).toBe(0);
    expect(baisa(-5500)).toBe(-5500);
  });

  it('rejects non-integers — the value must already be in minor units', () => {
    expect(() => baisa(180.5)).toThrow(MoneyError);
    expect(() => baisa(0.1)).toThrow(/integer number of baisa/);
  });

  it('rejects non-finite values', () => {
    expect(() => baisa(Number.NaN)).toThrow(/finite/);
    expect(() => baisa(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => baisa(Number.NEGATIVE_INFINITY)).toThrow(/finite/);
  });

  it('rejects values beyond the supported maximum', () => {
    expect(() => baisa(MAX_BAISA + 1)).toThrow(/maximum/);
    expect(() => baisa(-MAX_BAISA - 1)).toThrow(/maximum/);
    expect(baisa(MAX_BAISA)).toBe(MAX_BAISA);
  });
});

describe('isBaisa()', () => {
  it('identifies valid amounts without throwing', () => {
    expect(isBaisa(180000)).toBe(true);
    expect(isBaisa(0)).toBe(true);
    expect(isBaisa(-1)).toBe(true);
  });

  it('rejects anything that is not a safe integer amount', () => {
    expect(isBaisa(180.5)).toBe(false);
    expect(isBaisa(Number.NaN)).toBe(false);
    expect(isBaisa(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isBaisa(MAX_BAISA + 1)).toBe(false);
    expect(isBaisa('180000')).toBe(false);
    expect(isBaisa(null)).toBe(false);
    expect(isBaisa(undefined)).toBe(false);
    expect(isBaisa({})).toBe(false);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(add(omr(180), omr(20))).toBe(200000);
    expect(subtract(omr(180), omr(20))).toBe(160000);
    expect(subtract(omr(20), omr(180))).toBe(-160000);
  });

  it('does not drift when summing many fractional line items', () => {
    // 0.1 + 0.2 !== 0.3 in floating point. In baisa it is exact.
    const lines = [baisa(100), baisa(200)];
    expect(sum(lines)).toBe(300);

    // Ten lines of OMR 0.001 are exactly OMR 0.010 — no accumulated error.
    const tenth = Array.from({ length: 10 }, () => baisa(1));
    expect(sum(tenth)).toBe(10);

    // A realistic invoice: 37 accessory lines at OMR 12.345
    const many = Array.from({ length: 37 }, () => baisa(12345));
    expect(sum(many)).toBe(12345 * 37);
  });

  it('sums an empty list to zero', () => {
    expect(sum([])).toBe(0);
  });

  it('multiplies by whole quantities', () => {
    expect(multiply(omr(45), 3)).toBe(135000);
    expect(multiply(omr(45), 0)).toBe(0);
  });

  it('rejects fractional quantities', () => {
    expect(() => multiply(omr(45), 1.5)).toThrow(/Quantity must be an integer/);
  });

  it('negates and takes absolute values', () => {
    expect(negate(omr(45))).toBe(-45000);
    expect(negate(baisa(-45000))).toBe(45000);
    expect(abs(baisa(-45000))).toBe(45000);
    expect(abs(omr(45))).toBe(45000);
  });

  it('reports sign predicates', () => {
    expect(isZero(ZERO)).toBe(true);
    expect(isZero(omr(1))).toBe(false);
    expect(isPositive(omr(1))).toBe(true);
    expect(isPositive(ZERO)).toBe(false);
    expect(isNegative(baisa(-1))).toBe(true);
    expect(isNegative(ZERO)).toBe(false);
  });

  it('compares amounts', () => {
    expect(compare(omr(1), omr(2))).toBe(-1);
    expect(compare(omr(2), omr(1))).toBe(1);
    expect(compare(omr(2), omr(2))).toBe(0);
  });

  it('selects maxima and minima', () => {
    expect(max(omr(1), omr(2))).toBe(2000);
    expect(max(omr(2), omr(1))).toBe(2000);
    expect(min(omr(1), omr(2))).toBe(1000);
    expect(min(omr(2), omr(1))).toBe(1000);
  });

  it('clamps negative balances to zero', () => {
    // An overpaid reservation owes nothing; it does not owe a negative amount.
    expect(clampToZero(baisa(-5000))).toBe(0);
    expect(clampToZero(omr(5))).toBe(5000);
    expect(clampToZero(ZERO)).toBe(0);
  });
});

describe('roundedDivide() — half away from zero', () => {
  it('rounds halves away from zero', () => {
    expect(roundedDivide(5, 2)).toBe(3); // 2.5 → 3
    expect(roundedDivide(3, 2)).toBe(2); // 1.5 → 2
    expect(roundedDivide(1, 2)).toBe(1); // 0.5 → 1
  });

  it('rounds below the halfway point downward', () => {
    expect(roundedDivide(4, 3)).toBe(1); // 1.33 → 1
    expect(roundedDivide(5, 3)).toBe(2); // 1.67 → 2
  });

  it('divides exactly when there is no remainder', () => {
    expect(roundedDivide(10, 2)).toBe(5);
    expect(roundedDivide(0, 7)).toBe(0);
  });

  it('is symmetric across zero, so refunds mirror charges', () => {
    expect(roundedDivide(-5, 2)).toBe(-3);
    expect(roundedDivide(-3, 2)).toBe(-2);
    expect(roundedDivide(5, -2)).toBe(-3);
    expect(roundedDivide(-5, -2)).toBe(3);
  });

  it('rejects division by zero', () => {
    expect(() => roundedDivide(5, 0)).toThrow(/Division by zero/);
  });

  it('rejects non-integer operands', () => {
    expect(() => roundedDivide(5.5, 2)).toThrow(/requires integers/);
    expect(() => roundedDivide(5, 2.5)).toThrow(/requires integers/);
  });

  it('refuses to silently lose precision on overflow', () => {
    expect(() => roundedDivide(Number.MAX_SAFE_INTEGER, 1)).toThrow(/safe integer/);
  });
});

describe('percentOf()', () => {
  it('computes 5% VAT', () => {
    expect(percentOf(omr(180), 5)).toBe(9000); // OMR 9.000
    expect(percentOf(omr(100), 5)).toBe(5000);
  });

  it('returns zero for a 0% rate', () => {
    expect(percentOf(omr(180), 0)).toBe(0);
  });

  it('returns zero for a zero amount', () => {
    expect(percentOf(ZERO, 5)).toBe(0);
  });

  it('rounds once, deterministically, on amounts that do not divide evenly', () => {
    // 5% of 12.345 = 0.61725 → 617.25 baisa → 617
    expect(percentOf(baisa(12345), 5)).toBe(617);
    // 5% of 12.350 = 0.6175 → 617.5 baisa → 618 (half away from zero)
    expect(percentOf(baisa(12350), 5)).toBe(618);
  });

  it('supports fractional percentages', () => {
    expect(percentOf(omr(200), 2.5)).toBe(5000);
    expect(percentOf(omr(100), 0.5)).toBe(500);
  });

  it('handles 100% and values above 100%', () => {
    expect(percentOf(omr(180), 100)).toBe(180000);
    expect(percentOf(omr(180), 150)).toBe(270000);
  });

  it('applies to negative amounts symmetrically', () => {
    expect(percentOf(baisa(-12350), 5)).toBe(-618);
  });

  it('rejects a non-finite percentage', () => {
    expect(() => percentOf(omr(180), Number.NaN)).toThrow(/finite/);
    expect(() => percentOf(omr(180), Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});

describe('allocate()', () => {
  it('splits evenly when the amount divides exactly', () => {
    expect(allocate(omr(300), 3)).toEqual([100000, 100000, 100000]);
  });

  it('conserves every baisa when the amount does not divide evenly', () => {
    const parts = allocate(baisa(100), 3);
    expect(parts).toEqual([34, 33, 33]);
    expect(sum(parts)).toBe(100);
  });

  it('conserves value across many awkward splits', () => {
    for (const amount of [1, 7, 999, 12345, 180001]) {
      for (const count of [2, 3, 4, 7, 12]) {
        const parts = allocate(baisa(amount), count);
        expect(parts).toHaveLength(count);
        expect(sum(parts)).toBe(amount);
      }
    }
  });

  it('splits negative amounts, preserving sign and total', () => {
    const parts = allocate(baisa(-100), 3);
    expect(parts).toEqual([-34, -33, -33]);
    expect(sum(parts)).toBe(-100);
  });

  it('returns the whole amount as a single part', () => {
    expect(allocate(omr(180), 1)).toEqual([180000]);
  });

  it('rejects invalid part counts', () => {
    expect(() => allocate(omr(180), 0)).toThrow(/positive integer/);
    expect(() => allocate(omr(180), -1)).toThrow(/positive integer/);
    expect(() => allocate(omr(180), 2.5)).toThrow(/positive integer/);
  });
});

describe('parseOmr()', () => {
  it('parses whole rials', () => {
    expect(parseOmr('180')).toBe(180000);
    expect(parseOmr('0')).toBe(0);
  });

  it('pads partial decimals to three places', () => {
    expect(parseOmr('180.5')).toBe(180500);
    expect(parseOmr('180.05')).toBe(180050);
    expect(parseOmr('180.005')).toBe(180005);
  });

  it('parses full three-decimal precision', () => {
    expect(parseOmr('180.000')).toBe(180000);
    expect(parseOmr('0.001')).toBe(1);
    expect(parseOmr('0.500')).toBe(500);
  });

  it('accepts grouping separators and surrounding whitespace', () => {
    expect(parseOmr('1,180.000')).toBe(1180000);
    expect(parseOmr('  180.500  ')).toBe(180500);
    expect(parseOmr('1 180.000')).toBe(1180000);
  });

  it('parses signed amounts', () => {
    expect(parseOmr('-12.250')).toBe(-12250);
    expect(parseOmr('+12.250')).toBe(12250);
  });

  it('normalises Arabic-Indic digits', () => {
    expect(parseOmr('١٨٠.٥٠٠')).toBe(180500);
    expect(parseOmr('۱۸۰.۵۰۰')).toBe(180500); // Eastern Arabic-Indic
  });

  it('rejects more precision than OMR has — that is a data-entry error, not a rounding case', () => {
    expect(() => parseOmr('180.0005')).toThrow(MoneyError);
    expect(() => parseOmr('180.1234')).toThrow(/decimal places/);
  });

  it('rejects malformed input', () => {
    expect(() => parseOmr('')).toThrow(/empty/);
    expect(() => parseOmr('   ')).toThrow(/empty/);
    expect(() => parseOmr('abc')).toThrow(/not a valid OMR amount/);
    expect(() => parseOmr('180.')).toThrow(/not a valid OMR amount/);
    expect(() => parseOmr('.5')).toThrow(/not a valid OMR amount/);
    expect(() => parseOmr('1.2.3')).toThrow(/not a valid OMR amount/);
    expect(() => parseOmr('OMR 180')).toThrow(/not a valid OMR amount/);
  });

  it('rejects non-string input', () => {
    expect(() => parseOmr(180 as unknown as string)).toThrow(/Expected a string/);
    expect(() => parseOmr(null as unknown as string)).toThrow(/Expected a string/);
  });
});

describe('tryParseOmr()', () => {
  it('returns the amount for valid input', () => {
    expect(tryParseOmr('180.500')).toBe(180500);
  });

  it('returns null instead of throwing for invalid input', () => {
    expect(tryParseOmr('abc')).toBeNull();
    expect(tryParseOmr('180.0005')).toBeNull();
    expect(tryParseOmr('')).toBeNull();
  });
});

describe('formatOmr()', () => {
  it('always renders exactly three decimal places', () => {
    expect(formatOmr(omr(180))).toBe('OMR 180.000');
    expect(formatOmr(baisa(500))).toBe('OMR 0.500');
    expect(formatOmr(baisa(50))).toBe('OMR 0.050');
    expect(formatOmr(baisa(5))).toBe('OMR 0.005');
    expect(formatOmr(ZERO)).toBe('OMR 0.000');
  });

  it('never truncates a trailing zero', () => {
    // The failure this guards: rendering OMR 0.500 as "OMR 0.5".
    expect(formatOmr(baisa(500))).not.toBe('OMR 0.5');
    expect(formatOmr(omr(180))).not.toBe('OMR 180');
  });

  it('groups thousands', () => {
    expect(formatOmr(omr(1180))).toBe('OMR 1,180.000');
    expect(formatOmr(omr(1234567))).toBe('OMR 1,234,567.000');
  });

  it('omits grouping when asked', () => {
    expect(formatOmr(omr(1180), { grouping: false })).toBe('OMR 1180.000');
  });

  it('omits the currency code when asked', () => {
    expect(formatOmr(omr(180), { withCode: false })).toBe('180.000');
    expect(formatOmrPlain(omr(180))).toBe('180.000');
  });

  it('renders negative amounts with a leading minus', () => {
    expect(formatOmr(baisa(-180000))).toBe('OMR -180.000');
    expect(formatOmr(baisa(-500))).toBe('OMR -0.500');
  });

  it('renders an explicit plus only when requested and only when positive', () => {
    expect(formatOmr(omr(180), { signDisplay: true })).toBe('OMR +180.000');
    expect(formatOmr(ZERO, { signDisplay: true })).toBe('OMR 0.000');
    expect(formatOmr(baisa(-180000), { signDisplay: true })).toBe('OMR -180.000');
  });
});

describe('toInputValue()', () => {
  it('produces a value that round-trips through parseOmr', () => {
    for (const amount of [0, 5, 500, 180000, 1180000, -12250]) {
      const value = toInputValue(baisa(amount));
      expect(value).not.toMatch(/,/);
      expect(parseOmr(value)).toBe(amount);
    }
  });
});

describe('money — invoice-shaped scenario', () => {
  it('computes a reservation total with VAT excluded from the security deposit', () => {
    // Specification §11: the security deposit is not VAT taxable.
    const rental = parseOmr('180.000');
    const alterations = parseOmr('15.500');
    const accessories = parseOmr('22.250');
    const discount = parseOmr('10.000');
    const securityDeposit = parseOmr('100.000');

    const taxableSubtotal = subtract(sum([rental, alterations, accessories]), discount);
    expect(formatOmr(taxableSubtotal)).toBe('OMR 207.750');

    const vat = percentOf(taxableSubtotal, 5);
    expect(formatOmr(vat)).toBe('OMR 10.388'); // 10.3875 → 10.388

    const grandTotal = sum([taxableSubtotal, vat, securityDeposit]);
    expect(formatOmr(grandTotal)).toBe('OMR 318.138');

    // The deposit contributed nothing to VAT.
    const vatIfDepositWereTaxed = percentOf(add(taxableSubtotal, securityDeposit), 5);
    expect(vat).not.toBe(vatIfDepositWereTaxed);
  });

  it('leaves no residue when a balance is paid in instalments', () => {
    const balance = parseOmr('207.750');
    const instalments = allocate(balance, 3);
    expect(sum(instalments)).toBe(balance);
    expect(instalments.map((part) => formatOmrPlain(part))).toEqual(['69.250', '69.250', '69.250']);
  });
});
