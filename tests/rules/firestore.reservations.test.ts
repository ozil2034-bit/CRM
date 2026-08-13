/**
 * Phase 4 rule additions — reservations, reservation items, fittings, waitlist.
 *
 * The reservation rules are unusual in this codebase: they close the client
 * write path entirely. That is the point, and it is what these tests assert.
 * The engine's correctness is proved against the emulator in
 * `tests/functions-emulator/reservations.test.ts`; here we prove that nobody
 * can go around it.
 *
 * A client able to write a reservation item could book a gown that is already
 * promised, or free one that is not — availability is decided by those
 * documents. So every one of these denials matters even though the UI never
 * attempts the write.
 */

import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, describe, it } from 'vitest';

import {
  createFirestoreTestEnvironment,
  dbAs,
  seedDocument,
  seedIdentities,
  uniqueId,
  type IdentityName,
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

/** A reservation as the Cloud Function writes it. */
function reservationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 'RSV-0001',
    customerId: 'customer-1',
    customerName: 'Bride One',
    status: 'Reserved',
    pickupAt: new Date('2030-09-10T06:00:00Z'),
    returnAt: new Date('2030-09-12T06:00:00Z'),
    notes: '',
    createdBy: 'staff-user',
    updatedBy: 'staff-user',
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ *
 * reservations — no client may create one
 * ------------------------------------------------------------------------ */

describe('reservations cannot be created from a client', () => {
  const writers: IdentityName[] = ['staff', 'owner', 'unauthenticated', 'noClaims'];

  for (const identity of writers) {
    it(`DENIES ${identity} creating a reservation directly`, async () => {
      await assertFails(
        setDoc(doc(dbAs(testEnv, identity), 'reservations', uniqueId('r')), reservationBody()),
      );
    });
  }

  it('DENIES an OWNER creating a reservation even with a perfectly-formed body', async () => {
    // Being the owner is not the issue. Availability cannot be checked from a
    // client at all, so there is no correct client-side create.
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'owner'), 'reservations', uniqueId('r')), reservationBody()),
    );
  });
});

describe('reservations are readable by employees only', () => {
  it('ALLOWS staff to read a reservation', async () => {
    const id = uniqueId('r');
    await seedDocument(testEnv, `reservations/${id}`, reservationBody());

    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id)));
  });

  it('DENIES an unauthenticated read', async () => {
    const id = uniqueId('r');
    await seedDocument(testEnv, `reservations/${id}`, reservationBody());

    await assertFails(getDoc(doc(dbAs(testEnv, 'unauthenticated'), 'reservations', id)));
  });

  it('DENIES a deactivated employee reading a reservation', async () => {
    const id = uniqueId('r');
    await seedDocument(testEnv, `reservations/${id}`, reservationBody());

    await assertFails(getDoc(doc(dbAs(testEnv, 'deactivatedStaff'), 'reservations', id)));
  });

  it('DENIES a deactivated employee holding an unexpired token', async () => {
    // Firestore reads `active` from the user document, so revocation is immediate.
    const id = uniqueId('r');
    await seedDocument(testEnv, `reservations/${id}`, reservationBody());

    await assertFails(getDoc(doc(dbAs(testEnv, 'deactivatedStaleToken'), 'reservations', id)));
  });
});

