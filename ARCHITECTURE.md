# Azhary Boutique — Architecture

---

## 1. Layers

```
┌─────────────────────────────────────────────────────────────┐
│  UI                                                          │
│  src/app · src/pages · src/components · src/design-system    │
│  Renders state. Dispatches intent. No business rules.        │
└───────────────────────────┬─────────────────────────────────┘
                            │ hooks (TanStack Query)
┌───────────────────────────▼─────────────────────────────────┐
│  Application / Service Layer                                 │
│  src/services                                                │
│  Orchestrates: reads, writes, transactions, permissions,     │
│  audit, side effects. Knows Firebase. Knows the domain.      │
└──────────┬────────────────────────────────┬─────────────────┘
           │                                │
┌──────────▼──────────────────┐  ┌──────────▼─────────────────┐
│  Domain (pure)               │  │  Firebase SDK / Functions  │
│  src/domain                  │  │  src/lib/firebase          │
│  Zero I/O. Zero Firebase.    │  │  functions/                │
│  Deterministic. Unit-tested. │  └──────────┬─────────────────┘
└──────────────────────────────┘             │
                            ┌────────────────▼─────────────────┐
                            │  Firestore · Storage · Auth      │
                            └──────────────────────────────────┘
```

### The rule that matters most

**A React component never contains a business rule.**

If a component computes a total, decides whether pickup is allowed, or works out
whether two date ranges overlap, that is a defect. It calls a service; the service
calls the domain.

Enforced mechanically: ESLint forbids importing `firebase/*` from
`src/components/**` and `src/pages/**`, and forbids `src/domain/**` from importing
anything under `src/services`, `src/lib/firebase`, or `react`.

---

## 2. Directory layout

```
azhary-boutique/
├── src/
│   ├── app/                    # Shell: router, providers, error boundaries, layout
│   ├── design-system/          # Tokens + primitives (Button, Input, Dialog, …)
│   ├── components/             # Shared composite components (non-feature-specific)
│   ├── pages/                  # Route-level screens, grouped by feature
│   │   ├── dashboard/
│   │   ├── dresses/
│   │   ├── customers/
│   │   ├── reservations/
│   │   ├── payments/
│   │   ├── invoices/
│   │   ├── reports/
│   │   └── settings/
│   ├── services/               # Application layer — one module per capability
│   │   ├── auth.service.ts
│   │   ├── users.service.ts
│   │   ├── dresses.service.ts
│   │   ├── customers.service.ts
│   │   ├── photos.service.ts
│   │   ├── reservations.service.ts   # reads direct; writes via Cloud Functions
│   │   ├── fittings.service.ts       # fittings + waitlist (ordinary writes)
│   │   ├── audit.service.ts
│   │   └── write.ts                  # synced / pending / failed outcomes
│   ├── domain/                 # Pure business logic — the testable core
│   │   ├── money.ts            # Baisa arithmetic, rounding, formatting
│   │   ├── datetime.ts         # Asia/Muscat wall time ↔ instants
│   │   ├── availability.ts     # Interval overlap + cleaning buffer
│   │   ├── reservation.ts      # Transition table + date validation
│   │   ├── reservation-pricing.ts
│   │   ├── similar-dresses.ts  # Alternatives when a gown is taken
│   │   ├── authorization.ts
│   │   ├── dress.ts · customer.ts · phone.ts · search.ts
│   │   └── (payments, late fees, cancellation — Phase 5)
│   ├── schemas/                # Zod schemas — validation + inferred types
│   ├── types/                  # Shared domain types, branded primitives
│   ├── hooks/                  # Cross-cutting React hooks
│   ├── stores/                 # Zustand: auth session, UI preferences
│   ├── lib/
│   │   ├── firebase/           # SDK init, typed converters, collection refs
│   │   ├── datetime/           # Timezone-safe date helpers
│   │   ├── i18n/               # Typed translation system, EN/AR dictionaries
│   │   └── utils/
│   ├── config/                 # Env parsing + runtime validation, constants
│   └── print/                  # A4 document components (invoice, contract)
├── functions/                  # Cloud Functions (Phase 2+)
├── tests/                      # Integration + security-rules tests
├── scripts/                    # seed:demo, backup, migrations
├── firestore.rules
├── storage.rules
├── firestore.indexes.json
├── firebase.json
└── docs (README, ARCHITECTURE, DATABASE, SECURITY, TESTING, DEPLOYMENT, OPERATIONS)
```

