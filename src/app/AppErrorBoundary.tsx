import { useRouteError, isRouteErrorResponse, useLocation, useNavigate } from 'react-router-dom';

import { Button } from '@/design-system';
import { useT } from '@/hooks/useT';
import { toFriendlyError, developerDetail } from '@/domain/firebase-errors';
import type { TranslationKey } from '@/lib/i18n/dictionary';

/**
 * Route-level error boundary — §22, §45.
 *
 * A render or loader failure in one screen must not blank the whole
 * application. A boutique tablet showing a white page mid-fitting is not a
 * recoverable situation for the employee holding it, and "reload and hope" is
 * not an instruction.
 *
 * So this screen does three things, in this order of usefulness:
 *
 *   1. says what happened, in the employee's language, without naming
 *      infrastructure;
 *   2. says what was *not* affected — the fear after a crash is "did I just
 *      lose her payment?", and the honest answer is no, because this boundary
 *      catches rendering, and every write in this application is a server
 *      transaction that either committed or did not;
 *   3. offers two ways out: try this screen again, or leave it for one known
 *      to work.
 *
 * The raw error is never shown to an employee. It names collections, document
 * paths and — through a path — customers. It goes to the console in
 * development, where the person reading it is the person who can fix it.
 */
export function AppErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useT();

  /*
   * A 404 from the router is a different situation from a crash, and worth
   * distinguishing: nothing is broken, the address is simply wrong.
   */
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const friendly = toFriendlyError(error);
  const message = notFound
    ? t('errorKind.notFound')
    : t(`errorKind.${friendly.kind}` as TranslationKey);

  if (import.meta.env.DEV) {
    console.error(developerDetail(error));
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16">
      <p className="label-caps">{t('crash.eyebrow')}</p>
      <h1 className="display mt-3 text-3xl text-ink-900">{t('crash.title')}</h1>

      <p className="mt-4 text-sm text-ink-700">{message}</p>
      <p className="mt-2 text-2xs text-ink-400">{t('crash.reassurance')}</p>

      <div className="mt-8 flex flex-wrap gap-3">
        {/*
         * Re-navigating to the same address is tried first. A completed
         * navigation clears the router's error state and re-mounts the route,
         * so a transient failure — a query that raced a sign-in, a snapshot
         * that arrived half-written — clears without a full page load, and
         * without the seconds of white screen that a reload costs on a tablet.
         */}
        <Button
          onClick={() =>
            void navigate(`${location.pathname}${location.search}`, { replace: true })
          }
        >
          {t('crash.retry')}
        </Button>

        {/* And if it does not clear, a screen known to work. */}
        <Button variant="ghost" onClick={() => void navigate('/', { replace: true })}>
          {t('crash.home')}
        </Button>
      </div>
    </main>
  );
}
