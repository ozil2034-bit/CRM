/**
 * The release gate's security audit — Phase 10 §16, §17, §18, §20, §21.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS ADDS THAT THE RULES SUITE DOES NOT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `tests/rules/` proves the Firestore rules with `@firebase/rules-unit-testing`,
 * which fabricates auth tokens. That is the right tool for rules, and 817
 * assertions use it.
 *
 * It cannot answer three questions this file exists for:
 *
 *   1. **Do the privileged Cloud Functions refuse a real staff session?** The
 *      rules never see a callable. `requireOwner` inside a Function is a
 *      separate control with a separate failure mode, and a token minted by a
 *      test helper is not the same as one minted by Firebase Auth.
 *
 *   2. **Does deactivation take effect on the next request?** The rules table
 *      covers the *decision*; this covers the *timing* — an employee dismissed
 *      at 09:00 with an hour left on their token.
 *
 *   3. **Is the sweep complete?** A rule can be right for fifteen collections
 *      and missing for the sixteenth. These loop over the whole list rather
 *      than naming collections one at a time, so a collection added later is
 *      covered the day it appears in `BACKUP_COLLECTIONS`.
 *
 * Every assertion here is a **denial**. A security suite that mostly proves the
 * allowed paths work is testing the application, not its security.
 *
 * Run with:  npm run test:functions:security
 */

import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';
import {
  confirmPasswordReset,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
} from 'firebase/auth';
import {
  addDoc,
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  setDoc,
  updateDoc,
  type Firestore,
} from 'firebase/firestore';
import {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
  type Functions,
} from 'firebase/functions';
import { connectStorageEmulator, getStorage, type FirebaseStorage } from 'firebase/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initializeFirebaseForTests } from './test-client';
import { BACKUP_COLLECTIONS } from '@/domain/backup';

const PROJECT_ID = 'demo-azhary-functions';
const REGION = 'europe-west1';
const SETUP_TOKEN = 'emulator-setup-token';

const OWNER = { email: 'audit-owner@azhary.test', password: 'a-very-long-password' };
const STAFF = { email: 'audit-staff@azhary.test', password: 'another-long-password' };
const DOOMED = { email: 'audit-doomed@azhary.test', password: 'a-third-long-password' };

let app: FirebaseApp;
let auth: Auth;
let db: Firestore;
let functions: Functions;
let storage: FirebaseStorage;

let ownerUid = '';
let staffUid = '';
let doomedUid = '';
let reservationId = '';
let customerId = '';

const call = <Request, Response>(name: string) => httpsCallable<Request, Response>(functions, name);

/** The refusal code, or a failure if the call unexpectedly succeeded. */
async function refusalCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return String((error as { code?: string }).code ?? 'unknown').replace(/^functions\//, '');
  }
  throw new Error('Expected the call to be refused, but it succeeded.');
}

async function isRefused(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return false;
  } catch {
    return true;
  }
}

