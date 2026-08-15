/**
 * CSV exports — the five lists the boutique is asked for.
 *
 * Different job from the JSON backup, and worth keeping separate. A backup is
 * for restoring the system: every field, every collection, ids included, and no
 * human is meant to read it. A CSV is for a person — an accountant reconciling
 * payments, an owner checking the rail against a list, a stylist posting to
 * customers. It carries the columns that person needs and leaves out the rest.
 *
 * What is deliberately not exported:
 *
 * - **Internal ids.** They mean nothing outside the database and turn a readable
 *   sheet into noise. The human-facing code (`CUS-0001`, `RSV-0042`) is there
 *   instead, and it is what an employee would search for anyway.
 * - **Dress purchase cost.** Owner-only inside the application; a spreadsheet
 *   that leaves the building must not be the way it escapes.
 * - **Measurements.** A bride's bust and waist are not reconciliation data, and
 *   a file in a Downloads folder is not where they belong.
 * - **Notes.** Free text written for colleagues, frequently about a customer.
 *
 * The reads are one-shot `getDocs`, not listeners: this is a point-in-time
 * document, and the moment it is written it stops being live.
 */

import { collection, getDocs, orderBy, query, type Firestore } from 'firebase/firestore';

import { getFirebaseClient } from '@/lib/firebase/client';
import { csvAmount, csvFilename, toCsvFile, type CsvTable } from '@/domain/csv';
import { toMuscatDate, toMuscatWallTime, type EpochMs } from '@/domain/datetime';
import { baisa, type Baisa } from '@/domain/money';
import { AppError } from './errors';

function db(): Firestore {
  return getFirebaseClient().db;
}

export class CsvExportError extends AppError {
  constructor(code: string, message: string) {
    super('CsvExportError', code, message);
  }
}

/** The lists an owner can ask for. */
export const CSV_SUBJECTS = [
  'customers',
  'dresses',
  'reservations',
  'payments',
  'invoices',
] as const;

export type CsvSubject = (typeof CSV_SUBJECTS)[number];

export interface CsvExportResult {
  readonly subject: CsvSubject;
  readonly filename: string;
  readonly content: string;
  readonly rows: number;
}

/* ------------------------------------------------------------------------ *
 * Field readers
 * ------------------------------------------------------------------------ */

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
const money = (value: unknown): Baisa =>
  typeof value === 'number' && Number.isInteger(value) ? baisa(value) : baisa(0);

/**
 * A stored instant → a Muscat date.
 *
 * Exports use Asia/Muscat wall time, not UTC and not the browser's zone. The
 * person reading the file is in Muscat, and a pickup at 09:00 on the 3rd must
 * not appear as 05:00 on the 3rd because the file was produced on a laptop set
 * to London.
 */
function instant(value: unknown): EpochMs | null {
  if (typeof value === 'number') return value as EpochMs;

  if (typeof value === 'object' && value !== null && 'toMillis' in value) {
    return (value as { toMillis: () => number }).toMillis() as EpochMs;
  }

  return null;
}

const dateCell = (value: unknown): string => {
  const at = instant(value);
  return at === null ? '' : toMuscatDate(at);
};

const dateTimeCell = (value: unknown): string => {
  const at = instant(value);
  return at === null ? '' : toMuscatWallTime(at).replace('T', ' ');
};

const yesNo = (value: unknown): string => (value === true ? 'Yes' : 'No');

/* ------------------------------------------------------------------------ *
 * The tables
 * ------------------------------------------------------------------------ */

async function read(name: string, orderField: string): Promise<Record<string, unknown>[]> {
  /*
   * Ordered by the code rather than by creation time, because the file is read
   * by a human scanning for a record. An index on a single field is created
   * automatically, so this adds no configuration.
   */
  const snapshot = await getDocs(query(collection(db(), name), orderBy(orderField)));

  return snapshot.docs.map((document) => document.data());
}

async function customersTable(): Promise<CsvTable> {
  const rows = await read('customers', 'code');

  return {
    headers: [
      'Code',
      'Name (English)',
      'Name (Arabic)',
      'Phone',
      'WhatsApp',
      'Email',
      'Event date',
      'Preferred language',
      'Source',
      'Archived',
    ],
    rows: rows.map((data) => [
      str(data['code']),
      str(data['nameEn']),
      str(data['nameAr']),
      str(data['phone']),
      yesNo(data['hasWhatsapp']),
      str(data['email']),
      str(data['eventDate']),
      str(data['preferredLanguage']),
      str(data['source']),
      yesNo(data['archived']),
    ]),
  };
}

async function dressesTable(): Promise<CsvTable> {
  const rows = await read('dresses', 'code');

  return {
    headers: [
      'Code',
      'Name',
      'Designer',
      'Brand',
      'Size',
      'Colour',
      'Style',
      'Condition',
      'Status',
      'Rental price (OMR)',
      'Security deposit (OMR)',
      'Cleaning buffer (days)',
      'Location',
    ],
    rows: rows.map((data) => [
      str(data['code']),
      str(data['name']),
      str(data['designer']),
      str(data['brand']),
      str(data['size']),
      str(data['color']),
      str(data['style']),
      str(data['condition']),
      str(data['status']),
      csvAmount(money(data['rentalPrice'])),
      csvAmount(money(data['securityDeposit'])),
      String(num(data['cleaningBufferDays'])),
      str(data['location']),
      // `purchaseCost` is deliberately absent — see the module header.
    ]),
  };
}

