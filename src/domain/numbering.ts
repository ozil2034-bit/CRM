/**
 * Human-facing record numbers.
 *
 * `WD-0001`, `CU-0001`, `RSV-0001`, `INV-2026-0001`.
 *
 * This module only *formats* a number that has already been allocated. The
 * allocation itself is a Firestore transaction against `counters/{id}`
 * (src/services/numbering.service.ts), because deciding "what is the next
 * number?" in the browser is exactly the race the specification forbids.
 *
 * `array.length + 1` appears nowhere in this codebase and cannot: nothing here
 * accepts a collection.
 *
 * Pure: no I/O, no Firebase, no clock.
 */

export type SequenceKind = 'dress' | 'customer' | 'reservation' | 'invoice' | 'accessory';

export interface NumberFormat {
  readonly prefix: string;
  readonly separator: string;
  readonly padding: number;
  /** Invoice numbers embed the year: `INV-2026-0001`. */
  readonly includeYear?: boolean;
}

/**
 * Defaults, overridable from Settings by the owner in a later phase.
 * Nothing in the application hard-codes a prefix outside this table.
 */
export const DEFAULT_NUMBER_FORMATS: Readonly<Record<SequenceKind, NumberFormat>> = {
  dress: { prefix: 'WD', separator: '-', padding: 4 },
  customer: { prefix: 'CU', separator: '-', padding: 4 },
  reservation: { prefix: 'RSV', separator: '-', padding: 4 },
  invoice: { prefix: 'INV', separator: '-', padding: 4, includeYear: true },
  accessory: { prefix: 'ACC', separator: '-', padding: 4 },
};

export class NumberingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NumberingError';
  }
}

/**
 * Render an allocated sequence value as a display code.
 *
 * @param sequence 1-based. The counter stores the last issued value, so the
 *                 first record is 1 and renders as `0001`.
 * @param year     required when the format includes a year.
 */
export function formatRecordNumber(sequence: number, format: NumberFormat, year?: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new NumberingError(`Sequence must be a positive integer, received: ${sequence}`);
  }
  if (!Number.isInteger(format.padding) || format.padding < 1) {
    throw new NumberingError(`Padding must be a positive integer, received: ${format.padding}`);
  }
  if (format.prefix.length === 0) {
    throw new NumberingError('Prefix must not be empty.');
  }

  /*
   * Widen rather than truncate on overflow. A boutique that reaches its
   * ten-thousandth dress gets `WD-10000`, not a code that collides with
   * `WD-0000`. Losing uniqueness to preserve a column width would be the wrong
   * trade in a system where the code is how staff identify a garment.
   */
  const digits = String(sequence).padStart(format.padding, '0');

  const parts = [format.prefix];

  if (format.includeYear === true) {
    if (year === undefined || !Number.isInteger(year)) {
      throw new NumberingError('A year is required for this number format.');
    }
    parts.push(String(year));
  }

  parts.push(digits);

  return parts.join(format.separator);
}

/** Convenience wrapper using the default format for a kind. */
export function formatFor(kind: SequenceKind, sequence: number, year?: number): string {
  return formatRecordNumber(sequence, DEFAULT_NUMBER_FORMATS[kind], year);
}

/**
 * The `counters/{counterId}` document id for a sequence.
 *
 * Invoices are counted per year so the sequence resets on 1 January without a
 * migration; everything else uses a single lifetime counter.
 */
export function counterIdFor(kind: SequenceKind, year?: number): string {
  if (DEFAULT_NUMBER_FORMATS[kind].includeYear === true) {
    if (year === undefined || !Number.isInteger(year)) {
      throw new NumberingError(`A year is required for the ${kind} counter.`);
    }
    return `${kind}-${year}`;
  }
  return kind;
}

/** Recognise a display code, e.g. to route a search term. */
export function parseRecordNumber(
  code: string,
): { kind: SequenceKind; sequence: number; year?: number } | null {
  const trimmed = code.trim().toUpperCase();

  for (const [kind, format] of Object.entries(DEFAULT_NUMBER_FORMATS) as [
    SequenceKind,
    NumberFormat,
  ][]) {
    const separator = escapeRegExp(format.separator);
    const pattern =
      format.includeYear === true
        ? new RegExp(`^${format.prefix}${separator}(\\d{4})${separator}(\\d+)$`)
        : new RegExp(`^${format.prefix}${separator}(\\d+)$`);

    const match = pattern.exec(trimmed);
    if (!match) continue;

    if (format.includeYear === true) {
      return { kind, year: Number(match[1]), sequence: Number(match[2]) };
    }
    return { kind, sequence: Number(match[1]) };
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
