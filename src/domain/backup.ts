/**
 * Backup: export, validation and restore.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT A BACKUP IS FOR
 * ─────────────────────────────────────────────────────────────────────────
 *
 * One question: *if the project were lost tomorrow, could the boutique be put
 * back?* Everything here follows from that.
 *
 * It means **identifiers and timestamps are preserved, never regenerated**. A
 * restore that mints new ids produces a database that superficially resembles
 * the old one and has lost every relationship in it — a payment pointing at a
 * reservation that no longer exists under that name is not a payment.
 *
 * It means **financial history is copied, never recomputed**. A restore that
 * re-derives balances from pricing would quietly "correct" the record to what
 * the current code thinks it should be, which is precisely the opposite of what
 * a backup is. The events are the history; they are moved verbatim.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * VALIDATION REFUSES THE WHOLE FILE, NEVER HALF OF IT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A partial restore is worse than no restore: it leaves a database that looks
 * populated and is internally broken, and nobody can tell which half arrived.
 * So validation runs to completion, reports everything it found, and the import
 * either commits entirely or touches nothing.
 *
 * Pure: no I/O, no Firebase, no clock. The document is a parameter.
 */

/* ------------------------------------------------------------------------ *
 * Schema version
 * ------------------------------------------------------------------------ */

/**
 * The shape of an export file.
 *
 * Bumped only when a change would make an older file unreadable. Adding a
 * collection does not: an importer that has never heard of it simply restores
 * nothing for it, which is the correct behaviour and needs no migration.
 *
 * There are deliberately **no speculative migrations**. `MIGRATIONS` is empty
 * because nothing has changed yet, and writing a migration for a version that
 * has never existed is writing untestable code against an imagined past.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/** Versions this application can read. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];

/**
 * The collections a full backup carries, in dependency order.
 *
 * Order is load-bearing for restore: a reservation references a customer, so
 * customers are written first. Firestore does not enforce referential
 * integrity, but writing in this order means a restore interrupted halfway
 * leaves a database missing leaves rather than missing roots.
 */
export const BACKUP_COLLECTIONS = [
  'businessProfile',
  'settings',
  'termsVersions',
  'counters',
  'dresses',
  'customers',
  'accessories',
  'reservations',
  'reservationItems',
  'fittings',
  'waitlist',
  'financialEvents',
  'invoices',
  'damageLogs',
  'notificationLogs',
  'auditLogs',
] as const;

export type BackupCollection = (typeof BACKUP_COLLECTIONS)[number];

