/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

/**
 * The application version, shown under Settings → About and stamped into every
 * backup file. Read from package.json so there is one place to change it.
 */
const APP_VERSION = process.env['npm_package_version'] ?? '0.0.0';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },

  plugins: [
    react(),
    tailwindcss(),

    VitePWA({
      /*
       * `prompt`, never `autoUpdate`.
       *
       * A service worker that reloads the page on its own can do it while an
       * employee is halfway through recording a payment. The application shows
       * "New version available" and waits to be told. (§16)
       */
      registerType: 'prompt',
      injectRegister: null,

      manifest: {
        name: 'Azhary Boutique',
        short_name: 'Azhary',
        description:
          'Wedding dress management for Azhary Boutique — reservations, fittings, payments and documents.',
        lang: 'en',
        /*
         * The manifest spec allows `auto`, but the plugin's types do not. `ltr`
         * describes the manifest's own strings, which are English; the
         * application's direction comes from the `dir` attribute the i18n
         * provider stamps on `<html>` and is unaffected by this.
         */
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#FFFFFF',
        theme_color: '#FFFFFF',
        categories: ['business', 'productivity'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },

      workbox: {
        /*
         * The application shell only: the built JavaScript, CSS, fonts and
         * icons. All of it is public, versioned and safe to keep on disk.
         *
         * There is deliberately NO runtime caching of Firestore, Storage or
         * Functions. Two reasons, either sufficient:
         *
         * 1. Firestore already has a cache — `persistentLocalCache`, which is
         *    keyed to the signed-in user and cleared on sign-out. A second copy
         *    in the Cache API would not be, and private customer data would
         *    outlive the session that was entitled to read it.
         * 2. A cached response cannot be re-authorised. The security rules run
         *    on the server; a copy in the Cache API has already passed them
         *    once and would be served again to whoever opens the browser next.
         */
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,ico,webmanifest}'],

        /*
         * Sourcemaps ship for diagnosis but must not be precached — they are
         * several megabytes and no employee ever needs one offline.
         */
        globIgnores: ['**/*.map'],

        // Single-page application: an unknown path is the shell, not a 404.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/__/, /^\/api\//],

        cleanupOutdatedCaches: true,

        /*
         * Fonts are the largest precached assets at ~48 KB each; the default
         * 2 MiB ceiling would silently drop the JavaScript bundle.
         */
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },

      devOptions: {
        // A service worker in development caches a stale shell and produces
        // bug reports about changes that were made and not seen.
        enabled: false,
      },
    }),
  ],

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
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/rules/**', 'tests/functions-emulator/**'],
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
