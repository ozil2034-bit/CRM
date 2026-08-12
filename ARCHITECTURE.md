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
│   │   ├── availability.service.ts
│   │   ├── pricing.service.ts
│   │   ├── payments.service.ts
│   │   ├── reservations.service.ts
│   │   ├── invoices.service.ts
│   │   ├── notifications.service.ts
│   │   ├── customers.service.ts
│   │   ├── dresses.service.ts
│   │   ├── settings.service.ts
│   │   ├── audit.service.ts
│   │   └── numbering.service.ts
│   ├── domain/                 # Pure business logic — the testable core
│   │   ├── money.ts            # Baisa arithmetic, rounding, formatting
│   │   ├── vat.ts
│   │   ├── availability.ts     # Interval overlap + cleaning buffer
│   │   ├── pricing.ts
│   │   ├── late-fee.ts
│   │   ├── cancellation.ts
│   │   ├── deposit.ts
│   │   ├── payment-eligibility.ts
│   │   └── reservation-lifecycle.ts
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
// src/domain/availability.ts  (illustrative shape, implemented Phase 4)
export function blockedInterval(
  reservation: { pickupAt: number; returnAt: number },
  cleaningBufferDays: number,
): Interval;

export function overlaps(a: Interval, b: Interval): boolean;

export function isDressAvailable(request: Interval, existingBlocks: readonly Interval[]): boolean;
```

Each domain module has a matching `*.test.ts` covering the boundary cases named in
the specification: exact overlap, start overlap, end overlap, nested overlap and
cleaning-buffer overlap.

### Why time is a parameter

Late fees, cancellation tiers and overdue alerts all depend on "now". Passing `now`
explicitly means a test can assert the fee three days late without freezing the
system clock, and means the same function can be reused server-side in Cloud
Functions where the trusted clock differs from the browser's.

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

| Decision                  | Alternative rejected           | Reason                                                       |
| ------------------------- | ------------------------------ | ------------------------------------------------------------ |
| Integer baisa for money   | `number` in OMR                | Floating-point drift in invoice totals is unacceptable       |
| Pure domain, no Firebase  | Logic inside services only     | Exhaustive testing of edge cases without emulator overhead   |
| Custom i18n               | i18next                        | Compile-time key safety; smaller bundle; no unused machinery |
| Browser print             | jsPDF / pdfmake                | Correct Arabic shaping and RTL; no font embedding burden     |
| Custom design system      | MUI / Chakra                   | A luxury bridal brand must not look like a default kit       |
| Custom claims for roles   | Firestore role lookup in rules | No extra read per rule evaluation; claim is tamper-proof     |
| Per-year invoice counters | Single counter + filtering     | Sequence resets on 1 Jan with no migration                   |
| Vite SPA                  | Next.js                        | No public SEO surface; static hosting is simpler and cheaper |

### Revisit if requirements change

Choosing a Vite SPA assumes the platform stays an internal staff tool. If Azhary
Boutique later wants a public, search-indexed catalogue of dresses, that is an
SSR requirement and the front end would move to Next.js on Firebase App Hosting.
The domain and service layers are deliberately framework-independent so that
migration would not touch business logic.
