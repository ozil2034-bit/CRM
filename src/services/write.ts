/**
 * Write outcomes and offline honesty.
 *
 * The specification forbids reporting "saved to cloud" before the server has
 * acknowledged a write. Firestore makes that easy to get wrong: a `setDoc`
 * promise **does not resolve while offline**, and the local cache is updated
 * immediately either way. Awaiting the promise therefore hangs offline, and not
 * awaiting it reports success that has not happened.
 *
 * So writes report one of three outcomes, and the interface says exactly which.
 */

import { disableNetwork, enableNetwork, type Firestore } from 'firebase/firestore';

export type WriteOutcome =
  /** The server acknowledged the write. */
  | { readonly status: 'synced' }
  /**
   * Written to the device and queued. Firestore will send it when the
   * connection returns. This is a real, durable local write — not a failure —
   * but it is NOT confirmed by the server, and the interface must say so.
   */
  | { readonly status: 'pending' }
  | { readonly status: 'failed'; readonly error: Error };

/**
 * How long to wait for a server acknowledgement before calling a write
 * "pending".
 *
 * Long enough that a normal write on a slow connection still reports as synced;
 * short enough that an employee on a dead connection is not left watching a
 * spinner. The write is not cancelled at the deadline — it stays queued, and
 * any later failure is still surfaced through `onLateFailure`.
 */
export const SYNC_ACKNOWLEDGEMENT_TIMEOUT_MS = 4000;

export interface CommitOptions {
  /**
   * Called if the write ultimately fails *after* it was reported as pending.
   * Used to correct an optimistic "queued" message rather than leave it
   * standing.
   */
  readonly onLateFailure?: (error: Error) => void;
  readonly timeoutMs?: number;
}

/**
 * Commit a non-transactional write and report what actually happened.
 *
 * `operation` must be a function that *starts* the write, not an already-awaited
 * promise: Firestore applies it to the local cache synchronously, so the caller's
 * UI can update while the acknowledgement is still outstanding.
 */
export async function commitWrite(
  operation: () => Promise<void>,
  options: CommitOptions = {},
): Promise<WriteOutcome> {
  const timeoutMs = options.timeoutMs ?? SYNC_ACKNOWLEDGEMENT_TIMEOUT_MS;

  let settled = false;

  /*
   * Both branches are handled here rather than with a separate `.catch`, so the
   * promise is never left with an unhandled rejection when the timeout wins the
   * race.
   */
  const resolution: Promise<WriteOutcome> = operation().then(
    () => {
      settled = true;
      return { status: 'synced' } as const;
    },
    (error: unknown) => {
      settled = true;
      return { status: 'failed', error: toError(error) } as const;
    },
  );

  const timeout = new Promise<WriteOutcome>((resolve) => {
    setTimeout(() => {
      if (!settled) {
        resolve({ status: 'pending' });
      }
    }, timeoutMs);
  });

  const outcome = await Promise.race([resolution, timeout]);

  if (outcome.status === 'pending' && options.onLateFailure) {
    // Keep watching. A queued write later rejected — by the rules, or by a
    // validation failure — must not stay reported as "will sync".
    void resolution.then((late) => {
      if (late.status === 'failed') {
        options.onLateFailure?.(late.error);
      }
    });
  }

  return outcome;
}

/**
 * Run a Firestore transaction and report the outcome.
 *
 * Transactions have no offline mode: they need a round trip to read the current
 * state, so they fail rather than queue when there is no connection. Record
 * creation uses a transaction (to allocate a unique code), which means creating
 * a dress or customer genuinely requires a connection — and the caller is told
 * that plainly instead of being handed a write that will never arrive.
 */
export async function commitTransaction<T>(
  operation: () => Promise<T>,
): Promise<
  | { readonly status: 'synced'; readonly value: T }
  | { readonly status: 'failed'; readonly error: Error }
> {
  try {
    const value = await operation();
    return { status: 'synced', value };
  } catch (error) {
    return { status: 'failed', error: toError(error) };
  }
}

/**
 * Attempts allowed when a transaction contends for the same counter document.
 *
 * Eight employees creating a dress at the same instant is already beyond
 * anything a boutique will do; this leaves ample headroom.
 */
export const TRANSACTION_MAX_ATTEMPTS = 10;

/**
 * Run a transaction, retrying when it loses a race for a contended document.
 *
 * **Why this exists.** Record creation allocates a code by reading
 * `counters/{kind}` and writing `current + 1`, and the security rule enforces
 * that the increment is exactly one — which is what makes duplicate codes
 * impossible. Under contention, a transaction that read `7` tries to write `8`
 * after another has already written `8`, and the rule correctly refuses it.
 *
 * Firestore reports that refusal as **`permission-denied`, not `aborted`**,
 * because the rule is what rejected the write. `permission-denied` is not
 * retryable as far as the SDK is concerned, so `runTransaction` gives up
 * immediately — and an employee creating a dress while a colleague does the
 * same is told they lack permission. Verified against the emulator: eight
 * concurrent creations produced six codes and two spurious denials, with no
 * duplicates.
 *
 * Retrying here restores the behaviour the counter design intended. The cost of
 * retrying a *genuine* permission denial is a few milliseconds of backoff before
 * the identical error surfaces unchanged — the caller sees the same message
 * either way.
 *
 * Backoff is randomised so retrying writers do not re-collide in lockstep.
 */
export async function commitTransactionWithRetry<T>(
  operation: () => Promise<T>,
  maxAttempts = TRANSACTION_MAX_ATTEMPTS,
): Promise<
  | { readonly status: 'synced'; readonly value: T }
  | { readonly status: 'failed'; readonly error: Error }
> {
  let lastError: Error = new Error('The operation did not run.');

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return { status: 'synced', value: await operation() };
    } catch (error) {
      lastError = toError(error);

      if (!isContentionError(lastError)) {
        return { status: 'failed', error: lastError };
      }

      const backoffMs = Math.min(200, 10 * 2 ** attempt) * (0.5 + Math.random());
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  return { status: 'failed', error: lastError };
}

/**
 * Codes that can mean "another writer got there first".
 *
 * `permission-denied` is included for the reason above. It is the only code
 * here that is ambiguous, and the ambiguity is resolved safely: a real denial
 * still fails, just a few milliseconds later.
 */
function isContentionError(error: Error): boolean {
  const code = (error as { code?: string }).code ?? '';
  return code === 'aborted' || code === 'already-exists' || code === 'permission-denied';
}

/** Does this failure mean "no connection" rather than "refused"? */
export function isOfflineError(error: Error): boolean {
  const code = (error as { code?: string }).code ?? '';
  return code === 'unavailable' || code === 'failed-precondition' || !navigatorOnline();
}

export function isPermissionError(error: Error): boolean {
  return (error as { code?: string }).code === 'permission-denied';
}

function navigatorOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine;
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

/**
 * Test seam for exercising offline behaviour against the emulator.
 * @internal
 */
export async function goOffline(db: Firestore): Promise<void> {
  await disableNetwork(db);
}

/** @internal */
export async function goOnline(db: Firestore): Promise<void> {
  await enableNetwork(db);
}
