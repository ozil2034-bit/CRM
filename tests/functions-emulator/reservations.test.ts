/**
 * The reservation engine, against the Firebase Emulator Suite.
 *
 * The unit tests prove the availability algorithm is right. These prove the
 * deployed Function actually enforces it — atomically, under concurrency, with
 * real security rules and real transactions.
 *
 * The two concurrency tests are the reason this file exists. Nothing short of
 * firing genuinely simultaneous requests at one emulator demonstrates that a
 * dress cannot be promised twice.
 *
 * Run with:  npm run test:functions:reservations
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

const OWNER = { email: 'rsv-owner@azhary.test', password: 'a-very-long-password' };
const OUTSIDER = { email: 'rsv-outsider@azhary.test', password: 'another-long-password' };

let app: FirebaseApp;
let auth: Auth;
let db: Firestore;
let functions: Functions;
let storage: FirebaseStorage;

let ownerUid = '';
let customerId = '';

/**
 * Dates far enough ahead that "pickup in the past" never interferes, but inside
 * the two-year horizon the engine enforces. September of next year is between
 * eight and twenty months away whenever the suite runs.
 */
const YEAR = new Date().getUTCFullYear() + 1;
const SEP = (day: number, time = '10:00') => `${YEAR}-09-${String(day).padStart(2, '0')}T${time}`;

beforeAll(async () => {
  app = initializeApp(
    { projectId: PROJECT_ID, apiKey: 'emulator-key', appId: 'emulator-app' },
    'reservations',
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
  await httpsCallable<{ setupToken: string; name: string }, { ok: boolean }>(
    functions,
    'claimInitialOwnership',
  )({ setupToken: SETUP_TOKEN, name: 'Reservation Owner' });
  await auth.currentUser?.getIdToken(true);
  ownerUid = auth.currentUser?.uid ?? '';

  const { createCustomer } = await import('@/services/customers.service');
  const { EMPTY_CUSTOMER_FORM } = await import('@/schemas/customer');

  const customer = await createCustomer({
    values: { ...EMPTY_CUSTOMER_FORM, nameEn: 'Bride One', phone: '91000001' },
    actor: actor(),
  });
  customerId = customer.id;
}, 90_000);

afterAll(async () => {
  await deleteApp(app);
});

const actor = () => ({ uid: ownerUid, name: 'Reservation Owner', role: 'OWNER' as const });

async function asOwner(): Promise<void> {
  await signOut(auth);
  await signInWithEmailAndPassword(auth, OWNER.email, OWNER.password);
  await auth.currentUser?.getIdToken(true);
}

/** Create a dress and return its id. */
async function makeDress(
  name: string,
  overrides: Partial<{
    cleaningBufferDays: number;
    rentalPrice: number;
    securityDeposit: number;
  }> = {},
): Promise<string> {
  const { createDress } = await import('@/services/dresses.service');
  const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');

  const created = await createDress({
    values: {
      ...EMPTY_DRESS_FORM,
      name,
      rentalPrice: overrides.rentalPrice ?? 180_000,
      securityDeposit: overrides.securityDeposit ?? 100_000,
      cleaningBufferDays: overrides.cleaningBufferDays ?? 3,
    },
    actor: actor(),
    canSetPurchaseCost: false,
  });

  return created.id;
}

type CreateResult =
  | { success: true; reservationId: string; reservationNumber: string; total: number }
  | {
      success: false;
      reason: string;
      conflicts: {
        dressCode: string;
        reason: string;
        conflictingReservationCode: string | null;
        availableFrom: number | null;
      }[];
    };

function createReservation(input: {
  customerId?: string;
  pickupAt: string;
  returnAt: string;
  eventDate?: string | null;
  dressIds: string[];
}) {
  return httpsCallable<typeof input, CreateResult>(
    functions,
    'createReservation',
  )({ customerId, eventDate: null, ...input });
}

async function refusalCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return ((error as { code?: string }).code ?? 'unknown').replace(/^functions\//, '');
  }
  throw new Error('Expected the call to be refused, but it succeeded.');
}

/* ------------------------------------------------------------------------ *
 * Creation
 * ------------------------------------------------------------------------ */

