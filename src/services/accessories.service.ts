/**
 * The accessory catalogue — the application layer.
 *
 * Ordinary client CRUD, unlike reservations and money. An accessory record
 * grants nothing, holds nothing and blocks nothing: it is a priced list entry,
 * so there is no read-then-write decision for a Cloud Function to protect. The
 * rules govern who may write it.
 *
 * Adding an accessory *to a reservation* is a different matter entirely and
 * lives in `amendments.service.ts`, because that changes what a customer owes.
 */

import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';

import { getFirebaseClient } from '@/lib/firebase/client';
import { baisa, type Baisa } from '@/domain/money';
import {
  isAccessoryCategory,
  isAccessoryKind,
  isAccessoryStatus,
  type Accessory,
  type AccessoryStatus,
} from '@/domain/accessory';
import { counterIdFor, formatFor } from '@/domain/numbering';
import { auditWriteFor, writeAuditInTransaction, type AuditActor } from './audit.service';
import { commitTransactionWithRetry, commitWrite, type WriteOutcome } from './write';
import type { AccessoryFormValues } from '@/schemas/accessory';

const ACCESSORIES = 'accessories';

function db(): Firestore {
  return getFirebaseClient().db;
}

export class AccessoryServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AccessoryServiceError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------------ */

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const int = (value: unknown): Baisa =>
  typeof value === 'number' && Number.isInteger(value) ? baisa(value) : baisa(0);

function toAccessory(snapshot: QueryDocumentSnapshot): Accessory {
  const data = snapshot.data();

  return {
    id: snapshot.id,
    code: str(data['code']),
    name: str(data['name']),
    nameAr: str(data['nameAr']),
    description: str(data['description']),
    descriptionAr: str(data['descriptionAr']),
    category: isAccessoryCategory(data['category']) ? data['category'] : 'Other',
    kind: isAccessoryKind(data['kind']) ? data['kind'] : 'Rental',
    rentalPrice: int(data['rentalPrice']),
    salePrice:
      (data['salePrice'] ?? null) === null ? null : int(data['salePrice']),
    securityDeposit: int(data['securityDeposit']),
    photoPath: str(data['photoPath']).length > 0 ? str(data['photoPath']) : null,
    /*
     * An unrecognised status is treated as Retired. Presenting an unknown state
     * as sellable is the dangerous direction to fail in — it would put a line on
     * an invoice.
     */
    status: isAccessoryStatus(data['status']) ? data['status'] : 'Retired',
  };
}

/**
 * The whole catalogue.
 *
 * Read in one listener and filtered in memory. A boutique's accessory list is
 * tens of entries, not thousands, so a per-filter query would cost more round
 * trips than it saves — and every screen that uses it wants a different slice.
 */
export function observeAccessories(
  onChange: (accessories: Accessory[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    query(collection(db(), ACCESSORIES), orderBy('name')),
    (snapshot) => onChange(snapshot.docs.map(toAccessory)),
    onError,
  );
}

/* ------------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------------ */

function documentFrom(values: AccessoryFormValues) {
  return {
    name: values.name,
    nameAr: values.nameAr,
    description: values.description,
    descriptionAr: values.descriptionAr,
    category: values.category,
    kind: values.kind,
    rentalPrice: values.rentalPrice,
    salePrice: values.salePrice,
    securityDeposit: values.securityDeposit,
  };
}

/**
 * Create an accessory, allocating its code atomically.
 *
 * The counter read, the increment, the write and the audit entry are one
 * transaction, so two employees adding an accessory at the same moment cannot
 * both receive `ACC-0007`.
 *
 * **Requires a connection**, like every counter allocation: a transaction needs
 * a round trip to read the current value, and queueing one offline would hand
 * out a duplicate code.
 */
export async function createAccessory(input: {
  readonly values: AccessoryFormValues;
  readonly actor: AuditActor;
}): Promise<{ id: string; code: string }> {
  const result = await commitTransactionWithRetry(async () =>
    runTransaction(db(), async (transaction) => {
      const counterRef = doc(db(), 'counters', counterIdFor('accessory'));
      const counterSnapshot = await transaction.get(counterRef);

      const current = counterSnapshot.exists() ? Number(counterSnapshot.data()['current'] ?? 0) : 0;
      const next = current + 1;
      const code = formatFor('accessory', next);

      const accessoryRef = doc(collection(db(), ACCESSORIES));

      if (counterSnapshot.exists()) {
        transaction.update(counterRef, { current: next, updatedAt: serverTimestamp() });
      } else {
        transaction.set(counterRef, { current: next, updatedAt: serverTimestamp() });
      }

      transaction.set(accessoryRef, {
        ...documentFrom(input.values),
        code,
        photoPath: null,
        status: 'Active' satisfies AccessoryStatus,
        createdAt: serverTimestamp(),
        createdBy: input.actor.uid,
        updatedAt: serverTimestamp(),
        updatedBy: input.actor.uid,
      });

      writeAuditInTransaction(db(), transaction, {
        actor: input.actor,
        action: 'accessory.created',
        entityType: 'accessory',
        entityId: accessoryRef.id,
        entityCode: code,
        before: null,
        after: { name: input.values.name, code },
      });

      return { id: accessoryRef.id, code };
    }),
  );

  if (result.status === 'failed') {
    throw new AccessoryServiceError('transaction', 'An accessory code could not be reserved.');
  }

  return result.value;
}

export async function updateAccessory(input: {
  readonly accessoryId: string;
  readonly code: string;
  readonly values: AccessoryFormValues;
  readonly actor: AuditActor;
  readonly onLateFailure?: (error: Error) => void;
}): Promise<WriteOutcome> {
  const audit = auditWriteFor(db(), {
    actor: input.actor,
    action: 'accessory.updated',
    entityType: 'accessory',
    entityId: input.accessoryId,
    entityCode: input.code,
    after: { name: input.values.name },
  });

  return commitWrite(
    async () => {
      await updateDoc(doc(db(), ACCESSORIES, input.accessoryId), {
        ...documentFrom(input.values),
        updatedAt: serverTimestamp(),
        updatedBy: input.actor.uid,
      });
      await setDoc(audit.ref, audit.data);
    },
    { ...(input.onLateFailure ? { onLateFailure: input.onLateFailure } : {}) },
  );
}

/**
 * Retire or restore a catalogue entry.
 *
 * Never a deletion. Past reservations reference accessories by id, and a
 * removed entry would leave "which accessories earn their keep" unanswerable
 * for every booking that used one.
 */
export async function setAccessoryStatus(input: {
  readonly accessoryId: string;
  readonly code: string;
  readonly status: AccessoryStatus;
  readonly actor: AuditActor;
  readonly onLateFailure?: (error: Error) => void;
}): Promise<WriteOutcome> {
  const audit = auditWriteFor(db(), {
    actor: input.actor,
    action: input.status === 'Retired' ? 'accessory.retired' : 'accessory.restored',
    entityType: 'accessory',
    entityId: input.accessoryId,
    entityCode: input.code,
    after: { status: input.status },
  });

  return commitWrite(
    async () => {
      await updateDoc(doc(db(), ACCESSORIES, input.accessoryId), {
        status: input.status,
        updatedAt: serverTimestamp(),
        updatedBy: input.actor.uid,
      });
      await setDoc(audit.ref, audit.data);
    },
    { ...(input.onLateFailure ? { onLateFailure: input.onLateFailure } : {}) },
  );
}
