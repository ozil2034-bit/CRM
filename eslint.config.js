import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist', 'coverage', 'node_modules', 'functions/lib', '.firebase'],
  },

  // Base TypeScript + React configuration for application source.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',

      // The specification forbids localStorage as a database and forbids treating
      // browser state as the source of truth. Firestore is the record of truth.
      'no-restricted-globals': [
        'error',
        {
          name: 'localStorage',
          message:
            'localStorage is not a database. Firestore is the source of truth; use Firestore offline persistence for caching (see ARCHITECTURE.md §5).',
        },
      ],

      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // Architectural boundary: the domain layer must stay pure.
  // No Firebase, no React, no services — that is what makes it exhaustively testable.
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['firebase', 'firebase/*', '@/lib/firebase', '@/lib/firebase/*'],
              message:
                'src/domain must stay pure. Firebase access belongs in src/services (ARCHITECTURE.md §3).',
            },
            {
              group: ['react', 'react-dom', 'react/*'],
              message: 'src/domain must stay framework-independent.',
            },
            {
              group: ['@/services', '@/services/*'],
              message: 'Dependencies point inward: services depend on domain, never the reverse.',
            },
          ],
        },
      ],
    },
  },

  // Architectural boundary: UI must not talk to Firebase directly.
  // Business logic lives in services and domain, never in components (specification §2).
  {
    files: ['src/components/**/*.{ts,tsx}', 'src/pages/**/*.{ts,tsx}', 'src/design-system/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['firebase', 'firebase/*'],
              message:
                'Components must not use the Firebase SDK directly. Call a service in src/services (ARCHITECTURE.md §1).',
            },
          ],
        },
      ],
    },
  },

  // Node-side configuration and scripts.
  {
    files: ['vite.config.ts', 'scripts/**/*.ts', 'eslint.config.js'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-console': 'off',
    },
  },

  // Tests may reach further than application code.
  {
    files: ['**/*.test.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Prettier last: disables stylistic rules that would conflict with the formatter.
  prettier,
);
