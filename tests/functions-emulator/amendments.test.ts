/**
 * Amendments, against the Firebase Emulator Suite.
 *
 * The domain tests prove `reprice` produces the right numbers. These prove the
 * deployed Function does the things a pure function cannot be asked about:
 *
 *  - it reprices through the **one** engine, so the stored snapshot is exactly
 *    what `computePricing` would produce;
 *  - it keeps the reservation's own VAT rate when the setting has since changed;
 *  - a duplicate request adds one line, not two;
 *  - concurrent amendments both land rather than overwriting each other;
 *  - an issued invoice locks the charges, and voiding it unlocks them;
 *  - the balance the ledger reports moves by exactly the amendment.
 *
 * Run with:  npm run test:functions:amendments
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
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  setDoc,
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
import { computePricing } from '@/domain/reservation-pricing';

const PROJECT_ID = 'demo-azhary-functions';
const REGION = 'europe-west1';
const SETUP_TOKEN = 'emulator-setup-token';

const OWNER = { email: 'amend-owner@azhary.test', password: 'a-very-long-password' };
const STAFF = { email: 'amend-staff@azhary.test', password: 'another-long-password' };

let app: FirebaseApp;
let auth: Auth;
let db: Firestore;
let functions: Functions;
let storage: FirebaseStorage;

let ownerUid = '';
let customerId = '';

const YEAR = new Date().getUTCFullYear() + 1;
const SEP = (day: number, time = '10:00') => `${YEAR}-09-${String(day).padStart(2, '0')}T${time}`;

const RENTAL = 200_000;
const DEPOSIT = 100_000;
const VAT_PERCENT = 5;

const VEIL = { unitPrice: 20_000, securityDeposit: 5_000, quantity: 1 };

beforeAll(async () => {
  app = initializeApp(
    { projectId: PROJECT_ID, apiKey: 'emulator-key', appId: 'emulator-app' },
    'amendments',
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
  )({ setupToken: SETUP_TOKEN, name: 'Amend Owner' });
  await auth.currentUser?.getIdToken(true);
  ownerUid = auth.currentUser?.uid ?? '';

  await setDoc(doc(db, 'settings', 'app'), {
    vatRatePercent: VAT_PERCENT,
    lateFeePerDay: 10_000,
    minPickupPaymentPercent: 100,
  });

  await setDoc(doc(db, 'businessProfile', 'main'), {
    nameEn: 'Azhary Boutique',
    nameAr: 'أزهاري بوتيك',
    addressEn: 'Al Khuwair, Muscat',
    addressAr: 'الخوير، مسقط',
    phone: '91000000',
    email: 'hello@azhary.test',
    website: '',
    vatNumber: '',
    crNumber: '',
    logoPath: '',
  });

  const employee = await httpsCallable<
    { email: string; name: string; role: string },
    { uid: string; passwordResetLink: string }
  >(
    functions,
    'createEmployee',
  )({ email: STAFF.email, name: 'Amend Staff', role: 'STAFF' });

  const oobCode = new URL(employee.data.passwordResetLink).searchParams.get('oobCode');
  if (oobCode === null) throw new Error('No reset code was issued for the staff account.');

  await confirmPasswordReset(auth, oobCode, STAFF.password);
  await signInWithEmailAndPassword(auth, OWNER.email, OWNER.password);
  await auth.currentUser?.getIdToken(true);

  const { createCustomer } = await import('@/services/customers.service');
  const { EMPTY_CUSTOMER_FORM } = await import('@/schemas/customer');

  const customer = await createCustomer({
    values: {
      ...EMPTY_CUSTOMER_FORM,
      nameEn: 'Bride One',
      nameAr: 'العروس الأولى',
      phone: '91000004',
      preferredLanguage: 'ar',
    },
    actor: { uid: ownerUid, name: 'Amend Owner', role: 'OWNER' },
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

const call = <Request, Response>(name: string) => httpsCallable<Request, Response>(functions, name);

let dayCursor = 1;

async function makeReservation(): Promise<{ id: string; code: string; dressId: string }> {
  const { createDress } = await import('@/services/dresses.service');
  const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');

  const dress = await createDress({
    values: {
      ...EMPTY_DRESS_FORM,
      name: `Amend ${dayCursor}`,
      designer: 'Elie Saab',
      rentalPrice: RENTAL,
      securityDeposit: DEPOSIT,
      cleaningBufferDays: 0,
    },
    actor: { uid: ownerUid, name: 'Amend Owner', role: 'OWNER' },
    canSetPurchaseCost: false,
  });

  const day = Math.min(28, dayCursor);
  dayCursor += 1;

  const result = await call<
    Record<string, unknown>,
    { success: boolean; reservationId: string; reservationNumber: string }
  >('createReservation')({
    customerId,
    pickupAt: SEP(day),
    returnAt: SEP(day, '18:00'),
    eventDate: `${YEAR}-09-${String(Math.min(29, day + 1)).padStart(2, '0')}`,
    dressIds: [dress.id],
  });

  if (!result.data.success) throw new Error('reservation setup failed');

  return {
    id: result.data.reservationId,
    code: result.data.reservationNumber,
    dressId: dress.id,
  };
}

interface AmendResult {
  readonly success: boolean;
  readonly duplicate?: boolean;
  readonly grandTotal: number;
}

const addAccessory = (input: Record<string, unknown>) =>
  call<Record<string, unknown>, AmendResult>('addReservationAccessory')(input);

const addAlteration = (input: Record<string, unknown>) =>
  call<Record<string, unknown>, AmendResult>('addReservationAlteration')(input);

async function readPricing(reservationId: string): Promise<Record<string, unknown>> {
  const snapshot = await getDoc(doc(db, 'reservations', reservationId));
  return (snapshot.data()?.['pricing'] ?? {}) as Record<string, unknown>;
}

/* ------------------------------------------------------------------------ *
 * Adding an accessory
 * ------------------------------------------------------------------------ */

