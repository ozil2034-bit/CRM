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

## 3c. Documents

An invoice, a rental agreement and a receipt. All three are **snapshots**: they
capture the business, the customer, the dresses, the money and the terms exactly
as they stood at the moment of issue, and nothing that changes afterwards can
reach back into them. That is the entire point of a document a customer keeps.

### A document computes nothing

`documentFinancialsFrom(pricing, position)` **copies**. There is no VAT
arithmetic in the document layer, no balance subtraction, no summing of
payments — every figure has exactly one origin: the reservation's frozen
`PricingSnapshot`, or the `FinancialPosition` that `reduceLedger` produced.

`reconcileDocument` asserts it, field by field, and the tests run it over ten
scenarios plus a live emulator issue. A document that recomputed its own totals
would be a second financial engine, and when two engines disagree the wrong one
is the copy the customer is holding.

### Why issuing is a Cloud Function

Three reasons, each sufficient:

1. **The number.** `INV-2026-0001` comes from a per-year counter allocated
   inside the transaction, with the same `current == previous + 1` rule the
   other counters use. Two simultaneous issues conflict rather than taking the
   same number.
2. **One instant.** The reservation, the ledger, the customer, the business
   profile and the terms are all read inside one transaction. Assembled from
   separate reads, an invoice could show a balance from before a payment beside
   a payment list that includes it.
3. **Immutability.** The rules refuse every client write to `invoices`. A client
   that could create one could craft its figures, and an invoice whose totals a
   browser chose is not evidence of anything.

Idempotent on the request key, which is the document's id — the same mechanism
as Phase 5. A retry after a timeout returns the original document rather than
issuing a second one and burning a second number.

### Voiding, not deleting

An issued document is never deleted and its contents are never altered. Voiding
sets a status and records who and why. The number keeps its place in the
sequence, so a gap is explicable rather than indistinguishable from tampering.

Voiding withdraws the **document**. It does not reverse any payment; that is a
separate Phase 5 operation with its own record.

### Three templates, ten shared parts

`TaxInvoice`, `RentalAgreement` and `PaymentReceipt` compose `DocumentHeader`,
`BusinessInfo`, `CustomerInfo`, `ReservationInfo`, `DressInfo`,
`FinancialSummary`, `PaymentSummary`, `TermsAndConditions`, `SignatureSection`
and `DocumentFooter`.

Three components rather than one branching on a type. A single conditional
document grows a thicket of "if receipt hide this, if agreement show that", and
the one thing a printed document must be is predictable. The differences are
real: the agreement ends in signatures and omits the payment history because a
contract records an undertaking rather than a settlement; the receipt is a short
slip that says plainly it is not a tax invoice.

### A4

`src/print/print.css` is self-contained rather than built on the application's
utilities. Paper is a different medium — physical page breaks, no scrolling, a
fixed 210mm width — and expressing that through screen utilities produces output
that looks right in a browser and wrong on paper.

```css
@page {
  size: A4 portrait;
  margin: 12mm 12mm 16mm;
}
```

Table rows, totals blocks and signature blocks carry `break-inside: avoid`;
headings carry `break-after: avoid`; `thead` repeats on every page a table
continues onto, because a column of amounts with no headings above it is
unreadable. Page numbers come from CSS counters (`counter(page) / counter(pages)`)
rather than a count computed in JavaScript — the application cannot know where
the printer will break the flow, and a wrong "Page 1 of 2" is worse than none.

### PDF

There is no PDF library. `window.print()` gives the browser's own dialogue,
which offers Save as PDF, shapes Arabic and bilingual text with the platform's
own text engine, and needs no font embedding. Adding a library would introduce a
dependency and a second text-shaping implementation to obtain something the
browser already does properly — and Arabic shaping is precisely where such
libraries tend to fail.

### Language

`en`, `ar` and `bilingual`. A bilingual document stays **LTR as a whole** and
marks only its Arabic passages RTL: setting the page RTL would mirror the
English column too, and an English address read right-to-left is not a document
anyone would accept.

Money and dates carry `direction: ltr; unicode-bidi: isolate` so the
bidirectional algorithm cannot move `OMR` to the wrong end of an amount inside
an Arabic paragraph, and `font-variant-numeric: tabular-nums` so columns align.

The language follows the customer's preference, with an employee override, and
is snapshotted — changing the boutique's default later cannot alter a document
already given to somebody.

### Nothing invented