describe('creating a reservation', () => {
  it('books a dress, numbers it, and records everything atomically', async () => {
    const dressId = await makeDress('Aurora');

    const result = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [dressId],
    });

    expect(result.data.success).toBe(true);
    if (!result.data.success) return;

    expect(result.data.reservationNumber).toMatch(/^RSV-\d{4,}$/);

    const reservation = await getDoc(doc(db, 'reservations', result.data.reservationId));
    expect(reservation.data()).toMatchObject({ status: 'Reserved', customerId });

    const items = await getDocs(
      query(
        collection(db, 'reservationItems'),
        where('reservationId', '==', result.data.reservationId),
      ),
    );
    expect(items.size).toBe(1);
    expect(items.docs[0]!.data()['blocking']).toBe(true);

    // The dress follows the reservation.
    const dress = await getDoc(doc(db, 'dresses', dressId));
    expect(dress.data()!['status']).toBe('Reserved');

    const audits = await getDocs(
      query(
        collection(db, 'auditLogs'),
        where('entityId', '==', result.data.reservationId),
        where('action', '==', 'reservation.created'),
      ),
    );
    expect(audits.size).toBe(1);
  });

  it('stores the blocked interval as pickup through return plus the buffer', async () => {
    const dressId = await makeDress('Buffer check', { cleaningBufferDays: 3 });

    const result = await createReservation({
      pickupAt: SEP(10, '11:00'),
      returnAt: SEP(12, '11:00'),
      dressIds: [dressId],
    });
    if (!result.data.success) throw new Error('expected success');

    const items = await getDocs(
      query(
        collection(db, 'reservationItems'),
        where('reservationId', '==', result.data.reservationId),
      ),
    );
    const item = items.docs[0]!.data();

    const { fromMuscatWallTime } = await import('@/domain/datetime');

    expect(item['blockStartAt'].toMillis()).toBe(fromMuscatWallTime(SEP(10, '11:00')));
    // 12 Sep + 3 days of cleaning.
    expect(item['blockEndAt'].toMillis()).toBe(fromMuscatWallTime(SEP(15, '11:00')));
  });

  it('freezes pricing as integer baisa on the reservation', async () => {
    const dressId = await makeDress('Priced', { rentalPrice: 180_500, securityDeposit: 100_000 });

    const result = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [dressId],
    });
    if (!result.data.success) throw new Error('expected success');

    const pricing = (await getDoc(doc(db, 'reservations', result.data.reservationId))).data()![
      'pricing'
    ] as Record<string, unknown>;

    expect(pricing['rentalSubtotal']).toBe(180_500);
    expect(pricing['securityDepositTotal']).toBe(100_000);
    expect(Number.isInteger(pricing['grandTotal'])).toBe(true);
    // The deposit is outside the VAT base.
    expect(pricing['taxableSubtotal']).toBe(180_500);
  });

  it('books several dresses in one reservation', async () => {
    const dressIds = await Promise.all([
      makeDress('Multi A'),
      makeDress('Multi B'),
      makeDress('Multi C'),
    ]);

    const result = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds,
    });
    if (!result.data.success) throw new Error('expected success');

    const items = await getDocs(
      query(
        collection(db, 'reservationItems'),
        where('reservationId', '==', result.data.reservationId),
      ),
    );
    expect(items.size).toBe(3);
  });
});

/* ------------------------------------------------------------------------ *
 * Atomicity across dresses
 * ------------------------------------------------------------------------ */

