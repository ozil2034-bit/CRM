import { describe, expect, it } from 'vitest';

import {
  isConnectivityState,
  isOperationAllowed,
  isRetryable,
  isSyncState,
  reasonFor,
  refusalFor,
  CONNECTIVITY_STATES,
  GUARDED_OPERATIONS,
  OFFLINE_REASON_MESSAGES,
  SYNC_STATES,
  type ConnectivityState,
  type GuardedOperation,
} from './connectivity';
import { toFriendlyError, developerDetail, codeOf, ERROR_MESSAGES } from './firebase-errors';

/* ------------------------------------------------------------------------ *
 * What may be done offline
 * ------------------------------------------------------------------------ */

describe('operations that need the server', () => {
  it.each(GUARDED_OPERATIONS)('refuses %s when offline', (operation) => {
    expect(isOperationAllowed(operation, 'offline')).toBe(false);
  });

  it.each(GUARDED_OPERATIONS)('allows %s when online', (operation) => {
    expect(isOperationAllowed(operation, 'online')).toBe(true);
  });

  it('treats RECONNECTING as offline, not as online', () => {
    /*
     * Load-bearing. The browser reports `online` the instant an interface comes
     * up, well before Firestore has re-established its stream. Letting a
     * booking through in those seconds is exactly how it gets made against a
     * stale cache.
     */
    for (const operation of GUARDED_OPERATIONS) {
      expect(isOperationAllowed(operation, 'reconnecting')).toBe(false);
    }
  });

  it('guards every operation the specification names', () => {
    const guarded = new Set<string>(GUARDED_OPERATIONS);

    // §3's disallowed list, item by item.
    expect(guarded.has('reservation.create')).toBe(true);
    expect(guarded.has('reservation.changeDates')).toBe(true);
    expect(guarded.has('payment.record')).toBe(true);
    expect(guarded.has('payment.refund')).toBe(true);
    expect(guarded.has('deposit.settle')).toBe(true);
    expect(guarded.has('deposit.forfeit')).toBe(true);
    expect(guarded.has('document.issue')).toBe(true);
  });
});

