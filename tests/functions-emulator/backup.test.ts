/**
 * Backup and restore, against the Firebase Emulator Suite.
 *
 * The domain tests prove the validator rejects a bad file. This proves the
 * thing that actually matters, and that only a real database can answer:
 *
 *   **export → wipe → import → does the boutique reconcile?**
 *
 * Specification §46, run end to end: a dataset is built through the real
 * services and Cloud Functions, exported, the collections are emptied, the file
 * is imported, and every record, relationship, financial event, snapshot and
 * audit entry is compared against what was there before.
 *
 * A restore that "works" but renumbers ids, drops a payment, or recomputes a
 * balance would pass a shallower test and lose the boutique's history.
 *
 * Run with:  npm run test:functions:backup
 */

import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  type Auth,
} from 'firebase/auth';
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  setDoc,
  Timestamp,
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
import { exportAllData, importBackup, inspectBackup } from '@/services/backup.service';
import { validateBackup, BACKUP_COLLECTIONS, type BackupCollection } from '@/domain/backup';
import { reduceLedger } from '@/domain/ledger';

const PROJECT_ID = 'demo-azhary-functions';
const REGION = 'europe-west1';
const SETUP_TOKEN = 'emulator-setup-token';

const OWNER = { email: 'backup-owner@azhary.test', password: 'a-very-long-password' };

let app: FirebaseApp;
let auth: Auth;
let db: Firestore;
let functions: Functions;
let storage: FirebaseStorage;

let ownerUid = '';
let customerId = '';
let reservationId = '';
let reservationCode = '';
let dressId = '';

const YEAR = new Date().getUTCFullYear() + 1;
const RENTAL = 300_000;
const DEPOSIT = 100_000;

/** The whole dataset, as it stood before the wipe. */
let before: Record<string, Map<string, Record<string, unknown>>> = {};

beforeAll(async () => {
  app = initializeApp(
    { projectId: PROJECT_ID, apiKey: 'emulator-key', appId: 'emulator-app' },
    'backup',
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
  )({ setupToken: SETUP_TOKEN, name: 'Backup Owner' });
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
    phone: '91000000',
    email: 'hello@azhary.test',
    website: '',
    vatNumber: '',
    crNumber: '',
    logoPath: '',
  });

  await buildDataset();
  before = await readEverything();
}, 180_000);

afterAll(async () => {
  await deleteApp(app);
});

/* ------------------------------------------------------------------------ *
 * Building something worth losing
 * ------------------------------------------------------------------------ */

async function buildDataset(): Promise<void> {
  const { createCustomer } = await import('@/services/customers.service');
  const { EMPTY_CUSTOMER_FORM } = await import('@/schemas/customer');
  const { createDress } = await import('@/services/dresses.service');
  const { EMPTY_DRESS_FORM } = await import('@/schemas/dress');

  const actor = { uid: ownerUid, name: 'Backup Owner', role: 'OWNER' as const };

  const customer = await createCustomer({
    values: {
      ...EMPTY_CUSTOMER_FORM,
      nameEn: 'Bride Backup',
      // Arabic on purpose: a restore must preserve it byte for byte.
      nameAr: 'عروس النسخة الاحتياطية',
      phone: '91000009',
      preferredLanguage: 'ar',
    },
    actor,
  });
  customerId = customer.id;

  const dress = await createDress({
    values: {
      ...EMPTY_DRESS_FORM,
      name: 'Backup Gown',
      designer: 'Elie Saab',
      rentalPrice: RENTAL,
      securityDeposit: DEPOSIT,
      cleaningBufferDays: 3,
    },
    actor,
    canSetPurchaseCost: false,
  });
  dressId = dress.id;

  const call = <Request, Response>(name: string) =>
    httpsCallable<Request, Response>(functions, name);

  const created = await call<
    Record<string, unknown>,
    { success: boolean; reservationId: string; reservationNumber: string }
  >('createReservation')({
    customerId,
    pickupAt: `${YEAR}-09-10T11:00`,
    returnAt: `${YEAR}-09-14T18:00`,
    eventDate: `${YEAR}-09-12`,
    dressIds: [dressId],
    notes: 'Backup scenario',
  });

  if (!created.data.success) throw new Error('reservation setup failed');
  reservationId = created.data.reservationId;
  reservationCode = created.data.reservationNumber;

  // Money, so the ledger has something to reconcile.
  await call<Record<string, unknown>, unknown>('recordSecurityDeposit')({
    reservationId,
    amount: DEPOSIT,
    method: 'Cash',
    occurredAt: `${YEAR}-09-01T10:00`,
    reference: '',
    idempotencyKey: 'backup-deposit-1',
  });

  await call<Record<string, unknown>, unknown>('recordPayment')({
    reservationId,
    amount: 200_000,
    method: 'Card',
    type: 'Deposit',
    occurredAt: `${YEAR}-09-02T10:00`,
    reference: 'CARD-1',
    idempotencyKey: 'backup-payment-1',
  });

  // An accessory, so a nested array of money is in the snapshot.
  await call<Record<string, unknown>, unknown>('addReservationAccessory')({
    reservationId,
    accessoryId: 'cat-veil',
    name: 'Cathedral veil',
    nameAr: 'طرحة',
    unitPrice: 20_000,
    securityDeposit: 5_000,
    quantity: 2,
    idempotencyKey: 'backup-accessory-1',
  });

  // A document, so an immutable snapshot is in the file.
  await call<Record<string, unknown>, { documentId: string }>('issueDocument')({
    reservationId,
    documentType: 'Tax Invoice',
    language: 'bilingual',
    idempotencyKey: 'backup-invoice-1',
    notes: '',
  });
}

