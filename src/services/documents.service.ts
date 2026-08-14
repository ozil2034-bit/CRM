/**
 * Documents — the application layer.
 *
 * Reads come from Firestore; **issuing and voiding go through Cloud
 * Functions**, because an invoice number comes from a transactional counter and
 * the whole snapshot must be captured at one instant. The rules refuse every
 * client write to `invoices`, so the Function is the only path.
 *
 * The preview shown before issuing is built by the same `documentFinancialsFrom`
 * the server uses, over the same `reduceLedger` position, so what an employee
 * reviews is what will be frozen.
 */

import {
  collection,
  doc,
  endAt,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  startAt,
  Timestamp,
  where,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

import { getFirebaseClient } from '@/lib/firebase/client';
import { baisa, type Baisa } from '@/domain/money';
import {
  documentFinancialsFrom,
  isDocumentLanguage,
  isDocumentStatus,
  isDocumentType,
  type BusinessSnapshot,
  type CustomerSnapshot,
  type DocumentAccessoryLine,
  type DocumentAlterationLine,
  type DocumentDressLine,
  type DocumentLanguage,
  type DocumentPaymentLine,
  type DocumentSnapshot,
  type DocumentType,
} from '@/domain/document';
import { parseTermsSnapshot } from '@/domain/terms';
import {
  signedAmount,
  isPaymentMethod,
  isPaymentType,
  type FinancialPosition,
} from '@/domain/ledger';
import type { PricingSnapshot } from '@/domain/reservation-pricing';
import type { EpochMs } from '@/domain/datetime';
import type { DisplayEvent } from './payments.service';

export class DocumentServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DocumentServiceError';
    this.code = code;
  }
}

function db(): Firestore {
  return getFirebaseClient().db;
}

const INVOICES = 'invoices';

const millis = (value: unknown): EpochMs =>
  value instanceof Timestamp ? value.toMillis() : typeof value === 'number' ? value : 0;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const int = (value: unknown): Baisa =>
  typeof value === 'number' && Number.isInteger(value) ? baisa(value) : baisa(0);

/* ------------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------------ */

