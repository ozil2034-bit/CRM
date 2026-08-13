/**
 * Phase 5 rule additions — the financial ledger and the money settings.
 *
 * The ledger rules are the strictest in the codebase: no client may write a
 * financial event at all, and no role may ever amend or delete one. That is the
 * accounting principle the phase rests on — financial history is never
 * destroyed and never edited — and it is what these tests assert.
 *
 * The engine's correctness is proved against the emulator in
 * `tests/functions-emulator/payments.test.ts`. Here we prove nobody can go
 * around it.
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

/** An event as the Cloud Function writes it. */
function eventBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reservationId: 'rsv-1',
    reservationCode: 'RSV-0001',
    customerId: 'cus-1',
    kind: 'Payment',
    amount: 100_000,
    method: 'Cash',
    type: 'Installment',
    occurredAt: new Date('2026-03-05T06:00:00Z'),
    reference: '',
    reason: '',
    employeeId: 'staff-user',
    employeeName: 'Fixture staff-user',
    reversesEventId: null,
    idempotencyKey: 'abcdefgh1234',
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ *
 * No client may write the ledger
 * ------------------------------------------------------------------------ */

describe('financial events cannot be created from a client', () => {
  const writers: IdentityName[] = ['staff', 'owner', 'unauthenticated', 'noClaims'];

  for (const identity of writers) {
    it(`DENIES ${identity} creating a financial event`, async () => {
      await assertFails(
        setDoc(doc(dbAs(testEnv, identity), 'financialEvents', uniqueId('e')), eventBody()),
      );
    });
  }

  it('DENIES an OWNER creating one even with a perfectly-formed body', async () => {
    // Being the owner is not the issue. Whether a payment is permitted depends
    // on a balance that can only be computed inside a server transaction.
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'owner'), 'financialEvents', uniqueId('e')), eventBody()),
    );
  });

  it('DENIES inventing a payment that would make a reservation look settled', async () => {
    await assertFails(
      setDoc(
        doc(dbAs(testEnv, 'staff'), 'financialEvents', uniqueId('e')),
        eventBody({ amount: 999_999_999 }),
      ),
    );
  });

  it('DENIES choosing a document id, which would defeat idempotency', async () => {
    // The id IS the idempotency key. A client free to pick ids could post the
    // same intent twice under two keys, or squat on a key it never used.
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'financialEvents', 'chosen-key-1234'), eventBody()),
    );
  });
});

/* ------------------------------------------------------------------------ *
 * History is never edited
 * ------------------------------------------------------------------------ */

describe('posted financial events are immutable', () => {
  for (const identity of ['staff', 'owner'] as IdentityName[]) {
    it(`DENIES ${identity} changing the amount of a posted event`, async () => {
      const id = uniqueId('e');
      await seedDocument(testEnv, `financialEvents/${id}`, eventBody());

      await assertFails(
        updateDoc(doc(dbAs(testEnv, identity), 'financialEvents', id), { amount: 1 }),
      );
    });

    it(`DENIES ${identity} deleting a posted event`, async () => {
      const id = uniqueId('e');
      await seedDocument(testEnv, `financialEvents/${id}`, eventBody());

      await assertFails(deleteDoc(doc(dbAs(testEnv, identity), 'financialEvents', id)));
    });
  }

  it('DENIES re-pointing an event at a different reservation', async () => {
    const id = uniqueId('e');
    await seedDocument(testEnv, `financialEvents/${id}`, eventBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'financialEvents', id), { reservationId: 'rsv-2' }),
    );
  });

  it('DENIES changing the kind — a refund could be relabelled a payment', async () => {
    const id = uniqueId('e');
    await seedDocument(testEnv, `financialEvents/${id}`, eventBody({ kind: 'Refund' }));

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'financialEvents', id), { kind: 'Payment' }),
    );
  });

  it('DENIES adding a void flag — voiding mutates history', async () => {
    // Phase 2 modelled corrections as a void flag. Phase 5 replaced it with a
    // reversal event, precisely so nothing posted is ever touched again.
    const id = uniqueId('e');
    await seedDocument(testEnv, `financialEvents/${id}`, eventBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'financialEvents', id), { voided: true }),
    );
  });

  it('DENIES an unauthenticated edit', async () => {
    const id = uniqueId('e');
    await seedDocument(testEnv, `financialEvents/${id}`, eventBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'unauthenticated'), 'financialEvents', id), { amount: 1 }),
    );
  });
});

/* ------------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------------ */

describe('reading the ledger', () => {
  it('ALLOWS an employee to read an event — the statement has to render', async () => {
    const id = uniqueId('e');
    await seedDocument(testEnv, `financialEvents/${id}`, eventBody());

    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'financialEvents', id)));
  });

  it('ALLOWS the owner to read an event', async () => {
    const id = uniqueId('e');
    await seedDocument(testEnv, `financialEvents/${id}`, eventBody());

    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'owner'), 'financialEvents', id)));
  });

  it('DENIES an unauthenticated read', async () => {
    const id = uniqueId('e');
    await seedDocument(testEnv, `financialEvents/${id}`, eventBody());

    await assertFails(getDoc(doc(dbAs(testEnv, 'unauthenticated'), 'financialEvents', id)));
  });

  it('DENIES a deactivated employee reading the ledger', async () => {
    const id = uniqueId('e');
    await seedDocument(testEnv, `financialEvents/${id}`, eventBody());

    await assertFails(getDoc(doc(dbAs(testEnv, 'deactivatedStaff'), 'financialEvents', id)));
  });

  it('DENIES a deactivated employee holding an unexpired token', async () => {
    const id = uniqueId('e');
    await seedDocument(testEnv, `financialEvents/${id}`, eventBody());

    await assertFails(getDoc(doc(dbAs(testEnv, 'deactivatedStaleToken'), 'financialEvents', id)));
  });
});

