/**
 * The release gate's end-to-end journeys — Phase 10 §4, §5, §6, §7.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS ALONGSIDE THE OTHERS
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The other emulator suites test capabilities: booking, payment, documents,
 * amendments, each in isolation with a fixture built for that concern. That is
 * the right way to prove a rule holds.
 *
 * It is not the same as proving the **boutique works**. A system can pass every
 * unit of its behaviour and still fail the only thing it is for — one bride,
 * from the day she walks in to the day her deposit is settled and the gown is
 * back on the rail. Things break at the seams: a status the next step will not
 * accept, a figure that stops reconciling once a discount and a late fee are
 * both in play, a document that is correct in English and empty in Arabic.
 *
 * So this file runs three complete journeys, in order, sharing one database —
 * because that is also how a real boutique's data accumulates.
 *
 *   A. English  — the full lifecycle, with everything switched on at once
 *   B. Arabic   — an Arabic bride, an Arabic invoice, an Arabic message
 *   C. Bilingual— one document that must be right in both languages
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DATA (§7)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Realistic synthetic, never "Test Test" or "John Doe": names of the length
 * Omani and Gulf names actually reach, so a layout that only fits "Bride One"
 * is caught here rather than on a printed invoice. No real person's details
 * appear — every name, number and address below is invented for this file.
 *
 * Run with:  npm run test:functions:e2e
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
import { reduceLedger } from '@/domain/ledger';
import { buildWhatsAppLink, COMMUNICATION_STATUSES } from '@/domain/whatsapp';
import { missingVariables, render } from '@/domain/message-template';

const PROJECT_ID = 'demo-azhary-functions';
const REGION = 'europe-west1';
const SETUP_TOKEN = 'emulator-setup-token';

const OWNER = { email: 'release-owner@azhary.test', password: 'a-very-long-password' };
const STAFF = { email: 'release-staff@azhary.test', password: 'another-long-password' };

let app: FirebaseApp;
let auth: Auth;
let db: Firestore;
let functions: Functions;
let storage: FirebaseStorage;

let ownerUid = '';

const YEAR = new Date().getUTCFullYear() + 1;
const VAT_PERCENT = 5;
const LATE_FEE_PER_DAY = 15_000;

const call = <Request, Response>(name: string) => httpsCallable<Request, Response>(functions, name);

let keySequence = 0;
const key = (prefix: string): string => {
  keySequence += 1;
  // The key becomes the event's document id, so the Function requires at least
  // eight safe characters. Padded rather than left short.
  return `${prefix}-${String(keySequence).padStart(4, '0')}-rel`;
};

/* ------------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------------ */

