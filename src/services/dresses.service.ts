/**
 * Dress inventory — the application layer.
 *
 * The only module that reads or writes dress documents. Components go through
 * hooks; business rules live in `src/domain/dress.ts`.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit as queryLimit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  setDoc,
  updateDoc,
  where,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';

import { getFirebaseClient } from '@/lib/firebase/client';
import { baisa, type Baisa } from '@/domain/money';
import type { EpochMs } from '@/domain/datetime';
import {
  DEFAULT_CLEANING_BUFFER_DAYS,
  dressSearchFields,
  isDressStatus,
  refuseManualStatusChange,
  STATUS_REFUSAL_MESSAGES,
  type DressCondition,
  type DressMeasurements,
  type DressPhoto,
  type DressStatus,
} from '@/domain/dress';
import { buildSearchTokens, rankMatches, toSearchToken } from '@/domain/search';
import { counterIdFor, formatFor } from '@/domain/numbering';
import { auditWriteFor, writeAuditInTransaction, type AuditActor } from './audit.service';
import { commitTransactionWithRetry, commitWrite, type WriteOutcome } from './write';
import type { DressFormValues } from '@/schemas/dress';
import { AppError } from './errors';

export interface Dress {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly designer: string;
  readonly brand: string;
  readonly size: string;
  readonly color: string;
  readonly style: string;
  readonly condition: DressCondition;
  readonly measurements: DressMeasurements;
  readonly rentalPrice: Baisa;
  readonly salePrice: Baisa | null;
  readonly securityDeposit: Baisa;
  readonly photos: readonly DressPhoto[];
  readonly primaryPhotoId: string | null;
  readonly location: string;
  readonly cleaningBufferDays: number;
  readonly notes: string;
  readonly status: DressStatus;
  readonly createdBy: string;
  readonly updatedBy: string;
  /**
   * When the gown entered the inventory.
   *
   * Utilisation divides by the days a dress was actually available, so a gown
   * bought on the 20th must not be measured against the whole month. Zero when
   * the server timestamp has not landed yet, which reporting reads as "in
   * service for the whole period" rather than inventing a date.
   */
  readonly createdAt: EpochMs;
}

export class DressServiceError extends AppError {
  constructor(code: string, message: string) {
    super('DressServiceError', code, message);
  }
}

const DRESSES = 'dresses';

const millis = (value: unknown): EpochMs => {
  if (value instanceof Timestamp) return value.toMillis();
  return typeof value === 'number' ? value : 0;
};

function db(): Firestore {
  return getFirebaseClient().db;
}

/* ------------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------------ */

