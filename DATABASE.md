# Azhary Boutique — Database Design

Cloud Firestore is the **production source of truth**. IndexedDB offline persistence
is a cache. Nothing is stored in `localStorage`. The database is never one JSON blob.

---

## 1. Conventions

### Identifiers

Every document has an auto-generated Firestore document ID. Human-facing codes
(`WD-0001`, `CU-0001`, `RSV-0001`, `INV-2026-0001`) are a **separate indexed field**,
not the document ID. Codes are display and search values; document IDs are references.

This separation matters: if the boutique ever renumbers or changes a prefix, no
foreign key breaks.

### Money

All monetary fields are **integers in baisa** (1 OMR = 1000 baisa). A field named
`rentalPrice` with value `180000` means OMR 180.000.

TypeScript enforces this with a branded type:

```ts
type Baisa = number & { readonly __brand: 'Baisa' };
```

Passing a raw `number` where `Baisa` is expected is a compile error, which prevents
the classic bug of storing 180 (meaning OMR) where 180000 (baisa) was required.

### Time

| Kind                              | Storage                                   | Reason                                                                                                     |
| --------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Instant (pickup, return, created) | Firestore `Timestamp`                     | Ordering, range queries, server clock                                                                      |
| Calendar day (event date)         | `string` `YYYY-MM-DD` **and** `Timestamp` | A wedding on 14 June is that date regardless of timezone; the string is stable, the Timestamp is queryable |
| Duration                          | `number` of days                          | Cleaning buffer, late days                                                                                 |

Timezone for all boutique operations is **Asia/Muscat (UTC+4, no DST)**. The date
string is derived in that zone, so a reservation created at 01:00 Muscat does not
land on the previous day.

`createdAt` / `updatedAt` use `serverTimestamp()`. Client clocks are not trusted for
audit ordering.

### Common fields

Every document carries:

```
createdAt   Timestamp   serverTimestamp()
createdBy   string      uid
updatedAt   Timestamp   serverTimestamp()
updatedBy   string      uid
```

### Soft deletion

Financial and legal records (`payments`, `invoices`, `reservations`, `auditLogs`) are
**never hard-deleted**. They carry `voided: boolean`, `voidedAt`, `voidedBy`,
`voidReason`. Security rules deny `delete` on these collections to every role
including OWNER; voiding is the only path, and it is itself audited.

---

## 2. Collections

```
users/{uid}
businessProfile/main
settings/app
counters/{counterId}
dresses/{dressId}
customers/{customerId}
reservations/{reservationId}
reservationItems/{itemId}
fittings/{fittingId}
accessories/{accessoryId}
payments/{paymentId}
invoices/{invoiceId}
damageLogs/{damageLogId}
waitlist/{waitlistId}
notificationLogs/{notificationLogId}
auditLogs/{auditLogId}
termsVersions/{versionId}
```

---

### 2.1 `users/{uid}`

Document ID **is** the Firebase Auth uid.

| Field       | Type                 | Notes                              |
| ----------- | -------------------- | ---------------------------------- |
| `uid`       | string               | Mirrors document ID                |
| `name`      | string               |                                    |
| `email`     | string               | Mirrors Auth email                 |
| `role`      | `'OWNER' \| 'STAFF'` | **Display mirror only**            |
| `active`    | boolean              | Inactive users are denied by rules |
| `createdAt` | Timestamp            |                                    |

> **The authoritative role is the Firebase Auth custom claim**, not this field.
> Security rules read `request.auth.token.role`. This document exists so the UI can
> list staff without an Admin SDK call. Rules forbid clients from writing `role` or
> `active` — only a Cloud Function may change them. If the two ever disagree, the
> claim wins and the mirror is a display bug, never a privilege escalation.

No password is ever stored here. Firebase Authentication owns credentials.

---

### 2.2 `businessProfile/main`

Single document. **Every field ships blank.** No invented VAT or CR numbers.

| Field                                      | Type                            |
| ------------------------------------------ | ------------------------------- |
| `nameEn`                                   | string — `"Azhary Boutique"`    |
| `nameAr`                                   | string — `"أزهاري بوتيك"`       |
| `logoPath`                                 | string \| null — Storage path   |
| `addressEn` / `addressAr`                  | string                          |
| `phone` / `whatsapp` / `email` / `website` | string                          |
| `vatNumber`                                | string — blank until configured |
| `crNumber`                                 | string — blank until configured |
| `descriptionEn` / `descriptionAr`          | string                          |