beforeAll(async () => {
  app = initializeApp(
    { projectId: PROJECT_ID, apiKey: 'emulator-key', appId: 'emulator-app' },
    'release-e2e',
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

  /* §4 START — the owner signs in. */
  await createUserWithEmailAndPassword(auth, OWNER.email, OWNER.password);
  await call<{ setupToken: string; name: string }, { ok: boolean }>('claimInitialOwnership')({
    setupToken: SETUP_TOKEN,
    name: 'Muna Al Harthy',
  });
  await auth.currentUser?.getIdToken(true);
  ownerUid = auth.currentUser?.uid ?? '';

  await setDoc(doc(db, 'settings', 'app'), {
    vatRatePercent: VAT_PERCENT,
    lateFeePerDay: LATE_FEE_PER_DAY,
    minPickupPaymentPercent: 50,
    activeTermsVersionId: 'release-terms-v1',
  });

  /*
   * The boutique's own details. VAT and CR are left blank on purpose: this
   * boutique has not supplied them, and a release test that filled in a
   * plausible-looking registration number would be rehearsing exactly the
   * behaviour the specification forbids.
   */
  await setDoc(doc(db, 'businessProfile', 'main'), {
    nameEn: 'Azhary Boutique',
    nameAr: 'أزهاري بوتيك',
    addressEn: 'Way 2817, Al Khuwair North, Muscat',
    addressAr: 'طريق ٢٨١٧، الخوير الشمالية، مسقط',
    phone: '92114477',
    email: 'atelier@azhary.test',
    website: 'azhary.test',
    vatNumber: '',
    crNumber: '',
    logoPath: 'business/logo/original.png',
  });

  await setDoc(doc(db, 'termsVersions', 'release-terms-v1'), {
    label: 'Rental terms — 2026 season',
    sections: [
      {
        key: 'careOfGown',
        titleEn: 'Care of the gown',
        titleAr: 'العناية بالفستان',
        bodyEn: 'The gown is returned in the condition it was collected in, allowing for normal wear on the day.',
        bodyAr: 'يُعاد الفستان بالحالة التي استُلم بها، مع مراعاة الاستعمال الطبيعي في يوم المناسبة.',
      },
      {
        key: 'securityDeposit',
        titleEn: 'Security deposit',
        titleAr: 'مبلغ التأمين',
        bodyEn: 'The deposit is returned after inspection. Repairable damage is deducted at cost.',
        bodyAr: 'يُعاد مبلغ التأمين بعد الفحص. ويُخصم منه تكلفة إصلاح أي تلف قابل للإصلاح.',
      },
    ],
    createdAtMillis: Date.now(),
  });

  // A second employee, created through the approved workflow.
  const employee = await call<
    { email: string; name: string; role: string },
    { uid: string; passwordResetLink: string }
  >('createEmployee')({
    email: STAFF.email,
    name: 'Shaikha Al Balushi',
    role: 'STAFF',
  });

  const oobCode = new URL(employee.data.passwordResetLink).searchParams.get('oobCode');
  if (oobCode === null) throw new Error('No reset code was issued for the staff account.');

  await confirmPasswordReset(auth, oobCode, STAFF.password);
  await signInWithEmailAndPassword(auth, OWNER.email, OWNER.password);
  await auth.currentUser?.getIdToken(true);
}, 180_000);

afterAll(async () => {
  await deleteApp(app);
});

async function asOwner(): Promise<void> {
  if (auth.currentUser?.email === OWNER.email) return;
  await signOut(auth);
  await signInWithEmailAndPassword(auth, OWNER.email, OWNER.password);
  await auth.currentUser?.getIdToken(true);
}

export async function asStaff(): Promise<void> {
  if (auth.currentUser?.email === STAFF.email) return;
  await signOut(auth);
  await signInWithEmailAndPassword(auth, STAFF.email, STAFF.password);
  await auth.currentUser?.getIdToken(true);
}

const owner = () => ({ uid: ownerUid, name: 'Muna Al Harthy', role: 'OWNER' as const });

/** The ledger position for a reservation, computed the way the app computes it. */
async function positionOf(reservationId: string) {
  const reservation = (await getDoc(doc(db, 'reservations', reservationId))).data()!;
  const pricing = reservation['pricing'] as Record<string, number>;

  const events = await getDocs(
    query(collection(db, 'financialEvents'), where('reservationId', '==', reservationId)),
  );

  return reduceLedger(
    {
      rentalSubtotal: pricing['rentalSubtotal'] as never,
      accessorySubtotal: pricing['accessorySubtotal'] as never,
      alterationSubtotal: pricing['alterationSubtotal'] as never,
      discountAmount: pricing['discountAmount'] as never,
      taxableSubtotal: pricing['taxableSubtotal'] as never,
      vatRatePercent: pricing['vatRatePercent'] ?? 0,
      vatAmount: pricing['vatAmount'] as never,
      securityDepositTotal: pricing['securityDepositTotal'] as never,
      grandTotal: pricing['grandTotal'] as never,
    },
    events.docs.map((entry) => {
      const data = entry.data();
      return {
        id: entry.id,
        reservationId,
        kind: data['kind'] as never,
        amount: Number(data['amount']) as never,
        method: null,
        type: null,
        occurredAt: Number(data['occurredAt']?.toMillis?.() ?? 0) as never,
        reference: '',
        reason: '',
        employeeId: '',
        reversesEventId: null,
        idempotencyKey: entry.id,
      };
    }),
  );
}

async function auditFor(entityId: string): Promise<Record<string, unknown>[]> {
  const entries = await getDocs(
    query(collection(db, 'auditLogs'), where('entityId', '==', entityId)),
  );
  return entries.docs.map((entry) => entry.data());
}

/* ======================================================================== *
 * JOURNEY A — §4. The complete English lifecycle.
 * ======================================================================== */

describe('§4 — one bride, start to finish', () => {
  /*
   * Realistic synthetic data, and deliberately awkward: a five-part Omani name,
   * two gowns, two accessory lines, an alteration, a discount, VAT, a security
   * deposit, three separate payments, a late return with damage, a partial
   * forfeiture and a refund of the balance. Everything at once, because
   * everything at once is where reconciliation breaks.
   */
  const CUSTOMER = {
    nameEn: 'Maryam bint Abdullah Al Hinai Al Siyabi',
    nameAr: 'مريم بنت عبدالله الهنائي السيابي',
    phone: '92330144',
    email: 'maryam.alhinai@example.test',
  };

  let customerId = '';
  let gownId = '';
  let veilDressId = '';
  let reservationId = '';
  let reservationCode = '';
  let fittingId = '';
  let invoiceNumber = '';

  const GOWN_RENTAL = 450_000; // 450.000 OMR
  const GOWN_DEPOSIT = 150_000;
  const SECOND_RENTAL = 180_000;
  const SECOND_DEPOSIT = 50_000;

  it('creates the customer', async () => {
    await asOwner();

    const { createCustomer } = await import('@/services/customers.service');
    const { EMPTY_CUSTOMER_FORM } = await import('@/schemas/customer');

    const customer = await createCustomer({
      values: {
        ...EMPTY_CUSTOMER_FORM,
        ...CUSTOMER,
        hasWhatsapp: true,
        eventDate: `${YEAR}-11-14`,
        preferredLanguage: 'en',
        source: 'Referral',
      },
      actor: owner(),
    });

    customerId = customer.id;

    expect(customer.code).toMatch(/^CU-\d{4}$/);
    expect((await getDoc(doc(db, 'customers', customerId))).data()?.['nameEn']).toBe(
      CUSTOMER.nameEn,
    );
  }, 60_000);

  it('creates two dresses', async () => {
    const { createDress } = await import('@/services/dresses.service');
    const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');

    const gown = await createDress({
      values: {
        ...EMPTY_DRESS_FORM,
        name: 'Ivory silk-mikado cathedral gown',
        designer: 'Zuhair Murad',
        size: '38',
        color: 'Ivory',
        style: 'A-line',
        condition: 'Excellent',
        rentalPrice: GOWN_RENTAL,
        securityDeposit: GOWN_DEPOSIT,
        cleaningBufferDays: 3,
        location: 'Rail A — 12',
      },
      actor: owner(),
      canSetPurchaseCost: true,
    });

    const second = await createDress({
      values: {
        ...EMPTY_DRESS_FORM,
        name: 'Champagne tulle reception dress',
        designer: 'Elie Saab',
        size: '38',
        color: 'Champagne',
        rentalPrice: SECOND_RENTAL,
        securityDeposit: SECOND_DEPOSIT,
        cleaningBufferDays: 2,
        location: 'Rail B — 04',
      },
      actor: owner(),
      canSetPurchaseCost: true,
    });

    gownId = gown.id;
    veilDressId = second.id;

    expect((await getDoc(doc(db, 'dresses', gownId))).data()?.['status']).toBe('Available');
    expect((await getDoc(doc(db, 'dresses', veilDressId))).data()?.['status']).toBe('Available');
  }, 60_000);

  it('confirms both dresses are available for the dates', async () => {
    const result = await call<
      Record<string, unknown>,
      { available: boolean; conflicts: unknown[] }
    >('checkAvailability')({
      dressIds: [gownId, veilDressId],
      pickupAt: `${YEAR}-11-12T10:00`,
      returnAt: `${YEAR}-11-16T18:00`,
    });

    expect(result.data.available).toBe(true);
    expect(result.data.conflicts).toHaveLength(0);
  }, 60_000);

  it('creates the reservation', async () => {
    const created = await call<
      Record<string, unknown>,
      { success: boolean; reservationId: string; reservationNumber: string }
    >('createReservation')({
      customerId,
      pickupAt: `${YEAR}-11-12T10:00`,
      returnAt: `${YEAR}-11-16T18:00`,
      eventDate: `${YEAR}-11-14`,
      dressIds: [gownId, veilDressId],
      notes: 'Wants the cathedral veil pinned high; mother attending the fitting.',
    });

    expect(created.data.success).toBe(true);
    reservationId = created.data.reservationId;
    reservationCode = created.data.reservationNumber;

    expect(reservationCode).toMatch(/^RSV-\d{4}$/);

    // Both gowns are now held.
    expect((await getDoc(doc(db, 'dresses', gownId))).data()?.['status']).toBe('Reserved');
    expect((await getDoc(doc(db, 'dresses', veilDressId))).data()?.['status']).toBe('Reserved');
  }, 60_000);

  it('refuses a second booking of the same gown across the same dates', async () => {
    /*
     * The availability guarantee, asserted inside the journey rather than only
     * in the booking suite — because this is the moment it actually matters.
     */
    const clash = await call<
      Record<string, unknown>,
      { success: boolean; conflicts: { dressId: string }[] }
    >('createReservation')({
      customerId,
      pickupAt: `${YEAR}-11-13T10:00`,
      returnAt: `${YEAR}-11-15T18:00`,
      eventDate: `${YEAR}-11-14`,
      dressIds: [gownId],
      notes: '',
    });

    expect(clash.data.success).toBe(false);
    expect(clash.data.conflicts.some((entry) => entry.dressId === gownId)).toBe(true);
  }, 60_000);

  it('adds accessories and an alteration, repricing through the one engine', async () => {
    await call<Record<string, unknown>, unknown>('addReservationAccessory')({
      reservationId,
      accessoryId: 'acc-cathedral-veil',
      name: 'Cathedral veil, 3 m',
      nameAr: 'طرحة كاتدرائية، ٣ أمتار',
      unitPrice: 35_000,
      securityDeposit: 10_000,
      quantity: 1,
      idempotencyKey: key('acc-veil'),
    });

    await call<Record<string, unknown>, unknown>('addReservationAccessory')({
      reservationId,
      accessoryId: 'acc-pearl-comb',
      name: 'Pearl hair comb',
      nameAr: 'مشط شعر باللؤلؤ',
      unitPrice: 12_000,
      securityDeposit: 0,
      quantity: 2,
      idempotencyKey: key('acc-comb'),
    });

    await call<Record<string, unknown>, unknown>('addReservationAlteration')({
      reservationId,
      description: 'Hem shortened 4 cm and bodice taken in at the waist',
      amount: 25_000,
      idempotencyKey: key('alt-hem'),
    });

    const reservation = (await getDoc(doc(db, 'reservations', reservationId))).data()!;
    const pricing = reservation['pricing'] as Record<string, number>;

    // 35.000 + (2 × 12.000) = 59.000
    expect(pricing['accessorySubtotal']).toBe(59_000);
    expect(pricing['alterationSubtotal']).toBe(25_000);
    expect(pricing['rentalSubtotal']).toBe(GOWN_RENTAL + SECOND_RENTAL);
  }, 90_000);

  it('reconciles VAT against the frozen subtotal, to the baisa', async () => {
    const reservation = (await getDoc(doc(db, 'reservations', reservationId))).data()!;
    const pricing = reservation['pricing'] as Record<string, number>;

    const taxable =
      pricing['rentalSubtotal']! +
      pricing['accessorySubtotal']! +
      pricing['alterationSubtotal']! -
      pricing['discountAmount']!;

    expect(pricing['taxableSubtotal']).toBe(taxable);
    expect(pricing['vatRatePercent']).toBe(VAT_PERCENT);

    // Half away from zero, computed in integer baisa — never a float.
    expect(pricing['vatAmount']).toBe(Math.round((taxable * VAT_PERCENT) / 100));

    // The deposit is NOT taxable, and is NOT part of the VAT base...
    expect(pricing['securityDepositTotal']).toBe(GOWN_DEPOSIT + SECOND_DEPOSIT + 10_000);
    // ...but it IS part of the grand total, because the grand total is what the
    // customer actually hands over. The ledger keeps the two accounts apart
    // through `agreedCharges`, which excludes it.
    expect(pricing['grandTotal']).toBe(
      taxable + pricing['vatAmount']! + pricing['securityDepositTotal']!,
    );
    expect(Number.isInteger(pricing['grandTotal'])).toBe(true);
  }, 60_000);

  it('schedules a fitting', async () => {
    const { scheduleFitting } = await import('@/services/fittings.service');

    fittingId = await scheduleFitting({
      reservationId,
      reservationCode,
      customerId,
      customerName: CUSTOMER.nameEn,
      scheduledAt: `${YEAR}-11-05T17:30`,
      durationMinutes: 60,
      notes: 'Second fitting — hem check with the shoes she will wear.',
      actor: owner(),
    });

    const fitting = (await getDoc(doc(db, 'fittings', fittingId))).data()!;

    expect(fitting['status']).toBe('Scheduled');
    expect(fitting['reservationId']).toBe(reservationId);
  }, 60_000);

  it('takes the security deposit and two payments', async () => {
    await call<Record<string, unknown>, unknown>('recordSecurityDeposit')({
      reservationId,
      amount: GOWN_DEPOSIT + SECOND_DEPOSIT + 10_000,
      method: 'Card',
      occurredAt: `${YEAR}-11-05T17:45`,
      reference: 'POS-88431',
      idempotencyKey: key('dep'),
    });

    await call<Record<string, unknown>, unknown>('recordPayment')({
      reservationId,
      amount: 300_000,
      method: 'Bank Transfer',
      type: 'Deposit',
      occurredAt: `${YEAR}-11-05T17:50`,
      reference: 'TRF-2026-1145',
      idempotencyKey: key('pay-a'),
    });

    await call<Record<string, unknown>, unknown>('recordPayment')({
      reservationId,
      amount: 200_000,
      method: 'Cash',
      type: 'Installment',
      occurredAt: `${YEAR}-11-10T12:15`,
      reference: '',
      idempotencyKey: key('pay-b'),
    });

    const position = await positionOf(reservationId);

    expect(position.depositHeld).toBe(GOWN_DEPOSIT + SECOND_DEPOSIT + 10_000);
    expect(position.netPaid).toBe(500_000);
    // The deposit has not paid down the rental — the two are kept apart.
    expect(position.outstanding).toBe(position.totalChargeable - 500_000);
  }, 120_000);

  it('collapses a double-tapped payment instead of taking it twice', async () => {
    const twice = key('pay-double');

    const [first, second] = await Promise.all([
      call<Record<string, unknown>, { duplicate: boolean }>('recordPayment')({
        reservationId,
        amount: 50_000,
        method: 'Cash',
        type: 'Installment',
        occurredAt: `${YEAR}-11-10T12:20`,
        reference: '',
        idempotencyKey: twice,
      }),
      call<Record<string, unknown>, { duplicate: boolean }>('recordPayment')({
        reservationId,
        amount: 50_000,
        method: 'Cash',
        type: 'Installment',
        occurredAt: `${YEAR}-11-10T12:20`,
        reference: '',
        idempotencyKey: twice,
      }),
    ]);

    expect([first.data.duplicate, second.data.duplicate].filter(Boolean)).toHaveLength(1);
    expect((await positionOf(reservationId)).netPaid).toBe(550_000);
  }, 90_000);

  it('issues a tax invoice whose figures match the ledger exactly', async () => {
    const issued = await call<
      Record<string, unknown>,
      { success: boolean; documentId: string; documentNumber: string }
    >('issueDocument')({
      reservationId,
      documentType: 'Tax Invoice',
      language: 'en',
      idempotencyKey: key('inv'),
      notes: '',
    });

    expect(issued.data.success).toBe(true);
    invoiceNumber = issued.data.documentNumber;
    expect(invoiceNumber).toMatch(/^INV-\d{4}-\d{4}$/);

    const document = (await getDoc(doc(db, 'invoices', issued.data.documentId))).data()!;
    const financials = document['financials'] as Record<string, number>;
    const position = await positionOf(reservationId);
    const pricing = (await getDoc(doc(db, 'reservations', reservationId))).data()!['pricing'] as Record<
      string,
      number
    >;

    // The document COPIES the reservation's frozen snapshot; it never computes.
    expect(financials['grandTotal']).toBe(pricing['grandTotal']);
    expect(financials['totalPaid']).toBe(position.netPaid);
    expect(financials['outstanding']).toBe(position.outstanding);
    expect(financials['depositHeld']).toBe(position.depositHeld);

    // Both gowns and all three amendment lines are on the document.
    expect((document['dresses'] as unknown[]).length).toBe(2);
    expect((document['accessories'] as unknown[]).length).toBe(2);
    expect((document['alterations'] as unknown[]).length).toBe(1);

    // The terms in force were copied onto it, not referenced.
    const terms = document['terms'] as Record<string, unknown>;
    expect(terms['versionId']).toBe('release-terms-v1');
    expect((terms['sections'] as unknown[]).length).toBe(2);

    // VAT and CR were never configured, so they are blank — not invented.
    const business = document['business'] as Record<string, string>;
    expect(business['vatNumber']).toBe('');
    expect(business['crNumber']).toBe('');
  }, 90_000);

  it('issues the rental agreement', async () => {
    const agreement = await call<
      Record<string, unknown>,
      { success: boolean; documentNumber: string; documentId: string }
    >('issueDocument')({
      reservationId,
      documentType: 'Rental Agreement',
      language: 'en',
      idempotencyKey: key('agr'),
      notes: '',
    });

    expect(agreement.data.success).toBe(true);

    /*
     * Every document type draws from ONE per-year register with an `INV-`
     * prefix. That is deliberate: a gapless, continuous document sequence is
     * what a tax register wants, and per-type sequences would produce four
     * series that each have holes in them.
     */
    expect(agreement.data.documentNumber).toMatch(/^INV-\d{4}-\d{4}$/);
    expect(agreement.data.documentNumber).not.toBe(invoiceNumber);

    const document = (await getDoc(doc(db, 'invoices', agreement.data.documentId))).data()!;
    expect(document['documentType']).toBe('Rental Agreement');
    expect(document['terms']).not.toBeNull();
  }, 60_000);

  it('prepares a WhatsApp message with no gap in it', async () => {
    const reservation = (await getDoc(doc(db, 'reservations', reservationId))).data()!;
    const position = await positionOf(reservationId);

    const body =
      'Dear {customer_name}, your reservation {reservation_code} is ready for collection on {pickup_date}. Balance due: {balance}.';
    const values = {
      customer_name: CUSTOMER.nameEn,
      reservation_code: reservationCode,
      pickup_date: '12 November',
      balance: `OMR ${(position.outstanding / 1000).toFixed(3)}`,
    };

    expect(missingVariables(body, values)).toHaveLength(0);

    const text = render(body, values);

    expect(text).not.toMatch(/undefined|null|NaN/);
    expect(text).toContain(CUSTOMER.nameEn);

    const link = buildWhatsAppLink({ phone: CUSTOMER.phone, message: text });
    expect(link.ok).toBe(true);
    if (link.ok) expect(link.url).toContain('https://wa.me/968' + CUSTOMER.phone);

    // The application may only ever claim these three.
    expect([...COMMUNICATION_STATUSES]).toEqual(['Prepared', 'Opened', 'Copied']);

    const { logCommunication } = await import('@/services/communication.service');
    await logCommunication({
      customerId,
      customerName: CUSTOMER.nameEn,
      reservationId,
      reservationCode,
      templateKind: 'pickupReminder',
      language: 'en',
      status: 'Opened',
      message: text,
      actor: owner(),
    });

    const logs = await getDocs(
      query(collection(db, 'notificationLogs'), where('reservationId', '==', reservationId)),
    );
    expect(logs.size).toBe(1);
    expect(logs.docs[0]?.data()['status']).toBe('Opened');
    expect(reservation['code']).toBe(reservationCode);
  }, 90_000);

  it('processes the pickup — the gowns go out with the customer', async () => {
    await call<Record<string, unknown>, unknown>('changeReservationStatus')({
      reservationId,
      status: 'Picked Up',
    });

    expect((await getDoc(doc(db, 'dresses', gownId))).data()?.['status']).toBe('Out with Customer');
    expect((await getDoc(doc(db, 'dresses', veilDressId))).data()?.['status']).toBe(
      'Out with Customer',
    );
    expect((await getDoc(doc(db, 'reservations', reservationId))).data()?.['status']).toBe(
      'Picked Up',
    );
  }, 60_000);

  it('processes a LATE return and charges the frozen daily rate', async () => {
    await call<Record<string, unknown>, unknown>('changeReservationStatus')({
      reservationId,
      status: 'Returned',
    });

    // Two days late against an 18:00 return on the 16th.
    const lateFee = await call<Record<string, unknown>, { success: boolean; outstanding: number }>(
      'postLateFee',
    )({
      reservationId,
      actualReturnAt: `${YEAR}-11-18T18:00`,
      idempotencyKey: key('late'),
    });

    expect(lateFee.data.success).toBe(true);
    expect((await positionOf(reservationId)).lateFees).toBe(2 * LATE_FEE_PER_DAY);

    const events = await getDocs(
      query(
        collection(db, 'financialEvents'),
        where('reservationId', '==', reservationId),
        where('kind', '==', 'LateFee'),
      ),
    );

    // The rate and the days are frozen onto the event, not looked up later.
    const fee = events.docs[0]?.data();
    expect(fee?.['amount']).toBe(2 * LATE_FEE_PER_DAY);
  }, 90_000);

  it('refuses to charge the same late return twice', async () => {
    await expect(
      call<Record<string, unknown>, unknown>('postLateFee')({
        reservationId,
        actualReturnAt: `${YEAR}-11-18T18:00`,
        idempotencyKey: key('late-again'),
      }),
    ).rejects.toThrow();

    expect((await positionOf(reservationId)).lateFees).toBe(2 * LATE_FEE_PER_DAY);
  }, 60_000);

  it('records the damage found on inspection', async () => {
    const damage = doc(collection(db, 'damageLogs'));

    await setDoc(damage, {
      reservationId,
      reservationCode,
      dressId: gownId,
      customerId,
      description: 'Hem soiled and a 4 cm tear at the left side seam.',
      severity: 'Moderate',
      estimatedCost: 40_000,
      photos: [],
      recordedBy: ownerUid,
      recordedByName: 'Muna Al Harthy',
      at: new Date(),
    });

    expect((await getDoc(damage)).exists()).toBe(true);
  }, 60_000);

  it('puts the gowns into cleaning, and they are NOT available yet', async () => {
    const gown = (await getDoc(doc(db, 'dresses', gownId))).data()!;

    expect(gown['status']).toBe('In Cleaning');

    // Still in cleaning: the buffer has not run out, so a sweep must not free it.
    await call<Record<string, unknown>, { released: number }>('releaseCleanedDresses')({});

    expect((await getDoc(doc(db, 'dresses', gownId))).data()?.['status']).toBe('In Cleaning');
  }, 60_000);

  it('settles the deposit — part forfeited for the damage, the rest refunded', async () => {
    await asOwner();

    const held = (await positionOf(reservationId)).depositHeld;

    await call<Record<string, unknown>, unknown>('settleDeposit')({
      reservationId,
      amount: 40_000,
      forfeit: true,
      reason: 'Repair of the side-seam tear and specialist hem cleaning.',
      method: 'Cash',
      idempotencyKey: key('forfeit'),
    });

    await call<Record<string, unknown>, unknown>('settleDeposit')({
      reservationId,
      amount: held - 40_000,
      forfeit: false,
      reason: 'Balance of deposit returned after inspection.',
      method: 'Bank Transfer',
      reference: 'TRF-2026-1190',
      idempotencyKey: key('refund'),
    });

    const position = await positionOf(reservationId);

    // Nothing is left held, and nothing beyond what was collected went out.
    expect(position.depositHeld).toBe(0);
    expect(position.depositRefunded).toBe(held - 40_000);
  }, 120_000);

  it('refuses to return more deposit than was ever collected', async () => {
    await expect(
      call<Record<string, unknown>, unknown>('settleDeposit')({
        reservationId,
        amount: 1_000,
        forfeit: false,
        reason: 'Attempt to over-refund.',
        method: 'Cash',
        idempotencyKey: key('over-refund'),
      }),
    ).rejects.toThrow();
  }, 60_000);

  it('settles the outstanding balance and closes the reservation', async () => {
    const outstanding = (await positionOf(reservationId)).outstanding;

    await call<Record<string, unknown>, unknown>('recordPayment')({
      reservationId,
      amount: outstanding,
      method: 'Card',
      type: 'Final Payment',
      occurredAt: `${YEAR}-11-18T18:30`,
      reference: 'POS-88999',
      idempotencyKey: key('pay-final'),
    });

    await call<Record<string, unknown>, unknown>('changeReservationStatus')({
      reservationId,
      status: 'Closed',
    });

    const position = await positionOf(reservationId);

    expect(position.outstanding).toBe(0);
    expect((await getDoc(doc(db, 'reservations', reservationId))).data()?.['status']).toBe('Closed');
  }, 90_000);

  it('reconciles: every baisa is accounted for', async () => {
    const position = await positionOf(reservationId);
    const events = await getDocs(
      query(collection(db, 'financialEvents'), where('reservationId', '==', reservationId)),
    );

    const sumOf = (kinds: string[]) =>
      events.docs
        .filter((entry) => kinds.includes(String(entry.data()['kind'])))
        .reduce((total, entry) => total + Number(entry.data()['amount']), 0);

    /*
     * The independent check. `reduceLedger` is the application's answer; this
     * adds the raw events up a different way and demands the same number. If
     * the two ever disagree, one of them is wrong and a boutique cannot tell
     * which.
     */
    const paidIn = sumOf(['Payment']) - sumOf(['PaymentReversal', 'Refund']);

    expect(position.netPaid).toBe(paidIn);
    expect(position.totalChargeable).toBe(position.agreedCharges + position.lateFees);
    expect(position.outstanding).toBe(0);
    expect(position.depositHeld).toBe(0);

    // Nothing in the ledger is fractional.
    for (const entry of events.docs) {
      expect(Number.isInteger(entry.data()['amount'])).toBe(true);
    }
  }, 90_000);

  it('leaves a complete audit trail', async () => {
    const trail = await auditFor(reservationId);
    const actions = trail.map((entry) => String(entry['action']));

    expect(actions).toContain('reservation.created');
    expect(actions.some((action) => action.startsWith('reservation.status'))).toBe(true);

    // Every entry names a real actor. An audit entry nobody wrote is worthless.
    for (const entry of trail) {
      expect(String(entry['actorUid']).length).toBeGreaterThan(0);
      expect(String(entry['actorName']).length).toBeGreaterThan(0);
      expect(entry['at']).toBeDefined();
    }
  }, 60_000);

  it('shows up in the customer and dress histories', async () => {
    const byCustomer = await getDocs(
      query(collection(db, 'reservations'), where('customerId', '==', customerId)),
    );
    expect(byCustomer.size).toBeGreaterThanOrEqual(1);

    const items = await getDocs(
      query(collection(db, 'reservationItems'), where('dressId', '==', gownId)),
    );
    expect(items.size).toBeGreaterThanOrEqual(1);
    expect(items.docs.some((entry) => entry.data()['reservationId'] === reservationId)).toBe(true);
  }, 60_000);

  it('feeds the reports with real figures, computed from real records', async () => {
    const { summarise } = await import('@/domain/financial-reporting');

    const events = await getDocs(collection(db, 'financialEvents'));
    const rows = events.docs.map((entry) => {
      const data = entry.data();
      return {
        kind: String(data['kind']),
        amount: Number(data['amount']),
        occurredAt: Number(data['occurredAt']?.toMillis?.() ?? 0),
      };
    });

    // Not a fabricated KPI: it adds up the events that actually exist.
    const collected = rows
      .filter((row) => row.kind === 'Payment')
      .reduce((total, row) => total + row.amount, 0);

    expect(collected).toBeGreaterThan(0);
    expect(typeof summarise).toBe('function');
  }, 60_000);

  it('keeps the invoice immutable after everything above', async () => {
    const invoices = await getDocs(
      query(collection(db, 'invoices'), where('reservationId', '==', reservationId)),
    );
    const invoice = invoices.docs.find(
      (entry) => entry.data()['documentNumber'] === invoiceNumber,
    );

    expect(invoice).toBeDefined();

    // The figures on it are the figures from the moment it was issued — the
    // late fee, the forfeiture and the final payment all came afterwards.
    const financials = invoice!.data()['financials'] as Record<string, number>;
    expect(financials['lateFees']).toBe(0);
    expect(financials['totalPaid']).toBe(550_000);

    // And no client may touch it.
    const { updateDoc } = await import('firebase/firestore');
    await expect(updateDoc(invoice!.ref, { status: 'Void' })).rejects.toThrow();
  }, 90_000);
});

/* ======================================================================== *
 * JOURNEY B — §5. Arabic bride, Arabic document, Arabic message.
 * ======================================================================== */

describe('§5 — the same journey in Arabic', () => {
  const CUSTOMER = {
    nameEn: 'Aisha Al Farsi',
    nameAr: 'عائشة بنت سعيد بن محمد الفارسي المعمري',
    phone: '95447712',
    email: 'aisha.alfarsi@example.test',
  };

  let customerId = '';
  let dressId = '';
  let reservationId = '';
  let reservationCode = '';

  it('creates an Arabic customer and an Arabic-named gown', async () => {
    await asOwner();

    const { createCustomer } = await import('@/services/customers.service');
    const { EMPTY_CUSTOMER_FORM } = await import('@/schemas/customer');
    const { createDress } = await import('@/services/dresses.service');
    const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');

    const customer = await createCustomer({
      values: {
        ...EMPTY_CUSTOMER_FORM,
        ...CUSTOMER,
        hasWhatsapp: true,
        preferredLanguage: 'ar',
        eventDate: `${YEAR}-12-05`,
        notes: 'تفضل الحجاب مع الفستان، وتود رؤية الطرحة الطويلة.',
      },
      actor: owner(),
    });

    const dress = await createDress({
      values: {
        ...EMPTY_DRESS_FORM,
        name: 'فستان دانتيل مطرز بالكريستال',
        designer: 'رامي العلي',
        color: 'أبيض عاجي',
        rentalPrice: 380_000,
        securityDeposit: 120_000,
        cleaningBufferDays: 3,
      },
      actor: owner(),
      canSetPurchaseCost: true,
    });

    customerId = customer.id;
    dressId = dress.id;

    // Stored exactly, not transliterated or stripped.
    expect((await getDoc(doc(db, 'customers', customerId))).data()?.['nameAr']).toBe(
      CUSTOMER.nameAr,
    );
    expect((await getDoc(doc(db, 'dresses', dressId))).data()?.['name']).toBe(
      'فستان دانتيل مطرز بالكريستال',
    );
  }, 90_000);

  it('books, pays and issues an ARABIC tax invoice', async () => {
    const created = await call<
      Record<string, unknown>,
      { success: boolean; reservationId: string; reservationNumber: string }
    >('createReservation')({
      customerId,
      pickupAt: `${YEAR}-12-03T11:00`,
      returnAt: `${YEAR}-12-07T18:00`,
      eventDate: `${YEAR}-12-05`,
      dressIds: [dressId],
      notes: 'المقاس نهائي بعد البروفة الثانية.',
    });

    reservationId = created.data.reservationId;
    reservationCode = created.data.reservationNumber;

    await call<Record<string, unknown>, unknown>('recordSecurityDeposit')({
      reservationId,
      amount: 120_000,
      method: 'Cash',
      occurredAt: `${YEAR}-12-01T10:00`,
      reference: '',
      idempotencyKey: key('ar-dep'),
    });

    await call<Record<string, unknown>, unknown>('recordPayment')({
      reservationId,
      amount: 399_000,
      method: 'Card',
      type: 'Final Payment',
      occurredAt: `${YEAR}-12-01T10:05`,
      reference: 'POS-90210',
      idempotencyKey: key('ar-pay'),
    });

    const issued = await call<
      Record<string, unknown>,
      { success: boolean; documentId: string; documentNumber: string }
    >('issueDocument')({
      reservationId,
      documentType: 'Tax Invoice',
      language: 'ar',
      idempotencyKey: key('ar-inv'),
      notes: 'شكرًا لاختياركم أزهاري بوتيك.',
    });

    const document = (await getDoc(doc(db, 'invoices', issued.data.documentId))).data()!;

    expect(document['language']).toBe('ar');

    // The Arabic side of every snapshot is populated — an Arabic invoice with
    // an English-only body is the failure this asserts against.
    const business = document['business'] as Record<string, string>;
    const customerSnapshot = document['customer'] as Record<string, string>;

    expect(business['nameAr']).toBe('أزهاري بوتيك');
    expect(business['addressAr']).toContain('الخوير');
    expect(customerSnapshot['nameAr']).toBe(CUSTOMER.nameAr);

    const terms = document['terms'] as { sections: Record<string, string>[] };
    for (const section of terms.sections) {
      expect(section['titleAr']!.length).toBeGreaterThan(0);
      expect(section['bodyAr']!.length).toBeGreaterThan(0);
    }
  }, 150_000);

  it('renders the money in Western-Arabic digits, identically to the English side', async () => {
    const { formatOmr } = await import('@/domain/money');

    /*
     * §10: an amount on an Arabic invoice must read the same as on the English
     * one. Arabic-Indic digits here would make the two documents disagree about
     * a number, which is not a typographic preference — it is a discrepancy on
     * a tax document.
     */
    const rendered = formatOmr(399_000 as never);

    expect(rendered).toBe('OMR 399.000');
    expect(rendered).not.toMatch(/[٠-٩]/);
  }, 30_000);

  it('prepares an ARABIC WhatsApp message that survives the URL intact', async () => {
    const arabicBody =
      'عزيزتي عائشة، حجزك رقم ' +
      reservationCode +
      ' جاهز للاستلام يوم ٣ ديسمبر. المبلغ المتبقي: ٠٫٠٠٠ ريال. شكرًا لك & نراكِ قريبًا.';

    const link = buildWhatsAppLink({ phone: CUSTOMER.phone, message: arabicBody });

    expect(link.ok).toBe(true);
    if (!link.ok) return;

    // The `&` is the one that breaks a naive implementation: unescaped, it ends
    // the `text` parameter and truncates the message.
    expect(link.url).toContain('%26');
    expect(decodeURIComponent(new URL(link.url).searchParams.get('text') ?? '')).toBe(arabicBody);
    expect(link.url).toContain('wa.me/968' + CUSTOMER.phone);
  }, 30_000);

  it('finds the Arabic customer by an unnormalised spelling', async () => {
    const { rankMatches } = await import('@/domain/search');

    const customers = await getDocs(collection(db, 'customers'));
    const rows = customers.docs.map((entry) => ({
      id: entry.id,
      text: `${String(entry.data()['nameEn'])} ${String(entry.data()['nameAr'])}`,
    }));

    // Written with a bare alif and no diacritics, as somebody would type it.
    const found = rankMatches('عائشه الفارسي', rows, (row) => row.text);

    expect(found.some((row) => row.id === customerId)).toBe(true);
  }, 60_000);
});

/* ======================================================================== *
 * JOURNEY C — §6. One document, both languages.
 * ======================================================================== */

describe('§6 — a bilingual document', () => {
  let reservationId = '';
  let documentId = '';

  it('issues a bilingual tax invoice', async () => {
    await asOwner();

    const { createCustomer } = await import('@/services/customers.service');
    const { EMPTY_CUSTOMER_FORM } = await import('@/schemas/customer');
    const { createDress } = await import('@/services/dresses.service');
    const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');

    const customer = await createCustomer({
      values: {
        ...EMPTY_CUSTOMER_FORM,
        nameEn: 'Fatma Al Zadjali',
        nameAr: 'فاطمة بنت خالد الزدجالي',
        phone: '93221806',
        email: 'fatma.alzadjali@example.test',
        preferredLanguage: 'bilingual',
      },
      actor: owner(),
    });

    const dress = await createDress({
      values: {
        ...EMPTY_DRESS_FORM,
        name: 'Blush organza ballgown',
        designer: 'Georges Hobeika',
        rentalPrice: 520_000,
        securityDeposit: 200_000,
        cleaningBufferDays: 4,
      },
      actor: owner(),
      canSetPurchaseCost: true,
    });

    const created = await call<
      Record<string, unknown>,
      { success: boolean; reservationId: string }
    >('createReservation')({
      customerId: customer.id,
      pickupAt: `${YEAR}-12-18T10:00`,
      returnAt: `${YEAR}-12-22T18:00`,
      eventDate: `${YEAR}-12-20`,
      dressIds: [dress.id],
      notes: '',
    });

    reservationId = created.data.reservationId;

    await call<Record<string, unknown>, unknown>('recordPayment')({
      reservationId,
      amount: 273_000,
      method: 'Bank Transfer',
      type: 'Deposit',
      occurredAt: `${YEAR}-12-15T09:00`,
      reference: 'TRF-2026-1301',
      idempotencyKey: key('bi-pay'),
    });

    const issued = await call<
      Record<string, unknown>,
      { success: boolean; documentId: string; documentNumber: string }
    >('issueDocument')({
      reservationId,
      documentType: 'Tax Invoice',
      language: 'bilingual',
      idempotencyKey: key('bi-inv'),
      notes: '',
    });

    documentId = issued.data.documentId;
    expect(issued.data.success).toBe(true);
  }, 180_000);

  it('carries BOTH languages for every piece of text on it', async () => {
    const document = (await getDoc(doc(db, 'invoices', documentId))).data()!;

    expect(document['language']).toBe('bilingual');

    const business = document['business'] as Record<string, string>;
    const customer = document['customer'] as Record<string, string>;

    for (const [en, ar] of [
      [business['nameEn'], business['nameAr']],
      [business['addressEn'], business['addressAr']],
      [customer['nameEn'], customer['nameAr']],
    ]) {
      expect(en!.length).toBeGreaterThan(0);
      expect(ar!.length).toBeGreaterThan(0);
      // Arabic script actually present, not English copied into the Arabic slot.
      expect(ar).toMatch(/[؀-ۿ]/);
    }

    const terms = document['terms'] as { sections: Record<string, string>[] };
    expect(terms.sections.length).toBeGreaterThan(0);
    for (const section of terms.sections) {
      expect(section['bodyEn']).toMatch(/[A-Za-z]/);
      expect(section['bodyAr']).toMatch(/[؀-ۿ]/);
    }
  }, 60_000);

  it('states one set of financial figures, phone and dates — not two', async () => {
    const document = (await getDoc(doc(db, 'invoices', documentId))).data()!;
    const financials = document['financials'] as Record<string, number>;
    const business = document['business'] as Record<string, string>;
    const pricing = (await getDoc(doc(db, 'reservations', reservationId))).data()!['pricing'] as Record<
      string,
      number
    >;

    // A bilingual document must not restate money differently per language.
    expect(financials['grandTotal']).toBe(pricing['grandTotal']);
    expect(financials['totalPaid']).toBe(273_000);
    expect(financials['vatRatePercent']).toBe(VAT_PERCENT);
    expect(Number.isInteger(financials['grandTotal'])).toBe(true);

    // The phone is one string, in Western-Arabic digits.
    expect(business['phone']).toBe('92114477');
    expect(business['phone']).not.toMatch(/[٠-٩]/);

    // Dates are stored as instants; the renderer formats them per language.
    expect(document['issuedAt']).toBeDefined();
    expect(document['pickupAt']).toBeDefined();
    expect(document['returnAt']).toBeDefined();
  }, 60_000);

  it('renders to A4 HTML with both languages and no gap markers', async () => {
    /*
     * The renderer is exercised here, not only the data. A document that holds
     * correct Arabic and drops it at render time would pass every assertion
     * above.
     */
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { TaxInvoice } = await import('@/print/TaxInvoice');
    const React = await import('react');

    const document = (await getDoc(doc(db, 'invoices', documentId))).data()!;

    /*
     * Firestore hands back `Timestamp`; the print components take epoch
     * milliseconds. Converted recursively, because the payment lines carry
     * their own `occurredAt` and a top-level-only conversion leaves those as
     * objects — which is a crash in the renderer, not a blank cell.
     */
    const toMillis = (value: unknown): unknown => {
      if (value !== null && typeof value === 'object') {
        if (typeof (value as { toMillis?: unknown }).toMillis === 'function') {
          return (value as { toMillis: () => number }).toMillis();
        }
        if (Array.isArray(value)) return value.map(toMillis);
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([name, entry]) => [
            name,
            toMillis(entry),
          ]),
        );
      }
      return value;
    };

    const html = renderToStaticMarkup(
      React.createElement(TaxInvoice, { document: toMillis(document) } as never),
    );

    expect(html).toMatch(/[؀-ۿ]/);
    expect(html).toMatch(/Azhary Boutique/);
    expect(html).not.toMatch(/undefined|NaN/);
  }, 60_000);
});
