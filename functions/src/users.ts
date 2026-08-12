import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';

import {
  auth,
  callerFrom,
  db,
  FieldValue,
  readProfile,
  readProfileInTransaction,
  userRef,
  writeAudit,
} from './lib/firestore';
import {
  evaluateActivationChange,
  evaluateNewUser,
  evaluateRoleChange,
  normaliseEmail,
  normaliseName,
  requireOwner,
  type Role,
  type Verdict,
} from './lib/guards';

function enforce(verdict: Verdict): void {
  if (!verdict.ok) {
    throw new HttpsError(verdict.code as never, verdict.message);
  }
}

/**
 * Resolve the caller and confirm they are an active owner.
 *
 * Reads the profile from Firestore rather than trusting the token alone, so an
 * owner deactivated a minute ago cannot still manage users on a token that has
 * not yet expired.
 */
async function requireOwnerCaller(request: CallableRequest<unknown>) {
  const caller = callerFrom(request.auth);
  const profile = await readProfile(caller.uid);
  enforce(requireOwner(caller, profile));

  return {
    uid: caller.uid as string,
    name: (request.auth?.token['name'] as string | undefined) ?? 'Owner',
  };
}

/* ------------------------------------------------------------------------ *
 * Create a staff or owner account
 * ------------------------------------------------------------------------ */

interface CreateUserData {
  readonly name?: unknown;
  readonly email?: unknown;
  readonly role?: unknown;
}

/**
 * Create an employee account.
 *
 * No password is accepted, chosen or transmitted here. The account is created
 * without one and the new employee sets their own via a Firebase reset link, so
 * no password ever passes through this system or is seen by the owner.
 */
export const createEmployee = onCall(async (request: CallableRequest<CreateUserData>) => {
  const actor = await requireOwnerCaller(request);

  const data = request.data ?? {};
  enforce(evaluateNewUser({ name: data.name, email: data.email, role: data.role }));

  const name = normaliseName(data.name as string);
  const email = normaliseEmail(data.email as string);
  const role = data.role as Role;

  let userRecord;
  try {
    userRecord = await auth().createUser({ email, displayName: name, emailVerified: false });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'An account with that email already exists.');
    }
    throw new HttpsError('internal', 'The account could not be created.');
  }

  const uid = userRecord.uid;

  /*
   * Profile first, then claim.
   *
   * The Storage rules trust the claim alone (storage.rules explains why), so a
   * claim that outlives its profile would be a real grant rather than a
   * harmless intermediate state. Writing the profile first means the only
   * reachable partial state is a profile with no claim, which grants nothing
   * anywhere: Firestore requires both, and Storage requires the claim.
   */
  await db().runTransaction(async (transaction) => {
    transaction.set(userRef(uid), {
      uid,
      name,
      email,
      role,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    writeAudit(transaction, {
      actorUid: actor.uid,
      actorName: actor.name,
      actorRole: 'OWNER',
      action: 'user.created',
      entityType: 'user',
      entityId: uid,
      before: null,
      after: { name, email, role, active: true },
    });
  });

  await auth().setCustomUserClaims(uid, { role, active: true });

  const passwordResetLink = await auth().generatePasswordResetLink(email);

  logger.info('Employee created', { uid, role, by: actor.uid });

  return { ok: true as const, uid, passwordResetLink };
});

/* ------------------------------------------------------------------------ *
 * Change a role
 * ------------------------------------------------------------------------ */

interface SetRoleData {
  readonly targetUid?: unknown;
  readonly role?: unknown;
  readonly reason?: unknown;
}

/**
 * Change a user's role.
 *
 * The Firestore profile and the Auth claim are both updated. The profile change
 * takes effect on the target's next request; the claim follows when their token
 * refreshes. Because `effectiveRole` takes the lower of the two, a demotion
 * applies immediately and a promotion waits — privilege removal is never
 * deferred (SECURITY.md §2).
 */
