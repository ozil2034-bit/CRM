import type { ReactNode } from 'react';

import { Alert, Wordmark } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import type { Permission } from '@/domain/authorization';

export interface RequirePermissionProps {
  readonly permission: Permission;
  readonly children: ReactNode;
}

/**
 * Route guard.
 *
 * ⚠️ This prevents a screen from *rendering*. It does not prevent anything from
 * being *read or written* — a user who edits this out of the bundle reaches
 * Firestore and is refused there. The rules are the control; this exists so an
 * employee is told plainly instead of meeting a wall of failed requests.
 */
export function RequirePermission({ permission, children }: RequirePermissionProps) {
  const { can } = useAuth();

  if (!can(permission)) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-lg flex-col justify-center px-6">
        <Wordmark size="sm" showArabic={false} />
        <p className="label-caps mt-8">Not available</p>
        <h1 className="display mt-2 text-2xl text-ink-900">
          You do not have access to this screen
        </h1>
        <Alert tone="info" className="mt-6">
          This area is limited to the boutique owner. Ask them if you need something from it.
        </Alert>
      </main>
    );
  }

  return <>{children}</>;
}
