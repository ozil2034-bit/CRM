/**
 * Firestore authorization — the Phase 2 permission matrix.
 *
 * Every collection, both directions. A rules suite that only proves the happy
 * path proves nothing: the denials are the security property, so each one is
 * asserted explicitly against the role that must not have it.
 *
 * Mirrors SECURITY.md §3 and src/domain/authorization.ts. When the three
 * disagree, the rules are correct and the others are the bug.
 */

import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, getDocs, collection, setDoc, updateDoc } from 'firebase/firestore';
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

/* ------------------------------------------------------------------------ *
 * system — the bootstrap sentinel
 * ------------------------------------------------------------------------ */

describe('system/bootstrap is invisible to every client', () => {
  it('DENIES an owner reading the bootstrap sentinel', async () => {
    // The client learns bootstrap state from a callable Function, so no read
    // rule for `system` has to exist for anyone.
    await assertFails(getDoc(doc(dbAs(testEnv, 'owner'), 'system', 'bootstrap')));
  });

  it('DENIES staff reading the bootstrap sentinel', async () => {
    await assertFails(getDoc(doc(dbAs(testEnv, 'staff'), 'system', 'bootstrap')));
  });

  it('DENIES an unauthenticated visitor reading the bootstrap sentinel', async () => {
    await assertFails(getDoc(doc(dbAs(testEnv, 'unauthenticated'), 'system', 'bootstrap')));
  });

  it('DENIES an owner writing the bootstrap sentinel — no self-granted ownership', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'owner'), 'system', 'bootstrap'), {
        completed: false,
        ownerUid: null,
      }),
    );
  });

  it('DENIES an unauthenticated visitor claiming ownership by writing the sentinel', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'unauthenticated'), 'system', 'bootstrap'), {
        completed: true,
        ownerUid: 'attacker',
      }),
    );
  });
});

/* ------------------------------------------------------------------------ *
 * users — role escalation surface
 * ------------------------------------------------------------------------ */

describe('users — reading', () => {
  it('ALLOWS staff to read their own profile', async () => {
    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'users', 'staff-user')));
  });

  it('DENIES staff reading another employee profile', async () => {
    await assertFails(getDoc(doc(dbAs(testEnv, 'staff'), 'users', 'owner-user')));
  });

  it('DENIES staff listing all users', async () => {
    await assertFails(getDocs(collection(dbAs(testEnv, 'staff'), 'users')));
  });

  it('ALLOWS the owner to read any profile — staff management', async () => {
    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'owner'), 'users', 'staff-user')));
  });

  it('ALLOWS the owner to list users — staff management', async () => {
    await assertSucceeds(getDocs(collection(dbAs(testEnv, 'owner'), 'users')));
  });

  it('DENIES an unauthenticated visitor reading any profile', async () => {
    await assertFails(getDoc(doc(dbAs(testEnv, 'unauthenticated'), 'users', 'owner-user')));
  });
});

describe('users — role escalation is impossible from any client', () => {
  it('DENIES staff granting themselves OWNER', async () => {
    // The headline attack. Role lives in a claim only a Cloud Function can set,
    // and the mirror document is unwritable by every client.
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'users', 'staff-user'), { role: 'OWNER' }),
    );
  });

  it('DENIES staff overwriting their own profile document wholesale', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'users', 'staff-user'), {
        uid: 'staff-user',
        role: 'OWNER',
        active: true,
      }),
    );
  });

  it('DENIES staff changing another user’s role', async () => {
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'users', 'staff-user-2'), { role: 'OWNER' }),
    );
  });

  it('DENIES staff reactivating themselves', async () => {
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'users', 'staff-user'), { active: true }),
    );
  });

  it('DENIES a deactivated staff member reactivating themselves', async () => {
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'deactivatedStaff'), 'users', 'deactivated-staff'), {
        active: true,
      }),
    );
  });

  it('DENIES staff creating a new user document', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'users', uniqueId('fabricated')), {
        role: 'OWNER',
        active: true,
      }),
    );
  });

  it('DENIES an unauthenticated visitor creating an owner profile', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'unauthenticated'), 'users', uniqueId('anon')), {
        role: 'OWNER',
        active: true,
      }),
    );
  });

  it('DENIES even the OWNER writing user documents directly', async () => {
    // Owners manage staff through Cloud Functions. Allowing a direct write would
    // let a compromised owner session change roles without an audit record and
    // without the claim ever being updated, leaving the two sources disagreeing.
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'users', 'staff-user'), { role: 'OWNER' }),
    );
  });

  it('DENIES even the OWNER deleting a user document', async () => {
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'users', 'staff-user-2')));
  });

  it('DENIES the owner deactivating someone by direct write', async () => {
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'users', 'staff-user'), { active: false }),
    );
  });
});