describe('a multi-dress reservation is all or nothing', () => {
  it('creates NOTHING when one of three dresses is unavailable', async () => {
    const free1 = await makeDress('Atomic free 1');
    const free2 = await makeDress('Atomic free 2');
    const taken = await makeDress('Atomic taken');

    // Someone already has the third gown for those dates.
    const first = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [taken],
    });
    if (!first.data.success) throw new Error('setup failed');

    const before = await countReservations();

    const result = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [free1, free2, taken],
    });

    expect(result.data.success).toBe(false);
    if (result.data.success) return;

    expect(result.data.reason).toBe('DRESS_UNAVAILABLE');
    expect(result.data.conflicts).toHaveLength(1);
    expect(result.data.conflicts[0]!.conflictingReservationCode).toBe(first.data.reservationNumber);

    // No half-reservation for the two that were free.
    expect(await countReservations()).toBe(before);

    for (const dressId of [free1, free2]) {
      const items = await getDocs(
        query(collection(db, 'reservationItems'), where('dressId', '==', dressId)),
      );
      expect(items.size).toBe(0);

      const dress = await getDoc(doc(db, 'dresses', dressId));
      expect(dress.data()!['status']).toBe('Available');
    }
  });

  it('names every unavailable dress, not just the first', async () => {
    const takenA = await makeDress('Report A');
    const takenB = await makeDress('Report B');
    const free = await makeDress('Report free');

    await createReservation({ pickupAt: SEP(10), returnAt: SEP(12), dressIds: [takenA] });
    await createReservation({ pickupAt: SEP(10), returnAt: SEP(12), dressIds: [takenB] });

    const result = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [takenA, free, takenB],
    });

    expect(result.data.success).toBe(false);
    if (result.data.success) return;
    expect(result.data.conflicts).toHaveLength(2);
  });

  it('returns a conflict with the detail an employee can act on', async () => {
    const dressId = await makeDress('Detailed conflict');

    const first = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [dressId],
    });
    if (!first.data.success) throw new Error('setup failed');

    const result = await createReservation({
      pickupAt: SEP(11),
      returnAt: SEP(13),
      dressIds: [dressId],
    });
    if (result.data.success) throw new Error('expected a conflict');

    const conflict = result.data.conflicts[0]!;

    // Not "something went wrong".
    expect(conflict.reason).toBe('DATE_OVERLAP');
    expect(conflict.dressCode).toMatch(/^WD-/);
    expect(conflict.conflictingReservationCode).toBe(first.data.reservationNumber);
    expect(conflict.availableFrom).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------ *
 * The cleaning buffer
 * ------------------------------------------------------------------------ */