describe('adding an accessory', () => {
  it('stores exactly what the one pricing engine produces', async () => {
    /*
     * The whole point of Phase 7's amendment design. If the Function ever
     * computed its own totals, the invoice and the screen would eventually
     * disagree and the one on paper is the one the customer keeps.
     */
    await asOwner();
    const reservation = await makeReservation();

    await addAccessory({
      reservationId: reservation.id,
      accessoryId: 'cat-veil',
      name: 'Cathedral veil',
      nameAr: 'طرحة',
      ...VEIL,
      idempotencyKey: key('acc'),
    });

    const stored = await readPricing(reservation.id);

    const expected = computePricing({
      items: [
        {
          dressId: reservation.dressId,
          dressCode: '',
          dressName: '',
          designer: 'Elie Saab',
          rentalPrice: RENTAL as never,
          securityDeposit: DEPOSIT as never,
          cleaningBufferDays: 0,
        },
      ],
      accessories: [
        {
          accessoryId: 'cat-veil',
          name: 'Cathedral veil',
          unitPrice: VEIL.unitPrice as never,
          quantity: VEIL.quantity,
          securityDeposit: VEIL.securityDeposit as never,
        },
      ],
      alterations: [],
      discount: { kind: 'amount', value: 0 },
      vatRatePercent: VAT_PERCENT,
    });

    expect(stored['accessorySubtotal']).toBe(expected.accessorySubtotal);
    expect(stored['taxableSubtotal']).toBe(expected.taxableSubtotal);
    expect(stored['vatAmount']).toBe(expected.vatAmount);
    expect(stored['securityDepositTotal']).toBe(expected.securityDepositTotal);
    expect(stored['grandTotal']).toBe(expected.grandTotal);
  }, 60_000);

  it('keeps the catalogue id AND gives the line its own id', async () => {
    // The line id is the request key, so a retry converges; the catalogue id
    // survives so reporting can still attribute the revenue.
    await asOwner();
    const reservation = await makeReservation();
    const requestKey = key('acc');

    await addAccessory({
      reservationId: reservation.id,
      accessoryId: 'cat-tiara',
      name: 'Tiara',
      nameAr: '',
      ...VEIL,
      idempotencyKey: requestKey,
    });

    const stored = await readPricing(reservation.id);
    const lines = stored['accessories'] as Record<string, unknown>[];

    expect(lines).toHaveLength(1);
    expect(lines[0]?.['lineId']).toBe(requestKey);
    expect(lines[0]?.['accessoryId']).toBe('cat-tiara');
  }, 60_000);

  it('adds ONE line when the same request is sent twice', async () => {
    await asOwner();
    const reservation = await makeReservation();
    const requestKey = key('dup');

    const request = {
      reservationId: reservation.id,
      accessoryId: 'cat-veil',
      name: 'Veil',
      nameAr: '',
      ...VEIL,
      idempotencyKey: requestKey,
    };

    const first = await addAccessory(request);
    const second = await addAccessory(request);

    expect(first.data.duplicate).toBe(false);
    expect(second.data.duplicate).toBe(true);
    expect(second.data.grandTotal).toBe(first.data.grandTotal);

    const stored = await readPricing(reservation.id);
    expect(stored['accessories']).toHaveLength(1);
  }, 60_000);

  it('lets staff amend — it is shop-floor work', async () => {
    await asOwner();
    const reservation = await makeReservation();

    await asStaff();
    const result = await addAccessory({
      reservationId: reservation.id,
      accessoryId: 'cat-veil',
      name: 'Veil',
      nameAr: '',
      ...VEIL,
      idempotencyKey: key('staff'),
    });

    expect(result.data.success).toBe(true);
  }, 60_000);

  it('refuses a fractional price', async () => {
    await asOwner();
    const reservation = await makeReservation();

    await expect(
      addAccessory({
        reservationId: reservation.id,
        accessoryId: 'cat-veil',
        name: 'Veil',
        nameAr: '',
        unitPrice: 20_000.5,
        securityDeposit: 0,
        quantity: 1,
        idempotencyKey: key('frac'),
      }),
    ).rejects.toThrow();
  }, 60_000);

  it('refuses a zero quantity', async () => {
    await asOwner();
    const reservation = await makeReservation();

    await expect(
      addAccessory({
        reservationId: reservation.id,
        accessoryId: 'cat-veil',
        name: 'Veil',
        nameAr: '',
        unitPrice: 20_000,
        securityDeposit: 0,
        quantity: 0,
        idempotencyKey: key('zero'),
      }),
    ).rejects.toThrow();
  }, 60_000);

  it('refuses an unauthenticated caller', async () => {
    await asOwner();
    const reservation = await makeReservation();

    await signOut(auth);

    await expect(
      addAccessory({
        reservationId: reservation.id,
        accessoryId: 'cat-veil',
        name: 'Veil',
        nameAr: '',
        ...VEIL,
        idempotencyKey: key('anon'),
      }),
    ).rejects.toThrow();
  }, 60_000);
});

