/**
 * Dress and customer CRUD against the Firebase Emulator Suite.
 *
 * These exercise the real service layer — real transactions, real security
 * rules, real audit writes — rather than the pure logic the unit tests cover.
 * The concurrency test is the one that matters most: it is the only way to
 * demonstrate that two employees creating a dress at the same instant cannot
 * receive the same code.
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
import { connectStorageEmulator, getStorage, type FirebaseStorage } from 'firebase/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initializeFirebaseForTests } from './test-client';

const PROJECT_ID = 'demo-azhary-functions';
const REGION = 'europe-west1';
const SETUP_TOKEN = 'emulator-setup-token';

const OWNER = { email: 'catalogue-owner@azhary.test', password: 'a-very-long-password' };

let app: FirebaseApp;
let auth: Auth;
let db: Firestore;
let functions: Functions;
let storage: FirebaseStorage;

let ownerUid = '';

beforeAll(async () => {
  app = initializeApp(
    { projectId: PROJECT_ID, apiKey: 'emulator-key', appId: 'emulator-app' },
    'catalogue',
  );
  auth = getAuth(app);
  db = getFirestore(app);
  functions = getFunctions(app, REGION);
  storage = getStorage(app);

  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  connectStorageEmulator(storage, '127.0.0.1', 9199);

  // The service layer reads its handles from the shared client module.
  initializeFirebaseForTests({ app, auth, db, storage, functions });

  // Bootstrap an owner for this suite. `auth-flow.test.ts` may already have
  // claimed ownership in this emulator run, in which case sign in instead.
  try {
    await createUserWithEmailAndPassword(auth, OWNER.email, OWNER.password);
    await httpsCallable<{ setupToken: string; name: string }, { ok: boolean }>(
      functions,
      'claimInitialOwnership',
    )({ setupToken: SETUP_TOKEN, name: 'Catalogue Owner' });
  } catch {
    await signOut(auth);
    await signInWithEmailAndPassword(auth, OWNER.email, OWNER.password);
  }

  await auth.currentUser?.getIdToken(true);
  ownerUid = auth.currentUser?.uid ?? '';
}, 60_000);

afterAll(async () => {
  await deleteApp(app);
});

const ownerActor = () => ({ uid: ownerUid, name: 'Catalogue Owner', role: 'OWNER' as const });

/* ------------------------------------------------------------------------ *
 * Dresses
 * ------------------------------------------------------------------------ */

