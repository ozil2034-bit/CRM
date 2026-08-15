/**
 * Customers — the application layer.
 *
 * The only module that reads or writes customer documents.
 */

import {
  collection,
  doc,
  getDocs,
  limit as queryLimit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';

import { getFirebaseClient } from '@/lib/firebase/client';
import {
  customerSearchFields,
  evaluateDuplicatePhone,
  normaliseName,
  type CustomerMeasurements,
  type DuplicateVerdict,
  type ExistingCustomerSummary,
  type PreferredLanguage,
} from '@/domain/customer';
import { parseOmanPhone } from '@/domain/phone';
import { buildSearchTokens, rankMatches, toSearchToken } from '@/domain/search';
import { counterIdFor, formatFor } from '@/domain/numbering';
import { auditWriteFor, writeAuditInTransaction, type AuditActor } from './audit.service';
import { commitTransactionWithRetry, commitWrite, type WriteOutcome } from './write';
import type { CustomerFormValues } from '@/schemas/customer';
import { AppError } from './errors';

export interface Customer {
  readonly id: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly phone: string;
  readonly phoneNormalized: string;
  readonly hasWhatsapp: boolean;
  readonly email: string;
  readonly nationalId: string;
  readonly eventDate: string;
  readonly measurements: CustomerMeasurements;
  readonly source: string;
  readonly preferredLanguage: PreferredLanguage;
  readonly notes: string;
  readonly archived: boolean;
  readonly createdBy: string;
  readonly updatedBy: string;
}

export class CustomerServiceError extends AppError {
  constructor(code: string, message: string) {
    super('CustomerServiceError', code, message);
  }
}

const CUSTOMERS = 'customers';

function db(): Firestore {
  return getFirebaseClient().db;
}

/* ------------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------------ */

function toCustomer(snapshot: QueryDocumentSnapshot): Customer {
  const data = snapshot.data();
  const measurements = (data['measurements'] ?? {}) as Record<string, unknown>;

  const measure = (key: string): number | null =>
    typeof measurements[key] === 'number' ? (measurements[key] as number) : null;

  return {
    id: snapshot.id,
    code: str(data['code']),
    nameEn: str(data['nameEn']),
    nameAr: str(data['nameAr']),
    phone: str(data['phone']),
    phoneNormalized: str(data['phoneNormalized']),
    hasWhatsapp: data['hasWhatsapp'] === true,
    email: str(data['email']),
    nationalId: str(data['nationalId']),
    eventDate: str(data['eventDate']),
    measurements: {
      bust: measure('bust'),
      waist: measure('waist'),
      hips: measure('hips'),
      height: measure('height'),
      shoeSize: measure('shoeSize'),
    },
    source: str(data['source']),
    preferredLanguage: (data['preferredLanguage'] as PreferredLanguage | undefined) ?? 'bilingual',
    notes: str(data['notes']),
    archived: data['archived'] === true,
    createdBy: str(data['createdBy']),
    updatedBy: str(data['updatedBy']),
  };
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export interface CustomerFilters {
  /** Archived customers are hidden from everyday lists by default. */
  readonly includeArchived?: boolean;
}

export function observeCustomers(
  filters: CustomerFilters,
  onChange: (customers: Customer[]) => void,
  onError: (error: Error) => void,
): () => void {
  const constraints = filters.includeArchived === true ? [] : [where('archived', '==', false)];

  return onSnapshot(
    query(collection(db(), CUSTOMERS), ...constraints, orderBy('code', 'desc')),
    (snapshot) => onChange(snapshot.docs.map(toCustomer)),
    onError,
  );
}

export function observeCustomer(
  customerId: string,
  onChange: (customer: Customer | null) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db(), CUSTOMERS, customerId),
    (snapshot) => {
      onChange(snapshot.exists() ? toCustomer(snapshot as QueryDocumentSnapshot) : null);
    },
    onError,
  );
}

/**
 * Search customers by name (either script), phone or code.
 *
 * One indexed `array-contains` query with a bounded limit — the whole customer
 * collection is never pulled into the browser. The token is deliberately loose,
 * so results are then narrowed and ranked in memory over a small candidate set.
 */