function toDress(snapshot: QueryDocumentSnapshot): Dress {
  const data = snapshot.data();

  return {
    id: snapshot.id,
    code: str(data['code']),
    name: str(data['name']),
    designer: str(data['designer']),
    brand: str(data['brand']),
    size: str(data['size']),
    color: str(data['color']),
    style: str(data['style']),
    condition: (data['condition'] as DressCondition | undefined) ?? 'Excellent',
    measurements: {
      bust: num(data['measurements'], 'bust'),
      waist: num(data['measurements'], 'waist'),
      hips: num(data['measurements'], 'hips'),
      length: num(data['measurements'], 'length'),
    },
    rentalPrice: safeBaisa(data['rentalPrice']),
    salePrice:
      data['salePrice'] === null || data['salePrice'] === undefined
        ? null
        : safeBaisa(data['salePrice']),
    securityDeposit: safeBaisa(data['securityDeposit']),
    photos: Array.isArray(data['photos']) ? (data['photos'] as DressPhoto[]) : [],
    primaryPhotoId: (data['primaryPhotoId'] as string | null | undefined) ?? null,
    location: str(data['location']),
    cleaningBufferDays:
      typeof data['cleaningBufferDays'] === 'number'
        ? data['cleaningBufferDays']
        : DEFAULT_CLEANING_BUFFER_DAYS,
    notes: str(data['notes']),
    // A document with an unrecognised status is shown as Retired rather than
    // guessed as Available: presenting an unknown state as bookable would be
    // the dangerous direction to fail in.
    status: isDressStatus(data['status']) ? data['status'] : 'Retired',
    createdBy: str(data['createdBy']),
    createdAt: millis(data['createdAt']),
    updatedBy: str(data['updatedBy']),
  };
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const num = (container: unknown, key: string): number | null => {
  if (typeof container !== 'object' || container === null) return null;
  const value = (container as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
};

const safeBaisa = (value: unknown): Baisa =>
  typeof value === 'number' && Number.isInteger(value) ? baisa(value) : baisa(0);

export interface DressFilters {
  readonly statuses?: readonly DressStatus[];
  /** Retired dresses are hidden from the working inventory by default. */
  readonly includeRetired?: boolean;
  readonly designer?: string;
  readonly size?: string;
}

/**
 * Observe the inventory.
 *
 * Live rather than one-shot, so a status change made on the tablet at the rail
 * appears on the desk machine without a refresh.
 */
export function observeDresses(
  filters: DressFilters,
  onChange: (dresses: Dress[]) => void,
  onError: (error: Error) => void,
): () => void {
  const constraints = [];

  if (filters.statuses && filters.statuses.length > 0) {
    constraints.push(where('status', 'in', [...filters.statuses]));
  } else if (filters.includeRetired !== true) {
    constraints.push(where('status', '!=', 'Retired'));
  }

  const dressQuery = query(collection(db(), DRESSES), ...constraints, orderBy('code'));

  return onSnapshot(
    dressQuery,
    (snapshot) => {
      let dresses = snapshot.docs.map(toDress);

      // Applied in memory because Firestore cannot combine several equality
      // filters with the inequality above without a composite index per
      // combination. The candidate set is one boutique's inventory.
      if (filters.designer) {
        dresses = dresses.filter((dress) => dress.designer === filters.designer);
      }
      if (filters.size) {
        dresses = dresses.filter((dress) => dress.size === filters.size);
      }

      onChange(dresses);
    },
    onError,
  );
}

export function observeDress(
  dressId: string,
  onChange: (dress: Dress | null) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db(), DRESSES, dressId),
    (snapshot) => {
      onChange(snapshot.exists() ? toDress(snapshot as QueryDocumentSnapshot) : null);
    },
    onError,
  );
}

/**
 * Read the purchase cost.
 *
 * Lives in an owner-only subcollection because Firestore rules cannot hide a
 * single field. Staff calling this are refused by the rules, so the caller
 * treats a failure as "not visible to you", not as an error to surface.
 */
export async function readPurchaseCost(dressId: string): Promise<Baisa | null> {
  try {
    const snapshot = await getDoc(doc(db(), `${DRESSES}/${dressId}/private/cost`));
    if (!snapshot.exists()) return null;
    const value = snapshot.data()['purchaseCost'];
    return typeof value === 'number' ? baisa(value) : null;
  } catch {
    return null;
  }
}

/** Search the inventory by code, name, designer, brand, colour or size. */
export async function searchDresses(term: string, max = 20): Promise<Dress[]> {
  const token = toSearchToken(term);
  if (token === null) return [];

  const snapshot = await getDocs(
    query(
      collection(db(), DRESSES),
      where('searchTokens', 'array-contains', token),
      queryLimit(max * 3),
    ),
  );

  const candidates = snapshot.docs.map(toDress);

  return rankMatches(
    term,
    candidates,
    (dress) => `${dress.code} ${dress.name} ${dress.designer} ${dress.brand} ${dress.color}`,
  ).slice(0, max);
}

/* ------------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------------ */

