/**
 * Firebase errors, translated into things an employee can act on.
 *
 * A raw SDK error tells the person at the counter nothing useful and quite a
 * lot they should not see. `FirebaseError: Missing or insufficient permissions`
 * names an internal control; `PERMISSION_DENIED: Function not found` names
 * infrastructure. Neither helps somebody decide what to do next, and both make
 * a working application look broken.
 *
 * So every error reaching an employee passes through here and comes out as one
 * of a small set of situations, each with an action implied:
 *
 *   - it is not their fault and retrying will work      → offer retry
 *   - it is not their fault and retrying will not work  → say who to ask
 *   - they are not signed in any more                   → sign in again
 *   - the thing they wanted is gone                     → go back
 *
 * The original error is never discarded — it goes to the console in
 * development, where a developer wants exactly the detail an employee must not
 * be shown.
 *
 * Pure: no I/O, no `console`. The caller decides what to log.
 */

/** The situations an employee can meaningfully be told about. */
export const ERROR_KINDS = [
  'offline',
  'timeout',
  'permission',
  'unauthenticated',
  'notFound',
  'conflict',
  'quota',
  'invalid',
  'unknown',
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

export interface FriendlyError {
  readonly kind: ErrorKind;
  readonly message: string;
  /** Whether pressing the same button again is worth doing. */
  readonly retryable: boolean;
}

/**
 * Firebase error codes, mapped to a situation.
 *
 * Codes arrive in two shapes depending on which SDK produced them —
 * `permission-denied` from Firestore, `functions/permission-denied` from a
 * callable, `auth/network-request-failed` from Auth — so matching is on the
 * suffix after the last slash.
 */
const KIND_BY_CODE: Readonly<Record<string, ErrorKind>> = {
  /* Network */
  unavailable: 'offline',
  'network-request-failed': 'offline',
  'deadline-exceeded': 'timeout',

  /* Authorization */
  'permission-denied': 'permission',
  unauthenticated: 'unauthenticated',
  'user-token-expired': 'unauthenticated',
  'user-disabled': 'unauthenticated',
  'requires-recent-login': 'unauthenticated',

  /* The thing itself */
  'not-found': 'notFound',
  'object-not-found': 'notFound',
  'already-exists': 'conflict',
  aborted: 'conflict',
  'failed-precondition': 'conflict',

  /* Limits */
  'resource-exhausted': 'quota',
  'quota-exceeded': 'quota',
  'too-many-requests': 'quota',

  /* The request */
  'invalid-argument': 'invalid',
  'out-of-range': 'invalid',
};

export const ERROR_MESSAGES: Readonly<Record<ErrorKind, string>> = {
  offline:
    'This needs an internet connection. Check the connection and try again — nothing was lost.',
  timeout: 'The server took too long to answer. Try again.',
  permission: 'You do not have permission to do that. Ask the owner if you need access.',
  unauthenticated: 'Your session has ended. Sign in again to continue.',
  notFound: 'That record no longer exists. It may have been removed on another device.',
  conflict:
    'Somebody else changed this at the same moment. Reload to see the current version, then try again.',
  quota: 'The system is busy. Wait a moment and try again.',
  invalid: 'Some of the details are not valid. Check the form and try again.',
  unknown: 'Something went wrong. Try again, and tell the owner if it keeps happening.',
};

/** Retrying is worth offering only where it could plausibly succeed. */
const RETRYABLE: ReadonlySet<ErrorKind> = new Set(['offline', 'timeout', 'conflict', 'quota']);

/**
 * The code carried by a thrown value, if any.
 *
 * Deliberately tolerant: this is called in `catch` blocks, where the value can
 * be anything at all, and an error handler that throws is the worst possible
 * error handler.
 */
export function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;

  const code = (error as { code?: unknown }).code;

  return typeof code === 'string' && code.length > 0 ? code : null;
}

/** The part after the last slash: `functions/not-found` → `not-found`. */
function suffix(code: string): string {
  const parts = code.split('/');
  return (parts[parts.length - 1] ?? code).toLowerCase();
}

/**
 * Translate any thrown value into something an employee can read.
 *
 * @throws never.
 */
export function toFriendlyError(error: unknown): FriendlyError {
  const code = codeOf(error);
  const kind: ErrorKind = code === null ? 'unknown' : (KIND_BY_CODE[suffix(code)] ?? 'unknown');

  return {
    kind,
    message: ERROR_MESSAGES[kind],
    retryable: RETRYABLE.has(kind),
  };
}

/**
 * The detail a developer wants, and an employee must not be shown.
 *
 * Returned as a string rather than logged here so the caller decides — and so
 * this module stays pure and testable. Callers guard it behind
 * `import.meta.env.DEV`.
 */
export function developerDetail(error: unknown): string {
  if (error instanceof Error) {
    const code = codeOf(error);
    return [code === null ? null : `[${code}]`, error.message, error.stack]
      .filter((part): part is string => part !== null && part !== undefined)
      .join('\n');
  }

  try {
    return JSON.stringify(error);
  } catch {
    // A value that cannot be serialised — a circular structure, a Proxy that
    // throws — must still not break the error path.
    return String(error);
  }
}