/* ------------------------------------------------------------------------ *
 * businessProfile and settings — owner-configured
 * ------------------------------------------------------------------------ */

describe('businessProfile', () => {
  it('ALLOWS staff to read it — invoices and headers need it', async () => {
    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'businessProfile', 'main')));
  });

  it('ALLOWS the owner to write it', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'owner'), 'businessProfile', 'main'), { nameEn: 'Azhary Boutique' }),
    );
  });

  it('DENIES staff changing the business profile', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'businessProfile', 'main'), { nameEn: 'Not Azhary' }),
    );
  });

  it('DENIES staff changing the VAT registration number', async () => {
    await seedDocument(testEnv, 'businessProfile/main', {
      nameEn: 'Azhary Boutique',
      vatNumber: '',
    });
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'businessProfile', 'main'), { vatNumber: 'OM999' }),
    );
  });

  it('DENIES deleting the business profile, even for the owner', async () => {
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'businessProfile', 'main')));
  });
});

describe('settings', () => {
  it('ALLOWS staff to read settings — VAT rate and pickup threshold drive their screens', async () => {
    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'settings', 'app')));
  });

  it('ALLOWS the owner to write settings', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'owner'), 'settings', 'app'), { vatRatePercent: 5 }),
    );
  });

  it('DENIES staff changing the VAT rate', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'settings', 'app'), { vatRatePercent: 0 }),
    );
  });

  it('DENIES staff changing the VAT rate by partial update', async () => {
    await seedDocument(testEnv, 'settings/app', { vatRatePercent: 5 });
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'settings', 'app'), { vatRatePercent: 0 }),
    );
  });

  it('DENIES staff changing the minimum pickup payment percentage', async () => {
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'settings', 'app'), { minimumPickupPaymentPercent: 0 }),
    );
  });

  it('DENIES staff changing the late fee rule', async () => {
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'settings', 'app'), { lateFeePerDay: 0 }),
    );
  });

  it('DENIES staff changing cancellation tiers', async () => {
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'settings', 'app'), { cancellationTiers: [] }),
    );
  });

  it('DENIES staff changing numbering configuration', async () => {
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'settings', 'app'), {
        numbering: { dress: { prefix: 'XX', padding: 4 } },
      }),
    );
  });

  it('DENIES deleting settings, even for the owner', async () => {
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'settings', 'app')));
  });

  /* -------------------------------------------------------------------- *
   * Phase 8 — message templates and reminders live under settings/
   * -------------------------------------------------------------------- */

  it('ALLOWS staff to READ message templates — the composer needs them', async () => {
    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'settings', 'messageTemplates')));
  });

  it('DENIES staff writing message templates', async () => {
    /*
     * A template goes out over the boutique's name to every customer. Editing
     * one is an owner decision, and the interface hiding the editor is not the
     * control — this is.
     */
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'settings', 'messageTemplates'), {
        templates: [{ kind: 'balanceDue', en: 'Pay us', ar: '', enabled: true }],
      }),
    );
  });

  it('DENIES staff changing reminder preferences', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'settings', 'messageTemplates'), {
        reminders: [{ kind: 'pickup', enabled: false, daysOffset: 1 }],
      }),
    );
  });

  it('ALLOWS the owner to write message templates and reminders', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'owner'), 'settings', 'messageTemplates'), {
        templates: [{ kind: 'balanceDue', en: 'Balance {balance}', ar: '', enabled: true }],
        reminders: [{ kind: 'pickup', enabled: true, daysOffset: 2 }],
      }),
    );
  });

  it('REFUSES a VAT rate the boutique may not charge, even from the OWNER', async () => {
    /*
     * An invoice carrying the wrong VAT rate is a matter for the tax authority,
     * so the constraint is a rule and not merely a dropdown. Oman's rates are
     * 0% and 5%.
     */
    for (const rate of [1, 4.9, 10, 15, -5]) {
      await assertFails(
        setDoc(doc(dbAs(testEnv, 'owner'), 'settings', 'app'), { vatRatePercent: rate }),
      );
    }
  });

  it('ALLOWS both permitted VAT rates', async () => {
    for (const rate of [0, 5]) {
      await assertSucceeds(
        setDoc(doc(dbAs(testEnv, 'owner'), 'settings', 'app'), { vatRatePercent: rate }),
      );
    }
  });

  it('REFUSES a fractional late fee — settings money is whole baisa too', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'owner'), 'settings', 'app'), { lateFeePerDay: 10_000.5 }),
    );
  });

  it('REFUSES a pickup threshold outside 0–100', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'owner'), 'settings', 'app'), { minPickupPaymentPercent: 150 }),
    );
  });
});

