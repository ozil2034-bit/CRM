import { describe, it, expect, beforeEach } from 'vitest';
import { getFirebaseClient, isFirebaseInitialized, resetFirebaseClientForTests } from './client';

/**
 * These tests cover the guards around initialisation order.
 *
 * Actually initialising the SDK is not exercised here: `initializeFirestore`
 * with persistent local cache requires IndexedDB, which jsdom does not provide,
 * so a test that "initialises Firebase" in this environment would be testing a
 * shim rather than the real path. Initialisation is covered for real by the
 * emulator-backed service tests from Phase 2 onward (TESTING.md §4).
 */
describe('firebase client', () => {
  beforeEach(() => {
    resetFirebaseClientForTests();
  });

  it('reports that it is not initialised before startup runs', () => {
    expect(isFirebaseInitialized()).toBe(false);
  });

  it('throws a directive error rather than returning undefined handles', () => {
    // Returning `undefined` here would surface much later as an unrelated
    // Firebase error; failing at the point of misuse names the actual bug.
    expect(() => getFirebaseClient()).toThrow(/has not been initialised/);
    expect(() => getFirebaseClient()).toThrow(/initializeFirebase\(\)/);
  });
});