describe('the cleaning buffer', () => {
  it('rejects a pickup during the cleaning period and says so', async () => {
    const dressId = await makeDress('Cleaning', { cleaningBufferDays: 3 });

    await createReservation({ pickupAt: SEP(10), returnAt: SEP(12), dressIds: [dressId] });

    const result = await createReservation({
      pickupAt: SEP(14),
      returnAt: SEP(16),
      dressIds: [dressId],
    });

    expect(result.data.success).toBe(false);
    if (result.data.success) return;
    expect(result.data.conflicts[0]!.reason).toBe('CLEANING_BUFFER');
  });

  it('accepts a pickup exactly when the cleaning period expires', async () => {
    const dressId = await makeDress('Cleaning boundary', { cleaningBufferDays: 3 });

    await createReservation({
      pickupAt: SEP(10, '11:00'),
      returnAt: SEP(12, '11:00'),
      dressIds: [dressId],
    });

    // Blocked until 15 Sep 11:00; free at exactly that instant.
    const result = await createReservation({
      pickupAt: SEP(15, '11:00'),
      returnAt: SEP(17, '11:00'),
      dressIds: [dressId],
    });

    expect(result.data.success).toBe(true);
  });

  it('honours a dress-level buffer that differs from the default', async () => {
    const dressId = await makeDress('Long buffer', { cleaningBufferDays: 7 });

    await createReservation({
      pickupAt: SEP(10, '11:00'),
      returnAt: SEP(12, '11:00'),
      dressIds: [dressId],
    });

    // Would be fine with the 3-day default, but this gown needs seven.
    const tooSoon = await createReservation({
      pickupAt: SEP(16, '11:00'),
      returnAt: SEP(18, '11:00'),
      dressIds: [dressId],
    });
    expect(tooSoon.data.success).toBe(false);

    const later = await createReservation({
      pickupAt: SEP(19, '11:00'),
      returnAt: SEP(21, '11:00'),
      dressIds: [dressId],
    });
    expect(later.data.success).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * Concurrency — the guarantee this phase exists for
 * ------------------------------------------------------------------------ */

describe('concurrent bookings', () => {
  it('lets exactly ONE of eight simultaneous bookings of the same dress win', async () => {
    const dressId = await makeDress('Contended');

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        createReservation({ pickupAt: SEP(10), returnAt: SEP(12), dressIds: [dressId] }).then(
          (result) => result.data,
        ),
      ),
    );

    const succeeded = attempts.filter((attempt) => attempt.success);
    const failed = attempts.filter((attempt) => !attempt.success);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(7);

    // Every loser gets a structured conflict, not a vague error.
    for (const attempt of failed) {
      if (attempt.success) continue;
      expect(attempt.reason).toBe('DRESS_UNAVAILABLE');
      expect(attempt.conflicts.length).toBeGreaterThan(0);
    }

    // And exactly one blocking item exists — no orphans, no duplicates.
    const items = await getDocs(
      query(collection(db, 'reservationItems'), where('dressId', '==', dressId)),
    );
    expect(items.size).toBe(1);

    const dress = await getDoc(doc(db, 'dresses', dressId));
    expect(dress.data()!['status']).toBe('Reserved');
  }, 60_000);

  it('lets eight simultaneous bookings of DIFFERENT dresses all succeed', async () => {
    const dressIds = await Promise.all(
      Array.from({ length: 8 }, (_, index) => makeDress(`Parallel ${index}`)),
    );

    const attempts = await Promise.all(
      dressIds.map((dressId) =>
        createReservation({ pickupAt: SEP(20), returnAt: SEP(22), dressIds: [dressId] }).then(
          (result) => result.data,
        ),
      ),
    );

    expect(attempts.every((attempt) => attempt.success)).toBe(true);

    // Distinct reservation numbers: the counter held under parallel load.
    const codes = attempts.map((attempt) => (attempt.success ? attempt.reservationNumber : ''));
    expect(new Set(codes).size).toBe(8);
  }, 60_000);
});

/* ------------------------------------------------------------------------ *
 * Rollback
 * ------------------------------------------------------------------------ */

describe('a failed creation leaves nothing behind', () => {
  it('does not consume a reservation number when a dress does not exist', async () => {
    const real = await makeDress('Rollback real');

    const counterBefore = await readCounter();
    const reservationsBefore = await countReservations();

    const code = await refusalCode(() =>
      createReservation({
        pickupAt: SEP(10),
        returnAt: SEP(12),
        dressIds: [real, 'this-dress-does-not-exist'],
      }),
    );
    expect(code).toBe('not-found');

    // No number burned, no reservation, no items, and the real dress untouched.
    expect(await readCounter()).toBe(counterBefore);
    expect(await countReservations()).toBe(reservationsBefore);

    const items = await getDocs(
      query(collection(db, 'reservationItems'), where('dressId', '==', real)),
    );
    expect(items.size).toBe(0);

    expect((await getDoc(doc(db, 'dresses', real))).data()!['status']).toBe('Available');
  });

  it('does not consume a reservation number when the availability check fails', async () => {
    const dressId = await makeDress('Rollback conflict');
    await createReservation({ pickupAt: SEP(10), returnAt: SEP(12), dressIds: [dressId] });

    const counterBefore = await readCounter();

    const result = await createReservation({
      pickupAt: SEP(11),
      returnAt: SEP(13),
      dressIds: [dressId],
    });
    expect(result.data.success).toBe(false);

    expect(await readCounter()).toBe(counterBefore);
  });

  it('does not record an audit entry for a reservation that was never created', async () => {
    const dressId = await makeDress('Rollback audit');
    await createReservation({ pickupAt: SEP(10), returnAt: SEP(12), dressIds: [dressId] });

    const before = (
      await getDocs(
        query(collection(db, 'auditLogs'), where('action', '==', 'reservation.created')),
      )
    ).size;

    await createReservation({ pickupAt: SEP(11), returnAt: SEP(13), dressIds: [dressId] });

    const after = (
      await getDocs(
        query(collection(db, 'auditLogs'), where('action', '==', 'reservation.created')),
      )
    ).size;

    expect(after).toBe(before);
  });
});

/* ------------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------------ */

describe('validation', () => {
  it('rejects a pickup in the past', async () => {
    const dressId = await makeDress('Past pickup');
    const code = await refusalCode(() =>
      createReservation({
        pickupAt: '2020-01-01T10:00',
        returnAt: '2020-01-03T10:00',
        dressIds: [dressId],
      }),
    );
    expect(code).toBe('invalid-argument');
  });

  it('rejects a return before pickup', async () => {
    const dressId = await makeDress('Backwards');
    const code = await refusalCode(() =>
      createReservation({ pickupAt: SEP(12), returnAt: SEP(10), dressIds: [dressId] }),
    );
    expect(code).toBe('invalid-argument');
  });

  it('rejects a date that does not exist', async () => {
    const dressId = await makeDress('Impossible date');
    const code = await refusalCode(() =>
      createReservation({
        pickupAt: `${YEAR}-02-30T10:00`,
        returnAt: SEP(12),
        dressIds: [dressId],
      }),
    );
    expect(code).toBe('invalid-argument');
  });

  it('rejects an empty dress list', async () => {
    const code = await refusalCode(() =>
      createReservation({ pickupAt: SEP(10), returnAt: SEP(12), dressIds: [] }),
    );
    expect(code).toBe('invalid-argument');
  });

  it('rejects the same dress twice in one reservation', async () => {
    const dressId = await makeDress('Duplicated');
    const code = await refusalCode(() =>
      createReservation({ pickupAt: SEP(10), returnAt: SEP(12), dressIds: [dressId, dressId] }),
    );
    expect(code).toBe('invalid-argument');
  });

  it('rejects a forged customer id', async () => {
    const dressId = await makeDress('Forged customer');
    const code = await refusalCode(() =>
      httpsCallable(
        functions,
        'createReservation',
      )({
        customerId: 'not-a-real-customer',
        pickupAt: SEP(10),
        returnAt: SEP(12),
        eventDate: null,
        dressIds: [dressId],
      }),
    );
    expect(code).toBe('not-found');
  });

  it('rejects a retired dress regardless of dates', async () => {
    const dressId = await makeDress('To retire for booking');

    const { retireDress, observeDress } = await import('@/services/dresses.service');
    const dress = await firstEmission(observeDress, dressId);
    await retireDress(dress, actor(), 'Removed from service');

    const result = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [dressId],
    });

    expect(result.data.success).toBe(false);
    if (result.data.success) return;
    expect(result.data.conflicts[0]!.reason).toBe('DRESS_RETIRED');
  });
});

