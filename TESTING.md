# Azhary Boutique — Testing

---

## 1. What "tested" means here

The specification's critical rule (§63) governs this document:

> A feature is complete only when UI + business logic + database + persistence +
> error handling + security + tests work together.

A passing build is not evidence. A rendered button is not evidence. Tests exist to
prove that money is calculated correctly, that a dress cannot be double-booked, and
that a staff member cannot change the VAT rate.

---

## 2. Test layers

| Layer       | Tool                           | Environment                  | Speed  | Proves                                                                          |
| ----------- | ------------------------------ | ---------------------------- | ------ | ------------------------------------------------------------------------------- |
| Domain      | Vitest                         | node                         | ms     | Pricing, VAT, availability, buffers, fees, numbering are arithmetically correct |
| Component   | Vitest + Testing Library       | jsdom                        | fast   | States render; errors surface; input survives failure                           |
| Service     | Vitest                         | Firestore emulator           | medium | Transactions, concurrency, audit trails                                         |
| Rules       | `@firebase/rules-unit-testing` | Firestore + Storage emulator | medium | Each role can do exactly what it should, and nothing more                       |
| Integration | Vitest                         | full emulator suite          | slower | Real workflows end to end                                                       |

### Commands

```bash
npm run test            # unit + component (no emulator required)
npm run test:watch      # watch mode
npm run test:coverage   # coverage report
npm run test:rules      # Firestore + Storage rules, against the emulator
npm run test:functions  # Cloud Function integration, against the emulator
npm run emulators       # start the Firebase emulator suite
```

Three suites, three configs. `npm run test` deliberately needs no emulator, Java
or open port, so the fast feedback loop stays fast; the emulator-backed suites run
under their own Vitest configs on a single worker, because they share one emulator
and describe ordered lifecycles.

```bash
npm run test:functions:auth          # identity lifecycle only
npm run test:functions:catalogue     # dress and customer CRUD only
npm run test:functions:reservations  # the reservation engine only
npm run test:functions:payments      # the financial engine only
npm run test:functions:documents     # invoices, agreements and receipts only
npm run test:functions:amendments    # accessories and alterations only
```

The emulator-backed integration suites run in **separate emulator invocations**,
not merely separate files. Each bootstraps an owner, and owner bootstrap is a
one-time transition — sharing one emulator would make whichever suite ran second
fail against state the first had already consumed.

Current totals: **1,285** unit · **817** rules · **204** integration.

Per emulator suite: auth 31 · catalogue 16 · reservations 37 · payments 60 ·
documents 38 · amendments 22.

---

## 3. Domain tests — the priority

`src/domain` is pure, deterministic and takes `now` as a parameter. It is where the
money and the availability logic live, so it carries the highest coverage bar:
**100% of branches**.

### 3.1 Money (§10)

- `parseOmr('180.000') === 180000`
- `parseOmr('180.0005')` rejects — more precision than OMR has
- `formatOmr(180000) === 'OMR 180.000'` — always 3 decimals
- `formatOmr(0) === 'OMR 0.000'`
- `formatOmr(500) === 'OMR 0.500'` — no truncation to `0.5`
- Addition of many line items never drifts
- Half-up rounding at the defined boundary: `roundDiv(5, 2) === 3`
- Negative amounts round symmetrically
- Percentage application rounds once, not per operand

### 3.2 VAT (§11)

- 0% yields zero VAT and an unchanged total
- 5% of 180.000 is 9.000
- **Security deposit is excluded from the taxable base** — the single most important
  VAT assertion
- Rounding of 5% on an odd baisa amount is deterministic
- An invoice's stored rate and amount are unaffected when settings change afterwards

### 3.3 Availability and cleaning buffer (§18)

The specification names five cases; each has an explicit test, in both directions:

