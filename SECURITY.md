# Azhary Boutique — Security

---

## 1. Principles

1. **Authorisation is enforced server-side.** Firestore Security Rules, Storage Rules
   and Cloud Functions are the controls. Hiding a button is a usability choice with
   **zero** security value — a hidden button is still a reachable SDK call.
2. **Deny by default.** The rules file ends with a catch-all denial. A collection
   that is not explicitly allowed is unreachable.
3. **`allow read, write: if true` is never written.** Not in development, not
   temporarily, not "just for the emulator". The emulator is where role behaviour is
   tested; open rules there would test nothing.
4. **The role claim is the authority.** Firestore role fields are display mirrors.
5. **Financial and legal history is not deletable** — by anyone, including OWNER.

---

## 2. Identity

Firebase Authentication owns credentials. The application never stores, hashes,
transmits or logs a password, and `users/{uid}` contains no credential material (§8).

### Roles

| Role    | Description                                                        |
| ------- | ------------------------------------------------------------------ |
| `OWNER` | Full access, including settings, VAT, business profile, T&C, users |
| `STAFF` | Full day-to-day boutique operations                                |

Roles are carried in a **Firebase Auth custom claim**:

```json
{ "role": "STAFF", "active": true }
```

Claims are set **only** by a Cloud Function using the Admin SDK. No client path can
write a claim. Rules read `request.auth.token.role`, never a Firestore document, which
also avoids an extra document read on every rule evaluation.

A user disabled by the owner gets `active: false`; rules reject every request from an
inactive user, and the claim is refreshed so the change takes effect on next token
refresh (≤1 hour, or immediately via forced token refresh on the client).

### First-owner initialisation (§8)

No owner email or password is hard-coded, and no owner account is seeded.

1. On first launch, the app calls a callable Function `checkBootstrapState`.
2. The Function reports whether any user carries the `OWNER` claim.
3. If none exists, the setup screen is shown; the operator creates an account with
   Firebase Auth (email + password, or a provider).
4. The client calls `claimInitialOwnership`. The Function **re-verifies server-side**
   that no OWNER exists, then grants the claim to the caller and writes
   `users/{uid}` and an audit record.
5. Every subsequent call fails — the bootstrap is a one-time transition guarded by a
   Firestore transaction on a `bootstrap` sentinel document, so two simultaneous
   callers cannot both become owner.

The client-side check in step 2 is a UX affordance. Step 4's server-side re-check is
the actual control.

---

## 3. Permission matrix (§6)

| Capability                                     |     OWNER     |     STAFF     | Unauthenticated |
| ---------------------------------------------- | :-----------: | :-----------: | :-------------: |
| Read customers / dresses / reservations        |      ✅       |      ✅       |       ❌        |
| Create & edit customers                        |      ✅       |      ✅       |       ❌        |
| Create & edit dresses                          |      ✅       |      ✅       |       ❌        |
| Read dress purchase cost                       |      ✅       |      ❌       |       ❌        |
| Create & edit reservations                     |      ✅       |      ✅       |       ❌        |
| Change reservation status                      |      ✅       |      ✅       |       ❌        |
| Schedule / edit fittings                       |      ✅       |      ✅       |       ❌        |
| Record payments                                |      ✅       |      ✅       |       ❌        |
| Pickup / return workflows                      |      ✅       |      ✅       |       ❌        |
| Record damage                                  |      ✅       |      ✅       |       ❌        |
| Prepare WhatsApp messages                      |      ✅       |      ✅       |       ❌        |
| Operational reports                            |      ✅       |      ✅       |       ❌        |
| **Void / delete payments**                     |   Void only   |      ❌       |       ❌        |
| **Void / delete invoices**                     |   Void only   |      ❌       |       ❌        |
| **Delete financial history**                   |      ❌       |      ❌       |       ❌        |
| **Change VAT settings**                        |      ✅       |      ❌       |       ❌        |
| **Change business profile**                    |      ✅       |      ❌       |       ❌        |
| **Change global pricing / numbering settings** |      ✅       |      ❌       |       ❌        |
| **Edit Terms & Conditions**                    |      ✅       |      ❌       |       ❌        |
| **Manage users / roles**                       |      ✅       |      ❌       |       ❌        |
| **Financial reports (revenue, cost)**          |      ✅       |      ❌       |       ❌        |
| Read audit logs                                |      ✅       |      ❌       |       ❌        |
| Write audit logs                               | Function only | Function only |       ❌        |