/* ------------------------------------------------------------------------ *
 * Alterations
 * ------------------------------------------------------------------------ */

describe('recording an alteration', () => {
  it('adds the amount to the taxable base and charges VAT once', async () => {
    await asOwner();
    const reservation = await makeReservation();

    const before = await readPricing(reservation.id);

    await addAlteration({
      reservationId: reservation.id,
      description: 'Hem taken up 4cm',
      descriptionAr: '',
      amount: 15_000,
      notes: 'At the second fitting',
      idempotencyKey: key('alt'),
    });

    const after = await readPricing(reservation.id);

    expect(after['alterationSubtotal']).toBe(15_000);
    expect(Number(after['taxableSubtotal']) - Number(before['taxableSubtotal'])).toBe(15_000);
    // 5% of 15.000 OMR is 750 baisa.
    expect(Number(after['vatAmount']) - Number(before['vatAmount'])).toBe(750);
    // An alteration holds no deposit.
    expect(after['securityDepositTotal']).toBe(before['securityDepositTotal']);
  }, 60_000);

  it('records WHO did it and WHEN, and freezes both', async () => {
    await asStaff();
    await asOwner();
    const reservation = await makeReservation();

    await asStaff();
    await addAlteration({
      reservationId: reservation.id,
      description: 'Bustle added',
      descriptionAr: '',
      amount: 8_000,
      notes: '',
      idempotencyKey: key('who'),
    });

    const stored = await readPricing(reservation.id);
    const lines = stored['alterations'] as Record<string, unknown>[];

    expect(lines).toHaveLength(1);
    expect(lines[0]?.['employeeName']).toBe('Amend Staff');
    expect(lines[0]?.['createdAt']).toBeDefined();
  }, 60_000);

  it('refuses an amount of zero — a charge of nothing is not a charge', async () => {
    await asOwner();
    const reservation = await makeReservation();

    await expect(
      addAlteration({
        reservationId: reservation.id,
        description: 'Nothing',
        descriptionAr: '',
        amount: 0,
        notes: '',
        idempotencyKey: key('nil'),
      }),
    ).rejects.toThrow();
  }, 60_000);

  it('refuses a blank description', async () => {
    await asOwner();
    const reservation = await makeReservation();

    await expect(
      addAlteration({
        reservationId: reservation.id,
        description: '   ',
        descriptionAr: '',
        amount: 5_000,
        notes: '',
        idempotencyKey: key('blank'),
      }),
    ).rejects.toThrow();
  }, 60_000);

  it('removes a line and reprices back down', async () => {
    await asOwner();
    const reservation = await makeReservation();
    const lineId = key('rm');

    const before = await readPricing(reservation.id);

    await addAlteration({
      reservationId: reservation.id,
      description: 'To be removed',
      descriptionAr: '',
      amount: 12_000,
      notes: '',
      idempotencyKey: lineId,
    });

    await call<Record<string, unknown>, AmendResult>('removeReservationAlteration')({
      reservationId: reservation.id,
      lineId,
    });

    const after = await readPricing(reservation.id);

    expect(after['alterations']).toHaveLength(0);
    expect(after['grandTotal']).toBe(before['grandTotal']);
  }, 60_000);

  it('refuses to remove a line that is not there', async () => {
    await asOwner();
    const reservation = await makeReservation();

    await expect(
      call<Record<string, unknown>, AmendResult>('removeReservationAlteration')({
        reservationId: reservation.id,
        lineId: 'never-existed',
      }),
    ).rejects.toThrow();
  }, 60_000);
});