/* ------------------------------------------------------------------------ *
 * termsVersions — immutable
 * ------------------------------------------------------------------------ */

describe('termsVersions', () => {
  it('ALLOWS staff to read terms — reservations display them', async () => {
    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'termsVersions', uniqueId())));
  });

  it('ALLOWS the owner to create a new version', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'owner'), 'termsVersions', uniqueId()), {
        version: 1,
        bodyEn: 'Terms',
        bodyAr: 'الشروط',
      }),
    );
  });

  it('DENIES staff creating a terms version', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'termsVersions', uniqueId()), {
        version: 2,
        bodyEn: 'Rewritten',
      }),
    );
  });

  it('DENIES staff modifying an existing terms version', async () => {
    const id = uniqueId('terms');
    await seedDocument(testEnv, `termsVersions/${id}`, { version: 1, bodyEn: 'Original' });
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'termsVersions', id), { bodyEn: 'Tampered' }),
    );
  });

  it('DENIES even the OWNER modifying an issued terms version', async () => {
    // Reservations snapshot terms by version id. Editing one in place would
    // silently rewrite what a customer already agreed to.
    const id = uniqueId('terms');
    await seedDocument(testEnv, `termsVersions/${id}`, { version: 1, bodyEn: 'Original' });
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'termsVersions', id), { bodyEn: 'Rewritten' }),
    );
  });

  it('DENIES deleting a terms version, for every role', async () => {
    const id = uniqueId('terms');
    await seedDocument(testEnv, `termsVersions/${id}`, { version: 1 });
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'termsVersions', id)));
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'staff'), 'termsVersions', id)));
  });
});

/* ------------------------------------------------------------------------ *
 * counters
 * ------------------------------------------------------------------------ */

describe('counters', () => {
  it('ALLOWS staff to start a counter at one', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'staff'), 'counters', uniqueId('counter')), { current: 1 }),
    );
  });

  it('DENIES starting a counter at an arbitrary value', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'counters', uniqueId('counter')), { current: 500 }),
    );
  });

  it('ALLOWS incrementing a counter by exactly one', async () => {
    const id = uniqueId('counter');
    await seedDocument(testEnv, `counters/${id}`, { current: 7 });
    await assertSucceeds(updateDoc(doc(dbAs(testEnv, 'staff'), 'counters', id), { current: 8 }));
  });

  it('DENIES rewinding a counter — that would reissue a number already in use', async () => {
    const id = uniqueId('counter');
    await seedDocument(testEnv, `counters/${id}`, { current: 7 });
    await assertFails(updateDoc(doc(dbAs(testEnv, 'staff'), 'counters', id), { current: 3 }));
  });

  it('DENIES skipping a counter forward', async () => {
    const id = uniqueId('counter');
    await seedDocument(testEnv, `counters/${id}`, { current: 7 });
    await assertFails(updateDoc(doc(dbAs(testEnv, 'staff'), 'counters', id), { current: 99 }));
  });

  it('DENIES deleting a counter, even for the owner', async () => {
    const id = uniqueId('counter');
    await seedDocument(testEnv, `counters/${id}`, { current: 7 });
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'counters', id)));
  });
});

/* ------------------------------------------------------------------------ *
 * dresses and customers — operational
 * ------------------------------------------------------------------------ */

describe('dresses', () => {
  it('ALLOWS staff to read, create and edit dresses', async () => {
    const id = uniqueId('dress');
    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'dresses', id)));
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'staff'), 'dresses', id), { code: 'WD-0001', status: 'Available' }),
    );
    await assertSucceeds(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'dresses', id), { status: 'In Cleaning' }),
    );
  });

  it('DENIES staff deleting a dress', async () => {
    const id = uniqueId('dress');
    await seedDocument(testEnv, `dresses/${id}`, { code: 'WD-0002' });
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'staff'), 'dresses', id)));
  });

  it('ALLOWS the owner to delete a dress', async () => {
    const id = uniqueId('dress');
    await seedDocument(testEnv, `dresses/${id}`, { code: 'WD-0003' });
    await assertSucceeds(deleteDoc(doc(dbAs(testEnv, 'owner'), 'dresses', id)));
  });

  it('DENIES staff reading purchase cost', async () => {
    // Commercially sensitive. Rules cannot hide one field of a document, so cost
    // lives in a subcollection where a rule can actually cover it.
    const id = uniqueId('dress');
    await seedDocument(testEnv, `dresses/${id}/private/cost`, { purchaseCost: 450000 });
    await assertFails(getDoc(doc(dbAs(testEnv, 'staff'), `dresses/${id}/private/cost`)));
  });

  it('ALLOWS the owner to read purchase cost', async () => {
    const id = uniqueId('dress');
    await seedDocument(testEnv, `dresses/${id}/private/cost`, { purchaseCost: 450000 });
    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'owner'), `dresses/${id}/private/cost`)));
  });

  it('DENIES staff writing purchase cost', async () => {
    const id = uniqueId('dress');
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), `dresses/${id}/private/cost`), { purchaseCost: 1 }),
    );
  });
});

