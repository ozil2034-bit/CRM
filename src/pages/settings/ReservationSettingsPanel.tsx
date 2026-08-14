import { Field } from '@/design-system';
import { useT } from '@/hooks/useT';
import { DEFAULT_NUMBER_FORMATS } from '@/domain/numbering';
import { useSettingsDraft } from './useSettingsDraft';
import { SettingsSaveBar } from './SettingsSaveBar';

/**
 * Reservation defaults, and the record-number prefixes.
 *
 * The cleaning buffer is a default for **new** dresses. Each dress carries its
 * own, snapshotted onto every booking it takes, so changing this cannot move a
 * gown that is already out.
 *
 * The prefixes are shown but not editable, and that is deliberate rather than
 * unfinished — see the note below.
 */
export function ReservationSettingsPanel() {
  const { t } = useT();
  const draft = useSettingsDraft();

  return (
    <div>
      <section className="mt-8">
        <Field
          label={t('settings.cleaningBuffer')}
          type="number"
          min={0}
          max={30}
          value={String(draft.values.defaultCleaningBufferDays)}
          onChange={(event) =>
            draft.set('defaultCleaningBufferDays', Number(event.target.value))
          }
          className="w-40"
        />
        <p className="mt-2 max-w-prose text-2xs text-ink-400">
          {t('settings.cleaningBufferHint')}
        </p>
      </section>

      <section className="mt-10 border-t border-ink-100 pt-6">
        <h2 className="label-caps">{t('settings.prefixes')}</h2>
        <p className="mt-2 max-w-prose text-2xs text-ink-400">{t('settings.prefixesHint')}</p>

        <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {(['dress', 'customer', 'reservation', 'invoice'] as const).map((kind) => (
            <div key={kind}>
              <dt className="text-2xs tracking-wide text-ink-400 uppercase">
                {t(`settings.prefix.${kind}`)}
              </dt>
              <dd className="code mt-1 text-sm text-ink-900">
                {DEFAULT_NUMBER_FORMATS[kind].prefix}
              </dd>
            </div>
          ))}
        </dl>

        {/*
         * Read-only, on purpose.
         *
         * `parseRecordNumber` reads a code by matching it against the format
         * table, and every existing record already carries a code built from
         * the current prefixes. Changing one would leave the codes already in
         * circulation unparseable — the boutique would have RSV-0007 on a
         * printed agreement and no way for the system to recognise it.
         *
         * Making them editable needs the format stored per record, or a table
         * of historical prefixes. That is a data-model change, not a settings
         * field, so the screen shows what is in force rather than offering a
         * control that would quietly break existing numbers.
         */}
        <p className="mt-4 max-w-prose text-2xs text-ink-400">{t('settings.prefixesFixed')}</p>
      </section>

      <SettingsSaveBar draft={draft} />
    </div>
  );
}
