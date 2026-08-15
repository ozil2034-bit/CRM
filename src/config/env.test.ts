import { describe, it, expect } from 'vitest';
import { readEnvironment } from './env';

const validSource = {
  VITE_FIREBASE_API_KEY: 'test-api-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'example.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'example-project',
  VITE_FIREBASE_STORAGE_BUCKET: 'example-project.appspot.com',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '1234567890',
  VITE_FIREBASE_APP_ID: '1:1234567890:web:abcdef',
  VITE_APP_ENV: 'development',
  VITE_DEMO_MODE: 'false',
  VITE_USE_EMULATORS: 'false',
};

describe('readEnvironment()', () => {
  it('accepts a complete configuration', () => {
    const result = readEnvironment(validSource);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.env.firebase.projectId).toBe('example-project');
    expect(result.env.appEnv).toBe('development');
    expect(result.env.demoMode).toBe(false);
    expect(result.env.isProduction).toBe(false);
  });

  it('reports every missing key rather than only the first', () => {
    const result = readEnvironment({ VITE_APP_ENV: 'development' });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;

    expect(result.issues.length).toBeGreaterThanOrEqual(6);
    expect(result.issues.join('\n')).toContain('VITE_FIREBASE_API_KEY');
    expect(result.issues.join('\n')).toContain('VITE_FIREBASE_APP_ID');
  });

  it('rejects an empty string as a configured value', () => {
    const result = readEnvironment({ ...validSource, VITE_FIREBASE_PROJECT_ID: '   ' });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.issues.join('\n')).toContain('VITE_FIREBASE_PROJECT_ID');
  });

  it('defaults the flags to safe values when absent', () => {
    const { VITE_DEMO_MODE: _demo, VITE_USE_EMULATORS: _emu, ...withoutFlags } = validSource;
    const result = readEnvironment(withoutFlags);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.env.demoMode).toBe(false);
    expect(result.env.useEmulators).toBe(false);
  });

  it('coerces flag strings to booleans', () => {
    const result = readEnvironment({
      ...validSource,
      VITE_DEMO_MODE: 'true',
      VITE_USE_EMULATORS: 'true',
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.env.demoMode).toBe(true);
    expect(result.env.useEmulators).toBe(true);
  });

  it('rejects a flag value that is neither "true" nor "false"', () => {
    const result = readEnvironment({ ...validSource, VITE_DEMO_MODE: 'yes' });
    expect(result.status).toBe('invalid');
  });

  it('refuses production with demo mode enabled — specification §58', () => {
    const result = readEnvironment({
      ...validSource,
      VITE_APP_ENV: 'production',
      VITE_DEMO_MODE: 'true',
    });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.issues[0]).toMatch(/VITE_DEMO_MODE must be false/);
  });

  it('refuses production pointed at the emulator suite', () => {
    const result = readEnvironment({
      ...validSource,
      VITE_APP_ENV: 'production',
      VITE_USE_EMULATORS: 'true',
    });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.issues[0]).toMatch(/VITE_USE_EMULATORS must be false/);
  });

  it('accepts a correctly configured production environment', () => {
    const result = readEnvironment({ ...validSource, VITE_APP_ENV: 'production' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.env.isProduction).toBe(true);
    expect(result.env.demoMode).toBe(false);
  });

  it('rejects an unknown app environment', () => {
    const result = readEnvironment({ ...validSource, VITE_APP_ENV: 'staging' });
    expect(result.status).toBe('invalid');
  });

  it('reads import.meta.env when no source is supplied', () => {
    // The test runner supplies no VITE_FIREBASE_* values, so the default source
    // must be reached and must report the configuration as incomplete rather
    // than throwing. This is the path the browser takes at startup.
    const result = readEnvironment();
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.issues.join('\n')).toContain('VITE_FIREBASE_API_KEY');
  });
});

/* ------------------------------------------------------------------------ *
 * Production safety (Phase 9, §34–35)
 * ------------------------------------------------------------------------ */

describe('a production build must not ship a placeholder', () => {
  const production = (overrides: Record<string, string> = {}) => ({
    VITE_FIREBASE_API_KEY: 'AIzaReal',
    VITE_FIREBASE_AUTH_DOMAIN: 'azhary.firebaseapp.com',
    VITE_FIREBASE_PROJECT_ID: 'azhary-prod',
    VITE_FIREBASE_STORAGE_BUCKET: 'azhary-prod.appspot.com',
    VITE_FIREBASE_MESSAGING_SENDER_ID: '123456789',
    VITE_FIREBASE_APP_ID: '1:123:web:abc',
    VITE_APP_ENV: 'production',
    ...overrides,
  });

  it('accepts a fully configured production environment', () => {
    expect(readEnvironment(production()).status).toBe('ok');
  });

  it('REFUSES the literal placeholder from the template', () => {
    /*
     * The failure this prevents is quiet and expensive: a build that looks
     * production-ready, deploys, and points at nothing.
     */
    const result = readEnvironment(
      production({ VITE_FIREBASE_PROJECT_ID: 'REPLACE_WITH_PROD_PROJECT_ID' }),
    );

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.issues.join(' ')).toContain('VITE_FIREBASE_PROJECT_ID');
  });

  it.each([
    'your-project-id',
    'YOUR_PROJECT',
    'changeme',
    'placeholder-value',
    'TODO',
    'xxxx',
  ])('refuses the placeholder shape %s', (value) => {
    expect(readEnvironment(production({ VITE_FIREBASE_PROJECT_ID: value })).status).toBe(
      'invalid',
    );
  });

  it('catches a placeholder in ANY required value, not only the project id', () => {
    for (const key of [
      'VITE_FIREBASE_API_KEY',
      'VITE_FIREBASE_AUTH_DOMAIN',
      'VITE_FIREBASE_STORAGE_BUCKET',
      'VITE_FIREBASE_APP_ID',
    ]) {
      expect(readEnvironment(production({ [key]: 'REPLACE_WITH_VALUE' })).status).toBe('invalid');
    }
  });

  it('ALLOWS a placeholder in development — that is what development is for', () => {
    const result = readEnvironment(
      production({ VITE_APP_ENV: 'development', VITE_FIREBASE_PROJECT_ID: 'demo-azhary' }),
    );

    expect(result.status).toBe('ok');
  });

  it('does not mistake a legitimate value for a placeholder', () => {
    // A real project id containing "x" must not trip a substring check.
    expect(readEnvironment(production({ VITE_FIREBASE_PROJECT_ID: 'azhary-xr-2026' })).status).toBe(
      'ok',
    );
  });

  it('keeps development and production from pointing at each other', () => {
    // Emulators and demo data are refused in production, so a production build
    // cannot quietly run against a local or seeded database.
    expect(readEnvironment(production({ VITE_USE_EMULATORS: 'true' })).status).toBe('invalid');
    expect(readEnvironment(production({ VITE_DEMO_MODE: 'true' })).status).toBe('invalid');
  });
});