describe('customers', () => {
  it('ALLOWS staff to read, create and edit customers', async () => {
    const id = uniqueId('customer');
    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'customers', id)));
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'staff'), 'customers', id), {
        code: 'CU-0001',
        nameEn: 'A',
        archived: false,
      }),
    );
    await assertSucceeds(updateDoc(doc(dbAs(testEnv, 'staff'), 'customers', id), { nameEn: 'B' }));
  });

  it('DENIES staff deleting a customer', async () => {
    const id = uniqueId('customer');
    await seedDocument(testEnv, `customers/${id}`, { code: 'CU-0002', archived: false });
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'staff'), 'customers', id)));
  });

  it('DENIES the OWNER deleting a customer — archive is the only removal', async () => {
    /*
     * This assertion is INVERTED from Phase 2, deliberately.
     *
     * Phase 2 allowed the owner to delete a customer. Phase 3 requires that
     * customers are archived and never physically deleted, because
     * reservations, payments and invoices reference them and that history must
     * stay resolvable. The Phase 2 rule was the weaker one; this is a
     * tightening, not a relaxation.
     */
    const id = uniqueId('customer');
    await seedDocument(testEnv, `customers/${id}`, { code: 'CU-0003', archived: false });
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'customers', id)));
  });
});

/* ------------------------------------------------------------------------ *
 * reservations — snapshots frozen, never deletable
 * ------------------------------------------------------------------------ */

describe('reservations', () => {
  const snapshot = {
    code: 'RSV-0001',
    status: 'Reserved',
    pricing: { subtotal: 180000, vatRatePercent: 5, vatAmount: 9000 },
    termsVersionId: 'terms-1',
    termsSnapshot: { en: 'Terms', ar: 'الشروط' },
    businessSnapshot: { nameEn: 'Azhary Boutique' },
    createdBy: 'staff-user',
  };

  /*
   * These two assertions were inverted in Phase 4, and the reversal is
   * deliberate.
   *
   * Phase 2 wrote the reservation rules from the authorization matrix alone:
   * staff are employees, employees operate reservations, so a client write was
   * allowed. Phase 4 supplied the missing constraint — creating or re-dating a
   * reservation requires checking availability and booking in one atomic step,
   * and a transactional query is something the client SDK cannot perform. A
   * browser-side check followed by a write is a time-of-check/time-of-use race:
   * two employees looking at the same free gown would both see it free.
   *
   * So the write path moved into `createReservation` and
   * `changeReservationStatus`, which run with the Admin SDK and bypass these
   * rules entirely. `allow create: if false` is not a restriction on staff; it
   * closes the door that would let a client go around the engine. The rights
   * staff actually exercise are unchanged — they book through the Function.
   *
   * The narrowing is asserted here rather than merely allowed, and the full
   * surface lives in firestore.reservations.test.ts.
   */
  it('DENIES staff creating a reservation directly — booking is server-side', async () => {
    const id = uniqueId('rsv');
    await assertFails(setDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id), snapshot));
  });

  it('ALLOWS staff to READ a reservation', async () => {
    const id = uniqueId('rsv');
    await seedDocument(testEnv, `reservations/${id}`, snapshot);
    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id)));
  });

  it('DENIES staff advancing the status directly — it moves the dress with it', async () => {
    const id = uniqueId('rsv');
    await seedDocument(testEnv, `reservations/${id}`, snapshot);
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id), { status: 'Picked Up' }),
    );
  });

  it('ALLOWS staff to edit the notes, the one field that holds nothing', async () => {
    const id = uniqueId('rsv');
    await seedDocument(testEnv, `reservations/${id}`, snapshot);
    await assertSucceeds(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id), { notes: 'Morning collection.' }),
    );
  });

  it('DENIES rewriting the pricing snapshot after creation', async () => {
    // Specification §30: a later price change must not reach back into an
    // existing reservation.
    const id = uniqueId('rsv');
    await seedDocument(testEnv, `reservations/${id}`, snapshot);
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id), {
        pricing: { subtotal: 1, vatRatePercent: 0, vatAmount: 0 },
      }),
    );
  });

  it('DENIES an OWNER rewriting the pricing snapshot', async () => {
    const id = uniqueId('rsv');
    await seedDocument(testEnv, `reservations/${id}`, snapshot);
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'reservations', id), {
        pricing: { subtotal: 1, vatRatePercent: 0, vatAmount: 0 },
      }),
    );
  });

  it('DENIES rewriting the terms snapshot', async () => {
    const id = uniqueId('rsv');
    await seedDocument(testEnv, `reservations/${id}`, snapshot);
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id), {
        termsSnapshot: { en: 'Different terms', ar: '' },
      }),
    );
  });

  it('DENIES rewriting the business snapshot or the reservation code', async () => {
    const id = uniqueId('rsv');
    await seedDocument(testEnv, `reservations/${id}`, snapshot);
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id), {
        businessSnapshot: { nameEn: 'Someone Else' },
      }),
    );
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id), { code: 'RSV-9999' }),
    );
  });

  it('DENIES deleting a reservation, for staff AND owner', async () => {
    const id = uniqueId('rsv');
    await seedDocument(testEnv, `reservations/${id}`, snapshot);
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id)));
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'reservations', id)));
  });
});

