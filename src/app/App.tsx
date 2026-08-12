import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import type { EnvironmentResult } from '@/config/env';
import { SetupRequiredPage } from '@/pages/setup/SetupRequiredPage';
import { FoundationPage } from '@/pages/setup/FoundationPage';
import { AppErrorBoundary } from './AppErrorBoundary';

export interface AppProps {
  readonly environment: EnvironmentResult;
}

/**
 * Application root.
 *
 * When the environment is incomplete the application renders an actionable
 * setup screen rather than mounting routes that would immediately fail on a
 * Firebase call. A blank page during first-time configuration tells the
 * operator nothing.
 */
export function App({ environment }: AppProps) {
  if (environment.status === 'invalid') {
    return <SetupRequiredPage issues={environment.issues} />;
  }

  const router = createBrowserRouter([
    {
      path: '/',
      element: <FoundationPage env={environment.env} />,
      errorElement: <AppErrorBoundary />,
    },
    {
      path: '*',
      element: <FoundationPage env={environment.env} />,
    },
  ]);

  return <RouterProvider router={router} />;
}
