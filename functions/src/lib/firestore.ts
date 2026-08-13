import {
  getFirestore,
  FieldValue,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { initializeApp, getApps } from 'firebase-admin/app';

import type { CallerContext, Role, StoredProfile } from './guards';

/** Initialise the Admin SDK once per container. */
function ensureApp(): void {
  if (getApps().length === 0) {
    initializeApp();
  }
}

export function db(): Firestore {
  ensureApp();
  return getFirestore();
}

export function auth(): Auth {
  ensureApp();
  return getAuth();
}

export const BOOTSTRAP_DOC = 'system/bootstrap';

export function userRef(uid: string) {
  return db().doc(`users/${uid}`);
}

export function bootstrapRef() {
  return db().doc(BOOTSTRAP_DOC);
}

/** Read a user's stored profile in the shape the pure guards expect. */
export async function readProfile(uid: string | null): Promise<StoredProfile> {
  if (uid === null) {
    return { exists: false, role: null, active: null };
  }

  const snapshot = await userRef(uid).get();
  if (!snapshot.exists) {
    return { exists: false, role: null, active: null };
  }

  const data = snapshot.data() ?? {};
  return { exists: true, role: data['role'], active: data['active'] };
}

/** Read a profile inside a transaction, so the check and the write are atomic. */
export async function readProfileInTransaction(
  transaction: Transaction,
  uid: string,
): Promise<StoredProfile> {
  const snapshot = await transaction.get(userRef(uid));
  if (!snapshot.exists) {
    return { exists: false, role: null, active: null };
  }
  const data = snapshot.data() ?? {};
  return { exists: true, role: data['role'], active: data['active'] };
}

export interface AuditEntry {
  readonly actorUid: string;
  readonly actorName: string;
  readonly actorRole: Role | 'SYSTEM';
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly reason?: string | undefined;
}

/**
 * Append an audit record.
 *
 * `at` uses the server timestamp: audit ordering must not depend on a client
 * clock, and the Admin SDK writes bypass security rules, so this is the only
 * path that can record who did what to whom.
 */
export function writeAudit(transaction: Transaction, entry: AuditEntry): void {
  const ref = db().collection('auditLogs').doc();
  transaction.set(ref, {
    ...entry,
    reason: entry.reason ?? null,
    at: FieldValue.serverTimestamp(),
  });
}

export { FieldValue };

/** Build the caller context the pure guards consume from a callable request. */
export function callerFrom(
  authContext: { uid: string; token: Record<string, unknown> } | undefined,
): CallerContext {
  if (!authContext) {
    return { uid: null, claimRole: null };
  }
  return { uid: authContext.uid, claimRole: authContext.token['role'] };
}