describe('only notes may be edited on a reservation from a client', () => {
  it('ALLOWS staff to edit the notes', async () => {
    const id = uniqueId('r');
    await seedDocument(testEnv, `reservations/${id}`, reservationBody());

    await assertSucceeds(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id), {
        notes: 'Bride prefers a morning collection.',
        updatedAt: new Date(),
        updatedBy: 'staff-user',
      }),
    );
  });

  it('DENIES changing the status — that re-runs availability and moves the dress', async () => {
    const id = uniqueId('r');
    await seedDocument(testEnv, `reservations/${id}`, reservationBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id), { status: 'Picked Up' }),
    );
  });

  it('DENIES moving the pickup date', async () => {
    const id = uniqueId('r');
    await seedDocument(testEnv, `reservations/${id}`, reservationBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id), {
        pickupAt: new Date('2030-09-01T06:00:00Z'),
      }),
    );
  });

  it('DENIES moving the return date', async () => {
    const id = uniqueId('r');
    await seedDocument(testEnv, `reservations/${id}`, reservationBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id), {
        returnAt: new Date('2030-09-30T06:00:00Z'),
      }),
    );
  });

  it('DENIES rewriting the pricing', async () => {
    const id = uniqueId('r');
    await seedDocument(testEnv, `reservations/${id}`, {
      ...reservationBody(),
      pricing: { grandTotal: 180_000 },
    });

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id), {
        pricing: { grandTotal: 1 },
      }),
    );
  });

  it('DENIES rewriting the reservation code', async () => {
    const id = uniqueId('r');
    await seedDocument(testEnv, `reservations/${id}`, reservationBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id), { code: 'RSV-9999' }),
    );
  });

  it('DENIES an OWNER changing the status directly', async () => {
    const id = uniqueId('r');
    await seedDocument(testEnv, `reservations/${id}`, reservationBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'reservations', id), { status: 'Cancelled' }),
    );
  });

  it('DENIES a notes edit smuggling a status change alongside it', async () => {
    const id = uniqueId('r');
    await seedDocument(testEnv, `reservations/${id}`, reservationBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'reservations', id), {
        notes: 'Looks innocent',
        status: 'Closed',
      }),
    );
  });

  it('DENIES an unauthenticated notes edit', async () => {
    const id = uniqueId('r');
    await seedDocument(testEnv, `reservations/${id}`, reservationBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'unauthenticated'), 'reservations', id), { notes: 'x' }),
    );
  });
});

describe('reservations are never deleted', () => {
  for (const identity of ['staff', 'owner'] as IdentityName[]) {
    it(`DENIES ${identity} deleting a reservation`, async () => {
      const id = uniqueId('r');
      await seedDocument(testEnv, `reservations/${id}`, reservationBody());

      await assertFails(deleteDoc(doc(dbAs(testEnv, identity), 'reservations', id)));
    });
  }
});

/* ------------------------------------------------------------------------ *
 * reservationItems — the blocking intervals
 * ------------------------------------------------------------------------ */

describe('reservation items are function-only', () => {
  function itemBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      reservationId: 'reservation-1',
      dressId: 'dress-1',
      dressCode: 'WD-0001',
      blocking: true,
      blockStartAt: new Date('2030-09-10T06:00:00Z'),
      blockEndAt: new Date('2030-09-15T06:00:00Z'),
      ...overrides,
    };
  }

  it('DENIES staff forging a blocking item — it would book the dress', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'reservationItems', uniqueId('i')), itemBody()),
    );
  });

  it('DENIES an OWNER forging a blocking item', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'owner'), 'reservationItems', uniqueId('i')), itemBody()),
    );
  });

  it('DENIES clearing the blocking flag — it would free somebody else’s gown', async () => {
    const id = uniqueId('i');
    await seedDocument(testEnv, `reservationItems/${id}`, itemBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'reservationItems', id), { blocking: false }),
    );
  });

  it('DENIES shortening the blocked interval to slip a booking in', async () => {
    const id = uniqueId('i');
    await seedDocument(testEnv, `reservationItems/${id}`, itemBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'reservationItems', id), {
        blockEndAt: new Date('2030-09-11T06:00:00Z'),
      }),
    );
  });

  it('DENIES deleting an item', async () => {
    const id = uniqueId('i');
    await seedDocument(testEnv, `reservationItems/${id}`, itemBody());

    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'reservationItems', id)));
  });

  it('ALLOWS an employee to READ items — the UI shows what is booked', async () => {
    const id = uniqueId('i');
    await seedDocument(testEnv, `reservationItems/${id}`, itemBody());

    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'reservationItems', id)));
  });

  it('DENIES an unauthenticated read', async () => {
    const id = uniqueId('i');
    await seedDocument(testEnv, `reservationItems/${id}`, itemBody());

    await assertFails(getDoc(doc(dbAs(testEnv, 'unauthenticated'), 'reservationItems', id)));
  });
});

/* ------------------------------------------------------------------------ *
 * fittings — ordinary employee CRUD, because they hold nothing
 * ------------------------------------------------------------------------ */

