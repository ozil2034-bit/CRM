/**
 * Shared fixtures for the security-rules suites.
 *
 * Phase 2 resolves a role from BOTH the Auth custom claim and the users/{uid}
 * document, so an identity is now a pair: a token and a seeded profile. The
 * fixtures below cover every combination that changes the outcome, including
 * the two stale-token cases that only exist because claims and documents can
 * disagree for up to an hour.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import type { Firestore } from 'firebase/firestore';
import { doc, setDoc } from 'firebase/firestore';

export const FIRESTORE_RULES_PATH = fileURLToPath(
  new URL('../../firestore.rules', import.meta.url),
);
export const STORAGE_RULES_PATH = fileURLToPath(new URL('../../storage.rules', import.meta.url));

export const PROJECT_ID = 'demo-azhary-rules';

/**
 * `@firebase/rules-unit-testing` types `firestore()` as the *compat* surface,
 * while the modular helpers expect the modular type. The underlying instance is
 * the same object; only the published typings differ. The cast is isolated here
 * so no assertion is scattered through the suites.
 */
export function modularFirestore(context: RulesTestContext): Firestore {
  return context.firestore() as unknown as Firestore;
}

/* ------------------------------------------------------------------------ *
 * Identities
 * ------------------------------------------------------------------------ */

export interface IdentityFixture {
  readonly uid: string;
  /** Custom claims presented in the token. `null` means unauthenticated. */
  readonly claims: Record<string, unknown> | null;
  /** Seeded users/{uid} document, or `null` for no profile at all. */
  readonly profile: { role: string; active: boolean } | null;
}

/*
 * Claims carry BOTH `role` and `active`, exactly as the Cloud Functions set
 * them. The Firestore rules ignore `active` in the claim and read it from the
 * user document instead; the Storage rules use the claim. The fixtures below
 * therefore model the claim and the document independently, which is what makes
 * the stale-token cases expressible.
 */
export const IDENTITIES = {
  /** No token at all. */
  unauthenticated: { uid: 'anonymous', claims: null, profile: null },

  /** Signed in, but carrying no role claim and having no profile. */
  noClaims: { uid: 'claimless-user', claims: {}, profile: null },

  /** An ordinary active staff member. */
  staff: {
    uid: 'staff-user',
    claims: { role: 'STAFF', active: true },
    profile: { role: 'STAFF', active: true },
  },

  /** A second staff member, for "acting on someone else" cases. */
  otherStaff: {
    uid: 'staff-user-2',
    claims: { role: 'STAFF', active: true },
    profile: { role: 'STAFF', active: true },
  },

  /** An active owner. */
  owner: {
    uid: 'owner-user',
    claims: { role: 'OWNER', active: true },
    profile: { role: 'OWNER', active: true },
  },

  /** Deactivated staff, with the claim updated as `setUserActive` leaves it. */
  deactivatedStaff: {
    uid: 'deactivated-staff',
    claims: { role: 'STAFF', active: false },
    profile: { role: 'STAFF', active: false },
  },

  /** Deactivated owner — deactivation outranks role. */
  deactivatedOwner: {
    uid: 'deactivated-owner',
    claims: { role: 'OWNER', active: false },
    profile: { role: 'OWNER', active: false },
  },

  /**
   * Deactivated staff still holding a token minted before deactivation.
   *
   * This is the residual Storage window: the document already says inactive but
   * the unexpired claim does not. Firestore refuses them; Storage does not until
   * the token expires. Modelled explicitly so the limitation is tested rather
   * than assumed.
   */
  deactivatedStaleToken: {
    uid: 'deactivated-stale-token',
    claims: { role: 'STAFF', active: true },
    profile: { role: 'STAFF', active: false },
  },

  /**
   * Demoted owner holding a stale OWNER token.
   * The document says STAFF, so the demotion must take effect NOW in Firestore.
   */
  demotedOwner: {
    uid: 'demoted-owner',
    claims: { role: 'OWNER', active: true },
    profile: { role: 'STAFF', active: true },
  },

  /**
   * Promoted staff whose token has not refreshed.
   * The document says OWNER, the claim still says STAFF — they stay STAFF.
   */
  pendingPromotion: {
    uid: 'pending-promotion',
    claims: { role: 'STAFF', active: true },
    profile: { role: 'OWNER', active: true },
  },

  /**
   * Holds a valid OWNER claim but has no profile document — the state a
   * rolled-back user creation would leave behind.
   */
  claimWithoutProfile: {
    uid: 'claim-without-profile',
    claims: { role: 'OWNER', active: true },
    profile: null,
  },

  /** A forged claim value that is not a defined role. */
  forgedRole: {
    uid: 'forged-role',
    claims: { role: 'SUPERUSER', active: true },
    profile: { role: 'STAFF', active: true },
  },
} as const satisfies Record<string, IdentityFixture>;