| Case                | Existing          | Requested | Expected                        |
| ------------------- | ----------------- | --------- | ------------------------------- |
| Exact overlap       | 10–14             | 10–14     | unavailable                     |
| Start overlap       | 10–14             | 8–11      | unavailable                     |
| End overlap         | 10–14             | 13–16     | unavailable                     |
| Nested              | 10–20             | 12–14     | unavailable                     |
| Contains            | 12–14             | 10–20     | unavailable                     |
| Cleaning buffer     | 10–14, buffer 3   | 15–17     | **unavailable** (blocked to 17) |
| Clear of buffer     | 10–14, buffer 3   | 17–19     | available (boundary is exact)   |
| Adjacent, no buffer | 10–14, buffer 0   | 14–16     | available (half-open)           |
| Cancelled existing  | 10–14 (Cancelled) | 10–14     | **available**                   |
| No-Show existing    | 10–14 (No-Show)   | 10–14     | **available**                   |

Plus: operational blocks (`In Alteration`, `Under Repair`, `Retired`) make a dress
unavailable regardless of dates (§20).

### 3.4 Payment eligibility for pickup (§23)

- Threshold is read from settings, never hard-coded
- 100% requires the full eligible balance
- 50% requires half
- Security deposit unpaid ⇒ pickup denied even at 100% of rental paid
- Security deposit payments are excluded from the eligible balance
- Voided payments do not count toward the threshold

### 3.5 Security deposit (§24)

- `refunded + forfeited ≤ collected` — the one invariant, enforced by a single
  comparison against `depositHeld`, so an over-refund and an over-forfeit are the
  same arithmetic failure rather than two rules that can drift apart
- Refunding or forfeiting more than is held is rejected
- A second settlement beyond what remains is rejected
- Forfeiture without a reason is rejected — keeping a customer's money without
  recording why is indefensible if it is ever questioned
- A deposit never settles the rental balance, and a forfeited deposit does not
  either

### 3.5a The ledger (§3, §21, §33)

- A balance is a reduction over events; nothing is stored
- `outstanding` and `refundable` are mutually exclusive by construction
- A reversal leaves the reservation `Unpaid`, not `Refunded` — no money moved
- A refund shrinks the refundable ceiling, so "refunding twice" needs no special
  case: the second attempt finds nothing left
- A late fee can reopen a settled reservation
- A waiver never drives what is chargeable below zero
- `reconcile()` balances to zero difference across every scenario: no activity,
  part payment, full payment, deposit held, reversal, late fee, cancellation with
  refund, deposit partly kept
- Precision is carried exactly at 1, 2, 5, 999, 1 001 and 999 999 999 baisa, and
  across a chain of 97 one-baisa payments

### 3.6 Late fee (§26)

- On-time and early returns incur no fee
- Late days = `actualReturn − scheduledReturn`, counted in whole days
- Fee = `lateDays × configured daily rate`
- A same-day late return of a few hours is defined explicitly (whole-day rounding
  rule is asserted, not left implicit)
- A zero configured rate yields zero, never `NaN`

### 3.7 Cancellation (§28)

- Tier selection by days between cancellation date and event date
- **Every tier boundary** is asserted on both sides — off-by-one is the classic
  failure, and the day either side of 30, 14 and 7 is tested explicitly
- Cancelling the day before the event, on the event date, and after it all give
  the least generous tier
- Notice is counted in calendar days in Muscat, so 08:00 and 23:00 on the same
  day give the same answer
- No tier configured means no refund — refunding by default on a
  misconfiguration would give money away
- The retained charge and the waiver **add up to the original exactly**, across
  odd amounts, because rounding each half independently can miss by a baisa
- The deposit is returned in full: cancelling damages nothing
- A quote never reports both a refund and an amount still owed

### 3.8 Numbering (§5)

- Formatting honours configured prefix, separator and padding
- `WD-0001`, `CU-0001`, `RSV-0001`, `INV-2026-0001`
- Padding overflow (10000th dress) widens rather than truncating
- Invoice numbers include the correct year and reset on 1 January

### 3.9 Reservation lifecycle (§17)