describe('reservationItems', () => {
  /*
   * Inverted in Phase 4, for the sharpest reason in the schema.
   *
   * Phase 2 treated these as ordinary line items. Phase 4 gave them the
   * blocking interval that *decides* availability: a client that can write one
   * can book a gown that is already promised, and a client that can clear
   * `blocking` can free somebody else's booking without touching their
   * reservation. Staff never needed to write them by hand — the Function
   * writes them in the same transaction as the reservation — so closing the
   * path costs the boutique nothing and removes the forgery.
   */
  it('DENIES staff writing a blocking item — availability is decided by these', async () => {
    const id = uniqueId('item');
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'reservationItems', id), {
        reservationId: 'rsv-1',
        dressId: 'wd-1',
        blocking: true,
      }),
    );
  });

  it('DENIES staff clearing the blocking flag or deleting an item', async () => {
    const id = uniqueId('item');
    await seedDocument(testEnv, `reservationItems/${id}`, {
      reservationId: 'rsv-1',
      dressId: 'wd-1',
      blocking: true,
    });

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'reservationItems', id), { blocking: false }),
    );
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'staff'), 'reservationItems', id)));
  });

  it('ALLOWS staff to READ items — the UI has to show what is booked', async () => {
    const id = uniqueId('item');
    await seedDocument(testEnv, `reservationItems/${id}`, {
      reservationId: 'rsv-1',
      dressId: 'wd-1',
      blocking: true,
    });

    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'reservationItems', id)));
  });

  it('DENIES an unauthenticated visitor reading blocking intervals', async () => {
    await assertFails(
      getDoc(doc(dbAs(testEnv, 'unauthenticated'), 'reservationItems', uniqueId())),
    );
  });
});

/* ------------------------------------------------------------------------ *
 * payments — append-only ledger
 * ------------------------------------------------------------------------ */

