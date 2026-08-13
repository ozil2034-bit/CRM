import { useEffect, useState } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';

import type { EnvironmentResult } from '@/config/env';
import { AuthProvider } from './AuthProvider';
import { AppShell } from './AppShell';
import { AppErrorBoundary } from './AppErrorBoundary';
import { RequirePermission } from './RequirePermission';
import { useAuth } from '@/hooks/useAuth';
import { getBootstrapState } from '@/services/auth.service';

import { SetupRequiredPage } from '@/pages/setup/SetupRequiredPage';
import { DashboardPage } from '@/pages/dashboard/DashboardPage';
import { CalendarPage } from '@/pages/calendar/CalendarPage';
import { AccessoriesPage } from '@/pages/accessories/AccessoriesPage';
import { AccessoryFormPage } from '@/pages/accessories/AccessoryFormPage';
import { ReportsPage } from '@/pages/reports/ReportsPage';
import { SheetsPage } from '@/pages/operations/SheetsPage';
import { LoginPage } from '@/pages/auth/LoginPage';
import { BootstrapPage } from '@/pages/auth/BootstrapPage';
import { NoAccessPage } from '@/pages/auth/NoAccessPage';
import { UsersPage } from '@/pages/users/UsersPage';
import { InventoryPage } from '@/pages/inventory/InventoryPage';
import { DressDetailPage } from '@/pages/inventory/DressDetailPage';
import { DressFormPage } from '@/pages/inventory/DressFormPage';
import { CustomersPage } from '@/pages/customers/CustomersPage';
import { CustomerDetailPage } from '@/pages/customers/CustomerDetailPage';
import { CustomerFormPage } from '@/pages/customers/CustomerFormPage';
import { ReservationsPage } from '@/pages/reservations/ReservationsPage';
import { BookingPage } from '@/pages/reservations/BookingPage';
import { ReservationDetailPage } from '@/pages/reservations/ReservationDetailPage';
import { DocumentPreviewPage } from '@/pages/documents/DocumentPreviewPage';
import { DocumentPage } from '@/pages/documents/DocumentPage';
import { BusinessSettingsPage } from '@/pages/settings/BusinessSettingsPage';

export interface AppProps {
  readonly environment: EnvironmentResult;
}

export function App({ environment }: AppProps) {
  if (environment.status === 'invalid') {
    return <SetupRequiredPage issues={environment.issues} />;
  }

  return (
    <AuthProvider>
      <AuthenticatedApp isProduction={environment.env.isProduction} />
    </AuthProvider>
  );
}

/**
 * Chooses which application to show: setup, sign-in, or the boutique itself.
 *
 * The router is only constructed once an identity is known, so no protected
 * route ever mounts for an unauthenticated visitor — not even briefly.
 */