/* ------------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------------ */

describe('the reservation lifecycle', () => {
  it('moves the dress through Reserved → Out with Customer → In Cleaning', async () => {
    const dressId = await makeDress('Lifecycle');
    const created = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [dressId],
    });
    if (!created.data.success) throw new Error('setup failed');

    const reservationId = created.data.reservationId;

    expect((await getDoc(doc(db, 'dresses', dressId))).data()!['status']).toBe('Reserved');

    await changeStatus(reservationId, 'Picked Up');
    expect((await getDoc(doc(db, 'dresses', dressId))).data()!['status']).toBe('Out with Customer');

    await changeStatus(reservationId, 'Returned');
    // Not Available — the gown has to be cleaned first.
    expect((await getDoc(doc(db, 'dresses', dressId))).data()!['status']).toBe('In Cleaning');

    await changeStatus(reservationId, 'Closed');
    expect((await getDoc(doc(db, 'reservations', reservationId))).data()!['status']).toBe('Closed');
  });

  it('records an audit entry for every status change', async () => {
    const dressId = await makeDress('Audited lifecycle');
    const created = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [dressId],
    });
    if (!created.data.success) throw new Error('setup failed');

    await changeStatus(created.data.reservationId, 'Picked Up');

    const audits = await getDocs(
      query(
        collection(db, 'auditLogs'),
        where('entityId', '==', created.data.reservationId),
        where('action', '==', 'reservation.status_changed'),
      ),
    );

    expect(audits.size).toBe(1);
    const entry = audits.docs[0]!.data();
    expect(entry['before']).toMatchObject({ status: 'Reserved' });
    expect(entry['after']).toMatchObject({ status: 'Picked Up' });
    expect(entry['actorUid']).toBe(ownerUid);
  });

  it('refuses an invalid transition', async () => {
    const dressId = await makeDress('Bad transition');
    const created = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [dressId],
    });
    if (!created.data.success) throw new Error('setup failed');
    const { reservationId } = created.data;

    const code = await refusalCode(() => changeStatus(reservationId, 'Closed'));
    expect(code).toBe('failed-precondition');
  });

  it('frees the dress when a reservation is cancelled', async () => {
    const dressId = await makeDress('Cancelled');
    const created = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [dressId],
    });
    if (!created.data.success) throw new Error('setup failed');

    await changeStatus(created.data.reservationId, 'Cancelled');

    expect((await getDoc(doc(db, 'dresses', dressId))).data()!['status']).toBe('Available');

    // And the dates are bookable again.
    const reBooked = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [dressId],
    });
    expect(reBooked.data.success).toBe(true);
  });

  it('frees the dress on a no-show', async () => {
    const dressId = await makeDress('No-show');
    const created = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [dressId],
    });
    if (!created.data.success) throw new Error('setup failed');

    await changeStatus(created.data.reservationId, 'No-Show');

    const reBooked = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [dressId],
    });
    expect(reBooked.data.success).toBe(true);
  });

  it('keeps a dress reserved when another booking still holds it', async () => {
    const dressId = await makeDress('Two bookings');

    const first = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [dressId],
    });
    const second = await createReservation({
      pickupAt: SEP(20),
      returnAt: SEP(22),
      dressIds: [dressId],
    });
    if (!first.data.success || !second.data.success) throw new Error('setup failed');

    await changeStatus(second.data.reservationId, 'Cancelled');

    // The October booking is gone but the September one still holds the gown.
    expect((await getDoc(doc(db, 'dresses', dressId))).data()!['status']).toBe('Reserved');
  });
});