describe('payments', () => {
  const payment = {
    reservationId: 'rsv-1',
    amount: 90000,
    method: 'Cash',
    type: 'Deposit',
    createdBy: 'staff-user',
    idempotencyKey: 'key-1',
    voided: false,
  };

  /*
   * Inverted in Phase 5, deliberately.
   *
   * Phase 2 wrote these rules from the authorization matrix alone: staff take
   * money, so staff may write a payment. Phase 5 supplied the constraint that
   * was missing — whether a payment is permitted depends on the balance, and
   * the balance is a reduction over every event already posted. That is a query
   * read followed by a write, which the client SDK cannot do inside a
   * transaction, so a browser-side check is a time-of-check/time-of-use race
   * and two tills would both take the same outstanding balance.
   *
   * Payments now go through `recordPayment`, which runs with the Admin SDK and
   * bypasses these rules. Staff lose no capability — recording money is still
   * their job, and it is still they who do it.
   *
   * The collection itself is closed rather than removed, so anything written
   * before the change stays readable and auditable. New events live in
   * `financialEvents`; see firestore.financial.test.ts.
   */
  it('DENIES staff writing a payment directly — the balance decides, and only the server can', async () => {
    await assertFails(setDoc(doc(dbAs(testEnv, 'staff'), 'payments', uniqueId('pay')), payment));
  });

  it('ALLOWS staff to read the ledger', async () => {
    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'payments', uniqueId())));
  });

  it('DENIES recording a payment attributed to another employee', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'payments', uniqueId('pay')), {
        ...payment,
        createdBy: 'owner-user',
      }),
    );
  });

  it('DENIES staff DELETING a payment', async () => {
    const id = uniqueId('pay');
    await seedDocument(testEnv, `payments/${id}`, payment);
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'staff'), 'payments', id)));
  });

  it('DENIES the OWNER deleting a payment — financial history is never destroyed', async () => {
    const id = uniqueId('pay');
    await seedDocument(testEnv, `payments/${id}`, payment);
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'payments', id)));
  });

  it('DENIES staff editing a recorded amount', async () => {
    // A ledger whose entries can be edited is not a ledger.
    const id = uniqueId('pay');
    await seedDocument(testEnv, `payments/${id}`, payment);
    await assertFails(updateDoc(doc(dbAs(testEnv, 'staff'), 'payments', id), { amount: 1 }));
  });

  it('DENIES staff voiding a payment', async () => {
    const id = uniqueId('pay');
    await seedDocument(testEnv, `payments/${id}`, payment);
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'payments', id), {
        voided: true,
        voidReason: 'mistake',
      }),
    );
  });

  /*
   * Also inverted in Phase 5, and this one is the accounting principle itself.
   *
   * Voiding sets a flag on a posted entry — it edits history. Phase 5 replaced
   * it with a reversal: a new event that offsets the original, leaving both
   * visible so the record answers "what happened" rather than only "what do we
   * currently believe". A ledger whose entries can be amended is not a ledger,
   * and the owner is exactly the person whose amendments most need to be
   * visible.
   *
   * `reversePayment` is owner-only, so the control has not been loosened — it
   * has been moved somewhere it leaves a trace.
   */
  it('DENIES the owner voiding a payment — corrections are reversals, not edits', async () => {
    const id = uniqueId('pay');
    await seedDocument(testEnv, `payments/${id}`, payment);
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'payments', id), {
        voided: true,
        voidedBy: 'owner-user',
        voidReason: 'Duplicate entry',
      }),
    );
  });

  it('DENIES the owner changing the amount while voiding', async () => {
    const id = uniqueId('pay');
    await seedDocument(testEnv, `payments/${id}`, payment);
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'payments', id), { voided: true, amount: 0 }),
    );
  });
});

/* ------------------------------------------------------------------------ *
 * invoices — Function-issued, immutable
 * ------------------------------------------------------------------------ */

describe('invoices', () => {
  it('ALLOWS staff to read invoices', async () => {
    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'invoices', uniqueId())));
  });

  it('DENIES staff creating an invoice directly', async () => {
    // Number allocation and immutability cannot be trusted to a client, so no
    // client write path exists at all.
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'invoices', uniqueId('inv')), {
        number: 'INV-2026-0001',
        grandTotal: 1,
      }),
    );
  });

  it('DENIES the OWNER creating an invoice directly', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'owner'), 'invoices', uniqueId('inv')), {
        number: 'INV-2026-0001',
      }),
    );
  });

  it('DENIES staff DELETING an invoice', async () => {
    const id = uniqueId('inv');
    await seedDocument(testEnv, `invoices/${id}`, { number: 'INV-2026-0002' });
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'staff'), 'invoices', id)));
  });

  it('DENIES the OWNER deleting an invoice', async () => {
    const id = uniqueId('inv');
    await seedDocument(testEnv, `invoices/${id}`, { number: 'INV-2026-0003' });
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'invoices', id)));
  });

  it('DENIES modifying an issued invoice, for every role', async () => {
    const id = uniqueId('inv');
    await seedDocument(testEnv, `invoices/${id}`, { number: 'INV-2026-0004', grandTotal: 318138 });
    await assertFails(updateDoc(doc(dbAs(testEnv, 'staff'), 'invoices', id), { grandTotal: 0 }));
    await assertFails(updateDoc(doc(dbAs(testEnv, 'owner'), 'invoices', id), { grandTotal: 0 }));
  });
});

/* ------------------------------------------------------------------------ *
 * damageLogs · notificationLogs · fittings · accessories · waitlist
 * ------------------------------------------------------------------------ */