export async function searchCustomers(term: string, max = 20): Promise<Customer[]> {
  const token = toSearchToken(term);
  if (token === null) return [];

  const snapshot = await getDocs(
    query(
      collection(db(), CUSTOMERS),
      where('searchTokens', 'array-contains', token),
      queryLimit(max * 3),
    ),
  );

  const candidates = snapshot.docs.map(toCustomer);

  return rankMatches(
    term,
    candidates,
    (customer) =>
      `${customer.code} ${customer.nameEn} ${customer.nameAr} ${customer.phoneNormalized}`,
  ).slice(0, max);
}

/**
 * Find customers already holding a phone number.
 *
 * An exact equality query on the normalised form — never a full scan.
 */
export async function findByPhone(phoneNormalized: string): Promise<ExistingCustomerSummary[]> {
  const snapshot = await getDocs(
    query(
      collection(db(), CUSTOMERS),
      where('phoneNormalized', '==', phoneNormalized),
      queryLimit(10),
    ),
  );

  return snapshot.docs.map((document) => {
    const customer = toCustomer(document);
    return {
      id: customer.id,
      code: customer.code,
      nameEn: customer.nameEn,
      nameAr: customer.nameAr,
      phoneNormalized: customer.phoneNormalized,
      archived: customer.archived,
    };
  });
}

/**
 * Check a phone number before saving.
 *
 * The verdict warns and names who already holds the number; it never blocks a
 * legitimate shared family line. The decision rule lives in the domain.
 */
export async function checkDuplicatePhone(
  phone: string,
  editingCustomerId?: string,
): Promise<DuplicateVerdict> {
  const parsed = parseOmanPhone(phone);
  if (!parsed.ok) {
    return { severity: 'none', matches: [], reason: 'NONE' };
  }

  const existing = await findByPhone(parsed.phone.normalized);

  return evaluateDuplicatePhone(parsed.phone.normalized, existing, {
    editingCustomerId,
  });
}

/* ------------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------------ */

function customerDocumentFrom(values: CustomerFormValues, code: string) {
  const parsed = parseOmanPhone(values.phone);
  if (!parsed.ok) {
    throw new CustomerServiceError('invalid-phone', 'Enter a valid Omani phone number.');
  }

  const nameEn = normaliseName(values.nameEn);
  const nameAr = normaliseName(values.nameAr);

  return {
    code,
    nameEn,
    nameAr,
    phone: parsed.phone.e164,
    phoneNormalized: parsed.phone.normalized,
    hasWhatsapp: values.hasWhatsapp,
    email: values.email.trim().toLowerCase(),
    nationalId: values.nationalId,
    eventDate: values.eventDate,
    measurements: values.measurements,
    source: values.source,
    preferredLanguage: values.preferredLanguage,
    notes: values.notes,
    searchTokens: buildSearchTokens(
      customerSearchFields({
        code,
        nameEn,
        nameAr,
        phoneNormalized: parsed.phone.normalized,
        email: values.email,
      }),
    ),
  };
}

export interface CreateCustomerInput {
  readonly values: CustomerFormValues;
  readonly actor: AuditActor;
}

/**
 * Create a customer, allocating `CU-XXXX` atomically.
 *
 * Same transactional guarantee as dress creation: the counter read, its
 * increment, the customer write and the audit entry commit together, so two
 * employees cannot receive the same code. Requires a connection.
 */
export async function createCustomer(
  input: CreateCustomerInput,
): Promise<{ id: string; code: string }> {
  const result = await commitTransactionWithRetry(async () =>
    runTransaction(db(), async (transaction) => {
      const counterRef = doc(db(), 'counters', counterIdFor('customer'));
      const counterSnapshot = await transaction.get(counterRef);

      const current = counterSnapshot.exists() ? Number(counterSnapshot.data()['current'] ?? 0) : 0;
      const next = current + 1;
      const code = formatFor('customer', next);

      const customerRef = doc(collection(db(), CUSTOMERS));

      if (counterSnapshot.exists()) {
        transaction.update(counterRef, { current: next, updatedAt: serverTimestamp() });
      } else {
        transaction.set(counterRef, { current: next, updatedAt: serverTimestamp() });
      }

      transaction.set(customerRef, {
        ...customerDocumentFrom(input.values, code),
        archived: false,
        createdAt: serverTimestamp(),
        createdBy: input.actor.uid,
        updatedAt: serverTimestamp(),
        updatedBy: input.actor.uid,
      });

      writeAuditInTransaction(db(), transaction, {
        actor: input.actor,
        action: 'customer.created',
        entityType: 'customer',
        entityId: customerRef.id,
        entityCode: code,
        before: null,
        // Name and code only. Contact details, measurements and the national ID
        // are not change-log material.
        after: { code, nameEn: normaliseName(input.values.nameEn) },
      });

      return { id: customerRef.id, code };
    }),
  );

  if (result.status === 'failed') {
    throw asCustomerError(result.error, 'A customer code could not be reserved.');
  }

  return result.value;
}