/* ------------------------------------------------------------------------ *
 * Editing
 * ------------------------------------------------------------------------ */

describe('editing a reservation', () => {
  it('revalidates availability and moves the blocked interval', async () => {
    const dressId = await makeDress('Editable', { cleaningBufferDays: 3 });
    const created = await createReservation({
      pickupAt: SEP(10, '11:00'),
      returnAt: SEP(12, '11:00'),
      dressIds: [dressId],
    });
    if (!created.data.success) throw new Error('setup failed');

    const result = await httpsCallable<
      { reservationId: string; pickupAt: string; returnAt: string; eventDate: null },
      { success: boolean }
    >(
      functions,
      'updateReservationDates',
    )({
      reservationId: created.data.reservationId,
      pickupAt: SEP(14, '11:00'),
      returnAt: SEP(18, '11:00'),
      eventDate: null,
    });

    expect(result.data.success).toBe(true);

    const { fromMuscatWallTime } = await import('@/domain/datetime');
    const items = await getDocs(
      query(
        collection(db, 'reservationItems'),
        where('reservationId', '==', created.data.reservationId),
      ),
    );
    expect(items.docs[0]!.data()['blockEndAt'].toMillis()).toBe(
      fromMuscatWallTime(SEP(21, '11:00')),
    );
  });

  it('rejects an edit that would collide, and preserves the original', async () => {
    const dressId = await makeDress('Edit collision');

    const first = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [dressId],
    });
    const second = await createReservation({
      pickupAt: SEP(25),
      returnAt: SEP(27),
      dressIds: [dressId],
    });
    if (!first.data.success || !second.data.success) throw new Error('setup failed');

    const before = (await getDoc(doc(db, 'reservations', second.data.reservationId))).data()!;

    const result = await httpsCallable<
      { reservationId: string; pickupAt: string; returnAt: string; eventDate: null },
      { success: boolean; conflicts: unknown[] }
    >(
      functions,
      'updateReservationDates',
    )({
      reservationId: second.data.reservationId,
      pickupAt: SEP(11),
      returnAt: SEP(13),
      eventDate: null,
    });

    expect(result.data.success).toBe(false);

    const after = (await getDoc(doc(db, 'reservations', second.data.reservationId))).data()!;
    expect(after['pickupAt'].toMillis()).toBe(before['pickupAt'].toMillis());
    expect(after['returnAt'].toMillis()).toBe(before['returnAt'].toMillis());
  });

  it('does not let a reservation conflict with itself', async () => {
    const dressId = await makeDress('Self edit');
    const created = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [dressId],
    });
    if (!created.data.success) throw new Error('setup failed');

    const result = await httpsCallable<
      { reservationId: string; pickupAt: string; returnAt: string; eventDate: null },
      { success: boolean }
    >(
      functions,
      'updateReservationDates',
    )({
      reservationId: created.data.reservationId,
      pickupAt: SEP(10),
      returnAt: SEP(13),
      eventDate: null,
    });

    expect(result.data.success).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------------ */