- Every legal transition is accepted
- Every illegal transition is rejected (exhaustive over the status matrix)
- `Cancelled`, `No-Show` and `Closed` are terminal
- `Picked Up` is irreversible — once the gown has left the shop, no status change
  may pretend otherwise
- Each refusal carries a distinguishable code (`SAME_STATUS`, `TERMINAL`,
  `NOT_PERMITTED`, `PICKED_UP_IS_IRREVERSIBLE`), so the interface can explain
  rather than merely refuse

### 3.10 Similar-dress ranking (§20)

- The unavailable dress is never suggested as its own alternative
- `Retired`, `Under Repair`, `In Alteration` and `Sold` are never offered
- A gown with nothing in common is never offered — an unrelated suggestion
  damages trust in every later one
- Size outscores style, colour, designer and price **combined**: a gown that does
  not fit is not an alternative at any price
- Equal scores are ordered by code, so the same query always returns the same
  answer

---

## 4. Service and concurrency tests

Run against the full emulator suite via `npm run test:functions:reservations`.

**The double-booking test is mandatory** (§19, §27), and it is the reason this
suite exists. Nothing short of firing genuinely simultaneous requests at one
emulator demonstrates that a dress cannot be promised twice.

| Test                                      | Asserted outcome                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| Eight simultaneous, **same** dress        | Exactly 1 success, 7 structured conflicts, exactly 1 blocking item, dress `Reserved` |
| Eight simultaneous, **different** dresses | All 8 succeed with 8 distinct reservation numbers                                    |

The second case matters as much as the first: a lock coarse enough to serialise
unrelated bookings would pass the first test and make the boutique unusable on a
busy morning.

Also covered:

- A multi-dress booking is all-or-nothing — one unavailable gown creates
  **nothing**, not a partial reservation for the two that were free
- Every unavailable dress is named, not only the first
- A failed creation consumes no reservation number, writes no audit entry, and
  leaves no orphan items
- The blocked interval is stored as pickup through return **plus** the buffer,
  and a pickup at exactly the buffer's expiry is accepted
- A dress-level `cleaningBufferDays` overrides the default in both directions
- A retired dress is refused regardless of dates
- The lifecycle moves the gown `Reserved → Out with Customer → In Cleaning`, and
  a cancellation frees it only when no other booking still holds it
- Editing dates revalidates availability; a colliding edit preserves the original
- Unauthenticated and non-employee callers are refused, and direct client writes
  to `reservations` and `reservationItems` are rejected by the rules

A counter never issuing the same number twice under concurrent creation is
covered by the catalogue suite.

---

## 4a. Financial concurrency and idempotency (§28, §29)

Run against the full emulator suite via `npm run test:functions:payments`.

A balance is a reduction over an event list, so two simultaneous payments each
read a stale list unless the transactions genuinely conflict. These prove they
do.

| Test                                       | Asserted outcome                                      |
| ------------------------------------------ | ----------------------------------------------------- |
| Eight payments racing for the full balance | Exactly one succeeds; `netPaid` equals the balance    |
| Six payments racing at half the balance    | Exactly two fit; nothing exceeds what is owed         |
| Payments on six different reservations     | All succeed — unrelated work is not serialised        |
| Six refunds racing                         | Exactly one succeeds; `refundable` falls to zero      |
| A payment racing a refund                  | The position still reconciles                         |
| Six deposit settlements racing             | Returned + forfeited never exceeds what was collected |
| A deposit refund racing a forfeiture       | Same invariant holds                                  |

Idempotency:

- The same request key sent twice posts **one** event; the second reports
  `duplicate: true`
- Eight simultaneous sends of one key post **one** event — the double-click case
- Different keys are different payments, as they must be
- Refunds are idempotent on the same terms
- A missing key is refused rather than defaulted: a server-generated key would
  make every retry a fresh payment
- A key that could not be a document id (`../../system/bootstrap`) is refused

Immutability and authorization, against real rules:

- A posted event is byte-identical before and after a reversal is appended
- Editing or deleting a posted event is refused, **including for the owner**
- Writing a financial event directly from a client is refused
- Staff may record payments and deposits; staff are refused refunds, reversals
  and forfeitures
