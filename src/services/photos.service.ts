/**
 * Dress photographs.
 *
 * Bytes live in Firebase Storage; the dress document holds references. Large
 * images are never stored as base64 in Firestore — a 1 MB photograph becomes
 * ~1.4 MB of base64, which alone exceeds the 1 MiB document limit and would
 * make every inventory query download the entire gallery.
 *
 * Paths follow the shape the Phase 2 Storage rules already enforce:
 *   dresses/{dressId}/original/{photoId}.{ext}
 *   dresses/{dressId}/thumb/{photoId}.webp
 */

import { deleteObject, getDownloadURL, ref as storageRef, uploadBytes } from 'firebase/storage';
import {
  arrayRemove,
  arrayUnion,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';

import { getFirebaseClient } from '@/lib/firebase/client';
import { primaryAfterRemoval, type DressPhoto } from '@/domain/dress';
import { auditWriteFor, type AuditActor } from './audit.service';
import { resizeToBlob, readImageDimensions, type Dimensions } from '@/lib/images/resize';
import { AppError } from './errors';

/** Mirrors the Storage rules exactly. A mismatch would surface as a denial. */
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Long edge of the stored display image. Larger than any screen needs. */
export const LARGE_EDGE_PX = 1600;
/** Long edge of the gallery thumbnail. */
export const THUMB_EDGE_PX = 480;

export type PhotoRejection = 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'EMPTY_FILE' | 'NOT_AN_IMAGE';

export const PHOTO_REJECTION_MESSAGES: Readonly<Record<PhotoRejection, string>> = {
  UNSUPPORTED_TYPE: 'Photos must be JPEG, PNG or WebP.',
  TOO_LARGE: 'Photos must be smaller than 10 MB.',
  EMPTY_FILE: 'That file is empty.',
  NOT_AN_IMAGE: 'That file could not be read as an image.',
};

export class PhotoUploadError extends AppError {
  constructor(code: string, message: string) {
    super('PhotoUploadError', code, message);
  }
}

/**
 * Validate a file before any network work.
 *
 * The same limits the Storage rules enforce. Checking here does not replace the
 * rule — it means the employee is told immediately rather than after a failed
 * upload, and a 40 MB file is never sent at all.
 */
export function rejectFile(file: {
  readonly type: string;
  readonly size: number;
}): PhotoRejection | null {
  if (file.size === 0) return 'EMPTY_FILE';
  if (file.size >= MAX_UPLOAD_BYTES) return 'TOO_LARGE';
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return 'UNSUPPORTED_TYPE';
  }
  return null;
}

export interface UploadPhotoInput {
  readonly dressId: string;
  readonly dressCode: string;
  readonly file: File;
  readonly actor: AuditActor;
  readonly makePrimary: boolean;
  readonly onProgress?: (stage: 'preparing' | 'uploading' | 'saving') => void;
}

/**
 * Upload one photograph and attach it to the dress.
 *
 * Order matters: Storage first, Firestore second. A reference is only written
 * once the bytes exist, so the gallery can never point at a missing object. The
 * opposite order would render broken images on a failed upload.
 *
 * If the Firestore write fails, the uploaded objects are removed so a failed
 * attempt does not leave orphaned bytes accruing storage cost.
 */