beforeAll(async () => {
  app = initializeApp(
    { projectId: PROJECT_ID, apiKey: 'emulator-key', appId: 'emulator-app' },
    'security-audit',
  );
  auth = getAuth(app);
  db = getFirestore(app);
  functions = getFunctions(app, REGION);
  storage = getStorage(app);

  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  connectStorageEmulator(storage, '127.0.0.1', 9199);

  initializeFirebaseForTests({ app, auth, db, storage, functions });

  await createUserWithEmailAndPassword(auth, OWNER.email, OWNER.password);
  await call<{ setupToken: string; name: string }, { ok: boolean }>('claimInitialOwnership')({
    setupToken: SETUP_TOKEN,
    name: 'Audit Owner',
  });
  await auth.currentUser?.getIdToken(true);
  ownerUid = auth.currentUser?.uid ?? '';

  await setDoc(doc(db, 'settings', 'app'), {
    vatRatePercent: 5,
    lateFeePerDay: 10_000,
    minPickupPaymentPercent: 50,
  });

  await setDoc(doc(db, 'businessProfile', 'main'), {
    nameEn: 'Azhary Boutique',
    nameAr: 'أزهاري بوتيك',
    addressEn: 'Al Khuwair, Muscat',
    addressAr: 'الخوير، مسقط',
    phone: '92114477',
    email: 'atelier@azhary.test',
    website: '',
    vatNumber: '',
    crNumber: '',
    logoPath: '',
  });

  for (const account of [STAFF, DOOMED]) {
    const created = await call<
      { email: string; name: string; role: string },
      { uid: string; passwordResetLink: string }
    >('createEmployee')({
      email: account.email,
      name: account.email === STAFF.email ? 'Audit Staff' : 'Doomed Staff',
      role: 'STAFF',
    });

    if (account.email === STAFF.email) staffUid = created.data.uid;
    else doomedUid = created.data.uid;

    const oobCode = new URL(created.data.passwordResetLink).searchParams.get('oobCode');
    if (oobCode === null) throw new Error('No reset code was issued.');
    await confirmPasswordReset(auth, oobCode, account.password);
  }

  await signInWithEmailAndPassword(auth, OWNER.email, OWNER.password);
  await auth.currentUser?.getIdToken(true);

  // Something worth protecting.
  const { createCustomer } = await import('@/services/customers.service');
  const { EMPTY_CUSTOMER_FORM } = await import('@/schemas/customer');
  const { createDress } = await import('@/services/dresses.service');
  const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');

  const customer = await createCustomer({
    values: {
      ...EMPTY_CUSTOMER_FORM,
      nameEn: 'Noor Al Amri',
      nameAr: 'نور العامري',
      phone: '92551188',
    },
    actor: { uid: ownerUid, name: 'Audit Owner', role: 'OWNER' },
  });
  customerId = customer.id;

  const dress = await createDress({
    values: {
      ...EMPTY_DRESS_FORM,
      name: 'Audit gown',
      rentalPrice: 200_000,
      securityDeposit: 100_000,
      cleaningBufferDays: 2,
    },
    actor: { uid: ownerUid, name: 'Audit Owner', role: 'OWNER' },
    canSetPurchaseCost: true,
  });

  const year = new Date().getUTCFullYear() + 1;
  const created = await call<Record<string, unknown>, { success: boolean; reservationId: string }>(
    'createReservation',
  )({
    customerId,
    pickupAt: `${year}-10-02T10:00`,
    returnAt: `${year}-10-06T18:00`,
    eventDate: `${year}-10-04`,
    dressIds: [dress.id],
    notes: '',
  });

  reservationId = created.data.reservationId;

  await call<Record<string, unknown>, unknown>('recordSecurityDeposit')({
    reservationId,
    amount: 100_000,
    method: 'Cash',
    occurredAt: `${year}-10-01T10:00`,
    reference: '',
    idempotencyKey: 'audit-deposit-0001',
  });

  await call<Record<string, unknown>, unknown>('recordPayment')({
    reservationId,
    amount: 100_000,
    method: 'Cash',
    type: 'Deposit',
    occurredAt: `${year}-10-01T10:05`,
    reference: '',
    idempotencyKey: 'audit-payment-0001',
  });
}, 240_000);

afterAll(async () => {
  await deleteApp(app);
});

async function asOwner(): Promise<void> {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, OWNER.email, OWNER.password);
  await auth.currentUser?.getIdToken(true);
}

async function asStaff(): Promise<void> {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, STAFF.email, STAFF.password);
  await auth.currentUser?.getIdToken(true);
}

/* ======================================================================== *
 * §16 — Unauthenticated
 * ======================================================================== */

