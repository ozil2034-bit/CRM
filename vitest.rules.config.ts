import { defineConfig } from 'vitest/config';

/**
 * Security-rules test configuration.
 *
 * Separate from the main Vitest project because these tests require a running
 * Firebase Emulator Suite. They run through `npm run test:rules`, which starts
 * the emulator around them; keeping them out of `npm run test` means the fast
 * unit suite never depends on Java or a network port.
 *
 * Running on a single worker is deliberate: the suite calls `clearFirestore()`
 * between tests, and parallel workers sharing one emulator would clear each
 * other's data mid-assertion.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/rules/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
  },
});
