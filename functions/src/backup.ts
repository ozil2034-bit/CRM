/**
 * Restore — the trusted server-side operation.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS RUNS ON THE SERVER
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A restore writes `reservations`, `reservationItems`, `financialEvents`,
 * `invoices` and `auditLogs`. **Every one of those refuses client writes
 * entirely**, and that is not an oversight to work around — it is the property
 * the whole platform rests on. A browser that could write a financial event
 * could write any financial event.
 *
 * So restore joins booking, payment and document issuance on the server, where
 * the Admin SDK bypasses the rules and an owner check stands in their place.
 *
 * Export needs no Function: an owner may already *read* everything, so the
 * client builds the file directly.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT ARRIVES IN CHUNKS
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A callable request is capped at 10 MB and a real boutique's backup will
 * exceed that. The client sends one collection at a time, in pages, and drives
 * the loop — which also lets it report honest progress instead of a spinner
 * that means nothing.
 *
 * The consequence is that a restore is **not atomic across the whole file**.
 * Firestore offers no transaction at this size, so this is a limitation rather
 * than a choice. What makes it survivable: the client validates the whole file
 * before sending anything, this Function re-validates every chunk, and every
 * write is keyed by its original id — so re-running an interrupted restore
 * converges rather than duplicating.
 */

import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

import { callerFrom, db, readProfile, writeAudit } from './lib/firestore';
import { effectiveRole } from './lib/guards';
import {
  isBackupCollection,
  validateBackup,
  SUPPORTED_SCHEMA_VERSIONS,
  type BackupRecord,
} from '../../src/domain/backup';

/* ------------------------------------------------------------------------ *
 * Caller
 * ------------------------------------------------------------------------ */

interface Actor {
  readonly uid: string;
  readonly name: string;
}

/**
 * Restore is **owner-only**, checked here and not merely in the interface.
 *
 * It can overwrite every record in the boutique. There is no operation in this
 * application with a wider blast radius, and a staff account should not be able
 * to reach it even by calling the endpoint directly.
 */
async function requireOwner(request: CallableRequest<unknown>): Promise<Actor> {
  const caller = callerFrom(request.auth);

  if (caller.uid === null) {
    throw new HttpsError('unauthenticated', 'Sign in to perform this action.');
  }

  const profile = await readProfile(caller.uid);
  const role = effectiveRole(caller, profile);

  if (role !== 'OWNER') {
    throw new HttpsError('permission-denied', 'Only the owner may restore a backup.');
  }

  return {
    uid: caller.uid,
    name: (request.auth?.token['name'] as string | undefined) ?? 'Owner',
  };
}

/* ------------------------------------------------------------------------ *
 * Deserialisation
 * ------------------------------------------------------------------------ */

/**
 * Field names that were `Timestamp` and must become `Timestamp` again.
 *
 * Must stay in step with the exporter in `src/services/backup.service.ts`. A
 * field missing from this list restores as a plain number, and every date query
 * touching it silently stops matching — which is the kind of failure that is
 * discovered weeks later by a booking that does not appear on a calendar.
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
 * restoreBackupChunk
 * ------------------------------------------------------------------------ */

interface ChunkRequest {
  readonly schemaVersion?: unknown;
  readonly collection?: unknown;
  readonly records?: unknown;
}

/** Firestore caps a batch at 500. */
const BATCH_LIMIT = 450;

/**
 * Write one collection's records, or a page of them.
 *
 * Re-validates the chunk with the **same domain validator the client used**, so
 * a caller that skipped the interface — or a client with an older validator —
 * cannot write a fractional amount or a credential into the database.
 */
export const restoreBackupChunk = onCall(async (request: CallableRequest<ChunkRequest>) => {
  const actor = await requireOwner(request);
  const data = request.data ?? {};

  const schemaVersion = data.schemaVersion;

  if (typeof schemaVersion !== 'number' || !SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion)) {
    throw new HttpsError(
      'invalid-argument',
      'This backup was written with a schema version this application cannot read.',
    );
  }

  const name = data.collection;

  if (!isBackupCollection(name)) {
    throw new HttpsError('invalid-argument', 'That is not a collection this application restores.');
  }

  if (!Array.isArray(data.records)) {
    throw new HttpsError('invalid-argument', 'A chunk must carry a list of records.');
  }

  const records = data.records as BackupRecord[];

  if (records.length === 0) {
    return { written: 0 };
  }

  /*
   * Validated as a one-collection file. References are not checked here — the
   * chunk does not carry the collections they point at, and the client
   * validated the whole file before sending anything.
   */
  const check = validateBackup({
    schemaVersion,
    exportedAt: new Date().toISOString(),
    applicationVersion: '',
    projectId: '',
    environment: 'development',
    collections: { [name]: records },
  });

  if (!check.ok) {
    throw new HttpsError(
      'invalid-argument',
      `This part of the backup did not pass validation: ${check.problems[0]?.detail ?? 'unknown problem'}`,
    );
  }

  let written = 0;

  for (let offset = 0; offset < records.length; offset += BATCH_LIMIT) {
    const page = records.slice(offset, offset + BATCH_LIMIT);
    const batch = db().batch();

    for (const record of page) {
      batch.set(
        db().doc(`${name}/${record.id}`),
        deserialise(record.data) as FirebaseFirestore.DocumentData,
      );
    }

    await batch.commit();
    written += page.length;
  }

  logger.info('Backup chunk restored', { collection: name, written, by: actor.uid });

  return { written };
});

/* ------------------------------------------------------------------------ *
 * finishRestore
 * ------------------------------------------------------------------------ */

interface FinishRequest {
  readonly records?: unknown;
  readonly collections?: unknown;
  readonly schemaVersion?: unknown;
  readonly exportedAt?: unknown;
  readonly fromProject?: unknown;
}

/**
 * Record that a restore happened.
 *
 * Written **after** the chunks, never before: an audit entry claiming a restore
 * that then failed halfway would be worse than no entry at all. This one
 * records what actually landed.
 *
 * Separate from the chunks so the count is the total rather than one line per
 * page — an owner reading the trail wants "restored 1,240 records", not
 * thirty-one entries.
 */
export const finishRestore = onCall(async (request: CallableRequest<FinishRequest>) => {
  const actor = await requireOwner(request);
  const data = request.data ?? {};

  const records = typeof data.records === 'number' ? data.records : 0;
  const collections = typeof data.collections === 'number' ? data.collections : 0;

  await db().runTransaction((transaction) => {
    writeAudit(transaction, {
      actorUid: actor.uid,
      actorName: actor.name,
      actorRole: 'OWNER',
      action: 'data.imported',
      entityType: 'settings',
      entityId: 'backup',
      before: null,
      after: {
        records,
        collections,
        schemaVersion: typeof data.schemaVersion === 'number' ? data.schemaVersion : null,
        exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : null,
        fromProject: typeof data.fromProject === 'string' ? data.fromProject : null,
        restoredAt: FieldValue.serverTimestamp(),
      },
    });

    return Promise.resolve();
  });

  logger.info('Restore completed', { records, collections, by: actor.uid });

  return { ok: true as const };
});
