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

import { collection, getDocs, Timestamp, type Firestore } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

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
import type { AuditActor } from './audit.service';
import { AppError } from './errors';

function db(): Firestore {
  return getFirebaseClient().db;
}

export class BackupServiceError extends AppError {
  constructor(code: string, message: string) {
    super('BackupServiceError', code, message);
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

/*
 * Deserialisation lives in the Cloud Function, not here.
 *
 * The client no longer writes restored records — the rules refuse it — so
 * turning epoch milliseconds back into `Timestamp` happens in
 * `functions/src/backup.ts`, next to the writes that need it. Keeping a second
 * copy here would be two lists of timestamp field names drifting apart, and a
 * field missing from one restores as a plain number: every date query touching
 * it silently stops matching.
 */

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
 * How many records travel in one request.
 *
 * A callable is capped at 10 MB. Reservations carry a whole pricing snapshot and
 * invoices carry an entire frozen document, so 200 is a size that stays well
 * inside the cap for the heaviest collection rather than one tuned for the
 * lightest.
 */
const CHUNK_SIZE = 200;

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
 * Restore a validated backup.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS GOES THROUGH A CLOUD FUNCTION
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A restore writes `reservations`, `reservationItems`, `financialEvents`,
 * `invoices` and `auditLogs`. Every one of those refuses client writes
 * entirely — a browser that could write a financial event could write any
 * financial event — so the rules would reject this from here, and rightly.
 *
 * The Function is owner-only and re-validates every chunk with the same domain
 * validator used below, so the check here is a courtesy that fails fast and
 * cheaply, not the control.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS NOT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * **Not atomic across the file.** Firestore has no transaction at this size and
 * a callable has a 10 MB request cap, so the file goes up a page at a time.
 *
 * What makes that survivable: the whole file is validated before anything is
 * sent, so a mid-restore failure is an infrastructure failure rather than a
 * data one; and every write is keyed by its original id, so re-running an
 * interrupted restore converges rather than duplicating. OPERATIONS.md says to
 * re-run for exactly this reason.
 *
 * **Not a synchronisation.** Records the file does not mention are left alone.
 * Deleting them would make this a very different and far more dangerous
 * operation.
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

  const restoreChunk = httpsCallable<
    { schemaVersion: number; collection: BackupCollection; records: readonly BackupRecord[] },
    { written: number }
  >(getFirebaseClient().functions, 'restoreBackupChunk');

  let written = 0;
  let touchedCollections = 0;

  for (const name of BACKUP_COLLECTIONS) {
    const records = file.collections[name] ?? [];
    if (records.length === 0) continue;

    touchedCollections += 1;

    for (let offset = 0; offset < records.length; offset += CHUNK_SIZE) {
      const page = records.slice(offset, offset + CHUNK_SIZE);

      const result = await restoreChunk({
        schemaVersion: file.schemaVersion,
        collection: name,
        records: page,
      });

      written += result.data.written;
      input.onProgress?.({ collection: name, written, total: validation.totalRecords });
    }
  }

  /*
   * Audited after the chunks, never before. An entry claiming a restore that
   * then failed halfway would be worse than none; this one records what landed.
   */
  const finish = httpsCallable<
    {
      records: number;
      collections: number;
      schemaVersion: number;
      exportedAt: string;
      fromProject: string;
    },
    { ok: true }
  >(getFirebaseClient().functions, 'finishRestore');

  await finish({
    records: written,
    collections: touchedCollections,
    schemaVersion: file.schemaVersion,
    exportedAt: file.exportedAt,
    fromProject: file.projectId,
  });

  return { written, collections: touchedCollections };
}
