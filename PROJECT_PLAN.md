# Azhary Boutique — Project Plan

**أزهاري بوتيك**

Production wedding dress management platform.

---

## 1. Purpose

Azhary Boutique is an operational platform for a bridal boutique. Real employees will
use it to manage real customers, dress inventory, reservations, fittings, payments,
security deposits and invoices.

It is **not** a demo, not a generic CRM, and not an accounting system. It is a
purpose-built boutique operations tool.

### Success criteria

The system is production-ready when it is:

| Property        | Meaning                                                   |
| --------------- | --------------------------------------------------------- |
| Reliable        | No lost writes, no silent failures, no phantom success    |
| Secure          | Enforced server-side; UI hiding is never the control      |
| Cloud-based     | Firestore is the single source of truth                   |
| Multi-device    | Two employees on two devices see consistent state         |
| Offline-capable | Reads work offline; writes queue and sync                 |
| Bilingual       | Complete English + Arabic with correct RTL                |
| Responsive      | Phone (390–430px), tablet (768–1024px), desktop           |
| Premium         | Feels like a luxury bridal brand, not a SaaS dashboard    |
| Auditable       | Every financially or legally significant change is logged |

---

## 2. Non-negotiable rules

These constraints apply to every phase and every commit.

1. **Firestore is the source of truth.** IndexedDB is a cache. `localStorage` is never
   a database. The database is never one JSON blob.
2. **No business logic in components.** Logic lives in `src/services/*` and
   `src/domain/*`. Components render and dispatch.
3. **No dummy data in production.** Zero seeded dresses, customers, reservations,
   payments, invoices or fittings. Empty database renders helpful empty states.
   Demo data exists only behind `npm run seed:demo`, which never runs automatically.
4. **No invented business information.** VAT number, CR number, address and phone stay
   blank until the owner configures them. Never `OM123456789`. Never `CR-1098234`.
5. **No `allow read, write: if true`.** Ever.
6. **No `array.length + 1` numbering.** Transaction-safe counters only.
7. **Money is integer minor units.** See §5.
8. **A feature is complete only when** UI + business logic + database + persistence +
   error handling + security + tests all work together. Compiling is not completion.

---

## 3. Technology

| Layer        | Choice                                                  | Rationale                                        |
| ------------ | ------------------------------------------------------- | ------------------------------------------------ |
| UI           | React 19 + TypeScript (strict)                          | Team-standard, strong typing                     |
| Build        | Vite 8                                                  | Fast builds, static output for Firebase Hosting  |
| Styling      | Tailwind CSS 4 (CSS-first tokens)                       | Design tokens in one file, no config drift       |
| Routing      | React Router 7                                          | Data router, nested layouts                      |
| Server state | TanStack Query 5                                        | Cache, retry, optimistic updates, offline-aware  |
| Client state | Zustand 5                                               | Small, typed, no boilerplate                     |
| Validation   | Zod 4                                                   | One schema shared by client, Functions and tests |
| Backend      | Firebase (Auth, Firestore, Storage, Functions, Hosting) | Managed, offline-capable, rules-enforced         |
| Tests        | Vitest 4 + Testing Library + Firebase Emulator          | Unit, integration, rules                         |
| Lint/format  | ESLint 9 (flat) + Prettier 3                            | Enforced in the phase gate                       |

**Dependency policy.** Every dependency must earn its place. Notable deliberate
omissions and their replacements:

- **i18n library** → a small typed i18n module. Type-safe keys matter more than
  pluralization machinery we will not use, and it keeps the bundle lean.
- **Date library** → native `Date` + `Intl` in a `src/lib/datetime` module. All
  boutique operations are same-timezone (Asia/Muscat).
- **Component library** → our own design system. A luxury bridal brand cannot look
  like a default component kit.
- **PDF library** → browser print with dedicated A4 print components. Native print
  produces correct Arabic shaping and RTL; JS PDF generators generally do not.

---

## 4. Architecture summary

```
UI (components, pages)
  ↓  no business logic
Application / Service Layer (src/services)
  ↓
Domain (src/domain — pure, deterministic, fully unit-tested)
  ↓
Firebase SDK / Cloud Functions
  ↓
Firestore / Storage / Auth
```

`src/domain` is pure TypeScript with **zero Firebase imports**. Pricing, VAT,
availability, late fees, cancellation tiers and payment eligibility are pure functions
over plain data. This is what makes them exhaustively testable.