/* ------------------------------------------------------------------------ *
 * The frozen VAT rate
 * ------------------------------------------------------------------------ */

describe('the reservation’s own VAT rate', () => {
  it('is used when amending, NOT the current setting', async () => {
    /*
     * Load-bearing. A booking taken at 5% must stay at 5% even after the owner
     * changes the configured rate — the amendment adds a line to an existing
     * agreement, it does not renegotiate the tax on it.
     */
    await asOwner();
    const reservation = await makeReservation();

    await setDoc(
      doc(db, 'settings', 'app'),
      { vatRatePercent: 0, lateFeePerDay: 10_000, minPickupPaymentPercent: 100 },
      { merge: true },
    );

    try {
      await addAlteration({
        reservationId: reservation.id,
        description: 'Hem',
        descriptionAr: '',
        amount: 20_000,
        notes: '',
        idempotencyKey: key('vat'),
      });

      const stored = await readPricing(reservation.id);

      expect(stored['vatRatePercent']).toBe(VAT_PERCENT);
      // 5% of the full taxable base, not 0%.
      expect(Number(stored['vatAmount'])).toBeGreaterThan(0);
    } finally {
      await setDoc(
        doc(db, 'settings', 'app'),
        { vatRatePercent: VAT_PERCENT, lateFeePerDay: 10_000, minPickupPaymentPercent: 100 },
        { merge: true },
      );
    }
  }, 60_000);
});

/* ------------------------------------------------------------------------ *
 * Concurrency
 * ------------------------------------------------------------------------ */

