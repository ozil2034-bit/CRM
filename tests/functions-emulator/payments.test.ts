/**
 * The financial engine, against the Firebase Emulator Suite.
 *
 * The domain tests prove the arithmetic. These prove the deployed Functions
 * enforce it — atomically, under concurrency, with real security rules, real
 * transactions and a real idempotency guarantee.
 *
 * The concurrency block is the reason this file exists. A balance is a
 * reduction over an event list, so two simultaneous payments each read a stale
 * list unless the transactions genuinely conflict. Nothing short of firing real
 * simultaneous requests at one emulator demonstrates that they do.
 *
 * Run with:  npm run test:functions:payments
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
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  setDoc,
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

const OWNER = { email: 'pay-owner@azhary.test', password: 'a-very-long-password' };
const STAFF = { email: 'pay-staff@azhary.test', password: 'another-long-password' };

let app: FirebaseApp;
let auth: Auth;
let db: Firestore;
let functions: Functions;
let storage: FirebaseStorage;

let ownerUid = '';
let customerId = '';

const YEAR = new Date().getUTCFullYear() + 1;
const SEP = (day: number, time = '10:00') => `${YEAR}-09-${String(day).padStart(2, '0')}T${time}`;

/** A dress renting at OMR 200.000 with an OMR 100.000 deposit. */
const RENTAL = 200_000;
const DEPOSIT = 100_000;
/** With 5% VAT the chargeable rental is 210.000; the deposit stays outside it. */
const CHARGEABLE = 210_000;

beforeAll(async () => {
  app = initializeApp(
    { projectId: PROJECT_ID, apiKey: 'emulator-key', appId: 'emulator-app' },
    'payments',
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
  )({ setupToken: SETUP_TOKEN, name: 'Finance Owner' });
  await auth.currentUser?.getIdToken(true);
  ownerUid = auth.currentUser?.uid ?? '';

  // 5% VAT and a OMR 10.000/day late fee, so the tests exercise real settings
  // rather than the zero defaults.
  await setDoc(doc(db, 'settings', 'app'), {
    vatRatePercent: 5,
    lateFeePerDay: 10_000,
    minPickupPaymentPercent: 100,
    cancellationTiers: [
      { daysBeforeEvent: 30, refundPercent: 100, label: { en: '30+ days', ar: '' } },
      { daysBeforeEvent: 14, refundPercent: 50, label: { en: '14–29 days', ar: '' } },
      { daysBeforeEvent: 7, refundPercent: 25, label: { en: '7–13 days', ar: '' } },
    ],
  });

  /*
   * `createEmployee` never handles a password — the employee sets their own
   * through the reset link it returns. The suite follows that same flow rather
   * than reaching around it, so the STAFF identity used below is one produced
   * exactly as a real employee's would be.
   */
  const employee = await httpsCallable<
    { email: string; name: string; role: string },
    { uid: string; passwordResetLink: string }
  >(
    functions,
    'createEmployee',
  )({ email: STAFF.email, name: 'Finance Staff', role: 'STAFF' });

  const oobCode = new URL(employee.data.passwordResetLink).searchParams.get('oobCode');
  if (oobCode === null) throw new Error('No reset code was issued for the staff account.');

  await confirmPasswordReset(auth, oobCode, STAFF.password);
  await signInWithEmailAndPassword(auth, OWNER.email, OWNER.password);
  await auth.currentUser?.getIdToken(true);

  const { createCustomer } = await import('@/services/customers.service');
  const { EMPTY_CUSTOMER_FORM } = await import('@/schemas/customer');

  const customer = await createCustomer({
    values: { ...EMPTY_CUSTOMER_FORM, nameEn: 'Bride One', phone: '91000002' },
    actor: { uid: ownerUid, name: 'Finance Owner', role: 'OWNER' },
  });
  customerId = customer.id;
}, 120_000);

afterAll(async () => {
  await deleteApp(app);
});

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

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

