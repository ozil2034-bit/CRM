/**
 * End-to-end identity lifecycle against the Firebase Emulator Suite.
 *
 * The pure guard tests (tests/functions/guards.test.ts) prove the *decisions*
 * are right. These prove the deployed Functions actually apply them: that the
 * bootstrap transaction commits once, that custom claims really are written,
 * that audit records land, and that the security rules agree with all of it.
 *
 * The file describes one ordered lifecycle. Owner bootstrap is a one-time
 * transition, so the tests run in sequence and share state deliberately —
 * `describe` blocks below read as the story of a boutique being set up.
 *
 * Run with:  npm run test:functions
 */

import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
} from 'firebase/auth';
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  where,
  type Firestore,
} from 'firebase/firestore';
import {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
  type Functions,
} from 'firebase/functions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PROJECT_ID = 'demo-azhary-functions';
const REGION = 'europe-west1';

/** Must match the value exported to the emulator by `npm run test:functions`. */
const SETUP_TOKEN = 'emulator-setup-token';

const OWNER = { email: 'owner@azhary.test', password: 'a-very-long-password' };
const INTRUDER = { email: 'intruder@azhary.test', password: 'another-long-password' };

let app: FirebaseApp;
let auth: Auth;
let db: Firestore;
let functions: Functions;

beforeAll(() => {
  app = initializeApp({ projectId: PROJECT_ID, apiKey: 'emulator-key', appId: 'emulator-app' });
  auth = getAuth(app);
  db = getFirestore(app);
  functions = getFunctions(app, REGION);

  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
});

afterAll(async () => {
  await deleteApp(app);
});

function call<Request, Response>(name: string) {
  return httpsCallable<Request, Response>(functions, name);
}

/** Extract the error code from a callable rejection, e.g. `permission-denied`. */
async function refusalCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'unknown';
    return code.replace(/^functions\//, '');
  }
  throw new Error('Expected the call to be refused, but it succeeded.');
}

async function claimsOf(): Promise<Record<string, unknown>> {
  const user = auth.currentUser;
  if (!user) throw new Error('No signed-in user.');
  const result = await user.getIdTokenResult(true);
  return result.claims;
}

/* ------------------------------------------------------------------------ *
 * 1. Before anyone exists
 * ------------------------------------------------------------------------ */

