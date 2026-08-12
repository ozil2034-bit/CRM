/**
 * Money — Omani Rial arithmetic in integer minor units.
 *
 * OMR has three decimal places: 1 OMR = 1000 baisa.
 *
 * Every monetary value in this system is an integer number of baisa. Nothing
 * stores, transmits or computes money as a fractional number of rials.
 *
 * Why: IEEE-754 cannot represent 0.1 exactly, so `0.1 + 0.2 !== 0.3`. Summing
 * invoice lines in floating point drifts, and a boutique cannot hand a customer
 * an invoice whose total is a fraction of a baisa away from its own line items.
 * Integers make the arithmetic exact and the rounding explicit.
 *
 * This module is pure: no I/O, no Firebase, no React, no clock.
 */

declare const baisaBrand: unique symbol;

/**
 * An integer quantity of baisa. 1 OMR = 1000 baisa, so `180000` is OMR 180.000.
 *
 * Branded so a plain `number` cannot be passed where money is expected — this
 * catches the classic error of storing `180` (rials) in a field that means baisa.
 */
export type Baisa = number & { readonly [baisaBrand]: true };

/** Minor units per rial. OMR is a three-decimal currency. */
export const BAISA_PER_OMR = 1000;

/** Decimal places OMR is always displayed with. */
export const OMR_DECIMALS = 3;

export const ZERO = 0 as Baisa;

/**
 * Upper bound for a single monetary value: OMR 1,000,000,000.
 *
 * Rounding internally computes `2 * |amount|`, so the guard keeps every
 * intermediate value far inside `Number.MAX_SAFE_INTEGER` and turns an
 * overflowing calculation into a loud error rather than silent precision loss.
 */
export const MAX_BAISA = 1_000_000_000_000;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Construct a `Baisa` from an integer, validating the invariants.
 *
 * @throws MoneyError if the value is not a finite integer within range.
 */
export function baisa(value: number): Baisa {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`Amount must be a finite number, received: ${value}`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(
      `Amount must be an integer number of baisa, received: ${value}. ` +
        `Use parseOmr() to convert a rial value such as "180.500".`,
    );
  }
  if (Math.abs(value) > MAX_BAISA) {
    throw new MoneyError(`Amount ${value} exceeds the maximum supported value.`);
  }
  return value as Baisa;
}

/** True when the value is a valid baisa amount. Does not throw. */
export function isBaisa(value: unknown): value is Baisa {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_BAISA
  );
}

/* ------------------------------------------------------------------------ *
 * Arithmetic
 * ------------------------------------------------------------------------ */

export function add(a: Baisa, b: Baisa): Baisa {
  return baisa(a + b);
}

export function subtract(a: Baisa, b: Baisa): Baisa {
  return baisa(a - b);
}

/** Sum any number of amounts. Exact — integers do not drift. */
export function sum(amounts: readonly Baisa[]): Baisa {
  let total = 0;
  for (const amount of amounts) {
    total += amount;
  }
  return baisa(total);
}

/** Multiply by a whole quantity (e.g. three veils at the same unit price). */
export function multiply(amount: Baisa, quantity: number): Baisa {
  if (!Number.isInteger(quantity)) {
    throw new MoneyError(`Quantity must be an integer, received: ${quantity}`);
  }
  return baisa(amount * quantity);
}

export function negate(amount: Baisa): Baisa {
  return baisa(-amount);
}

export function abs(amount: Baisa): Baisa {
  return baisa(Math.abs(amount));
}

export function isZero(amount: Baisa): boolean {
  return amount === 0;
}

export function isPositive(amount: Baisa): boolean {
  return amount > 0;
}

export function isNegative(amount: Baisa): boolean {
  return amount < 0;
}

export function compare(a: Baisa, b: Baisa): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function max(a: Baisa, b: Baisa): Baisa {
  return a >= b ? a : b;
}