An unconfigured VAT or CR number is **omitted entirely**, never rendered as a
placeholder. A missing logo falls back to the business name rather than a broken
image. A dress with no photograph renders no image at all. Terms ship with
structure and **no legal text**: the boutique writes its own, because a claim it
never made should not appear on a contract it asks a customer to sign.

---

## 3d. The operational layer (Phase 7)

The employee experience is built on four pure modules, none of which computes
money or decides availability. They **derive**: they read what the reservation
and financial engines already established, and arrange it for somebody standing
behind a counter.

### `operations.ts` — the working day

`dayOperations({ reservations, fittings, now, minPickupPaymentPercent })`
returns today's pickups, returns, fittings, overdue gowns and unpaid
collections, each as its own list rather than one merged feed. An employee
asking "what am I handing out this morning?" should not have to read past three
returns to find out.

Two decisions are load-bearing:

- **Overdue is measured from the start of today**, not from the current instant.
  A gown due back at 18:00 is not overdue at 09:00 the same morning, and
  flagging it would train staff to ignore the list.
- **The action table is deliberately not the transition table.** `actionsFor()`
  says what is worth *offering*; `refuseStatusChange()` says what the engine
  will *accept*. A `Reserved` booking can be cancelled, but "Cancel" is not what
  an employee reaches for when a bride walks in, so it is not among the actions
  the row suggests. The first entry is the promoted action.

### `utilization.ts` — the most misleadable number

```
utilization = blocked days in the period / operating days in the period
```

**Blocked days** are the days the gown could not be rented to anyone else: the
stored blocked interval, rental *plus cleaning buffer*, exactly as the
availability engine computed it at booking. Reporting recomputes no buffer — a
second implementation of the rule that decides double-booking is the last thing
this platform needs.

**Operating days** are the period, less any stretch before the dress entered the
inventory or after it was retired. Measuring a gown bought in November against a
full year would make every new dress look idle.

`percent` is `number | null`. **`null` means N/A, never 0%.** Zero percent is a
judgement about a gown — "available all month and never booked". A dress that
did not exist yet deserves no judgement, and printing one would misinform the
owner about her own stock. `averageUtilization` excludes N/A rows for the same
reason: including them would drag the average down every time the boutique
bought a gown, which is precisely backwards.

Day counting is **half-open**, matching the intervals themselves. Two
back-to-back bookings must not both claim the changeover day; a fully-booked
gown reading "104% utilised" would rightly destroy confidence in the whole
report. The result is capped at 100% regardless.

### `calendar.ts` — grids, not a library

Forty-two cells, always, so the grid does not change height as an employee pages
through the year. The week starts **Saturday**: Friday and Saturday are the
Omani weekend, and a Monday or Sunday start would split it across two rows.

Each event kind (`pickup`, `return`, `fitting`, `event`) is a distinct kind
rather than a colour. The interface renders a glyph and a named label for each,
so a colour-blind employee reads the same information.

`monthQueryRange(month)` returns the 42-day window a bounded Firestore query
would need. The calendar does not currently use it — it renders from the
reservation listener the dashboard already holds — but it is the shape the
bounded query should take when the collection outgrows one listener.

### `operational-reporting.ts` — attribution, honestly labelled

Revenue comes from the ledger, always. Never from a reservation's status, never
from a dress's current price, never from a total shown on a card.

A payment is made against a *reservation*, not a dress, and a reservation may
carry three gowns. So `revenueByDress` splits each booking's net collection **in
proportion to the frozen rental prices of its lines**, by largest remainder in
integer baisa. The parts always sum to the whole: a report whose rows do not add
up to its own total destroys confidence in every other figure on the page.

This is an attribution, not a measurement, and the module says so. It is the
best available answer to "which gowns pay for themselves"; it is not a claim
that a particular customer paid a particular sum for a particular dress.

Accessory and alteration revenue is reported as **agreed charges**, not cash —
the ledger records payments against a reservation as a whole and cannot say
which part of a payment settled a veil. Splitting one across the lines of a bill
would be arithmetic dressed up as fact.

Security deposits are excluded from every revenue figure, everywhere.

---

## 3e. Amendments — accessories and alterations

Phase 4 created reservations with empty `accessories` and `alterations` and left
the workflow deferred. Phase 7 completes it, and it is the delicate one, because
Phase 5 froze the pricing snapshot at creation and this changes it.

### Amending is not recomputing

The rule Phase 5 established is that a reservation's figures must never *drift*:
a price rise in the catalogue, or a VAT change next quarter, must not reach back
into a booking a customer already agreed to. That rule is about the boutique's
data changing underneath a customer. It is not about the customer buying a veil.

