/**
 * Vitest global setup.
 *
 * Extends `expect` with jest-dom matchers and clears the DOM between tests so
 * one test's render cannot leak into the next.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