export function min(a: Baisa, b: Baisa): Baisa {
  return a <= b ? a : b;
}

/** Clamp to zero. Used where a negative balance is meaningless (amount still due). */
export function clampToZero(amount: Baisa): Baisa {
  return amount > 0 ? amount : ZERO;
}

/* ------------------------------------------------------------------------ *
 * Rounding
 * ------------------------------------------------------------------------ */

/**
 * Integer division rounding half away from zero.
 *
 * Half away from zero (rather than JavaScript's `Math.round`, which rounds half
 * *up* toward positive infinity) keeps refunds symmetrical with charges: a
 * refund of -2.5 baisa and a charge of 2.5 baisa round to the same magnitude.
 * Asymmetric rounding leaks value across a refund cycle.
 *
 * Computed with integers throughout, so no floating-point step can introduce
 * the error this module exists to prevent.
 *
 * @throws MoneyError on a zero divisor.
 */
export function roundedDivide(numerator: number, divisor: number): number {
  if (divisor === 0) {
    throw new MoneyError('Division by zero.');
  }
  if (!Number.isInteger(numerator) || !Number.isInteger(divisor)) {
    throw new MoneyError(`roundedDivide requires integers, received ${numerator} / ${divisor}.`);
  }

  const sign = Math.sign(numerator) * Math.sign(divisor);
  const absNumerator = Math.abs(numerator);
  const absDivisor = Math.abs(divisor);

  if (2 * absNumerator + absDivisor > Number.MAX_SAFE_INTEGER) {
    throw new MoneyError('Rounding would exceed safe integer precision.');
  }

  // floor((2n + d) / 2d) is exact half-away-from-zero on non-negative integers.
  const magnitude = Math.floor((2 * absNumerator + absDivisor) / (2 * absDivisor));
  return sign * magnitude;
}

/**
 * Apply a percentage, rounding once at the end.
 *
 * Rounding once matters: rounding each intermediate operand and then combining
 * accumulates error, which is how VAT totals end up disagreeing with the sum of
 * their own lines.
 *
 * @param percent may be fractional (e.g. 2.5), but the result is whole baisa.
 */
export function percentOf(amount: Baisa, percent: number): Baisa {
  if (!Number.isFinite(percent)) {
    throw new MoneyError(`Percentage must be finite, received: ${percent}`);
  }
  if (percent === 0 || amount === 0) {
    return ZERO;
  }

  // Scale the percentage to an integer so the division stays in integer space.
  // Four decimal places of percentage precision is far beyond any tax rate.
  const SCALE = 10_000;
  const scaledPercent = Math.round(percent * SCALE);

  return baisa(roundedDivide(amount * scaledPercent, 100 * SCALE));
}

/**
 * Split an amount into `parts` as evenly as possible, distributing the
 * remainder one baisa at a time so the parts always sum back to the original.
 *
 * Naive division loses or invents baisa when an amount does not divide evenly;
 * this guarantees conservation, which matters for instalment plans.
 */
export function allocate(amount: Baisa, parts: number): Baisa[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new MoneyError(`Parts must be a positive integer, received: ${parts}`);
  }

  const sign = amount < 0 ? -1 : 1;
  const total = Math.abs(amount);
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;

  const result: Baisa[] = [];
  for (let index = 0; index < parts; index += 1) {
    const share = base + (index < remainder ? 1 : 0);
    result.push(baisa(sign * share));
  }
  return result;
}

/* ------------------------------------------------------------------------ *
 * Parsing and formatting
 * ------------------------------------------------------------------------ */

/** Matches an optionally signed decimal with at most three fractional digits. */
const OMR_INPUT_PATTERN = /^([+-]?)(\d+)(?:\.(\d{1,3}))?$/;