export interface StoredDocument extends DocumentSnapshot {
  readonly id: string;
  readonly customerId: string;
  readonly voidReason: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function toBusiness(value: unknown): BusinessSnapshot {
  const data = record(value);
  return {
    nameEn: str(data['nameEn']),
    nameAr: str(data['nameAr']),
    addressEn: str(data['addressEn']),
    addressAr: str(data['addressAr']),
    phone: str(data['phone']),
    whatsapp: str(data['whatsapp']),
    email: str(data['email']),
    website: str(data['website']),
    vatNumber: str(data['vatNumber']),
    crNumber: str(data['crNumber']),
    logoPath: (data['logoPath'] ?? null) === null ? null : str(data['logoPath']),
  };
}

function toCustomer(value: unknown): CustomerSnapshot {
  const data = record(value);
  return {
    code: str(data['code']),
    nameEn: str(data['nameEn']),
    nameAr: str(data['nameAr']),
    phone: str(data['phone']),
    email: str(data['email']),
    preferredLanguage: str(data['preferredLanguage']),
  };
}

function toPaymentLine(value: unknown): DocumentPaymentLine {
  const data = record(value);
  return {
    occurredAt: millis(data['occurredAt']),
    kind: str(data['kind']),
    type: isPaymentType(data['type']) ? data['type'] : null,
    method: isPaymentMethod(data['method']) ? data['method'] : null,
    amount: int(data['amount']),
    signedAmount: int(data['signedAmount']),
    reference: str(data['reference']),
  };
}

function toDocument(snapshot: QueryDocumentSnapshot): StoredDocument {
  const data = snapshot.data();
  const financials = record(data['financials']);

  return {
    id: snapshot.id,
    documentType: isDocumentType(data['documentType']) ? data['documentType'] : 'Tax Invoice',
    documentNumber: str(data['documentNumber']),
    issuedAt: millis(data['issuedAt']),
    language: isDocumentLanguage(data['language']) ? data['language'] : 'en',
    /*
     * An unrecognised status is shown as Voided rather than Issued. Presenting
     * a document of unknown standing as live is the dangerous direction to fail
     * in — a customer could be handed an invoice the boutique has withdrawn.
     */
    status: isDocumentStatus(data['status']) ? data['status'] : 'Voided',

    business: toBusiness(data['business']),
    customer: toCustomer(data['customer']),
    customerId: str(data['customerId']),

    reservationId: str(data['reservationId']),
    reservationCode: str(data['reservationCode']),
    eventDate: str(data['eventDate']),
    pickupAt: millis(data['pickupAt']),
    returnAt: millis(data['returnAt']),

    dresses: (Array.isArray(data['dresses']) ? data['dresses'] : []).map(
      (entry: unknown): DocumentDressLine => {
        const line = record(entry);
        return {
          dressCode: str(line['dressCode']),
          dressName: str(line['dressName']),
          designer: str(line['designer']),
          rentalPrice: int(line['rentalPrice']),
          securityDeposit: int(line['securityDeposit']),
          photoPath: (line['photoPath'] ?? null) === null ? null : str(line['photoPath']),
        };
      },
    ),

    accessories: (Array.isArray(data['accessories']) ? data['accessories'] : []).map(
      (entry: unknown): DocumentAccessoryLine => {
        const line = record(entry);
        return {
          name: str(line['name']),
          quantity: typeof line['quantity'] === 'number' ? line['quantity'] : 0,
          unitPrice: int(line['unitPrice']),
          lineTotal: int(line['lineTotal']),
        };
      },
    ),

    alterations: (Array.isArray(data['alterations']) ? data['alterations'] : []).map(
      (entry: unknown): DocumentAlterationLine => {
        const line = record(entry);
        return { description: str(line['description']), amount: int(line['amount']) };
      },
    ),

    financials: {
      rentalSubtotal: int(financials['rentalSubtotal']),
      accessorySubtotal: int(financials['accessorySubtotal']),
      alterationSubtotal: int(financials['alterationSubtotal']),
      discountAmount: int(financials['discountAmount']),
      taxableSubtotal: int(financials['taxableSubtotal']),
      vatRatePercent:
        typeof financials['vatRatePercent'] === 'number' ? financials['vatRatePercent'] : 0,
      vatAmount: int(financials['vatAmount']),
      securityDepositTotal: int(financials['securityDepositTotal']),
      grandTotal: int(financials['grandTotal']),
      lateFees: int(financials['lateFees']),
      waivedCharges: int(financials['waivedCharges']),
      totalChargeable: int(financials['totalChargeable']),
      totalPaid: int(financials['totalPaid']),
      outstanding: int(financials['outstanding']),
      refundable: int(financials['refundable']),
      depositHeld: int(financials['depositHeld']),
      depositRefunded: int(financials['depositRefunded']),
      depositForfeited: int(financials['depositForfeited']),
      financialStatus: str(financials['financialStatus']),
    },

    payments: (Array.isArray(data['payments']) ? data['payments'] : []).map(toPaymentLine),

    terms: parseTermsSnapshot(data['terms']),
    receiptFor: (data['receiptFor'] ?? null) === null ? null : toPaymentLine(data['receiptFor']),

    notes: str(data['notes']),
    issuedByName: str(data['issuedByName']),
    voidReason: str(data['voidReason']),
  };
}

export function observeDocument(
  documentId: string,
  onChange: (document: StoredDocument | null) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    doc(db(), INVOICES, documentId),
    (snapshot) =>
      onChange(snapshot.exists() ? toDocument(snapshot as QueryDocumentSnapshot) : null),
    onError,
  );
}

/** Documents issued against one reservation, newest first. */
export function observeDocumentsForReservation(
  reservationId: string,
  onChange: (documents: StoredDocument[]) => void,
  onError: (error: Error) => void,
): () => void {
  return onSnapshot(
    query(collection(db(), INVOICES), where('reservationId', '==', reservationId)),
    (snapshot) => onChange(snapshot.docs.map(toDocument).sort((a, b) => b.issuedAt - a.issuedAt)),
    onError,
  );
}

/**
 * Find documents for global search, by document number.
 *
 * A prefix range query on `documentNumber` — indexed, bounded, and the only way
 * anybody looks an invoice up. `INV-2026-` narrows to a year; `INV-2026-0042`
 * finds one. The customer's own invoices are on her page and on the booking.
 */
export async function searchDocuments(term: string, max = 6): Promise<StoredDocument[]> {
  const prefix = term.trim().toUpperCase();
  if (prefix.length < 2) return [];

  const snapshot = await getDocs(
    query(
      collection(db(), INVOICES),
      orderBy('documentNumber'),
      startAt(prefix),
      endAt(`${prefix}\uf8ff`),
      limit(max),
    ),
  );

  return snapshot.docs.map(toDocument);
}

/* ------------------------------------------------------------------------ *
 * Preview
 * ------------------------------------------------------------------------ */

export interface PreviewInput {
  readonly documentType: DocumentType;
  readonly language: DocumentLanguage;
  readonly business: BusinessSnapshot;
  readonly customer: CustomerSnapshot;
  readonly reservationCode: string;
  readonly reservationId: string;
  readonly eventDate: string;
  readonly pickupAt: EpochMs;
  readonly returnAt: EpochMs;
  readonly dresses: readonly DocumentDressLine[];
  readonly pricing: PricingSnapshot;
  readonly position: FinancialPosition;
  readonly events: readonly DisplayEvent[];
  readonly terms: DocumentSnapshot['terms'];
  readonly notes: string;
  readonly issuedByName: string;
  readonly receiptForEventId?: string | null;
}