"Void only" means even the owner cannot destroy a record; voiding preserves it with a
reason and is itself audited.

---

## 4. Firestore rules structure

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isSignedIn()  { return request.auth != null; }
    function isActive()    { return isSignedIn() && request.auth.token.active == true; }
    function role()        { return request.auth.token.role; }
    function isOwner()     { return isActive() && role() == 'OWNER'; }
    function isStaff()     { return isActive() && role() == 'STAFF'; }
    function isEmployee()  { return isOwner() || isStaff(); }

    // …explicit per-collection rules…

    match /{document=**} {
      allow read, write: if false;   // deny by default
    }
  }
}
```

Per-collection posture:

| Collection             | Read               | Create            | Update                    | Delete    |
| ---------------------- | ------------------ | ----------------- | ------------------------- | --------- |
| `users`                | own doc; OWNER all | Function          | Function (role/active)    | Function  |
| `businessProfile`      | employee           | OWNER             | OWNER                     | never     |
| `settings`             | employee           | OWNER             | OWNER                     | never     |
| `counters`             | employee           | guarded           | +1 only, guarded          | never     |
| `dresses`              | employee           | employee          | employee                  | OWNER     |
| `dresses/{id}/private` | OWNER              | OWNER             | OWNER                     | OWNER     |
| `customers`            | employee           | employee          | employee                  | OWNER     |
| `reservations`         | employee           | employee          | employee (guarded fields) | never     |
| `reservationItems`     | employee           | employee          | employee                  | employee  |
| `fittings`             | employee           | employee          | employee                  | employee  |
| `accessories`          | employee           | employee          | employee                  | OWNER     |
| `payments`             | employee           | employee          | void fields only, OWNER   | **never** |
| `invoices`             | employee           | Function          | Function                  | **never** |
| `damageLogs`           | employee           | employee          | employee                  | never     |
| `waitlist`             | employee           | employee          | employee                  | employee  |
| `notificationLogs`     | employee           | employee          | `openedAt` only           | never     |
| `auditLogs`            | OWNER              | employee (append) | **never**                 | **never** |
| `termsVersions`        | employee           | OWNER             | **never**                 | never     |

### Field-level guards

Rules validate not just _who_ but _what_:

- `reservations`: `pricing`, `termsSnapshot`, `businessSnapshot` and `code` are
  immutable after creation — `request.resource.data.pricing == resource.data.pricing`.
- `payments`: after creation only `voided`, `voidedBy`, `voidedAt`, `voidReason` may
  change, and only by OWNER. `amount` is immutable.
- `deposit`: `refundedAmount + forfeitedAmount <= originalAmount` is asserted in the
  rule, not only in application code.
- `users`: clients may never write `role` or `active`.
- `settings`: staff writes are rejected outright.
- `counters`: `request.resource.data.current == resource.data.current + 1`.

Enforcing the deposit invariant in rules matters because it is a money-conservation
property. If a bug in the client ever tried to refund more than was held, the database
refuses the write.

---

## 5. Cloud Functions (trusted operations)

Operations that cannot be safely client-authorised, even with good rules:

| Function                      | Why it must be server-side                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `claimInitialOwnership`       | Grants OWNER; must verify no owner exists, transactionally                                                              |
| `setUserRole`                 | Writes custom claims — impossible from a client                                                                         |
| `createReservation`           | Availability check + booking must be one atomic operation over a **query**; client SDK transactions cannot read queries |
| `issueInvoice`                | Allocates the invoice number and freezes the document immutably                                                         |
| `voidPayment` / `voidInvoice` | Financial reversal with mandatory audit                                                                                 |
| `settleDeposit`               | Enforces the refund/forfeit invariant with the trusted clock                                                            |
| `processWaitlist`             | Triggered on availability change; runs with elevated read scope                                                         |

`createReservation` is the critical one. The client SDK cannot run a query inside a
transaction, so a client-side availability check is inherently a
time-of-check/time-of-use race. The Admin SDK **can** query inside a transaction, so
the Function re-queries blocking intervals and commits the booking atomically. Two
employees reserving the same dress for overlapping dates: one succeeds, one receives a
conflict error naming the clashing reservation (§19).

---

## 6. Storage rules (§57)

```
match /dresses/{dressId}/{size}/{file} {
  allow read:   if isEmployee();
  allow write:  if isEmployee()
                && request.resource.size < 10 * 1024 * 1024
                && request.resource.contentType.matches('image/(jpeg|png|webp)');
  allow delete: if isEmployee();
}
match /business/logo/{file} { allow read: if isEmployee(); allow write: if isOwner() && …; }
match /damage/{damageLogId}/{file} { allow read, write: if isEmployee() && …; }
match /{allPaths=**} { allow read, write: if false; }
```

Validated on every write: authentication, role, content type allow-list, size ceiling,
and path. Content type is checked against an allow-list rather than a deny-list so a
novel type cannot slip through.

Dress images are **not** public. A public bucket would expose the boutique's entire
inventory and any customer-identifying damage photographs.

---

## 7. Client-side hardening

Client checks improve experience; they are never the control.

- Environment variables are validated at startup with Zod; a missing Firebase key
  fails loudly rather than producing confusing runtime errors.
- Firebase Web API keys are **not secrets** — they identify the project. Security
  comes from rules. No service-account key, admin credential or private key is ever
  placed in `src/` or in any `VITE_`-prefixed variable, because everything with that
  prefix is compiled into the public bundle.
- `.env*` files are git-ignored except `.env.example`, which contains only key names.
- No sensitive data is cached in the service worker (§53): the offline shell caches
  application assets only. Firestore's own IndexedDB persistence holds business data
  and is cleared on sign-out.
- Sign-out clears Firestore persistence, TanStack Query cache and Zustand state, so a
  shared boutique tablet does not leak one session's data into the next.

---

## 8. Security testing (§56)

Every rule is tested against the emulator with `@firebase/rules-unit-testing`, for
three identities: **unauthenticated**, **STAFF**, **OWNER**.

Required assertions:

- Unauthenticated reads of `dresses`, `customers`, `reservations`, `payments`,
  `invoices`, `settings` and `auditLogs` **fail**.
- Unauthenticated writes anywhere **fail**.
- STAFF can create a customer, dress, reservation, fitting and payment.
- STAFF writing `settings/app` **fails**.
- STAFF writing `businessProfile/main` **fails**.
- STAFF writing `termsVersions` **fails**.
- STAFF deleting a payment **fails**.
- STAFF deleting an invoice **fails**.
- STAFF writing `users/{uid}.role` **fails**.
- STAFF reading `auditLogs` **fails**.
- STAFF reading `dresses/{id}/private/cost` **fails**.
- OWNER deleting a payment **fails** (nobody may delete financial history).
- OWNER updating an issued invoice **fails**.
- Updating an `auditLogs` document **fails** for every role.
- Mutating `reservations.pricing` after creation **fails**.
- A deposit settlement exceeding `originalAmount` **fails**.
- An inactive user (`active: false`) is denied everywhere.

Tests run in CI against the emulator. A rules change that breaks any assertion fails
the build.

---

## 9. Operational security

- Three isolated Firebase projects: local emulator, development, production.
  Production credentials are never used in development, and demo data never touches
  production (§58).
- Production requires `VITE_DEMO_MODE=false`; the seed script refuses to run unless
  it is pointed at the emulator.
- Firestore daily backups are enabled in production; restore is rehearsed and
  documented in `OPERATIONS.md`.
- Audit logs give a complete who/when/what/before/after trail for every financially
  or legally significant change (§50).
- Dependencies are kept current; `npm audit` runs in CI.

---

## 10. Threat notes

| Threat                                    | Mitigation                                                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| Staff escalating to owner                 | Claims are Function-only; `users.role` is unwritable by clients and is a display mirror |
| Double booking one dress                  | Admin-SDK transaction re-queries blocking intervals and commits atomically              |
| Duplicate payment on retry / double click | Unique `idempotencyKey` enforced in the transaction                                     |
| Deleting evidence of a refund             | Payments and invoices are undeletable; void preserves the record                        |
| Altering an issued invoice                | Rules deny update; all figures are snapshots                                            |
| Retroactive VAT change                    | Rate and amount stored per invoice, never referenced                                    |
| Refunding more than the deposit held      | Invariant asserted in domain, service **and** rules                                     |
| Leaked inventory or customer photos       | Storage is authenticated-only; no public read                                           |
| Stale session on a shared tablet          | Sign-out clears persistence, query cache and app state                                  |
| Secrets in the bundle                     | Only `VITE_`-prefixed public config is bundled; admin keys never leave Functions        |
