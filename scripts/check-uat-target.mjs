/**
 * Refuse to deploy unless the target is unmistakably the development project.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SCRIPT AND NOT A CHECKLIST ITEM
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `npm run deploy:uat` is going to be run late in the evening by somebody who
 * has run it twenty times before. The failure it guards against is not
 * ignorance — it is the moment `.firebaserc` has been edited for a production
 * dry run and nobody remembered to change it back.
 *
 * Every check below answers a question the deployer would otherwise have to
 * remember to ask, and each one has a specific failure it prevents:
 *
 *   - Placeholder project id      → deploying to nothing, and finding out later
 *   - Missing .env.development    → a bundle with no Firebase configuration
 *   - Bundle/CLI project mismatch → an application that loads and cannot write
 *   - Emulator flags left on      → a hosted build talking to 127.0.0.1
 *   - Target equals production    → the one that cannot be undone
 *
 * Exits non-zero with the specific reason. It never guesses a value and never
 * repairs anything: a deploy script that edits configuration to make itself
 * work is worse than one that stops.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];
const notes = [];

/** Markers that mean "nobody filled this in". Mirrors src/config/env.ts. */
const PLACEHOLDER = /replace_with|your-project|your_project|changeme|placeholder|todo|xxxx|<.*>/i;

/* ------------------------------------------------------------------------ *
 * 1. The CLI target
 * ------------------------------------------------------------------------ */

const rcPath = join(root, '.firebaserc');
let devProject = null;
let prodProject = null;

if (!existsSync(rcPath)) {
  problems.push('.firebaserc is missing. Run `npx firebase use --add` and alias the project "development".');
} else {
  const rc = JSON.parse(readFileSync(rcPath, 'utf8'));
  const projects = rc.projects ?? {};

  devProject = projects.development ?? null;
  prodProject = projects.production ?? null;

  if (devProject === null) {
    problems.push('.firebaserc has no "development" alias. Run `npx firebase use --add`.');
  } else if (PLACEHOLDER.test(devProject)) {
    problems.push(
      `.firebaserc "development" is still the placeholder "${devProject}". ` +
        'Set the real development project id — this script will not guess one.',
    );
  } else {
    notes.push(`CLI target (development): ${devProject}`);
  }
}

/* ------------------------------------------------------------------------ *
 * 2. The bundle's configuration
 * ------------------------------------------------------------------------ */

const envPath = join(root, '.env.development');

if (!existsSync(envPath)) {
  problems.push(
    '.env.development is missing. Copy .env.example and fill in the six ' +
      'VITE_FIREBASE_* values from the development project\'s console.',
  );
} else {
  const env = Object.fromEntries(
    readFileSync(envPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );

  const required = [
    'VITE_FIREBASE_API_KEY',
    'VITE_FIREBASE_AUTH_DOMAIN',
    'VITE_FIREBASE_PROJECT_ID',
    'VITE_FIREBASE_STORAGE_BUCKET',
    'VITE_FIREBASE_MESSAGING_SENDER_ID',
    'VITE_FIREBASE_APP_ID',
  ];

  for (const name of required) {
    const value = env[name] ?? '';

    if (value.length === 0) {
      problems.push(`${name} is empty in .env.development.`);
    } else if (PLACEHOLDER.test(value)) {
      problems.push(`${name} still contains a placeholder: "${value}".`);
    }
  }

  /*
   * The mismatch case. A bundle built against project A and hosted on project B
   * loads perfectly, shows a sign-in screen, and fails every single write — a
   * failure that looks like a permissions bug and is not.
   */
  const bundleProject = env.VITE_FIREBASE_PROJECT_ID ?? '';

  if (devProject !== null && bundleProject.length > 0 && bundleProject !== devProject) {
    problems.push(
      `The bundle is configured for "${bundleProject}" but the CLI would deploy to ` +
        `"${devProject}". These must be the same project.`,
    );
  }

  if ((env.VITE_APP_ENV ?? '') !== 'development') {
    problems.push(`VITE_APP_ENV must be "development" for a UAT deploy, found "${env.VITE_APP_ENV ?? ''}".`);
  }

  if ((env.VITE_USE_EMULATORS ?? 'false') !== 'false') {
    problems.push('VITE_USE_EMULATORS must be false — a hosted build cannot reach 127.0.0.1.');
  }

  if ((env.VITE_DEMO_MODE ?? 'false') !== 'false') {
    problems.push('VITE_DEMO_MODE must be false. UAT data is created through the interface.');
  }

  if (bundleProject.length > 0) notes.push(`Bundle target: ${bundleProject}`);
}

/* ------------------------------------------------------------------------ *
 * 3. The one that cannot be undone
 * ------------------------------------------------------------------------ */

if (
  devProject !== null &&
  prodProject !== null &&
  !PLACEHOLDER.test(prodProject) &&
  devProject === prodProject
) {
  problems.push(
    `REFUSING TO DEPLOY: the "development" and "production" aliases both point at ` +
      `"${devProject}". This script will not deploy a UAT build to production.`,
  );
}

/* ------------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------------ */

if (problems.length > 0) {
  console.error('\nUAT deploy target is not ready:\n');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error('\nSee DEPLOYMENT.md §12. Nothing was deployed.\n');
  process.exit(1);
}

console.log('\nUAT target verified:\n');
for (const note of notes) console.log(`  ✓ ${note}`);
console.log('  ✓ Environment: development, emulators off, demo mode off');
console.log('  ✓ Bundle and CLI agree on the project\n');
