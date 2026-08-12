import { Badge, Wordmark } from '@/design-system';
import type { AppEnvironment } from '@/config/env';

export interface FoundationPageProps {
  readonly env: AppEnvironment;
}

/**
 * Phase 1 landing screen.
 *
 * The foundation is in place but no business features exist yet, so this screen
 * reports exactly that. It deliberately shows **no** figures, counts or activity:
 * a dashboard populated with invented numbers is precisely what the
 * specification forbids (§51). Phase 7 replaces this with the real
 * employee-first dashboard, built from real data.
 */
export function FoundationPage({ env }: FoundationPageProps) {
  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-6 py-16 sm:py-24">
      <Wordmark size="lg" />

      <section className="mt-16">
        <p className="label-caps">Phase 1 · Foundation</p>
        <h1 className="display mt-3 text-3xl text-ink-900 sm:text-4xl">
          The groundwork is in place
        </h1>
        <p className="mt-5 max-w-prose text-base leading-relaxed text-ink-600">
          Architecture, design system, environment validation and Firebase initialisation are
          complete. Boutique features arrive in the phases that follow — no screen in this
          application will ever display data that is not real.
        </p>
      </section>

      <hr className="rule-gold mt-12 w-24" />

      <section className="mt-12">
        <h2 className="label-caps">Environment</h2>
        <dl className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <Detail label="Mode">
            <Badge tone={env.isProduction ? 'gold' : 'neutral'}>
              {env.isProduction ? 'Production' : 'Development'}
            </Badge>
          </Detail>

          <Detail label="Firebase project">
            <span className="font-mono text-xs text-ink-700">{env.firebase.projectId}</span>
          </Detail>

          <Detail label="Backend">
            <Badge tone={env.useEmulators ? 'info' : 'neutral'}>
              {env.useEmulators ? 'Emulator suite' : 'Live Firebase'}
            </Badge>
          </Detail>

          <Detail label="Demo data">
            <Badge tone={env.demoMode ? 'warning' : 'success'}>
              {env.demoMode ? 'Permitted' : 'Disabled'}
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
  { number: 2, title: 'Authentication, roles, security rules, emulator testing', done: false },
  { number: 3, title: 'Dress inventory, customers, photos, QR codes', done: false },
  { number: 4, title: 'Reservation engine, availability, fittings, waitlist', done: false },
  { number: 5, title: 'Payments, deposits, VAT, late fees, cancellation', done: false },
  { number: 6, title: 'Invoices, A4 documents, terms & conditions', done: false },
  { number: 7, title: 'Dashboard, calendar, reports, employee workflows', done: false },
  { number: 8, title: 'Arabic, right-to-left layout, WhatsApp messaging', done: false },
  { number: 9, title: 'Offline capability, installable app, backup and export', done: false },
  { number: 10, title: 'Quality assurance, security testing, production release', done: false },
] as const;
