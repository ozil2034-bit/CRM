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

Current totals: **377** unit · **662** rules · **31** Functions integration.

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
| Cleaning buffer     | 10–14, buffer 2   | 15–17     | **unavailable** (blocked to 16) |
| Clear of buffer     | 10–14, buffer 2   | 17–19     | available                       |
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

- `refunded + forfeited ≤ original` — property-tested across random splits
- Refunding more than held is rejected
- Forfeiting after a full refund is rejected
- Status derives correctly: Held / Refunded / Partially Refunded / Forfeited

### 3.6 Late fee (§26)

- On-time and early returns incur no fee
- Late days = `actualReturn − scheduledReturn`, counted in whole days
- Fee = `lateDays × configured daily rate`
- A same-day late return of a few hours is defined explicitly (whole-day rounding
  rule is asserted, not left implicit)
- A zero configured rate yields zero, never `NaN`

### 3.7 Cancellation (§28)

- Tier selection by days between cancellation date and event date
- Boundary days land in the correct tier (off-by-one is the classic failure here)
- Refund amount derives from the **snapshot**, not current pricing
- Cancellation releases availability
- An audit record is produced

### 3.8 Numbering (§5)

- Formatting honours configured prefix, separator and padding
- `WD-0001`, `CU-0001`, `RSV-0001`, `INV-2026-0001`
- Padding overflow (10000th dress) widens rather than truncating
- Invoice numbers include the correct year and reset on 1 January

### 3.9 Reservation lifecycle (§17)

- Every legal transition is accepted
- Every illegal transition is rejected (exhaustive over the status matrix)
- `Cancelled` and `No-Show` are terminal except for defined recovery paths

---

## 4. Service and concurrency tests (Phase 4+)

Run against the Firestore emulator.

**The double-booking test is mandatory** (§19): two concurrent `createReservation`
calls for the same dress and overlapping dates must produce exactly one success and
one conflict. Asserted by firing both without awaiting the first, then checking that
exactly one resolved and exactly one `reservationItem` exists.

Also covered:

- A counter never issues the same number twice under concurrent creation
- A failed entity write does not consume a counter value
- Duplicate `idempotencyKey` produces exactly one payment
- Every audited action writes exactly one audit record with correct before/after

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

No phase completes until all four pass:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

Or simply `npm run verify`.

Failures are fixed, not skipped or annotated away. `.skip` in a committed test is a
defect unless accompanied by a linked reason in the same commit.