Only OWNER may write. Invoices embed a **snapshot** of this document, so later edits
never alter issued invoices.

---

### 2.3 `settings/app`

Single document. OWNER-only writes. Every operational constant lives here — nothing
is hard-coded in the application.

| Field                         | Type                               | Default               | Spec                         |
| ----------------------------- | ---------------------------------- | --------------------- | ---------------------------- |
| `vatRatePercent`              | `0 \| 5`                           | `5`                   | §11                          |
| `vatAppliesToDeposit`         | `false`                            | `false` (constant)    | §11 — deposit is not taxable |
| `currency`                    | `'OMR'`                            | `'OMR'`               | §10                          |
| `currencyDecimals`            | `3`                                | `3`                   | §10                          |
| `minimumPickupPaymentPercent` | number 0–100                       | `100`                 | §23                          |
| `requireDepositBeforePickup`  | boolean                            | `true`                | §23                          |
| `lateFeePerDay`               | Baisa                              | `0` until configured  | §26                          |
| `defaultCleaningBufferDays`   | number                             | `2`                   | §18                          |
| `numbering.dress`             | `{ prefix, padding, separator }`   | `WD`, 4, `-`          | §5                           |
| `numbering.customer`          |                                    | `CU`, 4, `-`          | §5                           |
| `numbering.reservation`       |                                    | `RSV`, 4, `-`         | §5                           |
| `numbering.invoice`           | `{ prefix, padding, includeYear }` | `INV`, 4, true        | §5                           |
| `cancellationTiers`           | array (below)                      | `[]` until configured | §28                          |
| `activeTermsVersionId`        | string \| null                     | `null`                | §33                          |
| `defaultDocumentLanguage`     | `'en' \| 'ar' \| 'bilingual'`      | `'bilingual'`         | §32                          |

`cancellationTiers` entries:

```
{ daysBeforeEvent: number, refundPercent: number, label: { en, ar } }
```

Evaluated most-restrictive-first against `eventDate − cancellationDate`.

---

### 2.4 `counters/{counterId}`

Transaction-safe sequence allocation. **Never `array.length + 1`.**

| Field       | Type                       |
| ----------- | -------------------------- |
| `current`   | number — last issued value |
| `updatedAt` | Timestamp                  |

Documents: `dress`, `customer`, `reservation`, `invoice-2026`, `invoice-2027`, …

Invoice counters are per-year so the sequence resets on 1 January without migration.

**Allocation is always inside the same transaction as the entity write.** A failed
write therefore never burns a number, and two employees creating reservations at the
same instant cannot receive `RSV-0007` twice — the second transaction retries against
the updated counter.

Clients may not write counters directly; rules restrict writes to increments of
exactly one performed alongside the corresponding entity creation, and issuance of
invoice numbers is Cloud-Function-only.

---

### 2.5 `dresses/{dressId}`

| Field                | Type                                                         | Notes                                   |
| -------------------- | ------------------------------------------------------------ | --------------------------------------- |
| `code`               | string                                                       | `WD-0001`, unique, indexed              |
| `name`               | string                                                       |                                         |
| `designer` / `brand` | string                                                       |                                         |
| `size`               | string                                                       |                                         |
| `measurements`       | `{ bust, waist, hips, length }` numbers (cm)                 |                                         |
| `color` / `style`    | string                                                       |                                         |
| `condition`          | `'New' \| 'Excellent' \| 'Good' \| 'Fair' \| 'Needs Repair'` |                                         |
| `purchaseCost`       | Baisa                                                        | OWNER-visible only                      |
| `rentalPrice`        | Baisa                                                        |                                         |
| `salePrice`          | Baisa \| null                                                |                                         |
| `securityDeposit`    | Baisa                                                        |                                         |
| `photos`             | `DressPhoto[]`                                               | see below                               |
| `primaryPhotoId`     | string \| null                                               |                                         |
| `location`           | string                                                       | rail / room                             |
| `cleaningBufferDays` | number                                                       | overrides settings default              |
| `notes`              | string                                                       |                                         |
| `status`             | `DressStatus`                                                | see below                               |
| `searchTokens`       | string[]                                                     | lowercased code/name/designer fragments |

`DressPhoto`:

```
{ id, storagePath, thumbPath, largePath, width, height, contentType, sizeBytes, uploadedAt, uploadedBy }
```

Original aspect ratio is preserved in `width`/`height`; the UI never distorts a dress
image — it letterboxes within a fixed frame.

`DressStatus` (§12):
`Available` · `Reserved` · `Out with Customer` · `In Cleaning` · `In Alteration` ·
`Under Repair` · `Retired`

`In Alteration`, `Under Repair` and `Retired` are **operational blocks**: they prevent
new bookings entirely, independent of date availability (§20).

`purchaseCost` is commercially sensitive. Because Firestore rules cannot hide a single
field, staff-facing reads go through a Cloud Function projection, or the field is
relocated to `dresses/{id}/private/cost` with OWNER-only rules. Phase 3 will
implement the subcollection approach — it is the only one that is genuinely enforced.

---

### 2.6 `customers/{customerId}`

| Field               | Type                                          | Notes                                     |
| ------------------- | --------------------------------------------- | ----------------------------------------- |
| `code`              | string                                        | `CU-0001`                                 |
| `nameEn` / `nameAr` | string                                        |                                           |
| `phone`             | string                                        | E.164, indexed — duplicate warning source |
| `phoneNormalized`   | string                                        | digits only, for duplicate detection      |
| `hasWhatsapp`       | boolean                                       |                                           |
| `email`             | string                                        |                                           |
| `nationalId`        | string                                        | optional                                  |
| `eventDate`         | `YYYY-MM-DD` string + `eventDateTs` Timestamp |                                           |
| `measurements`      | `{ bust, waist, hips, height, shoeSize }`     |                                           |
| `source`            | string                                        | referral / social / walk-in               |
| `notes`             | string                                        |                                           |
| `preferredLanguage` | `'en' \| 'ar' \| 'bilingual'`                 | drives document + WhatsApp language       |
| `searchTokens`      | string[]                                      | includes Arabic name tokens               |

Duplicate phone numbers **warn, never block** — families legitimately share a number.
The warning shows the existing customer so staff can choose.

---

### 2.7 `reservations/{reservationId}`

| Field                              | Type                                                                        | Notes              |
| ---------------------------------- | --------------------------------------------------------------------------- | ------------------ |
| `code`                             | string                                                                      | `RSV-0001`         |
| `customerId`                       | string                                                                      |                    |
| `customerSnapshot`                 | `{ code, nameEn, nameAr, phone, preferredLanguage }`                        | §30                |
| `status`                           | `ReservationStatus`                                                         | below              |
| `eventDate`                        | `YYYY-MM-DD` + Timestamp                                                    |                    |
| `pickupAt` / `returnAt`            | Timestamp                                                                   | scheduled          |
| `actualReturnAt`                   | Timestamp \| null                                                           | §25                |
| `pricing`                          | `PricingSnapshot`                                                           | **immutable**, §30 |
| `deposit`                          | `DepositState`                                                              | §24                |
| `notes`                            | string                                                                      |                    |
| `termsVersionId` + `termsSnapshot` | string + `{ en, ar }`                                                       | §33, immutable     |
| `businessSnapshot`                 | business profile copy                                                       | §30                |
| `invoiceId`                        | string \| null                                                              |                    |
| `cancellation`                     | `{ cancelledAt, cancelledBy, reason, refundPercent, refundAmount } \| null` | §28                |
| `voided`                           | boolean                                                                     |                    |

`ReservationStatus` (§17):

```
Inquiry → Reserved → Fitting Scheduled → Fitted → Picked Up → Returned → Closed
                  ↘ Cancelled
                  ↘ No-Show
```

Transitions are validated by `src/domain/reservation-lifecycle.ts` and re-validated
server-side. Arbitrary jumps (e.g. `Inquiry → Picked Up`) are rejected.

**`Cancelled` and `No-Show` do not block availability** (§18).

`PricingSnapshot` — copied at creation, never recomputed from master data:

```
{
  items:        [{ dressId, dressCode, dressName, rentalPrice, securityDeposit }],
  accessories:  [{ accessoryId, name, unitPrice, quantity, lineTotal }],
  alterations:  [{ description, amount }],
  discount:     { type: 'amount' | 'percent', value, amount },
  subtotal:            Baisa,   // taxable base, excludes deposit
  vatRatePercent:      number,  // rate in force at creation
  vatAmount:           Baisa,
  securityDepositTotal:Baisa,   // NOT VAT taxable (§11)
  grandTotal:          Baisa    // subtotal + vat + deposit
}
```