describe('why an operation is refused', () => {
  it('gives booking a reason about availability, not a generic one', () => {
    expect(reasonFor('reservation.create')).toBe('AVAILABILITY');
    expect(refusalFor('reservation.create')).toContain('available');
  });

  it('gives every financial operation a reason about the ledger', () => {
    for (const operation of [
      'payment.record',
      'payment.refund',
      'payment.reverse',
      'deposit.settle',
      'deposit.forfeit',
    ] as const) {
      expect(reasonFor(operation)).toBe('LEDGER');
    }

    expect(refusalFor('payment.record')).toContain('Financial operations');
  });

  it('gives issuing a document a reason about its number', () => {
    expect(reasonFor('document.issue')).toBe('DOCUMENT_NUMBER');
  });

  it('has a distinct message for every reason', () => {
    // A single generic message would tell an employee nothing the indicator
    // does not already show.
    const messages = Object.values(OFFLINE_REASON_MESSAGES);

    expect(new Set(messages).size).toBe(messages.length);
  });

  it('explains rather than merely refusing', () => {
    for (const operation of GUARDED_OPERATIONS) {
      const message = refusalFor(operation as GuardedOperation);

      expect(message.length).toBeGreaterThan(30);
      expect(message).toMatch(/connection/i);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * The states
 * ------------------------------------------------------------------------ */

describe('connectivity states', () => {
  it('has exactly three, including reconnecting', () => {
    expect([...CONNECTIVITY_STATES]).toEqual(['online', 'offline', 'reconnecting']);
  });

  it('recognises its own states and nothing else', () => {
    for (const state of CONNECTIVITY_STATES) {
      expect(isConnectivityState(state)).toBe(true);
    }
    expect(isConnectivityState('connected')).toBe(false);
    expect(isConnectivityState(null)).toBe(false);
  });
});

describe('sync states', () => {
  it('are pending, synced and failed — never "saved" for an unacknowledged write', () => {
    expect([...SYNC_STATES]).toEqual(['pending', 'synced', 'failed']);
    expect(isSyncState('saved')).toBe(false);
  });

  it('offers a retry only for a failure', () => {
    expect(isRetryable('failed')).toBe(true);
    expect(isRetryable('pending')).toBe(false);
    expect(isRetryable('synced')).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * Firebase errors
 * ------------------------------------------------------------------------ */

describe('translating a Firebase error', () => {
  const thrown = (code: string) => Object.assign(new Error('raw sdk text'), { code });

  it.each([
    ['unavailable', 'offline'],
    ['auth/network-request-failed', 'offline'],
    ['deadline-exceeded', 'timeout'],
    ['permission-denied', 'permission'],
    ['functions/permission-denied', 'permission'],
    ['unauthenticated', 'unauthenticated'],
    ['not-found', 'notFound'],
    ['storage/object-not-found', 'notFound'],
    ['aborted', 'conflict'],
    ['failed-precondition', 'conflict'],
    ['resource-exhausted', 'quota'],
    ['invalid-argument', 'invalid'],
  ])('maps %s to %s', (code, expected) => {
    expect(toFriendlyError(thrown(code)).kind).toBe(expected);
  });

  it('matches on the suffix, so both SDK shapes of one code agree', () => {
    expect(toFriendlyError(thrown('not-found')).kind).toBe(
      toFriendlyError(thrown('functions/not-found')).kind,
    );
  });

  it('NEVER leaks the raw SDK text to the employee', () => {
    /*
     * "Missing or insufficient permissions" names an internal control and helps
     * nobody at the counter decide what to do next.
     */
    const friendly = toFriendlyError(thrown('permission-denied'));

    expect(friendly.message).not.toContain('raw sdk text');
    expect(friendly.message).toBe(ERROR_MESSAGES.permission);
  });

  it('falls back to a usable message for an unrecognised code', () => {
    expect(toFriendlyError(thrown('some-new-code')).kind).toBe('unknown');
  });

  it('handles a thrown value that is not an error at all', () => {
    // An error handler that throws is the worst possible error handler.
    for (const value of [null, undefined, 'a string', 42, {}, []]) {
      expect(() => toFriendlyError(value)).not.toThrow();
      expect(toFriendlyError(value).kind).toBe('unknown');
    }
  });

  it('offers a retry only where one could succeed', () => {
    expect(toFriendlyError(thrown('unavailable')).retryable).toBe(true);
    expect(toFriendlyError(thrown('aborted')).retryable).toBe(true);

    // Retrying a refusal just refuses again.
    expect(toFriendlyError(thrown('permission-denied')).retryable).toBe(false);
    expect(toFriendlyError(thrown('invalid-argument')).retryable).toBe(false);
  });

  it('tells the employee what to DO, not what went wrong internally', () => {
    expect(ERROR_MESSAGES.unauthenticated).toContain('Sign in');
    expect(ERROR_MESSAGES.permission).toContain('Ask the owner');
    expect(ERROR_MESSAGES.conflict).toContain('Reload');
  });

  it('reassures that nothing was lost when the connection is the problem', () => {
    expect(ERROR_MESSAGES.offline).toContain('nothing was lost');
  });
});

describe('the developer detail', () => {
  it('keeps the code, the message and the stack', () => {
    const detail = developerDetail(Object.assign(new Error('boom'), { code: 'unavailable' }));

    expect(detail).toContain('[unavailable]');
    expect(detail).toContain('boom');
  });

  it('survives a value that cannot be serialised', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(() => developerDetail(circular)).not.toThrow();
  });

  it('reads a code off any shape that carries one', () => {
    expect(codeOf({ code: 'unavailable' })).toBe('unavailable');
    expect(codeOf({ code: 42 })).toBeNull();
    expect(codeOf(null)).toBeNull();
    expect(codeOf('string')).toBeNull();
  });
});

/* ------------------------------------------------------------------------ *
 * The whole point
 * ------------------------------------------------------------------------ */

describe('the offline contract', () => {
  it('never queues a booking or a payment, in any state', () => {
    /*
     * The single assertion this module exists for. A reservation queued at
     * 09:00 and delivered at 14:00 is judged against availability as it was at
     * 09:00, by which time somebody else may have taken the gown.
     */
    const offlineStates: ConnectivityState[] = ['offline', 'reconnecting'];

    for (const state of offlineStates) {
      expect(isOperationAllowed('reservation.create', state)).toBe(false);
      expect(isOperationAllowed('payment.record', state)).toBe(false);
    }
  });
});
