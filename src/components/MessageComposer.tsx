import { useEffect, useMemo, useState } from 'react';

import { Alert, Badge, Button, Select } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import {
  prepare,
  MESSAGE_LANGUAGES,
  type MessageLanguage,
  type MessageTemplate,
  type TemplateKind,
  type TemplateValues,
} from '@/domain/message-template';
import {
  buildWhatsAppLink,
  canMessage,
  WHATSAPP_PROBLEM_MESSAGES,
  type CommunicationStatus,
} from '@/domain/whatsapp';
import { observeTemplates, logCommunication } from '@/services/communication.service';

export interface MessageComposerProps {
  readonly customerId: string;
  readonly customerName: string;
  readonly customerPhone: string;
  /** The customer's recorded preference. Used as the default, never rewritten. */
  readonly customerLanguage: MessageLanguage;
  readonly reservationId: string | null;
  readonly reservationCode: string;
  readonly values: TemplateValues;
  /** Restricts the picker when a screen is about one occasion. */
  readonly suggestedKind?: TemplateKind;
  readonly onClose: () => void;
}

/**
 * The communication composer.
 *
 * Choose a template, choose a language, read what will be sent, then either
 * copy it or open WhatsApp. Nothing happens without a click: WhatsApp is never
 * opened automatically, and no log entry is written by an effect.
 *
 * ## What the buttons claim
 *
 * "Open WhatsApp" opens WhatsApp. It does not send. The application hands over
 * a draft and loses sight of it, so the confirmation says *opened* — never
 * *sent* — and the log records the same word.
 *
 * ## Why a missing variable blocks the whole thing
 *
 * A template referencing `{balance}` on a booking with no balance recorded
 * would otherwise produce "you owe {balance}" or, worse, "you owe undefined".
 * The composer names what is missing and refuses both actions until it is
 * resolved. The preview still renders, with the gaps visible, so the employee
 * can see exactly what is wrong.
 */
