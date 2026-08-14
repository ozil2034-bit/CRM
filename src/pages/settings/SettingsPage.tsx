import { useState } from 'react';

import { Alert } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { cn } from '@/lib/utils/cn';
import type { TranslationKey } from '@/lib/i18n/dictionary';

import { BusinessSettingsPage } from './BusinessSettingsPage';
import { FinancialSettingsPanel } from './FinancialSettingsPanel';
import { ReservationSettingsPanel } from './ReservationSettingsPanel';
import { TemplateSettingsPanel } from './TemplateSettingsPanel';
import { ReminderSettingsPanel } from './ReminderSettingsPanel';

type Tab = 'business' | 'financial' | 'reservation' | 'templates' | 'terms' | 'notifications';

const TABS: readonly { readonly id: Tab; readonly labelKey: TranslationKey }[] = [
  { id: 'business', labelKey: 'settings.tabBusiness' },
  { id: 'financial', labelKey: 'settings.tabFinancial' },
  { id: 'reservation', labelKey: 'settings.tabReservation' },
  { id: 'templates', labelKey: 'settings.tabTemplates' },
  { id: 'terms', labelKey: 'settings.tabTerms' },
  { id: 'notifications', labelKey: 'settings.tabNotifications' },
];

/**
 * Settings, in sections.
 *
 * Six tabs rather than one column of fifty fields. The owner visits this screen
 * rarely and knows what they came to change; a wall of controls makes them read
 * everything to find one thing, and makes a mis-click on the VAT rate more
 * likely, not less.
 *
 * Tabs are logical-property styled and driven by the document direction, so the
 * row reverses wholesale in Arabic without a second layout.
 *
 * Everything here is owner-only. That is enforced by the rules and by the
 * route; the notice below explains it rather than leaving a staff member
 * wondering why a save failed.
 */
export function SettingsPage() {
  const { t } = useT();
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('business');

  const isOwner = can('businessProfile.edit');

  return (
    <main className="mx-auto max-w-3xl px-5 py-8 sm:px-6 sm:py-10">
      <header>
        <p className="label-caps">{t('nav.settings')}</p>
        <h1 className="display mt-2 text-3xl text-ink-900">{t('settings.title')}</h1>
      </header>

      {!isOwner && (
        <Alert tone="info" className="mt-6">
          {t('settings.ownerOnly')}
        </Alert>
      )}

      {/*
       * Horizontally scrollable on a phone rather than wrapped: six tabs on two
       * lines make the panel below jump as the selection changes.
       */}
      <div className="mt-8 -mx-5 overflow-x-auto border-b border-ink-100 px-5 sm:mx-0 sm:px-0">
        <div role="tablist" aria-label={t('settings.title')} className="flex min-w-max gap-1 pb-3">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className={cn(
                'min-h-11 shrink-0 rounded-xs px-3 text-sm transition-colors',
                tab === entry.id ? 'text-ink-900' : 'text-ink-400 hover:text-ink-900',
              )}
            >
              {t(entry.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2">
        {tab === 'business' && <BusinessSettingsPage section="business" withHeading={false} />}
        {tab === 'terms' && <BusinessSettingsPage section="terms" withHeading={false} />}
        {tab === 'financial' && <FinancialSettingsPanel />}
        {tab === 'reservation' && <ReservationSettingsPanel />}
        {tab === 'templates' && <TemplateSettingsPanel />}
        {tab === 'notifications' && <ReminderSettingsPanel />}
      </div>
    </main>
  );
}