- Staff cannot change the VAT rate, and the owner cannot set it to 15%

---

## 4b. Documents (§35–38)

Component tests (`src/print/documents.test.tsx`) render every document type in
every language mode and cover the content that breaks layouts:

- Tax invoice, rental agreement and receipt × `en` / `ar` / `bilingual`
- An Arabic document is `dir="rtl"`; a **bilingual** one stays `dir="ltr"` with
  its Arabic passages marked RTL, because mirroring the page would reverse the
  English column too
- Money is isolated so the bidirectional algorithm cannot move `OMR` to the wrong
  end of an amount inside Arabic text
- No logo → the business name, never a broken image; no dress photograph → no
  image element at all
- An unconfigured VAT or CR number is absent; `OM123456789` and `CR-1098234`
  appear nowhere
- No internal event id is printed on a customer document
- The security deposit is in its own block, is not inside the totals, and says
  it is refundable and untaxed
- Ten dresses, twenty-five payments, long English and long Arabic names, long
  terms in all three languages, long notes, and a short invoice with nothing paid
- The agreement carries signature lines and omits the payment history; the
  receipt says plainly it is not a tax invoice
- A voided document still renders, marked, with its original figures intact

Emulator tests (`npm run test:functions:documents`):

| Test                                | Asserted outcome                             |
| ----------------------------------- | -------------------------------------------- |
| Eight simultaneous issues           | Eight **unique** `INV-YYYY-NNNN` numbers     |
| Same request key twice              | One document; the second reports `duplicate` |
| Eight simultaneous sends of one key | One document                                 |
| Duplicate request                   | The invoice counter does **not** advance     |

Immutability, against real rules:

- Changing the business name, address, VAT number and logo, the VAT rate, and
  the customer's name leaves an issued document **byte-identical**
- A later payment does not alter an already-issued document's figures
- Editing, deleting or creating an invoice from a client is refused, for staff
  and for the owner
- A published terms version cannot be edited; a new active version does not
  change what an issued document carries

Financial reconciliation (§36) runs against the emulator: the stored document's
`financials` is compared field by field with `reduceLedger` recomputed
independently from the reservation and the ledger. `reconcileDocument` must
return an empty list.

---

## 4c. Operations, reporting and amendments (Phase 7)

### The domain

`operations.test.ts`, `utilization.test.ts`, `calendar.test.ts`,
`accessory.test.ts`, `amendment.test.ts` and `operational-reporting.test.ts` are
pure: the current instant and the reporting period are parameters, so February
2028's leap day and "three overdue returns" are asserted without touching the
clock.

The load-bearing assertions, the ones that would let a real defect through if
deleted:

- **N/A is not 0%.** A dress with no operating days reports `percent: null`, and
  `averageUtilization` excludes it rather than counting it as zero. A separate
  test asserts that a dress that *was* available and never booked reports a real
  `0` — the two must stay distinguishable.
- **Two back-to-back bookings do not both claim the changeover day.** Half-open
  day arithmetic; without it a fully-booked gown exceeds 100%.
- **A cancelled booking is omitted from the calendar entirely.** Leaving it on
  would have staff preparing for a customer who will not arrive.
- **Overdue is measured from the start of today.** A gown due at 18:00 is not
  overdue at 09:00.
- **`allocateByWeight` loses nothing.** Every split sums exactly to its input,
  including the odd-baisa case, and a zero-weight case spreads rather than
  dropping the money.
- **A rental-only accessory being sold reports no price**, never zero.
- **The reservation's VAT rate survives an amendment**, and the discount travels
  as an absolute amount rather than growing with the bill.
- **`reprice` equals `computePricing`** for the same lines, asserted by
  constructing both and comparing the whole snapshot.

### The Functions

`tests/functions-emulator/amendments.test.ts` proves what a pure function cannot
be asked about:

