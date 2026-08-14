import { Button, Field, Select } from '@/design-system';
import { MoneyField } from '@/components/MoneyField';
import { useT } from '@/hooks/useT';
import { PERMITTED_VAT_RATES } from '@/domain/settings';
import type { CancellationTier } from '@/domain/cancellation';
import type { Baisa } from '@/domain/money';
import { useSettingsDraft } from './useSettingsDraft';
import { SettingsSaveBar } from './SettingsSaveBar';

/**
 * VAT, the late fee, the pickup threshold and the cancellation scale.
 *
 * Every control carries a sentence saying what it affects and that it affects
 * the future only. The owner should not have to remember which settings reach
 * backwards — none of them do, and the screen says so rather than relying on
 * that being known.
 */
export function FinancialSettingsPanel() {
  const { t } = useT();
  const draft = useSettingsDraft();

  const tiers = draft.values.cancellationTiers;

  const setTier = (index: number, patch: Partial<CancellationTier>) => {
    draft.set(
      'cancellationTiers',
      tiers.map((tier, position) => (position === index ? { ...tier, ...patch } : tier)),
    );
  };

  return (
    <div>
      {/* VAT ------------------------------------------------------------- */}
      <section className="mt-8">
        <Select
          label={t('settings.vatRate')}
          value={String(draft.values.vatRatePercent)}
          onChange={(event) => draft.set('vatRatePercent', Number(event.target.value))}
          options={PERMITTED_VAT_RATES.map((rate) => ({
            value: String(rate),
            label: `${String(rate)}%`,
          }))}
          className="w-40"
        />
        <p className="mt-2 max-w-prose text-2xs text-ink-400">{t('settings.vatRateHint')}</p>
      </section>

      {/* Late fee -------------------------------------------------------- */}
      <section className="mt-8">
        <MoneyField
          label={t('settings.lateFee')}
          value={draft.values.lateFeePerDay as Baisa}
          onChange={(next) => draft.set('lateFeePerDay', next ?? 0)}
          className="w-48"
        />
        <p className="mt-2 max-w-prose text-2xs text-ink-400">{t('settings.lateFeeHint')}</p>
      </section>

      {/* Pickup threshold ------------------------------------------------ */}
      <section className="mt-8">
        <Field
          label={t('settings.minPickup')}
          type="number"
          min={0}
          max={100}
          value={String(draft.values.minPickupPaymentPercent)}
          onChange={(event) =>
            draft.set('minPickupPaymentPercent', Number(event.target.value))
          }
          className="w-40"
        />
        <p className="mt-2 max-w-prose text-2xs text-ink-400">{t('settings.minPickupHint')}</p>
      </section>

      {/* Cancellation scale ---------------------------------------------- */}
      <section className="mt-10 border-t border-ink-100 pt-6">
        <h2 className="label-caps">{t('settings.cancellationTiers')}</h2>
        <p className="mt-2 max-w-prose text-2xs text-ink-400">{t('settings.cancellationHint')}</p>

        {tiers.length === 0 && (
          <p className="mt-4 text-sm text-ink-500">{t('settings.noTiers')}</p>
        )}

        {tiers.length > 0 && (
          <ul className="mt-4 space-y-3">
            {tiers.map((tier, index) => (
              <li key={index} className="flex flex-wrap items-end gap-4">
                <Field
                  label={t('settings.tierDays')}
                  type="number"
                  min={0}
                  value={String(tier.daysBeforeEvent)}
                  onChange={(event) =>
                    setTier(index, { daysBeforeEvent: Number(event.target.value) })
                  }
                  className="w-40"
                />
                <Field
                  label={t('settings.tierRefund')}
                  type="number"
                  min={0}
                  max={100}
                  value={String(tier.refundPercent)}
                  onChange={(event) =>
                    setTier(index, { refundPercent: Number(event.target.value) })
                  }
                  className="w-32"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    draft.set(
                      'cancellationTiers',
                      tiers.filter((_unused, position) => position !== index),
                    )
                  }
                >
                  {t('settings.removeTier')}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <Button
          variant="secondary"
          size="sm"
          className="mt-4"
          onClick={() =>
            draft.set('cancellationTiers', [
              ...tiers,
              {
                // A new row starts at a notice period nothing else uses, so the
                // duplicate check does not fire the instant it appears.
                daysBeforeEvent: nextFreeDay(tiers),
                refundPercent: 0,
                label: { en: '', ar: '' },
              },
            ])
          }
        >
          {t('settings.addTier')}
        </Button>
      </section>

      <SettingsSaveBar draft={draft} />
    </div>
  );
}

function nextFreeDay(tiers: readonly CancellationTier[]): number {
  const used = new Set(tiers.map((tier) => tier.daysBeforeEvent));

  let candidate = 30;
  while (used.has(candidate)) candidate -= 1;

  return candidate > 0 ? candidate : 0;
}
