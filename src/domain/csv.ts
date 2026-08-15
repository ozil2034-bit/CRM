/**
 * CSV — the format the boutique's accountant actually opens.
 *
 * The JSON backup is for restoring the system. This is for the other need: a
 * list of payments to reconcile against a bank statement, a customer list to
 * post to, a dress list to check against the rail. Those go into Excel, which
 * means CSV, which means three problems that a naive `values.join(',')` gets
 * wrong.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 1. ARABIC
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Excel on Windows does not detect UTF-8 in a `.csv` unless the file begins with
 * a byte-order mark. Without it, `عروس` opens as `Ø¹Ø±ÙˆØ³` — and half this
 * boutique's customer names are Arabic. `BOM` is prepended by `toCsvFile`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 2. FORMULA INJECTION
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A customer's name is free text, and a spreadsheet treats a cell beginning
 * `=`, `+`, `-`, `@`, tab or carriage return as a **formula**. A name entered as
 * `=HYPERLINK("http://…","Click")` becomes a live link in the accountant's
 * spreadsheet; worse constructions exist. Quoting does not help — Excel parses
 * the quotes off and then evaluates what is inside.
 *
 * So a cell that starts with one of those characters is prefixed with a single
 * quote, which Excel and LibreOffice both read as "this is text". The value is
 * still legible; it simply cannot execute.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 3. MONEY
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Amounts are exported as OMR with **three decimals and no grouping** —
 * `1234.500`, never `OMR 1,234.500`. A thousands separator inside a CSV field is
 * a comma, and a currency code makes the column text rather than a number. The
 * unit belongs in the column heading, and that is where it is put.
 *
 * Pure: no I/O, no Firestore, no DOM. `toCsvFile` returns a string.
 */

import { formatOmr, type Baisa } from './money';

/** Excel needs this to read the file as UTF-8. */
export const BOM = '﻿';

/**
 * `\r\n`, not `\n`.
 *
 * RFC 4180 specifies it, and older Excel builds on Windows put the whole file
 * on one line without it.
 */
export const ROW_SEPARATOR = '\r\n';

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_STARTERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * A plain number — including a negative one.
 *
 * Without this exception the guard would break the thing it is protecting. A
 * refund exports as `-50.000`, which starts with `-`; prefixing it would make
 * Excel read the cell as **text**, and the accountant's `SUM` over the amount
 * column would silently skip every refund. A value that is entirely digits, one
 * optional sign and one optional decimal point cannot be a formula.
 */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * One value → one CSV field.
 *
 * `null` and `undefined` become empty rather than the strings "null" and
 * "undefined", which is what an accountant means by a blank cell.
 */
export function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text = typeof value === 'string' ? value : String(value);

  if (text.length > 0 && FORMULA_STARTERS.includes(text[0]!) && !PLAIN_NUMBER.test(text)) {
    text = `'${text}`;
  }

  // Quote when the value contains anything that would otherwise end the field.
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

export function toCsvRow(values: readonly unknown[]): string {
  return values.map(escapeCell).join(',');
}

/**
 * Amount for a CSV column: plain, ungrouped, three decimals.
 *
 * Not `formatOmr` with its default options — the currency code and the thousands
 * separator both belong outside a numeric field.
 */
export function csvAmount(amount: Baisa): string {
  return formatOmr(amount, { withCode: false, grouping: false });
}

export interface CsvTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}

/**
 * A whole file, ready to be handed to the browser.
 *
 * A trailing row separator is included: some tools treat a file whose last line
 * has no terminator as truncated.
 */
export function toCsvFile(table: CsvTable): string {
  const lines = [toCsvRow(table.headers), ...table.rows.map(toCsvRow)];

  return BOM + lines.join(ROW_SEPARATOR) + ROW_SEPARATOR;
}

/**
 * `azhary-payments-2026-08-15.csv`
 *
 * Dated so that two exports a week apart do not overwrite each other in the
 * Downloads folder, which is where these files live.
 */
export function csvFilename(subject: string, isoDate: string): string {
  return `azhary-${subject}-${isoDate}.csv`;
}
