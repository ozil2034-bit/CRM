/**
 * Application settings — the application layer.
 *
 * One document, `settings/app`, read by everything and written only by the
 * owner. The rules enforce that; this screen-facing layer enforces nothing.
 *
 * **Every value here is read once and frozen onto the record it affects.** The
 * VAT rate goes onto a reservation's pricing snapshot at creation; the
 * cancellation tier onto the cancellation event; the late-fee rate onto the fee.
 * Changing a setting therefore cannot reach back into a booking a customer
 * already agreed to, and nothing in this file needs to arrange that — the
 * engines that read these values already snapshot them.
 */

import {
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type Firestore,
} from 'firebase/firestore';

import { getFirebaseClient } from '@/lib/firebase/client';
import {
  validateSettings,
  DEFAULT_SETTINGS,
  SETTINGS_PROBLEM_MESSAGES,
  type AppSettings,
} from '@/domain/settings';
import type { CancellationTier } from '@/domain/cancellation';
import { auditWriteFor, type AuditActor } from './audit.service';
import { commitWrite, type WriteOutcome } from './write';
import { AppError } from './errors';

const SETTINGS_PATH = ['settings', 'app'] as const;

function db(): Firestore {
  return getFirebaseClient().db;
}

export class SettingsServiceError extends AppError {
  constructor(code: string, message: string) {
    super('SettingsServiceError', code, message);
  }
}

/* ------------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------------ */

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

function readTiers(value: unknown): CancellationTier[] {
  if (!Array.isArray(value)) return [];

  return (value as Record<string, unknown>[]).map((tier) => {
    const label = (tier['label'] ?? {}) as Record<string, unknown>;

    return {
      daysBeforeEvent: num(tier['daysBeforeEvent'], 0),
      refundPercent: num(tier['refundPercent'], 0),
      label: {
        en: typeof label['en'] === 'string' ? label['en'] : '',
        ar: typeof label['ar'] === 'string' ? label['ar'] : '',
      },
    };
  });
}

export function toSettings(data: Record<string, unknown> | undefined): AppSettings {
  if (data === undefined) return DEFAULT_SETTINGS;

  return {
    /*
     * An absent or malformed rate is zero, never an invented 5%. The same
     * default the Cloud Functions use, deliberately: a preview that quotes a
     * tax nobody configured would be shown to a customer.
     */
    vatRatePercent: num(data['vatRatePercent'], DEFAULT_SETTINGS.vatRatePercent),
    lateFeePerDay: num(data['lateFeePerDay'], DEFAULT_SETTINGS.lateFeePerDay),
    minPickupPaymentPercent: num(
      data['minPickupPaymentPercent'],
      DEFAULT_SETTINGS.minPickupPaymentPercent,
    ),
    defaultCleaningBufferDays: num(
      data['defaultCleaningBufferDays'],
      DEFAULT_SETTINGS.defaultCleaningBufferDays,
    ),
    cancellationTiers: readTiers(data['cancellationTiers']),
  };
}

export function observeSettings(
  onChange: (settings: AppSettings) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db(), ...SETTINGS_PATH),
    (snapshot) => onChange(toSettings(snapshot.data())),
    onError,
  );
}

/* ------------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------------ */

/**
 * Save the settings.
 *
 * Validated here **and** by the rules. The rules are the control; this check
 * exists so the owner is told what is wrong in their own language rather than
 * receiving a permission error that names nothing.
 *
 * Merged rather than replaced, so a field this release does not know about is
 * not silently dropped by an older client.
 */
export async function saveSettings(input: {
  readonly settings: AppSettings;
  readonly actor: AuditActor;
  readonly onLateFailure?: (error: Error) => void;
}): Promise<WriteOutcome> {
  const problems = validateSettings(input.settings);

  if (problems.length > 0) {
    throw new SettingsServiceError(
      'invalid',
      SETTINGS_PROBLEM_MESSAGES[problems[0] as keyof typeof SETTINGS_PROBLEM_MESSAGES],
    );
  }

  const audit = auditWriteFor(db(), {
    actor: input.actor,
    action: 'settings.updated',
    entityType: 'settings',
    entityId: 'app',
    entityCode: 'settings/app',
    after: {
      vatRatePercent: input.settings.vatRatePercent,
      lateFeePerDay: input.settings.lateFeePerDay,
      minPickupPaymentPercent: input.settings.minPickupPaymentPercent,
      cancellationTierCount: input.settings.cancellationTiers.length,
    },
  });

  return commitWrite(
    async () => {
      await setDoc(
        doc(db(), ...SETTINGS_PATH),
        {
          vatRatePercent: input.settings.vatRatePercent,
          lateFeePerDay: input.settings.lateFeePerDay,
          minPickupPaymentPercent: input.settings.minPickupPaymentPercent,
          defaultCleaningBufferDays: input.settings.defaultCleaningBufferDays,
          cancellationTiers: input.settings.cancellationTiers.map((tier) => ({
            daysBeforeEvent: tier.daysBeforeEvent,
            refundPercent: tier.refundPercent,
            label: { en: tier.label.en, ar: tier.label.ar },
          })),
          updatedAt: serverTimestamp(),
          updatedBy: input.actor.uid,
        },
        { merge: true },
      );

      await setDoc(audit.ref, audit.data);
    },
    { ...(input.onLateFailure ? { onLateFailure: input.onLateFailure } : {}) },
  );
}
