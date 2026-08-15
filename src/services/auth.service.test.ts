/**
 * Sign-out on a shared tablet — §37, §38.
 *
 * The boutique's devices are shared. The question this file answers is the one
 * that matters after an employee taps "Sign out" and hands the tablet over:
 * **is the previous session's data still reachable?**
 *
 * Firestore is mocked here rather than run against the emulator, because what is
 * being asserted is the *order and completeness of the teardown*, and node has
 * no IndexedDB to clear. The emulator suites cover the rules; this covers the
 * three steps that have to happen on the device, one of which — the page load —
 * leaves no trace to assert on afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const firebaseSignOut = vi.fn(async () => {});
const terminate = vi.fn(async () => {});
const clearIndexedDbPersistence = vi.fn(async () => {});

vi.mock('firebase/auth', () => ({
  signOut: (...args: unknown[]) => firebaseSignOut(...(args as [])),
  getAuth: vi.fn(),
  onAuthStateChanged: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  terminate: (...args: unknown[]) => terminate(...(args as [])),
  clearIndexedDbPersistence: (...args: unknown[]) => clearIndexedDbPersistence(...(args as [])),
  doc: vi.fn(),
  onSnapshot: vi.fn(),
  serverTimestamp: vi.fn(),
  setDoc: vi.fn(),
  Timestamp: { fromMillis: vi.fn() },
}));

vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn(() => vi.fn()) }));

vi.mock('@/lib/firebase/client', () => ({
  getFirebaseClient: () => ({
    auth: { name: 'auth' },
    db: { name: 'db' },
    functions: { name: 'functions' },
  }),
  FUNCTIONS_REGION: 'europe-west1',
}));

const { signOut } = await import('./auth.service');

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign, href: 'http://localhost/customers/abc' },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('signOut()', () => {
  it('drops the token, the disk cache and the page — all three', () => {
    return signOut().then(() => {
      expect(firebaseSignOut).toHaveBeenCalledOnce();
      expect(terminate).toHaveBeenCalledOnce();
      expect(clearIndexedDbPersistence).toHaveBeenCalledOnce();
      expect(assign).toHaveBeenCalledWith('/');
    });
  });

  it('clears the cache only after the token is gone', async () => {
    const order: string[] = [];

    firebaseSignOut.mockImplementationOnce(async () => {
      order.push('auth');
    });
    clearIndexedDbPersistence.mockImplementationOnce(async () => {
      order.push('cache');
    });

    await signOut();

    /*
     * Order matters. Clearing first would leave a window in which the session is
     * still valid and the cache is repopulating from live listeners.
     */
    expect(order).toEqual(['auth', 'cache']);
  });

  it('still leaves the tab when the cache cannot be cleared', async () => {
    /*
     * Another open tab holds the IndexedDB database, so clearing throws. An
     * employee who tapped "Sign out" must still be signed out — a failed cleanup
     * step is not a reason to leave a session open on a shared tablet.
     */
    clearIndexedDbPersistence.mockRejectedValueOnce(new Error('still open in another tab'));

    await expect(signOut()).resolves.toBeUndefined();

    expect(firebaseSignOut).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith('/');
  });

  it('lands on the sign-in screen, not on whatever was open', async () => {
    /*
     * The tablet was showing a customer. Reloading in place would show that
     * customer's record to the next person until the redirect caught up.
     */
    await signOut();

    expect(assign).toHaveBeenCalledWith('/');
    expect(assign).not.toHaveBeenCalledWith(expect.stringContaining('customers'));
  });
});
