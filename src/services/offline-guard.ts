import { refusalFor, type GuardedOperation } from '@/domain/connectivity';

/**
 * The one offline guard.
 *
 * Every service that reaches a Cloud Function calls this before it does, and
 * the message comes from `@/domain/connectivity` so an employee sees the same
 * explanation wherever the refusal happens — and one naming what the
 * application was about to do, rather than a generic "you are offline".
 *
 * `navigator.onLine === false` is a **certainty**, not a guess: the browser
 * knows when there is no interface at all. The optimistic direction is the
 * unreliable one, which is why nothing here trusts `true` to mean reachable —
 * the Cloud Function is still the authority, and it will refuse a stale
 * request whatever this returns.
 */
export function assertOnline(operation: GuardedOperation, wrap: (message: string) => Error): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw wrap(refusalFor(operation));
  }
}
