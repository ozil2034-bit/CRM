import { describe, it, expect } from 'vitest';
import {
  customerSearchFields,
  displayName,
  evaluateDuplicatePhone,
  findMeasurementProblems,
  hasUsableName,
  isPlausibleEventDate,
  isPreferredLanguage,
  isSelectableForNewWork,
  isValidCalendarDate,
  isValidCustomerMeasurement,
  normaliseName,
  type ExistingCustomerSummary,
} from './customer';

describe('preferred language', () => {
  it('accepts the three defined values', () => {
    expect(isPreferredLanguage('en')).toBe(true);
    expect(isPreferredLanguage('ar')).toBe(true);
    expect(isPreferredLanguage('bilingual')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isPreferredLanguage('EN')).toBe(false);
    expect(isPreferredLanguage('fr')).toBe(false);
    expect(isPreferredLanguage(null)).toBe(false);
  });
});

describe('names', () => {
  it('accepts a customer identified in either script alone', () => {
    // Requiring both would force staff to transliterate at the counter, which
    // produces inconsistent records.
    expect(hasUsableName('Fatima', '')).toBe(true);
    expect(hasUsableName('', 'فاطمة')).toBe(true);
    expect(hasUsableName('Fatima', 'فاطمة')).toBe(true);
  });

  it('rejects a customer with no name at all', () => {
    expect(hasUsableName('', '')).toBe(false);
    expect(hasUsableName('   ', '  ')).toBe(false);
  });

  it('shows the name in the reader’s language when available', () => {
    const customer = { nameEn: 'Fatima', nameAr: 'فاطمة' };
    expect(displayName(customer, 'en')).toBe('Fatima');
    expect(displayName(customer, 'ar')).toBe('فاطمة');
  });

  it('falls back to the other script rather than showing nothing', () => {
    expect(displayName({ nameEn: 'Fatima', nameAr: '' }, 'ar')).toBe('Fatima');
    expect(displayName({ nameEn: '', nameAr: 'فاطمة' }, 'en')).toBe('فاطمة');
  });

  it('collapses whitespace in stored names', () => {
    expect(normaliseName('  Fatima   Al   Balushi ')).toBe('Fatima Al Balushi');
  });
});

describe('measurements', () => {
  it('accepts absent measurements', () => {
    expect(isValidCustomerMeasurement('bust', null)).toBe(true);
  });

  it('accepts plausible values', () => {
    expect(isValidCustomerMeasurement('bust', 86)).toBe(true);
    expect(isValidCustomerMeasurement('height', 165)).toBe(true);
    expect(isValidCustomerMeasurement('shoeSize', 38)).toBe(true);
  });

  it('rejects values that indicate a misplaced decimal or the wrong field', () => {
    expect(isValidCustomerMeasurement('bust', 8)).toBe(false);
    expect(isValidCustomerMeasurement('height', 1.65)).toBe(false);
    expect(isValidCustomerMeasurement('shoeSize', 380)).toBe(false);
    expect(isValidCustomerMeasurement('waist', Number.NaN)).toBe(false);
  });

  it('reports every offending field', () => {
    const problems = findMeasurementProblems({
      bust: 5,
      waist: 70,
      hips: 5000,
      height: null,
      shoeSize: 38,
    });

    expect(problems).toContain('bust');
    expect(problems).toContain('hips');
    expect(problems).not.toContain('waist');
    expect(problems).not.toContain('height');
  });

  it('reports nothing when every measurement is absent', () => {
    expect(
      findMeasurementProblems({
        bust: null,
        waist: null,
        hips: null,
        height: null,
        shoeSize: null,
      }),
    ).toEqual([]);
  });
});

