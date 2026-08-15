/**
 * The business profile, the logo and the terms.
 *
 * All three are **owner-only**, enforced by `firestore.rules` and
 * `storage.rules` rather than by hiding controls. They decide what appears on
 * every document the boutique issues, so the shop floor must not be able to
 * change them.
 */

import {
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type Firestore,
} from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes, type FirebaseStorage } from 'firebase/storage';

import { getFirebaseClient } from '@/lib/firebase/client';
import type { BusinessSnapshot, TermsSection } from '@/domain/document';
import { emptyTermsSections, isPublishable } from '@/domain/terms';
import { AppError } from './errors';

export class BusinessServiceError extends AppError {
  constructor(code: string, message: string) {
    super('BusinessServiceError', code, message);
  }
}

function db(): Firestore {
  return getFirebaseClient().db;
}

function storage(): FirebaseStorage {
  return getFirebaseClient().storage;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/* ------------------------------------------------------------------------ *
 * The profile
 * ------------------------------------------------------------------------ */

export const EMPTY_BUSINESS: BusinessSnapshot = {
  nameEn: '',
  nameAr: '',
  addressEn: '',
  addressAr: '',
  phone: '',
  whatsapp: '',
  email: '',
  website: '',
  vatNumber: '',
  crNumber: '',
  logoPath: null,
};

/**
 * Watch the business profile.
 *
 * Ships blank. **No placeholder VAT or CR number is ever supplied** — an
 * unconfigured field stays empty and the document renderer omits it, because a
 * fabricated registration number on a tax invoice is a false statement to a
 * customer and to the tax authority.
 */
export function observeBusinessProfile(
  onChange: (profile: BusinessSnapshot) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db(), 'businessProfile', 'main'),
    (snapshot) => {
      const data = snapshot.data() ?? {};
      onChange({
        nameEn: str(data['nameEn']),
        nameAr: str(data['nameAr']),
        addressEn: str(data['addressEn']),
        addressAr: str(data['addressAr']),
        phone: str(data['phone']),
        whatsapp: str(data['whatsapp']),
        email: str(data['email']),
        website: str(data['website']),
        vatNumber: str(data['vatNumber']),
        crNumber: str(data['crNumber']),
        logoPath: str(data['logoPath']).length > 0 ? str(data['logoPath']) : null,
      });
    },
    onError,
  );
}

export async function saveBusinessProfile(
  profile: BusinessSnapshot,
  actorUid: string,
): Promise<void> {
  await setDoc(
    doc(db(), 'businessProfile', 'main'),
    { ...profile, updatedAt: serverTimestamp(), updatedBy: actorUid },
    { merge: true },
  );
}

/* ------------------------------------------------------------------------ *
 * The logo
 * ------------------------------------------------------------------------ */

/** Types a browser will reliably print. SVG is excluded — it can carry script. */
const ALLOWED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** 2 MB. A logo larger than this is a photograph somebody has mistaken for one. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export function refuseLogo(file: { type: string; size: number }): string | null {
  if (!(ALLOWED_LOGO_TYPES as readonly string[]).includes(file.type)) {
    return 'The logo must be a PNG, JPEG or WebP image.';
  }
  if (file.size > MAX_LOGO_BYTES) {
    return 'The logo must be smaller than 2 MB.';
  }
  return null;
}

/**
 * Upload a new logo.
 *
 * Each upload writes a **new object under a new path**, and the profile is
 * repointed at it. The old object is deliberately left in place: invoices
 * issued before the change hold the old path, and deleting it would break the
 * header of every document already given to a customer.
 *
 * Storage keeps the bytes; Firestore keeps a path. A base64 logo copied onto
 * every invoice would bloat the database for no benefit.
 */
export async function uploadLogo(file: File, actorUid: string): Promise<string> {
  const refusal = refuseLogo(file);
  if (refusal !== null) {
    throw new BusinessServiceError('invalid-logo', refusal);
  }

  const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `business/logo/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;

  await uploadBytes(ref(storage(), path), file, { contentType: file.type });

  await setDoc(
    doc(db(), 'businessProfile', 'main'),
    { logoPath: path, updatedAt: serverTimestamp(), updatedBy: actorUid },
    { merge: true },
  );

  return path;
}

/**
 * Resolve a stored path to a URL the document can render.
 *
 * Returns null rather than throwing when the object is gone. A missing logo
 * must degrade to the business name in the header — a broken image on a
 * customer's invoice is worse than no image at all.
 */
export async function resolveStorageUrl(path: string | null): Promise<string | null> {
  if (path === null || path.length === 0) return null;

  try {
    return await getDownloadURL(ref(storage(), path));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ *
 * Terms versions
 * ------------------------------------------------------------------------ */

export interface TermsVersion {
  readonly id: string;
  readonly label: string;
  readonly sections: readonly TermsSection[];
  readonly createdAt: number;
}

export function observeTermsVersions(
  onChange: (versions: TermsVersion[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    collection(db(), 'termsVersions'),
    (snapshot) =>
      onChange(
        snapshot.docs
          .map((document) => {
            const data = document.data();
            const raw = Array.isArray(data['sections']) ? data['sections'] : [];

            return {
              id: document.id,
              label: str(data['label']),
              sections: raw.map((entry: unknown): TermsSection => {
                const section = (entry ?? {}) as Record<string, unknown>;
                return {
                  key: str(section['key']),
                  titleEn: str(section['titleEn']),
                  titleAr: str(section['titleAr']),
                  bodyEn: str(section['bodyEn']),
                  bodyAr: str(section['bodyAr']),
                };
              }),
              createdAt: typeof data['createdAtMillis'] === 'number' ? data['createdAtMillis'] : 0,
            };
          })
          .sort((a, b) => b.createdAt - a.createdAt),
      ),
    onError,
  );
}

/**
 * Publish a new terms version.
 *
 * A version is **never edited**. Changing wording means creating a new version,
 * because documents already issued carry a frozen copy of the text their
 * customer agreed to and that text must stay exactly as it was. The rules
 * enforce it: `termsVersions` permits create but not update or delete.
 */
export async function publishTermsVersion(input: {
  readonly label: string;
  readonly sections: readonly TermsSection[];
  readonly actorUid: string;
}): Promise<string> {
  if (!isPublishable(input.sections)) {
    throw new BusinessServiceError(
      'empty-terms',
      'Write at least one section before publishing. A heading with no text under it is worse than no terms at all.',
    );
  }

  const id = `terms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await setDoc(doc(db(), 'termsVersions', id), {
    label: input.label,
    sections: input.sections.map((section) => ({ ...section })),
    createdAt: serverTimestamp(),
    createdAtMillis: Date.now(),
    createdBy: input.actorUid,
  });

  return id;
}

/** Make a published version the one new documents will snapshot. */
export async function setActiveTermsVersion(versionId: string, actorUid: string): Promise<void> {
  await setDoc(
    doc(db(), 'settings', 'app'),
    { activeTermsVersionId: versionId, updatedAt: serverTimestamp(), updatedBy: actorUid },
    { merge: true },
  );
}

export function observeActiveTermsVersionId(
  onChange: (versionId: string | null) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db(), 'settings', 'app'),
    (snapshot) => {
      const value = str(snapshot.data()?.['activeTermsVersionId']);
      onChange(value.length > 0 ? value : null);
    },
    onError,
  );
}

export { emptyTermsSections };
