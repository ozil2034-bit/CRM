/**
 * Firebase client initialisation.
 *
 * This module owns the SDK handles. Nothing else in the application calls
 * `initializeApp`, and nothing outside `src/services` imports Firestore, Auth or
 * Storage directly (ARCHITECTURE.md §1, enforced by ESLint).
 *
 * Phase 1 establishes initialisation, offline persistence and emulator wiring.
 * Reads and writes arrive with the services in Phase 2 onward.
 */

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, type Auth } from 'firebase/auth';
import {
  initializeFirestore,
  connectFirestoreEmulator,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import { getStorage, connectStorageEmulator, type FirebaseStorage } from 'firebase/storage';
import { getFunctions, connectFunctionsEmulator, type Functions } from 'firebase/functions';

import type { AppEnvironment } from '@/config/env';

export interface FirebaseClient {
  readonly app: FirebaseApp;
  readonly auth: Auth;
  readonly db: Firestore;
  readonly storage: FirebaseStorage;
  readonly functions: Functions;
}

const EMULATOR_HOST = '127.0.0.1';
const EMULATOR_PORTS = {
  auth: 9099,
  firestore: 8080,
  storage: 9199,
  functions: 5001,
} as const;

/** Must match `setGlobalOptions({ region })` in functions/src/index.ts. */
export const FUNCTIONS_REGION = 'europe-west1';

let client: FirebaseClient | null = null;

/**
 * Initialise Firebase once and return the shared handles.
 *
 * Idempotent: repeated calls return the same client, so React Strict Mode's
 * double-invocation in development cannot produce two app instances.
 */
export function initializeFirebase(env: AppEnvironment): FirebaseClient {
  if (client) {
    return client;
  }

  const app = getApps().length > 0 ? getApps()[0]! : initializeApp(env.firebase);

  /*
   * Offline persistence (specification §47).
   *
   * `persistentLocalCache` with the multi-tab manager stores the working set in
   * IndexedDB and coordinates between browser tabs. This is a *cache*: Firestore
   * remains the source of truth. The application never reports a write as
   * synchronised until the server acknowledges it — see ARCHITECTURE.md §5.
   *
   * Configured through `initializeFirestore` rather than the deprecated
   * `enableIndexedDbPersistence`, which must run before any other Firestore call
   * and fails confusingly when it does not.
   */
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
  });

  const auth = getAuth(app);
  const storage = getStorage(app);
  const functions = getFunctions(app, FUNCTIONS_REGION);

  if (env.useEmulators) {
    connectToEmulators({ auth, db, storage, functions });
  }

  client = { app, auth, db, storage, functions };
  return client;
}

/**
 * Access the initialised client.
 *
 * @throws if called before {@link initializeFirebase}, which indicates a
 *         module-import ordering bug rather than a runtime condition to handle.
 */
export function getFirebaseClient(): FirebaseClient {
  if (!client) {
    throw new Error(
      'Firebase has not been initialised. Call initializeFirebase() during application startup.',
    );
  }
  return client;
}

/** Whether Firebase has been initialised. */
export function isFirebaseInitialized(): boolean {
  return client !== null;
}

function connectToEmulators({
  auth,
  db,
  storage,
  functions,
}: {
  auth: Auth;
  db: Firestore;
  storage: FirebaseStorage;
  functions: Functions;
}): void {
  connectAuthEmulator(auth, `http://${EMULATOR_HOST}:${EMULATOR_PORTS.auth}`, {
    disableWarnings: true,
  });
  connectFirestoreEmulator(db, EMULATOR_HOST, EMULATOR_PORTS.firestore);
  connectStorageEmulator(storage, EMULATOR_HOST, EMULATOR_PORTS.storage);
  connectFunctionsEmulator(functions, EMULATOR_HOST, EMULATOR_PORTS.functions);

  console.warn(
    `[Azhary Boutique] Connected to the Firebase Emulator Suite on ${EMULATOR_HOST}. ` +
      'No live project data is being read or written.',
  );
}

/**
 * Reset the module for tests. Not used by application code.
 * @internal
 */
export function resetFirebaseClientForTests(): void {
  client = null;
}
