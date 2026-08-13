/**
 * Phase 6 rule additions — invoices, terms versions and the business profile.
 *
 * Issued documents are evidence. A client that could write one could craft its
 * figures, and an invoice whose totals the browser chose proves nothing; a
 * client that could edit one could change what a customer already holds. So the
 * collection is closed entirely and these tests assert the closure.
 *
 * The engine's correctness is proved against the emulator in
 * `tests/functions-emulator/documents.test.ts`. Here we prove nobody can go
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

/** A document as the Cloud Function writes it. */
function invoiceBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    documentType: 'Tax Invoice',
    documentNumber: 'INV-2026-0001',
    sequence: 1,
    year: 2026,
    issuedAt: new Date('2026-09-12T06:00:00Z'),
    language: 'bilingual',
    status: 'Issued',
    business: { nameEn: 'Azhary Boutique', vatNumber: '' },
    customer: { nameEn: 'Bride One' },
    customerId: 'cus-1',
    reservationId: 'rsv-1',
    reservationCode: 'RSV-0001',
    financials: { grandTotal: 310_000 },
    payments: [],
    terms: null,
    voided: false,
    ...overrides,
  };
}

/* ------------------------------------------------------------------------ *
 * No client may write a document
 * ------------------------------------------------------------------------ */

describe('invoices cannot be created from a client', () => {
  const writers: IdentityName[] = ['staff', 'owner', 'unauthenticated', 'noClaims'];

  for (const identity of writers) {
    it(`DENIES ${identity} creating an invoice`, async () => {
      await assertFails(
        setDoc(doc(dbAs(testEnv, identity), 'invoices', uniqueId('inv')), invoiceBody()),
      );
    });
  }

  it('DENIES an OWNER creating one even with a perfectly-formed body', async () => {
    // The number comes from a transactional counter and the figures come from
    // the ledger. Neither can be chosen by a browser.
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'owner'), 'invoices', uniqueId('inv')), invoiceBody()),
    );
  });

  it('DENIES choosing an invoice number', async () => {
    await assertFails(
      setDoc(
        doc(dbAs(testEnv, 'staff'), 'invoices', uniqueId('inv')),
        invoiceBody({ documentNumber: 'INV-2026-9999' }),
      ),
    );
  });

  it('DENIES inventing a document with fabricated totals', async () => {
    await assertFails(
      setDoc(
        doc(dbAs(testEnv, 'staff'), 'invoices', uniqueId('inv')),
        invoiceBody({ financials: { grandTotal: 1 } }),
      ),
    );
  });
});

/* ------------------------------------------------------------------------ *
 * Issued documents are immutable
 * ------------------------------------------------------------------------ */

describe('an issued document cannot be altered from a client', () => {
  for (const identity of ['staff', 'owner'] as IdentityName[]) {
    it(`DENIES ${identity} editing the figures`, async () => {
      const id = uniqueId('inv');
      await seedDocument(testEnv, `invoices/${id}`, invoiceBody());

      await assertFails(
        updateDoc(doc(dbAs(testEnv, identity), 'invoices', id), {
          financials: { grandTotal: 1 },
        }),
      );
    });

    it(`DENIES ${identity} deleting a document`, async () => {
      // The number sequence must stay explicable. A deletion is
      // indistinguishable from tampering; voiding leaves the record.
      const id = uniqueId('inv');
      await seedDocument(testEnv, `invoices/${id}`, invoiceBody());

      await assertFails(deleteDoc(doc(dbAs(testEnv, identity), 'invoices', id)));
    });

    it(`DENIES ${identity} voiding a document directly`, async () => {
      const id = uniqueId('inv');
      await seedDocument(testEnv, `invoices/${id}`, invoiceBody());

      await assertFails(
        updateDoc(doc(dbAs(testEnv, identity), 'invoices', id), {
          status: 'Voided',
          voided: true,
        }),
      );
    });
  }

  it('DENIES rewriting the customer on a document already given out', async () => {
    const id = uniqueId('inv');
    await seedDocument(testEnv, `invoices/${id}`, invoiceBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'invoices', id), {
        customer: { nameEn: 'Somebody Else' },
      }),
    );
  });

  it('DENIES rewriting the frozen terms', async () => {
    const id = uniqueId('inv');
    await seedDocument(testEnv, `invoices/${id}`, invoiceBody());

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'invoices', id), {
        terms: { versionId: 'other', sections: [] },
      }),
    );
  });
});

/* ------------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------------ */

describe('reading documents', () => {
  it('ALLOWS an employee to read one — the invoice has to be handed over', async () => {
    const id = uniqueId('inv');
    await seedDocument(testEnv, `invoices/${id}`, invoiceBody());

    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'invoices', id)));
  });

  it('DENIES an unauthenticated read — customer records are not public', async () => {
    const id = uniqueId('inv');
    await seedDocument(testEnv, `invoices/${id}`, invoiceBody());

    await assertFails(getDoc(doc(dbAs(testEnv, 'unauthenticated'), 'invoices', id)));
  });

  it('DENIES a deactivated employee', async () => {
    const id = uniqueId('inv');
    await seedDocument(testEnv, `invoices/${id}`, invoiceBody());

    await assertFails(getDoc(doc(dbAs(testEnv, 'deactivatedStaff'), 'invoices', id)));
  });

  it('DENIES a deactivated employee holding an unexpired token', async () => {
    const id = uniqueId('inv');
    await seedDocument(testEnv, `invoices/${id}`, invoiceBody());

    await assertFails(getDoc(doc(dbAs(testEnv, 'deactivatedStaleToken'), 'invoices', id)));
  });
});

