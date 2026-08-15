/**
 * The offline refusals, at the service layer — Phase 10 §26.
 *
 * `connectivity.test.ts` proves the *rule*: which operations need the server
 * and why. This proves the **wiring** — that the services actually consult it
 * before reaching a Cloud Function.
 *
 * The distinction matters because the rule and the wiring fail independently. A
 * perfect `GUARDED_OPERATIONS` table protects nothing if `recordPayment` never
 * calls the guard, and that omission is invisible in every test that runs with
 * a connection. Nothing here would have caught a missing call site until a
 * boutique's tablet lost signal mid-payment.
 *
 * Each operation is exercised through its **real service function** with
 * `navigator.onLine` forced false, and must throw before any network call. The
 * Firebase client is mocked to throw loudly if it is reached at all, so a
 * service that skipped the guard fails with "reached the network" rather than
 * quietly passing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GUARDED_OPERATIONS, refusalFor } from '@/domain/connectivity';

/** Reaching this is the failure the suite exists to catch. */
const reachedTheNetwork = vi.fn(() => {
  throw new Error('The service reached the network while offline — the guard was not consulted.');
});

vi.mock('@/lib/firebase/client', () => ({
  getFirebaseClient: () => ({
    db: {},
    auth: {},
    storage: {},
    functions: {},
  }),
  FUNCTIONS_REGION: 'europe-west1',
}));

vi.mock('firebase/functions', () => ({
  httpsCallable: () => reachedTheNetwork,
  getFunctions: vi.fn(),
  connectFunctionsEmulator: vi.fn(),
}));

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase/firestore');
  return {
    ...actual,
    getDoc: reachedTheNetwork,
    getDocs: reachedTheNetwork,
    setDoc: reachedTheNetwork,
    addDoc: reachedTheNetwork,
    updateDoc: reachedTheNetwork,
    runTransaction: reachedTheNetwork,
    collection: vi.fn(() => ({})),
    doc: vi.fn(() => ({})),
    query: vi.fn(() => ({})),
    where: vi.fn(() => ({})),
    orderBy: vi.fn(() => ({})),
    serverTimestamp: vi.fn(() => ({})),
  };
});

let onLine = true;

beforeEach(() => {
  onLine = false;
  Object.defineProperty(globalThis.navigator, 'onLine', {
    configurable: true,
    get: () => onLine,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------------ *
 * The refusals
 * ------------------------------------------------------------------------ */

describe('operations that must be refused offline', () => {
  it('refuses to CREATE A RESERVATION', async () => {
    const { createReservation } = await import('./reservations.service');

    await expect(
      createReservation({
        customerId: 'c-1',
        dressIds: ['d-1'],
        pickupAt: '2027-01-02T10:00',
        returnAt: '2027-01-06T18:00',
        eventDate: '2027-01-04',
        notes: '',
      }),
    ).rejects.toThrow(refusalFor('reservation.create'));

    expect(reachedTheNetwork).not.toHaveBeenCalled();
  });

  it('refuses to CHANGE RESERVATION DATES', async () => {
    const { updateReservationDates } = await import('./reservations.service');

    await expect(
      updateReservationDates({
        reservationId: 'r-1',
        pickupAt: '2027-01-02T10:00',
        returnAt: '2027-01-06T18:00',
        eventDate: '2027-01-04',
      }),
    ).rejects.toThrow(refusalFor('reservation.changeDates'));

    expect(reachedTheNetwork).not.toHaveBeenCalled();
  });

  it('refuses to CHANGE RESERVATION STATUS', async () => {
    const { changeReservationStatus } = await import('./reservations.service');

    await expect(
      changeReservationStatus({ reservationId: 'r-1', status: 'Picked Up' }),
    ).rejects.toThrow(refusalFor('reservation.changeStatus'));

    expect(reachedTheNetwork).not.toHaveBeenCalled();
  });

  it('refuses to RECORD A PAYMENT', async () => {
    const { recordPayment } = await import('./payments.service');

    await expect(
      recordPayment({
        reservationId: 'r-1',
        amount: 100_000 as never,
        method: 'Cash',
        type: 'Deposit',
        occurredAt: '2027-01-01T10:00',
        reference: '',
        idempotencyKey: 'offline-guard-0001',
      }),
    ).rejects.toThrow(refusalFor('payment.record'));

    expect(reachedTheNetwork).not.toHaveBeenCalled();
  });

  it('refuses to RECORD A SECURITY DEPOSIT', async () => {
    const { recordSecurityDeposit } = await import('./payments.service');

    await expect(
      recordSecurityDeposit({
        reservationId: 'r-1',
        amount: 100_000 as never,
        method: 'Cash',
        occurredAt: '2027-01-01T10:00',
        reference: '',
        idempotencyKey: 'offline-guard-0002',
      }),
    ).rejects.toThrow(refusalFor('payment.record'));

    expect(reachedTheNetwork).not.toHaveBeenCalled();
  });

  it('refuses to REFUND', async () => {
    const { refundPayment } = await import('./payments.service');

    await expect(
      refundPayment({
        reservationId: 'r-1',
        amount: 10_000 as never,
        method: 'Cash',
        reference: '',
        reason: 'x',
        idempotencyKey: 'offline-guard-0003',
      }),
    ).rejects.toThrow(refusalFor('payment.refund'));

    expect(reachedTheNetwork).not.toHaveBeenCalled();
  });

  it('refuses to SETTLE A DEPOSIT', async () => {
    const { settleDeposit } = await import('./payments.service');

    await expect(
      settleDeposit({
        reservationId: 'r-1',
        amount: 10_000 as never,
        forfeit: false,
        reason: 'x',
        method: 'Cash',
        reference: '',
        idempotencyKey: 'offline-guard-0004',
      }),
    ).rejects.toThrow(refusalFor('deposit.settle'));

    expect(reachedTheNetwork).not.toHaveBeenCalled();
  });

  it('refuses to ISSUE A DOCUMENT', async () => {
    const { issueDocument } = await import('./documents.service');

    await expect(
      issueDocument({
        reservationId: 'r-1',
        documentType: 'Tax Invoice',
        language: 'en',
        notes: '',
        idempotencyKey: 'offline-guard-0005',
      }),
    ).rejects.toThrow(refusalFor('document.issue'));

    expect(reachedTheNetwork).not.toHaveBeenCalled();
  });

  it('refuses to VOID A DOCUMENT', async () => {
    const { voidDocument } = await import('./documents.service');

    await expect(voidDocument({ documentId: 'i-1', reason: 'wrong reservation' })).rejects.toThrow(
      refusalFor('document.void'),
    );

    expect(reachedTheNetwork).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------ *
 * The message
 * ------------------------------------------------------------------------ */

describe('what the employee is told', () => {
  it('names what the application was about to do, not merely "offline"', () => {
    /*
     * "You are offline" tells an employee nothing they cannot see from the
     * banner. The refusal has to say why THIS action needs the server, because
     * that is the part they might otherwise argue with.
     */
    const booking = refusalFor('reservation.create');
    const payment = refusalFor('payment.record');

    expect(booking).not.toBe(payment);
    expect(booking.length).toBeGreaterThan(20);
    expect(payment.length).toBeGreaterThan(20);
  });

  it('has a refusal for every guarded operation, with no gaps', () => {
    for (const operation of GUARDED_OPERATIONS) {
      const message = refusalFor(operation);

      expect(message, operation).toBeTruthy();
      expect(message, operation).not.toMatch(/undefined|null/);
    }
  });
});
