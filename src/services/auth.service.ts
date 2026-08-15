/**
 * Authentication service — the application layer for identity.
 *
 * The only module that talks to Firebase Auth. Components consume this through
 * `useAuth`, never directly (ARCHITECTURE.md §1, enforced by ESLint).
 *
 * Everything this module produces is for the *interface*: which screens mount,
 * which controls render. None of it is a security control. A user who bypasses
 * it entirely reaches Firestore and is refused by the rules.
 */

import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  sendPasswordResetEmail,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { httpsCallable, type HttpsCallableResult } from 'firebase/functions';
import { clearIndexedDbPersistence, terminate } from 'firebase/firestore';

import { getFirebaseClient } from '@/lib/firebase/client';
import { resolveEffectiveRole, type Principal } from '@/domain/authorization';
import { AppError } from './errors';

export interface AuthSession {
  readonly uid: string;
  readonly email: string;
  readonly name: string;
  /**
   * The resolved principal, or `null` when the account is not an active
   * employee — deactivated, no profile, or a role the two sources disagree on
   * in a way that grants nothing.
   */
  readonly principal: Principal | null;
}

export type AuthState =
  | { readonly status: 'loading' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly session: AuthSession };

export class AuthError extends AppError {
  constructor(code: string, message: string) {
    super('AuthError', code, message);
  }
}

/**
 * Observe the signed-in identity.
 *
 * Subscribes to *two* sources: the Auth state, and the user's own profile
 * document. The profile subscription is what makes deactivation visible in the
 * interface the moment it happens — without it the employee would keep seeing a
 * working application while every write silently failed.
 *
 * Returns an unsubscribe function.
 */
export function observeAuth(onChange: (state: AuthState) => void): () => void {
  const { auth, db } = getFirebaseClient();

  let unsubscribeProfile: (() => void) | null = null;

  const stopProfile = (): void => {
    if (unsubscribeProfile) {
      unsubscribeProfile();
      unsubscribeProfile = null;
    }
  };

  const unsubscribeAuth = onAuthStateChanged(auth, (user: User | null) => {
    stopProfile();

    if (!user) {
      onChange({ status: 'signed-out' });
      return;
    }

    onChange({ status: 'loading' });

    unsubscribeProfile = onSnapshot(
      doc(db, 'users', user.uid),
      async (snapshot) => {
        const tokenResult = await user.getIdTokenResult();
        const profile = snapshot.data();

        const role = resolveEffectiveRole({
          claimRole: tokenResult.claims['role'],
          documentRole: profile?.['role'],
          documentActive: profile?.['active'],
          documentExists: snapshot.exists(),
        });

        onChange({
          status: 'signed-in',
          session: {
            uid: user.uid,
            email: user.email ?? '',
            name: (profile?.['name'] as string | undefined) ?? user.displayName ?? '',
            principal: role === null ? null : { uid: user.uid, role, active: true },
          },
        });
      },
      () => {
        /*
         * A profile read failure means the rules refused it, which is itself the
         * answer: this account is not an active employee. Reporting "signed in
         * with no principal" is correct and lets the interface explain the
         * situation rather than hanging on a spinner.
         */
        onChange({
          status: 'signed-in',
          session: {
            uid: user.uid,
            email: user.email ?? '',
            name: user.displayName ?? '',
            principal: null,
          },
        });
      },
    );
  });

  return () => {
    stopProfile();
    unsubscribeAuth();
  };
}

export async function signIn(email: string, password: string): Promise<void> {
  const { auth } = getFirebaseClient();

  try {
    await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
  } catch (error) {
    throw toAuthError(error);
  }
}

/**
 * Sign out and clear every local trace of the session.
 *
 * The boutique works from shared tablets, so one employee's cached customers,
 * reservations and payments must not survive into the next employee's session.
 * Firestore's IndexedDB cache is cleared explicitly; simply signing out leaves
 * it on disk.
 */
export async function signOut(): Promise<void> {
  const { auth, db } = getFirebaseClient();

  await firebaseSignOut(auth);

  try {
    await terminate(db);
    await clearIndexedDbPersistence(db);
  } catch {
    /*
     * Clearing fails when another tab still holds the database open. The sign-out
     * itself has already succeeded, so this is not worth surfacing to the user —
     * but it is why sign-out does not claim the cache was cleared.
     */
  }
}

