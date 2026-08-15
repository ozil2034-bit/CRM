/**
 * What an employee is shown when something fails — §22, §45.
 *
 * Two properties, and both are about what must *not* appear on a boutique
 * tablet: SDK wording written for a developer, and English wording shown to an
 * Arabic reader.
 */

import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { I18nProvider } from '@/lib/i18n/I18nProvider';
import { ar, en } from '@/lib/i18n/dictionary';
import { AppError } from '@/services/errors';
import { useFriendlyError } from './useFriendlyError';

function wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}

/** A Firebase error, as the SDK actually shapes one. */
function firebaseError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, name: 'FirebaseError' });
}

function friendlyIn(language: 'en' | 'ar') {
  window.localStorage.setItem('azhary.language', language);
  return renderHook(() => useFriendlyError(), { wrapper }).result.current;
}

describe('useFriendlyError', () => {
  it('never repeats an SDK message back to the employee', () => {
    const friendly = friendlyIn('en');
    const raw = 'Missing or insufficient permissions.';

    const result = friendly(firebaseError('permission-denied', raw));

    expect(result.message).not.toContain(raw);
    expect(result.message).toBe(en['errorKind.permission']);
  });

  it('answers in Arabic when the interface is Arabic', () => {
    const friendly = friendlyIn('ar');

    expect(friendly(firebaseError('unavailable', 'transport errored')).message).toBe(
      ar['errorKind.offline'],
    );
  });

  it('keeps the message when this application wrote it', () => {
    /*
     * "That dress is already booked" is worth more than any generic sentence,
     * and it is the reason `AppError` exists at all.
     */
    const friendly = friendlyIn('en');
    const written = new AppError('ReservationServiceError', 'overlap', 'That dress is booked.');

    expect(friendly(written).message).toBe('That dress is booked.');
  });

  it('does not mistake a plain Error for one of ours', () => {
    const friendly = friendlyIn('en');

    // A TypeError from a bug names internals. It gets the generic sentence.
    expect(friendly(new TypeError('x.y is not a function')).message).toBe(
      en['errorKind.unknown'],
    );
  });

  it('survives a thrown value that is not an error at all', () => {
    const friendly = friendlyIn('en');

    expect(() => friendly('something')).not.toThrow();
    expect(friendly(null).message).toBe(en['errorKind.unknown']);
  });

  it('still says whether retrying is worth doing', () => {
    const friendly = friendlyIn('en');

    expect(friendly(firebaseError('unavailable', '')).retryable).toBe(true);
    expect(friendly(firebaseError('permission-denied', '')).retryable).toBe(false);
  });

  it('has an Arabic string for every situation, not merely for the common ones', () => {
    for (const key of Object.keys(en).filter((name) => name.startsWith('errorKind.'))) {
      const arabic = ar[key as keyof typeof ar];

      expect(arabic, `${key} is missing Arabic`).toBeTruthy();
      expect(arabic, `${key} is still English`).not.toBe(en[key as keyof typeof en]);
    }
  });
});
