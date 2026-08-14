import { useEffect, useMemo, useState } from 'react';

import { Badge, Button } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { MessageComposer } from '@/components/MessageComposer';
import { formatMuscat, formatMuscatDate, startOfMuscatDay } from '@/domain/datetime';
import { formatOmr } from '@/domain/money';
import { reduceLedger } from '@/domain/ledger';
import { canMessage } from '@/domain/whatsapp';
import type { TemplateValues } from '@/domain/message-template';
import type { MessageLanguage } from '@/domain/message-template';
import {
  observeCommunicationsForReservation,
  type CommunicationEntry,
} from '@/services/communication.service';
import { observeFinancialEvents, type DisplayEvent } from '@/services/payments.service';
import { observeBusinessProfile } from '@/services/business.service';
import { observeCustomer, type Customer } from '@/services/customers.service';
import type { Reservation, ReservationItem } from '@/services/reservations.service';
import type { BusinessSnapshot } from '@/domain/document';

/**
 * Contacting the customer about one booking.
 *
 * Supplies the template variables from the reservation's **current** data —
 * today's balance, today's dates — because a reminder that quotes last week's
 * figures is worse than no reminder. What is preserved historically is the log
 * entry, which stores the exact text that was prepared at the time.
 *
 * A variable the booking cannot supply is simply absent. The composer then
 * refuses to prepare the message and names what is missing, rather than sending
 * "you owe {balance}".
 */
export function NotifyPanel({
  reservation,
  items,
}: {
  reservation: Reservation;
  items: readonly ReservationItem[];
}) {
  const { t, language } = useT();
  const { can } = useAuth();

  const [open, setOpen] = useState(false);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [events, setEvents] = useState<DisplayEvent[]>([]);
  const [business, setBusiness] = useState<BusinessSnapshot | null>(null);
  const [history, setHistory] = useState<CommunicationEntry[]>([]);

  useEffect(() => {
    if (reservation.customerId.length === 0) return;
    return observeCustomer(reservation.customerId, setCustomer, () => setCustomer(null));
  }, [reservation.customerId]);

  useEffect(() => {
    return observeFinancialEvents(reservation.id, setEvents, () => setEvents([]));
  }, [reservation.id]);

  useEffect(() => {
    return observeBusinessProfile(setBusiness, () => setBusiness(null));
  }, []);

  useEffect(() => {
    return observeCommunicationsForReservation(reservation.id, setHistory, () => setHistory([]));
  }, [reservation.id]);

  const position = useMemo(
    () => reduceLedger(reservation.pricing, events),
    [reservation.pricing, events],
  );

  /**
   * The values, from live data.
   *
   * Anything the booking has not got is **omitted entirely** rather than given
   * an empty string, because the composer treats absence as "refuse" and an
   * empty string would slip a blank into a sentence.
   */
  const values: TemplateValues = useMemo(() => {
    const first = items[0];

    const supplied: TemplateValues = {
      customer_name: reservation.customerName,
      reservation_number: reservation.code,
      pickup_date: formatMuscatDate(reservation.pickupAt, language),
      return_date: formatMuscatDate(reservation.returnAt, language),
      balance: formatOmr(position.outstanding),
      total: formatOmr(position.totalChargeable),
      paid: formatOmr(position.netPaid),
      deposit: formatOmr(position.depositDue),
    };

    if (reservation.customerNameAr.length > 0) {
      supplied.customer_name_ar = reservation.customerNameAr;
    }
    if (first !== undefined) {
      supplied.dress_name = first.dressName;
      supplied.dress_code = first.dressCode;
    }
    if (reservation.eventDate.length > 0) {
      supplied.event_date = formatMuscatDate(startOfMuscatDay(reservation.eventDate), language);
    }
    if (business !== null && business.nameEn.length > 0) {
      supplied.business_name =
        language === 'ar' && business.nameAr.length > 0 ? business.nameAr : business.nameEn;
    }
    if (business !== null && business.phone.length > 0) {
      supplied.business_phone = business.phone;
    }

    return supplied;
  }, [reservation, items, position, business, language]);

  const phone = customer?.phone ?? reservation.customerPhone;

  const preferred: MessageLanguage =
    customer?.preferredLanguage === 'ar'
      ? 'ar'
      : customer?.preferredLanguage === 'en'
        ? 'en'
        : 'bilingual';

  if (!can('whatsapp.prepare')) return null;

  return (
    <section className="mt-10 border-t border-ink-100 pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="label-caps">{t('notify.history')}</h2>

        {/*
         * No control at all when there is no usable number. A button that
         * always fails teaches staff the feature is broken.
         */}
        {!open && canMessage(phone) && (
          <Button size="sm" onClick={() => setOpen(true)}>
            {t('notify.open')}
          </Button>
        )}
      </div>

      {open && (
        <MessageComposer
          customerId={reservation.customerId}
          customerName={reservation.customerName}
          customerPhone={phone}
          customerLanguage={preferred}
          reservationId={reservation.id}
          reservationCode={reservation.code}
          values={values}
          onClose={() => setOpen(false)}
        />
      )}

      {history.length === 0 ? (
        <p className="mt-4 text-sm text-ink-500">{t('notify.noHistory')}</p>
      ) : (
        <ul className="mt-4 divide-y divide-ink-100">
          {history.map((entry) => (
            <li key={entry.id} className="py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Badge tone={entry.status === 'Opened' ? 'success' : 'neutral'}>
                  {t(`commStatus.${entry.status}`)}
                </Badge>

                <span className="text-sm text-ink-900">
                  {entry.templateKind === null ? '—' : t(`template.${entry.templateKind}`)}
                </span>

                <span className="text-2xs text-ink-400">{t(`language.${entry.language}`)}</span>

                <span className="numeric ms-auto text-2xs text-ink-400">
                  {entry.at > 0 ? formatMuscat(entry.at, language) : ''}
                </span>
              </div>

              <p className="mt-1 text-2xs text-ink-500">
                {entry.employeeName} · {t('notify.whatsapp')}
              </p>

              {/*
               * The exact text that was prepared, kept so "what did we actually
               * tell her?" has an answer after the template has been rewritten.
               */}
              <details className="mt-1">
                <summary className="cursor-pointer text-2xs text-ink-400">
                  {t('notify.preview')}
                </summary>
                <pre
                  dir="auto"
                  className="mt-2 whitespace-pre-wrap border border-ink-100 bg-sand-50 p-3 text-2xs text-ink-700"
                >
                  {entry.message}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
