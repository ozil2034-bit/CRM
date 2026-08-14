/**
 * What an employee sees when a dress cannot be booked.
 *
 * The specification is explicit that "not available" is not an acceptable
 * answer. A bride standing at the counter needs to know *why*, *until when*,
 * and *what else*. Every conflict therefore carries the reservation holding
 * the gown, the instant it comes free, and three ways forward: look at the
 * booking in the way, take the next free date, or take a similar dress.
 *
 * Adding to the waitlist is the fourth path, for when none of those will do.
 * It records interest and nothing else — Phase 4 sends no messages.
 */

import { Link } from 'react-router-dom';

import { Alert, Badge, Button, buttonClasses } from '@/design-system';
import { useT } from '@/hooks/useT';
import { formatMuscat } from '@/domain/datetime';
import type { TranslationKey } from '@/lib/i18n/dictionary';
import type { ConflictDetail } from '@/services/reservations.service';

/**
 * Reason codes the Function returns, mapped to something an employee can read.
 *
 * An unrecognised code falls back to the generic line rather than showing the
 * raw code — but it is still shown, because silently dropping a conflict would
 * suggest the dress is free.
 */
const REASON_KEYS: Record<string, TranslationKey> = {
  DATE_OVERLAP: 'conflict.dateOverlap',
  CLEANING_BUFFER: 'conflict.cleaningBuffer',
  DRESS_RETIRED: 'conflict.retired',
  DRESS_UNDER_REPAIR: 'conflict.underRepair',
  DRESS_IN_ALTERATION: 'conflict.inAlteration',
  DRESS_UNAVAILABLE: 'conflict.unavailable',
};

export interface ConflictPanelProps {
  readonly conflicts: readonly ConflictDetail[];
  /** Move the requested dates so this dress becomes bookable. */
  readonly onUseNextFreeDate: (conflict: ConflictDetail) => void;
  /** Show similar dresses that are free for the requested dates. */
  readonly onFindAlternative: (conflict: ConflictDetail) => void;
  readonly onAddToWaitlist?: (conflict: ConflictDetail) => void;
}

export function ConflictPanel({
  conflicts,
  onUseNextFreeDate,
  onFindAlternative,
  onAddToWaitlist,
}: ConflictPanelProps) {
  const { t, language } = useT();

  if (conflicts.length === 0) return null;

  return (
    <Alert tone="error" className="mt-6">
      <p className="font-medium">{t('conflict.title')}</p>

      <ul className="mt-4 space-y-4">
        {conflicts.map((conflict) => (
          <li
            key={conflict.dressId}
            className="border-t border-current/15 pt-4 first:border-0 first:pt-0"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="code text-2xs">{conflict.dressCode}</span>
              <span className="text-sm">{conflict.dressName}</span>
              <Badge tone="danger">
                {t(REASON_KEYS[conflict.reason] ?? 'conflict.unavailable')}
              </Badge>
            </div>

            <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-2xs">
              {conflict.conflictingReservationCode !== null && (
                <div className="flex gap-2">
                  <dt className="text-ink-500">{t('conflict.heldBy')}</dt>
                  <dd className="code">{conflict.conflictingReservationCode}</dd>
                </div>
              )}

              {conflict.availableFrom !== null && (
                <div className="flex gap-2">
                  <dt className="text-ink-500">{t('conflict.freeFrom')}</dt>
                  <dd className="numeric">{formatMuscat(conflict.availableFrom, language)}</dd>
                </div>
              )}
            </dl>

            <div className="mt-3 flex flex-wrap gap-2">
              {conflict.conflictingReservationId !== null && (
                <Link
                  to={`/reservations/${conflict.conflictingReservationId}`}
                  className={buttonClasses('ghost', 'sm')}
                >
                  {t('conflict.viewConflict')}
                </Link>
              )}

              {/*
               * Only offered when the engine actually computed a free instant.
               * A retired gown has no next free date, and offering one would be
               * a promise the boutique cannot keep.
               */}
              {conflict.availableFrom !== null && (
                <Button variant="ghost" size="sm" onClick={() => onUseNextFreeDate(conflict)}>
                  {t('conflict.findNearestDate')}
                </Button>
              )}

              <Button variant="ghost" size="sm" onClick={() => onFindAlternative(conflict)}>
                {t('conflict.findAlternative')}
              </Button>

              {onAddToWaitlist && (
                <Button variant="ghost" size="sm" onClick={() => onAddToWaitlist(conflict)}>
                  {t('conflict.addToWaitlist')}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Alert>
  );
}
