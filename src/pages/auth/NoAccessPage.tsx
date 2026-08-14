import { Alert, Button, Wordmark } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';

/**
 * Signed in, but not an active employee.
 *
 * Reached when the account has been deactivated, has no profile, or holds a role
 * the two sources do not agree grants anything. The application says so plainly
 * rather than presenting a working interface whose every write silently fails.
 */
export function NoAccessPage() {
  const { t } = useT();
  const { state, signOut } = useAuth();
  const email = state.status === 'signed-in' ? state.session.email : '';

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-6 py-16">
      <Wordmark size="md" />

      <p className="label-caps mt-12">{t('auth.noAccessTitle')}</p>
      <h1 className="display mt-2 text-3xl text-ink-900">{t('auth.noAccessHeading')}</h1>

      <p className="mt-4 text-sm leading-relaxed text-ink-600">
        You are signed in as <span className="text-ink-900">{email}</span>, but this account does
        not currently have access to the boutique system.
      </p>

      <Alert tone="info" className="mt-6">
        If you believe this is a mistake, ask the boutique owner to check your account.
      </Alert>

      <div className="mt-10">
        <Button variant="secondary" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    </main>
  );
}
