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
```

The emulator-backed integration suites run in **separate emulator invocations**,
not merely separate files. Each bootstraps an owner, and owner bootstrap is a
one-time transition — sharing one emulator would make whichever suite ran second
fail against state the first had already consumed.

Current totals: **888** unit · **768** rules · **144** integration.

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
