/**
 * Identity resolution at the rules layer.
 *
 * Phase 2 resolves a role from two independent sources — the Auth custom claim
 * and users/{uid} — and takes the lower of the two. These tests exercise the
 * cases that only exist because the two can disagree, which is precisely the
 * window an ID token stays valid after a role change.
 *
 * The behaviour asserted here is the reason the design does not use claims
 * alone: with a claim-only model, every one of the revocation tests below would
 * pass for up to an hour after access was withdrawn.
 */

import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { afterAll, beforeAll, describe, it } from 'vitest';

import {
  createFirestoreTestEnvironment,
  dbAs,
  seedDocument,
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

describe('deactivation takes effect immediately, not when the token expires', () => {
  it('DENIES a deactivated staff member reading customers', async () => {
    await assertFails(getDoc(doc(dbAs(testEnv, 'deactivatedStaff'), 'customers', uniqueId())));
  });

  it('DENIES a deactivated staff member recording a payment', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'deactivatedStaff'), 'payments', uniqueId('pay')), {
        amount: 1000,
        createdBy: 'deactivated-staff',
      }),
    );
  });

  it('DENIES a deactivated OWNER changing settings', async () => {
    // Deactivation outranks role: an owner who has been switched off is not an
    // owner for the purposes of any request.
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'deactivatedOwner'), 'settings', 'app'), { vatRatePercent: 0 }),
    );
  });

  it('DENIES a deactivated owner reading the audit trail', async () => {
    await assertFails(getDoc(doc(dbAs(testEnv, 'deactivatedOwner'), 'auditLogs', uniqueId())));
  });

  it('DENIES a deactivated staff member reading their own profile', async () => {
    await assertFails(getDoc(doc(dbAs(testEnv, 'deactivatedStaff'), 'users', 'deactivated-staff')));
  });

  it('revokes access the moment the flag flips, with the same token', async () => {
    // The token is unchanged throughout — only the document changes. This is the
    // whole point of reading `active` from Firestore.
    const id = uniqueId('customer');

    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'otherStaff'), 'customers', id), {
        code: 'CU-9001',
        nameEn: 'Before',
        archived: false,
      }),
    );

    await seedDocument(testEnv, 'users/staff-user-2', {
      uid: 'staff-user-2',
      name: 'Fixture staff-user-2',
      email: 'staff-user-2@example.test',
      role: 'STAFF',
      active: false,
    });

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'otherStaff'), 'customers', id), { nameEn: 'After' }),
    );

    // Restore, and confirm reactivation is equally immediate.
    await seedDocument(testEnv, 'users/staff-user-2', {
      uid: 'staff-user-2',
      name: 'Fixture staff-user-2',
      email: 'staff-user-2@example.test',
      role: 'STAFF',
      active: true,
    });

    await assertSucceeds(
      updateDoc(doc(dbAs(testEnv, 'otherStaff'), 'customers', id), { nameEn: 'Restored' }),
    );
  });
});

describe('a demotion applies immediately despite a stale OWNER token', () => {
  it('still ALLOWS ordinary staff work — the user is an employee, just not an owner', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'demotedOwner'), 'customers', uniqueId('customer')), {
        code: 'CU-9002',
        nameEn: 'Handled by a demoted owner',
        archived: false,
      }),
    );
  });

  it('DENIES changing settings with the stale OWNER claim', async () => {
    // The document says STAFF, and the lower of the two roles wins. Under a
    // claim-only model this write would succeed until the token expired.
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'demotedOwner'), 'settings', 'app'), { vatRatePercent: 0 }),
    );
  });

  it('DENIES editing the business profile with the stale OWNER claim', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'demotedOwner'), 'businessProfile', 'main'), { nameEn: 'Changed' }),
    );
  });

  it('DENIES creating a terms version with the stale OWNER claim', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'demotedOwner'), 'termsVersions', uniqueId()), { version: 9 }),
    );
  });

  it('DENIES reading the audit trail with the stale OWNER claim', async () => {
    await assertFails(getDoc(doc(dbAs(testEnv, 'demotedOwner'), 'auditLogs', uniqueId())));
  });

  it('DENIES voiding a payment with the stale OWNER claim', async () => {
    const id = uniqueId('pay');
    await seedDocument(testEnv, `payments/${id}`, { amount: 1000, voided: false });
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'demotedOwner'), 'payments', id), {
        voided: true,
        voidReason: 'x',
      }),
    );
  });

  it('DENIES listing users with the stale OWNER claim', async () => {
    await assertFails(getDoc(doc(dbAs(testEnv, 'demotedOwner'), 'users', 'staff-user')));
  });
});

describe('a promotion waits for the token to refresh', () => {
  it('ALLOWS staff-level work in the meantime', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'pendingPromotion'), 'dresses', uniqueId('dress')), {
        code: 'WD-0100',
      }),
    );
  });

  it('DENIES owner-level work until the claim catches up', async () => {
    // Under-privileged is the harmless direction to fail in: the new owner signs
    // out and back in, or the client forces a token refresh.
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'pendingPromotion'), 'settings', 'app'), { vatRatePercent: 0 }),
    );
  });

  it('DENIES deleting a dress until the claim catches up', async () => {
    const id = uniqueId('dress');
    await seedDocument(testEnv, `dresses/${id}`, { code: 'WD-0101' });
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'pendingPromotion'), 'dresses', id)));
  });
});

describe('a claim without a profile grants nothing', () => {
  it('DENIES reading business data', async () => {
    // The state a rolled-back user creation leaves behind. A claim alone is not
    // an identity in this system.
    await assertFails(getDoc(doc(dbAs(testEnv, 'claimWithoutProfile'), 'customers', uniqueId())));
  });

  it('DENIES owner operations', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'claimWithoutProfile'), 'settings', 'app'), { vatRatePercent: 0 }),
    );
  });

  it('DENIES creating a profile for itself to satisfy the check', async () => {
    // Closing the obvious follow-up: if a profile is required, can the holder of
    // a claim write one? No — users is unwritable by every client.
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'claimWithoutProfile'), 'users', 'claim-without-profile'), {
        uid: 'claim-without-profile',
        role: 'OWNER',
        active: true,
      }),
    );
  });
});

describe('a forged role value grants nothing', () => {
  it('DENIES business reads for an unrecognised claim value', async () => {
    await assertFails(getDoc(doc(dbAs(testEnv, 'forgedRole'), 'customers', uniqueId())));
  });

  it('DENIES owner operations for an unrecognised claim value', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'forgedRole'), 'settings', 'app'), { vatRatePercent: 0 }),
    );
  });

  it('DENIES even staff-level work — the claim must match a defined role exactly', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'forgedRole'), 'customers', uniqueId('customer')), {
        code: 'CU-9003',
        nameEn: 'X',
        archived: false,
      }),
    );
  });
});
