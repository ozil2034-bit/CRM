import { useEffect, useState } from 'react';

import { Alert, Button, Field, Toggle } from '@/design-system';
import { useAuth } from '@/hooks/useAuth';
import { useT } from '@/hooks/useT';
import { DEFAULT_REMINDERS, validateReminder, type ReminderPreference } from '@/domain/settings';
import { observeReminders, saveReminders } from '@/services/communication.service';
import { useFriendlyError } from '@/hooks/useFriendlyError';

/**
 * Reminder preferences.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NOTHING HERE SENDS ANYTHING
 * ─────────────────────────────────────────────────────────────────────────
 *
 * There is no scheduler in this architecture — no cron, no queue, no background
 * worker. A client-side timer would be worse than nothing: it fires only while
 * somebody happens to have the tab open, so reminders would arrive for whichever
 * employee left a browser running overnight, and not at all on a Friday.
 *
 * So these preferences record the boutique's **intent**. They say which
 * reminders matter and how far ahead, the dashboard surfaces what is due, and an
 * employee still prepares each message. When scheduled execution becomes part of
 * the architecture, these are the values it reads — nothing about the stored
 * shape needs to change.
 *
 * The screen says all of this, because a preferences page that looks like it
 * automates something and does not is how a customer stops being contacted.
 */
export function ReminderSettingsPanel() {
  const { t } = useT();
  const friendly = useFriendlyError();
  const { principal, state } = useAuth();

  const [stored, setStored] = useState<readonly ReminderPreference[] | null>(null);
  const [draft, setDraft] = useState<ReminderPreference[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return observeReminders(setStored, (caught) => setError(friendly(caught).message));
  }, [friendly]);

  const reminders = draft ?? stored ?? DEFAULT_REMINDERS;

  const update = (kind: ReminderPreference['kind'], patch: Partial<ReminderPreference>) => {
    setDraft(
      reminders.map((entry) => (entry.kind === kind ? { ...entry, ...patch } : entry)),
    );
    setNotice(null);
  };

  const invalid = reminders.some((entry) => !validateReminder(entry));

  async function save(): Promise<void> {
    if (draft === null || principal === null || saving || invalid) return;

    setSaving(true);
    setError(null);

    try {
      const outcome = await saveReminders({
        reminders: draft,
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

  return (
    <div>
      <p className="mt-8 max-w-prose text-2xs text-ink-400">{t('settings.remindersHint')}</p>

      <Alert tone="info" className="mt-4">
        {t('settings.reminderNotAutomatic')}
      </Alert>

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

      <ul className="mt-6 divide-y divide-ink-100">
        {reminders.map((reminder) => (
          <li key={reminder.kind} className="flex flex-wrap items-end gap-x-6 gap-y-3 py-4">
            <Toggle
              label={t(`reminder.${reminder.kind}`)}
              checked={reminder.enabled}
              onChange={(enabled) => update(reminder.kind, { enabled })}
              className="min-w-48 flex-1"
            />

            <Field
              // "Days after" for the overdue notice: it is measured from a date
              // that has already passed.
              label={reminder.kind === 'overdue' ? t('reminder.daysAfter') : t('reminder.daysBefore')}
              type="number"
              min={0}
              max={90}
              value={String(reminder.daysOffset)}
              onChange={(event) =>
                update(reminder.kind, { daysOffset: Number(event.target.value) })
              }
              disabled={!reminder.enabled}
              className="w-32"
            />
          </li>
        ))}
      </ul>

      <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-ink-100 pt-6">
        <Button disabled={draft === null || saving || invalid} onClick={() => void save()}>
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