`DepositState` (§24):

```
{
  originalAmount, refundedAmount, forfeitedAmount: Baisa,
  status: 'Held' | 'Refunded' | 'Partially Refunded' | 'Forfeited',
  reason: string, decidedAt: Timestamp | null, decidedBy: string | null
}
```

Invariant, enforced in domain, service and rules:
`refundedAmount + forfeitedAmount ≤ originalAmount`.

---

### 2.8 `reservationItems/{itemId}`

One document per dress per reservation. Top-level (not a subcollection) because
availability is queried **across all reservations for one dress** — the single most
performance-critical query in the system.

| Field                                 | Type           | Notes                                                    |
| ------------------------------------- | -------------- | -------------------------------------------------------- |
| `reservationId`                       | string         |                                                          |
| `reservationCode`                     | string         | display without a join                                   |
| `dressId` / `dressCode` / `dressName` | string         |                                                          |
| `dressPhotoPath`                      | string \| null |                                                          |
| `pickupAt` / `returnAt`               | Timestamp      |                                                          |
| `cleaningBufferDays`                  | number         | copied from dress at creation                            |
| `blockStartAt`                        | Timestamp      | `= pickupAt`                                             |
| `blockEndAt`                          | Timestamp      | `= returnAt + cleaningBufferDays`                        |
| `blocking`                            | boolean        | `false` when reservation is Cancelled / No-Show / voided |
| `rentalPriceSnapshot`                 | Baisa          |                                                          |

**`blockStartAt` / `blockEndAt` are stored, not computed at query time.** Firestore
cannot filter on a derived expression, so the blocked interval — pickup through
return **plus cleaning buffer** (§18) — is materialised on write and recomputed
whenever dates or buffer change.

Availability query (§18):

```
reservationItems
  where dressId   == :dressId
  where blocking  == true
  where blockEndAt > :requestedStart
```

then filter `blockStartAt < requestedEnd` in memory. A single inequality keeps the
index simple; the candidate set is small (future bookings for one dress).

Two intervals overlap when `aStart < bEnd && bStart < aEnd`. Half-open intervals mean
a dress returning and being collected at the same instant does **not** collide — which
is correct only because the cleaning buffer already separates them.

---

### 2.9 `fittings/{fittingId}`

| Field                               | Type                                                          |
| ----------------------------------- | ------------------------------------------------------------- |
| `reservationId` / `reservationCode` | string                                                        |
| `customerId` / `customerName`       | string                                                        |
| `dressIds`                          | string[]                                                      |
| `scheduledAt`                       | Timestamp                                                     |
| `durationMinutes`                   | number                                                        |
| `status`                            | `Scheduled \| Confirmed \| Completed \| Cancelled \| No-Show` |
| `notes`                             | string                                                        |
| `employeeId`                        | string                                                        |

Indexed on `scheduledAt` for the in-app calendar (§21).

---

### 2.10 `accessories/{accessoryId}`

Master catalogue: veils, tiaras, jewellery.

| Field                                 | Type           |
| ------------------------------------- | -------------- |
| `name` / `nameAr`                     | string         |
| `sku`                                 | string         |
| `rentalPrice`                         | Baisa          |
| `securityDeposit`                     | Baisa          |
| `quantityTotal` / `quantityAvailable` | number         |
| `photoPath`                           | string \| null |
| `active`                              | boolean        |

Reservations snapshot accessory lines; editing the catalogue never alters history.

---

### 2.11 `payments/{paymentId}`

Append-only ledger (§22). Corrections are made by adding a reversing entry, never by
editing or deleting — this is what makes the ledger trustworthy.

| Field                                | Type                                                                                                               | Notes                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `reservationId` / `reservationCode`  | string                                                                                                             |                                                   |
| `customerId`                         | string                                                                                                             |                                                   |
| `amount`                             | Baisa                                                                                                              | positive; refunds use `type: 'Refund'`            |
| `method`                             | `'Cash' \| 'Card' \| 'Bank Transfer'`                                                                              | §22                                               |
| `type`                               | `'Deposit' \| 'Installment' \| 'Final Payment' \| 'Security Deposit' \| 'Refund' \| 'Late Fee' \| 'Damage Charge'` |                                                   |
| `paidAt`                             | Timestamp                                                                                                          | may be backdated by staff                         |
| `reference`                          | string                                                                                                             | receipt / transfer ref                            |
| `employeeId`                         | string                                                                                                             |                                                   |
| `idempotencyKey`                     | string                                                                                                             | **unique**, prevents double submission (§22, §54) |
| `voided` / `voidedBy` / `voidReason` |                                                                                                                    |                                                   |
| `createdAt`                          | Timestamp                                                                                                          | server clock                                      |

