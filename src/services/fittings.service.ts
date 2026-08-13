/**
 * Fittings and the waitlist.
 *
 * Both are ordinary client writes, unlike reservations. Neither affects dress
 * availability — a fitting is an appointment in a diary, and a waitlist entry
 * records interest — so neither needs the transactional machinery that booking
 * does.
 */

import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';

import { getFirebaseClient } from '@/lib/firebase/client';
import { auditWriteFor, type AuditActor } from './audit.service';
import { commitWrite, type WriteOutcome } from './write';
import { fromMuscatWallTime, type EpochMs } from '@/domain/datetime';
import { setDoc } from 'firebase/firestore';

function db(): Firestore {
  return getFirebaseClient().db;
}

const millis = (value: unknown): EpochMs =>
  value instanceof Timestamp ? value.toMillis() : typeof value === 'number' ? value : 0;

/** An optional instant: absent and null both mean "has not happened yet". */
const millisOrNull = (value: unknown): EpochMs | null => {
  const present = value ?? null;
  return present === null ? null : millis(present);
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/* ------------------------------------------------------------------------ *
 * Fittings
 * ------------------------------------------------------------------------ */

export const FITTING_STATUSES = [
  'Scheduled',
  'Confirmed',
  'Completed',
  'Cancelled',
  'No-Show',
] as const;

export type FittingStatus = (typeof FITTING_STATUSES)[number];

export function isFittingStatus(value: unknown): value is FittingStatus {
  return typeof value === 'string' && (FITTING_STATUSES as readonly string[]).includes(value);
}

export interface Fitting {
  readonly id: string;
  readonly reservationId: string;
  readonly reservationCode: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly scheduledAt: EpochMs;
  readonly durationMinutes: number;
  readonly status: FittingStatus;
  readonly notes: string;
  readonly employeeId: string;
}

function toFitting(snapshot: QueryDocumentSnapshot): Fitting {
  const data = snapshot.data();

  return {
    id: snapshot.id,
    reservationId: str(data['reservationId']),
    reservationCode: str(data['reservationCode']),
    customerId: str(data['customerId']),
    customerName: str(data['customerName']),
    scheduledAt: millis(data['scheduledAt']),
    durationMinutes: typeof data['durationMinutes'] === 'number' ? data['durationMinutes'] : 60,
    status: isFittingStatus(data['status']) ? data['status'] : 'Cancelled',
    notes: str(data['notes']),
    employeeId: str(data['employeeId']),
  };
}

export function observeFittingsForReservation(
  reservationId: string,
  onChange: (fittings: Fitting[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    query(collection(db(), 'fittings'), where('reservationId', '==', reservationId)),
    (snapshot) =>
      onChange(snapshot.docs.map(toFitting).sort((a, b) => a.scheduledAt - b.scheduledAt)),
    onError,
  );
}

export function observeUpcomingFittings(
  onChange: (fittings: Fitting[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    query(collection(db(), 'fittings'), orderBy('scheduledAt')),
    (snapshot) => onChange(snapshot.docs.map(toFitting)),
    onError,
  );
}

export interface ScheduleFittingInput {
  readonly reservationId: string;
  readonly reservationCode: string;
  readonly customerId: string;
  readonly customerName: string;
  /** Boutique wall time, `YYYY-MM-DDTHH:MM`. */
  readonly scheduledAt: string;
  readonly durationMinutes: number;
  readonly notes: string;
  readonly actor: AuditActor;
}

/**
 * Schedule a fitting.
 *
 * Does **not** touch dress availability. A fitting happens in the shop with the
 * gown on the premises; treating it as a hold would take dresses off the market
 * for every appointment.
 */
export async function scheduleFitting(input: ScheduleFittingInput): Promise<string> {
  const scheduledAt = fromMuscatWallTime(input.scheduledAt);

  const created = await addDoc(collection(db(), 'fittings'), {
    reservationId: input.reservationId,
    reservationCode: input.reservationCode,
    customerId: input.customerId,
    customerName: input.customerName,
    scheduledAt: Timestamp.fromMillis(scheduledAt),
    durationMinutes: input.durationMinutes,
    status: 'Scheduled' satisfies FittingStatus,
    notes: input.notes,
    employeeId: input.actor.uid,
    createdAt: serverTimestamp(),
    createdBy: input.actor.uid,
    updatedAt: serverTimestamp(),
    updatedBy: input.actor.uid,
  });

  const audit = auditWriteFor(db(), {
    actor: input.actor,
    action: 'fitting.scheduled',
    entityType: 'reservation',
    entityId: input.reservationId,
    entityCode: input.reservationCode,
    before: null,
    after: { fittingId: created.id, scheduledAt },
  });
  await setDoc(audit.ref, audit.data);

  return created.id;
}

export async function changeFittingStatus(input: {
  readonly fitting: Fitting;
  readonly status: FittingStatus;
  readonly actor: AuditActor;
}): Promise<WriteOutcome> {
  return commitWrite(async () => {
    await updateDoc(doc(db(), 'fittings', input.fitting.id), {
      status: input.status,
      updatedAt: serverTimestamp(),
      updatedBy: input.actor.uid,
    });

    const audit = auditWriteFor(db(), {
      actor: input.actor,
      action: 'fitting.status_changed',
      entityType: 'reservation',
      entityId: input.fitting.reservationId,
      entityCode: input.fitting.reservationCode,
      before: { fittingStatus: input.fitting.status },
      after: { fittingStatus: input.status },
    });
    await setDoc(audit.ref, audit.data);
  });
}

/* ------------------------------------------------------------------------ *
 * Waitlist
 * ------------------------------------------------------------------------ */

export const WAITLIST_STATUSES = ['Waiting', 'Notified', 'Converted', 'Cancelled'] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export function isWaitlistStatus(value: unknown): value is WaitlistStatus {
  return typeof value === 'string' && (WAITLIST_STATUSES as readonly string[]).includes(value);
}

export interface WaitlistEntry {
  readonly id: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly dressId: string;
  readonly dressCode: string;
  readonly dressName: string;
  readonly requestedPickupAt: EpochMs;
  readonly requestedReturnAt: EpochMs;
  readonly eventDate: string;
  readonly status: WaitlistStatus;
  readonly notifiedAt: EpochMs | null;
}

function toWaitlistEntry(snapshot: QueryDocumentSnapshot): WaitlistEntry {
  const data = snapshot.data();

  return {
    id: snapshot.id,
    customerId: str(data['customerId']),
    customerName: str(data['customerName']),
    customerPhone: str(data['customerPhone']),
    dressId: str(data['dressId']),
    dressCode: str(data['dressCode']),
    dressName: str(data['dressName']),
    requestedPickupAt: millis(data['requestedPickupAt']),
    requestedReturnAt: millis(data['requestedReturnAt']),
    eventDate: str(data['eventDate']),
    status: isWaitlistStatus(data['status']) ? data['status'] : 'Cancelled',
    notifiedAt: millisOrNull(data['notifiedAt']),
  };
}

export function observeWaitlistForDress(
  dressId: string,
  onChange: (entries: WaitlistEntry[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    query(collection(db(), 'waitlist'), where('dressId', '==', dressId)),
    (snapshot) => onChange(snapshot.docs.map(toWaitlistEntry)),
    onError,
  );
}

export interface AddToWaitlistInput {
  readonly customerId: string;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly dressId: string;
  readonly dressCode: string;
  readonly dressName: string;
  readonly requestedPickupAt: string;
  readonly requestedReturnAt: string;
  readonly eventDate: string;
  readonly actor: AuditActor;
}

/**
 * Record that a customer wants a dress that is currently unavailable.
 *
 * Phase 4 stores the interest and nothing more. **No message is sent** — the
 * notification pipeline is Phase 8, and claiming a customer had been contacted
 * when nothing left the building would be worse than not recording it at all.
 */
export async function addToWaitlist(input: AddToWaitlistInput): Promise<string> {
  const created = await addDoc(collection(db(), 'waitlist'), {
    customerId: input.customerId,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    dressId: input.dressId,
    dressCode: input.dressCode,
    dressName: input.dressName,
    requestedPickupAt: Timestamp.fromMillis(fromMuscatWallTime(input.requestedPickupAt)),
    requestedReturnAt: Timestamp.fromMillis(fromMuscatWallTime(input.requestedReturnAt)),
    eventDate: input.eventDate,
    status: 'Waiting' satisfies WaitlistStatus,
    notifiedAt: null,
    createdAt: serverTimestamp(),
    createdBy: input.actor.uid,
  });

  return created.id;
}

export async function changeWaitlistStatus(input: {
  readonly entryId: string;
  readonly status: WaitlistStatus;
  readonly actor: AuditActor;
}): Promise<WriteOutcome> {
  return commitWrite(async () => {
    await updateDoc(doc(db(), 'waitlist', input.entryId), {
      status: input.status,
      ...(input.status === 'Notified' ? { notifiedAt: serverTimestamp() } : {}),
      updatedAt: serverTimestamp(),
      updatedBy: input.actor.uid,
    });
  });
}