- the **stored** snapshot equals what `computePricing` produces for the same
  lines — if the Function ever computed its own totals, the invoice and the
  screen would eventually disagree, and the one on paper is the one the customer
  keeps
- the reservation's frozen VAT rate is used even after the setting is changed
  underneath it
- the same request sent twice adds **one** line, sequentially and concurrently
- two *different* concurrent amendments both land: without the
  `financialVersion` lock neither transaction conflicts and the second silently
  discards the first
- an issued invoice **refuses** the amendment; voiding it allows one again; and
  the issued document's own figures never move either way
- a `Returned` booking refuses an amendment, while one still `Picked Up` accepts
  it — a hem taken up at the last fitting is billed after the dress has left
- the outstanding balance moves by exactly the charge plus its VAT, verified by
  reducing the stored snapshot through `reduceLedger`
- fractional prices, zero quantities, blank descriptions, zero amounts and
  unauthenticated callers are all refused

---

## 4d. Communication, Arabic and settings (Phase 8)

### The claim that must never appear

Asserted in three independent places, because a false claim of delivery is
exactly the kind of error that survives a code review and reappears in a
translation:

- `whatsapp.test.ts` asserts `COMMUNICATION_STATUSES` is exactly
  `['Prepared', 'Opened', 'Copied']` and that `Sent`, `Delivered`, `Read` and
  `Failed` are all rejected by the type guard.
- The rules suite asserts that a document carrying any of those statuses is
  **refused by Firestore**, not merely hidden by the interface.
- `dictionary.test.ts` asserts that no status label **in either language** uses
  those words, and that the disclaimer says plainly in both that opening is not
  sending.

### The WhatsApp link

- every form staff type — `91234567`, `+968 9123 4567`, `00968-…`, Arabic-Indic
  digits — reaches the same `96891234567`, through the **one** normaliser
- `&`, `#`, `?`, `+`, newlines and Arabic all survive a round trip through
  `encodeURIComponent`; the `&` case is asserted specifically, because an
  unescaped one would end the `text` parameter and truncate the message
- an empty, invalid or foreign number, an empty message and an over-length
  message are each refused with a named problem rather than producing a link
- `canMessage` gates the control, so no button that could only fail renders

### Templates

The load-bearing assertion: **`undefined`, `null` and `NaN` never appear in a
rendered message.** Around it:

- an unfilled placeholder renders as itself, visible and obviously wrong
- an empty-string value counts as missing, but `"OMR 0.000"` does not — a real
  balance of zero is a value
- a typo (`{custmer_name}`) is reported as an unknown variable, not as missing
  data, and rendering leaves it untouched
- a value that itself looks like a placeholder is not re-expanded, so a customer
  named `{balance}` does not become their balance
- the bilingual body is Arabic, separator, English; the separator is omitted
  when only one language is written
- preparing a bilingual message checks **both** halves, so a gap in either
  blocks it
- `SAMPLE_VALUES` supplies every variable, so a settings preview never shows a
  gap, and reads obviously as a sample

### Settings

- VAT accepts only 0 and 5, asserted through the domain **and** against the
  rules from the owner's own credentials
- the cancellation scale refuses duplicate notice periods (which would make a
  refund depend on the order rows were typed in) and refuses a scale where
  cancelling earlier refunds less
- equal percentages at different notice periods are accepted — flat within a
  band is a policy, not an error
- `criticalChanges` catches VAT, late fee, threshold and tier edits, and
  deliberately does **not** flag the cleaning buffer, which is not money
- staff are refused message templates, reminder preferences and every financial
  setting at the rules layer

### Arabic and direction

- every dictionary key has a non-empty Arabic value, and none still holds its
  English text outside a short allowlist of brand names. **Verified by breaking
  one translation and watching the suite fail** — a coverage test nobody has
  seen fail is a coverage test that may assert nothing.
- the Phase 3 normalisation is re-asserted end to end through `rankMatches`, not
  only through the normaliser: the way it breaks quietly is a call site
  normalising its own input instead of going through the domain

---

