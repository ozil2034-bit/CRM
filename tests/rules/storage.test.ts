/**
 * Firebase Storage security rules.
 *
 * Dress photographs, damage evidence and the business logo are authenticated-
 * only. A public bucket would expose the boutique's entire inventory and
 * customer-identifying damage photography.
 *
 * Identity here comes from the Auth custom claim rather than the users document
 * the Firestore rules read. storage.rules explains why in full: the Storage
 * emulator cannot evaluate cross-service Firestore reads, so a document-based
 * rule could never have its ALLOW path tested. The consequence is a bounded
 * revocation window, asserted explicitly at the end of this file.
 */

import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc } from 'firebase/firestore';
import { afterAll, beforeAll, describe, it } from 'vitest';

import {
  createStorageTestEnvironment,
  dbAs,
  seedIdentities,
  storageAs,
  uniqueId,
  type IdentityName,
} from './helpers';

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await createStorageTestEnvironment();
  await testEnv.clearFirestore();
  await testEnv.clearStorage();
  await seedIdentities(testEnv);
});

afterAll(async () => {
  await testEnv?.cleanup();
});

/** A minimal PNG header — enough bytes for the emulator to accept an object. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const IMAGE_METADATA = { contentType: 'image/png' };

function ref(identity: IdentityName, path: string) {
  // The rules-testing package exposes the v8-style compat Storage surface.
  return storageAs(testEnv, identity).ref(path);
}

/**
 * `put()` returns an `UploadTask`, which is thenable but not a `Promise`.
 * `Promise.resolve` adopts it so the assertion helpers receive a real promise.
 */
function upload(
  identity: IdentityName,
  path: string,
  metadata: { contentType: string } = IMAGE_METADATA,
): Promise<unknown> {
  return Promise.resolve(ref(identity, path).put(PNG_BYTES, metadata));
}

function download(identity: IdentityName, path: string): Promise<unknown> {
  return Promise.resolve(ref(identity, path).getDownloadURL());
}

function remove(identity: IdentityName, path: string): Promise<unknown> {
  return Promise.resolve(ref(identity, path).delete());
}

describe('dress photographs', () => {
  it('ALLOWS staff to upload a dress photograph', async () => {
    await assertSucceeds(upload('staff', `dresses/${uniqueId('wd')}/original/photo.png`));
  });

  it('ALLOWS the owner to upload a dress photograph', async () => {
    await assertSucceeds(upload('owner', `dresses/${uniqueId('wd')}/large/photo.png`));
  });

  it('ALLOWS staff to download a dress photograph', async () => {
    const path = `dresses/${uniqueId('wd')}/original/photo.png`;
    await upload('staff', path);
    await assertSucceeds(download('staff', path));
  });

  it('ALLOWS staff to delete a dress photograph', async () => {
    const path = `dresses/${uniqueId('wd')}/original/photo.png`;
    await upload('staff', path);
    await assertSucceeds(remove('staff', path));
  });

  it('DENIES an unauthenticated visitor uploading', async () => {
    await assertFails(upload('unauthenticated', `dresses/${uniqueId('wd')}/original/photo.png`));
  });

  it('DENIES an unauthenticated visitor downloading — the inventory is not public', async () => {
    const path = `dresses/${uniqueId('wd')}/original/photo.png`;
    await upload('staff', path);
    await assertFails(download('unauthenticated', path));
  });

  it('DENIES a deactivated staff member uploading', async () => {
    await assertFails(upload('deactivatedStaff', `dresses/${uniqueId('wd')}/original/photo.png`));
  });

  it('DENIES a deactivated staff member downloading', async () => {
    const path = `dresses/${uniqueId('wd')}/original/photo.png`;
    await upload('staff', path);
    await assertFails(download('deactivatedStaff', path));
  });

  it('DENIES a deactivated owner uploading', async () => {
    await assertFails(upload('deactivatedOwner', `dresses/${uniqueId('wd')}/original/photo.png`));
  });

  it('DENIES a signed-in user carrying no role claim', async () => {
    await assertFails(upload('noClaims', `dresses/${uniqueId('wd')}/original/photo.png`));
  });

  it('DENIES a forged role claim value', async () => {
    await assertFails(upload('forgedRole', `dresses/${uniqueId('wd')}/original/photo.png`));
  });
});

