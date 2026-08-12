/**
 * Firestore security rules — Phase 1 posture.
 *
 * Phase 1 declares that everything is denied. This suite proves it rather than
 * asserting it: an unauthenticated visitor, a signed-in user with no role, an
 * active STAFF member, an active OWNER and a deactivated user are each refused
 * every operation, because no collection rules exist yet.
 *
 * As Phase 2 adds collection rules, the corresponding cases move out of this
 * file into per-collection suites carrying both allow and deny assertions
 * (SECURITY.md §8). The catch-all denial at the end of firestore.rules stays,
 * and the "collection nobody defined" case below stays with it — permanently.
 * That case is the regression guard against a future rule accidentally opening
 * paths it did not intend to.
 *
 * Run with:  npm run test:rules
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import type { Firestore } from 'firebase/firestore';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const rulesPath = fileURLToPath(new URL('../../firestore.rules', import.meta.url));

/** Identities named in specification §56, plus the two edge cases that matter. */
const IDENTITY_NAMES = [
  'unauthenticated',
  'signed in with no role claim',
  'STAFF',
  'OWNER',
  'deactivated STAFF',
] as const;

type IdentityName = (typeof IDENTITY_NAMES)[number];

/** Collections from DATABASE.md, plus one that does not exist by design. */
const COLLECTIONS = [
  'users',
  'businessProfile',
  'settings',
  'counters',
  'dresses',
  'customers',
  'reservations',
  'reservationItems',
  'fittings',
  'accessories',
  'payments',
  'invoices',
  'damageLogs',
  'waitlist',
  'notificationLogs',
  'auditLogs',
  'termsVersions',
  'someCollectionNobodyDefined',
] as const;

let testEnv: RulesTestEnvironment;
const databases = new Map<IdentityName, Firestore>();

/**
 * `@firebase/rules-unit-testing` types `firestore()` as the *compat* Firestore
 * surface, while the modular `getDoc`/`setDoc` helpers expect the modular type.
 * The underlying instance is the same object; only the published typings differ.
 * The cast is isolated here so no assertion is scattered through the tests.
 */
function modularFirestore(context: RulesTestContext): Firestore {
  return context.firestore() as unknown as Firestore;
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-azhary-rules',
    firestore: {
      rules: readFileSync(rulesPath, 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });

  databases.set('unauthenticated', modularFirestore(testEnv.unauthenticatedContext()));
  databases.set(
    'signed in with no role claim',
    modularFirestore(testEnv.authenticatedContext('user-without-claims')),
  );
  databases.set(
    'STAFF',
    modularFirestore(testEnv.authenticatedContext('staff-user', { role: 'STAFF', active: true })),
  );
  databases.set(
    'OWNER',
    modularFirestore(testEnv.authenticatedContext('owner-user', { role: 'OWNER', active: true })),
  );
  databases.set(
    'deactivated STAFF',
    modularFirestore(
      testEnv.authenticatedContext('inactive-user', { role: 'STAFF', active: false }),
    ),
  );
});

afterAll(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

function dbFor(identity: IdentityName): Firestore {
  const db = databases.get(identity);
  if (!db) throw new Error(`No Firestore handle prepared for identity "${identity}".`);
  return db;
}

describe('firestore rules — Phase 1 denies every collection to every identity', () => {
  describe.each(IDENTITY_NAMES)('as %s', (identity) => {
    it.each(COLLECTIONS)('cannot read a document in %s', async (collectionName) => {
      await assertFails(getDoc(doc(dbFor(identity), collectionName, 'any-document')));
    });

    it.each(COLLECTIONS)('cannot list %s', async (collectionName) => {
      await assertFails(getDocs(collection(dbFor(identity), collectionName)));
    });

    it.each(COLLECTIONS)('cannot create a document in %s', async (collectionName) => {
      await assertFails(setDoc(doc(dbFor(identity), collectionName, 'any-document'), { value: 1 }));
    });

    it.each(COLLECTIONS)('cannot delete a document in %s', async (collectionName) => {
      await assertFails(deleteDoc(doc(dbFor(identity), collectionName, 'any-document')));
    });
  });

  it('denies nested subcollection paths, not merely top-level collections', async () => {
    const owner = dbFor('OWNER');
    await assertFails(getDoc(doc(owner, 'dresses/wd-1/private/cost')));
    await assertFails(setDoc(doc(owner, 'reservations/rsv-1/items/item-1'), { value: 1 }));
    await assertFails(getDocs(collection(owner, 'dresses/wd-1/private')));
  });
});