describe('two employees amending at once', () => {
  it('keeps BOTH lines — neither overwrites the other', async () => {
    /*
     * Without the financialVersion lock these two transactions never conflict:
     * each reads a list without the other's line and writes a snapshot computed
     * from it, so whichever commits second silently discards the first.
     */
    await asOwner();
    const reservation = await makeReservation();

    const results = await Promise.allSettled([
      addAccessory({
        reservationId: reservation.id,
        accessoryId: 'cat-veil',
        name: 'Veil',
        nameAr: '',
        ...VEIL,
        idempotencyKey: key('race-a'),
      }),
      addAccessory({
        reservationId: reservation.id,
        accessoryId: 'cat-tiara',
        name: 'Tiara',
        nameAr: '',
        unitPrice: 30_000,
        securityDeposit: 0,
        quantity: 1,
        idempotencyKey: key('race-b'),
      }),
    ]);

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);

    const stored = await readPricing(reservation.id);

    expect(stored['accessories']).toHaveLength(2);
    // 20.000 + 30.000, both present and both counted exactly once.
    expect(stored['accessorySubtotal']).toBe(50_000);
  }, 90_000);

  it('adds one line when the SAME request is sent twice at once', async () => {
    await asOwner();
    const reservation = await makeReservation();

    const request = {
      reservationId: reservation.id,
      accessoryId: 'cat-veil',
      name: 'Veil',
      nameAr: '',
      ...VEIL,
      idempotencyKey: key('race-same'),
    };

    await Promise.allSettled([addAccessory(request), addAccessory(request)]);

    const stored = await readPricing(reservation.id);
    expect(stored['accessories']).toHaveLength(1);
  }, 90_000);
});

/* ------------------------------------------------------------------------ *
 * The invoice lock
 * ------------------------------------------------------------------------ */

describe('once an invoice has been issued', () => {
  async function issue(reservationId: string): Promise<string> {
    const result = await call<
      Record<string, unknown>,
      { success: boolean; documentId: string }
    >('issueDocument')({
      reservationId,
      documentType: 'Tax Invoice',
      language: 'bilingual',
      idempotencyKey: key('inv'),
      notes: '',
    });

    return result.data.documentId;
  }

  it('REFUSES an amendment', async () => {
    /*
     * The customer is holding a piece of paper. Changing the reservation
     * underneath it would make the paper and the system disagree — precisely
     * the discrepancy reconcileDocument exists to detect.
     */
    await asOwner();
    const reservation = await makeReservation();
    await issue(reservation.id);

    await expect(
      addAlteration({
        reservationId: reservation.id,
        description: 'Too late',
        descriptionAr: '',
        amount: 5_000,
        notes: '',
        idempotencyKey: key('locked'),
      }),
    ).rejects.toThrow();
  }, 90_000);

  it('ALLOWS it again once the invoice is voided', async () => {
    await asOwner();
    const reservation = await makeReservation();
    const documentId = await issue(reservation.id);

    await call<Record<string, unknown>, { success: boolean }>('voidDocument')({
      documentId,
      reason: 'Charges changed after issue',
    });

    const result = await addAlteration({
      reservationId: reservation.id,
      description: 'Hem, after reissue',
      descriptionAr: '',
      amount: 5_000,
      notes: '',
      idempotencyKey: key('unlocked'),
    });

    expect(result.data.success).toBe(true);
  }, 90_000);

  it('leaves the ISSUED document unchanged when the reservation is later amended', async () => {
    await asOwner();
    const reservation = await makeReservation();
    const documentId = await issue(reservation.id);

    const beforeDocument = await getDoc(doc(db, 'invoices', documentId));
    const beforeTotal = (beforeDocument.data()?.['financials'] as Record<string, unknown>)[
      'grandTotal'
    ];

    await call<Record<string, unknown>, { success: boolean }>('voidDocument')({
      documentId,
      reason: 'Reissue',
    });

    await addAlteration({
      reservationId: reservation.id,
      description: 'Added after the void',
      descriptionAr: '',
      amount: 25_000,
      notes: '',
      idempotencyKey: key('after-void'),
    });

    const afterDocument = await getDoc(doc(db, 'invoices', documentId));
    const afterTotal = (afterDocument.data()?.['financials'] as Record<string, unknown>)[
      'grandTotal'
    ];

    // A document is a copy, frozen at issue. Voiding does not rewrite it, and
    // amending the reservation cannot reach back into it.
    expect(afterTotal).toBe(beforeTotal);
  }, 90_000);
});