function dressDocumentFrom(values: DressFormValues, code: string) {
  return {
    code,
    name: values.name,
    designer: values.designer,
    brand: values.brand,
    size: values.size,
    color: values.color,
    style: values.style,
    condition: values.condition,
    measurements: values.measurements,
    rentalPrice: values.rentalPrice,
    salePrice: values.salePrice,
    securityDeposit: values.securityDeposit,
    location: values.location,
    cleaningBufferDays: values.cleaningBufferDays,
    notes: values.notes,
    searchTokens: buildSearchTokens(
      dressSearchFields({
        code,
        name: values.name,
        designer: values.designer,
        brand: values.brand,
        color: values.color,
        size: values.size,
      }),
    ),
  };
}

export interface CreateDressInput {
  readonly values: DressFormValues;
  readonly actor: AuditActor;
  /**
   * Whether to persist `purchaseCost`. Derived from the caller's permission;
   * the rules refuse a staff write to the private subcollection regardless.
   */
  readonly canSetPurchaseCost: boolean;
}

/**
 * Create a dress, allocating its code atomically.
 *
 * The counter read, the counter increment, the dress write and the audit entry
 * are one transaction. Two employees creating a dress at the same moment
 * therefore cannot receive `WD-0007` twice: the second transaction re-reads the
 * updated counter and retries.
 *
 * **This requires a connection.** Firestore transactions have no offline mode —
 * they need a round trip to read the current counter. Creating a dress offline
 * fails with a clear message rather than queueing a write that would hand out a
 * duplicate code.
 */
export async function createDress(input: CreateDressInput): Promise<{ id: string; code: string }> {
  const result = await commitTransactionWithRetry(async () =>
    runTransaction(db(), async (transaction) => {
      const counterRef = doc(db(), 'counters', counterIdFor('dress'));
      const counterSnapshot = await transaction.get(counterRef);

      const current = counterSnapshot.exists() ? Number(counterSnapshot.data()['current'] ?? 0) : 0;
      const next = current + 1;
      const code = formatFor('dress', next);

      const dressRef = doc(collection(db(), DRESSES));

      if (counterSnapshot.exists()) {
        transaction.update(counterRef, { current: next, updatedAt: serverTimestamp() });
      } else {
        transaction.set(counterRef, { current: next, updatedAt: serverTimestamp() });
      }

      transaction.set(dressRef, {
        ...dressDocumentFrom(input.values, code),
        photos: [],
        primaryPhotoId: null,
        status: 'Available' satisfies DressStatus,
        createdAt: serverTimestamp(),
        createdBy: input.actor.uid,
        updatedAt: serverTimestamp(),
        updatedBy: input.actor.uid,
      });

      if (input.canSetPurchaseCost && input.values.purchaseCost !== null) {
        transaction.set(doc(db(), `${DRESSES}/${dressRef.id}/private/cost`), {
          purchaseCost: input.values.purchaseCost,
          updatedAt: serverTimestamp(),
          updatedBy: input.actor.uid,
        });
      }

      writeAuditInTransaction(db(), transaction, {
        actor: input.actor,
        action: 'dress.created',
        entityType: 'dress',
        entityId: dressRef.id,
        entityCode: code,
        before: null,
        after: { name: input.values.name, code, status: 'Available' },
      });

      return { id: dressRef.id, code };
    }),
  );

  if (result.status === 'failed') {
    throw asDressError(result.error, 'A dress code could not be reserved.');
  }

  return result.value;
}

export interface UpdateDressInput {
  readonly dressId: string;
  readonly before: Dress;
  readonly values: DressFormValues;
  readonly actor: AuditActor;
  readonly canSetPurchaseCost: boolean;
}

/**
 * Update a dress.
 *
 * Not a transaction: nothing here allocates a number, so the write can be
 * applied locally and queued when the connection is down. The returned outcome
 * distinguishes "the server has it" from "this device has it".
 */
