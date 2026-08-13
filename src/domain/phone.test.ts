import { describe, it, expect } from 'vitest';
import { isSamePhone, parseOmanPhone, tryParseOmanPhone } from './phone';

describe('parseOmanPhone()', () => {
  it('accepts a bare national mobile number', () => {
    const result = parseOmanPhone('91234567');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.phone.e164).toBe('+96891234567');
    expect(result.phone.normalized).toBe('96891234567');
    expect(result.phone.national).toBe('91234567');
    expect(result.phone.kind).toBe('mobile');
    expect(result.phone.formatted).toBe('9123 4567');
  });

  it('accepts every form staff actually type, collapsing to one value', () => {
    const forms = [
      '91234567',
      '9123 4567',
      '9123-4567',
      '+968 9123 4567',
      '+96891234567',
      '00968 91234567',
      '(968) 9123-4567',
      '  91234567  ',
    ];

    for (const form of forms) {
      const parsed = tryParseOmanPhone(form);
      expect(parsed, `failed to parse: ${form}`).not.toBeNull();
      expect(parsed?.normalized).toBe('96891234567');
    }
  });

  it('normalises Arabic-Indic digits', () => {
    expect(tryParseOmanPhone('٩١٢٣٤٥٦٧')?.normalized).toBe('96891234567');
    expect(tryParseOmanPhone('۹۱۲۳۴۵۶۷')?.normalized).toBe('96891234567');
  });

  it('classifies mobile and landline prefixes', () => {
    expect(tryParseOmanPhone('91234567')?.kind).toBe('mobile');
    expect(tryParseOmanPhone('71234567')?.kind).toBe('mobile');
    expect(tryParseOmanPhone('24123456')?.kind).toBe('landline');
  });

  it('rejects an empty or whitespace-only value', () => {
    for (const value of ['', '   ']) {
      const result = parseOmanPhone(value);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problem).toBe('EMPTY');
    }
  });

  it('rejects a number that is too short', () => {
    const result = parseOmanPhone('9123456');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe('TOO_SHORT');
  });

  it('rejects a foreign number rather than truncating it', () => {
    // Guessing which digits to drop would silently store the wrong number.
    const result = parseOmanPhone('+441234567890');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe('NOT_OMAN');
  });

  it('rejects an unassigned Omani prefix', () => {
    for (const value of ['11234567', '31234567', '81234567', '01234567']) {
      const result = parseOmanPhone(value);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.problem).toBe('UNASSIGNED_PREFIX');
    }
  });

  it('rejects letters and stray symbols', () => {
    const result = parseOmanPhone('9123ABCD');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe('INVALID_CHARACTERS');
  });

  it('rejects a non-string input', () => {
    const result = parseOmanPhone(91234567 as unknown as string);
    expect(result.ok).toBe(false);
  });

  it('rejects a country code with too many subscriber digits', () => {
    const result = parseOmanPhone('+968912345678');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe('TOO_LONG');
  });
});

describe('isSamePhone()', () => {
  it('matches numbers written differently — this is what makes the duplicate check work', () => {
    expect(isSamePhone('9123 4567', '+96891234567')).toBe(true);
    expect(isSamePhone('00968 91234567', '91234567')).toBe(true);
  });

  it('does not match different numbers', () => {
    expect(isSamePhone('91234567', '91234568')).toBe(false);
  });

  it('does not match when either side is invalid', () => {
    expect(isSamePhone('nonsense', '91234567')).toBe(false);
    expect(isSamePhone('91234567', '')).toBe(false);
  });
});