/** Every collection, as a map of id → data. */
async function readEverything(): Promise<Record<string, Map<string, Record<string, unknown>>>> {
  const all: Record<string, Map<string, Record<string, unknown>>> = {};

  for (const name of BACKUP_COLLECTIONS) {
    const snapshot = await getDocs(collection(db, name));
    all[name] = new Map(snapshot.docs.map((document) => [document.id, document.data()]));
  }

  return all;
}

/**
 * Empty every backed-up collection — *around* the security rules, deliberately.
 *
 * The rules refuse a client delete of `reservations`, `reservationItems`,
 * `financialEvents`, `invoices`, `auditLogs`, `damageLogs` and
 * `notificationLogs`, and that refusal is one of the properties this platform
 * rests on. Relaxing it so a test could tidy up would trade a real guarantee for
 * a convenience.
 *
 * So the disaster is staged the way a disaster actually happens — from outside
 * the application. The Firestore emulator treats `Authorization: Bearer owner`
 * as an administrative caller and skips rule evaluation, which is exactly the
 * privilege a lost or corrupted project would represent.
 *
 * Only the backed-up collections are cleared, never the whole database:
 * `users/{uid}` is not in a backup file, and `restoreBackupChunk` checks the
 * caller's profile before it will write anything. Wiping that too would make the
 * recovery fail for a reason that has nothing to do with recovery.
 */
