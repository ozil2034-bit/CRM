import { NavLink, Outlet } from 'react-router-dom';

import { Badge, Button, Wordmark } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils/cn';

/**
 * The authenticated shell.
 *
 * Navigation entries are filtered by permission. That filtering is a courtesy —
 * it keeps employees out of screens that would only refuse them — and carries no
 * security weight. Every route behind it is independently enforced by
 * firestore.rules.
 */
export function AppShell() {
  const { state, principal, can, signOut } = useAuth();
  const name = state.status === 'signed-in' ? state.session.name : '';

  const navigation = [
    { to: '/', label: 'Today', visible: true, end: true },
    { to: '/users', label: 'Staff', visible: can('users.view'), end: false },
  ].filter((entry) => entry.visible);

  return (
    <div className="min-h-dvh">
      <header className="border-b border-ink-100">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
          <Wordmark size="sm" showArabic={false} />

          <nav className="flex items-center gap-1">
            {navigation.map((entry) => (
              <NavLink
                key={entry.to}
                to={entry.to}
                end={entry.end}
                className={({ isActive }) =>
                  cn(
                    'rounded-xs px-3 py-2 text-sm transition-colors',
                    isActive ? 'text-ink-900' : 'text-ink-500 hover:text-ink-900',
                  )
                }
              >
                {entry.label}
              </NavLink>
            ))}
          </nav>

          <div className="ms-auto flex items-center gap-4">
            <div className="hidden text-end sm:block">
              <p className="text-sm text-ink-900">{name}</p>
              <p className="text-2xs text-ink-400">
                {state.status === 'signed-in' ? state.session.email : ''}
              </p>
            </div>

            {principal && (
              <Badge tone={principal.role === 'OWNER' ? 'gold' : 'neutral'}>
                {principal.role === 'OWNER' ? 'Owner' : 'Staff'}
              </Badge>
            )}

            <Button variant="ghost" size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <Outlet />
    </div>
  );
}