## 4e. Resilience, offline, backup and CSV (Phase 9)

### The recovery drill (§46)

`tests/functions-emulator/backup.test.ts` is the load-bearing test of this phase,
because it is the only one that answers the question a backup exists to answer.
It builds a boutique through the **real** services and Cloud Functions — an
Arabic-named customer, a dress, a reservation, a security deposit, a payment, a
two-unit accessory line and an issued tax invoice — then:

```
export → wipe every collection → import → compare
```

and asserts, against what was there before the wipe:

- every record is back **under its original id**;
- the reservation still points at its customer, and the items at their
  reservation;
- both financial events are back, and `reduceLedger` over the *restored* snapshot
  and the *restored* events produces the same balance as before — so a restore
  that recomputed a total, or dropped an event, fails here;
- the pricing snapshot survives with its nested accessory lines intact;
- the issued invoice carries the number it was issued under;
- every audit entry is back, plus exactly one new one for the restore itself;
- `عروس النسخة الاحتياطية` is byte-for-byte identical;
- `pickupAt` is a `Timestamp` and **not a number** — the failure mode where a
  restore looks fine and every date query silently stops matching.

**The wipe goes around the rules on purpose.** The rules refuse a client delete
of reservations, the ledger, invoices and audit logs, and that refusal is a
property under test elsewhere. Rather than weakening it so a test could tidy up,
the drill empties the collections through the emulator's administrative REST
endpoint — which is closer to what a real disaster looks like anyway. `users` is
left alone, because a backup does not contain it and the restore needs an owner
to authorise it.

### Offline

`connectivity.test.ts` covers the rule as data: fourteen guarded operations, each
with the reason its decision needs the server, and `reconnecting` treated as
offline. The point of asserting the *reason* separately from the *answer* is that
today every answer is the same — a test that only checked "is it allowed" would
pass against a function that ignored its argument.

### Backup validation

`backup.test.ts` (the domain one) covers what a file must not be allowed to be:
a fractional amount, an unsupported schema version, an unknown collection, an
implausible timestamp, a record with no id, a credential in any field. Two
properties are asserted about the validator itself — that it **runs to
completion** and reports every problem rather than the first, and that money is
judged by field *name*, since `3` as a quantity and `3` as baisa are both
integers.

### CSV

`csv.test.ts` covers the format; the emulator suite covers the content.

The one worth naming is **formula injection**: a customer name is free text, and
a spreadsheet executes a cell beginning `=`, `+`, `-`, `@`, tab or carriage
return. `=HYPERLINK(...)` in a customer's name would become a live link in the
accountant's sheet. Cells starting with those characters are prefixed so they are
read as text — *except* plain numbers, because neutralising `-50.000` would turn
every refund into text and make the accountant's `SUM` skip it. Both halves are
asserted; the second is the one a naive fix breaks.

Also asserted: the UTF-8 byte-order mark (without it Excel renders Arabic as
mojibake), CRLF row endings, a header row even for an empty list, and — against
the emulator — that no CSV contains a dress purchase cost, a customer
measurement, or anything resembling a credential.

### Sign-out

`auth.service.test.ts` asserts the three-step teardown and its order: token,
then cache, then a fresh page load — and that the page load happens **even when
clearing the cache throws**, since a cleanup failure must never leave a session
open on a shared tablet. Verified by removing the navigation and watching three
of the four tests fail.

### Errors

`useFriendlyError.test.tsx` asserts that an SDK message is never repeated back to
an employee, that the replacement is in the employee's language, and that an
`AppError` this application raised deliberately keeps its own wording — the three
properties that together decide what a boutique tablet displays when something
goes wrong.

---

## 5. Rules tests (Phase 2)

