/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  build: {
    // Sourcemaps ship so production stack traces stay diagnosable.
    sourcemap: true,
    rollupOptions: {
      output: {
        // Firebase is large and changes rarely; splitting it keeps application
        // updates from invalidating the whole vendor cache on every deploy.
        manualChunks(id: string): string | undefined {
          if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) {
            return 'firebase';
          }
          if (
            id.includes('node_modules/react') ||
            id.includes('node_modules/scheduler') ||
            id.includes('node_modules/@remix-run')
          ) {
            return 'react';
          }
          return undefined;
        },
      },
    },
  },

  server: {
    port: 5173,
    strictPort: false,
  },

  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    // Emulator-backed suites run under their own configs (`npm run test:rules`,
    // `npm run test:functions`) so the fast unit suite stays free of Java, open
    // ports and a built functions/lib.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/rules/**',
      'tests/functions-emulator/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/domain/**', 'src/services/**', 'src/lib/**', 'src/config/**'],
      thresholds: {
        // The domain layer holds the money and availability logic.
        // It is required to be fully covered (TESTING.md §9).
        'src/domain/**': {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
      },
    },
  },
});
