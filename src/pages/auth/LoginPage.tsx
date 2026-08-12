import { useState, type FormEvent } from 'react';

import { Alert, Button, Field, Wordmark } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { AuthError, sendPasswordReset } from '@/services/auth.service';

/**
 * The boutique sign-in screen.
 *
 * An editorial split: the brand holds the left, the form the right. On a phone
 * the brand collapses to a header so the form is reachable without scrolling.
 * Nothing here resembles a default Firebase sign-in page — no logo grid, no
 * provider buttons, no boxed card floating on grey.
 */
export function LoginPage() {
  const { signIn } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    // Guard against a second submit while the first is in flight.
    if (submitting) return;

    setError(null);
    setNotice(null);
    setSubmitting(true);

    try {
      await signIn(email, password);
      // On success the auth listener swaps the route; this component unmounts.
    } catch (caught) {
      // The email is deliberately preserved — only the password is cleared.
      setError(caught instanceof AuthError ? caught.message : 'Unable to sign in.');
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReset(): Promise<void> {
    if (email.trim().length === 0) {
      setError('Enter your email address first, then request a reset link.');
      return;
    }

    setError(null);
    try {
      await sendPasswordReset(email);
    } catch {
      // Deliberately silent: reporting whether an address exists would let
      // anyone enumerate the boutique's staff accounts.
    }
    setNotice('If that address has an account, a reset link is on its way.');
  }

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[1.1fr_1fr]">
      {/* Brand panel — the one place warm beige fills an area. */}
      <div className="flex flex-col justify-between bg-sand-50 px-6 py-10 lg:px-14 lg:py-16">
        <Wordmark size="md" />

        <div className="hidden lg:block">
          <p className="display max-w-md text-4xl leading-[1.15] text-ink-900">
            Every dress, every fitting, every bride — in one place.
          </p>
          <hr className="rule-gold mt-8 w-24" />
        </div>

        <p className="hidden text-xs text-ink-400 lg:block">Boutique management system</p>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center px-6 py-12 lg:px-14">
        <div className="w-full max-w-sm">
          <p className="label-caps">Welcome back</p>
          <h1 className="display mt-2 text-3xl text-ink-900">Sign in</h1>

          <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-6" noValidate>
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
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
            />

            {error && <Alert tone="error">{error}</Alert>}
            {notice && <Alert tone="info">{notice}</Alert>}

            <Button type="submit" size="lg" fullWidth loading={submitting}>
              Sign in
            </Button>

            <button
              type="button"
              onClick={handleReset}
              className="self-start text-xs text-ink-500 underline-offset-4 hover:text-gold-700 hover:underline"
            >
              Forgotten your password?
            </button>
          </form>

          <hr className="rule-gold mt-12 w-16" />
          <p className="mt-4 text-xs text-ink-400">
            Accounts are created by the boutique owner. Contact them if you need access.
          </p>
        </div>
      </div>
    </div>
  );
}