describe('dress CRUD', () => {
  it('creates a dress with a sequential code and an audit entry', async () => {
    const { createDress } = await import('@/services/dresses.service');
    const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');

    const created = await createDress({
      values: { ...EMPTY_DRESS_FORM, name: 'Aurora', designer: 'Elie Saab', rentalPrice: 180_000 },
      actor: ownerActor(),
      canSetPurchaseCost: true,
    });

    expect(created.code).toMatch(/^WD-\d{4,}$/);

    const stored = await getDoc(doc(db, 'dresses', created.id));
    expect(stored.exists()).toBe(true);
    expect(stored.data()).toMatchObject({
      code: created.code,
      name: 'Aurora',
      status: 'Available',
    });

    const audits = await getDocs(
      query(
        collection(db, 'auditLogs'),
        where('entityId', '==', created.id),
        where('action', '==', 'dress.created'),
      ),
    );
    expect(audits.size).toBe(1);
    expect(audits.docs[0]!.data()['actorUid']).toBe(ownerUid);
  });

  it('stores money as integer baisa, never a float', async () => {
    const { createDress } = await import('@/services/dresses.service');
    const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');
    const { parseOmr } = await import('@/domain/money');

    const created = await createDress({
      values: {
        ...EMPTY_DRESS_FORM,
        name: 'Money check',
        rentalPrice: parseOmr('180.500'),
        securityDeposit: parseOmr('100.000'),
      },
      actor: ownerActor(),
      canSetPurchaseCost: false,
    });

    const stored = (await getDoc(doc(db, 'dresses', created.id))).data()!;
    expect(stored['rentalPrice']).toBe(180_500);
    expect(Number.isInteger(stored['rentalPrice'])).toBe(true);
    expect(stored['securityDeposit']).toBe(100_000);
  });

  it('writes searchable tokens so the dress is findable', async () => {
    const { createDress, searchDresses } = await import('@/services/dresses.service');
    const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');

    await createDress({
      values: { ...EMPTY_DRESS_FORM, name: 'Marchesa Cascade', designer: 'Marchesa' },
      actor: ownerActor(),
      canSetPurchaseCost: false,
    });

    const results = await searchDresses('marchesa');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((dress) => dress.name === 'Marchesa Cascade')).toBe(true);
  });

  it('updates a dress and records what changed', async () => {
    const { createDress, updateDress, observeDress } = await import('@/services/dresses.service');
    const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');

    const created = await createDress({
      values: { ...EMPTY_DRESS_FORM, name: 'Before', rentalPrice: 100_000 },
      actor: ownerActor(),
      canSetPurchaseCost: false,
    });

    const before = await firstEmission(observeDress, created.id);

    const outcome = await updateDress({
      dressId: created.id,
      before,
      values: { ...EMPTY_DRESS_FORM, name: 'After', rentalPrice: 150_000 },
      actor: ownerActor(),
      canSetPurchaseCost: false,
    });

    expect(outcome.status).toBe('synced');

    const stored = (await getDoc(doc(db, 'dresses', created.id))).data()!;
    expect(stored['name']).toBe('After');
    expect(stored['rentalPrice']).toBe(150_000);
    expect(stored['code']).toBe(created.code);

    const audits = await getDocs(
      query(
        collection(db, 'auditLogs'),
        where('entityId', '==', created.id),
        where('action', '==', 'dress.updated'),
      ),
    );
    expect(audits.size).toBe(1);
    expect(audits.docs[0]!.data()['after']).toMatchObject({ name: 'After' });
  });

  it('retires a dress rather than deleting it', async () => {
    const { createDress, retireDress, observeDress } = await import('@/services/dresses.service');
    const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');

    const created = await createDress({
      values: { ...EMPTY_DRESS_FORM, name: 'To retire' },
      actor: ownerActor(),
      canSetPurchaseCost: false,
    });

    const dress = await firstEmission(observeDress, created.id);
    await retireDress(dress, ownerActor(), 'Damaged beyond repair');

    const stored = await getDoc(doc(db, 'dresses', created.id));
    // The record survives; only its status changed.
    expect(stored.exists()).toBe(true);
    expect(stored.data()!['status']).toBe('Retired');

    const audits = await getDocs(
      query(
        collection(db, 'auditLogs'),
        where('entityId', '==', created.id),
        where('action', '==', 'dress.retired'),
      ),
    );
    expect(audits.size).toBe(1);
    expect(audits.docs[0]!.data()['reason']).toBe('Damaged beyond repair');
  });

  it('refuses a reservation-driven status change made by hand', async () => {
    const { createDress, changeDressStatus, observeDress } =
      await import('@/services/dresses.service');
    const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');

    const created = await createDress({
      values: { ...EMPTY_DRESS_FORM, name: 'Status guard' },
      actor: ownerActor(),
      canSetPurchaseCost: false,
    });

    const dress = await firstEmission(observeDress, created.id);

    await expect(
      changeDressStatus({ dress, status: 'Reserved', actor: ownerActor() }),
    ).rejects.toThrow(/automatically/);

    const stored = (await getDoc(doc(db, 'dresses', created.id))).data()!;
    expect(stored['status']).toBe('Available');
  });

  it('keeps purchase cost in an owner-only subcollection', async () => {
    const { createDress, readPurchaseCost } = await import('@/services/dresses.service');
    const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');

    const created = await createDress({
      values: { ...EMPTY_DRESS_FORM, name: 'Costed', purchaseCost: 450_000 },
      actor: ownerActor(),
      canSetPurchaseCost: true,
    });

    // Not on the main document, which staff can read.
    const stored = (await getDoc(doc(db, 'dresses', created.id))).data()!;
    expect(stored['purchaseCost']).toBeUndefined();

    expect(await readPurchaseCost(created.id)).toBe(450_000);

    // Staff being refused the subcollection is asserted in the rules suite,
    // where an arbitrary role can be minted without a password reset flow.
  });
});

