import { describe, it, expect } from 'vitest';
import {
  DEFAULT_NUMBER_FORMATS,
  NumberingError,
  counterIdFor,
  formatFor,
  formatRecordNumber,
  parseRecordNumber,
} from './numbering';

describe('formatRecordNumber()', () => {
  it('produces the specified formats', () => {
    expect(formatFor('dress', 1)).toBe('WD-0001');
    expect(formatFor('customer', 1)).toBe('CU-0001');
    expect(formatFor('reservation', 1)).toBe('RSV-0001');
    expect(formatFor('invoice', 1, 2026)).toBe('INV-2026-0001');
  });

  it('pads to the configured width', () => {
    expect(formatFor('dress', 7)).toBe('WD-0007');
    expect(formatFor('dress', 42)).toBe('WD-0042');
    expect(formatFor('dress', 999)).toBe('WD-0999');
    expect(formatFor('dress', 1000)).toBe('WD-1000');
  });

  it('widens rather than truncating past the padding width', () => {
    // A boutique reaching its ten-thousandth dress gets WD-10000, not a code
    // that collides with an existing one.
    expect(formatFor('dress', 10_000)).toBe('WD-10000');
    expect(formatFor('dress', 123_456)).toBe('WD-123456');
  });

  it('honours a custom prefix, separator and padding', () => {
    expect(formatRecordNumber(5, { prefix: 'GOWN', separator: '/', padding: 6 })).toBe(
      'GOWN/000005',
    );
  });

  it('rejects a non-positive or fractional sequence', () => {
    for (const sequence of [0, -1, 1.5, Number.NaN]) {
      expect(() => formatFor('dress', sequence)).toThrow(NumberingError);
    }
  });

  it('rejects an invalid padding', () => {
    expect(() => formatRecordNumber(1, { prefix: 'WD', separator: '-', padding: 0 })).toThrow(
      /Padding/,
    );
  });

  it('rejects an empty prefix', () => {
    expect(() => formatRecordNumber(1, { prefix: '', separator: '-', padding: 4 })).toThrow(
      /Prefix/,
    );
  });

  it('requires a year for year-bearing formats', () => {
    expect(() => formatFor('invoice', 1)).toThrow(/year is required/);
    expect(() => formatFor('invoice', 1, 1.5)).toThrow(/year is required/);
  });

  it('ignores a year for formats that do not use one', () => {
    expect(formatFor('dress', 1, 2026)).toBe('WD-0001');
  });
});

describe('counterIdFor()', () => {
  it('uses one lifetime counter for dresses, customers and reservations', () => {
    expect(counterIdFor('dress')).toBe('dress');
    expect(counterIdFor('customer')).toBe('customer');
    expect(counterIdFor('reservation')).toBe('reservation');
  });

  it('uses a per-year counter for invoices so the sequence resets on 1 January', () => {
    expect(counterIdFor('invoice', 2026)).toBe('invoice-2026');
    expect(counterIdFor('invoice', 2027)).toBe('invoice-2027');
  });

  it('refuses an invoice counter without a year', () => {
    expect(() => counterIdFor('invoice')).toThrow(/year is required/);
  });
});

describe('parseRecordNumber()', () => {
  it('recognises each record type', () => {
    expect(parseRecordNumber('WD-0001')).toEqual({ kind: 'dress', sequence: 1 });
    expect(parseRecordNumber('CU-0042')).toEqual({ kind: 'customer', sequence: 42 });
    expect(parseRecordNumber('RSV-0007')).toEqual({ kind: 'reservation', sequence: 7 });
    expect(parseRecordNumber('INV-2026-0001')).toEqual({
      kind: 'invoice',
      year: 2026,
      sequence: 1,
    });
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(parseRecordNumber('  wd-0001 ')).toEqual({ kind: 'dress', sequence: 1 });
  });

  it('returns null for anything that is not a record number', () => {
    for (const value of ['', 'Fatima', 'WD', 'WD-', '0001', 'XX-0001', 'WD_0001']) {
      expect(parseRecordNumber(value)).toBeNull();
    }
  });

  it('round-trips every default format', () => {
    for (const kind of Object.keys(
      DEFAULT_NUMBER_FORMATS,
    ) as (keyof typeof DEFAULT_NUMBER_FORMATS)[]) {
      const needsYear = DEFAULT_NUMBER_FORMATS[kind].includeYear === true;
      const code = formatFor(kind, 123, needsYear ? 2026 : undefined);
      const parsed = parseRecordNumber(code);

      expect(parsed).not.toBeNull();
      expect(parsed?.kind).toBe(kind);
      expect(parsed?.sequence).toBe(123);
    }
  });
});