So `reprice()` in `src/domain/amendment.ts`:

- **reuses every frozen figure** — existing dress lines keep their snapshotted
  price and deposit; existing accessories and alterations keep theirs;
- **keeps the reservation's own VAT rate**, not today's, so a booking taken at
  0% stays at 0%;
- **carries the discount as an absolute amount**, because a discount was agreed
  as a sum of money off *this* booking; re-applying it as a percentage of a
  larger bill would silently enlarge a concession nobody granted;
- calls **`computePricing`** — the same and only pricing engine.

`reduceLedger` remains the one place a balance comes from. There is no second
calculation to disagree.

### Why an issued invoice stops it

A document is a copy, frozen at issue. Amending a reservation with a live
invoice would leave the customer holding a piece of paper the system no longer
agrees with — precisely the discrepancy `reconcileDocument` exists to detect.
The correction path is to void the invoice and issue a new one, which leaves
both on the record. The emulator suite proves the lock, the unlock after a void,
and that the issued document itself never moves.

### Why the Functions

Deciding whether an amendment is permitted means reading the reservation's
status, its issued documents and its existing lines, then writing a new snapshot
based on the answer — the same read-then-write shape as booking and payment, and
the same reason the client SDK cannot do it.

Every amendment reads and writes the reservation document, incrementing
`financialVersion` — the lock Phase 5 established. Without it, two employees
adding a veil at the same moment each write a snapshot computed from a list that
lacks the other's line, and whichever commits second silently discards the
first. With it, they conflict, Firestore retries the loser, and the retry
reprices against a list containing the winner's line.

The client's request key **is** the line's id, so a duplicate submission finds a
line that already exists rather than a race to detect. A double click cannot
bill a bride for two veils she asked for once.

### Accessories are not bookable resources

A dress is one physical garment, so booking it excludes everyone else and the
whole conflict engine exists to enforce that. A boutique holds several of most
accessories and frequently sells rather than rents them. Modelling them as
blocking resources would demand stock levels the boutique does not keep, and
would refuse bookings for a shortage nobody has observed.

So an accessory is a **priced catalogue entry**. `priceFor(accessory, 'Sale')`
on a rental-only item returns `null`, not zero — falling back to zero would put
a free veil on an invoice and nobody would notice until the month's revenue was
short. Entries are retired, never deleted: past reservations reference them by
id, and a deleted entry would leave their revenue unattributable.

---

## 3f. Communication (Phase 8)

### WhatsApp is click-to-chat, and the vocabulary follows from that

The application builds a `wa.me` link and opens it. WhatsApp receives a draft;
**the employee then presses send, or does not.** Nothing is transmitted by this
code, and nothing downstream can observe what happened.

So the three states are `Prepared`, `Opened` and `Copied`. Each is literally
true of something the application saw. There is no `Sent`, no `Delivered` and
no `Read`, and adding one requires an integration that can actually observe it —
the WhatsApp Business API, which is deliberately not here.

This is enforced in three places, because a claim of delivery is the kind of
error that survives a code review and reappears in a translation:

- `COMMUNICATION_STATUSES` is a closed union of the three.
- `firestore.rules` refuses to store any other status.
- `dictionary.test.ts` asserts that no status label **in either language** uses
  the words sent, delivered or read.

### Encoding

`encodeURIComponent` is applied to the whole message body. Not a hand-rolled
replacement of a few characters: an unescaped `&` in a business name would end
the `text` parameter and silently truncate the rest of the message.

Phone numbers go through `parseOmanPhone` — the same normaliser customer records
and duplicate detection use. `wa.me` wants digits with the country code and no
`+`, which is exactly `ParsedPhone.normalized`. A second definition of a valid
number would eventually disagree with the first about somebody's contact
details.

### The log is append-only, and stores the message

One immutable entry per action. Phase 2 modelled a notification as a single
document with a mutable `openedAt`; Phase 8 replaced that because an employee
who opens WhatsApp twice has contacted the customer twice — the second may be a
follow-up after no reply — and one timestamp records only the first.

Each entry carries the **exact text that was prepared**. A log saying "pickup
reminder, 10 September" is useless six months later once the template has been
rewritten and the booking's dates have moved. The entry is a snapshot, like an
invoice, and the rules refuse every update.

Entries are written from click handlers only, never from an effect, so a page
refresh cannot look like contacting somebody again.

### Templates: the rule that shapes the module