---

## 3. The domain layer

Pure functions over plain data. No `Date.now()` inside them — the current time is
always a parameter, which is what makes them testable without clock mocking.

```ts
// src/domain/availability.ts  (as implemented in Phase 4)
export function blockedInterval(
  pickupAt: EpochMs,
  returnAt: EpochMs,
  cleaningBufferDays: number,
): Interval;

export function overlaps(a: Interval, b: Interval): boolean;

export function findConflict(
  request: AvailabilityRequest,
  existing: readonly ExistingBlock[],
): DressConflict | null;

export function nextAvailableFrom(
  notBefore: EpochMs,
  durationMs: number,
  cleaningBufferDays: number,
  existing: readonly ExistingBlock[],
): EpochMs | null;
```

Each domain module has a matching `*.test.ts` covering the boundary cases named in
the specification: exact overlap, start overlap, end overlap, nested overlap and
cleaning-buffer overlap.

`findConflict` returns the conflict rather than a boolean. "Unavailable" is not
an answer an employee can act on; the returned value names the reservation
holding the gown, the instant it comes free, and whether the obstacle is another
booking or the cleaning buffer — which are different conversations to have with
a customer.

---

## 3a. The reservation engine

The most safety-critical logic in the platform. Documented here in full because
its correctness rests on choices that look arbitrary until the failure they
prevent is named.

### The blocked interval

A booking blocks a dress over the **half-open** interval

```
[pickupAt, returnAt + cleaningBufferDays)
```

Half-open is what makes back-to-back bookings possible: a gown returned at 11:00
on the 12th with a 3-day buffer is free at exactly 11:00 on the 15th, and not a
moment earlier. A closed interval would waste a day per rental; an open one would
double-book the boundary.

Overlap is the symmetric test:

```ts
aStart < bEnd && bStart < aEnd;
```

The default cleaning buffer is **3 days**, overridable per dress — an
embroidered gown may need a week, and `cleaningBufferDays` on the dress wins over
the setting.

### Which statuses block

`Reserved`, `Fitting Scheduled`, `Fitted`, `Picked Up`, `Returned` and `Closed`
all hold the dress. `Returned` and `Closed` still block because the cleaning
buffer runs past the return date; the interval, not the status, decides when the
hold ends.

`Inquiry` deliberately does **not** block. An enquiry is a conversation, and
letting one take a gown off the market would let an idle browser deprive a paying
customer.

### Why booking is a Cloud Function

Creating a reservation means checking availability and writing atomically. That
requires reading a **query** inside a transaction, which the client SDK cannot
do. A browser-side check followed by a write is a time-of-check/time-of-use race:
two employees looking at the same free gown both see it free.

So `createReservation`, `updateReservationDates` and `changeReservationStatus`
are Cloud Functions running with the Admin SDK, and `firestore.rules` closes the
client write path entirely (`allow create: if false`). The Function is not the
convenient path; it is the only one.

### The phantom-read defence

This is the subtle part. A Firestore transaction locks the documents a query
**returns** — not the absence of documents. Two concurrent first-ever bookings of
the same dress each run a query that returns nothing, each see the gown as free,
and both commit. Neither transaction conflicts with the other, because they
touched no common document.

The fix is to give them one. Every booking transaction **reads and writes the
dress document itself**, incrementing a `bookingVersion` counter. Two bookings of
the same gown now contend on a real document, the transaction layer sees a
write-write conflict, and exactly one survives.

Proved rather than asserted: eight simultaneous bookings of one dress leave one
winner, seven structured conflicts, one blocking item, and no burned reservation
number.

### Retries

