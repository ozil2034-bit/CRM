/**
 * Documents — the trusted server-side operations.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY ISSUING RUNS ON THE SERVER
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Three reasons, each sufficient on its own.
 *
 * 1. **The number.** `INV-2026-0001` comes from a per-year counter allocated in
 *    a transaction. A client choosing its own number would produce duplicates
 *    the moment two employees issue at once, and a duplicated invoice number is
 *    a defect a tax authority cares about.
 *
 * 2. **The figures.** An invoice's totals come from the reservation's frozen
 *    pricing and from `reduceLedger` over the ledger. Both must be read at one
 *    consistent instant, inside the transaction that writes the document —
 *    otherwise a payment landing mid-issue produces an invoice whose balance
 *    was never true.
 *
 * 3. **Immutability.** `firestore.rules` refuses every client write to
 *    `invoices`. If a client could create one it could also craft its contents,
 *    and an invoice whose figures the browser chose is not evidence of
 *    anything.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DOCUMENT COMPUTES NOTHING
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `documentFinancialsFrom` copies figures; it does not calculate. There is no
 * VAT arithmetic in this file and no summing of payments. A document that
 * recomputes its own totals is a second financial engine, and when two engines
 * disagree the wrong one is the one the customer is holding.
 */

import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore';

import { callerFrom, db, readProfile, writeAudit } from './lib/firestore';
import { effectiveRole } from './lib/guards';

import {
  reduceLedger,
  isPaymentMethod,
  isPaymentType,
  signedAmount,
  type FinancialEvent,
  type FinancialEventKind,
} from '../../src/domain/ledger';
import {
  documentFinancialsFrom,
  isDocumentLanguage,
  isDocumentType,
  type BusinessSnapshot,
  type CustomerSnapshot,
  type DocumentAccessoryLine,
  type DocumentAlterationLine,
  type DocumentDressLine,
  type DocumentLanguage,
  type DocumentPaymentLine,
  type DocumentType,
} from '../../src/domain/document';
import { snapshotTerms, type TermsSectionKey } from '../../src/domain/terms';
import type { TermsSection } from '../../src/domain/document';
import type { PricingSnapshot } from '../../src/domain/reservation-pricing';
import {
  formatRecordNumber,
  counterIdFor,
  DEFAULT_NUMBER_FORMATS,
} from '../../src/domain/numbering';
import { baisa, type Baisa } from '../../src/domain/money';
import { toMuscatDate } from '../../src/domain/datetime';

const INVOICES = 'invoices';
const EVENTS = 'financialEvents';

/* ------------------------------------------------------------------------ *
 * Callers
 * ------------------------------------------------------------------------ */

interface Actor {
  readonly uid: string;
  readonly name: string;
  readonly role: 'OWNER' | 'STAFF';
}

async function requireEmployee(request: CallableRequest<unknown>): Promise<Actor> {
  const caller = callerFrom(request.auth);

  if (caller.uid === null) {
    throw new HttpsError('unauthenticated', 'Sign in to perform this action.');
  }

  const profile = await readProfile(caller.uid);
  const role = effectiveRole(caller, profile);

  if (role === null) {
    throw new HttpsError('permission-denied', 'This account is not an active employee.');
  }

  return {
    uid: caller.uid,
    name: (request.auth?.token['name'] as string | undefined) ?? 'Employee',
    role,
  };
}

/**
 * Voiding is the owner's.
 *
 * A void does not delete an invoice, but it does withdraw a document already
 * given to a customer, and it is the operation that could be used to make an
 * inconvenient invoice disappear from a total. Same reasoning as refunds and
 * reversals in Phase 5.
 */
async function requireOwnerActor(request: CallableRequest<unknown>): Promise<Actor> {
  const actor = await requireEmployee(request);

  if (actor.role !== 'OWNER') {
    throw new HttpsError('permission-denied', 'Only the owner may void a document.');
  }

  return actor;
}

/* ------------------------------------------------------------------------ *
 * Reading the sources
 * ------------------------------------------------------------------------ */

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function int(value: unknown): Baisa {
  return typeof value === 'number' && Number.isInteger(value) ? baisa(value) : baisa(0);
}

