import { useRouteError, isRouteErrorResponse } from 'react-router-dom';
import { Button } from '@/design-system';

/**
 * Route-level error boundary.
 *
 * A render failure in one screen must not blank the whole application — a
 * boutique tablet showing a white page mid-fitting is not a recoverable
 * situation for the employee using it.
 */
export function AppErrorBoundary() {
  const error = useRouteError();

  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'An unexpected error occurred.';

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16">
      <p className="label-caps">Something went wrong</p>
      <h1 className="display mt-3 text-3xl text-ink-900">This screen could not be displayed</h1>
      <p className="mt-4 text-sm text-ink-600">
        Your data has not been affected. Reload the page to continue working.
      </p>

      <pre className="mt-6 overflow-x-auto rounded-sm bg-sand-50 p-4 text-xs text-ink-700">
        {message}
      </pre>

      <div className="mt-8">
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </div>
    </main>
  );
}
