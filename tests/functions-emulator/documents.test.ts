/**
 * Documents, against the Firebase Emulator Suite.
 *
 * The component tests prove a document renders. These prove the deployed
 * Function issues one correctly: a unique number under contention, a snapshot
 * that survives every later change to its sources, and figures that match the
 * financial engine exactly.
 *
 * Run with:  npm run test:functions:documents
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
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  setDoc,
  updateDoc,
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

const OWNER = { email: 'doc-owner@azhary.test', password: 'a-very-long-password' };
const STAFF = { email: 'doc-staff@azhary.test', password: 'another-long-password' };

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
const CHARGEABLE = 210_000;

/** The year the Function will stamp on a number issued now, in Muscat. */
const ISSUE_YEAR = Number(new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().slice(0, 4));

beforeAll(async () => {
  app = initializeApp(
    { projectId: PROJECT_ID, apiKey: 'emulator-key', appId: 'emulator-app' },
    'documents',
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
  )({ setupToken: SETUP_TOKEN, name: 'Document Owner' });
  await auth.currentUser?.getIdToken(true);
  ownerUid = auth.currentUser?.uid ?? '';

  await setDoc(doc(db, 'settings', 'app'), {
    vatRatePercent: 5,
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
    // Deliberately unconfigured — the document must omit them, not invent them.
    vatNumber: '',
    crNumber: '',
    logoPath: 'business/logo/original.png',
  });

  const employee = await httpsCallable<
    { email: string; name: string; role: string },
    { uid: string; passwordResetLink: string }
  >(
    functions,
    'createEmployee',
  )({ email: STAFF.email, name: 'Document Staff', role: 'STAFF' });

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
      phone: '91000003',
      preferredLanguage: 'ar',
    },
    actor: { uid: ownerUid, name: 'Document Owner', role: 'OWNER' },
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
async function makeReservation(): Promise<{ id: string; code: string }> {
  const { createDress } = await import('@/services/dresses.service');
  const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');

  const dress = await createDress({
    values: {
      ...EMPTY_DRESS_FORM,
      name: `Document ${dayCursor}`,
      designer: 'Elie Saab',
      rentalPrice: RENTAL,
      securityDeposit: DEPOSIT,
      cleaningBufferDays: 0,
    },
    actor: { uid: ownerUid, name: 'Document Owner', role: 'OWNER' },
    canSetPurchaseCost: false,
  });

  const day = Math.min(28, dayCursor);
  dayCursor += 1;

  const result = await call<
    Record<string, unknown>,
    {
      success: boolean;
      reservationId: string;
      reservationNumber: string;
    }
  >('createReservation')({
    customerId,
    pickupAt: SEP(day),
    returnAt: SEP(day, '18:00'),
    // The event is the day after collection, whatever day this reservation
    // lands on — a fixed date would fall before pickup once the cursor passes
    // it, and the engine rightly refuses that.
    eventDate: `${YEAR}-09-${String(Math.min(29, day + 1)).padStart(2, '0')}`,
    dressIds: [dress.id],
  });

  if (!result.data.success) throw new Error('reservation setup failed');
  return { id: result.data.reservationId, code: result.data.reservationNumber };
}

interface IssueResult {
  success: boolean;
  documentId: string;
  documentNumber: string;
  duplicate: boolean;
}

function issue(
  reservationId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ data: IssueResult }> {
  return call<Record<string, unknown>, IssueResult>('issueDocument')({
    reservationId,
    documentType: 'Tax Invoice',
    language: 'bilingual',
    notes: '',
    idempotencyKey: key('doc'),
    ...overrides,
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

function pay(reservationId: string, amount: number) {
  return call<Record<string, unknown>, { success: boolean }>('recordPayment')({
    reservationId,
    amount,
    method: 'Cash',
    type: 'Installment',
    reference: '',
    idempotencyKey: key('pay'),
  });
}

/* ------------------------------------------------------------------------ *
 * Issuing
 * ------------------------------------------------------------------------ */

describe('issuing a document', () => {
  it('numbers it INV-YYYY-NNNN and marks it Issued', async () => {
    await asOwner();
    const { id } = await makeReservation();

    const result = await issue(id);

    expect(result.data.success).toBe(true);
    expect(result.data.documentNumber).toMatch(new RegExp(`^INV-${ISSUE_YEAR}-\\d{4,}$`));

    const document = await getDoc(doc(db, 'invoices', result.data.documentId));
    expect(document.data()).toMatchObject({ status: 'Issued', voided: false });
  });

  it('increments the number for each document', async () => {
    await asOwner();
    const first = await issue((await makeReservation()).id);
    const second = await issue((await makeReservation()).id);

    const sequenceOf = (code: string) => Number(code.split('-')[2]);
    expect(sequenceOf(second.data.documentNumber)).toBe(sequenceOf(first.data.documentNumber) + 1);
  });

  it('records an audit entry naming the employee', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await issue(id);

    const audits = await getDocs(
      query(
        collection(db, 'auditLogs'),
        where('entityId', '==', id),
        where('action', '==', 'document.issued'),
      ),
    );

    expect(audits.size).toBe(1);
    expect(audits.docs[0]!.data()['actorUid']).toBe(ownerUid);
  });

  it('captures the customer, the dresses and the business', async () => {
    await asOwner();
    const { id, code } = await makeReservation();
    const result = await issue(id);

    const document = (await getDoc(doc(db, 'invoices', result.data.documentId))).data()!;

    expect(document['reservationCode']).toBe(code);
    expect(document['customer']).toMatchObject({ nameEn: 'Bride One', nameAr: 'العروس الأولى' });
    expect(document['business']).toMatchObject({ nameEn: 'Azhary Boutique' });
    expect(document['dresses'] as unknown[]).toHaveLength(1);
    expect((document['dresses'] as Record<string, unknown>[])[0]).toMatchObject({
      designer: 'Elie Saab',
      rentalPrice: RENTAL,
    });
  });

  it('captures an unconfigured VAT number as blank, never as a placeholder', async () => {
    await asOwner();
    const result = await issue((await makeReservation()).id);

    const business = (await getDoc(doc(db, 'invoices', result.data.documentId))).data()![
      'business'
    ] as Record<string, unknown>;

    expect(business['vatNumber']).toBe('');
    expect(business['crNumber']).toBe('');
  });

  it('issues a rental agreement and a receipt as distinct documents', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, 100_000);

    const events = await getDocs(
      query(collection(db, 'financialEvents'), where('reservationId', '==', id)),
    );

    const agreement = await issue(id, { documentType: 'Rental Agreement' });
    const receipt = await issue(id, {
      documentType: 'Payment Receipt',
      forEventId: events.docs[0]!.id,
    });

    const agreementDoc = (await getDoc(doc(db, 'invoices', agreement.data.documentId))).data()!;
    const receiptDoc = (await getDoc(doc(db, 'invoices', receipt.data.documentId))).data()!;

    expect(agreementDoc['documentType']).toBe('Rental Agreement');
    expect(receiptDoc['documentType']).toBe('Payment Receipt');
    expect(receiptDoc['receiptFor']).toMatchObject({ amount: 100_000, kind: 'Payment' });
  });

  it('REFUSES a receipt that does not name a payment', async () => {
    await asOwner();
    const { id } = await makeReservation();

    expect(await refusalCode(() => issue(id, { documentType: 'Payment Receipt' }))).toBe(
      'invalid-argument',
    );
  });

  it('REFUSES a receipt naming a payment from another reservation', async () => {
    await asOwner();
    const other = await makeReservation();
    await pay(other.id, 50_000);
    const otherEvents = await getDocs(
      query(collection(db, 'financialEvents'), where('reservationId', '==', other.id)),
    );

    const { id } = await makeReservation();

    const code = await refusalCode(() =>
      issue(id, { documentType: 'Payment Receipt', forEventId: otherEvents.docs[0]!.id }),
    );
    expect(code).toBe('not-found');
  });

  it('REFUSES an unknown document type or language', async () => {
    await asOwner();
    const { id } = await makeReservation();

    expect(await refusalCode(() => issue(id, { documentType: 'Quote' }))).toBe('invalid-argument');
    expect(await refusalCode(() => issue(id, { language: 'fr' }))).toBe('invalid-argument');
  });

  it('REFUSES a forged reservation id', async () => {
    await asOwner();
    expect(await refusalCode(() => issue('not-a-reservation'))).toBe('not-found');
  });

  it('REFUSES a request with no key', async () => {
    await asOwner();
    const { id } = await makeReservation();

    const code = await refusalCode(() =>
      call<Record<string, unknown>, IssueResult>('issueDocument')({
        reservationId: id,
        documentType: 'Tax Invoice',
        language: 'en',
      }),
    );

    expect(code).toBe('invalid-argument');
  });

  it('REFUSES a key that could not be a document id', async () => {
    await asOwner();
    const { id } = await makeReservation();

    expect(await refusalCode(() => issue(id, { idempotencyKey: '../../system/bootstrap' }))).toBe(
      'invalid-argument',
    );
  });
});

/* ------------------------------------------------------------------------ *
 * §36 — the document never disagrees with the engine
 * ------------------------------------------------------------------------ */

describe('financial reconciliation', () => {
  it('matches reduceLedger exactly, figure for figure', async () => {
    await asOwner();
    const { id } = await makeReservation();

    await call<Record<string, unknown>, { success: boolean }>('recordSecurityDeposit')({
      reservationId: id,
      amount: DEPOSIT,
      method: 'Cash',
      reference: '',
      idempotencyKey: key('dep'),
    });
    await pay(id, 150_000);

    const result = await issue(id);
    const document = (await getDoc(doc(db, 'invoices', result.data.documentId))).data()!;

    // Recompute independently from the authoritative sources and compare.
    const { reduceLedger } = await import('@/domain/ledger');
    const { reconcileDocument } = await import('@/domain/document');

    const reservation = (await getDoc(doc(db, 'reservations', id))).data()!;
    const events = (
      await getDocs(query(collection(db, 'financialEvents'), where('reservationId', '==', id)))
    ).docs.map((snapshot) => {
      const data = snapshot.data();
      return {
        id: snapshot.id,
        reservationId: id,
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
      };
    }) as never;

    const pricing = reservation['pricing'] as never;
    const position = reduceLedger(pricing, events);

    const problems = reconcileDocument(document['financials'] as never, pricing, position);

    expect(problems).toEqual([]);
  });

  it('keeps the security deposit out of the taxable total on the document', async () => {
    await asOwner();
    const result = await issue((await makeReservation()).id);

    const financials = (await getDoc(doc(db, 'invoices', result.data.documentId))).data()![
      'financials'
    ] as Record<string, number>;

    expect(financials['taxableSubtotal']).toBe(RENTAL);
    expect(financials['vatAmount']).toBe(10_000);
    expect(financials['securityDepositTotal']).toBe(DEPOSIT);
    expect(financials['grandTotal']).toBe(RENTAL + 10_000 + DEPOSIT);
  });

  it('records the balance the ledger reports, not a recomputed one', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, 60_000);

    const result = await issue(id);
    const financials = (await getDoc(doc(db, 'invoices', result.data.documentId))).data()![
      'financials'
    ] as Record<string, number>;

    expect(financials['totalPaid']).toBe(60_000);
    expect(financials['outstanding']).toBe(CHARGEABLE - 60_000);
    expect(financials['financialStatus']).toBe('Partially Paid');
  });
});