export interface UpdateCustomerInput {
  readonly customerId: string;
  readonly before: Customer;
  readonly values: CustomerFormValues;
  readonly actor: AuditActor;
}

export async function updateCustomer(
  input: UpdateCustomerInput,
  onLateFailure?: (error: Error) => void,
): Promise<WriteOutcome> {
  const { customerId, before, values, actor } = input;

  const outcome = await commitWrite(
    async () => {
      await updateDoc(doc(db(), CUSTOMERS, customerId), {
        ...customerDocumentFrom(values, before.code),
        updatedAt: serverTimestamp(),
        updatedBy: actor.uid,
      });

      const parsedPhone = parseOmanPhone(values.phone);

      const audit = auditWriteFor(db(), {
        actor,
        action: 'customer.updated',
        entityType: 'customer',
        entityId: customerId,
        entityCode: before.code,
        before: {
          nameEn: before.nameEn,
          nameAr: before.nameAr,
          phone: before.phone,
          eventDate: before.eventDate,
          preferredLanguage: before.preferredLanguage,
        },
        after: {
          nameEn: normaliseName(values.nameEn),
          nameAr: normaliseName(values.nameAr),
          // The stored E.164 form, so before/after compare like with like — the
          // raw input would show a spurious change whenever formatting differs.
          phone: parsedPhone.ok ? parsedPhone.phone.e164 : values.phone,
          eventDate: values.eventDate,
          preferredLanguage: values.preferredLanguage,
        },
      });

      await setDoc(audit.ref, audit.data);
    },
    onLateFailure ? { onLateFailure } : {},
  );

  if (outcome.status === 'failed') {
    throw asCustomerError(outcome.error, 'The customer could not be saved.');
  }

  return outcome;
}

/**
 * Archive or restore a customer.
 *
 * Never a deletion: reservations, payments and invoices reference the customer,
 * and those records must stay resolvable for the financial history to mean
 * anything.
 */
export async function setCustomerArchived(
  input: {
    readonly customer: Customer;
    readonly archived: boolean;
    readonly actor: AuditActor;
    readonly reason?: string;
  },
  onLateFailure?: (error: Error) => void,
): Promise<WriteOutcome> {
  const outcome = await commitWrite(
    async () => {
      await updateDoc(doc(db(), CUSTOMERS, input.customer.id), {
        archived: input.archived,
        updatedAt: serverTimestamp(),
        updatedBy: input.actor.uid,
      });

      const audit = auditWriteFor(db(), {
        actor: input.actor,
        action: input.archived ? 'customer.archived' : 'customer.restored',
        entityType: 'customer',
        entityId: input.customer.id,
        entityCode: input.customer.code,
        before: { archived: input.customer.archived },
        after: { archived: input.archived },
        reason: input.reason,
      });

      await setDoc(audit.ref, audit.data);
    },
    onLateFailure ? { onLateFailure } : {},
  );

  if (outcome.status === 'failed') {
    throw asCustomerError(outcome.error, 'The customer could not be updated.');
  }

  return outcome;
}

function asCustomerError(error: Error, fallback: string): CustomerServiceError {
  if (error instanceof CustomerServiceError) return error;

  const code = (error as { code?: string }).code ?? 'unknown';

  if (code === 'permission-denied') {
    return new CustomerServiceError(code, 'You do not have permission to do that.');
  }
  if (code === 'unavailable') {
    return new CustomerServiceError(
      code,
      'This needs a connection — a unique customer code must be reserved on the server.',
    );
  }

  return new CustomerServiceError(code, fallback);
}
