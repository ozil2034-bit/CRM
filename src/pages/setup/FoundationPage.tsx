import { Badge } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';

export interface FoundationPageProps {
  readonly isProduction: boolean;
}

/**
 * The signed-in landing screen, for now.
 *
 * It deliberately shows **no** figures, counts or activity. A dashboard
 * populated with invented numbers is precisely what the specification forbids
 * (§51), and there is no real data to show until Phase 3. Phase 7 replaces this
 * with the employee-first dashboard, built from what the boutique has actually
 * entered.
 */
export function FoundationPage({ isProduction }: FoundationPageProps) {
  const { state, principal } = useAuth();
  const name = state.status === 'signed-in' ? state.session.name : '';

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="label-caps">{greeting()}</p>
      <h1 className="display mt-2 text-3xl text-ink-900 sm:text-4xl">{name}</h1>

      <p className="mt-5 max-w-prose text-base leading-relaxed text-ink-600">
        Authentication, roles and authorization are in place. Boutique features arrive in the phases
        that follow — no screen in this application will ever display data that is not real.
      </p>

      <hr className="rule-gold mt-12 w-24" />

      <section className="mt-12">
        <h2 className="label-caps">Your access</h2>
        <dl className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <Detail label="Role">
            <Badge tone={principal?.role === 'OWNER' ? 'gold' : 'neutral'}>
              {principal?.role === 'OWNER' ? 'Owner — full access' : 'Staff — operational access'}
            </Badge>
          </Detail>

          <Detail label="Environment">
            <Badge tone={isProduction ? 'gold' : 'neutral'}>
              {isProduction ? 'Production' : 'Development'}
            </Badge>
          </Detail>
        </dl>
      </section>

      <section className="mt-14">
        <h2 className="label-caps">Roadmap</h2>
        <ol className="mt-4 space-y-3">
          {PHASES.map((phase) => (
            <li key={phase.number} className="flex items-baseline gap-4 text-sm">
              <span className="w-6 shrink-0 font-mono text-xs text-ink-300">
                {String(phase.number).padStart(2, '0')}
              </span>
              <span className={phase.done ? 'text-ink-900' : 'text-ink-400'}>{phase.title}</span>
              {phase.done && (
                <span className="ms-auto shrink-0">
                  <Badge tone="success">Complete</Badge>
                </span>
              )}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

/** Specification §39: the dashboard opens with a greeting, not a KPI row. */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="label-caps">{label}</dt>
      <dd className="mt-1.5">{children}</dd>
    </div>
  );
}

const PHASES = [
  { number: 1, title: 'Architecture, design system, Firebase setup, documentation', done: true },
  { number: 2, title: 'Authentication, roles, security rules, emulator testing', done: true },
  { number: 3, title: 'Dress inventory, customers, photos, QR codes', done: false },
  { number: 4, title: 'Reservation engine, availability, fittings, waitlist', done: false },
  { number: 5, title: 'Payments, deposits, VAT, late fees, cancellation', done: false },
  { number: 6, title: 'Invoices, A4 documents, terms & conditions', done: false },
  { number: 7, title: 'Dashboard, calendar, reports, employee workflows', done: false },
  { number: 8, title: 'Arabic, right-to-left layout, WhatsApp messaging', done: false },
  { number: 9, title: 'Offline capability, installable app, backup and export', done: false },
  { number: 10, title: 'Quality assurance, security testing, production release', done: false },
] as const;