/* ------------------------------------------------------------------------ *
 * Terms versions
 * ------------------------------------------------------------------------ */

describe('terms versions', () => {
  const version = {
    label: 'Version 1',
    sections: [
      {
        key: 'damageAndLoss',
        titleEn: 'Damage and loss',
        titleAr: 'التلف والفقد',
        bodyEn: 'The customer is responsible for the gown while in their care.',
        bodyAr: 'العميلة مسؤولة عن الفستان أثناء وجوده في عهدتها.',
      },
    ],
    createdAtMillis: 1_770_000_000_000,
  };

  it('ALLOWS the owner to publish a version', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'owner'), 'termsVersions', uniqueId('t')), version),
    );
  });

  it('DENIES staff publishing a version', async () => {
    // The terms are the boutique's legal position. The shop floor does not set it.
    await assertFails(setDoc(doc(dbAs(testEnv, 'staff'), 'termsVersions', uniqueId('t')), version));
  });

  it('DENIES editing a published version — documents reference its text', async () => {
    const id = uniqueId('t');
    await seedDocument(testEnv, `termsVersions/${id}`, version);

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'termsVersions', id), { label: 'Edited' }),
    );
  });

  it('DENIES rewriting the wording of a published version', async () => {
    const id = uniqueId('t');
    await seedDocument(testEnv, `termsVersions/${id}`, version);

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'termsVersions', id), { sections: [] }),
    );
  });

  it('DENIES deleting a published version', async () => {
    const id = uniqueId('t');
    await seedDocument(testEnv, `termsVersions/${id}`, version);

    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'termsVersions', id)));
  });

  it('ALLOWS an employee to read the terms', async () => {
    const id = uniqueId('t');
    await seedDocument(testEnv, `termsVersions/${id}`, version);

    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'termsVersions', id)));
  });

  it('DENIES staff activating a different version', async () => {
    // Which terms apply is a settings change, and settings are owner-only.
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'settings', uniqueId('s')), {
        activeTermsVersionId: 'terms-v2',
      }),
    );
  });

  it('ALLOWS the owner to activate a version', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'owner'), 'settings', uniqueId('s')), {
        activeTermsVersionId: 'terms-v2',
      }),
    );
  });
});

/* ------------------------------------------------------------------------ *
 * The business profile and the logo
 * ------------------------------------------------------------------------ */

describe('the business profile', () => {
  const profile = {
    nameEn: 'Azhary Boutique',
    nameAr: 'أزهاري بوتيك',
    addressEn: 'Muscat',
    phone: '91000000',
    vatNumber: '',
    crNumber: '',
    logoPath: 'business/logo/one.png',
  };

  it('ALLOWS the owner to configure it', async () => {
    await assertSucceeds(
      setDoc(doc(dbAs(testEnv, 'owner'), 'businessProfile', uniqueId('b')), profile),
    );
  });

  it('DENIES staff changing it', async () => {
    await assertFails(
      setDoc(doc(dbAs(testEnv, 'staff'), 'businessProfile', uniqueId('b')), profile),
    );
  });

  it('DENIES staff repointing the logo', async () => {
    // The logo appears on every document the boutique issues.
    const id = uniqueId('b');
    await seedDocument(testEnv, `businessProfile/${id}`, profile);

    await assertFails(
      updateDoc(doc(dbAs(testEnv, 'staff'), 'businessProfile', id), {
        logoPath: 'business/logo/staff.png',
      }),
    );
  });

  it('ALLOWS the owner to replace the logo', async () => {
    const id = uniqueId('b');
    await seedDocument(testEnv, `businessProfile/${id}`, profile);

    await assertSucceeds(
      updateDoc(doc(dbAs(testEnv, 'owner'), 'businessProfile', id), {
        logoPath: 'business/logo/two.png',
      }),
    );
  });

  it('ALLOWS an employee to read it — documents render from it', async () => {
    const id = uniqueId('b');
    await seedDocument(testEnv, `businessProfile/${id}`, profile);

    await assertSucceeds(getDoc(doc(dbAs(testEnv, 'staff'), 'businessProfile', id)));
  });

  it('DENIES an unauthenticated read', async () => {
    const id = uniqueId('b');
    await seedDocument(testEnv, `businessProfile/${id}`, profile);

    await assertFails(getDoc(doc(dbAs(testEnv, 'unauthenticated'), 'businessProfile', id)));
  });

  it('DENIES deleting the profile', async () => {
    const id = uniqueId('b');
    await seedDocument(testEnv, `businessProfile/${id}`, profile);

    await assertFails(deleteDoc(doc(dbAs(testEnv, 'owner'), 'businessProfile', id)));
  });
});
