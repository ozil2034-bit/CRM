import { useEffect, useState } from 'react';

import { photoUrl } from '@/services/photos.service';
import { cn } from '@/lib/utils/cn';
import type { DressPhoto as DressPhotoRef } from '@/domain/dress';

export interface DressPhotoProps {
  readonly photo: DressPhotoRef | null;
  readonly alt: string;
  readonly prefer?: 'thumb' | 'large';
  /**
   * Load immediately rather than when scrolled into view.
   *
   * For the one photograph that is certainly above the fold — a dress detail
   * page's hero. Everything in a grid stays lazy: a boutique with three hundred
   * gowns must not fetch three hundred images to show twelve.
   */
  readonly eager?: boolean;
  readonly className?: string;
}

interface Resolved {
  readonly path: string;
  readonly url: string | null;
  readonly failed: boolean;
}

/**
 * A dress photograph, or a calm placeholder when there is none.
 *
 * `object-contain` on a neutral ground, never `object-cover`: cropping a gown
 * to fill a tile cuts off the hem or the neckline, which are exactly what staff
 * are looking at. Letterboxing shows the whole garment at its true proportions.
 */
export function DressPhoto({
  photo,
  alt,
  prefer = 'thumb',
  eager = false,
  className,
}: DressPhotoProps) {
  const [resolved, setResolved] = useState<Resolved | null>(null);

  const path =
    photo === null
      ? null
      : prefer === 'thumb'
        ? (photo.thumbPath ?? photo.storagePath)
        : photo.storagePath;

  /*
   * State is keyed by the path it belongs to rather than cleared when the path
   * changes. Clearing would mean a synchronous setState inside the effect, which
   * costs an extra render pass on every photograph in the gallery.
   */
  const current = resolved !== null && resolved.path === path ? resolved : null;

  useEffect(() => {
    if (path === null) return;

    let cancelled = false;

    photoUrl(path)
      .then((url) => {
        if (!cancelled) setResolved({ path, url, failed: false });
      })
      .catch(() => {
        if (!cancelled) setResolved({ path, url: null, failed: true });
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  if (photo === null || current?.failed === true) {
    return (
      <div
        className={cn('flex items-center justify-center bg-sand-50 text-ink-300', className)}
        aria-label={alt}
        role="img"
      >
        <svg viewBox="0 0 32 40" className="size-8" fill="none" aria-hidden="true">
          <path
            d="M11 2h10l-2 6 5 22H8L13 8z"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    );
  }

  return (
    <div className={cn('overflow-hidden bg-sand-50', className)}>
      {current !== null && current.url !== null && (
        <img
          src={current.url}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          className="size-full object-contain"
          onError={() => setResolved({ path: path ?? '', url: null, failed: true })}
        />
      )}
    </div>
  );
}
