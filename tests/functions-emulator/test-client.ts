/**
 * Point the service layer at emulator handles.
 *
 * The services resolve their Firebase handles through `getFirebaseClient()`,
 * which the browser populates during startup. Integration tests construct their
 * own emulator-connected app, so this hands those handles to the same module —
 * letting the tests exercise the real service code rather than a reimplementation
 * of it.
 */

import { setFirebaseClientForTests } from '@/lib/firebase/client';

export { setFirebaseClientForTests as initializeFirebaseForTests };