describe('damageLogs', () => {
  it('ALLOWS staff to record and amend damage', async () => {
    const id = uniqueId('damage');
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'staff'), 'damageLogs', id), { dressId: 'wd-1', severity: 'Minor' }),
    );
    await assertSucceeds(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'damageLogs', id), { severity: 'Moderate' }),
    );
  });

  it('DENIES deleting damage evidence, for every role', async () => {
    // These records justify deposit forfeitures and customer charges.
    const id = uniqueId('damage');
    await seedDocument(testEnv, `damageLogs/${id}`, { dressId: 'wd-1' });
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'staff'), 'damageLogs', id)));
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'damageLogs', id)));
  });
});

/*
 * ─────────────────────────────────────────────────────────────────────────
 * PHASE 8 CHANGED THIS MODEL, DELIBERATELY
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Phase 2 modelled a notification as one document with a mutable `openedAt`,
 * and asserted that staff could set it. Phase 8 replaced that with one
 * immutable entry per action, and the two tests that exercised the update path
 * were rewritten to assert the opposite. The reasons:
 *
 * 1. An employee who opens WhatsApp twice has contacted the customer twice —
 *    the second may be a genuine follow-up after no reply. A single timestamp
 *    records only the first, so the history would understate what the boutique
 *    actually did. The specification requires each explicit action to be
 *    logged (§8.10).
 * 2. The entry carries the exact message text prepared. That is a snapshot, and
 *    a snapshot that can be edited answers nothing six months later.
 *
 * This is a tightening: nothing that was refused is now allowed. The deny
 * assertions below are stronger than the ones they replaced.
 */
describe('notificationLogs', () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    customerId: 'c-1',
    templateKind: 'pickupReminder',
    language: 'en',
    channel: 'WhatsApp',
    status: 'Prepared',
    message: 'Your dress is ready.',
    employeeId: 'staff-user',
    ...overrides,
  });

  it('ALLOWS staff to record a prepared message', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'staff'), 'notificationLogs', uniqueId('note')), entry()),
    );
  });

  it('ALLOWS recording that WhatsApp was opened, or the text copied', async () => {
    for (const status of ['Opened', 'Copied']) {
      await assertSucceeds(
        setDoc(
          doc(dbAs(testEnv, 'staff'), 'notificationLogs', uniqueId('note')),
          entry({ status }),
        ),
      );
    }
  });

  it('DENIES a status claiming the message was SENT, DELIVERED or READ', async () => {
    /*
     * The application opens a link. It never transmits anything and cannot
     * observe what happened next. A stored claim of delivery would one day be
     * quoted back to a customer who never received the message, so the rules —
     * not merely the interface — refuse to hold one.
     */
    for (const status of ['Sent', 'Delivered', 'Read', 'Failed']) {
      await assertFails(
        setDoc(
          doc(dbAs(testEnv, 'staff'), 'notificationLogs', uniqueId('note')),
          entry({ status }),
        ),
      );
    }
  });

  it('DENIES logging a message attributed to a colleague', async () => {
    await assertFails(
      setDoc(
        doc(dbAs(testEnv, 'staff'), 'notificationLogs', uniqueId('note')),
        entry({ employeeId: 'owner-user' }),
      ),
    );
  });

  it('DENIES ANY update — a communication record is evidence, not a draft', async () => {
    const id = uniqueId('note');
    await seedDocument(testEnv, `notificationLogs/${id}`, entry());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'notificationLogs', id), { status: 'Opened' }),
    );
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'notificationLogs', id), {
        message: 'Something else entirely',
      }),
    );
  });

  it('DENIES the OWNER updating one too', async () => {
    const id = uniqueId('note');
    await seedDocument(testEnv, `notificationLogs/${id}`, entry());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'notificationLogs', id), { status: 'Opened' }),
    );
  });

  it('DENIES deleting a notification log', async () => {
    const id = uniqueId('note');
    await seedDocument(testEnv, `notificationLogs/${id}`, entry());
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'notificationLogs', id)));
  });
});