/**
 * Build what the document *would* look like, without issuing it.
 *
 * The financial section goes through `documentFinancialsFrom`, exactly as the
 * server does, so the preview cannot flatter the real thing. The number is
 * shown as a placeholder because it does not exist yet — inventing one here and
 * having the server allocate a different one would be worse than showing none.
 */
export function buildPreview(input: PreviewInput): DocumentSnapshot {
  const payments: DocumentPaymentLine[] = input.events
    .slice()
    .sort((a, b) => a.occurredAt - b.occurredAt)
    .map((event) => ({
      occurredAt: event.occurredAt,
      kind: event.kind,
      type: event.type,
      method: event.method,
      amount: event.amount,
      signedAmount: signedAmount(event),
      reference: event.reference,
    }));

  const receiptFor =
    (input.receiptForEventId ?? null) === null
      ? null
      : (input.events
          .filter((event) => event.id === input.receiptForEventId)
          .map((event): DocumentPaymentLine => ({
            occurredAt: event.occurredAt,
            kind: event.kind,
            type: event.type,
            method: event.method,
            amount: event.amount,
            signedAmount: signedAmount(event),
            reference: event.reference,
          }))[0] ?? null);

  return {
    documentType: input.documentType,
    documentNumber: '—',
    issuedAt: Date.now(),
    language: input.language,
    status: 'Draft',

    business: input.business,
    customer: input.customer,

    reservationId: input.reservationId,
    reservationCode: input.reservationCode,
    eventDate: input.eventDate,
    pickupAt: input.pickupAt,
    returnAt: input.returnAt,

    dresses: input.dresses,
    accessories: [],
    alterations: [],

    financials: documentFinancialsFrom(input.pricing, input.position),
    payments,

    terms: input.terms,
    receiptFor,

    notes: input.notes,
    issuedByName: input.issuedByName,
  };
}

/* ------------------------------------------------------------------------ *
 * Trusted operations
 * ------------------------------------------------------------------------ */

function callable<Request, Response>(name: string) {
  return httpsCallable<Request, Response>(getFirebaseClient().functions, name);
}

/**
 * A key for one issue intent, generated when the preview opens.
 *
 * Same mechanism as Phase 5: the key becomes the document's id, so a retry
 * cannot burn a second invoice number. Restricted to characters a Firestore
 * document id accepts.
 */
export function newDocumentKey(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

  return uuid.replace(/[^A-Za-z0-9_-]/g, '');
}

export interface IssueResult {
  readonly success: boolean;
  readonly documentId: string;
  readonly documentNumber: string;
  readonly duplicate: boolean;
}

export interface IssueInput {
  readonly reservationId: string;
  readonly documentType: DocumentType;
  readonly language: DocumentLanguage;
  readonly notes: string;
  readonly forEventId?: string | null;
  readonly idempotencyKey: string;
}

function requireConnection(): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new DocumentServiceError(
      'offline',
      'An internet connection is required to issue a document. Nothing has been saved.',
    );
  }
}

export async function issueDocument(input: IssueInput): Promise<IssueResult> {
  requireConnection();

  try {
    const result = await callable<IssueInput, IssueResult>('issueDocument')(input);
    return result.data;
  } catch (error) {
    throw toDocumentError(error);
  }
}

export async function voidDocument(input: {
  readonly documentId: string;
  readonly reason: string;
}): Promise<{ success: boolean; documentNumber: string }> {
  requireConnection();

  try {
    const result = await callable<typeof input, { success: boolean; documentNumber: string }>(
      'voidDocument',
    )(input);
    return result.data;
  } catch (error) {
    throw toDocumentError(error);
  }
}

/**
 * Record that printing was **started**.
 *
 * Named for what the application can actually observe. The browser hands the
 * job to the operating system and reports nothing back — not whether paper
 * emerged, not whether the dialogue was cancelled. Claiming a document was
 * printed would be stating something unknowable.
 *
 * Failure here is swallowed: an audit note must never stop an employee handing
 * a customer their invoice.
 */
export async function recordPrintIntent(documentId: string): Promise<void> {
  try {
    await callable<{ documentId: string }, { success: boolean }>('recordPrintIntent')({
      documentId,
    });
  } catch {
    // Deliberately ignored — see the note above.
  }
}

const MESSAGES: Record<string, string> = {
  'functions/unauthenticated': 'Sign in and try again.',
  'functions/permission-denied': 'You do not have permission to do that.',
  'functions/not-found': 'That record no longer exists.',
  'functions/unavailable': 'An internet connection is required to issue a document.',
};

function toDocumentError(error: unknown): DocumentServiceError {
  if (error instanceof DocumentServiceError) return error;

  const code = (error as { code?: string }).code ?? 'unknown';
  const message =
    MESSAGES[code] ?? (error as { message?: string }).message ?? 'That could not be issued.';

  return new DocumentServiceError(code, message);
}