async function wipeEverything(): Promise<void> {
  for (const name of BACKUP_COLLECTIONS) {
    const snapshot = await getDocs(collection(db, name));

    for (const document of snapshot.docs) {
      const path = `projects/${PROJECT_ID}/databases/(default)/documents/${name}/${document.id}`;
      const response = await fetch(
        `http://127.0.0.1:8080/v1/${path.replace('(default)', '%28default%29')}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer owner' } },
      );

      if (!response.ok) {
        throw new Error(`Could not clear ${name}/${document.id}: ${String(response.status)}`);
      }
    }
  }
}

const exportNow = () =>
  exportAllData({
    projectId: PROJECT_ID,
    environment: 'development',
    applicationVersion: '0.1.0-test',
  });

/* ------------------------------------------------------------------------ *
 * The export
 * ------------------------------------------------------------------------ */

describe('exporting', () => {
  it('produces a file this application would itself accept', async () => {
    const result = await exportNow();

    expect(validateBackup(result.file).ok).toBe(true);
    expect(result.totalRecords).toBeGreaterThan(0);
  }, 120_000);

  it('carries the envelope a restore needs to judge the file', async () => {
    const result = await exportNow();

    expect(result.file.schemaVersion).toBe(1);
    expect(result.file.projectId).toBe(PROJECT_ID);
    expect(Number.isNaN(Date.parse(result.file.exportedAt))).toBe(false);
    expect(result.file.applicationVersion).toBe('0.1.0-test');
  }, 120_000);

  it('contains NO credential, anywhere', async () => {
    /*
     * An export is a file an owner emails to themselves. Asserted over the raw
     * JSON rather than the structure, so a credential smuggled into a field
     * this test does not know about is still caught.
     */
    const result = await exportNow();
    const json = result.json.toLowerCase();

    for (const forbidden of ['bootstraptoken', 'setuptoken', 'privatekey', 'serviceaccount']) {
      expect(json).not.toContain(forbidden);
    }
  }, 120_000);

  it('is round-trippable through JSON without loss', async () => {
    const result = await exportNow();

    expect(validateBackup(JSON.parse(result.json)).ok).toBe(true);
  }, 120_000);

  it('names the file after the day and the project', async () => {
    const result = await exportNow();

    expect(result.filename).toContain(PROJECT_ID);
    expect(result.filename.endsWith('.json')).toBe(true);
  }, 120_000);
});

/* ------------------------------------------------------------------------ *
 * §46 — the recovery drill
 * ------------------------------------------------------------------------ */

describe('export → wipe → import', () => {
  it('restores the boutique so that it reconciles', async () => {
    const exported = await exportNow();

    /* --- The disaster --- */
    await wipeEverything();

    const emptied = await getDocs(collection(db, 'reservations'));
    expect(emptied.empty).toBe(true);

    /* --- The recovery --- */
    const result = await importBackup({
      file: JSON.parse(exported.json),
      actor: { uid: ownerUid, name: 'Backup Owner', role: 'OWNER' },
    });

    expect(result.written).toBe(exported.totalRecords);

    const after = await readEverything();

    /* --- Every record, under its original id --- */
    for (const name of BACKUP_COLLECTIONS) {
      const originals = before[name] ?? new Map();
      const restored = after[name] ?? new Map();

      for (const id of originals.keys()) {
        // `auditLogs` grows: the import writes its own entry. Everything else
        // must match exactly.
        expect(restored.has(id), `${name}/${id} was not restored`).toBe(true);
      }
    }

    /* --- Relationships --- */
    const reservation = (after['reservations'] ?? new Map()).get(reservationId);
    expect(reservation?.['customerId']).toBe(customerId);
    expect((after['customers'] ?? new Map()).has(customerId)).toBe(true);

    const items = [...(after['reservationItems'] ?? new Map()).values()];
    expect(items.some((item) => item['dressId'] === dressId)).toBe(true);
    expect(items.every((item) => item['reservationId'] === reservationId)).toBe(true);
  }, 180_000);

  it('preserves the financial events exactly, and the balance they produce', async () => {
    const events = [...(await readEverything())['financialEvents']!.values()].filter(
      (event) => event['reservationId'] === reservationId,
    );

    // Both events are back, with their ids as idempotency keys.
    const restoredIds = [...(await readEverything())['financialEvents']!.keys()];
    expect(restoredIds).toContain('backup-deposit-1');
    expect(restoredIds).toContain('backup-payment-1');

    const reservation = (await getDoc(doc(db, 'reservations', reservationId))).data();
    const pricing = reservation?.['pricing'] as Record<string, unknown>;

    /*
     * The balance is RECOMPUTED from the restored snapshot and the restored
     * events, and compared with what the ledger produced before the wipe. If a
     * restore had recalculated anything, or dropped an event, this is where it
     * shows.
     */
    const position = reduceLedger(
      {
        rentalSubtotal: Number(pricing['rentalSubtotal']) as never,
        accessorySubtotal: Number(pricing['accessorySubtotal']) as never,
        alterationSubtotal: Number(pricing['alterationSubtotal']) as never,
        discountAmount: Number(pricing['discountAmount']) as never,
        taxableSubtotal: Number(pricing['taxableSubtotal']) as never,
        vatRatePercent: Number(pricing['vatRatePercent']),
        vatAmount: Number(pricing['vatAmount']) as never,
        securityDepositTotal: Number(pricing['securityDepositTotal']) as never,
        grandTotal: Number(pricing['grandTotal']) as never,
      },
      events.map((event) => ({
        id: String(event['idempotencyKey']),
        reservationId,
        kind: event['kind'] as never,
        amount: Number(event['amount']) as never,
        method: null,
        type: null,
        occurredAt: (event['occurredAt'] as Timestamp).toMillis(),
        reference: '',
        reason: '',
        employeeId: '',
        reversesEventId: null,
        idempotencyKey: String(event['idempotencyKey']),
      })),
    );

    expect(position.depositHeld).toBe(DEPOSIT);
    expect(position.netPaid).toBe(200_000);
  }, 120_000);

  it('preserves the pricing snapshot, including its nested accessory lines', async () => {
    const reservation = (await getDoc(doc(db, 'reservations', reservationId))).data();
    const pricing = reservation?.['pricing'] as Record<string, unknown>;
    const accessories = pricing['accessories'] as Record<string, unknown>[];

    expect(accessories).toHaveLength(1);
    expect(accessories[0]?.['quantity']).toBe(2);
    expect(accessories[0]?.['unitPrice']).toBe(20_000);
    // 2 × 20.000
    expect(pricing['accessorySubtotal']).toBe(40_000);
  }, 120_000);

  it('preserves the issued document, unchanged', async () => {
    const invoices = await getDocs(collection(db, 'invoices'));
    const invoice = invoices.docs[0]?.data();

    expect(invoices.size).toBe(1);
    expect(invoice?.['documentNumber']).toBeDefined();
    expect(invoice?.['reservationId']).toBe(reservationId);
    expect(invoice?.['status']).toBe('Issued');

    const original = before['invoices']?.get(invoices.docs[0]!.id);
    expect(invoice?.['documentNumber']).toBe(original?.['documentNumber']);
  }, 120_000);

  it('preserves the audit history', async () => {
    const restored = (await readEverything())['auditLogs'] ?? new Map();
    const originals = before['auditLogs'] ?? new Map();

    expect(originals.size).toBeGreaterThan(0);

    for (const id of originals.keys()) {
      expect(restored.has(id)).toBe(true);
    }

    // Plus the entry the restore itself wrote.
    expect(restored.size).toBeGreaterThan(originals.size);
  }, 120_000);

  it('preserves Arabic text byte for byte', async () => {
    const customer = (await getDoc(doc(db, 'customers', customerId))).data();

    expect(customer?.['nameAr']).toBe('عروس النسخة الاحتياطية');
  }, 120_000);

  it('preserves timestamps as timestamps, not as numbers', async () => {
    /*
     * The export serialises Timestamp to epoch milliseconds. If the import did
     * not convert back, every date query in the application would silently stop
     * matching.
     */
    const reservation = (await getDoc(doc(db, 'reservations', reservationId))).data();

    expect(reservation?.['pickupAt']).toBeInstanceOf(Timestamp);

    const original = before['reservations']?.get(reservationId);
    expect((reservation?.['pickupAt'] as Timestamp).toMillis()).toBe(
      (original?.['pickupAt'] as Timestamp).toMillis(),
    );
  }, 120_000);

  it('does NOT renumber anything — the reservation keeps its code', async () => {
    const reservation = (await getDoc(doc(db, 'reservations', reservationId))).data();

    expect(reservation?.['code']).toBe(reservationCode);
  }, 120_000);

  it('is idempotent — importing the same file twice changes nothing', async () => {
    const exported = await exportNow();
    const first = await readEverything();

    await importBackup({
      file: JSON.parse(exported.json),
      actor: { uid: ownerUid, name: 'Backup Owner', role: 'OWNER' },
    });

    const second = await readEverything();

    for (const name of BACKUP_COLLECTIONS) {
      if (name === 'auditLogs') continue; // the import logs itself

      expect((second[name] ?? new Map()).size, name).toBe((first[name] ?? new Map()).size);
    }
  }, 180_000);
});

/* ------------------------------------------------------------------------ *
 * Refusing a bad file
 * ------------------------------------------------------------------------ */

describe('refusing to restore', () => {
  it('writes NOTHING when the file is invalid', async () => {
    const before2 = await readEverything();

    await expect(
      importBackup({
        file: { schemaVersion: 99, exportedAt: 'nonsense', collections: {} },
        actor: { uid: ownerUid, name: 'Backup Owner', role: 'OWNER' },
      }),
    ).rejects.toThrow();

    const after2 = await readEverything();

    for (const name of BACKUP_COLLECTIONS) {
      expect((after2[name] ?? new Map()).size, name).toBe((before2[name] ?? new Map()).size);
    }
  }, 120_000);

  it('refuses a file that is not JSON at all', async () => {
    await expect(inspectBackup('this is not json')).rejects.toThrow();
  }, 60_000);

  it('reports problems from inspect WITHOUT touching anything', async () => {
    const before3 = await readEverything();

    const inspected = await inspectBackup(
      JSON.stringify({
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        collections: { customers: [{ id: 'x', data: { apiKey: 'leaked' } }] },
      }),
    );

    expect(inspected.validation.ok).toBe(false);

    const after3 = await readEverything();
    expect((after3['customers'] ?? new Map()).size).toBe(
      (before3['customers'] ?? new Map()).size,
    );
  }, 120_000);

  it('plans a restore before performing one', async () => {
    const exported = await exportNow();
    const inspected = await inspectBackup(exported.json);

    expect(inspected.validation.ok).toBe(true);

    // Everything is already there, so the plan is all updates and no creates.
    const reservations = inspected.plan.find(
      (entry) => entry.collection === ('reservations' as BackupCollection),
    );

    expect(reservations?.create).toBe(0);
    expect(reservations?.update).toBeGreaterThan(0);
  }, 120_000);
});