/* ------------------------------------------------------------------------ *
 * Concurrency — the guarantee that matters
 * ------------------------------------------------------------------------ */

describe('concurrent creation never issues a duplicate code', () => {
  it('gives eight simultaneous dress creations eight distinct codes', async () => {
    const { createDress } = await import('@/services/dresses.service');
    const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');

    const created = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createDress({
          values: { ...EMPTY_DRESS_FORM, name: `Concurrent ${index}` },
          actor: ownerActor(),
          canSetPurchaseCost: false,
        }),
      ),
    );

    const codes = created.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  }, 30_000);

  it('gives eight simultaneous customer creations eight distinct codes', async () => {
    const { createCustomer } = await import('@/services/customers.service');
    const { EMPTY_CUSTOMER_FORM } = await import('@/schemas/customer');

    const created = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createCustomer({
          values: {
            ...EMPTY_CUSTOMER_FORM,
            nameEn: `Concurrent ${index}`,
            phone: `9123456${index}`,
          },
          actor: ownerActor(),
        }),
      ),
    );

    const codes = created.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  }, 30_000);

  it('leaves the counter equal to the number of records created', async () => {
    const counter = await getDoc(doc(db, 'counters', 'dress'));
    const dresses = await getDocs(collection(db, 'dresses'));

    // A failed transaction must not consume a number, and a successful one must
    // not skip: the sequence and the record count agree exactly.
    expect(counter.data()!['current']).toBe(dresses.size);
  });
});

/* ------------------------------------------------------------------------ *
 * Customers
 * ------------------------------------------------------------------------ */

