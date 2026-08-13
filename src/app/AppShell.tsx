import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

import { Badge, Button, Wordmark } from '@/design-system';
import { GlobalSearch } from '@/components/GlobalSearch';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { cn } from '@/lib/utils/cn';
import type { Permission } from '@/domain/authorization';
import type { TranslationKey } from '@/lib/i18n/dictionary';

interface NavEntry {
  readonly to: string;
  readonly labelKey: TranslationKey;
  readonly permission: Permission | null;
  readonly end: boolean;
  /** Shown in the mobile bottom bar. Everything else lives behind "More". */
  readonly primary: boolean;
}

/**
 * The navigation, in the order an employee works.
 *
 * Today first, then the calendar, then the three workspaces. Settings and staff
 * are administration and sit at the end — an owner visits them monthly, and the
 * shop floor never does.
 *
 * `primary` marks the five that fit a phone's bottom bar. The choice is not
 * arbitrary: they are the screens somebody standing in the shop reaches for.
 */
const NAVIGATION: readonly NavEntry[] = [
  { to: '/', labelKey: 'nav.today', permission: null, end: true, primary: true },
  { to: '/calendar', labelKey: 'nav.calendar', permission: null, end: false, primary: true },
  {
    to: '/reservations',
    labelKey: 'nav.reservations',
    permission: 'reservations.view',
    end: false,
    primary: true,
  },
  {
    to: '/inventory',
    labelKey: 'nav.inventory',
    permission: 'dresses.view',
    end: false,
    primary: true,
  },
  {
    to: '/customers',
    labelKey: 'nav.customers',
    permission: 'customers.view',
    end: false,
    primary: false,
  },
  {
    to: '/accessories',
    labelKey: 'nav.accessories',
    permission: 'accessories.view',
    end: false,
    primary: false,
  },
  {
    to: '/sheets',
    labelKey: 'nav.sheets',
    permission: 'reports.operational',
    end: false,
    primary: false,
  },
  {
    to: '/reports',
    labelKey: 'nav.reports',
    permission: 'reports.operational',
    end: false,
    primary: false,
  },
  {
    to: '/settings',
    labelKey: 'nav.settings',
    permission: 'businessProfile.edit',
    end: false,
    primary: false,
  },
  { to: '/users', labelKey: 'nav.staff', permission: 'users.view', end: false, primary: false },
];

/**
 * The authenticated shell.
 *
 * Three layouts from one entry list: a horizontal bar on desktop, the same bar
 * condensed on tablet, and a bottom bar on phones with the remainder behind
 * "More". Duplicating the entries per breakpoint is how navigation quietly
 * drifts out of step with itself.
 *
 * Permission filtering here is a **courtesy** — it keeps employees out of
 * screens that would only refuse them — and carries no security weight. Every
 * route behind it is independently enforced by firestore.rules.
 */
export function AppShell() {
  const { state, principal, can, signOut } = useAuth();
  const { t, toggleLanguage } = useT();
  const [moreOpen, setMoreOpen] = useState(false);

  const name = state.status === 'signed-in' ? state.session.name : '';

  const visible = NAVIGATION.filter(
    (entry) => entry.permission === null || can(entry.permission),
  );

  const primary = visible.filter((entry) => entry.primary);
  const secondary = visible.filter((entry) => !entry.primary);

  return (
    <div className="min-h-dvh">
      <header className="border-b border-ink-100">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3 sm:px-6 sm:py-4">
          <Wordmark size="sm" showArabic={false} />

          {/* Desktop and tablet: every entry, in one row that wraps. */}
          <nav
            aria-label={t('nav.menu')}
            className="hidden flex-wrap items-center gap-0.5 md:flex"
          >
            {visible.map((entry) => (
              <NavLink
                key={entry.to}
                to={entry.to}
                end={entry.end}
                className={({ isActive }) =>
                  cn(
                    'rounded-xs px-2.5 py-2 text-sm transition-colors lg:px-3',
                    isActive ? 'text-ink-900' : 'text-ink-500 hover:text-ink-900',
                  )
                }
              >
                {t(entry.labelKey)}
              </NavLink>
            ))}
          </nav>

          <div className="ms-auto flex items-center gap-3 sm:gap-4">
            <GlobalSearch />

            <button
              type="button"
              onClick={toggleLanguage}
              className="min-h-11 shrink-0 rounded-xs px-2 text-xs text-ink-500 hover:text-ink-900"
              aria-label={t('language.label')}
            >
              {t('language.toggle')}
            </button>

            <div className="hidden text-end lg:block">
              <p className="text-sm text-ink-900">{name}</p>
              <p className="text-2xs text-ink-400">
                {state.status === 'signed-in' ? state.session.email : ''}
              </p>
            </div>

            {principal && (
              <span className="hidden sm:block">
                <Badge tone={principal.role === 'OWNER' ? 'gold' : 'neutral'}>
                  {principal.role === 'OWNER' ? 'Owner' : 'Staff'}
                </Badge>
              </span>
            )}

            <Button
              variant="ghost"
              size="sm"
              className="hidden md:inline-flex"
              onClick={() => void signOut()}
            >
              {t('nav.signOut')}
            </Button>
          </div>
        </div>
      </header>

      {/*
       * Padding at the foot on phones so the bottom bar never covers the last
       * row of a list. `pb-safe` is not available, so the value accounts for the
       * bar's own height.
       */}
      <div className="pb-20 md:pb-0">
        <Outlet />
      </div>

      {/* Phones: a bottom bar, thumb-reachable, 44px targets. */}
      <nav
        aria-label={t('nav.menu')}
        className="fixed inset-x-0 bottom-0 z-20 border-t border-ink-100 bg-white/95 backdrop-blur md:hidden"
      >
        <ul className="mx-auto flex max-w-lg items-stretch">
          {primary.map((entry) => (
            <li key={entry.to} className="flex-1">
              <NavLink
                to={entry.to}
                end={entry.end}
                onClick={() => setMoreOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'flex min-h-14 items-center justify-center px-1 text-center text-2xs',
                    isActive ? 'text-ink-900' : 'text-ink-400',
                  )
                }
              >
                {t(entry.labelKey)}
              </NavLink>
            </li>
          ))}

          {secondary.length > 0 && (
            <li className="flex-1">
              <button
                type="button"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((open) => !open)}
                className={cn(
                  'flex min-h-14 w-full items-center justify-center px-1 text-center text-2xs',
                  moreOpen ? 'text-ink-900' : 'text-ink-400',
                )}
              >
                {t('nav.more')}
              </button>
            </li>
          )}
        </ul>

        {moreOpen && (
          <ul className="mx-auto max-w-lg border-t border-ink-100 bg-white">
            {secondary.map((entry) => (
              <li key={entry.to}>
                <NavLink
                  to={entry.to}
                  end={entry.end}
                  onClick={() => setMoreOpen(false)}
                  className={({ isActive }) =>
                    cn(
                      'flex min-h-12 items-center px-5 text-sm',
                      isActive ? 'text-ink-900' : 'text-ink-600',
                    )
                  }
                >
                  {t(entry.labelKey)}
                </NavLink>
              </li>
            ))}
            <li>
              <button
                type="button"
                onClick={() => void signOut()}
                className="flex min-h-12 w-full items-center px-5 text-start text-sm text-ink-600"
              >
                {t('nav.signOut')}
              </button>
            </li>
          </ul>
        )}
      </nav>
    </div>
  );
}
