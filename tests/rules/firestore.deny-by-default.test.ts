/**
 * Deny-by-default — the Phase 1 assertions that remain correct, preserved.
 *
 * Phase 1 asserted that five identities were refused every operation on every
 * collection, because no collection rules existed yet. Phase 2 grants OWNER and
 * STAFF access to business collections, so their denials on those collections
 * are assertions Phase 2 is defined to invert — they move to
 * firestore.authorization.test.ts, which asserts the same ground with explicit
 * ALLOW and DENY cases.
 *
 * Everything that must still be denied is preserved here, and extended: Phase 1
 * had three always-denied identities, this has six. Two of the additions —
 * a valid claim with no profile, and a forged role value — became reachable only
 * once roles were resolved from two sources.
 *
 * The undefined collection and the nested subcollection cases stay permanently.
 * They guard the catch-all rule against a future collection rule opening paths
 * it did not intend to.
 */

import { assertFails, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, describe, it } from 'vitest';

import {
  ALL_COLLECTIONS,
  ALWAYS_DENIED,
  createFirestoreTestEnvironment,
  dbAs,
  seedIdentities,
  uniqueId,
} from './helpers';

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await createFirestoreTestEnvironment();
  await testEnv.clearFirestore();
  await seedIdentities(testEnv);
});

afterAll(async () => {
  await testEnv?.cleanup();
});

describe('every collection is closed to identities that hold no access', () => {
  describe.each(ALWAYS_DENIED)('as %s', (identity) => {
    it.each(ALL_COLLECTIONS)('cannot read a document in %s', async (collectionName) => {
      await assertFails(getDoc(doc(dbAs(testEnv, identity), collectionName, uniqueId())));
    });

    it.each(ALL_COLLECTIONS)('cannot list %s', async (collectionName) => {
      await assertFails(getDocs(collection(dbAs(testEnv, identity), collectionName)));
    });

    it.each(ALL_COLLECTIONS)('cannot create a document in %s', async (collectionName) => {
      await assertFails(
        setDoc(doc(dbAs(testEnv, identity), collectionName, uniqueId()), { value: 1 }),
      );
    });

    it.each(ALL_COLLECTIONS)('cannot delete a document in %s', async (collectionName) => {
      await assertFails(deleteDoc(doc(dbAs(testEnv, identity), collectionName, uniqueId())));
    });
  });
});

describe('the catch-all rule still closes undefined paths to employees', () => {
  for (const identity of ['staff', 'owner'] as const) {
    it(`refuses ${identity} a read of an undefined collection`, async () => {
      await assertFails(
        getDoc(doc(dbAs(testEnv, identity), 'someCollectionNobodyDefined', uniqueId())),
      );
    });

    it(`refuses ${identity} a list of an undefined collection`, async () => {
      await assertFails(
        getDocs(collection(dbAs(testEnv, identity), 'someCollectionNobodyDefined')),
      );
    });

    it(`refuses ${identity} a create in an undefined collection`, async () => {
      await assertFails(
        setDoc(doc(dbAs(testEnv, identity), 'someCollectionNobodyDefined', uniqueId()), {
          value: 1,
        }),
      );
    });

    it(`refuses ${identity} a delete in an undefined collection`, async () => {
      await assertFails(
        deleteDoc(doc(dbAs(testEnv, identity), 'someCollectionNobodyDefined', uniqueId())),
      );
    });
  }
});

describe('nested paths are denied, not merely top-level collections', () => {
  it('refuses an owner an undefined subcollection under a reservation', async () => {
    const owner = dbAs(testEnv, 'owner');
    await assertFails(getDoc(doc(owner, `reservations/${uniqueId()}/items/${uniqueId()}`)));
    await assertFails(
      setDoc(doc(owner, `reservations/${uniqueId()}/items/${uniqueId()}`), { value: 1 }),
    );
  });

  it('refuses an owner an undefined subcollection under a customer', async () => {
    const owner = dbAs(testEnv, 'owner');
    await assertFails(getDoc(doc(owner, `customers/${uniqueId()}/secrets/${uniqueId()}`)));
    await assertFails(getDocs(collection(owner, `customers/${uniqueId()}/secrets`)));
  });

  it('refuses staff a deeply nested arbitrary path', async () => {
    const staff = dbAs(testEnv, 'staff');
    await assertFails(getDoc(doc(staff, `a/${uniqueId()}/b/${uniqueId()}/c/${uniqueId()}`)));
  });
});
