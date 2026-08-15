import { describe, expect, it } from 'vitest';

import { BOM, csvAmount, csvFilename, escapeCell, ROW_SEPARATOR, toCsvFile, toCsvRow } from './csv';
import { baisa } from './money';

describe('escapeCell()', () => {
  it('leaves an ordinary value alone', () => {
    expect(escapeCell('Aisha')).toBe('Aisha');
    expect(escapeCell(42)).toBe('42');
  });

  it('treats null and undefined as a blank cell, not as words', () => {
    expect(escapeCell(null)).toBe('');
    expect(escapeCell(undefined)).toBe('');
  });

  it('quotes a value containing a comma', () => {
    expect(escapeCell('Al Khuwair, Muscat')).toBe('"Al Khuwair, Muscat"');
  });

  it('doubles an embedded quote, as RFC 4180 requires', () => {
    expect(escapeCell('the "ivory" one')).toBe('"the ""ivory"" one"');
  });

  it('quotes a value containing a newline so the row does not end early', () => {
    expect(escapeCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('keeps Arabic exactly as it is', () => {
    expect(escapeCell('عروس النسخة')).toBe('عروس النسخة');
  });

  describe('formula injection', () => {
    /*
     * The reason this matters: a customer name is free text, and it ends up in
     * a spreadsheet the boutique's accountant opens. A cell starting with one of
     * these characters is executed, not displayed.
     */
    it('neutralises a formula, keeping the text readable', () => {
      expect(escapeCell('=HYPERLINK("http://evil","Click")')).toBe(
        '"\'=HYPERLINK(""http://evil"",""Click"")"',
      );
    });

    it.each(['=', '+', '@'])('neutralises a cell starting with %j', (start) => {
      expect(escapeCell(`${start}cmd`)).toBe(`'${start}cmd`);
    });

    it('neutralises a leading tab or carriage return, quoting as well', () => {
      expect(escapeCell('\tcmd')).toBe("'\tcmd");
      expect(escapeCell('\rcmd')).toBe('"\'\rcmd"');
    });

    it('neutralises a leading minus that is not a number', () => {
      expect(escapeCell('-1+1+cmd|calc')).toBe("'-1+1+cmd|calc");
    });

    it('does not disturb a value that merely contains one of those characters', () => {
      expect(escapeCell('Nasser Al-Balushi')).toBe('Nasser Al-Balushi');
      expect(escapeCell('aisha@example.com')).toBe('aisha@example.com');
    });

    it('leaves a negative amount as a number, so the column still sums', () => {
      /*
       * A refund exports as `-50.000`. Prefixing it would make Excel read the
       * cell as text, and `SUM` over the amount column would silently skip
       * every refund — the guard would have broken the report it protects.
       */
      expect(csvAmount(baisa(-50_000))).toBe('-50.000');
      expect(escapeCell(csvAmount(baisa(-50_000)))).toBe('-50.000');
      expect(escapeCell('-1234')).toBe('-1234');
    });
  });
});

describe('csvAmount()', () => {
  it('is a bare number with three decimals — no code, no grouping', () => {
    expect(csvAmount(baisa(1_234_500))).toBe('1234.500');
    expect(csvAmount(baisa(500))).toBe('0.500');
    expect(csvAmount(baisa(0))).toBe('0.000');
  });

  it('never emits a comma, which would end the field', () => {
    expect(csvAmount(baisa(9_999_999_000))).not.toContain(',');
  });
});

describe('toCsvRow()', () => {
  it('joins fields with commas', () => {
    expect(toCsvRow(['a', 'b', 3])).toBe('a,b,3');
  });
});

describe('toCsvFile()', () => {
  const table = {
    headers: ['Code', 'Name', 'Total (OMR)'],
    rows: [
      ['CUS-0001', 'عروس', '300.000'],
      ['CUS-0002', 'Al Khuwair, Muscat', '0.000'],
    ],
  };

  it('starts with the byte-order mark Excel needs for Arabic', () => {
    expect(toCsvFile(table).startsWith(BOM)).toBe(true);
  });

  it('separates rows with CRLF', () => {
    expect(toCsvFile(table)).toContain(`CUS-0001,عروس,300.000${ROW_SEPARATOR}`);
  });

  it('ends with a terminator, so the last row is not read as truncated', () => {
    expect(toCsvFile(table).endsWith(ROW_SEPARATOR)).toBe(true);
  });

  it('has one header line and one line per row', () => {
    const lines = toCsvFile(table).trimEnd().split(ROW_SEPARATOR);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`${BOM}Code,Name,Total (OMR)`);
  });

  it('produces a header-only file for an empty table rather than nothing', () => {
    /*
     * An empty boutique exports a file with column names. A zero-byte file looks
     * like a failure; a header row says "there are no payments yet".
     */
    const empty = toCsvFile({ headers: ['Code'], rows: [] });

    expect(empty).toBe(`${BOM}Code${ROW_SEPARATOR}`);
  });
});

describe('csvFilename()', () => {
  it('names the subject and the day', () => {
    expect(csvFilename('payments', '2026-08-15')).toBe('azhary-payments-2026-08-15.csv');
  });
});