Firestore reports a contended counter refusal as `permission-denied` rather than
`aborted`, and the SDK does not retry `permission-denied`. Without intervention,
losers of a counter race fail permanently instead of retrying and succeeding.
`commitTransactionWithRetry` restores the intended behaviour with bounded,
randomised backoff.

### Offline

Reservations cannot be created offline, deliberately. Availability can only be
judged against current server state, so a queued booking could commit against
stale data and double-book a gown. The attempt fails with a clear message and
**nothing is queued** — unlike ordinary edits, which sync when the connection
returns.

### Timezone

All wall-clock input is interpreted in `Asia/Muscat`, a fixed UTC+04:00 with no
DST. `fromMuscatWallTime` parses deliberately rather than calling
`new Date(string)`, whose behaviour depends on the host's zone.

### Why time is a parameter

Late fees, cancellation tiers and overdue alerts all depend on "now". Passing `now`
explicitly means a test can assert the fee three days late without freezing the
system clock, and means the same function can be reused server-side in Cloud
Functions where the trusted clock differs from the browser's.

---

## 3b. The financial engine

The highest-risk logic in the platform, and the one place where being merely
plausible is not good enough: an arithmetic mistake here is a customer charged
twice, and a design mistake is a record nobody can audit.

### One calculation, everywhere

`reduceLedger(pricing, events)` is the **single authoritative financial
calculation**. The reservation screen, the payment dialog, the Cloud Functions
and — in Phase 6 — the invoice all call it. There is deliberately no second
implementation of any balance formula, because two eventually disagree and the
copy on the invoice is the one the customer keeps.

### A balance is derived, never stored

Nothing stores `outstanding`. It is a reduction over every event posted against
a reservation, computed on demand. A stored balance is a cache that goes stale
the moment an event is appended, and a stale balance is how a customer gets
asked to pay twice.

### Append-only, with reversals instead of edits

Financial history is never destroyed and never edited. A mistake is corrected by
appending an event that offsets it, leaving **both** visible, so the record
answers "what happened" and not merely "what do we currently believe".

Phase 2 modelled corrections as a `voided` flag on a payment. Phase 5 replaced
it: setting a flag mutates a posted entry, and a ledger whose entries can be
amended is not a ledger. The owner is exactly the person whose amendments most
need to leave a trace.

| Kind                        | Effect                                                                      |
| --------------------------- | --------------------------------------------------------------------------- |
| `Payment`                   | Money in, rental account                                                    |
| `PaymentReversal`           | Cancels a payment that should never have been recorded — **no money moves** |
| `Refund`                    | Money out, rental account                                                   |
| `SecurityDepositPayment`    | Money in, deposit account                                                   |
| `SecurityDepositRefund`     | Deposit returned                                                            |
| `SecurityDepositForfeiture` | Deposit kept against damage, with a reason                                  |
| `LateFee`                   | Charge added                                                                |
| `ChargeWaiver`              | Charge removed — cancellation relief                                        |

Every event carries a **positive** amount; the kind decides the direction.
A signed amount would turn a mistyped minus into a silent reversal, and would
let "greater than zero" pass on a value that takes money out of the till.

### Two accounts, never mixed

The rental account and the security deposit are tracked separately. A deposit is
the customer's money held against damage: not revenue, not VAT-taxable, and
never consumed to make a rental balance look settled. A bride who has paid a
deposit and nothing else owes the full rental, and `pickupEligibility` says so —
the deposit does not count toward the collection threshold.

```
totalChargeable = agreedCharges + lateFees − waivers      (floored at zero)
netPaid         = payments − reversals − refunds
outstanding     = max(0, totalChargeable − netPaid)
refundable      = max(0, netPaid − totalChargeable)

depositHeld     = depositPaid − depositRefunded − depositForfeited
```

`outstanding` and `refundable` are mutually exclusive by construction, and
`reconcile()` asserts it.

### VAT

```
taxableSubtotal = rentals + accessories + alterations − discount
vatAmount       = round(taxableSubtotal × rate)
grandTotal      = taxableSubtotal + vatAmount + securityDeposit
```

