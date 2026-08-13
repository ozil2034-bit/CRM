/**
 * Reservations — the application layer.
 *
 * Reads come straight from Firestore; **every write goes through a Cloud
 * Function**, because creating or moving a reservation requires checking
 * availability and writing atomically, and the client SDK cannot read a query
 * inside a transaction.
 *
 * There is deliberately no `createReservation` that writes to Firestore here.
 * The rules refuse it too, so the Function is not merely the convenient path —
 * it is the only one.
 */

import {
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
import { httpsCallable } from 'firebase/functions';

import { getFirebaseClient } from '@/lib/firebase/client';
import { baisa, type Baisa } from '@/domain/money';
import {
  isReservationStatus,
  type ExistingBlock,
  type ReservationStatus,
} from '@/domain/availability';
import { toMuscatWallTime, type EpochMs } from '@/domain/datetime';
import type { PricingSnapshot } from '@/domain/reservation-pricing';

export interface ReservationItem {
  readonly id: string;
  readonly reservationId: string;
  readonly dressId: string;
  readonly dressCode: string;
  readonly dressName: string;
  readonly pickupAt: EpochMs;
  readonly returnAt: EpochMs;
  readonly cleaningBufferDays: number;
  readonly blockStartAt: EpochMs;
  readonly blockEndAt: EpochMs;
  readonly blocking: boolean;
  readonly rentalPriceSnapshot: Baisa;
}

export interface Reservation {
  readonly id: string;
  readonly code: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly customerNameAr: string;
  readonly customerPhone: string;
  readonly status: ReservationStatus;
  readonly pickupAt: EpochMs;
  readonly returnAt: EpochMs;
  readonly actualReturnAt: EpochMs | null;
  readonly eventDate: string;
  readonly pricing: PricingSnapshot;
  readonly notes: string;
  readonly createdBy: string;
}

export class ReservationServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReservationServiceError';
    this.code = code;
  }
}

function db(): Firestore {
  return getFirebaseClient().db;
}

const millis = (value: unknown): EpochMs => {
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof value === 'number') return value;
  return 0;
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const int = (value: unknown): Baisa =>
  typeof value === 'number' && Number.isInteger(value) ? baisa(value) : baisa(0);

/* ------------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------------ */

function toReservation(snapshot: QueryDocumentSnapshot): Reservation {
  const data = snapshot.data();
  const customer = (data['customerSnapshot'] ?? {}) as Record<string, unknown>;
  const pricing = (data['pricing'] ?? {}) as Record<string, unknown>;

  return {
    id: snapshot.id,
    code: str(data['code']),
    customerId: str(data['customerId']),
    customerName: str(customer['nameEn']),
    customerNameAr: str(customer['nameAr']),
    customerPhone: str(customer['phone']),
    // An unrecognised status is shown as Cancelled rather than guessed as
    // active: presenting an unknown state as a live booking is the dangerous
    // direction to fail in.
    status: isReservationStatus(data['status']) ? data['status'] : 'Cancelled',
    pickupAt: millis(data['pickupAt']),
    returnAt: millis(data['returnAt']),
    actualReturnAt: data['actualReturnAt'] == null ? null : millis(data['actualReturnAt']),
    eventDate: str(data['eventDate']),
    pricing: {
      rentalSubtotal: int(pricing['rentalSubtotal']),
      accessorySubtotal: int(pricing['accessorySubtotal']),
      alterationSubtotal: int(pricing['alterationSubtotal']),
      discountAmount: int(pricing['discountAmount']),
      taxableSubtotal: int(pricing['taxableSubtotal']),
      vatRatePercent: typeof pricing['vatRatePercent'] === 'number' ? pricing['vatRatePercent'] : 0,
      vatAmount: int(pricing['vatAmount']),
      securityDepositTotal: int(pricing['securityDepositTotal']),
      grandTotal: int(pricing['grandTotal']),
    },
    notes: str(data['notes']),
    createdBy: str(data['createdBy']),
  };
}

function toItem(snapshot: QueryDocumentSnapshot): ReservationItem {
  const data = snapshot.data();

  return {
    id: snapshot.id,
    reservationId: str(data['reservationId']),
    dressId: str(data['dressId']),
    dressCode: str(data['dressCode']),
    dressName: str(data['dressName']),
    pickupAt: millis(data['pickupAt']),
    returnAt: millis(data['returnAt']),
    cleaningBufferDays:
      typeof data['cleaningBufferDays'] === 'number' ? data['cleaningBufferDays'] : 3,
    blockStartAt: millis(data['blockStartAt']),
    blockEndAt: millis(data['blockEndAt']),
    blocking: data['blocking'] === true,
    rentalPriceSnapshot: int(data['rentalPriceSnapshot']),
  };
}

export function observeReservations(
  onChange: (reservations: Reservation[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    query(collection(db(), 'reservations'), orderBy('pickupAt', 'desc')),
    (snapshot) => onChange(snapshot.docs.map(toReservation)),
    onError,
  );
}

export function observeReservation(
  reservationId: string,
  onChange: (reservation: Reservation | null) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db(), 'reservations', reservationId),
    (snapshot) =>
      onChange(snapshot.exists() ? toReservation(snapshot as QueryDocumentSnapshot) : null),
    onError,
  );
}

