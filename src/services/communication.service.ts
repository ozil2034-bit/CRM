/**
 * Communication — the application layer.
 *
 * Two things: the editable templates (owner-only, one document), and the log of
 * what employees actually did with them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE LOG RECORDS OBSERVATIONS, NOT OUTCOMES
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The application opens a `wa.me` link. It never transmits anything and cannot
 * learn whether the employee pressed send, whether the message arrived, or
 * whether it was read. So the log says `Prepared`, `Opened` or `Copied` — each
 * literally true of something this code observed — and never `Sent`.
 *
 * A record claiming delivery would eventually be quoted back to a customer who
 * never received the message, and the boutique would have no way to tell which
 * of its records were true and which were assumptions.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE MESSAGE TEXT IS STORED WITH THE LOG
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A log entry saying "pickup reminder, 10 September" is useless six months
 * later when the template has been rewritten and the reservation's dates have
 * moved. The entry stores the **exact text that was prepared**, so "what did we
 * actually tell her?" has an answer. It is a snapshot, like an invoice, and it
 * is never updated.
 */

import {
  addDoc,
  collection,
  doc,
  limit as queryLimit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  where,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';

import { getFirebaseClient } from '@/lib/firebase/client';
import {
  isTemplateKind,
  mergeTemplates,
  type MessageLanguage,
  type MessageTemplate,
  type TemplateKind,
} from '@/domain/message-template';
import { DEFAULT_REMINDERS, validateReminder, type ReminderPreference } from '@/domain/settings';
import {
  isCommunicationStatus,
  type CommunicationChannel,
  type CommunicationStatus,
} from '@/domain/whatsapp';
import type { EpochMs } from '@/domain/datetime';
import { auditWriteFor, type AuditActor } from './audit.service';
import { commitWrite, type WriteOutcome } from './write';
import { AppError } from './errors';

const TEMPLATES_PATH = ['settings', 'messageTemplates'] as const;
const LOGS = 'notificationLogs';

function db(): Firestore {
  return getFirebaseClient().db;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const millis = (value: unknown): EpochMs => {
  if (value instanceof Timestamp) return value.toMillis();
  return typeof value === 'number' ? value : 0;
};

export class CommunicationServiceError extends AppError {
  constructor(code: string, message: string) {
    super('CommunicationServiceError', code, message);
  }
}

/* ------------------------------------------------------------------------ *
 * Templates
 * ------------------------------------------------------------------------ */

/**
 * Watch the template set.
 *
 * Always returns the full set, blanks included, so a template kind the boutique
 * has never written still appears in settings and is still refused by the
 * composer.
 */
export function observeTemplates(
  onChange: (templates: MessageTemplate[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db(), ...TEMPLATES_PATH),
    (snapshot) => {
      const stored = snapshot.data()?.['templates'];
      onChange(mergeTemplates(Array.isArray(stored) ? stored : []));
    },
    onError,
  );
}

export async function saveTemplates(input: {
  readonly templates: readonly MessageTemplate[];
  readonly actor: AuditActor;
  readonly onLateFailure?: (error: Error) => void;
}): Promise<WriteOutcome> {
  const audit = auditWriteFor(db(), {
    actor: input.actor,
    action: 'templates.updated',
    entityType: 'settings',
    entityId: 'messageTemplates',
    entityCode: 'settings/messageTemplates',
    after: {
      written: input.templates.filter((entry) => entry.en.length > 0 || entry.ar.length > 0).length,
    },
  });

  return commitWrite(
    async () => {
      await setDoc(
        doc(db(), ...TEMPLATES_PATH),
        {
          templates: input.templates.map((entry) => ({
            kind: entry.kind,
            en: entry.en,
            ar: entry.ar,
            enabled: entry.enabled,
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

/* ------------------------------------------------------------------------ *
 * Reminder preferences
 * ------------------------------------------------------------------------ */

/**
 * Watch the reminder preferences.
 *
 * Stored beside the templates, because they are the same kind of thing: the
 * boutique's intent about what it says to customers. **Nothing schedules them** —
 * see `ReminderSettingsPanel` for why a client-side timer is worse than none.
 */
export function observeReminders(
  onChange: (reminders: readonly ReminderPreference[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db(), ...TEMPLATES_PATH),
    (snapshot) => {
      const stored = snapshot.data()?.['reminders'];
      onChange(mergeReminders(Array.isArray(stored) ? stored : []));
    },
    onError,
  );
}

/**
 * Merge stored preferences over the shipped defaults.
 *
 * A reminder kind added later appears with its default rather than vanishing,
 * and a stored entry with an impossible offset is discarded in favour of the
 * default rather than saved back out.
 */
function mergeReminders(stored: readonly unknown[]): ReminderPreference[] {
  return DEFAULT_REMINDERS.map((fallback) => {
    const found = (stored as Record<string, unknown>[]).find(
      (entry) => entry['kind'] === fallback.kind,
    );

    if (found === undefined) return fallback;

    const candidate: ReminderPreference = {
      kind: fallback.kind,
      enabled: found['enabled'] !== false,
      daysOffset:
        typeof found['daysOffset'] === 'number' ? found['daysOffset'] : fallback.daysOffset,
    };

    return validateReminder(candidate) ? candidate : fallback;
  });
}

export async function saveReminders(input: {
  readonly reminders: readonly ReminderPreference[];
  readonly actor: AuditActor;
  readonly onLateFailure?: (error: Error) => void;
}): Promise<WriteOutcome> {
  const audit = auditWriteFor(db(), {
    actor: input.actor,
    action: 'templates.updated',
    entityType: 'settings',
    entityId: 'messageTemplates',
    entityCode: 'settings/messageTemplates',
    after: { reminders: input.reminders.filter((entry) => entry.enabled).length },
  });

  return commitWrite(
    async () => {
      await setDoc(
        doc(db(), ...TEMPLATES_PATH),
        {
          reminders: input.reminders.map((entry) => ({
            kind: entry.kind,
            enabled: entry.enabled,
            daysOffset: entry.daysOffset,
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

/* ------------------------------------------------------------------------ *
 * The log
 * ------------------------------------------------------------------------ */

export interface CommunicationEntry {
  readonly id: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly reservationId: string | null;
  readonly reservationCode: string;
  readonly templateKind: TemplateKind | null;
  readonly language: MessageLanguage;
  readonly channel: CommunicationChannel;
  readonly status: CommunicationStatus;
  /** The exact text that was prepared. A snapshot; never updated. */
  readonly message: string;
  readonly employeeId: string;
  readonly employeeName: string;
  readonly at: EpochMs;
}

function toEntry(snapshot: QueryDocumentSnapshot): CommunicationEntry {
  const data = snapshot.data();
  const kind = data['templateKind'];
  const language = data['language'];

  return {
    id: snapshot.id,
    customerId: str(data['customerId']),
    customerName: str(data['customerName']),
    reservationId: str(data['reservationId']).length > 0 ? str(data['reservationId']) : null,
    reservationCode: str(data['reservationCode']),
    templateKind: isTemplateKind(kind) ? kind : null,
    language: language === 'ar' || language === 'bilingual' ? language : 'en',
    channel: 'WhatsApp',
    /*
     * An unrecognised status reads as `Prepared` — the weakest claim available.
     * Guessing upwards would have corrupt data assert that something was opened
     * when it may not have been.
     */
    status: isCommunicationStatus(data['status']) ? data['status'] : 'Prepared',
    message: str(data['message']),
    employeeId: str(data['employeeId']),
    employeeName: str(data['employeeName']),
    at: millis(data['at']),
  };
}

/** One customer's communication history, most recent first. */
export function observeCommunicationsForCustomer(
  customerId: string,
  onChange: (entries: CommunicationEntry[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    query(collection(db(), LOGS), where('customerId', '==', customerId), queryLimit(100)),
    (snapshot) => onChange(snapshot.docs.map(toEntry).sort((a, b) => b.at - a.at)),
    onError,
  );
}

/** One reservation's communication history, most recent first. */
export function observeCommunicationsForReservation(
  reservationId: string,
  onChange: (entries: CommunicationEntry[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    query(collection(db(), LOGS), where('reservationId', '==', reservationId), queryLimit(50)),
    (snapshot) => onChange(snapshot.docs.map(toEntry).sort((a, b) => b.at - a.at)),
    onError,
  );
}

export interface LogCommunicationInput {
  readonly customerId: string;
  readonly customerName: string;
  readonly reservationId: string | null;
  readonly reservationCode: string;
  readonly templateKind: TemplateKind;
  readonly language: MessageLanguage;
  readonly status: CommunicationStatus;
  readonly message: string;
  readonly actor: AuditActor;
}

/**
 * Record one communication action.
 *
 * **Append-only, and one entry per explicit action.** Opening WhatsApp twice is
 * two entries, because it is two things the employee did and the second may
 * have been a genuine follow-up. What must never happen is an entry appearing
 * because a page re-rendered — so this is called from click handlers only, never
 * from an effect. (§10)
 *
 * The rules permit create but not update or delete: a communication record is
 * evidence of what the boutique told a customer.
 */
export async function logCommunication(input: LogCommunicationInput): Promise<WriteOutcome> {
  if (input.message.trim().length === 0) {
    throw new CommunicationServiceError('empty', 'There is nothing to record.');
  }

  return commitWrite(async () => {
    await addDoc(collection(db(), LOGS), {
      customerId: input.customerId,
      customerName: input.customerName,
      reservationId: input.reservationId ?? '',
      reservationCode: input.reservationCode,
      templateKind: input.templateKind,
      language: input.language,
      channel: 'WhatsApp' satisfies CommunicationChannel,
      status: input.status,
      message: input.message,
      employeeId: input.actor.uid,
      employeeName: input.actor.name,
      at: serverTimestamp(),
      createdBy: input.actor.uid,
    });
  });
}
