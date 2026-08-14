import { useState } from 'react';

import { Alert, Button } from '@/design-system';
import { useT } from '@/hooks/useT';
import type { SettingsDraft } from './useSettingsDraft';

/**
 * The save bar every settings panel shares.
 *
 * Four states, named: **Unsaved changes**, saving, **Saved**, **Not saved**.
 * Nothing here saves on a keystroke — a VAT rate that changed because somebody
 * tabbed through a field is a change nobody decided to make.
 *
 * When the draft touches a critical setting, saving goes through a
 * confirmation that says what the change does and, just as importantly, what it
 * does **not** do: existing reservations, invoices and payments are unchanged.
 * An owner raising the VAT rate should not spend the afternoon wondering
 * whether last month's invoices just moved.
 */
export function SettingsSaveBar({ draft }: { draft: SettingsDraft }) {
  const { t } = useT();
  const [confirming, setConfirming] = useState(false);

  const blocked = draft.problems.length > 0;
  const saving = draft.saveState === 'saving';
  const dirty = draft.saveState === 'dirty' || draft.saveState === 'failed';

  async function commit(): Promise<void> {
    setConfirming(false);
    await draft.save();
  }

  return (
    <div className="mt-8 border-t border-ink-100 pt-6">
      {draft.problems.map((problem) => (
        <Alert key={problem} tone="error" className="mb-3">
          {problem}
        </Alert>
      ))}

      {draft.error !== null && (
        <Alert tone="error" className="mb-3">
          {draft.error}
        </Alert>
      )}

      {confirming && (
        <div className="mb-4 border border-gold-500 p-4">
          <p className="text-sm text-ink-900">{t('settings.confirmTitle')}</p>

          <ul className="mt-2 space-y-1">
            {draft.critical.map((setting) => (
              <li key={setting} className="text-sm text-ink-700">
                {t(`settings.${settingLabelKey(setting)}`)}
              </li>
            ))}
          </ul>

          <p className="mt-3 text-2xs text-ink-500">{t('settings.confirmForwardOnly')}</p>

          <div className="mt-4 flex flex-wrap gap-3">
            <Button size="sm" onClick={() => void commit()}>
              {t('settings.confirmApply')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              {t('action.cancel')}
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={(!dirty && !saving) || blocked || saving}
          onClick={() => {
            // Critical changes stop for a confirmation; everything else saves.
            if (draft.critical.length > 0) setConfirming(true);
            else void draft.save();
          }}
        >
          {saving ? t('action.saving') : t('settings.save')}
        </Button>

        {dirty && (
          <Button variant="ghost" size="sm" onClick={draft.discard}>
            {t('settings.discard')}
          </Button>
        )}

        <span className="text-2xs text-ink-500" role="status">
          {draft.saveState === 'dirty' && t('settings.unsaved')}
          {draft.saveState === 'saved' && t('settings.saved')}
          {draft.saveState === 'failed' && t('settings.saveFailed')}
        </span>
      </div>
    </div>
  );
}

function settingLabelKey(
  setting: 'vatRatePercent' | 'lateFeePerDay' | 'minPickupPaymentPercent' | 'cancellationTiers',
): 'vatRate' | 'lateFee' | 'minPickup' | 'cancellationTiers' {
  switch (setting) {
    case 'vatRatePercent':
      return 'vatRate';
    case 'lateFeePerDay':
      return 'lateFee';
    case 'minPickupPaymentPercent':
      return 'minPickup';
    case 'cancellationTiers':
      return 'cancellationTiers';
  }
}