**A variable with no value must never reach a customer.** `undefined`, `null`
and `NaN` are precisely what naive substitution produces, and each turns a
careful message into evidence that the shop's system is broken.

So rendering is two steps. `missingVariables(body, values)` reports what cannot
be filled and the composer refuses both actions until it is resolved, naming
what is missing. `render` leaves an unfilled placeholder as itself — visible and
obviously wrong — rather than as prose. There is no empty-string fallback for a
required variable: "your balance is  " is worse than a refusal, because the
employee sends it.

An empty-string value counts as missing for the same reason.

### Bilingual is a structure

Arabic, a separator line, then English — each a coherent whole. Arabic first
because the boutique is in Oman and most of its customers read it. Interleaving
sentence by sentence produces something neither reader can follow, and gluing
two paragraphs together with no break reads as one corrupted message.

### Reminders are stored intent, not a schedule

There is no cron, no queue and no background worker in this architecture. A
client-side `setTimeout` would fire only while somebody happened to have the tab
open, so reminders would arrive for whichever employee left a browser running
overnight and not at all on a Friday — worse than none, because the boutique
would believe they were going out.

`ReminderPreference` records which reminders matter and how far ahead. The
dashboard surfaces what is due; an employee still prepares each message. When
scheduled execution becomes part of the architecture, these are the values it
reads and nothing about the stored shape needs to change. The settings panel
says all of this on screen.

---

## 3g. Language, direction and mixed content

### Three languages, two of them for different things

- The **interface** language is `en` or `ar`, held in `I18nProvider` and stamped
  onto `<html lang dir>`. Layout uses CSS logical properties throughout, so the
  entire interface mirrors from that one attribute — no mirrored stylesheet, no
  per-component RTL branching.
- The **customer's** preference is `en`, `ar` or `bilingual`, stored on the
  customer and used as the default for documents and messages.
- The **message** language is chosen per message. Changing it affects that
  message only; an employee writing once in English has not decided the bride
  now prefers English, so the stored preference is never rewritten as a side
  effect.

An Arabic-speaking employee writing to an English-speaking bride is the case
that makes these genuinely independent.

### Mixed content

Three CSS classes carry the whole strategy:

| Class | Applies to | Why |
| --- | --- | --- |
| `.numeric` | money, dates, counts | `direction: ltr; unicode-bidi: isolate` — an amount must be unambiguous whatever surrounds it |
| `.code` | `RSV-0001`, `INV-2026-0042`, phone numbers | same isolation. Without it, bidi reorders the trailing groups and `INV-2026-0042` renders as `0042-2026-INV` — a number the customer cannot match to the invoice in their hand |
| `.user-text` | names, notes, descriptions | `unicode-bidi: plaintext`, the CSS form of `dir="auto"`. Each string takes its base direction from its own first strong character, so "فاطمة (VIP)" puts the bracket on the correct side and an English note in an Arabic screen has the same treatment mirrored |

`.user-text` is applied per element and never globally. Interface chrome must
follow the *language*; only content follows the *content*.

Typography keys off `:lang(ar)` rather than direction, which is what lets a
bilingual document render each language in its own face on the same page. Arabic
sits slightly larger and looser at the same nominal size, because without that
it reads noticeably smaller than the Latin beside it.

### Arabic search

Unchanged from Phase 3 and deliberately re-asserted in the Phase 8 suite. Alif
forms fold together, ta marbuta folds to ha, alif maqsura to ya, so `أحمد` and
`احمد` reach the same token. The way this breaks quietly is a call site
normalising its own input instead of going through `src/domain/search.ts`, which
is why the regression test exercises the end-to-end `rankMatches` path and not
only the normaliser.

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

- **Firestore listeners are the state layer.** `observeX(…)` in a service returns
  an unsubscribe function; a screen subscribes in `useEffect` and holds the
  result in `useState`. There is no query-cache library between the SDK and the
  component, because Firestore's own listener *is* a subscription with a cache
  — putting a second cache in front of it would mean two things to invalidate
  and two answers to reconcile.
- **Session and preference state** lives in React context: `AuthProvider` for
  the identity, `I18nProvider` for language and direction, `ConnectivityProvider`
  for the connection state. Never business data.
- **Firestore offline persistence** (IndexedDB, multi-tab) is the offline cache.
  It is a cache. The application never treats it as the record of truth, and never
  reports a write as successful until the server acknowledges it.