export type IdentityName = keyof typeof IDENTITIES;

export const IDENTITY_NAMES = Object.keys(IDENTITIES) as IdentityName[];

/** Identities that Firestore must refuse everywhere, in every phase. */
export const ALWAYS_DENIED: readonly IdentityName[] = [
  'unauthenticated',
  'noClaims',
  'deactivatedStaff',
  'deactivatedOwner',
  'deactivatedStaleToken',
  'claimWithoutProfile',
  'forgedRole',
];

/* ------------------------------------------------------------------------ *
 * Environment
 * ------------------------------------------------------------------------ */

export async function createFirestoreTestEnvironment(): Promise<RulesTestEnvironment> {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(FIRESTORE_RULES_PATH, 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
}

export async function createStorageTestEnvironment(): Promise<RulesTestEnvironment> {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(FIRESTORE_RULES_PATH, 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
    storage: {
      rules: readFileSync(STORAGE_RULES_PATH, 'utf8'),
      host: '127.0.0.1',
      port: 9199,
    },
  });
}

/**
 * Seed the users collection that the rules read on every request.
 *
 * Written with security rules disabled, because in production these documents
 * are created by a Cloud Function through the Admin SDK — no client path exists,
 * which is exactly what the `users` rules assert.
 */
export async function seedIdentities(testEnv: RulesTestEnvironment): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore() as unknown as Firestore;

    for (const identity of Object.values(IDENTITIES) as IdentityFixture[]) {
      if (identity.profile === null) continue;

      await setDoc(doc(db, 'users', identity.uid), {
        uid: identity.uid,
        name: `Fixture ${identity.uid}`,
        email: `${identity.uid}@example.test`,
        role: identity.profile.role,
        active: identity.profile.active,
      });
    }
  });
}

/** Seed an arbitrary document, bypassing rules, so update/delete can be tested. */
export async function seedDocument(
  testEnv: RulesTestEnvironment,
  path: string,
  data: Record<string, unknown>,
): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore() as unknown as Firestore;
    await setDoc(doc(db, path), data);
  });
}

/** Build the Firestore handle for a named identity. */
export function dbAs(testEnv: RulesTestEnvironment, identity: IdentityName): Firestore {
  const fixture: IdentityFixture = IDENTITIES[identity];

  if (fixture.claims === null) {
    return modularFirestore(testEnv.unauthenticatedContext());
  }
  return modularFirestore(testEnv.authenticatedContext(fixture.uid, fixture.claims));
}

/** Build the Storage handle for a named identity. */
export function storageAs(testEnv: RulesTestEnvironment, identity: IdentityName) {
  const fixture: IdentityFixture = IDENTITIES[identity];

  if (fixture.claims === null) {
    return testEnv.unauthenticatedContext().storage();
  }
  return testEnv.authenticatedContext(fixture.uid, fixture.claims).storage();
}

/* ------------------------------------------------------------------------ *
 * Unique identifiers
 *
 * The suites do not clear Firestore between tests: re-seeding the users
 * collection before every one of several hundred assertions would dominate the
 * runtime. Unique document ids keep the tests independent instead.
 * ------------------------------------------------------------------------ */

let counter = 0;

export function uniqueId(prefix = 'doc'): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Every collection named in DATABASE.md, plus one that is not defined anywhere. */
export const ALL_COLLECTIONS = [
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