function readPricing(data: FirebaseFirestore.DocumentData | undefined): PricingSnapshot {
  const pricing = (data?.['pricing'] ?? {}) as Record<string, unknown>;

  return {
    rentalSubtotal: int(pricing['rentalSubtotal']),
    accessorySubtotal: int(pricing['accessorySubtotal']),
    alterationSubtotal: int(pricing['alterationSubtotal']),
    discountAmount: int(pricing['discountAmount']),
    taxableSubtotal: int(pricing['taxableSubtotal']),
    vatRatePercent: typeof pricing['vatRatePercent'] === 'number' ? pricing['vatRatePercent'] : 0,
    vatAmount: int(pricing['vatAmount']),
    securityDepositTotal: int(pricing['securityDepositTotal']),
    grandTotal: int(pricing['grandTotal']),
  };
}

function toEvent(id: string, data: FirebaseFirestore.DocumentData): FinancialEvent {
  const at = data['occurredAt'];

  return {
    id,
    reservationId: str(data['reservationId']),
    kind: data['kind'] as FinancialEventKind,
    amount: int(data['amount']),
    method: isPaymentMethod(data['method']) ? data['method'] : null,
    type: isPaymentType(data['type']) ? data['type'] : null,
    occurredAt: at instanceof Timestamp ? at.toMillis() : 0,
    reference: str(data['reference']),
    reason: str(data['reason']),
    employeeId: str(data['employeeId']),
    reversesEventId:
      (data['reversesEventId'] ?? null) === null ? null : str(data['reversesEventId']),
    idempotencyKey: str(data['idempotencyKey']),
  };
}

/**
 * The business, as it stands right now — copied onto the document and never
 * read again.
 *
 * Missing fields come back as empty strings and the renderer omits them. That
 * is deliberate: an absent VAT number must print as nothing, never as a
 * placeholder, and certainly never as an invented registration.
 */
function readBusiness(data: FirebaseFirestore.DocumentData | undefined): BusinessSnapshot {
  const profile = data ?? {};

  return {
    nameEn: str(profile['nameEn']),
    nameAr: str(profile['nameAr']),
    addressEn: str(profile['addressEn']),
    addressAr: str(profile['addressAr']),
    phone: str(profile['phone']),
    whatsapp: str(profile['whatsapp']),
    email: str(profile['email']),
    website: str(profile['website']),
    vatNumber: str(profile['vatNumber']),
    crNumber: str(profile['crNumber']),
    logoPath: str(profile['logoPath']).length > 0 ? str(profile['logoPath']) : null,
  };
}

function readCustomer(data: FirebaseFirestore.DocumentData | undefined): CustomerSnapshot {
  const customer = data ?? {};

  return {
    code: str(customer['code']),
    nameEn: str(customer['nameEn']),
    nameAr: str(customer['nameAr']),
    phone: str(customer['phone']),
    email: str(customer['email']),
    preferredLanguage: str(customer['preferredLanguage']),
  };
}

function readTermsSections(data: FirebaseFirestore.DocumentData | undefined): TermsSection[] {
  const raw = data?.['sections'];
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry): TermsSection[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const section = entry as Record<string, unknown>;

    return [
      {
        key: str(section['key']) as TermsSectionKey,
        titleEn: str(section['titleEn']),
        titleAr: str(section['titleAr']),
        bodyEn: str(section['bodyEn']),
        bodyAr: str(section['bodyAr']),
      },
    ];
  });
}

/* ------------------------------------------------------------------------ *
 * Numbering
 * ------------------------------------------------------------------------ */

/**
 * Invoice numbers come from a **per-year** counter allocated in this
 * transaction.
 *
 * The counter stores the last issued value; the rules assert
 * `current == previous + 1`, which is what makes two simultaneous issues
 * conflict rather than both taking the same number. `array.length + 1` cannot
 * appear here — nothing in this path ever sees a collection.
 *
 * Per year, so the sequence restarts on 1 January with no migration and
 * `INV-2027-0001` follows `INV-2026-0184` naturally.
 */
function commitCounter(
  transaction: Transaction,
  ref: FirebaseFirestore.DocumentReference,
  exists: boolean,
  next: number,
): void {
  if (exists) {
    transaction.update(ref, { current: next, updatedAt: FieldValue.serverTimestamp() });
  } else {
    transaction.set(ref, { current: next, updatedAt: FieldValue.serverTimestamp() });
  }
}