export async function updateDress(
  input: UpdateDressInput,
  onLateFailure?: (error: Error) => void,
): Promise<WriteOutcome> {
  const { dressId, before, values, actor } = input;

  const outcome = await commitWrite(
    async () => {
      const audit = auditFor(actor, before, values);

      await updateDoc(doc(db(), DRESSES, dressId), {
        ...dressDocumentFrom(values, before.code),
        updatedAt: serverTimestamp(),
        updatedBy: actor.uid,
      });

      await setDoc(audit.ref, audit.data);

      if (input.canSetPurchaseCost && values.purchaseCost !== null) {
        await setDoc(doc(db(), `${DRESSES}/${dressId}/private/cost`), {
          purchaseCost: values.purchaseCost,
          updatedAt: serverTimestamp(),
          updatedBy: actor.uid,
        });
      }
    },
    onLateFailure ? { onLateFailure } : {},
  );

  if (outcome.status === 'failed') {
    throw asDressError(outcome.error, 'The dress could not be saved.');
  }

  return outcome;
}

function auditFor(actor: AuditActor, before: Dress, values: DressFormValues) {
  return auditWriteFor(db(), {
    actor,
    action: 'dress.updated',
    entityType: 'dress',
    entityId: before.id,
    entityCode: before.code,
    before: {
      name: before.name,
      designer: before.designer,
      rentalPrice: before.rentalPrice,
      securityDeposit: before.securityDeposit,
      size: before.size,
      location: before.location,
    },
    after: {
      name: values.name,
      designer: values.designer,
      rentalPrice: values.rentalPrice,
      securityDeposit: values.securityDeposit,
      size: values.size,
      location: values.location,
    },
  });
}

/**
 * Change a dress's status by hand.
 *
 * Refuses the transitions the reservation engine owns, so the inventory cannot
 * be made to disagree with the bookings that drive it.
 */
export async function changeDressStatus(
  input: {
    readonly dress: Dress;
    readonly status: DressStatus;
    readonly actor: AuditActor;
    readonly reason?: string;
  },
  onLateFailure?: (error: Error) => void,
): Promise<WriteOutcome> {
  const refusal = refuseManualStatusChange(input.dress.status, input.status);

  if (refusal !== null) {
    throw new DressServiceError('invalid-transition', STATUS_REFUSAL_MESSAGES[refusal]);
  }

  const outcome = await commitWrite(
    async () => {
      await updateDoc(doc(db(), DRESSES, input.dress.id), {
        status: input.status,
        updatedAt: serverTimestamp(),
        updatedBy: input.actor.uid,
      });

      const audit = auditWriteFor(db(), {
        actor: input.actor,
        action: input.status === 'Retired' ? 'dress.retired' : 'dress.status_changed',
        entityType: 'dress',
        entityId: input.dress.id,
        entityCode: input.dress.code,
        before: { status: input.dress.status },
        after: { status: input.status },
        reason: input.reason,
      });

      await setDoc(audit.ref, audit.data);
    },
    onLateFailure ? { onLateFailure } : {},
  );

  if (outcome.status === 'failed') {
    throw asDressError(outcome.error, 'The status could not be changed.');
  }

  return outcome;
}

/**
 * Retire a dress.
 *
 * The archive operation for inventory. The document is never deleted: it is
 * referenced by reservations and invoices, and those must stay resolvable.
 */
export async function retireDress(
  dress: Dress,
  actor: AuditActor,
  reason?: string,
): Promise<WriteOutcome> {
  return changeDressStatus({ dress, status: 'Retired', actor, ...(reason ? { reason } : {}) });
}

function asDressError(error: Error, fallback: string): DressServiceError {
  const code = (error as { code?: string }).code ?? 'unknown';

  if (code === 'permission-denied') {
    return new DressServiceError(code, 'You do not have permission to do that.');
  }
  if (code === 'unavailable') {
    return new DressServiceError(
      code,
      'This needs a connection — a unique dress code must be reserved on the server.',
    );
  }

  return new DressServiceError(code, fallback);
}
