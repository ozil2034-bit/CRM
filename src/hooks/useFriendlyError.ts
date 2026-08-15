import { useCallback } from 'react';

import { useT } from '@/hooks/useT';
import { developerDetail, toFriendlyError, type FriendlyError } from '@/domain/firebase-errors';
import { AppError } from '@/services/errors';
import type { TranslationKey } from '@/lib/i18n/dictionary';

/**
 * Any thrown value → something an employee can read, in their own language.
 *
 * `toFriendlyError` decides *which* situation a failure is; that decision is
 * pure domain logic and stays there. This adds the two things a component
 * needs and a pure module must not have: the current language, and somewhere to
 * put the detail a developer wants.
 *
 * The detail goes to the console **only in development**. In production it is
 * dropped entirely rather than logged, because a boutique's console is not
 * private — it is a tablet on a counter — and an error object from Firestore
 * routinely carries the document path of the customer being served.
 */
export function useFriendlyError(): (error: unknown) => FriendlyError {
  const { t } = useT();

  return useCallback(
    (error: unknown): FriendlyError => {
      const friendly = toFriendlyError(error);

      if (import.meta.env.DEV) {
        console.error(developerDetail(error));
      }

      /*
       * An `AppError` already carries a message written for the person at the
       * counter — "That dress is already booked for those dates" says more than
       * any generic sentence could, and replacing it would lose the only part
       * of the failure that was worth saying.
       */
      return {
        ...friendly,
        message:
          error instanceof AppError
            ? error.message
            : t(`errorKind.${friendly.kind}` as TranslationKey),
      };
    },
    [t],
  );
}