/* ------------------------------------------------------------------------ *
 * issueDocument
 * ------------------------------------------------------------------------ */

interface IssueRequest {
  readonly reservationId?: unknown;
  readonly documentType?: unknown;
  readonly language?: unknown;
  readonly notes?: unknown;
  /** Payment Receipt only: the event being acknowledged. */
  readonly forEventId?: unknown;
  readonly idempotencyKey?: unknown;
}

export interface IssueResult {
  readonly success: boolean;
  readonly documentId: string;
  readonly documentNumber: string;
  readonly duplicate: boolean;
}

function requireKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(value)) {
    throw new HttpsError(
      'invalid-argument',
      'A request key is required so a retry cannot issue the same document twice.',
    );
  }
  return value;
}

function requireReservationId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('/')) {
    throw new HttpsError('invalid-argument', 'A reservation is required.');
  }
  return value;
}

/**
 * Issue a document against a reservation.
 *
 * The whole snapshot — business, customer, dresses, money, terms — is captured
 * inside one transaction, so every part of it describes the same instant. An
 * invoice assembled from several reads could show a balance from before a
 * payment beside a payment list that includes it.
 *
 * Idempotent on the request key, which is the document's id. A retry after a
 * timeout returns the original document rather than issuing a second one and
 * burning a second invoice number.
 */
