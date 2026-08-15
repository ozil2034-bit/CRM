/**
 * Backup — export and restore.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT AN EXPORT IS
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A file the owner keeps, answering one question: *if the project were lost
 * tomorrow, could the boutique be put back?*
 *
 * It is **downloaded to the device and uploaded nowhere.** Not to a bucket, not
 * to an inbox, not to this application's own storage. A backup that silently
 * travels somewhere is a copy of every customer's name, phone number and
 * spending in a place nobody chose.
 *
 * Photographs are **not** in it. They live in Firebase Storage and are
 * megabytes each; a JSON file carrying them would be unusable and would fail in
 * a browser tab long before it finished. The export records their storage paths,
 * so a restore reconnects to photographs that survived — and OPERATIONS.md says
 * plainly that Storage needs its own backup.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT A RESTORE DOES
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Writes each record back **under its original id**, with its original
 * timestamps and its original financial history. Nothing is renumbered, nothing
 * is recalculated. A restore that re-derived balances would quietly replace the
 * record with what today's code thinks it should have been, which is the
 * opposite of restoring.
 *
 * It validates first, completely, and refuses the whole file if anything is
 * wrong. A partial restore leaves a database that looks populated and is
 * internally broken, and nobody can tell which half arrived.
 */

import {
  collection,
  doc,
  getDocs,
  setDoc,
  Timestamp,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';

import { getFirebaseClient } from '@/lib/firebase/client';
import {
  planImport,
  validateBackup,
  BACKUP_COLLECTIONS,
  CURRENT_SCHEMA_VERSION,
  type BackupCollection,
  type BackupFile,
  type BackupRecord,
  type ImportPlan,
  type ValidationResult,
} from '@/domain/backup';
import { auditWriteFor, type AuditActor } from './audit.service';

function db(): Firestore {
  return getFirebaseClient().db;
}

export class BackupServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BackupServiceError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------------ *
 * Serialisation
 * ------------------------------------------------------------------------ */

/**
 * Convert a Firestore value into something JSON can hold.
 *
 * `Timestamp` becomes epoch milliseconds, which is what the validator expects
 * and what `deserialise` turns back into a `Timestamp`. The round trip is
 * lossless to the millisecond — Firestore stores nanoseconds, but nothing in
 * this application has ever written sub-millisecond precision, and a wedding
 * booking does not need it.
 */
function serialise(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) return value.map(serialise);

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        serialise(entry),
      ]),
    );
  }

  return value;
}

/**
 * Field names that were timestamps and must become timestamps again.
 *
 * Restored by name, because a number cannot say whether it was an instant or a
 * quantity. The alternative — a tagged wrapper like `{__ts: 1234}` — would make
 * the file harder to read and to repair by hand, which is exactly what somebody
 * doing a restore at nine in the evening needs to be able to do.
 */
const TIMESTAMP_FIELDS: ReadonlySet<string> = new Set([
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
  'publishedAt',
]);

function deserialise(value: unknown, key?: string): unknown {
  if (key !== undefined && TIMESTAMP_FIELDS.has(key)) {
    if (value === null) return null;
    if (typeof value === 'number') return Timestamp.fromMillis(value);
  }

  if (Array.isArray(value)) return value.map((entry) => deserialise(entry));

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, entry]) => [
        name,
        deserialise(entry, name),
      ]),
    );
  }

  return value;
}

/* ------------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------------ */

export interface ExportResult {
  readonly file: BackupFile;
  readonly json: string;
  readonly filename: string;
  readonly totalRecords: number;
}

/**
 * Read every collection and build the file.
 *
 * Sequential rather than parallel: a restore is a rare, deliberate act and the
 * owner is watching a progress line. Sixteen concurrent unbounded reads would
 * be faster and would also be the single heaviest thing this application ever
 * asks Firestore to do.
 *
 * A collection the caller cannot read — `auditLogs` for staff — is **not**
 * silently skipped. The export is owner-only precisely so this cannot produce a
 * file that looks complete and is not.
 */
export async function exportAllData(input: {
  readonly projectId: string;
  readonly environment: 'development' | 'production';
  readonly applicationVersion: string;
  readonly onProgress?: (collection: BackupCollection, index: number, total: number) => void;
}): Promise<ExportResult> {
  const collections: Partial<Record<BackupCollection, BackupRecord[]>> = {};

  for (const [index, name] of BACKUP_COLLECTIONS.entries()) {
    input.onProgress?.(name, index, BACKUP_COLLECTIONS.length);

    const snapshot = await getDocs(collection(db(), name));

    collections[name] = snapshot.docs.map((document) => ({
      id: document.id,
      data: serialise(document.data()) as Record<string, unknown>,
    }));
  }

  const exportedAt = new Date().toISOString();

  const file: BackupFile = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt,
    applicationVersion: input.applicationVersion,
    projectId: input.projectId,
    environment: input.environment,
    collections,
  };

  /*
   * Validated before it is offered. Claiming "backup successful" for a file
   * this application would itself refuse to read is the one thing a backup
   * feature must never do.
   */
  const check = validateBackup(file);

  if (!check.ok) {
    throw new BackupServiceError(
      'invalid-export',
      'The export could not be completed because the data did not pass validation. Nothing was downloaded.',
    );
  }

  const json = JSON.stringify(file, null, 2);

  return {
    file,
    json,
    filename: `azhary-backup-${exportedAt.slice(0, 10)}-${input.projectId}.json`,
    totalRecords: check.totalRecords,
  };
}

