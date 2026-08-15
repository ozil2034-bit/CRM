/**
 * Service worker registration.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE APPLICATION NEVER RELOADS ITSELF
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `registerType: 'prompt'` in the Vite config, and this module honours it: when
 * a new build is available the interface says so and waits. It does not reload.
 *
 * The reason is specific. An employee recording a payment has a half-filled
 * form and an idempotency key generated when it opened; a reload discards both.
 * They would then re-enter the payment — and because the key changed, the
 * server would see a second, legitimate-looking request. Auto-updating a
 * service worker is how a customer gets charged twice.
 *
 * So the update waits for a click, and the click happens between transactions
 * because that is when somebody reads a banner.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS CACHED
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The shell only — the built JavaScript, CSS, fonts and icons. No Firestore
 * response, no Storage object, no callable result. See the `workbox` block in
 * `vite.config.ts` for why: Firestore has its own cache tied to the signed-in
 * user, and a copy in the Cache API would outlive the session entitled to read
 * it.
 */

import { registerSW } from 'virtual:pwa-register';

export interface ServiceWorkerHandle {
  /** Apply the waiting update and reload. Called from a click, never a timer. */
  readonly update: () => Promise<void>;
}

export interface RegisterOptions {
  /** A newer build is waiting. Show the banner. */
  readonly onUpdateAvailable: (handle: ServiceWorkerHandle) => void;
  /** The shell is cached; the application will now open offline. */
  readonly onOfflineReady: () => void;
}

/**
 * Register the service worker, if the browser has one.
 *
 * A browser without service worker support gets a perfectly good online-only
 * application, which is why nothing here throws or warns at the employee. On
 * iOS this is also the state until the application is added to the Home Screen.
 */
export function registerServiceWorker(options: RegisterOptions): void {
  if (!('serviceWorker' in navigator)) return;

  const updateSW = registerSW({
    immediate: true,

    onNeedRefresh() {
      options.onUpdateAvailable({
        /*
         * `updateSW(true)` tells the waiting worker to activate and reloads.
         * The reload is the point — a page holding the old JavaScript against
         * the new worker's CSS is exactly the mixed-version state §15 warns
         * about.
         */
        update: async () => {
          await updateSW(true);
        },
      });
    },

    onOfflineReady() {
      options.onOfflineReady();
    },

    onRegisterError(error: unknown) {
      /*
       * A failed registration is not an employee-facing problem: the
       * application works, it simply will not work offline. Logged for a
       * developer and otherwise silent.
       */
      if (import.meta.env.DEV) {
        console.warn('[Azhary Boutique] Service worker registration failed.', error);
      }
    },
  });
}