export const issueDocument = onCall(async (request: CallableRequest<IssueRequest>) => {
  const actor = await requireEmployee(request);
  const data = request.data ?? {};

  const reservationId = requireReservationId(data.reservationId);
  const idempotencyKey = requireKey(data.idempotencyKey);

  if (!isDocumentType(data.documentType)) {
    throw new HttpsError('invalid-argument', 'Choose which document to issue.');
  }
  if (!isDocumentLanguage(data.language)) {
    throw new HttpsError('invalid-argument', 'Choose the document language.');
  }

  const documentType: DocumentType = data.documentType;
  const language: DocumentLanguage = data.language;
  const notes = str(data.notes);
  const forEventId = typeof data.forEventId === 'string' ? data.forEventId : null;

  if (documentType === 'Payment Receipt' && forEventId === null) {
    throw new HttpsError('invalid-argument', 'A receipt must name the payment it acknowledges.');
  }

  return db().runTransaction(async (transaction): Promise<IssueResult> => {
    const documentRef = db().doc(`${INVOICES}/${idempotencyKey}`);
    const existing = await transaction.get(documentRef);

    if (existing.exists) {
      return {
        success: true,
        documentId: documentRef.id,
        documentNumber: str(existing.data()?.['documentNumber']),
        duplicate: true,
      };
    }

    /* --- Read every source, at one instant --- */

    const reservationRef = db().doc(`reservations/${reservationId}`);
    const reservationSnapshot = await transaction.get(reservationRef);

    if (!reservationSnapshot.exists) {
      throw new HttpsError('not-found', 'That reservation no longer exists.');
    }

    const reservation = reservationSnapshot.data() ?? {};
    const customerId = str(reservation['customerId']);

    const [customerSnapshot, businessSnapshot, settingsSnapshot] = await Promise.all([
      transaction.get(db().doc(`customers/${customerId}`)),
      transaction.get(db().doc('businessProfile/main')),
      transaction.get(db().doc('settings/app')),
    ]);

    if (!customerSnapshot.exists) {
      throw new HttpsError('not-found', 'That customer no longer exists.');
    }

    const eventsSnapshot = await transaction.get(
      db().collection(EVENTS).where('reservationId', '==', reservationId),
    );
    const itemsSnapshot = await transaction.get(
      db().collection('reservationItems').where('reservationId', '==', reservationId),
    );

    const events = eventsSnapshot.docs.map((document) => toEvent(document.id, document.data()));
    const pricing = readPricing(reservation);

    /* --- The one financial calculation, from Phase 5 --- */
    const position = reduceLedger(pricing, events);

    /* --- Terms, frozen in full --- */
    const activeTermsId = str(settingsSnapshot.data()?.['activeTermsVersionId']);
    let terms = null;

    if (activeTermsId.length > 0) {
      const termsSnapshot = await transaction.get(db().doc(`termsVersions/${activeTermsId}`));

      if (termsSnapshot.exists) {
        const sections = readTermsSections(termsSnapshot.data());
        const frozen = snapshotTerms(activeTermsId, str(termsSnapshot.data()?.['label']), sections);
        // A version with nothing printable is recorded as absent rather than as
        // a heading with no text under it.
        terms = frozen.sections.length > 0 ? frozen : null;
      }
    }

    /* --- The number --- */
    const issuedAt = Date.now();
    const year = Number(toMuscatDate(issuedAt).slice(0, 4));

    const counterRef = db().doc(`counters/${counterIdFor('invoice', year)}`);
    const counterSnapshot = await transaction.get(counterRef);
    const currentSequence = counterSnapshot.exists
      ? Number(counterSnapshot.data()?.['current'] ?? 0)
      : 0;
    const nextSequence = currentSequence + 1;
    const documentNumber = formatRecordNumber(nextSequence, DEFAULT_NUMBER_FORMATS.invoice, year);

    /* --- Lines --- */

    const dresses: DocumentDressLine[] = itemsSnapshot.docs.map((document) => {
      const item = document.data();
      return {
        dressCode: str(item['dressCode']),
        dressName: str(item['dressName']),
        designer: str(item['designer']),
        rentalPrice: int(item['rentalPriceSnapshot']),
        securityDeposit: int(item['securityDepositSnapshot']),
        photoPath: str(item['dressPhotoPath']).length > 0 ? str(item['dressPhotoPath']) : null,
      };
    });

    const accessories: DocumentAccessoryLine[] = [];
    const alterations: DocumentAlterationLine[] = [];

    /*
     * The event id is carried alongside each line so a receipt can be matched
     * to the payment it acknowledges. Matching by position would be wrong: the
     * lines are re-sorted into date order and no longer correspond to the
     * order the query returned them in.
     */
    const lines = events
      .slice()
      .sort((a, b) => a.occurredAt - b.occurredAt)
      .map((event) => ({
        eventId: event.id,
        line: {
          occurredAt: event.occurredAt,
          kind: event.kind,
          type: event.type,
          method: event.method,
          amount: event.amount,
          signedAmount: signedAmount(event),
          reference: event.reference,
        } satisfies DocumentPaymentLine,
      }));

    const payments: DocumentPaymentLine[] = lines.map((entry) => entry.line);

    const receiptFor =
      forEventId === null
        ? null
        : (lines.find((entry) => entry.eventId === forEventId)?.line ?? null);

    if (documentType === 'Payment Receipt' && receiptFor === null) {
      throw new HttpsError('not-found', 'That payment is not on this reservation.');
    }

    /* --- Write --- */

    const pickupAt = reservation['pickupAt'];
    const returnAt = reservation['returnAt'];

    transaction.create(documentRef, {
      documentType,
      documentNumber,
      sequence: nextSequence,
      year,
      issuedAt: Timestamp.fromMillis(issuedAt),
      language,
      status: 'Issued',

      business: readBusiness(businessSnapshot.data()),
      customer: readCustomer(customerSnapshot.data()),
      customerId,

      reservationId,
      reservationCode: str(reservation['code']),
      eventDate: str(reservation['eventDate']),
      pickupAt: pickupAt instanceof Timestamp ? pickupAt : Timestamp.fromMillis(0),
      returnAt: returnAt instanceof Timestamp ? returnAt : Timestamp.fromMillis(0),

      dresses,
      accessories,
      alterations,

      financials: documentFinancialsFrom(pricing, position),
      payments: payments.map((line) => ({
        ...line,
        occurredAt: Timestamp.fromMillis(line.occurredAt),
      })),

      terms,
      receiptFor:
        receiptFor === null
          ? null
          : { ...receiptFor, occurredAt: Timestamp.fromMillis(receiptFor.occurredAt) },

      notes,
      issuedByName: actor.name,
      issuedByUid: actor.uid,

      voided: false,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,

      createdAt: FieldValue.serverTimestamp(),
      createdBy: actor.uid,
    });

    commitCounter(transaction, counterRef, counterSnapshot.exists, nextSequence);

    writeAudit(transaction, {
      actorUid: actor.uid,
      actorName: actor.name,
      actorRole: actor.role,
      action: 'document.issued',
      entityType: 'reservation',
      entityId: reservationId,
      entityCode: str(reservation['code']),
      before: null,
      after: { documentType, documentNumber, language, grandTotal: pricing.grandTotal },
    });

    return { success: true, documentId: documentRef.id, documentNumber, duplicate: false };
  });
});

