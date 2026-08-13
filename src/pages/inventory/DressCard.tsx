import { Link } from 'react-router-dom';

import { Badge } from '@/design-system';
import { DressPhoto } from '@/components/DressPhoto';
import { formatOmr } from '@/domain/money';
import { resolvePrimaryPhoto } from '@/domain/dress';
import { STATUS_TONE } from './status-tone';
import type { Dress } from '@/services/dresses.service';

/**
 * One dress in the gallery.
 *
 * Photograph first and large; text is secondary and quiet. No card border, no
 * shadow — the image provides the edge, which is what keeps a wall of dresses
 * looking like a boutique rather than an admin grid.
 */
export function DressCard({ dress }: { dress: Dress }) {
  const photo = resolvePrimaryPhoto(dress.photos, dress.primaryPhotoId);

  return (
    <Link
      to={`/inventory/${dress.id}`}
      className="group flex flex-col focus-visible:outline-2 focus-visible:outline-gold-500"
    >
      <DressPhoto
        photo={photo}
        alt={dress.name}
        className="aspect-[3/4] w-full transition-opacity duration-[--duration-base] group-hover:opacity-90"
      />

      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-ink-900">{dress.name}</p>
          <p className="mt-0.5 truncate text-xs text-ink-500">
            {dress.designer || '—'}
            {dress.size ? ` · ${dress.size}` : ''}
          </p>
        </div>

        <span className="shrink-0 font-mono text-2xs text-ink-300">{dress.code}</span>
      </div>

      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="numeric text-sm text-ink-900">{formatOmr(dress.rentalPrice)}</span>
        <Badge tone={STATUS_TONE[dress.status]}>{dress.status}</Badge>
      </div>
    </Link>
  );
}
