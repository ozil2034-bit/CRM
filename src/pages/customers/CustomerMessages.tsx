import { useEffect, useMemo, useState } from 'react';

import { Badge, Button } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { MessageComposer } from '@/components/MessageComposer';
import { displayName } from '@/domain/customer';
import { formatMuscat } from '@/domain/datetime';
import { canMessage } from '@/domain/whatsapp';
import type { MessageLanguage, TemplateValues } from '@/domain/message-template';
import {
  observeCommunicationsForCustomer,
  type CommunicationEntry,
} from '@/services/communication.service';
import { observeBusinessProfile } from '@/services/business.service';
import type { Customer } from '@/services/customers.service';
import type { BusinessSnapshot } from '@/domain/document';

/**
 * Messaging a customer from her profile, and everything already said to her.
 *
 * Deliberately thinner than the reservation panel: from here there is no
 * booking, so no dates, no balance and no dress. Templates that need those
 * variables are refused by the composer, which is correct — a balance reminder
 * belongs on the booking that has the balance.
 */
export function CustomerMessages({ customer }: { customer: Customer }) {
  const { t, language } = useT();
  const { can } = useAuth();

  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<CommunicationEntry[]>([]);
  const [business, setBusiness] = useState<BusinessSnapshot | null>(null);

  useEffect(() => {
    return observeCommunicationsForCustomer(customer.id, setHistory, () => setHistory([]));
  }, [customer.id]);

  useEffect(() => {
    return observeBusinessProfile(setBusiness, () => setBusiness(null));
  }, []);

  const values: TemplateValues = useMemo(() => {
    const supplied: TemplateValues = { customer_name: customer.nameEn };

    if (customer.nameAr.length > 0) supplied.customer_name_ar = customer.nameAr;

    if (business !== null && business.nameEn.length > 0) {
      supplied.business_name =
        language === 'ar' && business.nameAr.length > 0 ? business.nameAr : business.nameEn;
    }
    if (business !== null && business.phone.length > 0) {
      supplied.business_phone = business.phone;
    }

    return supplied;
  }, [customer, business, language]);

  const preferred: MessageLanguage =
    customer.preferredLanguage === 'ar'
      ? 'ar'
      : customer.preferredLanguage === 'en'
        ? 'en'
        : 'bilingual';

  if (!can('whatsapp.prepare')) return null;

  return (
    <section className="mt-10 border-t border-ink-100 pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="label-caps">{t('notify.history')}</h2>

        {!open && canMessage(customer.phone) && (
          <Button size="sm" onClick={() => setOpen(true)}>
            {t('notify.open')}
          </Button>
        )}
      </div>

      {open && (
        <MessageComposer
          customerId={customer.id}
          customerName={displayName(customer, language)}
          customerPhone={customer.phone}
          customerLanguage={preferred}
          reservationId={null}
          reservationCode=""
          values={values}
          onClose={() => setOpen(false)}
        />
      )}

      {history.length === 0 ? (
        <p className="mt-4 text-sm text-ink-500">{t('notify.noHistory')}</p>
      ) : (
        <ul className="mt-4 divide-y divide-ink-100">
          {history.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
              <Badge tone={entry.status === 'Opened' ? 'success' : 'neutral'}>
                {t(`commStatus.${entry.status}`)}
              </Badge>

              <span className="text-sm text-ink-900">
                {entry.templateKind === null ? '—' : t(`template.${entry.templateKind}`)}
              </span>

              {entry.reservationCode.length > 0 && (
                <span className="code text-2xs text-ink-300">{entry.reservationCode}</span>
              )}

              <span className="numeric ms-auto text-2xs text-ink-400">
                {entry.at > 0 ? formatMuscat(entry.at, language) : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