describe('fittings, accessories and waitlist', () => {
  it('ALLOWS staff to manage fittings end to end', async () => {
    const id = uniqueId('fitting');
    await assertSucceeds(
      // Phase 4 requires a fitting to name the reservation it belongs to; a
      // dangling appointment is not something the diary can act on.
      setDoc(doc(dbAs(testEnv, 'staff'), 'fittings', id), {
        reservationId: 'rsv-1',
        status: 'Scheduled',
      }),
    );
    await assertSucceeds(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'fittings', id), { status: 'Completed' }),
    );
    await assertSucceeds(deleteDoc(doc(dbAs(testEnv, 'staff'), 'fittings', id)));
  });

  it('ALLOWS staff to manage the waitlist end to end', async () => {
    const id = uniqueId('wait');
    await assertSucceeds(
      // Phase 4 requires the dress and customer the entry is about — an entry
      // naming neither could never be acted on when the gown frees up.
      setDoc(doc(dbAs(testEnv, 'staff'), 'waitlist', id), {
        dressId: 'wd-1',
        customerId: 'cus-1',
        status: 'Waiting',
      }),
    );
    await assertSucceeds(deleteDoc(doc(dbAs(testEnv, 'staff'), 'waitlist', id)));
  });

  it('ALLOWS staff to create and edit accessories but not delete them', async () => {
    const id = uniqueId('acc');
    await assertSucceeds(setDoc(doc(dbAs(testEnv, 'staff'), 'accessories', id), { name: 'Veil' }));
    await assertSucceeds(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'accessories', id), { name: 'Tiara' }),
    );
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'staff'), 'accessories', id)));
  });

  it('ALLOWS the owner to delete an accessory', async () => {
    const id = uniqueId('acc');
    await seedDocument(testEnv, `accessories/${id}`, { name: 'Veil' });
    await assertSucceeds(deleteDoc(doc(dbAs(testEnv, 'owner'), 'accessories', id)));
  });

  /*
   * Accessory prices reach an invoice through the reservation's pricing
   * snapshot. A fractional or negative one would break the integer-baisa
   * invariant the whole financial engine rests on, from the catalogue inwards.
   */
  it('REFUSES a fractional accessory price — money is whole baisa', async () => {
    const id = uniqueId('acc');
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'accessories', id), {
        name: 'Veil',
        rentalPrice: 20_000.5,
      }),
    );
  });

  it('REFUSES a negative accessory price or deposit', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'accessories', uniqueId('acc')), {
        name: 'Veil',
        rentalPrice: -1,
      }),
    );
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'accessories', uniqueId('acc')), {
        name: 'Veil',
        securityDeposit: -1,
      }),
    );
  });

  it('REFUSES a fractional price on an update, not only on create', async () => {
    const id = uniqueId('acc');
    await seedDocument(testEnv, `accessories/${id}`, { name: 'Veil', rentalPrice: 20_000 });

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'accessories', id), { rentalPrice: 0.5 }),
    );
  });

  it('ALLOWS whole-baisa prices, a zero price, and a null sale price', async () => {
    // A rental-only accessory has no sale price at all; null is not a violation.
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'staff'), 'accessories', uniqueId('acc')), {
        name: 'Veil',
        rentalPrice: 20_000,
        salePrice: null,
        securityDeposit: 0,
      }),
    );
  });
});

/* ------------------------------------------------------------------------ *
 * auditLogs — append-only, owner-readable
 * ------------------------------------------------------------------------ */

describe('auditLogs', () => {
  it('ALLOWS the owner to read the audit trail', async () => {
    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'owner'), 'auditLogs', uniqueId())));
  });

  it('DENIES staff reading the audit trail', async () => {
    await assertFails(getDoc(doc(dbAs(testEnv, 'staff'), 'auditLogs', uniqueId())));
  });

  it('DENIES staff listing the audit trail', async () => {
    await assertFails(getDocs(collection(dbAs(testEnv, 'staff'), 'auditLogs')));
  });

  it('ALLOWS staff to append an entry attributed to themselves', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'staff'), 'auditLogs', uniqueId('audit')), {
        actorUid: 'staff-user',
        action: 'reservation.status_changed',
        entityType: 'reservation',
      }),
    );
  });

  it('DENIES forging an audit entry attributed to someone else', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'auditLogs', uniqueId('audit')), {
        actorUid: 'owner-user',
        action: 'settings.vat_changed',
        entityType: 'settings',
      }),
    );
  });

  it('DENIES amending an audit entry, for every role', async () => {
    // An audit log its subjects can amend records nothing.
    const id = uniqueId('audit');
    await seedDocument(testEnv, `auditLogs/${id}`, {
      actorUid: 'staff-user',
      action: 'payment.recorded',
    });
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'auditLogs', id), { action: 'nothing.happened' }),
    );
    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'auditLogs', id), { action: 'nothing.happened' }),
    );
  });

  it('DENIES deleting an audit entry, for every role', async () => {
    const id = uniqueId('audit');
    await seedDocument(testEnv, `auditLogs/${id}`, { actorUid: 'staff-user' });
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'staff'), 'auditLogs', id)));
    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'auditLogs', id)));
  });
});
