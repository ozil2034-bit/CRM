import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Cloud Functions integration tests.
 *
 * These exercise the deployed callables against the Auth, Firestore and
 * Functions emulators together — the bootstrap transaction, custom claim
 * writes, audit records and the security rules, all at once.
 *
 * Separate from both other suites: they need three emulators and a built
 * `functions/lib`, so they run only through `npm run test:functions`.
 *
 * Single worker and no file parallelism are required, not merely preferred: the
 * owner bootstrap is a one-time transition, so the tests describe one ordered
 * lifecycle rather than a set of independent cases.
 */
export default defineConfig({
  // The integration tests import the real service layer, so the `@/` alias has
  // to resolve here exactly as it does in the application build.
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/functions-emulator/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});