export function isBackupCollection(value: unknown): value is BackupCollection {
  return typeof value === 'string' && (BACKUP_COLLECTIONS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------------ *
 * The file
 * ------------------------------------------------------------------------ */

/** One document, with its id and its fields exactly as stored. */
export interface BackupRecord {
  readonly id: string;
  readonly data: Record<string, unknown>;
}

export interface BackupFile {
  readonly schemaVersion: number;
  /** ISO 8601, UTC. */
  readonly exportedAt: string;
  readonly applicationVersion: string;
  /** Which project this came from, so a restore into the wrong one is visible. */
  readonly projectId: string;
  readonly environment: 'development' | 'production';
  readonly collections: Partial<Record<BackupCollection, readonly BackupRecord[]>>;
}

/**
 * Field names that must never appear in an export.
 *
 * None of these is stored in Firestore today; the check exists because the
 * failure it prevents is catastrophic and silent. An export is a file an owner
 * emails to themselves, and a bootstrap token in it is a permanent grant of
 * ownership to anybody who reads that mailbox.
 */
export const FORBIDDEN_FIELDS: readonly string[] = [
  'bootstrapToken',
  'setupToken',
  'privateKey',
  'apiKey',
  'password',
  'passwordHash',
  'refreshToken',
  'idToken',
  'clientSecret',
  'serviceAccount',
];

/* ------------------------------------------------------------------------ *
 * Problems
 * ------------------------------------------------------------------------ */

export type BackupProblemKind =
  | 'NOT_AN_OBJECT'
  | 'MISSING_SCHEMA_VERSION'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'MISSING_EXPORTED_AT'
  | 'INVALID_EXPORTED_AT'
  | 'MISSING_COLLECTIONS'
  | 'UNKNOWN_COLLECTION'
  | 'RECORD_NOT_AN_OBJECT'
  | 'MISSING_ID'
  | 'DUPLICATE_ID'
  | 'FORBIDDEN_FIELD'
  | 'INVALID_MONEY'
  | 'INVALID_TIMESTAMP'
  | 'BROKEN_REFERENCE';

export interface BackupProblem {
  readonly kind: BackupProblemKind;
  /** Where it was found, e.g. `customers[3]` or `reservations/abc.pickupAt`. */
  readonly where: string;
  readonly detail: string;
}

/* ------------------------------------------------------------------------ *
 * Money and time
 * ------------------------------------------------------------------------ */

/**
 * Fields carrying money, by name.
 *
 * Checked by name rather than by inspecting every number, because a *count* of
 * three and *three baisa* are both integers and only one of them must be
 * rejected for being fractional. This list is the same set of names the
 * financial engine writes.
 */
const MONEY_FIELDS: readonly string[] = [
  'amount',
  'rentalPrice',
  'salePrice',
  'securityDeposit',
  'purchaseCost',
  'unitPrice',
  'lateFeePerDay',
  'rentalSubtotal',
  'accessorySubtotal',
  'alterationSubtotal',
  'discountAmount',
  'taxableSubtotal',
  'vatAmount',
  'securityDepositTotal',
  'grandTotal',
  'rentalPriceSnapshot',
  'securityDepositSnapshot',
];

/** Fields carrying an instant. */
const TIMESTAMP_FIELDS: readonly string[] = [
  'at',
  'occurredAt',
  'issuedAt',
  'createdAt',
  'updatedAt',
  'pickupAt',
  'returnAt',
  'actualReturnAt',
  'blockStartAt',
  'blockEndAt',
  'scheduledAt',
  'eventAt',
  'voidedAt',
];

/**
 * A serialised instant, as the exporter writes them.
 *
 * Firestore `Timestamp` has no JSON form, so the exporter converts to epoch
 * milliseconds. `null` is legitimate — `actualReturnAt` is null until a gown
 * comes back — and is not a problem.
 */
function isValidTimestamp(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'number') return false;
  if (!Number.isFinite(value)) return false;

  /*
   * A negative instant is before 1970 and an absurdly large one is a unit
   * mix-up — seconds read as milliseconds, or the reverse. Both indicate a
   * corrupted file rather than a boutique with unusual dates.
   */
  return value >= 0 && value <= 4_102_444_800_000; // 2100-01-01
}

function isValidMoney(value: unknown): boolean {
  if (value === null) return true;
  return typeof value === 'number' && Number.isInteger(value);
}

/* ------------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------------ */

export interface ValidationResult {
  readonly ok: boolean;
  readonly problems: readonly BackupProblem[];
  /** Records per collection, for the pre-import summary. */
  readonly counts: Readonly<Partial<Record<BackupCollection, number>>>;
  readonly totalRecords: number;
}

/**
 * Validate a parsed backup file.
 *
 * Runs to completion rather than stopping at the first problem: an owner
 * fixing a corrupted export needs the list, not a trail of one error at a time.
 */
export function validateBackup(input: unknown): ValidationResult {
  const problems: BackupProblem[] = [];
  const counts: Partial<Record<BackupCollection, number>> = {};

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      problems: [
        { kind: 'NOT_AN_OBJECT', where: 'file', detail: 'The file is not a backup object.' },
      ],
      counts: {},
      totalRecords: 0,
    };
  }

  const file = input as Record<string, unknown>;

  /* --- The envelope --- */

  const version = file['schemaVersion'];

  if (version === undefined) {
    problems.push({
      kind: 'MISSING_SCHEMA_VERSION',
      where: 'schemaVersion',
      detail: 'The file does not say which schema version it was written with.',
    });
  } else if (typeof version !== 'number' || !SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    problems.push({
      kind: 'UNSUPPORTED_SCHEMA_VERSION',
      where: 'schemaVersion',
      detail: `Schema version ${String(version)} cannot be read by this application.`,
    });
  }

  const exportedAt = file['exportedAt'];

  if (typeof exportedAt !== 'string' || exportedAt.length === 0) {
    problems.push({
      kind: 'MISSING_EXPORTED_AT',
      where: 'exportedAt',
      detail: 'The file does not say when it was exported.',
    });
  } else if (Number.isNaN(Date.parse(exportedAt))) {
    problems.push({
      kind: 'INVALID_EXPORTED_AT',
      where: 'exportedAt',
      detail: 'The export date is not a valid timestamp.',
    });
  }

  const collections = file['collections'];

  if (typeof collections !== 'object' || collections === null || Array.isArray(collections)) {
    problems.push({
      kind: 'MISSING_COLLECTIONS',
      where: 'collections',
      detail: 'The file contains no collections.',
    });

    return { ok: false, problems, counts, totalRecords: 0 };
  }

  /* --- The records --- */

  const idsByCollection = new Map<string, Set<string>>();
  let totalRecords = 0;

  for (const [name, records] of Object.entries(collections as Record<string, unknown>)) {
    if (!isBackupCollection(name)) {
      problems.push({
        kind: 'UNKNOWN_COLLECTION',
        where: `collections.${name}`,
        detail: `"${name}" is not a collection this application knows about.`,
      });
      continue;
    }

    if (!Array.isArray(records)) {
      problems.push({
        kind: 'RECORD_NOT_AN_OBJECT',
        where: `collections.${name}`,
        detail: 'Expected a list of records.',
      });
      continue;
    }

    const seen = new Set<string>();
    idsByCollection.set(name, seen);
    counts[name] = records.length;
    totalRecords += records.length;

    records.forEach((raw, index) => {
      const where = `${name}[${String(index)}]`;

      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        problems.push({
          kind: 'RECORD_NOT_AN_OBJECT',
          where,
          detail: 'A record must be an object.',
        });
        return;
      }

      const record = raw as Record<string, unknown>;
      const id = record['id'];

      if (typeof id !== 'string' || id.length === 0) {
        problems.push({ kind: 'MISSING_ID', where, detail: 'A record must carry its id.' });
        return;
      }

      if (seen.has(id)) {
        problems.push({
          kind: 'DUPLICATE_ID',
          where: `${name}/${id}`,
          detail: 'Two records share this id, so a restore could not say which is correct.',
        });
      }
      seen.add(id);

      const data = record['data'];

      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        problems.push({
          kind: 'RECORD_NOT_AN_OBJECT',
          where: `${name}/${id}`,
          detail: 'A record must carry a data object.',
        });
        return;
      }

      inspectFields(data as Record<string, unknown>, `${name}/${id}`, problems);
    });
  }

  /* --- References --- */

  checkReferences(collections as Record<string, unknown>, idsByCollection, problems);

  return { ok: problems.length === 0, problems, counts, totalRecords };
}