export function MessageComposer({
  customerId,
  customerName,
  customerPhone,
  customerLanguage,
  reservationId,
  reservationCode,
  values,
  suggestedKind,
  onClose,
}: MessageComposerProps) {
  const { t } = useT();
  const { principal, state } = useAuth();

  const [templates, setTemplates] = useState<MessageTemplate[] | null>(null);
  const [kind, setKind] = useState<TemplateKind | ''>(suggestedKind ?? '');

  /*
   * Seeded from the customer's preference and changeable here. Changing it
   * affects THIS message only — the customer's stored preference is not
   * touched, because an employee writing once in English has not decided the
   * bride now prefers English. (§16)
   */
  const [language, setLanguage] = useState<MessageLanguage>(customerLanguage);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    return observeTemplates(setTemplates, () => setTemplates([]));
  }, []);

  const actor =
    principal === null
      ? null
      : {
          uid: principal.uid,
          name: state.status === 'signed-in' ? state.session.name : '',
          role: principal.role,
        };

  const available = useMemo(
    () => (templates ?? []).filter((entry) => entry.enabled),
    [templates],
  );

  const chosen = available.find((entry) => entry.kind === kind) ?? null;

  const prepared = useMemo(
    () => (chosen === null ? null : prepare({ template: chosen, language, values })),
    [chosen, language, values],
  );

  const reachable = canMessage(customerPhone);

  const link = useMemo(() => {
    if (prepared === null || !prepared.ready) return null;
    return buildWhatsAppLink({ phone: customerPhone, message: prepared.text });
  }, [prepared, customerPhone]);

  async function record(status: CommunicationStatus): Promise<void> {
    if (actor === null || prepared === null || chosen === null) return;

    await logCommunication({
      customerId,
      customerName,
      reservationId,
      reservationCode,
      templateKind: chosen.kind,
      language,
      status,
      // The exact text, so "what did we actually tell her?" has an answer.
      message: prepared.text,
      actor,
    });
  }

  async function handleCopy(): Promise<void> {
    if (prepared === null || !prepared.ready || busy) return;

    setBusy(true);
    setError(null);

    try {
      await navigator.clipboard.writeText(prepared.text);
      await record('Copied');
      setNotice(t('notify.copied'));
    } catch {
      // A refused clipboard is a browser permission, not a defect. Say so
      // rather than claiming the copy worked.
      setError(t('notify.copyFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleOpen(): Promise<void> {
    if (link === null || !link.ok || busy) return;

    setBusy(true);
    setError(null);

    try {
      /*
       * Logged BEFORE opening, so a record exists even if the new tab is
       * blocked or the employee closes it instantly. The record says the link
       * was opened, which is what this code did — not that anything was sent.
       */
      await record('Opened');
      window.open(link.url, '_blank', 'noopener,noreferrer');
      setNotice(t('notify.opened'));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 border-t border-ink-100 pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="label-caps">{t('notify.title')}</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('action.close')}
        </Button>
      </div>

      {/* Who, and on what number. */}
      <dl className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
        <div>
          <dt className="text-2xs tracking-wide text-ink-400 uppercase">
            {t('notify.customer')}
          </dt>
          <dd className="text-sm text-ink-900">{customerName}</dd>
        </div>
        <div>
          <dt className="text-2xs tracking-wide text-ink-400 uppercase">{t('customer.phone')}</dt>
          <dd className="numeric text-sm text-ink-900">
            {customerPhone.length > 0 ? customerPhone : '—'}
          </dd>
        </div>
        <Badge tone="neutral">{t(`language.${customerLanguage}`)}</Badge>
      </dl>

      {!reachable && (
        <Alert tone="warning" className="mt-4">
          {WHATSAPP_PROBLEM_MESSAGES[customerPhone.trim().length === 0 ? 'NO_PHONE' : 'INVALID_PHONE']}
        </Alert>
      )}

      {templates !== null && available.length === 0 && (
        <Alert tone="info" className="mt-4">
          {t('notify.noTemplates')}
        </Alert>
      )}

      <div className="mt-5 flex flex-wrap items-end gap-4">
        <Select
          label={t('notify.template')}
          value={kind}
          onChange={(event) => setKind(event.target.value as TemplateKind | '')}
          options={[
            { value: '', label: '—' },
            ...available.map((entry) => ({
              value: entry.kind,
              label: t(`template.${entry.kind}`),
            })),
          ]}
          className="min-w-52 flex-1"
        />

        <Select
          label={t('notify.language')}
          value={language}
          onChange={(event) => setLanguage(event.target.value as MessageLanguage)}
          options={MESSAGE_LANGUAGES.map((value) => ({
            value,
            label: t(`language.${value}`),
          }))}
          className="w-40"
        />
      </div>

      {/* The preview: exactly what will be handed to WhatsApp. */}
      {prepared !== null && (
        <div className="mt-5">
          <p className="text-2xs tracking-wide text-ink-400 uppercase">{t('notify.preview')}</p>
          <pre
            /*
             * `dir="auto"` so a message in either language reads correctly
             * inside an interface that may be in the other one. Arabic in an
             * English UI must not be laid out left-to-right.
             */
            dir="auto"
            className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap border border-ink-100 bg-sand-50 p-4 text-sm text-ink-800"
          >
            {prepared.text}
          </pre>
        </div>
      )}

      {prepared !== null && prepared.missing.length > 0 && (
        <Alert tone="warning" className="mt-4">
          {t('notify.missing')}{' '}
          {prepared.missing.map((name) => t(`variable.${name}`)).join('، ')}
        </Alert>
      )}

      {prepared !== null && prepared.missing.length === 0 && !prepared.ready && (
        <Alert tone="warning" className="mt-4">
          {t('notify.templateEmpty')}
        </Alert>
      )}

      {link !== null && !link.ok && (
        <Alert tone="error" className="mt-4">
          {WHATSAPP_PROBLEM_MESSAGES[link.problem]}
        </Alert>
      )}

      {error !== null && (
        <Alert tone="error" className="mt-4">
          {error}
        </Alert>
      )}

      {notice !== null && (
        <Alert tone="success" className="mt-4">
          {notice}
        </Alert>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        <Button
          disabled={busy || prepared === null || !prepared.ready || !reachable}
          onClick={() => void handleOpen()}
        >
          {t('notify.openWhatsApp')}
        </Button>

        <Button
          variant="secondary"
          disabled={busy || prepared === null || !prepared.ready}
          onClick={() => void handleCopy()}
        >
          {t('notify.copy')}
        </Button>
      </div>

      {/*
       * Said plainly, every time. The application opens a link; whether the
       * employee then presses send is something it cannot know.
       */}
      <p className="mt-3 text-2xs text-ink-400">{t('notify.notSentDisclaimer')}</p>
    </div>
  );
}
