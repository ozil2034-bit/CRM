/**
 * Oman phone numbers.
 *
 * The boutique's customers are in Oman, so numbers are normalised to E.164
 * (`+968XXXXXXXX`) for storage and comparison, while staff may type them in any
 * of the forms people actually use: `9123 4567`, `00968 91234567`,
 * `+968-9123-4567`.
 *
 * Normalisation matters beyond tidiness: duplicate detection compares the
 * normalised form, so `9123 4567` and `+96891234567` must collapse to the same
 * value or the warning never fires.
 *
 * Pure: no I/O, no Firebase, no clock.
 */

export const OMAN_COUNTRY_CODE = '968';

/**
 * Oman subscriber numbers are 8 digits.
 * 7x and 9x are mobile; 2x is fixed line. Others are not assigned to
 * subscribers, so they are rejected rather than stored as unreachable contacts.
 */
const OMAN_SUBSCRIBER_PATTERN = /^[279]\d{7}$/;

export type PhoneKind = 'mobile' | 'landline';

export interface ParsedPhone {
  /** E.164, e.g. `+96891234567`. The value stored in `phone`. */
  readonly e164: string;
  /** Digits only, e.g. `96891234567`. The value stored in `phoneNormalized`. */
  readonly normalized: string;
  /** The 8-digit national part, e.g. `91234567`. */
  readonly national: string;
  readonly kind: PhoneKind;
  /** Grouped for display: `9123 4567`. */
  readonly formatted: string;
}

export type PhoneProblem =
  'EMPTY' | 'TOO_SHORT' | 'TOO_LONG' | 'NOT_OMAN' | 'UNASSIGNED_PREFIX' | 'INVALID_CHARACTERS';

export type PhoneResult =
  | { readonly ok: true; readonly phone: ParsedPhone }
  | { readonly ok: false; readonly problem: PhoneProblem };

/** Convert Arabic-Indic and Eastern Arabic-Indic digits to ASCII. */
export function normaliseDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/**
 * Parse a phone number as typed by an employee.
 *
 * Accepts `+968` / `00968` / bare national form, with spaces, dashes,
 * parentheses and Arabic-Indic digits.
 */
export function parseOmanPhone(input: string): PhoneResult {
  if (typeof input !== 'string') {
    return { ok: false, problem: 'INVALID_CHARACTERS' };
  }

  const ascii = normaliseDigits(input).trim();

  if (ascii.length === 0) {
    return { ok: false, problem: 'EMPTY' };
  }

  // Anything other than digits and conventional separators is a typing error,
  // not something to silently strip.
  if (!/^[+\d\s()\-.]+$/.test(ascii)) {
    return { ok: false, problem: 'INVALID_CHARACTERS' };
  }

  let digits = ascii.replace(/\D/g, '');

  if (digits.length === 0) {
    return { ok: false, problem: 'EMPTY' };
  }

  // Strip the international prefix in either form.
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.startsWith(OMAN_COUNTRY_CODE) && digits.length > 8) {
    digits = digits.slice(OMAN_COUNTRY_CODE.length);
  } else if (digits.length > 8) {
    // A long number that is not Omani. Rejected rather than truncated: guessing
    // which digits to drop would silently store the wrong number.
    return { ok: false, problem: 'NOT_OMAN' };
  }

  if (digits.length < 8) {
    return { ok: false, problem: 'TOO_SHORT' };
  }
  if (digits.length > 8) {
    return { ok: false, problem: 'TOO_LONG' };
  }

  if (!OMAN_SUBSCRIBER_PATTERN.test(digits)) {
    return { ok: false, problem: 'UNASSIGNED_PREFIX' };
  }

  const national = digits;
  const kind: PhoneKind = national.startsWith('2') ? 'landline' : 'mobile';

  return {
    ok: true,
    phone: {
      e164: `+${OMAN_COUNTRY_CODE}${national}`,
      normalized: `${OMAN_COUNTRY_CODE}${national}`,
      national,
      kind,
      formatted: `${national.slice(0, 4)} ${national.slice(4)}`,
    },
  };
}

/** Parse without the result wrapper; `null` when invalid. */
export function tryParseOmanPhone(input: string): ParsedPhone | null {
  const result = parseOmanPhone(input);
  return result.ok ? result.phone : null;
}

/**
 * Are two numbers the same person's line?
 *
 * Compares normalised forms, so differing input formats do not defeat the
 * duplicate check.
 */
export function isSamePhone(a: string, b: string): boolean {
  const left = tryParseOmanPhone(a);
  const right = tryParseOmanPhone(b);
  if (!left || !right) return false;
  return left.normalized === right.normalized;
}

export const PHONE_PROBLEM_MESSAGES: Readonly<Record<PhoneProblem, string>> = {
  EMPTY: 'Enter a phone number.',
  TOO_SHORT: 'An Omani number has 8 digits.',
  TOO_LONG: 'An Omani number has 8 digits.',
  NOT_OMAN: 'Enter an Omani number, or include the correct country code.',
  UNASSIGNED_PREFIX: 'Omani numbers start with 9, 7 or 2.',
  INVALID_CHARACTERS: 'Use digits only.',
};
