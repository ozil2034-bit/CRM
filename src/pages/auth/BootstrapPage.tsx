import { useState, type FormEvent } from 'react';

import { Alert, Button, Field, Wordmark } from '@/design-system';
import { AuthError, claimInitialOwnership, createAccount } from '@/services/auth.service';

/**
 * First-owner initialisation.
 *
 * Shown only when `getBootstrapState` reports that no owner exists. That check
 * is a UX affordance; the control is the server-side re-check inside
 * `claimInitialOwnership`, which runs in a Firestore transaction and refuses a
 * second claim.
 *
 * The setup token is what makes the caller the *intended* owner rather than
 * whoever reached the URL first. It is configured server-side as a Functions
 * secret before first run, and never travels in the browser bundle.
 */
export function BootstrapPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    if (password !== confirmPassword) {
      setError('The two passwords do not match.');
      return;
    }
    if (password.length < 12) {
      // The owner account is the most privileged in the system; a longer
      // minimum than Firebase's default six characters is warranted.
      setError('Choose a password of at least 12 characters.');
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      /*
       * Create the account, then claim ownership. The account on its own grants
       * nothing: without the OWNER claim and a profile document, the security
       * rules refuse every request. If the claim step fails, the operator can
       * sign in and retry — the Function treats a replay by the recorded owner
       * as idempotent.
       */
      await createAccount(email, password);
      await claimInitialOwnership({ setupToken: setupToken.trim(), name: name.trim() });
      // The auth listener now sees an OWNER principal and swaps the route.
    } catch (caught) {
      setError(
        caught instanceof AuthError
          ? caught.message
          : ((caught as { message?: string }).message ?? 'Setup could not be completed.'),
      );
      setPassword('');
      setConfirmPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16">
      <Wordmark size="md" />

      <p className="label-caps mt-12">First-time setup</p>
      <h1 className="display mt-2 text-3xl text-ink-900">Create the owner account</h1>
      <p className="mt-4 max-w-prose text-sm leading-relaxed text-ink-600">
        This boutique has no owner yet. The account you create here has full access to settings,
        pricing, terms and staff management. It can only be created once.
      </p>

      <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-6" noValidate>
        <Field
          label="Your name"
          name="name"
          autoComplete="name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={submitting}
        />

        <Field
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
        />

        <Field
          label="Password"
          type="password"
          name="new-password"
          autoComplete="new-password"
          required
          hint="At least 12 characters."
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={submitting}
        />

        <Field
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          disabled={submitting}
        />

        <Field
          label="Setup token"
          name="setup-token"
          required
          hint="Provided with your deployment. Ask whoever configured this installation."
          value={setupToken}
          onChange={(event) => setSetupToken(event.target.value)}
          disabled={submitting}
        />

        {error && <Alert tone="error">{error}</Alert>}

        <Button type="submit" size="lg" fullWidth loading={submitting}>
          Create owner account
        </Button>
      </form>

      <hr className="rule-gold mt-12 w-16" />
      <p className="mt-4 text-xs text-ink-400">
        Your password is handled by Firebase Authentication and is never stored by this application.
      </p>
    </main>
  );
}