/**
 * Parse a human-entered rial string into baisa.
 *
 * Accepts `"180"`, `"180.5"`, `"180.500"`, `"1,180.000"`, `"-12.250"`.
 * Rejects more than three decimal places — OMR has no smaller unit than a
 * baisa, so `"180.0005"` is not a roundable input, it is a data-entry error.
 * Silently rounding it would hide a mistake in a financial field.
 *
 * Arabic-Indic digits (٠-٩) are normalised, since an Arabic keyboard may
 * produce them.
 *
 * @throws MoneyError on malformed input.
 */
export function parseOmr(input: string): Baisa {
  if (typeof input !== 'string') {
    throw new MoneyError(`Expected a string amount, received: ${typeof input}`);
  }

  // Strip grouping separators and any whitespace, including the non-breaking
  // space and the Arabic thousands separator (U+066C) that a paste from a
  // formatted document or an Arabic keyboard can introduce. The Arabic decimal
  // separator (U+066B) is deliberately NOT stripped -- it is a decimal point.
  const normalised = normaliseDigits(input)
    .replace(/[\s,\u00A0\u066C]/gu, '')
    .trim();

  if (normalised === '') {
    throw new MoneyError('Amount is empty.');
  }

  const match = OMR_INPUT_PATTERN.exec(normalised);
  if (!match) {
    throw new MoneyError(
      `"${input}" is not a valid OMR amount. Use up to ${OMR_DECIMALS} decimal places, e.g. "180.500".`,
    );
  }

  const [, sign, whole, fraction = ''] = match;
  const paddedFraction = fraction.padEnd(OMR_DECIMALS, '0');
  const magnitude = Number(whole) * BAISA_PER_OMR + Number(paddedFraction);

  return baisa(sign === '-' ? -magnitude : magnitude);
}

/** Parse without throwing. Returns `null` when the input is not a valid amount. */
export function tryParseOmr(input: string): Baisa | null {
  try {
    return parseOmr(input);
  } catch {
    return null;
  }
}

/** Convert Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits to ASCII. */
function normaliseDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

export interface FormatOptions {
  /** Include the `OMR` currency code. Default `true`. */
  readonly withCode?: boolean;
  /** Group thousands with separators. Default `true`. */
  readonly grouping?: boolean;
  /** Render a leading `+` for positive amounts. Default `false`. */
  readonly signDisplay?: boolean;
}

/**
 * Format baisa for display: always exactly three decimal places.
 *
 * `formatOmr(180000)` → `"OMR 180.000"`
 * `formatOmr(500)`    → `"OMR 0.500"`
 *
 * Formatting is done manually rather than through `Intl.NumberFormat` so the
 * output is identical in every locale. An amount rendered on an Arabic invoice
 * must read the same as on the English one — Western-Arabic digits, three
 * decimals, no locale-specific separators (specification §10).
 */
export function formatOmr(amount: Baisa, options: FormatOptions = {}): string {
  const { withCode = true, grouping = true, signDisplay = false } = options;

  const negative = amount < 0;
  const magnitude = Math.abs(amount);
  const whole = Math.floor(magnitude / BAISA_PER_OMR);
  const fraction = magnitude % BAISA_PER_OMR;

  const wholeText = grouping ? groupThousands(whole) : String(whole);
  const fractionText = String(fraction).padStart(OMR_DECIMALS, '0');

  const sign = negative ? '-' : signDisplay && amount > 0 ? '+' : '';
  const number = `${sign}${wholeText}.${fractionText}`;

  return withCode ? `OMR ${number}` : number;
}

/** Format without the currency code — for table columns with a currency header. */
export function formatOmrPlain(amount: Baisa): string {
  return formatOmr(amount, { withCode: false });
}

/**
 * Convert baisa to a decimal string suitable for an `<input>` value.
 * Never grouped, never prefixed — an input must round-trip through `parseOmr`.
 */
export function toInputValue(amount: Baisa): string {
  return formatOmr(amount, { withCode: false, grouping: false });
}

function groupThousands(value: number): string {
  const text = String(value);
  if (text.length <= 3) {
    return text;
  }
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