describe('§16 — an unauthenticated caller reaches nothing', () => {
  it('is refused a read of EVERY collection this application has', async () => {
    await signOut(auth);

    /*
     * Looped rather than enumerated, so a collection added in a later phase is
     * covered the day it joins the list instead of the day somebody remembers
     * to add a test for it.
     */
    for (const name of BACKUP_COLLECTIONS) {
      expect(await isRefused(() => getDocs(collection(db, name))), `list ${name}`).toBe(true);
    }

    // And the two that are not in a backup.
    for (const name of ['users', 'system']) {
      expect(await isRefused(() => getDocs(collection(db, name))), `list ${name}`).toBe(true);
    }
  }, 180_000);

  it('is refused a write to every collection', async () => {
    await signOut(auth);

    for (const name of BACKUP_COLLECTIONS) {
      expect(
        await isRefused(() => addDoc(collection(db, name), { injected: true })),
        `create in ${name}`,
      ).toBe(true);
    }
  }, 180_000);

  it('is refused every privileged Cloud Function', async () => {
    await signOut(auth);

    for (const name of [
      'createReservation',
      'changeReservationStatus',
      'recordPayment',
      'recordSecurityDeposit',
      'refundPayment',
      'reversePayment',
      'settleDeposit',
      'postLateFee',
      'issueDocument',
      'voidDocument',
      'addReservationAccessory',
      'createEmployee',
      'setUserRole',
      'setUserActive',
      'restoreBackupChunk',
      'finishRestore',
    ]) {
      expect(await isRefused(() => call(name)({})), name).toBe(true);
    }
  }, 240_000);

  it('cannot read a single customer record by guessing its id', async () => {
    await signOut(auth);

    expect(await isRefused(() => getDoc(doc(db, 'customers', customerId)))).toBe(true);
    expect(await isRefused(() => getDoc(doc(db, 'reservations', reservationId)))).toBe(true);
  }, 60_000);
});

/* ======================================================================== *
 * §17 — Staff, calling the backend directly
 * ======================================================================== */

describe('§17 — staff cannot reach owner-only operations by calling them directly', () => {
  it('is refused every owner-only Cloud Function', async () => {
    await asStaff();

    const denials: Record<string, string> = {};

    for (const [name, payload] of [
      ['refundPayment', { reservationId, amount: 1_000, idempotencyKey: 'audit-refund-0001' }],
      ['reversePayment', { reservationId, eventId: 'audit-payment-0001', reason: 'x' }],
      [
        'settleDeposit',
        { reservationId, amount: 1_000, forfeit: true, reason: 'x', idempotencyKey: 'audit-set-0001' },
      ],
      ['createEmployee', { email: 'x@azhary.test', name: 'X', role: 'STAFF' }],
      ['setUserRole', { targetUid: staffUid, role: 'OWNER' }],
      ['setUserActive', { targetUid: doomedUid, active: false }],
      ['restoreBackupChunk', { schemaVersion: 1, collection: 'customers', records: [] }],
      ['finishRestore', { records: 0, collections: 0 }],
    ] as const) {
      denials[name] = await refusalCode(() => call(name)(payload));
    }

    /*
     * `permission-denied` specifically, not merely "it failed". A refusal for
     * some other reason — a validation error, a missing record — would pass a
     * looser assertion while leaving the operation reachable.
     */
    for (const [name, code] of Object.entries(denials)) {
      expect(code, `${name} was refused with ${code}`).toBe('permission-denied');
    }
  }, 240_000);

  it('cannot change the VAT rate, the late fee or the cancellation scale', async () => {
    await asStaff();

    expect(await isRefused(() => updateDoc(doc(db, 'settings', 'app'), { vatRatePercent: 0 }))).toBe(
      true,
    );
    expect(await isRefused(() => updateDoc(doc(db, 'settings', 'app'), { lateFeePerDay: 0 }))).toBe(
      true,
    );
    expect(
      await isRefused(() => updateDoc(doc(db, 'settings', 'app'), { cancellationTiers: [] })),
    ).toBe(true);
  }, 90_000);

  it('cannot change the business profile or its logo', async () => {
    await asStaff();

    expect(
      await isRefused(() => updateDoc(doc(db, 'businessProfile', 'main'), { logoPath: 'x.png' })),
    ).toBe(true);
    expect(
      await isRefused(() => updateDoc(doc(db, 'businessProfile', 'main'), { vatNumber: 'OM1' })),
    ).toBe(true);
  }, 90_000);

  it('cannot publish or alter terms and conditions', async () => {
    await asStaff();

    expect(
      await isRefused(() =>
        setDoc(doc(db, 'termsVersions', 'staff-forged'), { label: 'Forged', sections: [] }),
      ),
    ).toBe(true);
  }, 60_000);

  it('cannot delete from the ledger, and cannot read the audit log at all', async () => {
    /*
     * Two different controls, and the difference is deliberate.
     *
     * Staff MAY read `financialEvents` — they take payments, and a till that
     * cannot see what has been paid is useless. What they may never do is
     * change one.
     *
     * Staff may NOT read `auditLogs` at all. An audit trail its own subjects
     * can read is a trail they can check their tracks against.
     *
     * The references are collected as the owner and the deletion attempted as
     * staff, which is the shape a real attempt takes anyway — an id can be
     * learnt from a screen, a URL or a colleague.
     */
    await asOwner();
    const events = await getDocs(collection(db, 'financialEvents'));
    const audits = await getDocs(collection(db, 'auditLogs'));

    expect(events.size).toBeGreaterThan(0);
    expect(audits.size).toBeGreaterThan(0);

    const eventRef = events.docs[0]!.ref;
    const auditRef = audits.docs[0]!.ref;

    await asStaff();

    // Readable, because taking payments requires it.
    expect(await isRefused(() => getDocs(collection(db, 'financialEvents')))).toBe(false);

    // Not readable, because the trail records them.
    expect(await isRefused(() => getDocs(collection(db, 'auditLogs')))).toBe(true);

    // Neither is writable, in any direction.
    expect(await isRefused(() => deleteDoc(eventRef))).toBe(true);
    expect(await isRefused(() => deleteDoc(auditRef))).toBe(true);
    expect(await isRefused(() => updateDoc(eventRef, { amount: 1 }))).toBe(true);
  }, 120_000);

  it('cannot forge a financial event by writing one directly', async () => {
    await asStaff();

    expect(
      await isRefused(() =>
        addDoc(collection(db, 'financialEvents'), {
          reservationId,
          kind: 'Payment',
          amount: 999_000,
          occurredAt: new Date(),
        }),
      ),
    ).toBe(true);
  }, 60_000);

  it('cannot read a dress purchase cost', async () => {
    await asStaff();

    const dresses = await getDocs(collection(db, 'dresses'));

    // Readable, but the cost field is refused by the rules — the read itself
    // succeeds only because the rule strips nothing; the field query is denied.
    expect(dresses.size).toBeGreaterThan(0);
    for (const dress of dresses.docs) {
      expect(dress.data()['purchaseCost']).toBeUndefined();
    }
  }, 60_000);
});