/* ------------------------------------------------------------------------ *
 * The lifecycle
 * ------------------------------------------------------------------------ */

describe('a finished reservation', () => {
  it('REFUSES an amendment once the gown is back', async () => {
    await asOwner();
    const reservation = await makeReservation();

    for (const status of ['Fitting Scheduled', 'Fitted', 'Picked Up', 'Returned']) {
      await call<Record<string, unknown>, { success: boolean }>('changeReservationStatus')({
        reservationId: reservation.id,
        status,
      });
    }

    await expect(
      addAlteration({
        reservationId: reservation.id,
        description: 'Too late',
        descriptionAr: '',
        amount: 5_000,
        notes: '',
        idempotencyKey: key('returned'),
      }),
    ).rejects.toThrow();
  }, 90_000);

  it('ALLOWS one while the gown is still out with the customer', async () => {
    // A hem taken up at the last fitting is billed after the dress has left.
    await asOwner();
    const reservation = await makeReservation();

    for (const status of ['Fitting Scheduled', 'Fitted', 'Picked Up']) {
      await call<Record<string, unknown>, { success: boolean }>('changeReservationStatus')({
        reservationId: reservation.id,
        status,
      });
    }

    const result = await addAlteration({
      reservationId: reservation.id,
      description: 'Emergency hem',
      descriptionAr: '',
      amount: 5_000,
      notes: '',
      idempotencyKey: key('out'),
    });

    expect(result.data.success).toBe(true);
  }, 90_000);
});

/* ------------------------------------------------------------------------ *
 * The balance
 * ------------------------------------------------------------------------ */

describe('what the amendment does to the balance', () => {
  it('increases the outstanding balance by exactly the charge plus its VAT', async () => {
    await asOwner();
    const reservation = await makeReservation();

    const { observeFinancialEvents, positionOf } = await import('@/services/payments.service');

    const before = await readPricing(reservation.id);

    await addAlteration({
      reservationId: reservation.id,
      description: 'Hem',
      descriptionAr: '',
      amount: 40_000,
      notes: '',
      idempotencyKey: key('balance'),
    });

    const after = await readPricing(reservation.id);

    // 40.000 plus 5% VAT = 42.000, on the chargeable side only.
    const chargeBefore = Number(before['taxableSubtotal']) + Number(before['vatAmount']);
    const chargeAfter = Number(after['taxableSubtotal']) + Number(after['vatAmount']);

    expect(chargeAfter - chargeBefore).toBe(42_000);

    // And the ledger agrees, reading the stored snapshot through reduceLedger.
    const events = await new Promise<Parameters<Parameters<typeof observeFinancialEvents>[1]>[0]>(
      (resolve, reject) => {
        const stop = observeFinancialEvents(
          reservation.id,
          (next) => {
            stop();
            resolve(next);
          },
          (error) => {
            stop();
            reject(error);
          },
        );
      },
    );

    const position = positionOf(
      {
        rentalSubtotal: Number(after['rentalSubtotal']) as never,
        accessorySubtotal: Number(after['accessorySubtotal']) as never,
        alterationSubtotal: Number(after['alterationSubtotal']) as never,
        discountAmount: Number(after['discountAmount']) as never,
        taxableSubtotal: Number(after['taxableSubtotal']) as never,
        vatRatePercent: Number(after['vatRatePercent']),
        vatAmount: Number(after['vatAmount']) as never,
        securityDepositTotal: Number(after['securityDepositTotal']) as never,
        grandTotal: Number(after['grandTotal']) as never,
      },
      events,
    );

    expect(position.outstanding).toBe(chargeAfter);
  }, 90_000);
});