let keySequence = 0;
function key(prefix = 'k'): string {
  keySequence += 1;
  return `${prefix}-${keySequence}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Create a reservation and return its id. Days are spread so nothing collides. */
let dayCursor = 1;
async function makeReservation(
  options: { rentalPrice?: number; securityDeposit?: number; eventDate?: string | null } = {},
): Promise<{ id: string; code: string }> {
  const { createDress } = await import('@/services/dresses.service');
  const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');

  const dress = await createDress({
    values: {
      ...EMPTY_DRESS_FORM,
      name: `Money ${dayCursor}`,
      rentalPrice: options.rentalPrice ?? RENTAL,
      securityDeposit: options.securityDeposit ?? DEPOSIT,
      cleaningBufferDays: 0,
    },
    actor: { uid: ownerUid, name: 'Finance Owner', role: 'OWNER' },
    canSetPurchaseCost: false,
  });

  const pickup = SEP(Math.min(28, dayCursor));
  const returned = SEP(Math.min(28, dayCursor));
  dayCursor += 1;

  const result = await httpsCallable<
    Record<string, unknown>,
    { success: boolean; reservationId: string; reservationNumber: string }
  >(
    functions,
    'createReservation',
  )({
    customerId,
    pickupAt: pickup,
    returnAt: returned.replace('T10:00', 'T18:00'),
    eventDate: options.eventDate === undefined ? null : options.eventDate,
    dressIds: [dress.id],
  });

  if (!result.data.success) throw new Error('reservation setup failed');
  return { id: result.data.reservationId, code: result.data.reservationNumber };
}

const call = <Request, Response>(name: string) => httpsCallable<Request, Response>(functions, name);

interface PostResult {
  success: boolean;
  eventId: string;
  duplicate: boolean;
  outstanding: number;
  depositHeld: number;
  status: string;
}

function pay(reservationId: string, amount: number, extra: Record<string, unknown> = {}) {
  return call<Record<string, unknown>, PostResult>('recordPayment')({
    reservationId,
    amount,
    method: 'Cash',
    type: 'Installment',
    reference: '',
    idempotencyKey: key('pay'),
    ...extra,
  });
}

function depositIn(reservationId: string, amount: number, extra: Record<string, unknown> = {}) {
  return call<Record<string, unknown>, PostResult>('recordSecurityDeposit')({
    reservationId,
    amount,
    method: 'Cash',
    reference: '',
    idempotencyKey: key('dep'),
    ...extra,
  });
}

function refund(reservationId: string, amount: number, extra: Record<string, unknown> = {}) {
  return call<Record<string, unknown>, PostResult>('refundPayment')({
    reservationId,
    amount,
    method: 'Cash',
    reference: '',
    reason: 'Cancelled booking',
    idempotencyKey: key('ref'),
    ...extra,
  });
}

function settle(reservationId: string, amount: number, forfeit: boolean, reason = 'Damage') {
  return call<Record<string, unknown>, PostResult>('settleDeposit')({
    reservationId,
    amount,
    forfeit,
    reason,
    method: 'Cash',
    idempotencyKey: key('set'),
  });
}

async function refusalCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return ((error as { code?: string }).code ?? 'unknown').replace(/^functions\//, '');
  }
  throw new Error('Expected the call to be refused, but it succeeded.');
}

async function eventsFor(reservationId: string) {
  const snapshot = await getDocs(
    query(collection(db, 'financialEvents'), where('reservationId', '==', reservationId)),
  );
  return snapshot.docs.map((document) => document.data());
}

async function positionOf(reservationId: string) {
  const { reduceLedger } = await import('@/domain/ledger');
  const reservation = await getDoc(doc(db, 'reservations', reservationId));
  const pricing = reservation.data()!['pricing'] as never;

  const events = (await eventsFor(reservationId)).map((data, index) => ({
    id: `x-${index}`,
    reservationId,
    kind: data['kind'],
    amount: data['amount'],
    method: data['method'] ?? null,
    type: data['type'] ?? null,
    occurredAt: 0,
    reference: '',
    reason: '',
    employeeId: '',
    reversesEventId: data['reversesEventId'] ?? null,
    idempotencyKey: '',
  })) as never;

  return reduceLedger(pricing, events);
}

/* ------------------------------------------------------------------------ *
 * Recording money
 * ------------------------------------------------------------------------ */

describe('recording a payment', () => {
  it('posts an event and reduces the outstanding balance', async () => {
    await asOwner();
    const { id } = await makeReservation();

    const result = await pay(id, 100_000);

    expect(result.data.success).toBe(true);
    expect(result.data.outstanding).toBe(CHARGEABLE - 100_000);
    expect(result.data.status).toBe('Partially Paid');

    const events = await eventsFor(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'Payment', amount: 100_000, method: 'Cash' });
  });

  it('settles the reservation when paid in full', async () => {
    await asOwner();
    const { id } = await makeReservation();

    const result = await pay(id, CHARGEABLE);

    expect(result.data.outstanding).toBe(0);
    expect(result.data.status).toBe('Paid');
  });

  it('writes an audit record naming the employee', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, 50_000);

    const audits = await getDocs(
      query(
        collection(db, 'auditLogs'),
        where('entityId', '==', id),
        where('action', '==', 'payment.recorded'),
      ),
    );

    expect(audits.size).toBe(1);
    expect(audits.docs[0]!.data()['actorUid']).toBe(ownerUid);
  });

  it('keeps the security deposit OUT of the rental balance', async () => {
    await asOwner();
    const { id } = await makeReservation();

    const result = await depositIn(id, DEPOSIT);

    expect(result.data.depositHeld).toBe(DEPOSIT);
    // The whole point: a deposit pays for nothing.
    expect(result.data.outstanding).toBe(CHARGEABLE);
    expect(result.data.status).toBe('Unpaid');
  });

  it('bumps financialVersion so concurrent work conflicts', async () => {
    await asOwner();
    const { id } = await makeReservation();

    await pay(id, 10_000);
    await pay(id, 10_000);

    const reservation = await getDoc(doc(db, 'reservations', id));
    expect(reservation.data()!['financialVersion']).toBe(2);
  });
});

/* ------------------------------------------------------------------------ *
 * Validation — server-side, never trusting the browser
 * ------------------------------------------------------------------------ */

describe('validation', () => {
  it('REFUSES a zero payment', async () => {
    await asOwner();
    const { id } = await makeReservation();

    expect(await refusalCode(() => pay(id, 0))).toBe('failed-precondition');
  });

  it('REFUSES a negative payment', async () => {
    await asOwner();
    const { id } = await makeReservation();

    expect(await refusalCode(() => pay(id, -50_000))).toBe('failed-precondition');
  });

  it('REFUSES a fractional baisa', async () => {
    await asOwner();
    const { id } = await makeReservation();

    expect(await refusalCode(() => pay(id, 100.5))).toBe('failed-precondition');
  });

  it('REFUSES an overpayment', async () => {
    await asOwner();
    const { id } = await makeReservation();

    expect(await refusalCode(() => pay(id, CHARGEABLE + 1))).toBe('failed-precondition');
  });

  it('REFUSES a payment once the balance is settled', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, CHARGEABLE);

    expect(await refusalCode(() => pay(id, 1))).toBe('failed-precondition');
  });

  it('REFUSES collecting more deposit than the reservation calls for', async () => {
    await asOwner();
    const { id } = await makeReservation();

    expect(await refusalCode(() => depositIn(id, DEPOSIT + 1))).toBe('failed-precondition');
  });

  it('REFUSES a payment with no request key — a retry would post twice', async () => {
    await asOwner();
    const { id } = await makeReservation();

    const code = await refusalCode(() =>
      call<Record<string, unknown>, PostResult>('recordPayment')({
        reservationId: id,
        amount: 1_000,
        method: 'Cash',
        type: 'Installment',
      }),
    );

    expect(code).toBe('invalid-argument');
  });

  it('REFUSES a request key that could not be a document id', async () => {
    await asOwner();
    const { id } = await makeReservation();

    const code = await refusalCode(() =>
      pay(id, 1_000, { idempotencyKey: '../../system/bootstrap' }),
    );

    expect(code).toBe('invalid-argument');
  });

  it('REFUSES an unknown payment method', async () => {
    await asOwner();
    const { id } = await makeReservation();

    expect(await refusalCode(() => pay(id, 1_000, { method: 'Cheque' }))).toBe('invalid-argument');
  });

  it('REFUSES a forged reservation id', async () => {
    await asOwner();

    expect(await refusalCode(() => pay('not-a-reservation', 1_000))).toBe('not-found');
  });
});

/* ------------------------------------------------------------------------ *
 * Idempotency
 * ------------------------------------------------------------------------ */

describe('idempotency', () => {
  it('posts ONE event when the same request is sent twice', async () => {
    await asOwner();
    const { id } = await makeReservation();
    const requestKey = key('idem');

    const first = await pay(id, 50_000, { idempotencyKey: requestKey });
    const second = await pay(id, 50_000, { idempotencyKey: requestKey });

    expect(first.data.duplicate).toBe(false);
    expect(second.data.duplicate).toBe(true);

    const events = await eventsFor(id);
    expect(events).toHaveLength(1);

    const position = await positionOf(id);
    expect(position.netPaid).toBe(50_000);
  });

  it('collapses a double click — eight simultaneous sends of one key', async () => {
    await asOwner();
    const { id } = await makeReservation();
    const requestKey = key('click');

    await Promise.all(
      Array.from({ length: 8 }, () => pay(id, 50_000, { idempotencyKey: requestKey })),
    );

    const events = await eventsFor(id);
    expect(events).toHaveLength(1);

    const position = await positionOf(id);
    expect(position.netPaid).toBe(50_000);
  }, 60_000);

  it('treats different keys as different payments, as it must', async () => {
    await asOwner();
    const { id } = await makeReservation();

    await pay(id, 50_000);
    await pay(id, 50_000);

    expect(await eventsFor(id)).toHaveLength(2);
  });

  it('is idempotent for refunds too', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, CHARGEABLE);
    await call<Record<string, unknown>, PostResult>('cancelReservationFinancially')({
      reservationId: id,
      reason: 'Customer cancelled',
      idempotencyKey: key('can'),
    });

    const requestKey = key('refidem');
    await refund(id, 50_000, { idempotencyKey: requestKey });
    const second = await refund(id, 50_000, { idempotencyKey: requestKey });

    expect(second.data.duplicate).toBe(true);

    const refunds = (await eventsFor(id)).filter((event) => event['kind'] === 'Refund');
    expect(refunds).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------ *
 * Concurrency — mandatory (§28)
 * ------------------------------------------------------------------------ */

describe('concurrent financial operations', () => {
  it('lets only as much through as is owed when eight payments race', async () => {
    await asOwner();
    const { id } = await makeReservation();

    // Each attempt is for the whole balance, with its own key. Exactly one can
    // legitimately succeed; the rest must find nothing outstanding.
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => pay(id, CHARGEABLE)));

    const succeeded = attempts.filter((attempt) => attempt.status === 'fulfilled');
    expect(succeeded).toHaveLength(1);

    const position = await positionOf(id);
    expect(position.netPaid).toBe(CHARGEABLE);
    expect(position.outstanding).toBe(0);
  }, 90_000);

  it('never lets simultaneous part payments exceed the balance', async () => {
    await asOwner();
    const { id } = await makeReservation();

    // Six attempts at half the balance. At most two can fit.
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => pay(id, 105_000)));

    const succeeded = attempts.filter((attempt) => attempt.status === 'fulfilled').length;
    expect(succeeded).toBe(2);

    const position = await positionOf(id);
    expect(position.netPaid).toBeLessThanOrEqual(CHARGEABLE);
    expect(position.netPaid).toBe(210_000);
  }, 90_000);

  it('lets payments on DIFFERENT reservations proceed in parallel', async () => {
    await asOwner();
    const reservations = await Promise.all(Array.from({ length: 6 }, () => makeReservation()));

    const attempts = await Promise.all(
      reservations.map((reservation) => pay(reservation.id, 100_000)),
    );

    // A lock coarse enough to serialise unrelated bookings would make a busy
    // morning unusable, so this matters as much as the contended case.
    expect(attempts.every((attempt) => attempt.data.success)).toBe(true);
  }, 90_000);

  it('never double-refunds when two refunds race', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, CHARGEABLE);
    await call<Record<string, unknown>, PostResult>('cancelReservationFinancially')({
      reservationId: id,
      reason: 'Cancelled',
      idempotencyKey: key('can'),
    });

    const refundable = (await positionOf(id)).refundable;
    expect(refundable).toBe(CHARGEABLE);

    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () => refund(id, refundable)),
    );

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);

    const position = await positionOf(id);
    expect(position.refunded).toBe(refundable);
    expect(position.refundable).toBe(0);
  }, 90_000);

  it('keeps the position consistent when a payment and a refund race', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, 100_000);
    await call<Record<string, unknown>, PostResult>('cancelReservationFinancially')({
      reservationId: id,
      reason: 'Cancelled',
      idempotencyKey: key('can'),
    });

    // After a full waiver the 100.000 already held becomes refundable, and
    // nothing further is owed — so the payment must fail and the refund succeed.
    await Promise.allSettled([refund(id, 100_000), pay(id, 100_000)]);

    const { reconcile } = await import('@/domain/ledger');
    const reservation = await getDoc(doc(db, 'reservations', id));
    const position = await positionOf(id);

    expect(reconcile(reservation.data()!['pricing'] as never, position).balanced).toBe(true);
    expect(position.netPaid).toBeGreaterThanOrEqual(0);
  }, 90_000);

  it('never lets concurrent deposit settlements return more than was held', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await depositIn(id, DEPOSIT);

    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () => settle(id, DEPOSIT, false)),
    );

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);

    const position = await positionOf(id);
    expect(position.depositRefunded + position.depositForfeited).toBe(DEPOSIT);
    expect(position.depositHeld).toBe(0);
  }, 90_000);

  it('never lets a concurrent refund and forfeiture exceed the deposit', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await depositIn(id, DEPOSIT);

    await Promise.allSettled([settle(id, DEPOSIT, false), settle(id, DEPOSIT, true)]);

    const position = await positionOf(id);
    expect(position.depositRefunded + position.depositForfeited).toBeLessThanOrEqual(DEPOSIT);
  }, 90_000);
});

/* ------------------------------------------------------------------------ *
 * Reversal
 * ------------------------------------------------------------------------ */

describe('reversing a payment', () => {
  async function paidReservation() {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, 100_000);

    const events = await getDocs(
      query(collection(db, 'financialEvents'), where('reservationId', '==', id)),
    );
    return { id, eventId: events.docs[0]!.id };
  }

  it('leaves the original event untouched and appends a reversal', async () => {
    const { id, eventId } = await paidReservation();
    const before = (await getDoc(doc(db, 'financialEvents', eventId))).data();

    await call<Record<string, unknown>, PostResult>('reversePayment')({
      reservationId: id,
      eventId,
      reason: 'Recorded against the wrong booking',
      idempotencyKey: key('rev'),
    });

    const after = (await getDoc(doc(db, 'financialEvents', eventId))).data();
    expect(after).toEqual(before);

    const events = await eventsFor(id);
    expect(events).toHaveLength(2);
  });

  it('nets the position back to nothing paid', async () => {
    const { id, eventId } = await paidReservation();

    await call<Record<string, unknown>, PostResult>('reversePayment')({
      reservationId: id,
      eventId,
      reason: 'Duplicate entry',
      idempotencyKey: key('rev'),
    });

    const position = await positionOf(id);
    expect(position.grossPaid).toBe(100_000);
    expect(position.netPaid).toBe(0);
    expect(position.outstanding).toBe(CHARGEABLE);
  });

  it('REFUSES reversing the same payment twice', async () => {
    const { id, eventId } = await paidReservation();

    await call<Record<string, unknown>, PostResult>('reversePayment')({
      reservationId: id,
      eventId,
      reason: 'First',
      idempotencyKey: key('rev'),
    });

    const code = await refusalCode(() =>
      call<Record<string, unknown>, PostResult>('reversePayment')({
        reservationId: id,
        eventId,
        reason: 'Second',
        idempotencyKey: key('rev'),
      }),
    );

    expect(code).toBe('failed-precondition');
  });

  it('REFUSES a reversal with no reason', async () => {
    const { id, eventId } = await paidReservation();

    const code = await refusalCode(() =>
      call<Record<string, unknown>, PostResult>('reversePayment')({
        reservationId: id,
        eventId,
        reason: '   ',
        idempotencyKey: key('rev'),
      }),
    );

    expect(code).toBe('failed-precondition');
  });

  it('REFUSES reversing an event that does not exist', async () => {
    await asOwner();
    const { id } = await makeReservation();

    const code = await refusalCode(() =>
      call<Record<string, unknown>, PostResult>('reversePayment')({
        reservationId: id,
        eventId: 'no-such-event',
        reason: 'x',
        idempotencyKey: key('rev'),
      }),
    );

    expect(code).toBe('not-found');
  });
});

/* ------------------------------------------------------------------------ *
 * Deposits
 * ------------------------------------------------------------------------ */

describe('settling a deposit', () => {
  it('returns the whole deposit', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await depositIn(id, DEPOSIT);

    const result = await settle(id, DEPOSIT, false);

    expect(result.data.depositHeld).toBe(0);
  });

  it('keeps part of it against damage, with a reason', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await depositIn(id, DEPOSIT);

    await settle(id, 40_000, true, 'Beading torn at the hem');

    const position = await positionOf(id);
    expect(position.depositForfeited).toBe(40_000);
    expect(position.depositHeld).toBe(60_000);
  });

  it('REFUSES a forfeiture with no reason', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await depositIn(id, DEPOSIT);

    expect(await refusalCode(() => settle(id, 10_000, true, '  '))).toBe('failed-precondition');
  });

  it('REFUSES returning more than is held', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await depositIn(id, DEPOSIT);

    expect(await refusalCode(() => settle(id, DEPOSIT + 1, false))).toBe('failed-precondition');
  });

  it('REFUSES a second settlement beyond what remains', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await depositIn(id, DEPOSIT);
    await settle(id, 70_000, false);

    expect(await refusalCode(() => settle(id, 40_000, false))).toBe('failed-precondition');
  });

  it('REFUSES settling when no deposit was collected', async () => {
    await asOwner();
    const { id } = await makeReservation();

    expect(await refusalCode(() => settle(id, 1, false))).toBe('failed-precondition');
  });
});

/* ------------------------------------------------------------------------ *
 * Late fees
 * ------------------------------------------------------------------------ */

describe('late fees', () => {
  it('charges the configured rate for each day late', async () => {
    await asOwner();
    const { id } = await makeReservation();

    const reservation = await getDoc(doc(db, 'reservations', id));
    const returnAt = reservation.data()!['returnAt'].toMillis() as number;

    const { toMuscatWallTime } = await import('@/domain/datetime');
    const threeDaysLate = toMuscatWallTime(returnAt + 3 * 24 * 60 * 60 * 1000);

    const result = await call<Record<string, unknown>, PostResult>('postLateFee')({
      reservationId: id,
      actualReturnAt: threeDaysLate,
      idempotencyKey: key('late'),
    });

    // 3 days at OMR 10.000.
    expect(result.data.outstanding).toBe(CHARGEABLE + 30_000);
  });

  it('freezes the rate and the days onto the event', async () => {
    await asOwner();
    const { id } = await makeReservation();

    const reservation = await getDoc(doc(db, 'reservations', id));
    const returnAt = reservation.data()!['returnAt'].toMillis() as number;
    const { toMuscatWallTime } = await import('@/domain/datetime');

    await call<Record<string, unknown>, PostResult>('postLateFee')({
      reservationId: id,
      actualReturnAt: toMuscatWallTime(returnAt + 2 * 24 * 60 * 60 * 1000),
      idempotencyKey: key('late'),
    });

    const events = await eventsFor(id);
    const fee = events.find((event) => event['kind'] === 'LateFee')!;

    expect(fee['snapshot']).toMatchObject({ lateDays: 2, dailyRate: 10_000, amount: 20_000 });
  });

  it('REFUSES charging twice — a gown is returned late only once', async () => {
    await asOwner();
    const { id } = await makeReservation();

    const reservation = await getDoc(doc(db, 'reservations', id));
    const returnAt = reservation.data()!['returnAt'].toMillis() as number;
    const { toMuscatWallTime } = await import('@/domain/datetime');
    const late = toMuscatWallTime(returnAt + 24 * 60 * 60 * 1000);

    await call<Record<string, unknown>, PostResult>('postLateFee')({
      reservationId: id,
      actualReturnAt: late,
      idempotencyKey: key('late'),
    });

    const code = await refusalCode(() =>
      call<Record<string, unknown>, PostResult>('postLateFee')({
        reservationId: id,
        actualReturnAt: late,
        idempotencyKey: key('late'),
      }),
    );

    expect(code).toBe('failed-precondition');
  });

  it('REFUSES a late fee when the gown came back on time', async () => {
    await asOwner();
    const { id } = await makeReservation();

    const reservation = await getDoc(doc(db, 'reservations', id));
    const returnAt = reservation.data()!['returnAt'].toMillis() as number;
    const { toMuscatWallTime } = await import('@/domain/datetime');

    const code = await refusalCode(() =>
      call<Record<string, unknown>, PostResult>('postLateFee')({
        reservationId: id,
        actualReturnAt: toMuscatWallTime(returnAt),
        idempotencyKey: key('late'),
      }),
    );

    expect(code).toBe('failed-precondition');
  });
});

/* ------------------------------------------------------------------------ *
 * Cancellation
 * ------------------------------------------------------------------------ */

describe('cancellation', () => {
  it('quotes the tier without posting anything', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, CHARGEABLE);

    const quote = await call<{ reservationId: string }, Record<string, number>>(
      'quoteCancellationFor',
    )({ reservationId: id });

    expect(quote.data['chargesBeforeCancellation']).toBe(CHARGEABLE);
    expect(await eventsFor(id)).toHaveLength(1);
  });

  it('waives the refundable share and leaves the retained charge owed', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, CHARGEABLE);

    await call<Record<string, unknown>, PostResult>('cancelReservationFinancially')({
      reservationId: id,
      reason: 'Wedding postponed',
      idempotencyKey: key('can'),
    });

    const position = await positionOf(id);

    // The event is far in the future, so the most generous tier applies.
    expect(position.totalChargeable).toBe(0);
    expect(position.refundable).toBe(CHARGEABLE);
  });

  it('does NOT pay the refund automatically', async () => {
    // Money leaving the till is a separate, deliberate act.
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, CHARGEABLE);

    await call<Record<string, unknown>, PostResult>('cancelReservationFinancially')({
      reservationId: id,
      reason: 'Cancelled',
      idempotencyKey: key('can'),
    });

    const refunds = (await eventsFor(id)).filter((event) => event['kind'] === 'Refund');
    expect(refunds).toHaveLength(0);
  });

  it('REFUSES cancelling financially twice', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, CHARGEABLE);

    await call<Record<string, unknown>, PostResult>('cancelReservationFinancially')({
      reservationId: id,
      reason: 'Once',
      idempotencyKey: key('can'),
    });

    const code = await refusalCode(() =>
      call<Record<string, unknown>, PostResult>('cancelReservationFinancially')({
        reservationId: id,
        reason: 'Twice',
        idempotencyKey: key('can'),
      }),
    );

    expect(code).toBe('failed-precondition');
  });

  it('REFUSES a refund larger than what the cancellation made refundable', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, CHARGEABLE);
    await call<Record<string, unknown>, PostResult>('cancelReservationFinancially')({
      reservationId: id,
      reason: 'Cancelled',
      idempotencyKey: key('can'),
    });

    expect(await refusalCode(() => refund(id, CHARGEABLE + 1))).toBe('failed-precondition');
  });

  it('REFUSES a refund on a reservation that was never cancelled or overpaid', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, 100_000);

    expect(await refusalCode(() => refund(id, 50_000))).toBe('failed-precondition');
  });
});

/* ------------------------------------------------------------------------ *
 * Authorization
 * ------------------------------------------------------------------------ */

describe('authorization', () => {
  it('DENIES an unauthenticated caller', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await signOut(auth);

    expect(await refusalCode(() => pay(id, 1_000))).toBe('unauthenticated');
    await asOwner();
  });

  it('ALLOWS staff to record a payment — that is the job', async () => {
    await asOwner();
    const { id } = await makeReservation();

    await asStaff();
    const result = await pay(id, 50_000);

    expect(result.data.success).toBe(true);
    await asOwner();
  });

  it('ALLOWS staff to collect a security deposit', async () => {
    await asOwner();
    const { id } = await makeReservation();

    await asStaff();
    const result = await depositIn(id, DEPOSIT);

    expect(result.data.depositHeld).toBe(DEPOSIT);
    await asOwner();
  });

  it('DENIES staff paying a refund', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, CHARGEABLE);
    await call<Record<string, unknown>, PostResult>('cancelReservationFinancially')({
      reservationId: id,
      reason: 'Cancelled',
      idempotencyKey: key('can'),
    });

    await asStaff();
    expect(await refusalCode(() => refund(id, 1_000))).toBe('permission-denied');
    await asOwner();
  });

  it('DENIES staff reversing a payment', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, 50_000);
    const events = await getDocs(
      query(collection(db, 'financialEvents'), where('reservationId', '==', id)),
    );

    await asStaff();
    const code = await refusalCode(() =>
      call<Record<string, unknown>, PostResult>('reversePayment')({
        reservationId: id,
        eventId: events.docs[0]!.id,
        reason: 'x',
        idempotencyKey: key('rev'),
      }),
    );

    expect(code).toBe('permission-denied');
    await asOwner();
  });

  it('DENIES staff forfeiting a deposit', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await depositIn(id, DEPOSIT);

    await asStaff();
    expect(await refusalCode(() => settle(id, 10_000, true, 'Damage'))).toBe('permission-denied');
    await asOwner();
  });

  it('DENIES writing a financial event directly from a client', async () => {
    // The ledger is the record. A client able to write it could invent a
    // payment and show a reservation as settled.
    await asOwner();

    await expect(
      setDoc(doc(db, 'financialEvents', 'forged'), {
        reservationId: 'anything',
        kind: 'Payment',
        amount: 999_000,
      }),
    ).rejects.toThrow();
  });

  it('DENIES editing a posted financial event, even for the owner', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, 50_000);

    const events = await getDocs(
      query(collection(db, 'financialEvents'), where('reservationId', '==', id)),
    );
    const { updateDoc } = await import('firebase/firestore');

    await expect(
      updateDoc(doc(db, 'financialEvents', events.docs[0]!.id), { amount: 1 }),
    ).rejects.toThrow();
  });

  it('DENIES deleting a posted financial event, even for the owner', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, 50_000);

    const events = await getDocs(
      query(collection(db, 'financialEvents'), where('reservationId', '==', id)),
    );
    const { deleteDoc } = await import('firebase/firestore');

    await expect(deleteDoc(doc(db, 'financialEvents', events.docs[0]!.id))).rejects.toThrow();
  });

  it('DENIES staff changing the VAT rate', async () => {
    await asStaff();

    await expect(setDoc(doc(db, 'settings', 'app'), { vatRatePercent: 0 })).rejects.toThrow();
    await asOwner();
  });

  it('DENIES even the OWNER storing a VAT rate outside the permitted set', async () => {
    await asOwner();

    await expect(setDoc(doc(db, 'settings', 'app'), { vatRatePercent: 15 })).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------------ *
 * Reconciliation
 * ------------------------------------------------------------------------ */

describe('reconciliation', () => {
  it('balances through a full rental with a late fee and a deposit return', async () => {
    await asOwner();
    const { id } = await makeReservation();

    await depositIn(id, DEPOSIT);
    await pay(id, 100_000);
    await pay(id, 110_000);

    const reservation = await getDoc(doc(db, 'reservations', id));
    const returnAt = reservation.data()!['returnAt'].toMillis() as number;
    const { toMuscatWallTime } = await import('@/domain/datetime');

    await call<Record<string, unknown>, PostResult>('postLateFee')({
      reservationId: id,
      actualReturnAt: toMuscatWallTime(returnAt + 24 * 60 * 60 * 1000),
      idempotencyKey: key('late'),
    });

    await pay(id, 10_000);
    await settle(id, DEPOSIT, false);

    const { reconcile } = await import('@/domain/ledger');
    const position = await positionOf(id);
    const result = reconcile(reservation.data()!['pricing'] as never, position);

    expect(result.problems).toEqual([]);
    expect(position.outstanding).toBe(0);
    expect(position.depositHeld).toBe(0);
    expect(position.netPaid).toBe(CHARGEABLE + 10_000);
  }, 60_000);

  it('balances through a cancellation with a refund and a deposit return', async () => {
    await asOwner();
    const { id } = await makeReservation();

    await depositIn(id, DEPOSIT);
    await pay(id, CHARGEABLE);

    await call<Record<string, unknown>, PostResult>('cancelReservationFinancially')({
      reservationId: id,
      reason: 'Wedding cancelled',
      idempotencyKey: key('can'),
    });

    const refundable = (await positionOf(id)).refundable;
    await refund(id, refundable);
    await settle(id, DEPOSIT, false);

    const { reconcile } = await import('@/domain/ledger');
    const reservation = await getDoc(doc(db, 'reservations', id));
    const position = await positionOf(id);

    expect(reconcile(reservation.data()!['pricing'] as never, position).problems).toEqual([]);
    expect(position.netPaid).toBe(0);
    expect(position.depositHeld).toBe(0);
    expect(position.status).toBe('Refunded');
  }, 60_000);
});