describe('fittings', () => {
  function fittingBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      reservationId: 'reservation-1',
      reservationCode: 'RSV-0001',
      customerId: 'customer-1',
      customerName: 'Bride One',
      scheduledAt: new Date('2030-09-01T06:00:00Z'),
      durationMinutes: 60,
      status: 'Scheduled',
      notes: '',
      employeeId: 'staff-user',
      createdBy: 'staff-user',
      createdAt: new Date(),
      ...overrides,
    };
  }

  it('ALLOWS staff to schedule a fitting', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'staff'), 'fittings', uniqueId('f')), fittingBody()),
    );
  });

  it('DENIES a fitting with no reservation attached', async () => {
    const body = fittingBody();
    delete body['reservationId'];

    await assertFails(setDoc(doc(dbAs(testEnv, 'staff'), 'fittings', uniqueId('f')), body));
  });

  it('DENIES a fitting with no status', async () => {
    const body = fittingBody();
    delete body['status'];

    await assertFails(setDoc(doc(dbAs(testEnv, 'staff'), 'fittings', uniqueId('f')), body));
  });

  it('ALLOWS marking a fitting completed', async () => {
    const id = uniqueId('f');
    await seedDocument(testEnv, `fittings/${id}`, fittingBody());

    await assertSucceeds(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'fittings', id), { status: 'Completed' }),
    );
  });

  it('DENIES moving a fitting to a different reservation', async () => {
    // Re-pointing a fitting would rewrite history rather than record a change.
    const id = uniqueId('f');
    await seedDocument(testEnv, `fittings/${id}`, fittingBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'fittings', id), { reservationId: 'reservation-2' }),
    );
  });

  it('DENIES rewriting who created a fitting', async () => {
    const id = uniqueId('f');
    await seedDocument(testEnv, `fittings/${id}`, fittingBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'fittings', id), { createdBy: 'owner-user' }),
    );
  });

  it('DENIES an unauthenticated caller scheduling a fitting', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'unauthenticated'), 'fittings', uniqueId('f')), fittingBody()),
    );
  });

  it('DENIES a deactivated employee scheduling a fitting', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'deactivatedStaff'), 'fittings', uniqueId('f')), fittingBody()),
    );
  });
});

/* ------------------------------------------------------------------------ *
 * waitlist — records interest, grants nothing
 * ------------------------------------------------------------------------ */

describe('waitlist', () => {
  function waitlistBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      customerId: 'customer-1',
      customerName: 'Bride One',
      customerPhone: '91000001',
      dressId: 'dress-1',
      dressCode: 'WD-0001',
      dressName: 'Aurora',
      requestedPickupAt: new Date('2030-09-10T06:00:00Z'),
      requestedReturnAt: new Date('2030-09-12T06:00:00Z'),
      eventDate: '2030-09-11',
      status: 'Waiting',
      notifiedAt: null,
      createdBy: 'staff-user',
      createdAt: new Date(),
      ...overrides,
    };
  }

  it('ALLOWS staff to add an entry', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'staff'), 'waitlist', uniqueId('w')), waitlistBody()),
    );
  });

  it('DENIES an entry that starts in any state but Waiting', async () => {
    // Creating something already "Notified" would assert a message was sent.
    await assertFails(
      setDoc(
        doc(dbAs(testEnv, 'staff'), 'waitlist', uniqueId('w')),
        waitlistBody({ status: 'Notified' }),
      ),
    );
  });

  it('DENIES an entry with no dress', async () => {
    const body = waitlistBody();
    delete body['dressId'];

    await assertFails(setDoc(doc(dbAs(testEnv, 'staff'), 'waitlist', uniqueId('w')), body));
  });

  it('DENIES an entry with no customer', async () => {
    const body = waitlistBody();
    delete body['customerId'];

    await assertFails(setDoc(doc(dbAs(testEnv, 'staff'), 'waitlist', uniqueId('w')), body));
  });

  it('ALLOWS marking an entry notified', async () => {
    const id = uniqueId('w');
    await seedDocument(testEnv, `waitlist/${id}`, waitlistBody());

    await assertSucceeds(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'waitlist', id), {
        status: 'Notified',
        notifiedAt: new Date(),
      }),
    );
  });

  it('DENIES re-pointing an entry at another dress', async () => {
    const id = uniqueId('w');
    await seedDocument(testEnv, `waitlist/${id}`, waitlistBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'waitlist', id), { dressId: 'dress-2' }),
    );
  });

  it('DENIES re-pointing an entry at another customer', async () => {
    const id = uniqueId('w');
    await seedDocument(testEnv, `waitlist/${id}`, waitlistBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'waitlist', id), { customerId: 'customer-2' }),
    );
  });

  it('DENIES an unauthenticated caller adding an entry', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'unauthenticated'), 'waitlist', uniqueId('w')), waitlistBody()),
    );
  });
});