> `@tanstack/react-query` and `zustand` appear in `package.json` from the Phase 1
> plan and are **not imported anywhere**. Nothing bundles them. They are listed
> here so the discrepancy is recorded rather than discovered; removing them is a
> Phase 10 cleanup decision.

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
- Errors are typed, and the type is what decides what an employee sees.
- Two error boundaries, one for what the router can catch and one for what it
  cannot.

### Two kinds of error, and why the distinction is a class

`src/services/errors.ts` defines `AppError`, and every deliberate service failure
extends it — `ReservationServiceError`, `PaymentServiceError`, `AuthError` and ten
more. That base class exists to answer one question at a `catch` site:

| Thrown value                                   | What it is                                          | What the employee sees      |
| ---------------------------------------------- | --------------------------------------------------- | --------------------------- |
| `AppError` subclass                            | A message this application wrote for the counter    | The message, verbatim       |
| `FirebaseError`, `TypeError`, anything else    | Wording written for a developer, or a bug           | A translated sentence       |

Nothing on a bare `Error` distinguishes the two, and `caught instanceof Error ?
caught.message : …` — which reads as defensive — will happily print *"Missing or
insufficient permissions"* to a bride's stylist. The class is what makes the
check correct.

`useFriendlyError()` performs it. It maps a Firebase code to one of nine
situations (`src/domain/firebase-errors.ts` — offline, timeout, permission,
unauthenticated, notFound, conflict, quota, invalid, unknown), looks the
situation up in the dictionary so an Arabic employee reads Arabic, and passes an
`AppError`'s own message through untouched. The original goes to the console in
**development only**: a boutique tablet's console is not a private place, and a
Firestore error routinely carries the document path of the customer on screen.

### The two boundaries

- **`AppErrorBoundary`** is the router's `errorElement`. It offers a way out
  rather than a dead end: *try this screen again* re-navigates to the same
  address, which clears the router's error state and re-mounts the route without
  a page load; *return to Today* leaves for a screen known to work.
- **`RootErrorBoundary`** wraps everything in `main.tsx`, outside every provider.
  It catches what the router cannot — a provider that throws while mounting, a
  router that could not be constructed — so it deliberately depends on nothing:
  no hooks, no design-system components, no i18n context. It reads the language
  preference straight from storage and indexes the dictionary as a plain object,
  because the screen an Arabic employee is most likely to be alarmed by should
  not be the one screen that reverts to English.

---

## 11a. Offline — what a disconnected device may decide (Phase 9)

Being installable and working on a weak connection is not permission to do
everything offline. The governing rule is one sentence:

> **An operation whose legality depends on current server state cannot be
> decided on a device that has not seen the server.**

`src/domain/connectivity.ts` is that rule as data. It lists fourteen
`GUARDED_OPERATIONS` and, for each, *which* piece of server state is missing —
because the refusal an employee reads should say something true about their
situation, not "you are offline":

| Reason            | Operations                                              | What cannot be known offline                            |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| `AVAILABILITY`    | reservation create, date change, status change          | Whether another till just booked the same dress          |
| `LEDGER`          | payment, deposit, refund, reversal, settlement, late fee | The balance, which is a reduction over an event query    |
| `DOCUMENT_NUMBER` | document issue, void                                    | The next number in a per-year counter                    |
| `UNIQUE_CODE`     | dress create, customer create, accessory create         | The next code in a counter, with the rule that guards it |
| `IDENTITY`        | employee create, role change                            | A custom claim only the Admin SDK can write              |

`isOperationAllowed()` returns `state === 'online'` for all fourteen. The
operation stays a parameter anyway: the *reason* differs per operation, and the
day one of these becomes safely queueable, that function is the single place
that changes.

`reconnecting` counts as offline. A device that is trying to reconnect has not
yet seen the server, and treating "probably back" as "back" is exactly how a
dress gets double-booked.

The guard is enforced in the service layer (`src/services/offline-guard.ts`,
called from the reservation, payment, document and amendment services) and not
merely by disabling a button — a disabled button is a courtesy, not a control.

What *is* allowed offline: reading anything already cached, and editing an
existing dress or customer. Those are ordinary Firestore writes that apply to the
local cache immediately and sync later, and the interface says **"Saved on this
device — it will sync when the connection returns"** rather than "Saved".

---

## 11b. The PWA and the service worker

Generated by `vite-plugin-pwa` in `generateSW` mode. Three choices are worth
recording:

- **`registerType: 'prompt'`, not `autoUpdate`.** An employee mid-way through
  taking a payment must not have the application swap underneath them. A new
  version waits, and is offered.