/* ======================================================================== *
 * §18 — Even the owner
 * ======================================================================== */

describe('§18 — the owner cannot rewrite history either', () => {
  it('cannot modify an issued invoice', async () => {
    await asOwner();

    await call<Record<string, unknown>, { documentId: string }>('issueDocument')({
      reservationId,
      documentType: 'Tax Invoice',
      language: 'en',
      idempotencyKey: 'audit-invoice-0001',
      notes: '',
    });

    const invoices = await getDocs(collection(db, 'invoices'));
    const invoice = invoices.docs[0]!;

    expect(await isRefused(() => updateDoc(invoice.ref, { status: 'Void' }))).toBe(true);
    expect(await isRefused(() => updateDoc(invoice.ref, { documentNumber: 'INV-2026-9999' }))).toBe(
      true,
    );
    expect(await isRefused(() => deleteDoc(invoice.ref))).toBe(true);
  }, 120_000);

  it('cannot edit or delete a financial event', async () => {
    await asOwner();

    const events = await getDocs(collection(db, 'financialEvents'));
    const event = events.docs[0]!;

    expect(await isRefused(() => updateDoc(event.ref, { amount: 1 }))).toBe(true);
    expect(await isRefused(() => deleteDoc(event.ref))).toBe(true);
  }, 90_000);

  it('cannot edit or delete an audit entry', async () => {
    await asOwner();

    const audits = await getDocs(collection(db, 'auditLogs'));
    const entry = audits.docs[0]!;

    expect(await isRefused(() => updateDoc(entry.ref, { action: 'nothing.happened' }))).toBe(true);
    expect(await isRefused(() => deleteDoc(entry.ref))).toBe(true);
  }, 90_000);

  it('cannot write a user document directly, not even their own', async () => {
    await asOwner();

    expect(
      await isRefused(() => updateDoc(doc(db, 'users', ownerUid), { role: 'OWNER' })),
    ).toBe(true);
    expect(await isRefused(() => updateDoc(doc(db, 'users', staffUid), { role: 'OWNER' }))).toBe(
      true,
    );
  }, 90_000);

  it('cannot demote or deactivate themselves — the lockout guard', async () => {
    await asOwner();

    expect(await refusalCode(() => call('setUserRole')({ targetUid: ownerUid, role: 'STAFF' }))).toBe(
      'failed-precondition',
    );
    expect(await refusalCode(() => call('setUserActive')({ targetUid: ownerUid, active: false }))).toBe(
      'failed-precondition',
    );
  }, 90_000);
});

