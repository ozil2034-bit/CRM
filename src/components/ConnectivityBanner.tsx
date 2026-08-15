import { useEffect, useState } from 'react';

import { useT } from '@/hooks/useT';
import { useConnectivity } from '@/hooks/useConnectivity';
import { registerServiceWorker, type ServiceWorkerHandle } from '@/lib/pwa/register';
import { cn } from '@/lib/utils/cn';

/**
 * The connectivity strip, and the update prompt.
 *
 * ## Restraint is the design
 *
 * Offline is a **normal condition** in a shop with thick walls, not an
 * emergency. A red full-width alarm every time a phone loses a bar trains staff
 * to ignore the one message that matters. So the strip is quiet, states the
 * fact, and names the consequence in the same breath: some actions are
 * unavailable.
 *
 * When everything is fine it renders **nothing**. A permanent "Connected"
 * badge is a control that has never once told anybody something useful.
 *
 * ## The update prompt
 *
 * Shown, never acted on. The application does not reload itself — see
 * `lib/pwa/register.ts` for why an auto-update can charge a customer twice.
 */
export function ConnectivityBanner() {
  const { t } = useT();
  const { state } = useConnectivity();

  const [waiting, setWaiting] = useState<ServiceWorkerHandle | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    registerServiceWorker({
      onUpdateAvailable: setWaiting,
      onOfflineReady: () => {
        // Deliberately silent. "This application now works offline" is a
        // developer's milestone, not an employee's news.
      },
    });
  }, []);

  const offline = state === 'offline';
  const reconnecting = state === 'reconnecting';

  if (!offline && !reconnecting && waiting === null) return null;

  return (
    <div
      /*
       * `polite`, not `assertive`. Losing a connection should not interrupt a
       * screen reader mid-sentence, and the information keeps.
       */
      role="status"
      aria-live="polite"
      className="sticky top-0 z-30"
    >
      {(offline || reconnecting) && (
        <div
          className={cn(
            'flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 py-2 text-2xs',
            offline ? 'bg-sand-200 text-ink-800' : 'bg-sand-100 text-ink-600',
          )}
        >
          {/* A word, never a colour alone. */}
          <span aria-hidden="true">{offline ? '○' : '◐'}</span>
          <span>{offline ? t('connectivity.offline') : t('connectivity.reconnecting')}</span>
        </div>
      )}

      {waiting !== null && (
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-gold-300 px-4 py-2 text-2xs text-ink-900">
          <span>{t('pwa.updateAvailable')}</span>

          <button
            type="button"
            disabled={updating}
            onClick={() => {
              setUpdating(true);
              void waiting.update();
            }}
            className="min-h-8 rounded-xs px-2 underline underline-offset-2 hover:text-ink-700"
          >
            {updating ? t('pwa.updating') : t('pwa.update')}
          </button>
        </div>
      )}
    </div>
  );
}