export async function uploadDressPhoto(input: UploadPhotoInput): Promise<DressPhoto> {
  const rejection = rejectFile(input.file);
  if (rejection !== null) {
    throw new PhotoUploadError(rejection, PHOTO_REJECTION_MESSAGES[rejection]);
  }

  const { storage, db } = getFirebaseClient();
  const photoId = crypto.randomUUID();

  input.onProgress?.('preparing');

  let dimensions: Dimensions;
  let largeBlob: Blob;
  let thumbBlob: Blob | null;

  try {
    dimensions = await readImageDimensions(input.file);
    // Resizing before upload keeps a 12 MP phone photograph from costing the
    // boutique bandwidth on every gallery view. Aspect ratio is preserved: a
    // stretched dress photograph misrepresents the garment.
    largeBlob = await resizeToBlob(input.file, LARGE_EDGE_PX);
    thumbBlob = await resizeToBlob(input.file, THUMB_EDGE_PX);
  } catch {
    throw new PhotoUploadError('NOT_AN_IMAGE', PHOTO_REJECTION_MESSAGES.NOT_AN_IMAGE);
  }

  const largePath = `dresses/${input.dressId}/original/${photoId}.webp`;
  const thumbPath = `dresses/${input.dressId}/thumb/${photoId}.webp`;

  input.onProgress?.('uploading');

  const uploaded: string[] = [];

  try {
    await uploadBytes(storageRef(storage, largePath), largeBlob, {
      contentType: 'image/webp',
    });
    uploaded.push(largePath);

    if (thumbBlob) {
      await uploadBytes(storageRef(storage, thumbPath), thumbBlob, {
        contentType: 'image/webp',
      });
      uploaded.push(thumbPath);
    }
  } catch (error) {
    await removeQuietly(uploaded);
    throw toUploadError(error);
  }

  const photo: DressPhoto = {
    id: photoId,
    storagePath: largePath,
    thumbPath: thumbBlob ? thumbPath : null,
    width: dimensions.width,
    height: dimensions.height,
    contentType: 'image/webp',
    sizeBytes: largeBlob.size,
    uploadedAt: Date.now(),
    uploadedBy: input.actor.uid,
  };

  input.onProgress?.('saving');

  try {
    await updateDoc(doc(db, 'dresses', input.dressId), {
      photos: arrayUnion(photo),
      ...(input.makePrimary ? { primaryPhotoId: photoId } : {}),
      updatedAt: serverTimestamp(),
      updatedBy: input.actor.uid,
    });

    const audit = auditWriteFor(db, {
      actor: input.actor,
      action: 'dress.photo_added',
      entityType: 'dress',
      entityId: input.dressId,
      entityCode: input.dressCode,
      before: null,
      after: { photoId },
    });
    await setDoc(audit.ref, audit.data);
  } catch (error) {
    // Do not leave bytes behind for a reference that was never written.
    await removeQuietly(uploaded);
    throw toUploadError(error);
  }

  return photo;
}

export async function removeDressPhoto(input: {
  readonly dressId: string;
  readonly dressCode: string;
  readonly photo: DressPhoto;
  readonly photos: readonly DressPhoto[];
  readonly primaryPhotoId: string | null;
  readonly actor: AuditActor;
}): Promise<void> {
  const { db } = getFirebaseClient();

  const nextPrimary = primaryAfterRemoval(input.photos, input.primaryPhotoId, input.photo.id);

  // Firestore first here: the reference is what the interface reads, and an
  // orphaned object costs pennies while a dangling reference shows a broken
  // image to every employee.
  await updateDoc(doc(db, 'dresses', input.dressId), {
    photos: arrayRemove(input.photo),
    primaryPhotoId: nextPrimary,
    updatedAt: serverTimestamp(),
    updatedBy: input.actor.uid,
  });

  const audit = auditWriteFor(db, {
    actor: input.actor,
    action: 'dress.photo_removed',
    entityType: 'dress',
    entityId: input.dressId,
    entityCode: input.dressCode,
    before: { photoId: input.photo.id },
    after: null,
  });
  await setDoc(audit.ref, audit.data);

  // Already-removed reference is what matters; leftover bytes are harmless.
  await removeQuietly(
    [input.photo.storagePath, input.photo.thumbPath].filter(
      (path): path is string => path !== null,
    ),
  );
}

export async function setPrimaryPhoto(input: {
  readonly dressId: string;
  readonly photoId: string;
  readonly actor: AuditActor;
}): Promise<void> {
  const { db } = getFirebaseClient();

  await updateDoc(doc(db, 'dresses', input.dressId), {
    primaryPhotoId: input.photoId,
    updatedAt: serverTimestamp(),
    updatedBy: input.actor.uid,
  });
}

/** Resolve a Storage path to a URL the browser can display. */
export async function photoUrl(path: string): Promise<string> {
  const { storage } = getFirebaseClient();
  return getDownloadURL(storageRef(storage, path));
}

async function removeQuietly(paths: readonly string[]): Promise<void> {
  const { storage } = getFirebaseClient();

  for (const path of paths) {
    try {
      await deleteObject(storageRef(storage, path));
    } catch {
      // Best effort cleanup; the caller is already reporting a failure.
    }
  }
}

function toUploadError(error: unknown): PhotoUploadError {
  const code = (error as { code?: string }).code ?? 'unknown';

  if (code === 'storage/unauthorized' || code === 'permission-denied') {
    return new PhotoUploadError(code, 'You do not have permission to upload photos.');
  }
  if (code === 'storage/retry-limit-exceeded' || code === 'unavailable') {
    return new PhotoUploadError(
      code,
      'The photo could not be uploaded. Check the connection and try again.',
    );
  }

  return new PhotoUploadError(code, 'The photo could not be uploaded.');
}