describe('evaluateDuplicatePhone()', () => {
  const existing: ExistingCustomerSummary[] = [
    {
      id: 'c1',
      code: 'CU-0001',
      nameEn: 'Fatima Al Balushi',
      nameAr: 'فاطمة البلوشي',
      phoneNormalized: '96891234567',
      archived: false,
    },
    {
      id: 'c2',
      code: 'CU-0002',
      nameEn: 'Noor Al Balushi',
      nameAr: '',
      phoneNormalized: '96891234567',
      archived: false,
    },
  ];

  it('reports nothing when the number is new', () => {
    const verdict = evaluateDuplicatePhone('96899999999', existing);
    expect(verdict.severity).toBe('none');
    expect(verdict.matches).toEqual([]);
  });

  it('WARNS rather than blocking, and names who already holds the number', () => {
    // Family members legitimately share a number. Blocking would stop real work;
    // a bare warning would not let staff tell a sister from a duplicate entry.
    const verdict = evaluateDuplicatePhone('96891234567', existing);

    expect(verdict.severity).toBe('warn');
    expect(verdict.reason).toBe('SHARED_NUMBER');
    expect(verdict.matches).toHaveLength(2);
    expect(verdict.matches[0]?.nameEn).toBe('Fatima Al Balushi');
  });

  it('never returns "none" for an existing number — silent creation is the failure', () => {
    const verdict = evaluateDuplicatePhone('96891234567', existing);
    expect(verdict.severity).not.toBe('none');
  });

  it('does not warn when a customer keeps their own number while editing', () => {
    const verdict = evaluateDuplicatePhone('96891234567', [existing[0]!], {
      editingCustomerId: 'c1',
    });

    expect(verdict.severity).toBe('none');
    expect(verdict.reason).toBe('SAME_RECORD');
  });

  it('warns when an edit moves a customer onto another customer’s number', () => {
    const verdict = evaluateDuplicatePhone('96891234567', existing, {
      editingCustomerId: 'c1',
    });

    expect(verdict.severity).toBe('warn');
    expect(verdict.matches).toHaveLength(1);
    expect(verdict.matches[0]?.id).toBe('c2');
  });

  it('includes archived customers, so a number is not silently reused', () => {
    const archived: ExistingCustomerSummary[] = [{ ...existing[0]!, archived: true }];
    const verdict = evaluateDuplicatePhone('96891234567', archived);
    expect(verdict.severity).toBe('warn');
  });
});

describe('event dates', () => {
  it('accepts a well-formed date', () => {
    expect(isValidCalendarDate('2026-06-14')).toBe(true);
  });

  it('rejects a date that does not exist rather than rolling it over', () => {
    // Otherwise 2026-02-30 would silently become 2 March.
    expect(isValidCalendarDate('2026-02-30')).toBe(false);
    expect(isValidCalendarDate('2026-13-01')).toBe(false);
    expect(isValidCalendarDate('2026-00-10')).toBe(false);
    expect(isValidCalendarDate('2026-06-31')).toBe(false);
  });

  it('accepts a genuine leap day and rejects a false one', () => {
    expect(isValidCalendarDate('2028-02-29')).toBe(true);
    expect(isValidCalendarDate('2026-02-29')).toBe(false);
  });

  it('rejects malformed strings', () => {
    for (const value of ['', '2026-6-14', '14/06/2026', '2026-06', 'not a date']) {
      expect(isValidCalendarDate(value)).toBe(false);
    }
  });

  it('accepts a past event date — staff enter historical customers', () => {
    expect(isPlausibleEventDate('2020-06-14', '2026-08-13')).toBe(true);
  });

  it('rejects absurdly distant dates as typos', () => {
    expect(isPlausibleEventDate('2099-06-14', '2026-08-13')).toBe(false);
    expect(isPlausibleEventDate('1990-06-14', '2026-08-13')).toBe(false);
  });

  it('rejects an invalid date outright', () => {
    expect(isPlausibleEventDate('2026-02-30', '2026-08-13')).toBe(false);
    expect(isPlausibleEventDate('2026-06-14', 'nonsense')).toBe(false);
  });
});

describe('archiving', () => {
  it('excludes archived customers from new work', () => {
    expect(isSelectableForNewWork({ archived: false })).toBe(true);
    expect(isSelectableForNewWork({ archived: true })).toBe(false);
  });
});

describe('customerSearchFields()', () => {
  const customer = {
    code: 'CU-0001',
    nameEn: 'Fatima Al Balushi',
    nameAr: 'فاطمة البلوشي',
    phoneNormalized: '96891234567',
    email: 'fatima@example.com',
  };

  it('includes the fields staff search by', () => {
    const fields = customerSearchFields(customer);
    expect(fields).toContain('CU-0001');
    expect(fields).toContain('Fatima Al Balushi');
    expect(fields).toContain('فاطمة البلوشي');
    expect(fields).toContain('96891234567');
  });

  it('excludes the national ID', () => {
    // It identifies a person to the state and has no business being reachable
    // by partial-match search from a staff screen.
    const fields = customerSearchFields(customer);
    expect(fields).toHaveLength(5);
    expect(JSON.stringify(fields)).not.toContain('nationalId');
  });
});