/* ------------------------------------------------------------------------ *
 * The superseded payments collection
 * ------------------------------------------------------------------------ */

describe('the legacy payments collection is closed', () => {
  it('DENIES staff creating a payment there', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'payments', uniqueId('p')), {
        reservationId: 'rsv-1',
        amount: 90_000,
        createdBy: 'staff-user',
      }),
    );
  });

  it('DENIES the owner voiding a legacy payment', async () => {
    const id = uniqueId('p');
    await seedDocument(testEnv, `payments/${id}`, { reservationId: 'rsv-1', amount: 90_000 });

    await assertFails(updateDoc(doc(dbAs(testEnv, 'owner'), 'payments', id), { voided: true }));
  });

  it('DENIES deleting a legacy payment', async () => {
    const id = uniqueId('p');
    await seedDocument(testEnv, `payments/${id}`, { reservationId: 'rsv-1', amount: 90_000 });

    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'payments', id)));
  });

  it('ALLOWS an employee to still READ anything written before the change', async () => {
    const id = uniqueId('p');
    await seedDocument(testEnv, `payments/${id}`, { reservationId: 'rsv-1', amount: 90_000 });

    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'payments', id)));
  });
});

/* ------------------------------------------------------------------------ *
 * Money settings
 * ------------------------------------------------------------------------ */

describe('the money settings', () => {
  const settings = {
    vatRatePercent: 5,
    lateFeePerDay: 10_000,
    minPickupPaymentPercent: 100,
    cancellationTiers: [{ daysBeforeEvent: 30, refundPercent: 100, label: { en: '', ar: '' } }],
  };

  it('ALLOWS the owner to configure VAT at the standard rate', async () => {
    await assertSucceeds(setDoc(doc(dbAs(testEnv, 'owner'), 'settings', uniqueId('s')), settings));
  });

  it('ALLOWS the owner to zero-rate', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'owner'), 'settings', uniqueId('s')), {
        ...settings,
        vatRatePercent: 0,
      }),
    );
  });

  it('DENIES staff changing the VAT rate', async () => {
    await assertFails(setDoc(doc(dbAs(testEnv, 'staff'), 'settings', uniqueId('s')), settings));
  });

  it('DENIES staff changing the late-fee rate', async () => {
    const id = uniqueId('s');
    await seedDocument(testEnv, `settings/${id}`, settings);

    await assertFails(updateDoc(doc(dbAs(testEnv, 'staff'), 'settings', id), { lateFeePerDay: 0 }));
  });

  it('DENIES staff changing the cancellation scale', async () => {
    const id = uniqueId('s');
    await seedDocument(testEnv, `settings/${id}`, settings);

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'settings', id), { cancellationTiers: [] }),
    );
  });

  it('DENIES even the OWNER storing a VAT rate outside the permitted set', async () => {
    // A wrong VAT rate on an issued invoice is a matter for the tax authority,
    // so the check belongs in the rules and not only in the interface.
    for (const rate of [1, 10, 15, 100, -5]) {
      await assertFails(
        setDoc(doc(dbAs(testEnv, 'owner'), 'settings', uniqueId('s')), {
          ...settings,
          vatRatePercent: rate,
        }),
      );
    }
  });

  it('DENIES a fractional VAT rate', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'owner'), 'settings', uniqueId('s')), {
        ...settings,
        vatRatePercent: 5.5,
      }),
    );
  });

  it('DENIES a negative late fee — the boutique would pay for lateness', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'owner'), 'settings', uniqueId('s')), {
        ...settings,
        lateFeePerDay: -1_000,
      }),
    );
  });

  it('DENIES a fractional late fee, which is not a whole baisa', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'owner'), 'settings', uniqueId('s')), {
        ...settings,
        lateFeePerDay: 10.5,
      }),
    );
  });

  it('DENIES a pickup threshold outside 0–100', async () => {
    for (const percent of [-1, 101, 1_000]) {
      await assertFails(
        setDoc(doc(dbAs(testEnv, 'owner'), 'settings', uniqueId('s')), {
          ...settings,
          minPickupPaymentPercent: percent,
        }),
      );
    }
  });

  it('ALLOWS a settings write that does not mention money at all', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'owner'), 'settings', uniqueId('s')), {
        defaultDocumentLanguage: 'bilingual',
      }),
    );
  });

  it('ALLOWS an employee to read the settings the screens depend on', async () => {
    const id = uniqueId('s');
    await seedDocument(testEnv, `settings/${id}`, settings);

    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'settings', id)));
  });

  it('DENIES deleting the settings', async () => {
    const id = uniqueId('s');
    await seedDocument(testEnv, `settings/${id}`, settings);

    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'settings', id)));
  });
});
