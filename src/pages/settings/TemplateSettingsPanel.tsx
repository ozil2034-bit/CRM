import { useEffect, useMemo, useState } from 'react';

import { Alert, Button, Select, TextArea, Toggle } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import {
  prepare,
  unknownVariablesIn,
  MESSAGE_LANGUAGES,
  SAMPLE_VALUES,
  TEMPLATE_VARIABLES,
  type MessageLanguage,
  type MessageTemplate,
  type TemplateKind,
} from '@/domain/message-template';
import { observeTemplates, saveTemplates } from '@/services/communication.service';
import { useFriendlyError } from '@/hooks/useFriendlyError';

/**
 * The template editor.
 *
 * One template at a time, both languages side by side, with the variable list
 * and a live preview underneath.
 *
 * **The preview writes nothing.** It renders the template against
 * `SAMPLE_VALUES` — a pure function — so an owner can see the shape of a
 * message without a reservation, a customer, or any record being created.
 */
export function TemplateSettingsPanel() {
  const { t } = useT();
  const friendly = useFriendlyError();
  const { principal, state } = useAuth();

  const [stored, setStored] = useState<MessageTemplate[] | null>(null);
  const [draft, setDraft] = useState<MessageTemplate[] | null>(null);
  const [kind, setKind] = useState<TemplateKind>('reservationConfirmation');
  const [previewLanguage, setPreviewLanguage] = useState<MessageLanguage>('bilingual');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return observeTemplates(setStored, (caught) => setError(friendly(caught).message));
  }, [friendly]);

  // The draft wins while editing; the listener wins when nothing is being typed.
  const templates = draft ?? stored;
  const current = templates?.find((entry) => entry.kind === kind) ?? null;

  const update = (patch: Partial<MessageTemplate>) => {
    if (templates === null) return;

    setDraft(
      templates.map((entry) => (entry.kind === kind ? { ...entry, ...patch } : entry)),
    );
    setNotice(null);
  };

  const unknownEn = useMemo(
    () => (current === null ? [] : unknownVariablesIn(current.en)),
    [current],
  );
  const unknownAr = useMemo(
    () => (current === null ? [] : unknownVariablesIn(current.ar)),
    [current],
  );

  const preview = useMemo(
    () =>
      current === null
        ? null
        : prepare({ template: current, language: previewLanguage, values: SAMPLE_VALUES }),
    [current, previewLanguage],
  );

  async function save(): Promise<void> {
    if (draft === null || principal === null || saving) return;

    setSaving(true);
    setError(null);

    try {
      const outcome = await saveTemplates({
        templates: draft,
        actor: {
          uid: principal.uid,
          name: state.status === 'signed-in' ? state.session.name : '',
          role: principal.role,
        },
      });

      if (outcome.status === 'failed') {
        setError(friendly(outcome.error).message);
        return;
      }

      setDraft(null);
      setNotice(t('settings.saved'));
    } finally {
      setSaving(false);
    }
  }

  /** Append a variable to whichever body the owner is writing. */
  const insert = (field: 'en' | 'ar', name: string) => {
    if (current === null) return;
    update({ [field]: `${current[field]}{${name}}` } as Partial<MessageTemplate>);
  };

  if (templates === null) {
    return (
      <p className="mt-8 text-sm text-ink-400" role="status">
        {t('state.loading')}
      </p>
    );
  }

  return (
    <div>
      <p className="mt-8 max-w-prose text-2xs text-ink-400">{t('settings.templatesHint')}</p>

      <div className="mt-6 flex flex-wrap items-end gap-4">
        <Select
          label={t('notify.template')}
          value={kind}
          onChange={(event) => setKind(event.target.value as TemplateKind)}
          options={templates.map((entry) => ({
            value: entry.kind,
            label: t(`template.${entry.kind}`),
          }))}
          className="min-w-56 flex-1"
        />

        {current !== null && (
          <Toggle
            label={t('settings.templateEnabled')}
            checked={current.enabled}
            onChange={(enabled) => update({ enabled })}
          />
        )}
      </div>

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

      {current !== null && (
        <>
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <div>
              <TextArea
                label={t('settings.templateEn')}
                value={current.en}
                onChange={(event) => update({ en: event.target.value })}
                rows={8}
                dir="ltr"
              />
              <VariableChips onInsert={(name) => insert('en', name)} />
              {unknownEn.length > 0 && (
                <Alert tone="warning" className="mt-3">
                  {t('settings.unknownVariable')} {unknownEn.join(', ')}
                </Alert>
              )}
            </div>

            <div>
              <TextArea
                label={t('settings.templateAr')}
                value={current.ar}
                onChange={(event) => update({ ar: event.target.value })}
                rows={8}
                dir="rtl"
              />
              <VariableChips onInsert={(name) => insert('ar', name)} />
              {unknownAr.length > 0 && (
                <Alert tone="warning" className="mt-3">
                  {t('settings.unknownVariable')} {unknownAr.join(', ')}
                </Alert>
              )}
            </div>
          </div>

          {/* Preview ---------------------------------------------------- */}
          <section className="mt-10 border-t border-ink-100 pt-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <h2 className="label-caps">{t('settings.previewSample')}</h2>

              <Select
                label={t('notify.language')}
                value={previewLanguage}
                onChange={(event) => setPreviewLanguage(event.target.value as MessageLanguage)}
                options={MESSAGE_LANGUAGES.map((value) => ({
                  value,
                  label: t(`language.${value}`),
                }))}
                className="w-40"
              />
            </div>

            <pre
              dir="auto"
              className="mt-4 max-h-72 overflow-auto whitespace-pre-wrap border border-ink-100 bg-sand-50 p-4 text-sm text-ink-800"
            >
              {preview?.text.length === 0 ? '—' : preview?.text}
            </pre>

            <p className="mt-2 text-2xs text-ink-400">{t('settings.previewNotSaved')}</p>
          </section>
        </>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-ink-100 pt-6">
        <Button disabled={draft === null || saving} onClick={() => void save()}>
          {saving ? t('action.saving') : t('settings.save')}
        </Button>

        {draft !== null && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
            {t('settings.discard')}
          </Button>
        )}

        <span className="text-2xs text-ink-500" role="status">
          {draft !== null && t('settings.unsaved')}
        </span>
      </div>
    </div>
  );
}

/**
 * The variable palette.
 *
 * Clickable rather than a list to copy from: an owner typing `{custmer_name}`
 * produces a template that silently ships a literal placeholder to a customer,
 * and the editor warns about it but preventing it is better.
 */
function VariableChips({ onInsert }: { onInsert: (name: string) => void }) {
  const { t } = useT();

  return (
    <div className="mt-3">
      <p className="text-2xs tracking-wide text-ink-400 uppercase">
        {t('settings.availableVariables')}
      </p>
      <p className="mt-1 text-2xs text-ink-400">{t('settings.variablesHint')}</p>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {TEMPLATE_VARIABLES.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => onInsert(name)}
            title={t(`variable.${name}`)}
            className="code min-h-8 rounded-xs border border-ink-100 px-2 py-1 text-2xs text-ink-600 hover:border-gold-500 hover:text-ink-900"
          >
            {`{${name}}`}
          </button>
        ))}
      </div>
    </div>
  );
}