describe('upload validation', () => {
  it('DENIES a non-image content type', async () => {
    await assertFails(
      upload('staff', `dresses/${uniqueId('wd')}/original/payload.pdf`, {
        contentType: 'application/pdf',
      }),
    );
  });

  it('DENIES an executable content type behind an image path', async () => {
    await assertFails(
      upload('staff', `dresses/${uniqueId('wd')}/original/evil.png`, {
        contentType: 'application/x-msdownload',
      }),
    );
  });

  it('DENIES an SVG upload — SVG can carry script', async () => {
    await assertFails(
      upload('staff', `dresses/${uniqueId('wd')}/original/vector.svg`, {
        contentType: 'image/svg+xml',
      }),
    );
  });

  it('ALLOWS the permitted raster formats', async () => {
    for (const contentType of ['image/jpeg', 'image/png', 'image/webp']) {
      await assertSucceeds(
        upload('staff', `dresses/${uniqueId('wd')}/original/photo`, { contentType }),
      );
    }
  });
});

describe('business logo', () => {
  it('ALLOWS the owner to upload the logo', async () => {
    await assertSucceeds(upload('owner', 'business/logo/mark.png'));
  });

  it('DENIES staff replacing the logo', async () => {
    await assertFails(upload('staff', 'business/logo/mark.png'));
  });

  it('ALLOWS staff to read the logo — invoices render it', async () => {
    await upload('owner', 'business/logo/mark.png');
    await assertSucceeds(download('staff', 'business/logo/mark.png'));
  });

  it('DENIES an unauthenticated visitor reading the logo', async () => {
    await upload('owner', 'business/logo/mark.png');
    await assertFails(download('unauthenticated', 'business/logo/mark.png'));
  });

  it('DENIES a deactivated owner replacing the logo', async () => {
    await assertFails(upload('deactivatedOwner', 'business/logo/mark.png'));
  });
});

describe('damage evidence', () => {
  it('ALLOWS staff to upload damage photographs', async () => {
    await assertSucceeds(upload('staff', `damage/${uniqueId('dmg')}/tear.png`));
  });

  it('DENIES staff deleting damage evidence', async () => {
    // The person who recorded a charge must not be able to remove the evidence
    // that justifies it.
    const path = `damage/${uniqueId('dmg')}/tear.png`;
    await upload('staff', path);
    await assertFails(remove('staff', path));
  });

  it('ALLOWS the owner to delete damage evidence', async () => {
    const path = `damage/${uniqueId('dmg')}/tear.png`;
    await upload('staff', path);
    await assertSucceeds(remove('owner', path));
  });

  it('DENIES an unauthenticated visitor reading damage evidence', async () => {
    const path = `damage/${uniqueId('dmg')}/tear.png`;
    await upload('staff', path);
    await assertFails(download('unauthenticated', path));
  });
});

describe('undeclared paths are closed', () => {
  it('DENIES an owner writing outside the declared paths', async () => {
    await assertFails(upload('owner', `arbitrary/${uniqueId()}/file.png`));
  });

  it('DENIES an owner reading outside the declared paths', async () => {
    await assertFails(download('owner', `arbitrary/${uniqueId()}/file.png`));
  });

  it('DENIES writing to the bucket root', async () => {
    await assertFails(upload('owner', `${uniqueId()}.png`));
  });

  it('DENIES an unauthenticated visitor writing anywhere', async () => {
    await assertFails(upload('unauthenticated', `arbitrary/${uniqueId()}/file.png`));
  });
});

/**
 * The known, accepted limitation — asserted rather than left implicit.
 *
 * Storage resolves identity from the claim, so revocation lags an unexpired ID
 * token by up to an hour. These tests pin the exact shape of that window, so any
 * future change to it surfaces as a failing test rather than a silent
 * behavioural change. Recorded in SECURITY.md §6.
 */
describe('documented limitation: Storage revocation lags an unexpired token', () => {
  it('still admits a deactivated employee whose token predates deactivation', async () => {
    const path = `dresses/${uniqueId('wd')}/original/photo.png`;
    await upload('staff', path);

    // The profile already says inactive; the unexpired claim still says active.
    await assertSucceeds(download('deactivatedStaleToken', path));
  });

  it('refuses that same employee once the claim reflects deactivation', async () => {
    // What `setUserActive` produces: claim updated, refresh tokens revoked, Auth
    // account disabled. From that point the window is closed.
    const path = `dresses/${uniqueId('wd')}/original/photo.png`;
    await upload('staff', path);

    await assertFails(download('deactivatedStaff', path));
  });

  it('does not let a stale token discover new object paths', async () => {
    // The mitigation that bounds the exposure: object paths live in Firestore
    // (dresses.photos[].storagePath), and Firestore revokes immediately — so a
    // stale token can only reach objects whose paths were already known to it.
    await assertFails(
      getDoc(doc(dbAs(testEnv, 'deactivatedStaleToken'), 'dresses', uniqueId('wd'))),
    );
  });
});