export const setUserRole = onCall(async (request: CallableRequest<SetRoleData>) => {
  const actor = await requireOwnerCaller(request);
  const data = request.data ?? {};

  const reason = typeof data.reason === 'string' ? data.reason.trim() : '';

  const { targetUid, newRole, previousRole, targetActive } = await db().runTransaction(
    async (transaction) => {
      const requestedUid = typeof data.targetUid === 'string' ? data.targetUid : '';
      const target = requestedUid
        ? await readProfileInTransaction(transaction, requestedUid)
        : { exists: false, role: null, active: null };

      enforce(
        evaluateRoleChange(
          { actorUid: actor.uid, targetUid: data.targetUid, newRole: data.role },
          target.exists,
        ),
      );

      const uid = data.targetUid as string;
      const role = data.role as Role;
      const before = target.role as Role;

      transaction.update(userRef(uid), {
        role,
        updatedAt: FieldValue.serverTimestamp(),
      });

      writeAudit(transaction, {
        actorUid: actor.uid,
        actorName: actor.name,
        actorRole: 'OWNER',
        action: 'user.role_changed',
        entityType: 'user',
        entityId: uid,
        before: { role: before },
        after: { role },
        reason: reason.length > 0 ? reason : undefined,
      });

      return {
        targetUid: uid,
        newRole: role,
        previousRole: before,
        targetActive: target.active === true,
      };
    },
  );

  /*
   * Carry the target's existing activation forward rather than assuming true.
   * Changing the role of a deactivated employee must not quietly restore the
   * access that deactivation removed.
   */
  await auth().setCustomUserClaims(targetUid, { role: newRole, active: targetActive });

  /*
   * Revoke outstanding refresh tokens so the target cannot keep using an ID
   * token minted under the old role. Combined with the document check in the
   * rules, this closes the stale-token window rather than merely narrowing it.
   */
  await auth().revokeRefreshTokens(targetUid);

  logger.info('Role changed', { targetUid, from: previousRole, to: newRole, by: actor.uid });

  return { ok: true as const, targetUid, role: newRole };
});

/* ------------------------------------------------------------------------ *
 * Activate or deactivate
 * ------------------------------------------------------------------------ */

interface SetActiveData {
  readonly targetUid?: unknown;
  readonly active?: unknown;
  readonly reason?: unknown;
}

/**
 * Activate or deactivate an employee.
 *
 * Deactivation writes `active: false` to the profile, which the security rules
 * read live — so the next Firestore request from that employee is refused, with
 * no wait for a token to expire. The Auth account is also disabled and refresh
 * tokens revoked, which stops new ID tokens being minted at all.
 *
 * The account is never deleted: `createdBy` references on reservations,
 * payments and audit entries must stay resolvable for the financial history to
 * remain meaningful.
 */
export const setUserActive = onCall(async (request: CallableRequest<SetActiveData>) => {
  const actor = await requireOwnerCaller(request);
  const data = request.data ?? {};

  const reason = typeof data.reason === 'string' ? data.reason.trim() : '';

  const { targetUid, active } = await db().runTransaction(async (transaction) => {
    const requestedUid = typeof data.targetUid === 'string' ? data.targetUid : '';
    const target = requestedUid
      ? await readProfileInTransaction(transaction, requestedUid)
      : { exists: false, role: null, active: null };

    enforce(
      evaluateActivationChange(
        { actorUid: actor.uid, targetUid: data.targetUid, active: data.active },
        target.exists,
      ),
    );

    const uid = data.targetUid as string;
    const nextActive = data.active as boolean;

    transaction.update(userRef(uid), {
      active: nextActive,
      updatedAt: FieldValue.serverTimestamp(),
    });

    writeAudit(transaction, {
      actorUid: actor.uid,
      actorName: actor.name,
      actorRole: 'OWNER',
      action: nextActive ? 'user.activated' : 'user.deactivated',
      entityType: 'user',
      entityId: uid,
      before: { active: target.active === true },
      after: { active: nextActive },
      reason: reason.length > 0 ? reason : undefined,
    });

    return { targetUid: uid, active: nextActive };
  });

  /*
   * Mirror the flag into the claim as well.
   *
   * Firestore reads `active` from the document and revokes immediately, so this
   * is not what protects business data. It is what closes the Storage window
   * (storage.rules, header comment): the claim is refused, no new token can be
   * minted, and the account itself is disabled.
   */
  const currentClaims = (await auth().getUser(targetUid)).customClaims ?? {};
  await auth().setCustomUserClaims(targetUid, { ...currentClaims, active });

  await auth().updateUser(targetUid, { disabled: !active });

  // Revoked in both directions: on deactivation to stop further use, and on
  // reactivation so the restored account starts from a freshly minted token
  // carrying the updated claim.
  await auth().revokeRefreshTokens(targetUid);

  logger.info('Activation changed', { targetUid, active, by: actor.uid });

  return { ok: true as const, targetUid, active };
});
