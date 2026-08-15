/**
 * Connectivity, and what may be done without it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * OFFLINE SUPPORT IS NOT PERMISSION TO DO EVERYTHING OFFLINE
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Firestore will happily queue a write made with no connection and send it when
 * the connection returns. For most applications that is the whole point. For
 * this one it is a trap, and the reason is the same reason booking and payment
 * run as Cloud Functions in the first place:
 *
 * **An operation whose legality depends on current server state cannot be
 * decided on a device that has not seen the server.**
 *
 * A reservation queued at 09:00 and delivered at 14:00 is judged against
 * availability as it was at 09:00 — by which time somebody else may have taken
 * the gown. A payment queued offline is computed against a balance that may
 * since have moved. Neither failure is visible at the moment it is made; both
 * surface hours later as a double-booked dress or a customer asked to pay twice.
 *
 * So those operations **fail immediately, with a reason**, and nothing is
 * queued. A clear refusal now is worth far more than a silent success that
 * turns into a conflict this afternoon.
 *
 * What *is* safe offline: reading the cache, navigating, and editing the
 * handful of fields whose correctness does not depend on anything else — a
 * customer's phone number, a note on a booking. Those already go through
 * `commitWrite`, which reports `pending` rather than claiming a save.
 *
 * Pure: no `navigator`, no I/O. The state is a parameter.
 */

/* ------------------------------------------------------------------------ *
 * The states
 * ------------------------------------------------------------------------ */

/**
 * What the application believes about its connection.
 *
 * `reconnecting` is a real third state, not decoration: the browser reports
 * `online` the instant an interface comes up, well before Firestore has
 * re-established its stream. Showing "Connected" then is a small lie that
 * invites an employee to press a button that will fail.
 */
export const CONNECTIVITY_STATES = ['online', 'offline', 'reconnecting'] as const;
export type ConnectivityState = (typeof CONNECTIVITY_STATES)[number];

export function isConnectivityState(value: unknown): value is ConnectivityState {
  return value === 'online' || value === 'offline' || value === 'reconnecting';
}

/* ------------------------------------------------------------------------ *
 * Operations
 * ------------------------------------------------------------------------ */

/**
 * Every operation whose availability depends on the connection.
 *
 * A closed set, so adding a server-dependent operation means deciding
 * deliberately which side of this line it falls on rather than discovering the
 * answer in production.
 */
export const GUARDED_OPERATIONS = [
  'reservation.create',
  'reservation.changeDates',
  'reservation.changeStatus',
  'reservation.amend',
  'payment.record',
  'payment.refund',
  'payment.reverse',
  'deposit.settle',
  'deposit.forfeit',
  'document.issue',
  'document.void',
  'employee.create',
  'employee.changeRole',
  'record.create',
] as const;

export type GuardedOperation = (typeof GUARDED_OPERATIONS)[number];

/**
 * Why each operation needs the network.
 *
 * Distinct reasons rather than one generic message, because "you need a
 * connection" tells an employee nothing they cannot see from the indicator.
 * "An internet connection is required to verify the dress is still free" tells
 * them what the application was about to do on their behalf.
 */
export type OfflineReason =
  | 'AVAILABILITY'
  | 'LEDGER'
  | 'DOCUMENT_NUMBER'
  | 'IDENTITY'
  | 'UNIQUE_CODE';

const REASON_BY_OPERATION: Readonly<Record<GuardedOperation, OfflineReason>> = {
  'reservation.create': 'AVAILABILITY',
  'reservation.changeDates': 'AVAILABILITY',
  'reservation.changeStatus': 'AVAILABILITY',
  'reservation.amend': 'LEDGER',
  'payment.record': 'LEDGER',
  'payment.refund': 'LEDGER',
  'payment.reverse': 'LEDGER',
  'deposit.settle': 'LEDGER',
  'deposit.forfeit': 'LEDGER',
  'document.issue': 'DOCUMENT_NUMBER',
  'document.void': 'DOCUMENT_NUMBER',
  'employee.create': 'IDENTITY',
  'employee.changeRole': 'IDENTITY',
  'record.create': 'UNIQUE_CODE',
};

export const OFFLINE_REASON_MESSAGES: Readonly<Record<OfflineReason, string>> = {
  AVAILABILITY:
    'An internet connection is required to check that the dress is still available.',
  LEDGER:
    'Financial operations require an internet connection, so the balance is calculated from the current record rather than a cached one.',
  DOCUMENT_NUMBER:
    'An internet connection is required to issue a document, so its number is unique.',
  IDENTITY: 'An internet connection is required to change who can use this application.',
  UNIQUE_CODE:
    'An internet connection is required to create a record, so its code is unique.',
};

export function reasonFor(operation: GuardedOperation): OfflineReason {
  return REASON_BY_OPERATION[operation];
}

/**
 * May this operation be attempted in this connectivity state?
 *
 * **`reconnecting` is treated as offline.** The optimistic reading — "the
 * network is probably back, let it through" — is exactly how a booking gets
 * made against a stale cache in the seconds before the stream re-establishes.
 * Waiting a moment costs nothing; a double booking costs a wedding.
 */
export function isOperationAllowed(
  _operation: GuardedOperation,
  state: ConnectivityState,
): boolean {
  /*
   * Every guarded operation has the same answer today: online only. The
   * operation is still a parameter because the *reason* differs per operation
   * and the call sites read better naming what they are asking about — and
   * because the day one of these becomes safely queueable, this is the single
   * place that changes.
   */
  return state === 'online';
}

/** The message to show when an operation is refused. */
export function refusalFor(operation: GuardedOperation): string {
  return OFFLINE_REASON_MESSAGES[reasonFor(operation)];
}

/* ------------------------------------------------------------------------ *
 * Pending writes
 * ------------------------------------------------------------------------ */

/**
 * What happened to a write the application *did* accept.
 *
 * The vocabulary matters as much as it does for messaging: `pending` means
 * written to this device and not yet acknowledged by the server. It is a real,
 * durable local write and not a failure — but it is **not** confirmed, and the
 * interface must never round it up to "saved".
 */
export const SYNC_STATES = ['pending', 'synced', 'failed'] as const;
export type SyncState = (typeof SYNC_STATES)[number];

export function isSyncState(value: unknown): value is SyncState {
  return value === 'pending' || value === 'synced' || value === 'failed';
}

/** Whether a failed write is worth offering a retry for. */
export function isRetryable(state: SyncState): boolean {
  return state === 'failed';
}
