import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ConnectivityState } from '@/domain/connectivity';
import { ConnectivityContext, type ConnectivityContextValue } from './connectivity-context';

/**
 * How long to stay in `reconnecting` after the browser reports the network back.
 *
 * `navigator.onLine` flips the moment an interface comes up — a phone finding
 * Wi-Fi, a laptop waking. Firestore's stream takes longer, and a write issued in
 * between fails in a way that looks like the application is broken.
 *
 * Two seconds is long enough for the stream to re-establish on a normal
 * connection and short enough that nobody stares at the banner. It is a
 * heuristic, not a guarantee, which is why the *authoritative* check is still
 * the Cloud Function refusing a stale request.
 */
const RECONNECTING_MS = 2000;

/**
 * Connectivity, as the application understands it.
 *
 * Three states rather than the browser's two. `navigator.onLine` answers "is
 * there a network interface", which is not the question — a captive portal in a
 * hotel lobby reports online and reaches nothing. `reconnecting` covers the gap
 * between the interface coming up and Firestore actually being reachable, and
 * every guarded operation treats it as offline.
 *
 * This is a **courtesy layer**. It decides which buttons are offered and what
 * the banner says. It is not a security control and not a correctness control:
 * the operations that matter are refused by a Cloud Function that can see the
 * real state of the database, and would be refused even if this reported online
 * incorrectly.
 */
export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConnectivityState>(() =>
    typeof navigator === 'undefined' || navigator.onLine ? 'online' : 'offline',
  );

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    function handleOnline(): void {
      clearTimer();
      setState('reconnecting');

      timer.current = setTimeout(() => {
        timer.current = null;
        setState('online');
      }, RECONNECTING_MS);
    }

    function handleOffline(): void {
      // Going offline is immediate and certain; there is nothing to wait for.
      clearTimer();
      setState('offline');
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearTimer();
    };
  }, [clearTimer]);

  const value = useMemo<ConnectivityContextValue>(
    () => ({
      state,
      isOnline: state === 'online',
      /*
       * Both non-online states count as offline for every guarded operation.
       * The optimistic reading of `reconnecting` is exactly how a booking gets
       * made against a stale cache.
       */
      isOffline: state !== 'online',
    }),
    [state],
  );

  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>;
}
