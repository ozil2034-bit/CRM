import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';

import {
  auth,
  bootstrapRef,
  callerFrom,
  db,
  FieldValue,
  userRef,
  writeAudit,
} from './lib/firestore';
import { evaluateBootstrap, normaliseName } from './lib/guards';

/**
 * The one-time setup token.
 *
 * Held as a Functions secret so it exists only server-side — never in the
 * browser bundle, never in a VITE_ variable, never in this repository.
 *
 * Why a token is necessary at all: Firebase email/password sign-up is open by
 * default, so without a shared secret the bootstrap endpoint grants ownership of
 * the boutique to whoever reaches the URL first. The specification requires that
 * "only the intended first owner can initialize the business", and a first-come
 * race does not satisfy that. The token is what makes the caller *intended*.
 *
 * Set before first run:
 *   firebase functions:secrets:set AZHARY_BOOTSTRAP_TOKEN
 */
const bootstrapToken = defineSecret('AZHARY_BOOTSTRAP_TOKEN');

/**
 * Report whether the boutique still needs its first owner.
 *
 * Unauthenticated by necessity — it is called before anyone can sign in. It
 * returns a single boolean and no business data, which is why the client learns
 * bootstrap state from here rather than from a public read rule on the sentinel
 * document. No read rule for `system` exists anywhere.
 *
 * This is a UX affordance. The real control is the re-check inside
 * `claimInitialOwnership`, which runs in a transaction.
 */
export const getBootstrapState = onCall(async (): Promise<{ needsBootstrap: boolean }> => {
  const snapshot = await bootstrapRef().get();
  const completed = snapshot.exists && snapshot.data()?.['completed'] === true;
  return { needsBootstrap: !completed };
});

interface ClaimOwnershipData {
  readonly setupToken?: unknown;
  readonly name?: unknown;
}

/**
 * Grant OWNER to the calling account, once, ever.
 *
 * The transaction on `system/bootstrap` is what makes this safe under
 * concurrency: two operators submitting simultaneously both read the sentinel,
 * but only one commit succeeds; the loser retries, observes `completed`, and is
 * refused. Checking "does an owner exist?" outside a transaction would be a
 * time-of-check/time-of-use race that hands out two owners.
 */
export const claimInitialOwnership = onCall(
  { secrets: [bootstrapToken] },
  async (request: CallableRequest<ClaimOwnershipData>) => {
    const caller = callerFrom(request.auth);

    const providedName =
      typeof request.data?.name === 'string' && request.data.name.trim().length > 0
        ? normaliseName(request.data.name)
        : ((request.auth?.token['name'] as string | undefined) ?? 'Owner');

    const uid = await db().runTransaction(async (transaction) => {
      const snapshot = await transaction.get(bootstrapRef());
      const data = snapshot.data() ?? {};

      const verdict = evaluateBootstrap(
        {
          callerUid: caller.uid,
          providedToken: request.data?.setupToken,
          expectedToken: bootstrapToken.value(),
        },
        {
          completed: snapshot.exists && data['completed'] === true,
          ownerUid: typeof data['ownerUid'] === 'string' ? data['ownerUid'] : null,
        },
      );

      if (!verdict.ok) {
        // Logged server-side so repeated failed attempts are visible; the
        // caller receives the message but never the expected token.
        logger.warn('Bootstrap refused', { code: verdict.code, uid: caller.uid });
        throw new HttpsError(verdict.code as never, verdict.message);
      }

      // caller.uid is non-null: evaluateBootstrap refuses a null uid above.
      const ownerUid = caller.uid as string;

      transaction.set(bootstrapRef(), {
        completed: true,
        ownerUid,
        completedAt: FieldValue.serverTimestamp(),
      });

      transaction.set(userRef(ownerUid), {
        uid: ownerUid,
        name: providedName,
        email: request.auth?.token['email'] ?? '',
        role: 'OWNER',
        active: true,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      writeAudit(transaction, {
        actorUid: ownerUid,
        actorName: providedName,
        actorRole: 'SYSTEM',
        action: 'user.bootstrap_owner_claimed',
        entityType: 'user',
        entityId: ownerUid,
        before: null,
        after: { role: 'OWNER', active: true },
        reason: 'First owner initialisation',
      });

      return ownerUid;
    });

    /*
     * The claim is written after the transaction commits, because custom claims
     * live in Firebase Auth and cannot participate in a Firestore transaction.
     *
     * If this step fails, the profile exists with role OWNER but the token
     * carries no claim, and `effectiveRole` returns null — the operator is
     * locked out. That is why `evaluateBootstrap` treats a replay by the
     * recorded owner as allowed: retrying the call repairs the state.
     */
    await auth().setCustomUserClaims(uid, { role: 'OWNER', active: true });

    logger.info('Initial ownership claimed', { uid });

    return { ok: true as const, uid };
  },
);
