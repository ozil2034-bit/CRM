# Azhary Boutique · أزهاري بوتيك

Production wedding dress management platform — inventory, customers, reservations,
fittings, payments, security deposits and invoicing for a bridal boutique.

> **This is a production system**, not a demo. It contains no seeded data, no
> placeholder business details and no fabricated figures. Screens are empty until
> real data is entered.

---

## Status

**Phase 3 of 10 complete** — foundation, identity and authorization, and now the
dress inventory, customers, photographs, search and audit trail. 1,256 tests.
The reservation engine begins in Phase 4.

See [PROJECT_PLAN.md](./PROJECT_PLAN.md) for the full phase plan.

---

## Documentation

| Document                             | Contents                                            |
| ------------------------------------ | --------------------------------------------------- |
| [PROJECT_PLAN.md](./PROJECT_PLAN.md) | Scope, phases, non-negotiable rules, open items     |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Layers, directory layout, data flow, decisions      |
| [DATABASE.md](./DATABASE.md)         | Firestore collections, fields, indexes, conventions |
| [SECURITY.md](./SECURITY.md)         | Roles, permission matrix, rules, threat notes       |
| [TESTING.md](./TESTING.md)           | Test layers, required assertions, coverage policy   |
| [DEPLOYMENT.md](./DEPLOYMENT.md)     | Firebase setup, environments, release procedure     |
| [OPERATIONS.md](./OPERATIONS.md)     | Backup, restore, runbooks, manual checklists        |

---

## Requirements

| Tool         | Version                                                        |
| ------------ | -------------------------------------------------------------- |
| Node.js      | ≥ 22.12                                                        |
| npm          | ≥ 10                                                           |
| Firebase CLI | installed locally as a dev dependency — run via `npx firebase` |

---

## Getting started

```bash
npm install

cp .env.example .env.development
# Fill in the Firebase Web configuration from the Firebase console.

npm run dev
```

Without configuration the application starts and displays a setup screen naming
the missing variables — it does not fail with a blank page.

### Local development against the emulator

```bash
npm run emulators     # Auth :9099 · Firestore :8080 · Storage :9199 · UI :4000
```

Set `VITE_USE_EMULATORS=true` in `.env.development` to point the app at it. No live
project data is read or written in this mode.

---

## Commands

| Command                  | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `npm run dev`            | Development server                              |
| `npm run build`          | Type-check and produce a production build       |
| `npm run preview`        | Serve the production build locally              |
| `npm run lint`           | ESLint                                          |
| `npm run typecheck`      | TypeScript, no emit                             |
| `npm run test`           | Unit and component tests                        |
| `npm run test:watch`     | Tests in watch mode                             |
| `npm run test:coverage`  | Coverage report                                 |
| `npm run test:rules`     | Security rules against the emulator             |
| `npm run test:functions` | Cloud Function integration tests                |
| `npm run format`         | Prettier write                                  |
| `npm run emulators`      | Firebase Emulator Suite                         |
| **`npm run verify`**     | **Phase gate: lint + typecheck + test + build** |

`npm run verify` must pass before any phase is considered complete.

---

## Technology

React 19 · TypeScript 6 (strict) · Vite 8 · Tailwind CSS 4 · React Router 7 ·
TanStack Query 5 · Zustand 5 · Zod 4 · Firebase 12 · Vitest 4

---

## Conventions that matter

**Money is integer baisa.** OMR has three decimals; 1 OMR = 1000 baisa. Every
monetary value is an integer, branded as `Baisa` in TypeScript. Floating-point
rials are never stored or computed. See [`src/domain/money.ts`](./src/domain/money.ts).

**Firestore is the source of truth.** IndexedDB offline persistence is a cache.
`localStorage` is not a database and is blocked by lint.

**Business logic lives in `src/domain` and `src/services`, never in components.**
ESLint enforces the boundary: components cannot import the Firebase SDK, and the
domain layer cannot import Firebase, React or services.

**Security is enforced server-side.** Firestore and Storage rules are the control.
Hiding a button is a usability choice with no security value.

**Roles are confirmed twice.** Every request's role must be agreed by both the
Firebase Auth custom claim and the `users/{uid}` document, and the lower of the
two wins — so a demotion applies immediately while a promotion waits for the
token to refresh. `active` is read live from Firestore, so deactivating an
employee takes effect on their very next request rather than when their ID token
expires. See [SECURITY.md §2](./SECURITY.md).

**No demo data in production.** `VITE_DEMO_MODE` must be `false` in production; the
environment validator refuses to start a production build otherwise.

---

## Repository layout

```
src/
  app/            Application shell, router, error boundaries
  design-system/  Tokens and primitives
  components/     Shared composite components
  pages/          Route-level screens
  services/       Application layer — the only code that touches Firebase
  domain/         Pure business logic, exhaustively unit-tested
  schemas/        Zod schemas and inferred types
  lib/            Firebase client, datetime, i18n, utilities
  config/         Environment parsing and validation
  print/          A4 document components
functions/        Cloud Functions for trusted operations
tests/            Integration and security-rules tests
```

---

## Configuration not yet supplied

The following are intentionally blank and must be provided by the boutique before
production use. Nothing here is invented or placeholdered with fake values:

business address (EN/AR) · phone · WhatsApp number · email · website ·
VAT registration number · CR number · logo · VAT rate · late-return daily fee ·
cancellation policy tiers · Terms & Conditions text (EN/AR) · Firebase project IDs