describe('a boutique with no owner', () => {
  it('reports that bootstrap is needed', async () => {
    const result = await call<Record<string, never>, { needsBootstrap: boolean }>(
      'getBootstrapState',
    )({});
    expect(result.data.needsBootstrap).toBe(true);
  });

  it('DENIES an unauthenticated bootstrap attempt', async () => {
    await signOut(auth);
    const code = await refusalCode(() =>
      call('claimInitialOwnership')({ setupToken: SETUP_TOKEN, name: 'Anonymous' }),
    );
    expect(code).toBe('unauthenticated');
  });

  it('DENIES a signed-in caller presenting the wrong setup token', async () => {
    // Creating an account is open; that is exactly why a shared secret is
    // required to distinguish the *intended* owner from whoever arrives first.
    await createUserWithEmailAndPassword(auth, INTRUDER.email, INTRUDER.password);

    const code = await refusalCode(() =>
      call('claimInitialOwnership')({ setupToken: 'guessed-token', name: 'Intruder' }),
    );
    expect(code).toBe('permission-denied');
  });

  it('leaves the intruder with no role claim after the refusal', async () => {
    const claims = await claimsOf();
    expect(claims['role']).toBeUndefined();
  });

  it('leaves the intruder unable to read any business data', async () => {
    await expect(getDoc(doc(db, 'customers', 'anything'))).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------------ *
 * 2. The intended owner claims ownership
 * ------------------------------------------------------------------------ */

describe('first owner bootstrap', () => {
  it('ALLOWS the first owner with the correct setup token', async () => {
    await signOut(auth);
    await createUserWithEmailAndPassword(auth, OWNER.email, OWNER.password);

    const result = await call<{ setupToken: string; name: string }, { ok: boolean; uid: string }>(
      'claimInitialOwnership',
    )({ setupToken: SETUP_TOKEN, name: 'Azhary Owner' });

    expect(result.data.ok).toBe(true);
    expect(result.data.uid).toBe(auth.currentUser?.uid);
  });

  it('writes the OWNER custom claim', async () => {
    const claims = await claimsOf();
    expect(claims['role']).toBe('OWNER');
    expect(claims['active']).toBe(true);
  });

  it('creates the owner profile with no credential material', async () => {
    const uid = auth.currentUser!.uid;
    const snapshot = await getDoc(doc(db, 'users', uid));

    expect(snapshot.exists()).toBe(true);
    const profile = snapshot.data()!;
    expect(profile['role']).toBe('OWNER');
    expect(profile['active']).toBe(true);
    expect(profile['name']).toBe('Azhary Owner');
    expect(profile['email']).toBe(OWNER.email);

    // No password, hash, salt or token is ever stored.
    for (const forbidden of ['password', 'passwordHash', 'salt', 'token', 'setupToken']) {
      expect(profile[forbidden]).toBeUndefined();
    }
  });

  it('records an audit entry for the bootstrap', async () => {
    const uid = auth.currentUser!.uid;
    const entries = await getDocs(
      query(collection(db, 'auditLogs'), where('action', '==', 'user.bootstrap_owner_claimed')),
    );

    expect(entries.size).toBe(1);
    const entry = entries.docs[0]!.data();
    expect(entry['entityId']).toBe(uid);
    expect(entry['after']).toMatchObject({ role: 'OWNER', active: true });
    expect(entry['at']).toBeTruthy();
  });

  it('now reports that bootstrap is complete', async () => {
    const result = await call<Record<string, never>, { needsBootstrap: boolean }>(
      'getBootstrapState',
    )({});
    expect(result.data.needsBootstrap).toBe(false);
  });

  it('DENIES a second owner bootstrap by a different account', async () => {
    await signOut(auth);
    await signInWithEmailAndPassword(auth, INTRUDER.email, INTRUDER.password);

    const code = await refusalCode(() =>
      call('claimInitialOwnership')({ setupToken: SETUP_TOKEN, name: 'Second Owner' }),
    );
    expect(code).toBe('already-exists');
  });

  it('leaves the second caller with no role claim', async () => {
    const claims = await claimsOf();
    expect(claims['role']).toBeUndefined();
  });

  it('ALLOWS the recorded owner to replay, so a failed claim write can be repaired', async () => {
    await signOut(auth);
    await signInWithEmailAndPassword(auth, OWNER.email, OWNER.password);

    const result = await call<{ setupToken: string; name: string }, { ok: boolean }>(
      'claimInitialOwnership',
    )({ setupToken: SETUP_TOKEN, name: 'Azhary Owner' });

    expect(result.data.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * 3. The owner manages staff
 * ------------------------------------------------------------------------ */

const STAFF_EMAIL = 'fatima@azhary.test';
let staffUid = '';

describe('owner staff management', () => {
  it('creates an employee without ever handling a password', async () => {
    const result = await call<
      { name: string; email: string; role: string },
      { ok: boolean; uid: string; passwordResetLink: string }
    >('createEmployee')({ name: 'Fatima Al Balushi', email: STAFF_EMAIL, role: 'STAFF' });

    staffUid = result.data.uid;
    expect(result.data.ok).toBe(true);

    // The employee sets their own password through this link. No password was
    // accepted, generated or transmitted by the application.
    expect(result.data.passwordResetLink).toContain('oobCode');
  });

  it('writes the new employee profile', async () => {
    const snapshot = await getDoc(doc(db, 'users', staffUid));
    expect(snapshot.data()).toMatchObject({ role: 'STAFF', active: true, email: STAFF_EMAIL });
  });

  it('records an audit entry for the creation', async () => {
    const entries = await getDocs(
      query(collection(db, 'auditLogs'), where('action', '==', 'user.created')),
    );
    expect(entries.size).toBe(1);
    expect(entries.docs[0]!.data()['entityId']).toBe(staffUid);
  });

  it('DENIES the owner changing their own role — lockout guard', async () => {
    const ownerUid = auth.currentUser!.uid;
    const code = await refusalCode(() =>
      call('setUserRole')({ targetUid: ownerUid, role: 'STAFF' }),
    );
    expect(code).toBe('failed-precondition');
  });

  it('DENIES the owner deactivating their own account', async () => {
    const ownerUid = auth.currentUser!.uid;
    const code = await refusalCode(() =>
      call('setUserActive')({ targetUid: ownerUid, active: false }),
    );
    expect(code).toBe('failed-precondition');
  });

  it('DENIES an invalid role value', async () => {
    const code = await refusalCode(() =>
      call('setUserRole')({ targetUid: staffUid, role: 'SUPERUSER' }),
    );
    expect(code).toBe('invalid-argument');
  });

  it('DENIES a role change for a user who does not exist', async () => {
    const code = await refusalCode(() =>
      call('setUserRole')({ targetUid: 'no-such-user', role: 'STAFF' }),
    );
    expect(code).toBe('not-found');
  });

  it('promotes a staff member and audits the change with both roles', async () => {
    await call('setUserRole')({
      targetUid: staffUid,
      role: 'OWNER',
      reason: 'Promoted to co-owner',
    });

    const snapshot = await getDoc(doc(db, 'users', staffUid));
    expect(snapshot.data()!['role']).toBe('OWNER');

    const entries = await getDocs(
      query(collection(db, 'auditLogs'), where('action', '==', 'user.role_changed')),
    );
    expect(entries.size).toBe(1);

    const entry = entries.docs[0]!.data();
    expect(entry['before']).toMatchObject({ role: 'STAFF' });
    expect(entry['after']).toMatchObject({ role: 'OWNER' });
    expect(entry['actorUid']).toBe(auth.currentUser!.uid);
    expect(entry['reason']).toBe('Promoted to co-owner');
  });

  it('demotes them again', async () => {
    await call('setUserRole')({ targetUid: staffUid, role: 'STAFF' });
    const snapshot = await getDoc(doc(db, 'users', staffUid));
    expect(snapshot.data()!['role']).toBe('STAFF');
  });

  it('deactivates an employee and audits it', async () => {
    await call('setUserActive')({
      targetUid: staffUid,
      active: false,
      reason: 'Left the boutique',
    });

    const snapshot = await getDoc(doc(db, 'users', staffUid));
    expect(snapshot.data()!['active']).toBe(false);

    const entries = await getDocs(
      query(collection(db, 'auditLogs'), where('action', '==', 'user.deactivated')),
    );
    expect(entries.size).toBe(1);
    expect(entries.docs[0]!.data()['reason']).toBe('Left the boutique');
  });

  it('keeps the account rather than deleting it, so history stays resolvable', async () => {
    const snapshot = await getDoc(doc(db, 'users', staffUid));
    expect(snapshot.exists()).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * 4. A non-owner tries to manage staff
 * ------------------------------------------------------------------------ */

describe('privilege escalation attempts', () => {
  beforeAll(async () => {
    await signOut(auth);
    await signInWithEmailAndPassword(auth, INTRUDER.email, INTRUDER.password);
  });

  it('DENIES a caller with no role creating an employee', async () => {
    const code = await refusalCode(() =>
      call('createEmployee')({ name: 'Ghost', email: 'ghost@azhary.test', role: 'OWNER' }),
    );
    expect(code).toBe('permission-denied');
  });

  it('DENIES a caller with no role changing someone else’s role', async () => {
    const code = await refusalCode(() =>
      call('setUserRole')({ targetUid: staffUid, role: 'OWNER' }),
    );
    expect(code).toBe('permission-denied');
  });

  it('DENIES a caller granting themselves OWNER', async () => {
    const ownUid = auth.currentUser!.uid;
    const code = await refusalCode(() => call('setUserRole')({ targetUid: ownUid, role: 'OWNER' }));
    // Refused as permission-denied before the self-action guard is ever reached:
    // the caller is not an owner, so the request never gets that far.
    expect(code).toBe('permission-denied');
  });

  it('DENIES a caller reactivating a deactivated employee', async () => {
    const code = await refusalCode(() =>
      call('setUserActive')({ targetUid: staffUid, active: true }),
    );
    expect(code).toBe('permission-denied');
  });

  it('DENIES writing a role directly into Firestore', async () => {
    // The rules refuse every client write to `users`, so the Function is not
    // merely the convenient path — it is the only one.
    const { setDoc } = await import('firebase/firestore');
    await expect(
      setDoc(doc(db, 'users', auth.currentUser!.uid), { role: 'OWNER', active: true }),
    ).rejects.toThrow();
  });

  it('DENIES writing the bootstrap sentinel directly', async () => {
    const { setDoc } = await import('firebase/firestore');
    await expect(setDoc(doc(db, 'system', 'bootstrap'), { completed: false })).rejects.toThrow();
  });

  it('leaves the caller with no role claim after every attempt', async () => {
    const claims = await claimsOf();
    expect(claims['role']).toBeUndefined();
  });
});