`idempotencyKey` is generated when the payment form opens. A double click, a retry
after a timeout, or a duplicate offline replay all carry the same key, and the
transaction aborts if a payment with that key exists. This is the only reliable
defence — disabling the button is UX, not a guarantee.

`type: 'Security Deposit'` payments are excluded from the VAT-taxable base and from
the "eligible balance" used for the pickup threshold (§23).

---

### 2.12 `invoices/{invoiceId}`

| Field                                       | Type                                          |
| ------------------------------------------- | --------------------------------------------- |
| `number`                                    | string — `INV-2026-0001`                      |
| `year`                                      | number                                        |
| `reservationId` / `reservationCode`         | string                                        |
| `customerSnapshot` / `businessSnapshot`     | object                                        |
| `lines`                                     | `InvoiceLine[]`                               |
| `subtotal` / `vatRatePercent` / `vatAmount` | Baisa / number / Baisa                        |
| `securityDepositTotal`                      | Baisa — shown separately, **not** VAT taxable |
| `grandTotal` / `amountPaid` / `balance`     | Baisa                                         |
| `termsSnapshot`                             | `{ en, ar }`                                  |
| `issuedAt` / `issuedBy`                     | Timestamp / string                            |
| `language`                                  | `'en' \| 'ar' \| 'bilingual'`                 |
| `voided` / `voidReason`                     |                                               |

Fully self-contained: an invoice renders correctly even if the dress, customer and
VAT rate all change afterwards. **Changing the VAT setting never alters an issued
invoice** (§11) because the rate and amount are stored, not referenced.

Issuing is a Cloud Function (number allocation + immutability), and rules deny
`update` and `delete` to all roles.

---

### 2.13 `damageLogs/{damageLogId}`

| Field                   | Type                                                 |
| ----------------------- | ---------------------------------------------------- |
| `dressId` / `dressCode` | string                                               |
| `reservationId`         | string \| null                                       |
| `occurredAt`            | Timestamp                                            |
| `description`           | string                                               |
| `severity`              | `'Minor' \| 'Moderate' \| 'Severe' \| 'Irreparable'` |
| `repairCost`            | Baisa                                                |
| `chargedToCustomer`     | Baisa                                                |
| `photoPaths`            | string[]                                             |
| `employeeId`            | string                                               |
| `depositAction`         | `'None' \| 'Partial Forfeit' \| 'Full Forfeit'`      |

---

### 2.14 `waitlist/{waitlistId}`

| Field                                           | Type                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `customerId` / `customerName` / `customerPhone` | string                                                               |
| `dressId` / `dressCode`                         | string                                                               |
| `requestedStartAt` / `requestedEndAt`           | Timestamp                                                            |
| `status`                                        | `'Waiting' \| 'Notified' \| 'Converted' \| 'Expired' \| 'Cancelled'` |
| `notifiedAt`                                    | Timestamp \| null                                                    |
| `createdAt`                                     | Timestamp                                                            |

When a blocking `reservationItem` becomes non-blocking (cancellation, no-show, date
change), a Cloud Function matches overlapping `Waiting` entries and creates
notification records (§29).

---

### 2.15 `notificationLogs/{notificationLogId}`

WhatsApp V1 is click-to-chat (§34). The system **never claims delivery**.

