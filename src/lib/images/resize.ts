/**
 * Client-side image preparation.
 *
 * Photographs are resized before upload so a 12-megapixel phone image does not
 * cost the boutique bandwidth on every gallery view, and so a tablet on a slow
 * connection is not uploading 8 MB per dress.
 *
 * Aspect ratio is always preserved. A stretched dress photograph misrepresents
 * the garment, which for a bridal boutique is worse than no photograph at all.
 * The `fitWithin` calculation is pure and fully tested; the canvas work around
 * it is a thin browser wrapper.
 */

export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Scale dimensions to fit within a square of `maxEdge`, preserving the ratio.
 *
 * Images already smaller than the limit are returned untouched — upscaling adds
 * bytes and no detail.
 */
export function fitWithin(source: Dimensions, maxEdge: number): Dimensions {
  if (maxEdge <= 0) {
    throw new Error('maxEdge must be positive.');
  }
  if (source.width <= 0 || source.height <= 0) {
    throw new Error('Source dimensions must be positive.');
  }

  const longest = Math.max(source.width, source.height);

  if (longest <= maxEdge) {
    return { width: source.width, height: source.height };
  }

  const scale = maxEdge / longest;

  // Round rather than floor, and never below 1: flooring a very wide, very short
  // image could otherwise produce a height of zero.
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

/** Read an image's intrinsic dimensions without decoding it into a canvas. */
export async function readImageDimensions(file: Blob): Promise<Dimensions> {
  const bitmap = await createImageBitmap(file);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/**
 * Resize to WebP.
 *
 * WebP is chosen for output because it is materially smaller than JPEG at
 * equivalent quality and is supported everywhere the application runs. The
 * Storage rules accept it explicitly.
 *
 * Returns the original file unchanged if the browser cannot produce a WebP
 * blob, so an upload never fails purely because optimisation was unavailable.
 */
export async function resizeToBlob(file: File, maxEdge: number, quality = 0.82): Promise<Blob> {
  const bitmap = await createImageBitmap(file);

  try {
    const target = fitWithin({ width: bitmap.width, height: bitmap.height }, maxEdge);

    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;

    const context = canvas.getContext('2d');
    if (!context) {
      return file;
    }

    context.drawImage(bitmap, 0, 0, target.width, target.height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/webp', quality);
    });

    return blob ?? file;
  } finally {
    bitmap.close();
  }
}