/**
 * Walk one record's fields, to any depth.
 *
 * Nested because a pricing snapshot holds its own money and a document holds a
 * whole nested copy of one. Checking only the top level would let a fractional
 * `grandTotal` inside `pricing` through.
 */
function inspectFields(
  data: Record<string, unknown>,
  where: string,
  problems: BackupProblem[],
): void {
  for (const [key, value] of Object.entries(data)) {
    const path = `${where}.${key}`;

    if (FORBIDDEN_FIELDS.includes(key)) {
      problems.push({
        kind: 'FORBIDDEN_FIELD',
        where: path,
        detail: `"${key}" is a credential and must never appear in a backup.`,
      });
      continue;
    }

    if (MONEY_FIELDS.includes(key) && !isValidMoney(value)) {
      problems.push({
        kind: 'INVALID_MONEY',
        where: path,
        detail: 'Money must be a whole number of baisa.',
      });
    }

    if (TIMESTAMP_FIELDS.includes(key) && !isValidTimestamp(value)) {
      problems.push({
        kind: 'INVALID_TIMESTAMP',
        where: path,
        detail: 'A timestamp must be epoch milliseconds, or null.',
      });
    }

    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
          inspectFields(entry as Record<string, unknown>, `${path}[${String(index)}]`, problems);
        }
      });
    } else if (typeof value === 'object' && value !== null) {
      inspectFields(value as Record<string, unknown>, path, problems);
    }
  }
}

