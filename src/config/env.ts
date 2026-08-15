/**
 * Environment configuration with runtime validation.
 *
 * Vite replaces `import.meta.env.VITE_*` at build time, so a missing variable
 * becomes `undefined` and surfaces later as an opaque Firebase error. Validating
 * here converts that into a specific, actionable message at startup.
 *
 * Nothing secret belongs in this file. Every `VITE_`-prefixed value is compiled
 * into the public browser bundle. Firebase Web config identifies the project; it
 * is not a credential, and security is enforced by Firestore and Storage rules
 * (SECURITY.md §7).
 */

import { z } from 'zod';

const requiredString = (name: string) =>
  z
    .string({ error: `${name} is missing.` })
    .trim()
    .min(1, `${name} is empty.`);

/** `"true"` / `"false"` strings from the environment, coerced to booleans. */
const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const environmentSchema = z.object({
  VITE_FIREBASE_API_KEY: requiredString('VITE_FIREBASE_API_KEY'),
  VITE_FIREBASE_AUTH_DOMAIN: requiredString('VITE_FIREBASE_AUTH_DOMAIN'),
  VITE_FIREBASE_PROJECT_ID: requiredString('VITE_FIREBASE_PROJECT_ID'),
  VITE_FIREBASE_STORAGE_BUCKET: requiredString('VITE_FIREBASE_STORAGE_BUCKET'),
  VITE_FIREBASE_MESSAGING_SENDER_ID: requiredString('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  VITE_FIREBASE_APP_ID: requiredString('VITE_FIREBASE_APP_ID'),
  VITE_APP_ENV: z.enum(['development', 'production']).default('development'),
  VITE_DEMO_MODE: booleanFlag,
  VITE_USE_EMULATORS: booleanFlag,
});

export interface FirebaseConfig {
  readonly apiKey: string;
  readonly authDomain: string;
  readonly projectId: string;
  readonly storageBucket: string;
  readonly messagingSenderId: string;
  readonly appId: string;
}

export interface AppEnvironment {
  readonly firebase: FirebaseConfig;
  readonly appEnv: 'development' | 'production';
  readonly demoMode: boolean;
  readonly useEmulators: boolean;
  readonly isProduction: boolean;
}

export type EnvironmentResult =
  | { readonly status: 'ok'; readonly env: AppEnvironment }
  | { readonly status: 'invalid'; readonly issues: readonly string[] };

/**
 * Read and validate the environment.
 *
 * Returns a result rather than throwing so the application can render an
 * actionable setup screen instead of a blank page. A blank page during first-time
 * Firebase setup tells the operator nothing.
 */
export function readEnvironment(
  source: Record<string, unknown> = import.meta.env,
): EnvironmentResult {
  const parsed = environmentSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const key = issue.path.join('.');
      return key ? `${key}: ${issue.message}` : issue.message;
    });
    return { status: 'invalid', issues };
  }

  const value = parsed.data;
  const isProduction = value.VITE_APP_ENV === 'production';

  /*
   * Specification §58: production must never run with demo mode enabled.
   * Treated as a configuration error, not a warning — shipping a production
   * build that permits demo data is exactly the failure the rule prevents.
   */
  if (isProduction && value.VITE_DEMO_MODE) {
    return {
      status: 'invalid',
      issues: [
        'VITE_DEMO_MODE must be false when VITE_APP_ENV is "production". ' +
          'Demo data is never permitted in the production environment.',
      ],
    };
  }

  if (isProduction && value.VITE_USE_EMULATORS) {
    return {
      status: 'invalid',
      issues: ['VITE_USE_EMULATORS must be false when VITE_APP_ENV is "production".'],
    };
  }

  /*
   * A production build must never carry a placeholder (§9.35).
   *
   * The failure this prevents is quiet and expensive: a build that looks
   * production-ready, deploys, and points at nothing — or worse, at the
   * development project, where it would write real customer records into a
   * database nobody backs up.
   *
   * Checked here rather than only in a deploy script because the deploy script
   * is the thing somebody bypasses at eleven at night.
   */
  if (isProduction) {
    const placeholders = findPlaceholders(value);

    if (placeholders.length > 0) {
      return {
        status: 'invalid',
        issues: placeholders.map(
          (key) =>
            `${key} still contains a placeholder value. A production build requires the real Firebase configuration.`,
        ),
      };
    }
  }

  return {
    status: 'ok',
    env: {
      firebase: {
        apiKey: value.VITE_FIREBASE_API_KEY,
        authDomain: value.VITE_FIREBASE_AUTH_DOMAIN,
        projectId: value.VITE_FIREBASE_PROJECT_ID,
        storageBucket: value.VITE_FIREBASE_STORAGE_BUCKET,
        messagingSenderId: value.VITE_FIREBASE_MESSAGING_SENDER_ID,
        appId: value.VITE_FIREBASE_APP_ID,
      },
      appEnv: value.VITE_APP_ENV,
      demoMode: value.VITE_DEMO_MODE,
      useEmulators: value.VITE_USE_EMULATORS,
      isProduction,
    },
  };
}

/**
 * Markers that mean "somebody has not filled this in yet".
 *
 * Matched case-insensitively as a substring, because the shapes people actually
 * leave behind vary: `REPLACE_WITH_PROD_PROJECT_ID`, `your-project-id`,
 * `xxx`, `TODO`.
 */
const PLACEHOLDER_MARKERS: readonly string[] = [
  'replace_with',
  'replace-with',
  'your-project',
  'your_project',
  'yourproject',
  'changeme',
  'change-me',
  'placeholder',
  'example.com',
  'todo',
  'xxxx',
];

/** Which required Firebase values still look like a template. */
function findPlaceholders(value: Record<string, unknown>): string[] {
  return REQUIRED_ENV_KEYS.filter((key) => {
    const entry = value[key];
    if (typeof entry !== 'string') return false;

    const lowered = entry.toLowerCase();
    return PLACEHOLDER_MARKERS.some((marker) => lowered.includes(marker));
  });
}

/** The environment variables this application reads, for setup diagnostics. */
export const REQUIRED_ENV_KEYS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
] as const;