The discount is applied **before** VAT — taxing money the customer never paid
would be wrong — and the deposit sits outside the tax base entirely. VAT is
rounded **once**, on the discounted base, half away from zero. Rounding each
line and summing accumulates error, which is how a VAT total ends up disagreeing
with the sum of its own lines.

Permitted rates are 0% and 5%, enforced in `firestore.rules` as well as in the
domain: a wrong rate on an issued invoice is a matter for the tax authority.

Rate, taxable base and VAT amount are **frozen onto the reservation** at
creation. Changing the setting later cannot reach back into an agreed price.

### Concurrency — the same problem, the same answer

Whether a payment is permitted depends on the balance, and the balance is a
query read followed by a write. The client SDK cannot do that inside a
transaction, so every financial write is a Cloud Function.

And, as with booking, the transactional query is not enough on its own: it locks
the documents it **returns**, not their absence. Two simultaneous payments
against a reservation with no events both read an empty list, both conclude the
full balance is outstanding, and both commit without ever conflicting.

So every financial transaction **reads and writes the reservation document**,
incrementing `financialVersion`. Concurrent financial work on one reservation
becomes a write-write conflict; the loser retries, re-reads the ledger, and is
judged against the true balance. Work on different reservations runs in parallel.

### Idempotency is structural

The client generates a key when the form opens, and that key **is** the event's
document id. A duplicate submission is therefore not a race to detect — it is a
document that already exists. The transaction reads it first and returns the
original outcome without posting anything.

Generating the key at submission time would give every retry its own key and
defeat the whole mechanism. Disabling the button is UX; this is the guarantee.

### Separation of duties

Staff record money coming in — that is the job, and refusing it would stop the
shop working. Money going **out**, and any correction to posted history, needs
the owner: refunds, reversals, forfeitures, and applying a cancellation. Those
are the operations that could conceal a shortfall.

Enforced in the Functions, not merely hidden in the interface.

### Cancellation

Tiers are configured, never hard-coded — the percentages are the boutique's
commercial decision. Notice is measured in **calendar days in Muscat**, so a
call at 23:00 and one at 08:00 the same morning get the same answer; measuring
elapsed hours would make the refund depend on the time of the telephone call.

Cancelling posts a `ChargeWaiver` for the relieved share. It does **not** pay
the refund: money leaving the till is a separate, deliberate act with its own
method and reference, recorded when it actually happens. After the waiver, what
the customer owes is exactly the cancellation charge and the refundable amount
falls out of the ordinary balance arithmetic rather than being computed a second
way.

### Late fees

`lateDays × dailyRate`, with days rounded **up** — a gown eleven hours overdue
has cost the boutique the day either way. The rate, the day count and the
instants it was computed between are frozen onto the event, so raising the rate
next month cannot re-price a fee already agreed. Charged once per reservation.

---

## 4. The service layer

Services are the only place that:

- reads or writes Firestore,
- opens transactions,
- writes audit records,
- enforces role permissions in the client (as UX; the rules enforce them for real).

A representative write path:

```
UI action
  → service method
      → validate input with Zod schema
      → check caller role
      → run Firestore transaction
          → re-read current state inside the transaction
          → call pure domain function to decide
          → write entity + counter + audit record atomically
      → return typed Result
  → hook surfaces loading / success / failure to the UI
```

**Transactions re-read inside the transaction.** Availability computed from a cached
snapshot is not a safety property. Reservation creation reads the dress's live
blocking intervals inside the transaction and aborts if they changed. This is what
prevents two employees double-booking one dress (§19 of the specification).

---

## 5. Data flow and caching

- **TanStack Query** owns server state. Query keys are structured
  (`['reservations', { status, dateRange }]`) so invalidation is precise.
