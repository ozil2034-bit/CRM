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
| 1   | Foundation            | Architecture, project setup, design system, Firebase config, documentation                      | **In progress** |
| 2   | Identity & security   | Auth, OWNER/STAFF roles, owner bootstrap, Firestore + Storage rules, emulator rules tests       | Pending         |
| 3   | Catalogue             | Dress inventory, customers, CRUD, photo pipeline, QR codes                                      | Pending         |
| 4   | Reservation engine    | Lifecycle state machine, availability + cleaning buffer, concurrency safety, fittings, waitlist | Pending         |
| 5   | Money                 | Payments, deposits, VAT, pickup threshold, late fees, cancellation, pricing snapshots           | Pending         |
| 6   | Documents             | Invoices, A4 print, T&C versioning, bilingual documents                                         | Pending         |
| 7   | Operations UX         | Dashboard, calendar, reports, CSV export, global search                                         | Pending         |
| 8   | Bilingual & messaging | Arabic, RTL, WhatsApp click-to-chat, notification log                                           | Pending         |
| 9   | Resilience            | Offline persistence, PWA, backup, import/export                                                 | Pending         |
| 10  | Production            | Full QA, security testing, deployment                                                           | Pending         |

### Phase 1 scope (current)

- [x] Repository, branch, Node/tooling verification
- [ ] `PROJECT_PLAN.md`, `ARCHITECTURE.md`, `DATABASE.md`, `SECURITY.md`, `TESTING.md`
- [ ] Vite + React + TypeScript (strict) project skeleton
- [ ] ESLint (flat config), Prettier, Vitest
- [ ] Design system: tokens, typography, primitives
- [ ] Money domain module + tests (foundation for all later phases)
- [ ] Firebase project configuration files, emulator suite, rules skeleton in
      **deny-by-default** posture
- [ ] Environment configuration with runtime validation
- [ ] Phase gate green

**Explicitly not in Phase 1:** authentication logic, any Firestore reads/writes,
any business screens. Phase 1 builds the ground the rest stands on.

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
