import { Wordmark } from '@/design-system';
import { REQUIRED_ENV_KEYS } from '@/config/env';
import { useT } from '@/hooks/useT';

export interface SetupRequiredPageProps {
  readonly issues: readonly string[];
}

/**
 * Shown when the Firebase environment is not configured.
 *
 * This is a developer/operator screen, not a customer-facing one. It names the
 * exact variables that are missing, because "failed to initialise" sends someone
 * hunting through documentation for information the application already has.
 */
export function SetupRequiredPage({ issues }: SetupRequiredPageProps) {
  const { t } = useT();
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-16">
      <Wordmark size="md" />

      <p className="label-caps mt-12">{t('setup.title')}</p>
      <h1 className="display mt-3 text-3xl text-ink-900">{t('setup.heading')}</h1>

      <p className="mt-4 max-w-prose text-sm leading-relaxed text-ink-600">
        The application cannot start until the Firebase environment is provided. Copy{' '}
        <code className="rounded-xs bg-sand-100 px-1.5 py-0.5 text-xs">.env.example</code> to{' '}
        <code className="rounded-xs bg-sand-100 px-1.5 py-0.5 text-xs">.env.development</code> and
        fill in the values from the Firebase console.
      </p>

      <section className="mt-10">
        <h2 className="label-caps">{t('setup.issues')}</h2>
        <ul className="mt-3 space-y-2">
          {issues.map((issue) => (
            <li key={issue} className="flex gap-3 text-sm text-ink-700">
              <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-danger" />
              <span>{issue}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="label-caps">{t('setup.requiredVariables')}</h2>
        <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {REQUIRED_ENV_KEYS.map((key) => (
            <li key={key} className="code text-xs text-ink-500">
              {key}
            </li>
          ))}
        </ul>
      </section>

      <hr className="rule-gold mt-12 w-24" />

      <p className="mt-4 text-xs text-ink-400">
        See DEPLOYMENT.md for the full Firebase setup procedure.
      </p>
    </main>
  );
}