/* ------------------------------------------------------------------------ *
 * Immutability — §24
 * ------------------------------------------------------------------------ */

describe('an issued document is a snapshot', () => {
  it('survives every later change to its sources', async () => {
    await asOwner();
    const { id } = await makeReservation();

    const result = await issue(id);
    const before = (await getDoc(doc(db, 'invoices', result.data.documentId))).data()!;

    // Change everything the document was built from.
    await setDoc(
      doc(db, 'businessProfile', 'main'),
      {
        nameEn: 'A Completely Different Boutique',
        addressEn: 'Somewhere else',
        vatNumber: 'OM-NEW-REGISTRATION',
        logoPath: 'business/logo/replaced.png',
      },
      { merge: true },
    );

    await setDoc(doc(db, 'settings', 'app'), { vatRatePercent: 0 }, { merge: true });

    const { updateCustomer, observeCustomer } = await import('@/services/customers.service');
    const { EMPTY_CUSTOMER_FORM } = await import('@/schemas/customer');

    const existing = await new Promise<never>((resolve, reject) => {
      const stop = observeCustomer(
        customerId,
        (value) => {
          if (value !== null) {
            stop();
            resolve(value as never);
          }
        },
        (error) => {
          stop();
          reject(error);
        },
      );
    });

    await updateCustomer({
      customerId,
      before: existing,
      values: { ...EMPTY_CUSTOMER_FORM, nameEn: 'Renamed Entirely', phone: '91000003' },
      actor: { uid: ownerUid, name: 'Document Owner', role: 'OWNER' },
    });

    const after = (await getDoc(doc(db, 'invoices', result.data.documentId))).data()!;

    expect(after['business']).toEqual(before['business']);
    expect(after['customer']).toEqual(before['customer']);
    expect(after['financials']).toEqual(before['financials']);

    // And specifically: the invented registration did not appear.
    expect((after['business'] as Record<string, unknown>)['vatNumber']).toBe('');
    expect((after['business'] as Record<string, unknown>)['nameEn']).toBe('Azhary Boutique');
    expect((after['business'] as Record<string, unknown>)['logoPath']).toBe(
      'business/logo/original.png',
    );
  }, 60_000);

  it('keeps its figures when a later payment is recorded', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await pay(id, 50_000);

    const result = await issue(id);
    const before = (await getDoc(doc(db, 'invoices', result.data.documentId))).data()!;

    await pay(id, 50_000);

    const after = (await getDoc(doc(db, 'invoices', result.data.documentId))).data()!;

    expect(after['financials']).toEqual(before['financials']);
    expect((after['financials'] as Record<string, number>)['totalPaid']).toBe(50_000);
  });

  it('DENIES a client editing an issued document', async () => {
    await asOwner();
    const result = await issue((await makeReservation()).id);

    await expect(
      updateDoc(doc(db, 'invoices', result.data.documentId), { documentNumber: 'INV-2026-9999' }),
    ).rejects.toThrow();
  });

  it('DENIES a client deleting an issued document, even the owner', async () => {
    await asOwner();
    const result = await issue((await makeReservation()).id);

    await expect(deleteDoc(doc(db, 'invoices', result.data.documentId))).rejects.toThrow();
  });

  it('DENIES a client creating an invoice directly', async () => {
    await asOwner();

    await expect(
      setDoc(doc(db, 'invoices', 'forged'), {
        documentNumber: 'INV-2026-0001',
        status: 'Issued',
      }),
    ).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------------ *
 * Terms snapshots — §20
 * ------------------------------------------------------------------------ */

describe('terms are frozen onto the document', () => {
  it('copies the text, so a later version cannot change what was signed', async () => {
    await asOwner();

    await setDoc(doc(db, 'termsVersions', 'terms-v1'), {
      label: 'Version 1',
      sections: [
        {
          key: 'damageAndLoss',
          titleEn: 'Damage and loss',
          titleAr: 'التلف والفقد',
          bodyEn: 'Original wording, version one.',
          bodyAr: 'الصيغة الأصلية، النسخة الأولى.',
        },
      ],
      createdAtMillis: Date.now(),
    });

    await setDoc(doc(db, 'settings', 'app'), { activeTermsVersionId: 'terms-v1' }, { merge: true });

    const result = await issue((await makeReservation()).id);
    const document = (await getDoc(doc(db, 'invoices', result.data.documentId))).data()!;
    const terms = document['terms'] as Record<string, unknown>;

    expect(terms['versionId']).toBe('terms-v1');
    expect((terms['sections'] as Record<string, unknown>[])[0]!['bodyEn']).toMatch(
      /Original wording/,
    );

    // Publish a new version and make it active.
    await setDoc(doc(db, 'termsVersions', 'terms-v2'), {
      label: 'Version 2',
      sections: [
        {
          key: 'damageAndLoss',
          titleEn: 'Damage and loss',
          titleAr: 'التلف والفقد',
          bodyEn: 'Rewritten wording, version two.',
          bodyAr: 'صيغة معدلة، النسخة الثانية.',
        },
      ],
      createdAtMillis: Date.now(),
    });
    await setDoc(doc(db, 'settings', 'app'), { activeTermsVersionId: 'terms-v2' }, { merge: true });

    const unchanged = (await getDoc(doc(db, 'invoices', result.data.documentId))).data()!;
    const unchangedTerms = unchanged['terms'] as Record<string, unknown>;

    expect((unchangedTerms['sections'] as Record<string, unknown>[])[0]!['bodyEn']).toMatch(
      /Original wording/,
    );
  }, 60_000);

  it('DENIES editing a published terms version', async () => {
    await asOwner();

    await expect(
      updateDoc(doc(db, 'termsVersions', 'terms-v1'), { label: 'Edited' }),
    ).rejects.toThrow();
  });

  it('DENIES staff publishing a terms version', async () => {
    await asStaff();

    await expect(
      setDoc(doc(db, 'termsVersions', 'staff-terms'), { label: 'Staff', sections: [] }),
    ).rejects.toThrow();

    await asOwner();
  });
});

/* ------------------------------------------------------------------------ *
 * Concurrency and idempotency — §37
 * ------------------------------------------------------------------------ */

describe('concurrent issuing', () => {
  it('gives eight simultaneous issues eight UNIQUE numbers', async () => {
    await asOwner();
    const reservations = await Promise.all(Array.from({ length: 8 }, () => makeReservation()));

    const results = await Promise.all(reservations.map((reservation) => issue(reservation.id)));

    const numbers = results.map((result) => result.data.documentNumber);

    expect(new Set(numbers).size).toBe(8);
    for (const number of numbers) {
      expect(number).toMatch(new RegExp(`^INV-${ISSUE_YEAR}-\\d{4,}$`));
    }
  }, 120_000);

  it('never issues two documents for one request key', async () => {
    await asOwner();
    const { id } = await makeReservation();
    const requestKey = key('idem');

    const first = await issue(id, { idempotencyKey: requestKey });
    const second = await issue(id, { idempotencyKey: requestKey });

    expect(first.data.duplicate).toBe(false);
    expect(second.data.duplicate).toBe(true);
    expect(second.data.documentNumber).toBe(first.data.documentNumber);

    const documents = await getDocs(
      query(collection(db, 'invoices'), where('reservationId', '==', id)),
    );
    expect(documents.size).toBe(1);
  });

  it('collapses a double click — eight simultaneous sends of one key', async () => {
    await asOwner();
    const { id } = await makeReservation();
    const requestKey = key('click');

    await Promise.all(Array.from({ length: 8 }, () => issue(id, { idempotencyKey: requestKey })));

    const documents = await getDocs(
      query(collection(db, 'invoices'), where('reservationId', '==', id)),
    );
    expect(documents.size).toBe(1);
  }, 120_000);

  it('burns no invoice number on a duplicate request', async () => {
    await asOwner();
    const { id } = await makeReservation();
    const requestKey = key('nowaste');

    await issue(id, { idempotencyKey: requestKey });

    const counterBefore = (await getDoc(doc(db, 'counters', `invoice-${ISSUE_YEAR}`))).data()![
      'current'
    ];

    await issue(id, { idempotencyKey: requestKey });

    const counterAfter = (await getDoc(doc(db, 'counters', `invoice-${ISSUE_YEAR}`))).data()![
      'current'
    ];

    expect(counterAfter).toBe(counterBefore);
  });
});

/* ------------------------------------------------------------------------ *
 * Voiding — §25
 * ------------------------------------------------------------------------ */

describe('voiding', () => {
  it('marks the document voided without deleting or altering it', async () => {
    await asOwner();
    const result = await issue((await makeReservation()).id);
    const before = (await getDoc(doc(db, 'invoices', result.data.documentId))).data()!;

    await call<Record<string, unknown>, { success: boolean }>('voidDocument')({
      documentId: result.data.documentId,
      reason: 'Issued against the wrong reservation',
    });

    const after = (await getDoc(doc(db, 'invoices', result.data.documentId))).data()!;

    expect(after['status']).toBe('Voided');
    expect(after['voidReason']).toBe('Issued against the wrong reservation');

    // The number and the figures are untouched: the gap in the sequence stays
    // explicable, which a deletion would not.
    expect(after['documentNumber']).toBe(before['documentNumber']);
    expect(after['financials']).toEqual(before['financials']);
  });

  it('records an audit entry', async () => {
    await asOwner();
    const { id } = await makeReservation();
    const result = await issue(id);

    await call<Record<string, unknown>, { success: boolean }>('voidDocument')({
      documentId: result.data.documentId,
      reason: 'Duplicate',
    });

    const audits = await getDocs(
      query(
        collection(db, 'auditLogs'),
        where('entityId', '==', id),
        where('action', '==', 'document.voided'),
      ),
    );

    expect(audits.size).toBe(1);
  });

  it('REFUSES voiding without a reason', async () => {
    await asOwner();
    const result = await issue((await makeReservation()).id);

    const code = await refusalCode(() =>
      call<Record<string, unknown>, { success: boolean }>('voidDocument')({
        documentId: result.data.documentId,
        reason: '   ',
      }),
    );

    expect(code).toBe('failed-precondition');
  });

  it('REFUSES voiding the same document twice', async () => {
    await asOwner();
    const result = await issue((await makeReservation()).id);

    await call<Record<string, unknown>, { success: boolean }>('voidDocument')({
      documentId: result.data.documentId,
      reason: 'First',
    });

    const code = await refusalCode(() =>
      call<Record<string, unknown>, { success: boolean }>('voidDocument')({
        documentId: result.data.documentId,
        reason: 'Second',
      }),
    );

    expect(code).toBe('failed-precondition');
  });

  it('DENIES staff voiding a document', async () => {
    await asOwner();
    const result = await issue((await makeReservation()).id);

    await asStaff();
    const code = await refusalCode(() =>
      call<Record<string, unknown>, { success: boolean }>('voidDocument')({
        documentId: result.data.documentId,
        reason: 'Staff attempt',
      }),
    );

    expect(code).toBe('permission-denied');
    await asOwner();
  });
});

/* ------------------------------------------------------------------------ *
 * Authorization — §38
 * ------------------------------------------------------------------------ */

describe('authorization', () => {
  it('DENIES an unauthenticated caller issuing', async () => {
    await asOwner();
    const { id } = await makeReservation();
    await signOut(auth);

    expect(await refusalCode(() => issue(id))).toBe('unauthenticated');
    await asOwner();
  });

  it('DENIES an unauthenticated caller reading a document', async () => {
    await asOwner();
    const result = await issue((await makeReservation()).id);
    await signOut(auth);

    await expect(getDoc(doc(db, 'invoices', result.data.documentId))).rejects.toThrow();
    await asOwner();
  });

  it('ALLOWS staff to issue — handing a customer their invoice is the job', async () => {
    await asOwner();
    const { id } = await makeReservation();

    await asStaff();
    const result = await issue(id);

    expect(result.data.success).toBe(true);
    await asOwner();
  });

  it('ALLOWS staff to read a document', async () => {
    await asOwner();
    const result = await issue((await makeReservation()).id);

    await asStaff();
    const document = await getDoc(doc(db, 'invoices', result.data.documentId));

    expect(document.exists()).toBe(true);
    await asOwner();
  });

  it('DENIES staff changing the business profile or the logo path', async () => {
    await asStaff();

    await expect(
      setDoc(
        doc(db, 'businessProfile', 'main'),
        { logoPath: 'business/logo/staff.png' },
        { merge: true },
      ),
    ).rejects.toThrow();

    await asOwner();
  });

  it('records print as INITIATED, never as printed', async () => {
    await asOwner();
    const { id } = await makeReservation();
    const result = await issue(id);

    await call<Record<string, unknown>, { success: boolean }>('recordPrintIntent')({
      documentId: result.data.documentId,
    });

    const audits = await getDocs(
      query(
        collection(db, 'auditLogs'),
        where('entityId', '==', id),
        where('action', '==', 'document.print_initiated'),
      ),
    );

    expect(audits.size).toBe(1);

    // The application cannot know whether paper emerged, so it never says so.
    const printedClaims = await getDocs(
      query(collection(db, 'auditLogs'), where('action', '==', 'document.printed')),
    );
    expect(printedClaims.size).toBe(0);
  });
});