export function observeReservationItems(
  reservationId: string,
  onChange: (items: ReservationItem[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    query(collection(db(), 'reservationItems'), where('reservationId', '==', reservationId)),
    (snapshot) => onChange(snapshot.docs.map(toItem)),
    onError,
  );
}

/**
 * Blocking intervals for one dress, for the availability hint shown while
 * booking.
 *
 * Advisory only. The authoritative check happens inside the Function's
 * transaction.
 */
export function observeDressBlocks(
  dressId: string,
  onChange: (blocks: ExistingBlock[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    query(
      collection(db(), 'reservationItems'),
      where('dressId', '==', dressId),
      where('blocking', '==', true),
    ),
    (snapshot) =>
      onChange(
        snapshot.docs.map((document) => {
          const item = toItem(document);
          return {
            itemId: item.id,
            reservationId: item.reservationId,
            reservationCode: str(document.data()['reservationCode']),
            dressId: item.dressId,
            pickupAt: item.pickupAt,
            returnAt: item.returnAt,
            blockStartAt: item.blockStartAt,
            blockEndAt: item.blockEndAt,
            blocking: item.blocking,
          };
        }),
      ),
    onError,
  );
}

/** Reservations a dress has ever had — its rental history. */
export function observeDressHistory(
  dressId: string,
  onChange: (items: ReservationItem[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    query(collection(db(), 'reservationItems'), where('dressId', '==', dressId)),
    (snapshot) =>
      onChange(snapshot.docs.map(toItem).sort((a, b) => b.pickupAt - a.pickupAt)),
    onError,
  );
}

/* ------------------------------------------------------------------------ *
 * Trusted operations
 * ------------------------------------------------------------------------ */

export interface ConflictDetail {
  readonly dressId: string;
  readonly dressCode: string;
  readonly dressName: string;
  readonly reason: string;
  readonly conflictingReservationId: string | null;
  readonly conflictingReservationCode: string | null;
  readonly conflictingPickupAt: EpochMs | null;
  readonly conflictingReturnAt: EpochMs | null;
  readonly availableFrom: EpochMs | null;
}

export type CreateReservationResult =
  | {
      readonly success: true;
      readonly reservationId: string;
      readonly reservationNumber: string;
      readonly total: Baisa;
      readonly conflicts: readonly [];
    }
  | {
      readonly success: false;
      readonly reason: 'DRESS_UNAVAILABLE';
      readonly conflicts: readonly ConflictDetail[];
    };

export interface CreateReservationInput {
  readonly customerId: string;
  /** Boutique wall time, `YYYY-MM-DDTHH:MM`. Converted server-side. */
  readonly pickupAt: string;
  readonly returnAt: string;
  readonly eventDate: string | null;
  readonly dressIds: readonly string[];
  readonly notes?: string;
}

function callable<Request, Response>(name: string) {
  return httpsCallable<Request, Response>(getFirebaseClient().functions, name);
}

/**
 * Create a reservation.
 *
 * **Requires a connection, deliberately.** Availability has to be judged against
 * current server state, so a queued reservation could be committed against
 * stale data and double-book a gown. Offline attempts fail with a clear message
 * rather than being stored for later.
 */
export async function createReservation(
  input: CreateReservationInput,
): Promise<CreateReservationResult> {
  requireConnection();

  try {
    const result = await callable<CreateReservationInput, CreateReservationResult>(
      'createReservation',
    )(input);
    return result.data;
  } catch (error) {
    throw toReservationError(error);
  }
}

export async function updateReservationDates(input: {
  readonly reservationId: string;
  readonly pickupAt: string;
  readonly returnAt: string;
  readonly eventDate: string | null;
}): Promise<CreateReservationResult> {
  requireConnection();

  try {
    const result = await callable<typeof input, CreateReservationResult>(
      'updateReservationDates',
    )(input);
    return result.data;
  } catch (error) {
    throw toReservationError(error);
  }
}

export async function changeReservationStatus(input: {
  readonly reservationId: string;
  readonly status: ReservationStatus;
  readonly reason?: string;
}): Promise<void> {
  requireConnection();

  try {
    await callable<typeof input, { success: true }>('changeReservationStatus')(input);
  } catch (error) {
    throw toReservationError(error);
  }
}

export async function checkAvailability(input: {
  readonly dressIds: readonly string[];
  readonly pickupAt: string;
  readonly returnAt: string;
  readonly excludeReservationId?: string;
}): Promise<{ available: boolean; conflicts: ConflictDetail[] }> {
  const result = await callable<typeof input, { available: boolean; conflicts: ConflictDetail[] }>(
    'checkAvailability',
  )(input);
  return result.data;
}

export async function releaseCleanedDresses(): Promise<number> {
  const result = await callable<Record<string, never>, { released: number }>(
    'releaseCleanedDresses',
  )({});
  return result.data.released;
}

/** Notes are the one reservation field with no bearing on availability. */
export async function updateReservationNotes(
  reservationId: string,
  notes: string,
  actorUid: string,
): Promise<void> {
  await updateDoc(doc(db(), 'reservations', reservationId), {
    notes,
    updatedAt: serverTimestamp(),
    updatedBy: actorUid,
  });
}

/** Format an instant for the datetime-local inputs the booking screen uses. */
export function toInputDateTime(instant: EpochMs): string {
  return toMuscatWallTime(instant);
}

function requireConnection(): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ReservationServiceError(
      'offline',
      'An internet connection is required to create or modify a reservation.',
    );
  }
}

const MESSAGES: Record<string, string> = {
  'functions/unauthenticated': 'Sign in and try again.',
  'functions/permission-denied': 'You do not have permission to do that.',
  'functions/not-found': 'That record no longer exists.',
  'functions/failed-precondition': 'That change is not allowed for this reservation.',
  'functions/invalid-argument': 'Some of the details are not valid.',
  'functions/unavailable':
    'An internet connection is required to create or modify a reservation.',
};

function toReservationError(error: unknown): ReservationServiceError {
  if (error instanceof ReservationServiceError) return error;

  const code = (error as { code?: string }).code ?? 'unknown';
  const message =
    MESSAGES[code] ??
    (error as { message?: string }).message ??
    'The reservation could not be saved.';

  return new ReservationServiceError(code, message);
}