- **No runtime caching of Firestore, Storage or Functions.** The precache holds
  the application shell only — JS, CSS, fonts, icons. Business data caching is
  Firestore's own IndexedDB persistence, which is bound to a signed-in session
  and cleared on sign-out. A service worker cache is not: it is shared by
  everyone who opens the browser, and a cached customer record in it would
  outlive the session that fetched it.
- **Source maps are excluded from the precache** (`globIgnores: ['**/*.map']`),
  so they are not shipped to every installed device.

### Fonts are self-hosted

Inter, Cormorant Garamond, IBM Plex Sans Arabic and Noto Kufi Arabic live in
`src/assets/fonts/` as WOFF2, with their OFL licences beside them. Nothing is
requested from Google Fonts. That is partly privacy — a font request tells a
third party which boutique tablet opened the application and when — and partly
that an offline-capable application cannot depend on a CDN for its own text.

`font-display: swap` means a first paint before the fonts land may briefly use a
fallback. On the **print** documents that would be visible in the output, so
printing is done from a session that has already rendered the application; the
fonts are in the precache by then.

---

## 11c. Backup and recovery

Export is a client operation and needs no Cloud Function: an owner may already
*read* everything, so the browser reads all sixteen collections and writes a
JSON file. Restore is the opposite — `reservations`, `reservationItems`,
`financialEvents`, `invoices` and `auditLogs` refuse every client write, and that
refusal is one of the properties the platform rests on. So restore is an
owner-only Cloud Function (`functions/src/backup.ts`), where the Admin SDK
bypasses the rules and an ownership check stands in their place.

- **The file carries an envelope**: schema version, export time, application
  version, project id and environment. A restore into the wrong project is
  visible before anything is written.
- **Nothing is written until the owner confirms.** The file is validated whole,
  then the screen shows what would be created and what would be *overwritten*,
  per collection.
- **Ids are never regenerated and figures are never recomputed.** A restored
  invoice carries the number it was issued with; a restored balance is the
  reduction of the restored events, not a fresh calculation.
- **Chunked, therefore not atomic across the whole file.** A callable is capped
  at 10 MB, and Firestore has no transaction at backup size. What makes that
  survivable: the client validates the whole file first, the Function
  re-validates every chunk with the same domain validator, and every write is
  keyed by its original id — so re-running an interrupted restore converges
  instead of duplicating.
- **No secrets, ever.** `FORBIDDEN_FIELDS` in `src/domain/backup.ts` rejects a
  file containing a bootstrap token, a private key or a credential, in both
  directions: an export that somehow contained one would fail validation before
  being offered for download.

The recovery drill (`tests/functions-emulator/backup.test.ts`) runs the whole
thing end to end against the emulator — build a boutique, export, wipe, restore,
and compare every record, relationship, financial event, snapshot and audit
entry with what was there before.

---

## 11d. Sign-out on a shared tablet

The boutique's devices are shared, so sign-out has to settle three things:

1. **Auth** — the token is dropped.
2. **Disk** — Firestore's IndexedDB cache holds the working set of every customer
   and reservation the session opened. Signing out does not touch it, so it is
   terminated and cleared explicitly.
3. **Memory** — the React tree still holds what it last rendered, and the
   Firestore handle has just been terminated, so a second sign-in in the same tab
   would meet a dead client on every read.

A full page load settles all three at once, which is what makes the guarantee
simple enough to state: **after sign-out there is nothing left in this tab.** The
navigation goes to `/`, not a reload in place, so the next employee starts at the
sign-in screen rather than at whichever customer was open. It happens last, so a
failed cache clear — another tab still holds the database — never leaves a
session signed in.

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
| Prompt for a new version     | `autoUpdate` service worker    | The application must not swap under an employee taking a payment      |
| No runtime caching of data   | Cache Firestore responses      | A service-worker cache outlives the session that filled it            |
| Self-hosted fonts            | Google Fonts CDN               | Offline capability, and no third party told which tablet opened when  |
| Restore as a Cloud Function  | Relax the rules for restore    | A browser that can write a financial event can write any of them      |
| Restore chunked, not atomic  | One transaction                | Firestore has no transaction at backup size; convergence instead      |
| Full page load on sign-out   | Reset state in place           | The only teardown whose completeness can actually be stated           |

### Revisit if requirements change

Choosing a Vite SPA assumes the platform stays an internal staff tool. If Azhary
Boutique later wants a public, search-indexed catalogue of dresses, that is an
SSR requirement and the front end would move to Next.js on Firebase App Hosting.
The domain and service layers are deliberately framework-independent so that
migration would not touch business logic.