| Field                          | Type                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customerId` / `reservationId` | string                                                                                                                                                          |
| `template`                     | `'reservation_confirmation' \| 'fitting_reminder' \| 'pickup_reminder' \| 'return_reminder' \| 'overdue' \| 'balance_due' \| 'deposit' \| 'waitlist_available'` |
| `channel`                      | `'whatsapp'`                                                                                                                                                    |
| `language`                     | `'en' \| 'ar'`                                                                                                                                                  |
| `messageBody`                  | string — exact text prepared                                                                                                                                    |
| `preparedAt` / `preparedBy`    | Timestamp / string                                                                                                                                              |
| `openedAt`                     | Timestamp \| null                                                                                                                                               |
| `employeeId`                   | string                                                                                                                                                          |

States are **Prepared** and **Opened** only. `openedAt` records that the employee
opened the `wa.me` link — not that WhatsApp delivered anything. No `sent`, no
`delivered`, no `read`.

---

### 2.16 `auditLogs/{auditLogId}`

Append-only. No role may update or delete (§50).

| Field                                    | Type                                                      |
| ---------------------------------------- | --------------------------------------------------------- |
| `actorUid` / `actorName` / `actorRole`   | string                                                    |
| `at`                                     | Timestamp — `serverTimestamp()`                           |
| `action`                                 | e.g. `reservation.status_changed`, `settings.vat_changed` |
| `entityType` / `entityId` / `entityCode` | string                                                    |
| `before` / `after`                       | object \| null — changed fields only                      |
| `context`                                | `{ reason?, ip?, userAgent? }`                            |

Tracked: reservations, payments, cancellations, deposit decisions, price changes,
T&C changes, settings changes, user role changes, voids.

`before`/`after` store only changed fields — a full document copy per edit would grow
without bound and bury the actual change.

---

### 2.17 `termsVersions/{versionId}`

| Field               | Type                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `version`           | number — monotonic                                                                                                 |
| `bodyEn` / `bodyAr` | string                                                                                                             |
| `sections`          | `{ damageAndLoss, lateFees, cancellationRefund, alterations, securityDeposit, hygieneCleaning }` each `{ en, ar }` |
| `effectiveFrom`     | Timestamp                                                                                                          |
| `createdBy`         | string                                                                                                             |
| `active`            | boolean                                                                                                            |

Immutable once created — a new version is added rather than an existing one edited,
because reservations reference versions by ID and their snapshots must stay truthful.
OWNER-only (§6).

---

## 3. Indexes

Composite indexes required (`firestore.indexes.json`):

| Collection         | Fields                                          |
| ------------------ | ----------------------------------------------- |
| `reservationItems` | `dressId` ASC, `blocking` ASC, `blockEndAt` ASC |
| `reservations`     | `status` ASC, `pickupAt` ASC                    |
| `reservations`     | `status` ASC, `returnAt` ASC                    |
| `reservations`     | `customerId` ASC, `createdAt` DESC              |
| `fittings`         | `status` ASC, `scheduledAt` ASC                 |
| `payments`         | `reservationId` ASC, `paidAt` DESC              |
| `invoices`         | `year` DESC, `number` DESC                      |
| `waitlist`         | `dressId` ASC, `status` ASC                     |
| `auditLogs`        | `entityType` ASC, `entityId` ASC, `at` DESC     |
| `dresses`          | `status` ASC, `code` ASC                        |

Single-field indexes on `code`, `phoneNormalized` and `searchTokens` (array-contains)
serve global search (§43).

---

## 4. Search

Firestore has no full-text search. Global search (§43) uses `searchTokens`: a
lowercased, de-duplicated array of prefix fragments generated on write from code,
name, Arabic name and phone. `array-contains` on a normalised query token gives fast
exact-prefix matching across dresses, customers, reservations and invoices without an
external service.

This handles the boutique's real search behaviour — staff type a code, a phone number,
or the start of a name. If fuzzy or full-text search is needed later, the write path
is already centralised and could feed an external index without touching callers.

---

## 5. Storage layout

```
/business/logo/{filename}
/dresses/{dressId}/original/{photoId}.{ext}
/dresses/{dressId}/large/{photoId}.webp
/dresses/{dressId}/thumb/{photoId}.webp
/damage/{damageLogId}/{photoId}.{ext}
```

Firestore stores paths and metadata; Storage stores bytes. Rules validate content
type, size and role on every path (§57, see SECURITY.md).

---

## 6. What is deliberately absent

- **No `demo` or `sample` documents.** Production starts empty (§51).
- **No `passwords` collection.** Firebase Auth owns credentials (§8).
- **No hard-coded owner account.** First-owner setup is a guarded flow (§8).
- **No placeholder VAT or CR numbers.** Blank until configured (§9).
- **No aggregate/KPI documents yet.** Dashboard figures are computed from real data;
  fabricated KPI counters would be exactly the fake dashboard the spec forbids.
  If read volume later justifies aggregation, counters will be maintained by Cloud
  Functions from real writes.