/**
 * The references that must resolve.
 *
 * Only the ones whose absence would leave the restored database incoherent. A
 * `customerId` on a reservation matters; an `employeeId` on an audit entry does
 * not, because a departed employee's user record may legitimately be gone while
 * their actions remain.
 */
const REFERENCES: readonly {
  readonly from: BackupCollection;
  readonly field: string;
  readonly to: BackupCollection;
}[] = [
  { from: 'reservations', field: 'customerId', to: 'customers' },
  { from: 'reservationItems', field: 'reservationId', to: 'reservations' },
  { from: 'reservationItems', field: 'dressId', to: 'dresses' },
  { from: 'fittings', field: 'reservationId', to: 'reservations' },
  { from: 'financialEvents', field: 'reservationId', to: 'reservations' },
  { from: 'invoices', field: 'reservationId', to: 'reservations' },
];

function checkReferences(
  collections: Record<string, unknown>,
  idsByCollection: Map<string, Set<string>>,
  problems: BackupProblem[],
): void {
  for (const reference of REFERENCES) {
    const records = collections[reference.from];
    if (!Array.isArray(records)) continue;

    const targets = idsByCollection.get(reference.to);

    /*
     * A partial export — one collection only — is a legitimate thing to hold,
     * and its references cannot be checked against a collection that is not in
     * the file. Absent is not broken.
     */
    if (targets === undefined) continue;

    for (const raw of records as Record<string, unknown>[]) {
      const data = raw['data'];
      if (typeof data !== 'object' || data === null) continue;

      const value = (data as Record<string, unknown>)[reference.field];
      if (typeof value !== 'string' || value.length === 0) continue;

      if (!targets.has(value)) {
        problems.push({
          kind: 'BROKEN_REFERENCE',
          where: `${reference.from}/${String(raw['id'])}.${reference.field}`,
          detail: `Points at ${reference.to}/${value}, which is not in this file.`,
        });
      }
    }
  }
}

/* ------------------------------------------------------------------------ *
 * The import plan
 * ------------------------------------------------------------------------ */

export interface ImportPlan {
  readonly collection: BackupCollection;
  readonly create: number;
  readonly update: number;
  readonly total: number;
}

/**
 * What an import would do, before it does it.
 *
 * `existingIds` is what the target database already holds. A record whose id is
 * present is an **update**; one whose id is absent is a **create**. Nothing is
 * skipped and nothing is merged: the file is the authority, because a restore
 * that preserved parts of a database it was called in to replace would produce
 * a mixture neither version.
 */
export function planImport(
  file: BackupFile,
  existingIds: Readonly<Partial<Record<BackupCollection, ReadonlySet<string>>>>,
): ImportPlan[] {
  return BACKUP_COLLECTIONS.filter((name) => (file.collections[name]?.length ?? 0) > 0).map(
    (name) => {
      const records = file.collections[name] ?? [];
      const existing = existingIds[name] ?? new Set<string>();

      const update = records.filter((record) => existing.has(record.id)).length;

      return {
        collection: name,
        create: records.length - update,
        update,
        total: records.length,
      };
    },
  );
}

export function totalRecordsIn(file: BackupFile): number {
  return BACKUP_COLLECTIONS.reduce(
    (total, name) => total + (file.collections[name]?.length ?? 0),
    0,
  );
}