function AuthenticatedApp({ isProduction }: { isProduction: boolean }) {
  const { state, principal } = useAuth();
  const [needsBootstrap, setNeedsBootstrap] = useState<boolean | null>(null);

  useEffect(() => {
    /*
     * Only asked when nobody is signed in. This is a UX affordance: it decides
     * whether to show the setup screen or the sign-in screen. The control that
     * matters is the server-side re-check inside `claimInitialOwnership`.
     */
    if (state.status !== 'signed-out') {
      return;
    }

    let cancelled = false;

    getBootstrapState()
      .then((result) => {
        if (!cancelled) setNeedsBootstrap(result.needsBootstrap);
      })
      .catch(() => {
        // If the check itself fails, show sign-in rather than offering to create
        // an owner. Failing towards *less* privilege is the right default.
        if (!cancelled) setNeedsBootstrap(false);
      });

    return () => {
      cancelled = true;
    };
  }, [state.status]);

  if (state.status === 'loading' || (state.status === 'signed-out' && needsBootstrap === null)) {
    return <SplashScreen />;
  }

  if (state.status === 'signed-out') {
    return needsBootstrap ? <BootstrapPage /> : <LoginPage />;
  }

  // Signed in, but not an active employee: deactivated, or no usable profile.
  if (principal === null) {
    return <NoAccessPage />;
  }

  const router = createBrowserRouter([
    {
      path: '/',
      element: <AppShell />,
      errorElement: <AppErrorBoundary />,
      children: [
        /*
         * Phase 7 replaces the foundation screen with the employee dashboard.
         * It renders correctly with zero records: an empty boutique is told so,
         * rather than shown zeroes that look like measurements.
         */
        { index: true, element: <DashboardPage isProduction={isProduction} /> },

        { path: 'calendar', element: <CalendarPage /> },

        {
          path: 'accessories',
          element: (
            <RequirePermission permission="accessories.view">
              <AccessoriesPage />
            </RequirePermission>
          ),
        },
        {
          path: 'accessories/new',
          element: (
            <RequirePermission permission="accessories.manage">
              <AccessoryFormPage />
            </RequirePermission>
          ),
        },
        {
          path: 'accessories/:accessoryId',
          element: (
            <RequirePermission permission="accessories.view">
              <AccessoryFormPage />
            </RequirePermission>
          ),
        },

        {
          path: 'reports',
          element: (
            <RequirePermission permission="reports.operational">
              <ReportsPage />
            </RequirePermission>
          ),
        },
        {
          path: 'sheets',
          element: (
            <RequirePermission permission="reports.operational">
              <SheetsPage />
            </RequirePermission>
          ),
        },

        {
          path: 'inventory',
          element: (
            <RequirePermission permission="dresses.view">
              <InventoryPage />
            </RequirePermission>
          ),
        },
        {
          path: 'inventory/new',
          element: (
            <RequirePermission permission="dresses.create">
              <DressFormPage />
            </RequirePermission>
          ),
        },
        {
          path: 'inventory/:dressId',
          element: (
            <RequirePermission permission="dresses.view">
              <DressDetailPage />
            </RequirePermission>
          ),
        },
        {
          path: 'inventory/:dressId/edit',
          element: (
            <RequirePermission permission="dresses.edit">
              <DressFormPage />
            </RequirePermission>
          ),
        },

        {
          path: 'customers',
          element: (
            <RequirePermission permission="customers.view">
              <CustomersPage />
            </RequirePermission>
          ),
        },
        {
          path: 'customers/new',
          element: (
            <RequirePermission permission="customers.create">
              <CustomerFormPage />
            </RequirePermission>
          ),
        },
        {
          path: 'customers/:customerId',
          element: (
            <RequirePermission permission="customers.view">
              <CustomerDetailPage />
            </RequirePermission>
          ),
        },
        {
          path: 'customers/:customerId/edit',
          element: (
            <RequirePermission permission="customers.edit">
              <CustomerFormPage />
            </RequirePermission>
          ),
        },

        {
          path: 'reservations',
          element: (
            <RequirePermission permission="reservations.view">
              <ReservationsPage />
            </RequirePermission>
          ),
        },
        {
          path: 'reservations/new',
          element: (
            <RequirePermission permission="reservations.create">
              <BookingPage />
            </RequirePermission>
          ),
        },
        {
          path: 'reservations/:reservationId',
          element: (
            <RequirePermission permission="reservations.view">
              <ReservationDetailPage />
            </RequirePermission>
          ),
        },

        {
          path: 'reservations/:reservationId/documents',
          element: (
            <RequirePermission permission="invoices.issue">
              <DocumentPreviewPage />
            </RequirePermission>
          ),
        },
        {
          path: 'documents/:documentId',
          element: (
            <RequirePermission permission="invoices.view">
              <DocumentPage />
            </RequirePermission>
          ),
        },

        {
          path: 'settings',
          element: (
            <RequirePermission permission="businessProfile.edit">
              <BusinessSettingsPage />
            </RequirePermission>
          ),
        },

        {
          path: 'users',
          element: (
            <RequirePermission permission="users.view">
              <UsersPage />
            </RequirePermission>
          ),
        },
        { path: '*', element: <Navigate to="/" replace /> },
      ],
    },
  ]);

  return <RouterProvider router={router} />;
}

function SplashScreen() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <span className="sr-only">Loading</span>
      <span aria-hidden="true" className="rule-gold w-16" />
    </div>
  );
}