- **Firestore listeners** feed Query's cache for live operational screens
  (today's pickups, returns, fittings). Everything else uses one-shot reads.
- **Zustand** holds only session and UI preference state: current user, role,
  language, direction, sidebar state. Never business data.
- **Firestore offline persistence** (IndexedDB, multi-tab) is the offline cache.
  It is a cache. The application never treats it as the record of truth, and never
  reports a write as successful until the server acknowledges it.

### Record creation requires a connection

Firestore **transactions have no offline mode** — they need a round trip to read
current state. Creating a dress or customer allocates a code from a counter
inside a transaction, so it genuinely cannot happen offline, and the interface
says so rather than queueing a write that would hand out a duplicate code.

Edits are ordinary writes: they apply to the local cache immediately and sync
when the connection returns.

Under contention the counter rule refuses a stale increment as
`permission-denied` rather than `aborted`, which the SDK does not retry. The
service layer retries it with randomised backoff — see
`commitTransactionWithRetry` in `src/services/write.ts`, which documents the
behaviour and the emulator evidence for it.

### Write acknowledgement

Firestore resolves a write promise optimistically while offline. Reporting "Saved"
at that point would be a lie the specification explicitly forbids. Writes therefore
surface three states:

| State   | Meaning                                | UI                           |
| ------- | -------------------------------------- | ---------------------------- |
| Pending | Written locally, not yet acknowledged  | "Saving…" / queued indicator |
| Synced  | Server acknowledged                    | "Saved"                      |
| Failed  | Rejected (rules, validation, conflict) | Error, form data preserved   |

Server acknowledgement is detected via snapshot metadata
(`hasPendingWrites === false`), not via promise resolution.

---

## 6. Numbering

Human-facing identifiers are generated through Firestore transactions against the
`counters` collection, never from `array.length`.

| Entity      | Format          | Counter document                   |
| ----------- | --------------- | ---------------------------------- |
| Dress       | `WD-0001`       | `counters/dress`                   |
| Customer    | `CU-0001`       | `counters/customer`                |
| Reservation | `RSV-0001`      | `counters/reservation`             |
| Invoice     | `INV-2026-0001` | `counters/invoice-2026` (per year) |

Prefixes and padding are configurable in Settings. The counter increment happens in
the **same transaction** as the entity write, so a failed write never consumes a
number and two concurrent writers never receive the same one.

Invoice counters are per-year documents so the sequence resets on 1 January without
a migration.

---

## 7. Immutable snapshots

Historical documents must not change when master data changes. At reservation
creation, and again at invoice issue, the system copies rather than references:

- rental price, security deposit, accessory prices, alteration charges, discount
- VAT rate and computed VAT amount, taxable subtotal
- business profile (name, VAT number, CR, address, logo reference)
- customer name and contact details as they stood
- dress code, name, designer and primary photo reference
- Terms & Conditions version id and full text (EN + AR)

Editing a dress's rental price tomorrow changes no invoice issued today. This is a
legal and accounting requirement, not a convenience.

---

## 8. Security model

Authorisation is enforced in **Firestore Security Rules and Cloud Functions**, not in
the UI. Hidden buttons are a usability affordance with no security value.

- Roles are confirmed by **two independent sources**: the Firebase Auth custom
  claim (`{ role, active }`, writable only by a Cloud Function) and the
  `users/{uid}` document (writable by no client at all). The **lower** of the two
  roles wins, so a demotion applies immediately while a promotion waits for the
  token to refresh. `active` is read live from Firestore, which is what makes
  deactivation take effect on the employee's next request rather than when their
  ID token expires — up to an hour later.
- Operations that must not be client-trusted run as Cloud Functions with the Admin
  SDK: role assignment, invoice issuing, deposit forfeiture, financial deletion.
- Storage rules validate content type, size and path ownership.

Full matrix: [SECURITY.md](./SECURITY.md).

---

## 9. Internationalisation

- A typed dictionary keyed by literal union; a missing key is a **compile error**,
  not a runtime fallback to English.
- `dir` is set on `<html>` and drives layout via CSS logical properties
  (`margin-inline-start`, not `margin-left`). This removes the need for mirrored
  stylesheets.
- Numbers, currency and dates format through `Intl` with the active locale, with
  Western-Arabic digits retained for financial figures so amounts are unambiguous.
- Documents render in English, Arabic or bilingual, independently of the UI language,
  because a customer's preferred document language differs from the employee's UI.

---

## 10. Printing and A4 documents

Documents render as dedicated React components under `src/print/`, not as a styled
copy of a screen. A print stylesheet sets `@page { size: A4; margin: … }` and hides
all application chrome.

Multi-page flow is handled with CSS fragmentation (`break-inside: avoid` on rows and
signature blocks, repeated `<thead>` on long tables) so that a long reservation never
clips content, splits a table row, or orphans a signature.

The browser's own print pipeline is used deliberately: it shapes Arabic text and
handles RTL correctly, which client-side PDF generators generally do not.

---

## 11. Error handling

Every mutation exposes loading, success and failure. Beyond that:

- Failure preserves form input. Users never retype a reservation.
- Submit buttons are disabled while in flight and mutations are idempotency-guarded,
  so a double click cannot create two payments.
- Errors are typed (`AppError` with a code), so the UI can show an actionable
  message rather than a raw Firebase string.
- A route-level error boundary catches render failures without blanking the app.

---

## 12. Testing strategy

| Layer       | Tool                                      | What it proves                                                    |
| ----------- | ----------------------------------------- | ----------------------------------------------------------------- |
| Domain      | Vitest                                    | Pricing, VAT, availability, buffers, fees, numbering are correct  |
| Services    | Vitest + Firestore emulator               | Transactions, concurrency, audit writes                           |
| Rules       | Emulator + `@firebase/rules-unit-testing` | Each role can do exactly what it should                           |
| Components  | Testing Library                           | States render, errors surface, forms preserve input               |
| Integration | Emulator                                  | Create dress → customer → reservation → payment → pickup → return |

Detail: [TESTING.md](./TESTING.md).

---

## 13. Decisions and trade-offs

| Decision                     | Alternative rejected           | Reason                                                                |
| ---------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| Integer baisa for money      | `number` in OMR                | Floating-point drift in invoice totals is unacceptable                |
| Pure domain, no Firebase     | Logic inside services only     | Exhaustive testing of edge cases without emulator overhead            |
| Custom i18n                  | i18next                        | Compile-time key safety; smaller bundle; no unused machinery          |
| Browser print                | jsPDF / pdfmake                | Correct Arabic shaping and RTL; no font embedding burden              |
| Custom design system         | MUI / Chakra                   | A luxury bridal brand must not look like a default kit                |
| Custom claims for roles      | Firestore role lookup in rules | No extra read per rule evaluation; claim is tamper-proof              |
| Per-year invoice counters    | Single counter + filtering     | Sequence resets on 1 Jan with no migration                            |
| Vite SPA                     | Next.js                        | No public SEO surface; static hosting is simpler and cheaper          |
| Booking via Cloud Function   | Client transaction             | The client SDK cannot read a query inside a transaction               |
| Dress write per booking      | Query-only availability check  | A transactional query locks returned docs, not their absence          |
| Half-open blocked interval   | Closed interval                | Back-to-back bookings without wasting a day per rental                |
| Reservations refuse offline  | Queue and reconcile            | Availability cannot be judged against stale local state               |
| Append-only financial events | Editable payments + void flag  | A ledger whose entries can be amended is not a ledger                 |
| Balance derived on read      | Stored balance field           | A stored balance is stale the moment an event is appended             |
| Idempotency key as doc id    | Key stored as a field          | Duplicate detection becomes existence, not a race to detect           |
| Deposit tracked separately   | One combined balance           | A deposit is not revenue and must never settle a rental               |
| Overpayment refused          | Accept and hold credit         | Almost always a typing error; credit must be designed, not accidental |

### Revisit if requirements change

Choosing a Vite SPA assumes the platform stays an internal staff tool. If Azhary
Boutique later wants a public, search-indexed catalogue of dresses, that is an
SSR requirement and the front end would move to Next.js on Firebase App Hosting.
The domain and service layers are deliberately framework-independent so that
migration would not touch business logic.