Full assertion list in [SECURITY.md §8](./SECURITY.md#8-security-testing-56).
Three identities — unauthenticated, STAFF, OWNER — with both allow and **deny**
assertions. A rules suite that only tests the happy path proves nothing; the deny
cases are the point.

---

## 6. Integration tests (§55)

End-to-end through the emulator, exercising real services and real Firestore:

1. Create a dress → verify code `WD-0001` and `Available` status
2. Create a customer → verify code `CU-0001`
3. Create a reservation → verify availability check, snapshot, dress → `Reserved`
4. Record a deposit payment → verify ledger and balance
5. Attempt pickup below threshold → **denied**
6. Pay the remaining balance → pickup allowed → dress → `Out with Customer`
7. Return late with damage → late fee applied, damage logged, dress → `In Cleaning`
8. Settle the deposit with a partial forfeit → invariant holds
9. Issue the invoice → number, totals and snapshots correct
10. Change the VAT rate → **the issued invoice is unchanged**

Step 10 is the regression guard for the historical-integrity requirement (§11, §30).

---

## 7. Component tests

- Every mutation surfaces loading, success and failure (§54)
- Failure preserves form data
- Double submit produces one write
- Empty database renders helpful empty states, never fabricated figures (§51)
- Offline banner appears when offline and no write is reported as synced
- RTL: Arabic renders with `dir="rtl"` and no clipped or mirrored-wrong layout
- No hardcoded English strings — a lint rule plus a test that renders key screens in
  Arabic and asserts no untranslated key markers remain

---

## 8. Print / document tests (Phase 6)

Automated where meaningful, manual where the browser's print pipeline is the
subject:

- Invoice component renders at A4 (210mm × 297mm) with correct margins
- A long reservation flows across pages with no clipped content
- Table headers repeat on continuation pages
- Signature blocks are never orphaned
- Arabic invoices render RTL with correct letter shaping
- Bilingual invoices place both languages without overlap

Cross-browser print verification is a documented manual checklist in `OPERATIONS.md`;
headless print output is not a faithful proxy for what the boutique's printer produces.

---

## 9. Coverage policy

| Area              | Requirement                                      |
| ----------------- | ------------------------------------------------ |
| `src/domain/**`   | 100% branch coverage — non-negotiable            |
| `src/services/**` | Every write path and every failure path          |
| Rules             | Every collection, every role, allow **and** deny |
| Components        | Every mutation's three states                    |

Coverage percentage alone is not the goal. A test that asserts a function was called
proves nothing; tests here assert values, states and denials.

---

## 10. Phase gate (§61)

No phase completes until all of these pass:

```bash
npm run lint
npm run typecheck
npm run test
npm run test:rules       # needs Java + the emulator
npm run test:functions   # needs Java + the emulator
npm run build
```

`npm run verify` chains the four that need no emulator; the two emulator-backed
suites are run separately because they need Java and free ports, which not every
contributor's machine has ready.

Failures are fixed, not skipped or annotated away. `.skip` in a committed test is a
defect unless accompanied by a linked reason in the same commit.


---

## 11. Release severity (Phase 10 §44)

| Level  | Meaning                                                | Ships?                       |
| ------ | ------------------------------------------------------ | ---------------------------- |
| **P0** | Security hole, data loss, or financial corruption      | **Never**                    |
| **P1** | A core workflow is broken                              | **Never**                    |
| **P2** | Major usability problem, or a limit reached at scale   | Owner decides, explicitly    |
| **P3** | Cosmetic or minor                                      | May be deferred and recorded |

A defect's level is decided by what it does to the boutique, not by how hard it
is to fix. The Phase 10 accessory-line defect is the worked example: a one-line
omission in a Function, and P1 — because a tax invoice that charges 84.000 with
nothing to say what it was for is a document the boutique cannot defend.

## 12. The Phase 10 gate

Everything in §10, plus:

```bash
npm run test:functions:e2e       # three complete boutique journeys
npm run test:functions:security  # the denial sweep
```

and the manual checks that no emulator can perform: real devices, a real
printer, a real WhatsApp send, and an installed PWA taking a real update. Those
are listed in the release report and marked **MANUAL VERIFICATION REQUIRED**
until someone has actually done them. A gate that counts an unperformed test as
passed is not a gate.