describe('customer CRUD', () => {
  it('creates a customer with a sequential code, normalised phone and audit entry', async () => {
    const { createCustomer } = await import('@/services/customers.service');
    const { EMPTY_CUSTOMER_FORM } = await import('@/schemas/customer');

    const created = await createCustomer({
      values: {
        ...EMPTY_CUSTOMER_FORM,
        nameEn: 'Fatima Al Balushi',
        nameAr: 'فاطمة البلوشي',
        phone: '9123 4567',
      },
      actor: ownerActor(),
    });

    expect(created.code).toMatch(/^CU-\d{4,}$/);

    const stored = (await getDoc(doc(db, 'customers', created.id))).data()!;
    expect(stored['phone']).toBe('+96891234567');
    expect(stored['phoneNormalized']).toBe('96891234567');
    expect(stored['archived']).toBe(false);

    const audits = await getDocs(
      query(
        collection(db, 'auditLogs'),
        where('entityId', '==', created.id),
        where('action', '==', 'customer.created'),
      ),
    );
    expect(audits.size).toBe(1);
  });

  it('does not put the national ID into the audit trail or search tokens', async () => {
    const { createCustomer } = await import('@/services/customers.service');
    const { EMPTY_CUSTOMER_FORM } = await import('@/schemas/customer');

    const created = await createCustomer({
      values: {
        ...EMPTY_CUSTOMER_FORM,
        nameEn: 'Private Person',
        phone: '91110001',
        nationalId: '99887766',
      },
      actor: ownerActor(),
    });

    const stored = (await getDoc(doc(db, 'customers', created.id))).data()!;
    expect(stored['nationalId']).toBe('99887766');
    expect(JSON.stringify(stored['searchTokens'])).not.toContain('99887766');

    const audits = await getDocs(
      query(collection(db, 'auditLogs'), where('entityId', '==', created.id)),
    );
    expect(JSON.stringify(audits.docs.map((entry) => entry.data()))).not.toContain('99887766');
  });

  it('warns about a duplicate phone number without blocking it', async () => {
    const { createCustomer, checkDuplicatePhone } = await import('@/services/customers.service');
    const { EMPTY_CUSTOMER_FORM } = await import('@/schemas/customer');

    const shared = '92220001';

    await createCustomer({
      values: { ...EMPTY_CUSTOMER_FORM, nameEn: 'Sister One', phone: shared },
      actor: ownerActor(),
    });

    const verdict = await checkDuplicatePhone(shared);
    expect(verdict.severity).toBe('warn');
    expect(verdict.matches.length).toBeGreaterThan(0);

    // The employee may proceed — families share numbers.
    const second = await createCustomer({
      values: { ...EMPTY_CUSTOMER_FORM, nameEn: 'Sister Two', phone: shared },
      actor: ownerActor(),
    });
    expect(second.code).toMatch(/^CU-/);
  });

  it('finds a customer by name, Arabic name, phone digits and code', async () => {
    const { createCustomer, searchCustomers } = await import('@/services/customers.service');
    const { EMPTY_CUSTOMER_FORM } = await import('@/schemas/customer');

    const created = await createCustomer({
      values: {
        ...EMPTY_CUSTOMER_FORM,
        nameEn: 'Maryam Alharthy',
        nameAr: 'مريم الحارثي',
        phone: '93330007',
      },
      actor: ownerActor(),
    });

    expect((await searchCustomers('maryam')).some((c) => c.id === created.id)).toBe(true);
    expect((await searchCustomers('alharthy')).some((c) => c.id === created.id)).toBe(true);
    expect((await searchCustomers('مريم')).some((c) => c.id === created.id)).toBe(true);
    expect((await searchCustomers('0007')).some((c) => c.id === created.id)).toBe(true);
    expect((await searchCustomers(created.code)).some((c) => c.id === created.id)).toBe(true);
  });

  it('archives a customer rather than deleting it', async () => {
    const { createCustomer, observeCustomer, setCustomerArchived } =
      await import('@/services/customers.service');
    const { EMPTY_CUSTOMER_FORM } = await import('@/schemas/customer');

    const created = await createCustomer({
      values: { ...EMPTY_CUSTOMER_FORM, nameEn: 'To archive', phone: '94440001' },
      actor: ownerActor(),
    });

    const customer = await firstEmission(observeCustomer, created.id);
    await setCustomerArchived({ customer, archived: true, actor: ownerActor() });

    const stored = await getDoc(doc(db, 'customers', created.id));
    expect(stored.exists()).toBe(true);
    expect(stored.data()!['archived']).toBe(true);

    const audits = await getDocs(
      query(
        collection(db, 'auditLogs'),
        where('entityId', '==', created.id),
        where('action', '==', 'customer.archived'),
      ),
    );
    expect(audits.size).toBe(1);
  });

  it('rejects an invalid phone number before it reaches Firestore', async () => {
    const { createCustomer } = await import('@/services/customers.service');
    const { EMPTY_CUSTOMER_FORM } = await import('@/schemas/customer');

    await expect(
      createCustomer({
        values: { ...EMPTY_CUSTOMER_FORM, nameEn: 'Bad phone', phone: '12345' },
        actor: ownerActor(),
      }),
    ).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

/**
 * Read the first non-null value from one of the `observe*` subscriptions.
 *
 * The services expose live subscriptions rather than one-shot reads, so tests
 * that need a snapshot take the first emission and unsubscribe.
 */
function firstEmission<T>(
  subscribe: (
    id: string,
    onChange: (value: T | null) => void,
    onError: (error: Error) => void,
  ) => () => void,
  id: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = subscribe(
      id,
      (value) => {
        if (value !== null) {
          stop();
          resolve(value);
        }
      },
      (error) => {
        stop();
        reject(error);
      },
    );
  });
}