Full detail: [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 5. Money — integer minor units

OMR has **3 decimal places**. 1 OMR = 1000 baisa.

**Every monetary value is stored and computed as an integer number of baisa.**

```
OMR 180.000  →  180000 baisa
OMR   5.500  →    5500 baisa
```

Rationale: `0.1 + 0.2 !== 0.3` in IEEE-754. A boutique cannot have invoice totals that
drift by fractions of a baisa. Integers make arithmetic exact.

- Firestore stores integers. Field names carry no unit suffix but the type is
  `Baisa` (a branded `number`), enforced by TypeScript.
- Conversion happens only at the UI boundary: `parseOmr()` on input,
  `formatOmr()` on output.
- Division (VAT, percentages, proration) uses explicit half-up rounding via
  `src/domain/money.ts`. Rounding is applied once, at a defined point, never
  accumulated.
- Display is always 3 decimals: `OMR 180.000`.

---

## 6. Development phases

Each phase ends with the **phase gate** (§7) and at least one Git commit.

| #   | Phase                 | Delivers                                                                                        | Status          |
| --- | --------------------- | ----------------------------------------------------------------------------------------------- | --------------- |
| 1   | Foundation            | Architecture, project setup, design system, Firebase config, documentation                      | Complete        |
| 2   | Identity & security   | Auth, OWNER/STAFF roles, owner bootstrap, Firestore + Storage rules, emulator rules tests       | Complete        |
| 3   | Catalogue             | Dress inventory, customers, CRUD, photo pipeline                                                | Complete        |
| 4   | Reservation engine    | Lifecycle state machine, availability + cleaning buffer, concurrency safety, fittings, waitlist | Complete        |
| 5   | Money                 | Payments, deposits, VAT, pickup threshold, late fees, cancellation, pricing snapshots           | Complete        |
| 6   | Documents             | Invoices, A4 print, T&C versioning, bilingual documents                                         | Complete        |
| 7   | Operations UX         | Dashboard, calendar, reports, sheets, accessories, alterations, global search                   | Complete        |
| 8   | Bilingual & messaging | Arabic, RTL, WhatsApp click-to-chat, templates, communication log, settings                     | **In progress** |
| 9   | Resilience            | Offline persistence, PWA, backup, import/export                                                 | Pending         |
| 10  | Production            | Full QA, security testing, deployment                                                           | Pending         |

### Phase 6 scope

- [x] Invoice, rental agreement and receipt as three templates over ten shared parts
- [x] `INV-YYYY-NNNN` from a per-year transactional counter; idempotent on the request key
- [x] Immutable snapshots: business, logo path, customer, dresses, money, terms
- [x] Figures **copied** from pricing + `reduceLedger`; `reconcileDocument` asserts it
- [x] A4 print CSS, page-break control, repeated table headers, CSS-counter page numbers
- [x] English, Arabic and bilingual, with isolated LTR money inside Arabic text
- [x] Browser print / Save as PDF; no PDF dependency
- [x] Terms versions: structure only, no supplied legal text, immutable once published
- [x] Owner-only business profile, logo upload to Storage, and terms
- [x] Void with a reason; never delete; audit records issue, void and print-initiated
- [x] Concurrency: eight simultaneous issues, eight unique numbers
- [x] Phase gate green

### Phase 7 scope

- [x] Employee dashboard: today's work first, then alerts, then what is coming,
      money last. No KPI row. Correct and honest with zero records.
- [x] Contextual actions per reservation state, with one promoted action
- [x] Calendar: month, week and agenda; six whole weeks; Saturday start; each
      event kind carries a glyph and a named label, never colour alone
- [x] Reservations workspace: status, date-range and text filters; By date and
      By dress groupings; balance and next action on every row
- [x] Customer workspace: bookings, fittings, payment statement, and what she has
      actually paid — not the sum of agreed totals
- [x] Inventory filters built from what the inventory actually contains
- [x] Accessory catalogue, and accessory + alteration capture on a reservation,
      repricing through the one existing `computePricing`
- [x] Amendment refused once an invoice is issued; void and reissue is the path
- [x] Reports: revenue, revenue by dress, most rented, utilisation, outstanding,
      deposits, cancellations, accessory and alteration revenue — all from the
      ledger, with N/A where a figure does not apply
- [x] Printable collection, return, cleaning and alteration sheets on the same A4
      stylesheet as the invoices
- [x] Global search extended to reservations and invoices, grouped by kind
- [x] Responsive navigation: one entry list drives desktop, tablet and a phone
      bottom bar
- [x] Domain suites for operations, utilisation, calendar, accessories,
      amendments and operational reporting
- [x] Emulator suite for the amendment Functions: one engine, the frozen VAT
      rate, idempotency, concurrency, the invoice lock
- [x] Phase gate green

**Explicitly not in Phase 7:** WhatsApp *sending* — the notification surfaces are
prepared, nothing is dispatched (Phase 8); full RTL polish and Arabic review
(Phase 8); CSV export (Phase 9). Nothing is deployed, no production project is
configured, and no production bootstrap token exists.

### Phase 8 scope (current)

- [x] WhatsApp click-to-chat: `wa.me` links through the one phone normaliser,
      whole-body URL encoding, and no control at all without a valid number
- [x] States are `Prepared`, `Opened`, `Copied`. No `Sent`, `Delivered` or
      `Read` exists in the types, in the rules, or in either dictionary
- [x] Nine editable templates, English and Arabic, bilingual as a structure
      rather than a concatenation. No wording supplied.
- [x] A variable the data cannot supply blocks preparation and is named;
      `undefined`, `null` and `NaN` cannot reach a customer
- [x] Template preview against sample values, creating no records
- [x] Communication log: append-only, one entry per explicit action, storing the
      exact message text. Refreshing a page logs nothing.
- [x] Composer on the reservation and on the customer profile
- [x] Complete Arabic UI, with a test that proves it stays complete
- [x] RTL from one `dir` attribute and logical properties; `.numeric`, `.code`
      and `.user-text` handle money, identifiers and mixed content
- [x] Arabic search normalisation re-asserted end to end
- [x] Settings in six tabs, nothing saved on a keystroke, critical changes
      confirmed with a forward-only explanation
- [x] Business profile, logo, VAT, late fee, pickup threshold, cancellation
      scale, cleaning buffer, T&C versioning, reminder preferences
- [x] Staff refused templates, reminders and every financial setting at the
      rules layer
- [x] Phase gate green

**Explicitly not in Phase 8:** the WhatsApp Business API — V1 is click-to-chat
and the vocabulary reflects that; scheduled reminder delivery — there is no cron
or worker in this architecture, so preferences record intent and the dashboard
surfaces what is due; editable record-number prefixes, which need the format
stored per record rather than a settings field; offline and PWA (Phase 9).
Nothing is deployed, no production project is configured, and no production
bootstrap token exists.

---

## 7. Phase gate

No phase is complete, and no phase may begin, until the previous one passes:

```bash
npm run lint        # ESLint, zero errors
npm run typecheck   # tsc --noEmit, zero errors
npm run test        # Vitest, all green
npm run build       # production build succeeds
```

Shortcut: `npm run verify`.

Then: fix errors → review implementation → update documentation → commit.

A phase with unresolved critical errors blocks the next phase.

---

## 8. Git conventions

Small, meaningful, reviewable commits. Conventional Commit prefixes:

```
feat:  new capability
fix:   corrected behaviour
test:  tests only
docs:  documentation only
chore: tooling, config, dependencies
refactor: behaviour-preserving restructure
```

One enormous unreviewable commit is a defect, not a shortcut.

Branch: `claude/azhary-boutique-env-setup-fyoja2`

---

## 9. Environments

| Environment | Firebase project       | Demo data     | Purpose                  |
| ----------- | ---------------------- | ------------- | ------------------------ |
| Local       | Emulator suite         | Allowed       | Development, rules tests |
| Development | `azhary-boutique-dev`  | Allowed       | Shared testing           |
| Production  | `azhary-boutique-prod` | **Forbidden** | Real boutique operations |

Production requires `VITE_DEMO_MODE=false`. The seed command refuses to run when
demo mode is off or when pointed at a non-emulator project.

Configuration and deployment: [DEPLOYMENT.md](./DEPLOYMENT.md) (Phase 2).

---

## 10. Open items requiring boutique input

These are recorded rather than invented. Blank until the owner supplies them.

- Business address (EN / AR)
- Phone, WhatsApp number, email, website
- VAT registration number, CR number
- Logo asset
- VAT rate in force (0% or 5%)
- Late-return daily fee
- Cancellation policy tiers
- Terms & Conditions text (EN / AR)
- Firebase project IDs

The application ships with these unset and prompts the owner during setup.
