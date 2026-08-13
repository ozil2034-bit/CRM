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
