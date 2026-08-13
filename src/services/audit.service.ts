/**
 * Audit trail.
 *
 * Every create, update and archive writes one entry. The rules enforce that
 * `actorUid` equals the caller, so an employee cannot attribute an action to
 * someone else, and no role may amend or delete an entry once written.
 *
 * Entries are written inside the same transaction as the change they describe
 * wherever a transaction is already in play, so a committed change always has
 * its audit record and a failed one leaves none.
 */

import {
  collection,
  doc,
  serverTimestamp,
  type Firestore,
  type Transaction,
} from 'firebase/firestore';

import type { Role } from '@/domain/authorization';

export type AuditAction =
  | 'dress.created'
  | 'dress.updated'
  | 'dress.status_changed'
  | 'dress.retired'
  | 'dress.photo_added'
  | 'dress.photo_removed'
  | 'customer.created'
  | 'customer.updated'
  | 'customer.archived'
  | 'customer.restored';

export interface AuditActor {
  readonly uid: string;
  readonly name: string;
  readonly role: Role;
}

export interface AuditInput {
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly entityType: 'dress' | 'customer';
  readonly entityId: string;
  readonly entityCode: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly reason?: string | undefined;
}

/**
 * Fields that must never reach an audit entry.
 *
 * The specification asks not to store unnecessary sensitive customer
 * information in audit logs. A national ID identifies a person to the state and
 * has no place in a change log that exists to answer "who changed what"; notes
 * and measurements are personal and equally unnecessary — the fact that they
 * changed is the auditable event, not their contents.
 */
const REDACTED_FIELDS: ReadonlySet<string> = new Set([
  'nationalId',
  'notes',
  'measurements',
  'searchTokens',
  'email',
]);

/**
 * Reduce a change to what is worth recording.
 *
 * Only changed fields are kept — a full document copy per edit would grow
 * without bound and bury the actual change. Redacted fields are recorded as
 * having changed, without their values.
 */
export function summariseChange(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { before: Record<string, unknown> | null; after: Record<string, unknown> | null } {
  if (before === null || after === null) {
    return {
      before: before === null ? null : redact(before),
      after: after === null ? null : redact(after),
    };
  }

  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of keys) {
    const from = before[key];
    const to = after[key];

    if (isEqual(from, to)) continue;

    if (REDACTED_FIELDS.has(key)) {
      changedBefore[key] = '[redacted]';
      changedAfter[key] = '[redacted]';
      continue;
    }

    changedBefore[key] = from ?? null;
    changedAfter[key] = to ?? null;
  }

  return { before: changedBefore, after: changedAfter };
}

function redact(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = REDACTED_FIELDS.has(key) ? '[redacted]' : value;
  }
  return result;
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Build the document body. Exposed for testing without Firestore. */
export function buildAuditRecord(input: AuditInput): Record<string, unknown> {
  const { before, after } = summariseChange(input.before ?? null, input.after ?? null);

  return {
    actorUid: input.actor.uid,
    actorName: input.actor.name,
    actorRole: input.actor.role,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    entityCode: input.entityCode,
    before,
    after,
    reason: input.reason ?? null,
  };
}

/** Append an audit entry inside an existing transaction. */
export function writeAuditInTransaction(
  db: Firestore,
  transaction: Transaction,
  input: AuditInput,
): void {
  const ref = doc(collection(db, 'auditLogs'));
  transaction.set(ref, {
    ...buildAuditRecord(input),
    // Server clock: audit ordering must not depend on a device's clock.
    at: serverTimestamp(),
  });
}

/** A reference and body for a standalone audit write (outside a transaction). */
export function auditWriteFor(db: Firestore, input: AuditInput) {
  return {
    ref: doc(collection(db, 'auditLogs')),
    data: { ...buildAuditRecord(input), at: serverTimestamp() },
  };
}