/* ------------------------------------------------------------------------ *
 * voidDocument
 * ------------------------------------------------------------------------ */

interface VoidRequest {
  readonly documentId?: unknown;
  readonly reason?: unknown;
}

/**
 * Withdraw an issued document.
 *
 * The document is **not deleted** and its contents are **not altered**. Voiding
 * sets a status and records who did it and why, so the numbering sequence keeps
 * its gap-free meaning and anyone auditing later can see that INV-2026-0007
 * existed and was withdrawn — rather than finding it simply missing, which is
 * indistinguishable from tampering.
 *
 * The financial figures on a voided document stay exactly as issued. Voiding
 * withdraws the document, not the money; reversing a payment is a separate
 * Phase 5 operation with its own record.
 */
export const voidDocument = onCall(async (request: CallableRequest<VoidRequest>) => {
  const actor = await requireOwnerActor(request);
  const data = request.data ?? {};

  if (typeof data.documentId !== 'string' || data.documentId.length === 0) {
    throw new HttpsError('invalid-argument', 'Choose the document to void.');
  }

  const reason = str(data.reason);
  if (reason.trim().length === 0) {
    throw new HttpsError('failed-precondition', 'A reason is required to void a document.');
  }

  const documentId = data.documentId;

  return db().runTransaction(async (transaction) => {
    const ref = db().doc(`${INVOICES}/${documentId}`);
    const snapshot = await transaction.get(ref);

    if (!snapshot.exists) {
      throw new HttpsError('not-found', 'That document no longer exists.');
    }

    const document = snapshot.data() ?? {};

    if (document['status'] === 'Voided') {
      throw new HttpsError('failed-precondition', 'That document has already been voided.');
    }

    transaction.update(ref, {
      status: 'Voided',
      voided: true,
      voidedAt: FieldValue.serverTimestamp(),
      voidedBy: actor.uid,
      voidReason: reason,
    });

    writeAudit(transaction, {
      actorUid: actor.uid,
      actorName: actor.name,
      actorRole: actor.role,
      action: 'document.voided',
      entityType: 'reservation',
      entityId: str(document['reservationId']),
      entityCode: str(document['reservationCode']),
      before: { documentNumber: str(document['documentNumber']), status: 'Issued' },
      after: { status: 'Voided' },
      reason,
    });

    return { success: true, documentNumber: str(document['documentNumber']) };
  });
});

/* ------------------------------------------------------------------------ *
 * recordPrintIntent
 * ------------------------------------------------------------------------ */

interface PrintRequest {
  readonly documentId?: unknown;
}

/**
 * Record that an employee **started** printing a document.
 *
 * Deliberately named for what actually happened. The browser hands the job to
 * the operating system's print dialogue and tells the page nothing afterwards —
 * whether paper came out, whether it was cancelled, whether it went to a PDF
 * instead. Recording "printed" would state something the application cannot
 * know, so the audit says `document.print_initiated`.
 */
export const recordPrintIntent = onCall(async (request: CallableRequest<PrintRequest>) => {
  const actor = await requireEmployee(request);
  const data = request.data ?? {};

  if (typeof data.documentId !== 'string' || data.documentId.length === 0) {
    throw new HttpsError('invalid-argument', 'A document is required.');
  }

  const documentId = data.documentId;

  return db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(db().doc(`${INVOICES}/${documentId}`));

    if (!snapshot.exists) {
      throw new HttpsError('not-found', 'That document no longer exists.');
    }

    const document = snapshot.data() ?? {};

    writeAudit(transaction, {
      actorUid: actor.uid,
      actorName: actor.name,
      actorRole: actor.role,
      action: 'document.print_initiated',
      entityType: 'reservation',
      entityId: str(document['reservationId']),
      entityCode: str(document['reservationCode']),
      before: null,
      after: { documentNumber: str(document['documentNumber']) },
    });

    return { success: true };
  });
});