async function reservationsTable(): Promise<CsvTable> {
  const rows = await read('reservations', 'code');

  return {
    headers: [
      'Code',
      'Customer',
      'Customer (Arabic)',
      'Phone',
      'Status',
      'Pickup',
      'Return',
      'Actual return',
      'Event date',
      'Rental (OMR)',
      'Accessories (OMR)',
      'Alterations (OMR)',
      'Discount (OMR)',
      'VAT rate (%)',
      'VAT (OMR)',
      'Grand total (OMR)',
      'Security deposit (OMR)',
    ],
    rows: rows.map((data) => {
      const pricing = (data['pricing'] ?? {}) as Record<string, unknown>;

      return [
        str(data['code']),
        str(data['customerName']),
        str(data['customerNameAr']),
        str(data['customerPhone']),
        str(data['status']),
        dateCell(data['pickupAt']),
        dateCell(data['returnAt']),
        dateCell(data['actualReturnAt']),
        str(data['eventDate']),
        csvAmount(money(pricing['rentalSubtotal'])),
        csvAmount(money(pricing['accessorySubtotal'])),
        csvAmount(money(pricing['alterationSubtotal'])),
        csvAmount(money(pricing['discountAmount'])),
        String(num(pricing['vatRatePercent'])),
        csvAmount(money(pricing['vatAmount'])),
        csvAmount(money(pricing['grandTotal'])),
        csvAmount(money(pricing['securityDepositTotal'])),
      ];
    }),
  };
}

async function paymentsTable(): Promise<CsvTable> {
  /*
   * Ordered by when it happened, not by code: this file is reconciled against a
   * bank statement, and a statement is chronological.
   */
  const rows = await read('financialEvents', 'occurredAt');

  return {
    headers: [
      'Occurred',
      'Reservation',
      'Kind',
      'Amount (OMR)',
      'Method',
      'Type',
      'Reference',
      'Reason',
      'Reverses',
      'Recorded by',
    ],
    rows: rows.map((data) => [
      dateTimeCell(data['occurredAt']),
      str(data['reservationCode']),
      str(data['kind']),
      csvAmount(money(data['amount'])),
      str(data['method']),
      str(data['type']),
      str(data['reference']),
      str(data['reason']),
      str(data['reversesEventId']),
      str(data['employeeName']),
    ]),
  };
}

async function invoicesTable(): Promise<CsvTable> {
  const rows = await read('invoices', 'documentNumber');

  return {
    headers: [
      'Number',
      'Type',
      'Status',
      'Issued',
      'Reservation',
      'Customer',
      'Subtotal (OMR)',
      'Discount (OMR)',
      'VAT rate (%)',
      'VAT (OMR)',
      'Grand total (OMR)',
      'Paid (OMR)',
      'Balance (OMR)',
      'Issued by',
    ],
    rows: rows.map((data) => {
      const financials = (data['financials'] ?? {}) as Record<string, unknown>;
      const customer = (data['customer'] ?? {}) as Record<string, unknown>;

      return [
        str(data['documentNumber']),
        str(data['documentType']),
        str(data['status']),
        dateCell(data['issuedAt']),
        str(data['reservationCode']),
        str(customer['nameEn']),
        csvAmount(money(financials['taxableSubtotal'])),
        csvAmount(money(financials['discountAmount'])),
        String(num(financials['vatRatePercent'])),
        csvAmount(money(financials['vatAmount'])),
        csvAmount(money(financials['grandTotal'])),
        csvAmount(money(financials['amountPaid'])),
        csvAmount(money(financials['balanceDue'])),
        str(data['issuedByName']),
      ];
    }),
  };
}

const BUILDERS: Readonly<Record<CsvSubject, () => Promise<CsvTable>>> = {
  customers: customersTable,
  dresses: dressesTable,
  reservations: reservationsTable,
  payments: paymentsTable,
  invoices: invoicesTable,
};

/* ------------------------------------------------------------------------ *
 * The operation
 * ------------------------------------------------------------------------ */

export async function exportCsv(subject: CsvSubject): Promise<CsvExportResult> {
  const build = BUILDERS[subject];

  if (build === undefined) {
    throw new CsvExportError('unknown-subject', 'That is not a list this application exports.');
  }

  const table = await build();

  return {
    subject,
    filename: csvFilename(subject, toMuscatDate(Date.now() as EpochMs)),
    content: toCsvFile(table),
    rows: table.rows.length,
  };
}

/**
 * Hand the file to the browser.
 *
 * `text/csv` with an explicit UTF-8 charset. The byte-order mark inside the
 * content is what Excel actually reads, but a browser that respects the charset
 * saves the bytes correctly in the first place.
 */
export function downloadCsv(result: CsvExportResult): void {
  const blob = new Blob([result.content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.filename;
  anchor.click();

  // Revoked on the next tick: revoking synchronously can cancel the download in
  // some browsers before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