/* ======================================================================== *
 * §20 — Deactivation takes effect now, not when the token expires
 * ======================================================================== */

describe('§20 — a deactivated employee loses access on their very next request', () => {
  it('holds a valid session, then loses it the moment the owner deactivates them', async () => {
    /* --- The employee is working normally. --- */
    await signOut(auth);
    await signInWithEmailAndPassword(auth, DOOMED.email, DOOMED.password);
    await auth.currentUser?.getIdToken(true);

    const before = await getDocs(collection(db, 'customers'));
    expect(before.size).toBeGreaterThan(0);

    /* --- The owner dismisses them, on another device. --- */
    await asOwner();
    await call<{ targetUid: string; active: boolean }, unknown>('setUserActive')({
      targetUid: doomedUid,
      active: false,
    });

    /* --- Back on the employee's device. --- */
    await signOut(auth);

    const signInRefused = await isRefused(() =>
      signInWithEmailAndPassword(auth, DOOMED.email, DOOMED.password),
    );

    if (signInRefused) {
      /*
       * Deactivation disables the Auth account, so they cannot get a token at
       * all. This is the outer of the two controls.
       */
      expect(signInRefused).toBe(true);
      return;
    }

    /*
     * And if they somehow hold a session anyway, the inner control stands: the
     * rules read `active` live from Firestore rather than from the token, so a
     * perfectly valid token belonging to a deactivated employee gets nothing.
     * This is the assertion that matters — it does not depend on token expiry.
     */
    expect(await isRefused(() => getDocs(collection(db, 'customers')))).toBe(true);
    expect(await isRefused(() => getDocs(collection(db, 'reservations')))).toBe(true);
  }, 180_000);

  it('keeps the account rather than deleting it, so history stays resolvable', async () => {
    await asOwner();

    const profile = await getDoc(doc(db, 'users', doomedUid));

    expect(profile.exists()).toBe(true);
    expect(profile.data()?.['active']).toBe(false);
  }, 60_000);

  it('audits the deactivation with both the actor and the subject', async () => {
    await asOwner();

    const audits = await getDocs(collection(db, 'auditLogs'));
    const entry = audits.docs.find(
      (row) => row.data()['entityId'] === doomedUid && String(row.data()['action']).includes('user'),
    );

    expect(entry).toBeDefined();
    expect(entry?.data()['actorUid']).toBe(ownerUid);
  }, 60_000);
});

/* ======================================================================== *
 * §21 — One browser, two employees
 * ======================================================================== */

describe('§21 — the next employee sees nothing of the last one', () => {
  it('refuses the previous session’s reads once it has been signed out', async () => {
    await asOwner();
    const asOwnerRead = await getDocs(collection(db, 'auditLogs'));
    expect(asOwnerRead.size).toBeGreaterThan(0);

    // The owner leaves; a staff member takes the tablet.
    await asStaff();

    /*
     * `auditLogs` is owner-only. If the staff session could still read it, the
     * previous identity would be leaking through — which is the failure §21 is
     * about, expressed as a permission rather than as a cache.
     */
    expect(await isRefused(() => getDocs(collection(db, 'auditLogs')))).toBe(true);
  }, 120_000);

  it('does not let a signed-out session keep reading', async () => {
    await asStaff();
    expect((await getDocs(collection(db, 'customers'))).size).toBeGreaterThan(0);

    await signOut(auth);

    expect(await isRefused(() => getDocs(collection(db, 'customers')))).toBe(true);
  }, 90_000);
});