/**
 * Create the account that will claim initial ownership.
 *
 * Used only by the bootstrap flow. The resulting account grants nothing on its
 * own: without an OWNER claim and a profile document the rules refuse every
 * request, so this is a Firebase Auth registration and nothing more.
 */
export async function createAccount(email: string, password: string): Promise<void> {
  const { auth } = getFirebaseClient();
  try {
    await createUserWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
  } catch (error) {
    throw toAuthError(error);
  }
}

export async function sendPasswordReset(email: string): Promise<void> {
  const { auth } = getFirebaseClient();
  try {
    await sendPasswordResetEmail(auth, email.trim().toLowerCase());
  } catch (error) {
    throw toAuthError(error);
  }
}

/**
 * Force the ID token to refresh.
 *
 * Called after a role change so the new claim takes effect without waiting for
 * the token's natural expiry. Documented in SECURITY.md §2 as the client half
 * of claim refresh; the server half is `revokeRefreshTokens`.
 */
export async function refreshIdToken(): Promise<void> {
  const { auth } = getFirebaseClient();
  await auth.currentUser?.getIdToken(true);
}

/* ------------------------------------------------------------------------ *
 * Trusted server-side operations
 * ------------------------------------------------------------------------ */

function call<Request, Response>(
  name: string,
): (data: Request) => Promise<HttpsCallableResult<Response>> {
  const { functions } = getFirebaseClient();
  return httpsCallable<Request, Response>(functions, name);
}

export async function getBootstrapState(): Promise<{ needsBootstrap: boolean }> {
  const result = await call<Record<string, never>, { needsBootstrap: boolean }>(
    'getBootstrapState',
  )({});
  return result.data;
}

export async function claimInitialOwnership(input: {
  setupToken: string;
  name: string;
}): Promise<void> {
  try {
    await call<typeof input, { ok: true; uid: string }>('claimInitialOwnership')(input);
  } catch (error) {
    throw toAuthError(error);
  }
  // The claim was just written server-side; refresh so this session carries it.
  await refreshIdToken();
}

export async function createEmployee(input: {
  name: string;
  email: string;
  role: 'OWNER' | 'STAFF';
}): Promise<{ uid: string; passwordResetLink: string }> {
  try {
    const result = await call<typeof input, { ok: true; uid: string; passwordResetLink: string }>(
      'createEmployee',
    )(input);
    return { uid: result.data.uid, passwordResetLink: result.data.passwordResetLink };
  } catch (error) {
    throw toAuthError(error);
  }
}

export async function setUserRole(input: {
  targetUid: string;
  role: 'OWNER' | 'STAFF';
  reason?: string;
}): Promise<void> {
  try {
    await call<typeof input, { ok: true }>('setUserRole')(input);
  } catch (error) {
    throw toAuthError(error);
  }
}

export async function setUserActive(input: {
  targetUid: string;
  active: boolean;
  reason?: string;
}): Promise<void> {
  try {
    await call<typeof input, { ok: true }>('setUserActive')(input);
  } catch (error) {
    throw toAuthError(error);
  }
}

/* ------------------------------------------------------------------------ *
 * Error mapping
 * ------------------------------------------------------------------------ */

/**
 * Map Firebase error codes to messages an employee can act on.
 *
 * Wrong-password and unknown-email both map to the same message deliberately:
 * distinguishing them tells an attacker which addresses have accounts.
 */
const MESSAGES: Record<string, string> = {
  'auth/invalid-credential': 'That email or password is not correct.',
  'auth/invalid-email': 'That email or password is not correct.',
  'auth/user-not-found': 'That email or password is not correct.',
  'auth/wrong-password': 'That email or password is not correct.',
  'auth/user-disabled': 'This account has been deactivated. Contact the boutique owner.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/network-request-failed': 'No connection. Check the network and try again.',
  'functions/permission-denied': 'You do not have permission to do that.',
  'functions/already-exists': 'This boutique already has an owner.',
  'functions/failed-precondition': 'That action is not available right now.',
  'functions/unauthenticated': 'Sign in and try again.',
};

function toAuthError(error: unknown): AuthError {
  const code = (error as { code?: string }).code ?? 'unknown';
  const fallback =
    (error as { message?: string }).message ?? 'Something went wrong. Please try again.';
  return new AuthError(code, MESSAGES[code] ?? fallback);
}
