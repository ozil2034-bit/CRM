/**
 * Azhary Boutique — trusted server-side operations.
 *
 * Only operations that cannot be safely authorised on the client live here.
 * Everything else goes through the Firestore SDK and is governed by
 * firestore.rules.
 *
 * Phase 2 exports the identity operations. Custom claims are writable only by
 * the Admin SDK, so there is no client path to any of them by construction —
 * not merely by rule.
 */

import { setGlobalOptions } from 'firebase-functions/v2';

setGlobalOptions({
  region: 'europe-west1',
  maxInstances: 10,
});

export { getBootstrapState, claimInitialOwnership } from './bootstrap';
export { createEmployee, setUserRole, setUserActive } from './users';
export {
  createReservation,
  updateReservationDates,
  changeReservationStatus,
  releaseCleanedDresses,
  checkAvailability,
} from './reservations';

/*
 * Phase 5. Every financial write is here for the same reason booking is: a
 * balance is a reduction over an event list, so deciding whether a payment is
 * permitted means reading a query and then writing based on the answer. The
 * client SDK cannot do that inside a transaction, and a browser-computed
 * balance is stale the moment two tills are open.
 */
export {
  recordPayment,
  recordSecurityDeposit,
  refundPayment,
  reversePayment,
  settleDeposit,
  postLateFee,
  quoteCancellationFor,
  cancelReservationFinancially,
} from './payments';

/*
 * Phase 6. Issuing allocates a number from a per-year counter and captures the
 * whole snapshot at one instant; both need a transaction the client SDK cannot
 * run. The rules refuse every client write to `invoices`, so this is the only
 * path — an invoice whose figures the browser chose is not evidence of anything.
 */
export { issueDocument, voidDocument, recordPrintIntent } from './documents';
