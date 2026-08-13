/**
 * Phase 3 rule additions — dresses and customers.
 *
 * The Phase 2 authorization matrix already covers who may read and write these
 * collections. This file covers the constraints Phase 3 added: immutable codes,
 * the mandatory `archived` flag, and the fact that customers cannot be deleted
 * by anyone.
 */

import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, setDoc, updateDoc } from 'firebase/firestore';
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

describe('dress codes are immutable', () => {
  it('ALLOWS creating a dress with a code', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'staff'), 'dresses', uniqueId('d')), {
        code: 'WD-0001',
        name: 'Aurora',
        status: 'Available',
        createdBy: 'staff-user',
      }),
    );
  });

  it('DENIES creating a dress with no code', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'dresses', uniqueId('d')), {
        name: 'Aurora',
        status: 'Available',
      }),
    );
  });

  it('DENIES rewriting a dress code — every reference to it would break', async () => {
    const id = uniqueId('d');
    await seedDocument(testEnv, `dresses/${id}`, { code: 'WD-0002', name: 'Aurora' });

    await assertFails(updateDoc(doc(dbAs(testEnv, 'staff'), 'dresses', id), { code: 'WD-9999' }));
  });

  it('DENIES an OWNER rewriting a dress code', async () => {
    const id = uniqueId('d');
    await seedDocument(testEnv, `dresses/${id}`, { code: 'WD-0003', name: 'Aurora' });

    await assertFails(updateDoc(doc(dbAs(testEnv, 'owner'), 'dresses', id), { code: 'WD-9999' }));
  });

  it('ALLOWS ordinary edits that leave the code alone', async () => {
    const id = uniqueId('d');
    await seedDocument(testEnv, `dresses/${id}`, { code: 'WD-0004', name: 'Aurora' });

    await assertSucceeds(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'dresses', id), {
        name: 'Aurora II',
        status: 'In Cleaning',
      }),
    );
  });

  it('DENIES rewriting createdBy to attribute a dress to someone else', async () => {
    const id = uniqueId('d');
    await seedDocument(testEnv, `dresses/${id}`, {
      code: 'WD-0005',
      createdBy: 'owner-user',
    });

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'dresses', id), { createdBy: 'staff-user' }),
    );
  });
});

describe('customers are archived, never deleted', () => {
  it('ALLOWS creating a customer that starts unarchived', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'staff'), 'customers', uniqueId('c')), {
        code: 'CU-0001',
        nameEn: 'Fatima',
        archived: false,
      }),
    );
  });

  it('DENIES creating a customer already marked archived', async () => {
    // The default list filters on `archived == false`; a record created
    // archived would be invisible the moment it was made.
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'customers', uniqueId('c')), {
        code: 'CU-0002',
        archived: true,
      }),
    );
  });

  it('DENIES creating a customer with no archived flag', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'customers', uniqueId('c')), {
        code: 'CU-0003',
        nameEn: 'Fatima',
      }),
    );
  });

  it('ALLOWS archiving a customer', async () => {
    const id = uniqueId('c');
    await seedDocument(testEnv, `customers/${id}`, { code: 'CU-0004', archived: false });

    await assertSucceeds(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'customers', id), { archived: true }),
    );
  });

  it('ALLOWS restoring an archived customer', async () => {
    const id = uniqueId('c');
    await seedDocument(testEnv, `customers/${id}`, { code: 'CU-0005', archived: true });

    await assertSucceeds(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'customers', id), { archived: false }),
    );
  });

  it('DENIES deleting a customer, for staff AND owner', async () => {
    // Reservations, payments and invoices reference the customer; that history
    // must stay resolvable.
    const id = uniqueId('c');
    await seedDocument(testEnv, `customers/${id}`, { code: 'CU-0006', archived: false });

    await assertFails(deleteDoc(doc(dbAs(testEnv, 'staff'), 'customers', id)));
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'customers', id)));
  });

  it('DENIES rewriting a customer code', async () => {
    const id = uniqueId('c');
    await seedDocument(testEnv, `customers/${id}`, { code: 'CU-0007', archived: false });

    await assertFails(updateDoc(doc(dbAs(testEnv, 'staff'), 'customers', id), { code: 'CU-9999' }));
  });
});

describe('catalogue access still follows the Phase 2 matrix', () => {
  it('DENIES an unauthenticated visitor creating a dress', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'unauthenticated'), 'dresses', uniqueId('d')), {
        code: 'WD-0001',
      }),
    );
  });

  it('DENIES a deactivated staff member creating a customer', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'deactivatedStaff'), 'customers', uniqueId('c')), {
        code: 'CU-0001',
        archived: false,
      }),
    );
  });

  it('DENIES a deactivated staff member editing a dress', async () => {
    const id = uniqueId('d');
    await seedDocument(testEnv, `dresses/${id}`, { code: 'WD-0100' });

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'deactivatedStaff'), 'dresses', id), { name: 'Changed' }),
    );
  });

  it('DENIES staff deleting a dress but ALLOWS the owner', async () => {
    const staffTarget = uniqueId('d');
    await seedDocument(testEnv, `dresses/${staffTarget}`, { code: 'WD-0101' });
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'staff'), 'dresses', staffTarget)));

    const ownerTarget = uniqueId('d');
    await seedDocument(testEnv, `dresses/${ownerTarget}`, { code: 'WD-0102' });
    await assertSucceeds(deleteDoc(doc(dbAs(testEnv, 'owner'), 'dresses', ownerTarget)));
  });
});