describe('authorization', () => {
  it('DENIES an unauthenticated caller', async () => {
    const dressId = await makeDress('Authz unauth');
    await signOut(auth);

    const code = await refusalCode(() =>
      createReservation({ pickupAt: SEP(10), returnAt: SEP(12), dressIds: [dressId] }),
    );
    expect(code).toBe('unauthenticated');

    await asOwner();
  });

  it('DENIES a signed-in caller who is not an employee', async () => {
    const dressId = await makeDress('Authz outsider');

    await signOut(auth);
    await createUserWithEmailAndPassword(auth, OUTSIDER.email, OUTSIDER.password);

    const code = await refusalCode(() =>
      createReservation({ pickupAt: SEP(10), returnAt: SEP(12), dressIds: [dressId] }),
    );
    expect(code).toBe('permission-denied');

    await asOwner();
  });

  it('DENIES an unauthenticated status change', async () => {
    const dressId = await makeDress('Authz status');
    const created = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [dressId],
    });
    if (!created.data.success) throw new Error('setup failed');
    const { reservationId } = created.data;

    await signOut(auth);
    const code = await refusalCode(() => changeStatus(reservationId, 'Picked Up'));
    expect(code).toBe('unauthenticated');

    await asOwner();
  });

  it('DENIES writing a reservation item directly from a client', async () => {
    // The blocking intervals decide availability; a client able to write them
    // could book a dress by inventing an item.
    const { setDoc } = await import('firebase/firestore');

    await expect(
      setDoc(doc(db, 'reservationItems', 'forged'), {
        dressId: 'anything',
        blocking: true,
        blockStartAt: new Date(),
        blockEndAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('DENIES writing a reservation directly from a client', async () => {
    const { setDoc } = await import('firebase/firestore');

    await expect(
      setDoc(doc(db, 'reservations', 'forged'), { code: 'RSV-9999', status: 'Reserved' }),
    ).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------------ *
 * Cleaning release
 * ------------------------------------------------------------------------ */

describe('releaseCleanedDresses', () => {
  it('leaves a dress in cleaning while its buffer is still running', async () => {
    const dressId = await makeDress('Still cleaning', { cleaningBufferDays: 3 });
    const created = await createReservation({
      pickupAt: SEP(10),
      returnAt: SEP(12),
      dressIds: [dressId],
    });
    if (!created.data.success) throw new Error('setup failed');

    await changeStatus(created.data.reservationId, 'Picked Up');
    await changeStatus(created.data.reservationId, 'Returned');

    await httpsCallable(functions, 'releaseCleanedDresses')({});

    // The buffer runs to a date years ahead, so the gown stays in cleaning.
    expect((await getDoc(doc(db, 'dresses', dressId))).data()!['status']).toBe('In Cleaning');
  });
});

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

function changeStatus(reservationId: string, status: string) {
  return httpsCallable<{ reservationId: string; status: string }, { success: boolean }>(
    functions,
    'changeReservationStatus',
  )({ reservationId, status });
}

async function countReservations(): Promise<number> {
  return (await getDocs(collection(db, 'reservations'))).size;
}

async function readCounter(): Promise<number> {
  const snapshot = await getDoc(doc(db, 'counters', 'reservation'));
  return snapshot.exists() ? Number(snapshot.data()['current'] ?? 0) : 0;
}

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