/**
 * Hand the file to the browser.
 *
 * Separate from building it so the caller can report success only once the file
 * genuinely exists — and so the pure part stays testable without a DOM.
 */
export function downloadBackup(result: ExportResult): void {
  const blob = new Blob([result.json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = result.filename;
  anchor.click();

  // Revoked on the next tick: revoking synchronously can cancel the download in
  // some browsers before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------------ *
 * Reading a file
 * ------------------------------------------------------------------------ */

export interface InspectedBackup {
  readonly file: BackupFile;
  readonly validation: ValidationResult;
  readonly plan: readonly ImportPlan[];
}

/**
 * Parse, validate and plan — without writing anything.
 *
 * This is what the confirmation screen shows. Nothing in the database is
 * touched until the owner has seen this and pressed the button.
 */
export async function inspectBackup(text: string): Promise<InspectedBackup> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupServiceError(
      'not-json',
      'That file is not valid JSON, so it cannot be a backup. Nothing has been changed.',
    );
  }

  const validation = validateBackup(parsed);

  if (!validation.ok) {
    return { file: parsed as BackupFile, validation, plan: [] };
  }

  const file = parsed as BackupFile;

  /*
   * What is already there, so the summary can say how many records would be
   * overwritten rather than only how many would arrive. Only the collections
   * the file actually carries are read.
   */
  const existing: Partial<Record<BackupCollection, ReadonlySet<string>>> = {};

  for (const name of BACKUP_COLLECTIONS) {
    if ((file.collections[name]?.length ?? 0) === 0) continue;

    const snapshot = await getDocs(collection(db(), name));
    existing[name] = new Set(snapshot.docs.map((document) => document.id));
  }

  return { file, validation, plan: planImport(file, existing) };
}

/* ------------------------------------------------------------------------ *
 * Restore
 * ------------------------------------------------------------------------ */

/**
 * Firestore caps a batch at 500 writes.
 *
 * A restore of a real boutique is thousands of records, so it is committed in
 * chunks. That means a restore is **not atomic across the whole file**, which
 * is a genuine limitation and not a design choice — Firestore offers no
 * cross-batch transaction at this size.
 *
 * What mitigates it: validation has already passed completely, so a mid-restore
 * failure is an infrastructure failure rather than a data one, and re-running
 * the same file is safe because every write is keyed by its original id and
 * therefore idempotent. OPERATIONS.md says to re-run on failure for exactly
 * this reason.
 */
const BATCH_LIMIT = 450;

export interface ImportProgress {
  readonly collection: BackupCollection;
  readonly written: number;
  readonly total: number;
}

export interface ImportResult {
  readonly written: number;
  readonly collections: number;
}

/**
 * Write a validated backup back into Firestore.
 *
 * **Refuses an invalid file outright.** Re-validated here rather than trusting
 * the caller's earlier check: this is the last point before data is written,
 * and the file could have been swapped between inspection and confirmation.
 *
 * Every record keeps its id, so a restore over a live database updates the
 * matching records and creates the rest. Nothing is deleted — a restore puts
 * data back; removing records the file does not mention would make it a
 * synchronisation, which is a different and far more dangerous operation.
 */
export async function importBackup(input: {
  readonly file: unknown;
  readonly actor: AuditActor;
  readonly onProgress?: (progress: ImportProgress) => void;
}): Promise<ImportResult> {
  const validation = validateBackup(input.file);

  if (!validation.ok) {
    throw new BackupServiceError(
      'invalid',
      'This file did not pass validation, so nothing was restored.',
    );
  }

  const file = input.file as BackupFile;
  let written = 0;
  let touchedCollections = 0;

  for (const name of BACKUP_COLLECTIONS) {
    const records = file.collections[name] ?? [];
    if (records.length === 0) continue;

    touchedCollections += 1;

    for (let offset = 0; offset < records.length; offset += BATCH_LIMIT) {
      const chunk = records.slice(offset, offset + BATCH_LIMIT);
      const batch = writeBatch(db());

      for (const record of chunk) {
        batch.set(
          doc(db(), name, record.id),
          deserialise(record.data) as Record<string, unknown>,
        );
      }

      await batch.commit();
      written += chunk.length;

      input.onProgress?.({ collection: name, written, total: validation.totalRecords });
    }
  }

  /*
   * Audited after the fact, and deliberately not inside the restore: an audit
   * entry claiming a restore that then failed would be worse than none. This
   * one records what actually landed.
   */
  const audit = auditWriteFor(db(), {
    actor: input.actor,
    action: 'data.imported',
    entityType: 'settings',
    entityId: 'backup',
    entityCode: 'backup',
    after: {
      records: written,
      collections: touchedCollections,
      schemaVersion: file.schemaVersion,
      exportedAt: file.exportedAt,
      fromProject: file.projectId,
    },
  });

  await setDoc(audit.ref, audit.data);

  return { written, collections: touchedCollections };
}
