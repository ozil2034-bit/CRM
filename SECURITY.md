# Azhary Boutique — Security

---

## 1. Principles

1. **Authorisation is enforced server-side.** Firestore Security Rules, Storage
   Rules and Cloud Functions are the controls. Hiding a button is a usability
   choice with **zero** security value — a hidden button is still a reachable
   SDK call.
2. **Deny by default.** Both rules files end with a catch-all denial. A path
   that is not explicitly allowed is unreachable.
3. **`allow read, write: if true` is never written.** Not in development, not
   temporarily, not "just for the emulator".
4. **Roles are confirmed by two independent sources**, and the lower of the two
   wins. See §2.
5. **Financial and legal history is not deletable** — by anyone, including
   OWNER.
6. **A security rule that cannot be tested is not shipped.** Where a stronger
   construct could not be verified in the emulator, the weaker verifiable one
   was chosen and the gap documented rather than hidden (§6).

---

## 2. Identity

Firebase Authentication owns credentials. The application never stores, hashes,
transmits or logs a password. `users/{uid}` contains no credential material, and
an integration test asserts the absence of `password`, `passwordHash`, `salt`
and `token` fields on a freshly created profile.

### Roles

| Role    | Description                                                        |
| ------- | ------------------------------------------------------------------ |
| `OWNER` | Full access, including settings, VAT, business profile, T&C, users |
| `STAFF` | Full day-to-day boutique operations                                |

### Where a role lives — and why in two places

Every request's role is resolved from **both** of:

- the Firebase Auth **custom claim** `{ role, active }`, writable only by the
  Admin SDK inside a Cloud Function; and
- the **`users/{uid}` document**, which no client can write (the rules refuse
  every client write to `users`, including the owner's).

`resolveEffectiveRole` (src/domain/authorization.ts), `effectiveRole`
(functions/src/lib/guards.ts) and `isOwner()` / `isEmployee()`
(firestore.rules) implement the same resolution in the three places it is
needed. They are deliberate mirrors, independently enforced.

**The claim alone is not enough.** Claims are minted into the ID token and stay
valid until it expires — up to an hour. An employee dismissed at 09:00 would
keep full access until 10:00. Firestore therefore reads `active` live from the
user document, and revocation applies on the employee's very next request.

**The document alone is not enough.** A role stored only in a database field is
one rule bug away from being client-writable. The claim is unreachable from any
client under any rule.

**The lower of the two roles wins**, which makes the stale-token window fail
safe in both directions:

| Situation                 | Document | Claim   | Effective | Consequence                           |
| ------------------------- | -------- | ------- | --------- | ------------------------------------- |
| Normal owner              | `OWNER`  | `OWNER` | `OWNER`   | —                                     |
| Normal staff              | `STAFF`  | `STAFF` | `STAFF`   | —                                     |
| Promotion, token stale    | `OWNER`  | `STAFF` | `STAFF`   | Under-privileged until refresh — safe |
| **Demotion, token stale** | `STAFF`  | `OWNER` | `STAFF`   | **Privilege removed immediately**     |
| Deactivated               | inactive | any     | none      | Refused everywhere                    |
| Claim but no profile      | absent   | `OWNER` | none      | Refused everywhere                    |
| Forged claim value        | `STAFF`  | `ADMIN` | none      | Refused everywhere                    |

Every row is covered by tests in `tests/rules/firestore.identity.test.ts`.

### How claims refresh

A role or activation change is applied in three steps by the Cloud Function:

1. The `users/{uid}` document is updated inside a transaction, together with the
   audit record. **Firestore honours this immediately.**
2. `setCustomUserClaims` writes the new claim. It reaches the client on the next
   token refresh.
3. `revokeRefreshTokens` invalidates outstanding refresh tokens, so no further
   ID token can be minted under the old claim. Deactivation additionally sets
   `disabled: true` on the Auth account.

On the client, `refreshIdToken()` calls `getIdToken(true)` after a role change so
the current session picks up the new claim without signing out. The application
also subscribes to the signed-in user's own profile document, so a deactivation
performed on another device changes the interface immediately rather than leaving
a working-looking screen whose writes all fail.

Activation is carried forward on a role change: promoting or demoting a
deactivated employee does not silently restore their access.

### First-owner initialisation

No owner email, password or account is hard-coded or seeded.

1. The client calls `getBootstrapState` — an unauthenticated callable returning a
   single boolean and no business data. This is why no read rule for `system`
   exists anywhere in the database.
2. If no owner exists, the setup screen is shown. The operator creates a Firebase
   Auth account, which on its own grants **nothing**: with no claim and no
   profile, every request is refused.
3. The client calls `claimInitialOwnership` with a **setup token**.
4. The Function opens a Firestore transaction on `system/bootstrap`, re-checks
   every condition server-side, writes the sentinel, the owner profile and an
   audit record atomically, then sets the claim.

**Why a setup token is required.** Firebase email/password sign-up is open by
default, so without a shared secret the bootstrap endpoint grants ownership of
the boutique to whoever reaches the URL first. The specification requires that
only the _intended_ first owner can initialise the business, and a first-come
race does not satisfy that. The token is what makes the caller intended. It is
stored as a Functions secret (`AZHARY_BOOTSTRAP_TOKEN`), never in the browser
bundle, never in this repository.

It is compared in constant time. A naive `===` short-circuits at the first
differing byte, which over many attempts reveals the expected value one
character at a time.

**Why a transaction.** Two operators submitting simultaneously both read the
sentinel, but only one commit succeeds; the loser retries, observes `completed`,
and is refused. Checking "does an owner exist?" outside a transaction is a
time-of-check/time-of-use race that hands out two owners.

**Idempotent replay.** The recorded owner may re-run the call. The claim is
written after the transaction commits, because custom claims cannot participate
in a Firestore transaction; if that step fails, the operator would hold a profile
with no claim and be locked out. Replay repairs it. Any _other_ caller is refused
with `already-exists`.

**The token is checked before bootstrap state is revealed**, so the endpoint does
not become an oracle for "has this boutique been set up yet".

---

## 3. Permission matrix

| Capability                                    |     OWNER     | STAFF | Unauthenticated |
| --------------------------------------------- | :-----------: | :---: | :-------------: |
| Read customers / dresses / reservations       |      ✅       |  ✅   |       ❌        |
| Create & edit customers                       |      ✅       |  ✅   |       ❌        |
| Create & edit dresses                         |      ✅       |  ✅   |       ❌        |
| Read dress purchase cost                      |      ✅       |  ❌   |       ❌        |
| Create & edit reservations                    |      ✅       |  ✅   |       ❌        |
| Change reservation status                     |      ✅       |  ✅   |       ❌        |
| Schedule / edit fittings                      |      ✅       |  ✅   |       ❌        |
| Record payments                               |      ✅       |  ✅   |       ❌        |
| Pickup / return workflows                     |      ✅       |  ✅   |       ❌        |
| Record damage                                 |      ✅       |  ✅   |       ❌        |
| Prepare WhatsApp messages                     |      ✅       |  ✅   |       ❌        |
| Operational reports                           |      ✅       |  ✅   |       ❌        |
| Read settings (VAT rate, thresholds)          |      ✅       |  ✅   |       ❌        |
| Delete a dress / customer / accessory         |      ✅       |  ❌   |       ❌        |
| **Void payments**                             |      ✅       |  ❌   |       ❌        |
| **Delete payments**                           |      ❌       |  ❌   |       ❌        |
| **Delete invoices**                           |      ❌       |  ❌   |       ❌        |
| **Delete reservations**                       |      ❌       |  ❌   |       ❌        |
| **Delete damage evidence**                    |      ❌       |  ❌   |       ❌        |
| **Change VAT settings**                       |      ✅       |  ❌   |       ❌        |
| **Change business profile**                   |      ✅       |  ❌   |       ❌        |
| **Change pricing / cancellation / late fees** |      ✅       |  ❌   |       ❌        |
| **Change numbering settings**                 |      ✅       |  ❌   |       ❌        |
| **Create Terms & Conditions version**         |      ✅       |  ❌   |       ❌        |
| **Modify an existing T&C version**            |      ❌       |  ❌   |       ❌        |
| **Manage users / roles**                      | Function only |  ❌   |       ❌        |
| Read audit logs                               |      ✅       |  ❌   |       ❌        |
| Append audit entries                          |      ✅       |  ✅   |       ❌        |
| Amend or delete audit entries                 |      ❌       |  ❌   |       ❌        |

"Function only" means even the owner cannot do it by writing to Firestore; the
request must go through a Cloud Function, which audits it.

---

## 4. Firestore rules

Structure:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isActive()   { …exists(users/{uid}) && profile().active == true }
    function claimRole()  { request.auth.token.get('role', '') }
    function documentRole() { profile().get('role', '') }
    function isOwner()    { isActive() && claimRole() == 'OWNER' && documentRole() == 'OWNER' }
    function isEmployee() { isActive() && both sources name a defined role }
    function isStaff()    { isEmployee() && !isOwner() }

    // …explicit per-collection rules…

    match /{document=**} { allow read, write: if false; }   // always last
  }
}
```

Per-collection posture:

| Collection             | Read               | Create       | Update                     | Delete    |
| ---------------------- | ------------------ | ------------ | -------------------------- | --------- |
| `system`               | **never**          | **never**    | **never**                  | **never** |
| `users`                | own doc; OWNER all | **never**    | **never**                  | **never** |
| `businessProfile`      | employee           | OWNER        | OWNER                      | never     |
| `settings`             | employee           | OWNER        | OWNER                      | never     |
| `termsVersions`        | employee           | OWNER        | **never**                  | **never** |
| `counters`             | employee           | `current==1` | `+1` exactly               | never     |
| `dresses`              | employee           | employee     | employee                   | OWNER     |
| `dresses/{id}/private` | OWNER              | OWNER        | OWNER                      | OWNER     |
| `customers`            | employee           | employee     | employee                   | OWNER     |
| `reservations`         | employee           | employee     | employee, snapshots frozen | **never** |
| `reservationItems`     | employee           | employee     | employee                   | employee  |
| `fittings`             | employee           | employee     | employee                   | employee  |
| `accessories`          | employee           | employee     | employee                   | OWNER     |
| `waitlist`             | employee           | employee     | employee                   | employee  |
| `payments`             | employee           | employee     | OWNER, void fields only    | **never** |
| `invoices`             | employee           | **never**    | **never**                  | **never** |
| `damageLogs`           | employee           | employee     | employee                   | **never** |
| `notificationLogs`     | employee           | employee     | `openedAt` only            | **never** |
| `auditLogs`            | OWNER              | employee¹    | **never**                  | **never** |

¹ Must be created with `archived: false`, and can never be deleted — archiving
is the only removal, because reservations, payments and invoices reference
customers and that history must stay resolvable.

² Must carry a `code`, which is immutable thereafter: it is how staff identify a
garment and how every future reservation references it.

On `auditLogs`, `actorUid` must equal the caller's uid — an employee cannot
forge an entry attributed to someone else.

### Field-level guards

Rules validate not only _who_ but _what_:

- **`reservations`**: `code`, `pricing`, `termsVersionId`, `termsSnapshot`,
  `businessSnapshot`, `createdAt` and `createdBy` are immutable after creation.
  A later price change, VAT change or business-profile edit cannot reach back
  into an existing reservation.
- **`payments`**: after creation only `voided`, `voidedAt`, `voidedBy`,
  `voidReason` may change, and only by OWNER. `amount` is immutable — a ledger
  whose entries can be edited is not a ledger.
- **`counters`**: `current` must increase by exactly one, so a client cannot
  rewind a sequence and reissue a number an existing invoice already carries.
- **`users`**: no client write path exists at all. Attempting to allow a "safe
  subset" of fields on a privilege-bearing document is a worse design than
  refusing the whole write.
- **`notificationLogs`**: only `openedAt` may change, so the recorded message
  body stays truthful.

---

## 5. Cloud Functions (trusted operations)

| Function                | Why it must be server-side                                                   |
| ----------------------- | ---------------------------------------------------------------------------- |
| `getBootstrapState`     | Avoids any public read rule on the sentinel document                         |
| `claimInitialOwnership` | Grants OWNER; must verify no owner exists, transactionally, once ever        |
| `createEmployee`        | Creates an Auth account and writes a custom claim — impossible from a client |
| `setUserRole`           | Writes custom claims and revokes tokens; audits the change                   |
| `setUserActive`         | Same, plus disabling the Auth account                                        |

Planned for later phases, for the same reason — they cannot be safely
client-authorised even with good rules:

| Function                      | Why                                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createReservation` (Phase 4) | Availability check and booking must be atomic over a **query**; the client SDK cannot read a query inside a transaction, making any client-side check a time-of-check/time-of-use race |
| `issueInvoice` (Phase 6)      | Allocates the invoice number and freezes the document                                                                                                                                  |
| `voidPayment` / `voidInvoice` | Financial reversal with mandatory audit                                                                                                                                                |
| `settleDeposit` (Phase 5)     | Enforces the refund/forfeit invariant with the trusted clock                                                                                                                           |

### Lockout guards

An owner cannot change their own role or deactivate their own account. Role
assignment requires an existing owner, so self-demotion can leave the boutique
with nobody able to reach settings, terms or user management — and no
in-application route back. Recovery would require a developer with Admin SDK
credentials. Enforced in the Function, and mirrored in the interface so the
control is disabled with an explanation rather than failing on click.

---

## 6. Storage rules

```
match /business/logo/{file}          { read: employee; write: owner + valid image; delete: owner }
match /dresses/{dressId}/{size}/{f}  { read: employee; write: employee + valid image; delete: employee }
match /damage/{damageLogId}/{file}   { read: employee; write: employee + valid image; delete: owner }
match /{allPaths=**}                 { read, write: if false }
```

Validated on every write: authentication, role, content-type allow-list and a
10 MB ceiling. SVG is excluded deliberately — it is an image type that can carry
script. Dress images are **not** public: a public bucket would expose the
boutique's entire inventory and any customer-identifying damage photography.

Staff may add damage evidence but not delete it, so the person who recorded a
charge cannot remove what justifies it.

### Documented limitation: Storage identity comes from the claim

The Firestore rules read `active` live from the user document. The Storage rules
**cannot**: `firestore.get()` in Storage rules is valid in production but is not
implemented by the Storage emulator, so every rule using it evaluates to a denial
locally. A rule written that way could never have its ALLOW path tested, and
untestable rules are how a deploy silently breaks every image in the application —
or silently opens the bucket — with a green build either way.

Storage therefore resolves identity from the custom claim, which the emulator
evaluates exactly as production does, and both directions are covered by tests.

**The residual exposure:** a deactivated employee holding an unexpired ID token
can fetch objects whose exact paths they already know, for up to one hour.

**What bounds it:**

1. `setUserActive` writes `active: false` into the claim, so any newly minted
   token is refused.
2. It revokes refresh tokens, so no new ID token can be obtained.
3. It disables the Auth account outright.
4. Object paths are discovered through Firestore
   (`dresses.photos[].storagePath`), and Firestore revokes immediately — so a
   stale token cannot enumerate anything it did not already hold.

All three behaviours are asserted in
`tests/rules/storage.test.ts › documented limitation`, so any change to the
window surfaces as a failing test rather than a silent regression.

Revisit if the Storage emulator gains cross-service support: the stronger
document-based rule is a two-line change.

---

## 7. Client-side hardening

Client checks improve experience; they are never the control.

- `src/domain/authorization.ts` decides what renders. Its header says, in the
  file, that it is not a security control.
- Environment variables are validated at startup with Zod; production refuses to
  start with demo mode or emulators enabled.
- Firebase Web API keys are **not secrets** — they identify the project. No
  service-account key, admin credential or private key is ever placed in `src/`
  or in any `VITE_`-prefixed variable, because everything with that prefix is
  compiled into the public bundle. The bootstrap setup token is a Functions
  secret and never appears client-side.
- Sign-out terminates Firestore and clears its IndexedDB cache, so one
  employee's cached customers and payments do not survive into the next
  employee's session on a shared boutique tablet.
- Sign-in reports the same message for an unknown email and a wrong password;
  distinguishing them would let an attacker enumerate staff accounts. Password
  reset is silent for the same reason.

---

## 8. Security testing

Three suites, all against the emulator.

```bash
npm run test            # 377 unit tests, including the authorization matrix
npm run test:rules      # 662 rules assertions (Firestore + Storage)
npm run test:functions  #  31 Cloud Function integration tests
```

### Identities covered

unauthenticated · signed-in with no claim · STAFF · OWNER · deactivated STAFF ·
deactivated OWNER · deactivated with a stale token · demoted owner with a stale
OWNER claim · promoted staff awaiting refresh · valid claim with no profile ·
forged role value.

### Required assertions — all present and passing

- Unauthenticated reads and writes fail on **every** collection.
- STAFF can create customers, dresses, reservations, fittings and payments.
- STAFF writing `settings/app` **fails** — including every individual setting:
  VAT rate, pickup threshold, late fee, cancellation tiers, numbering.
- STAFF writing `businessProfile/main` **fails**.
- STAFF creating or modifying `termsVersions` **fails**.
- STAFF deleting a payment **fails**; **OWNER deleting a payment also fails**.
- STAFF deleting an invoice **fails**; **OWNER deleting an invoice also fails**.
- Creating or modifying an issued invoice **fails for every role**.
- STAFF granting themselves OWNER **fails**; so does modifying another user's
  role, and so does the OWNER writing `users` directly.
- STAFF reading `auditLogs` **fails**; amending or deleting an audit entry
  **fails for every role**; forging an entry attributed to another actor
  **fails**.
- STAFF reading `dresses/{id}/private/cost` **fails**.
- Mutating `reservations.pricing`, `termsSnapshot` or `businessSnapshot` after
  creation **fails for every role**.
- Deleting a reservation **fails for every role**.
- A deactivated user is denied everywhere, immediately, on the same token.
- A demoted owner with a stale OWNER claim is denied every owner operation.
- A valid claim with no profile grants nothing, and cannot create its own
  profile to satisfy the check.
- Unauthenticated Storage read and write **fail**; non-image and SVG uploads
  **fail**; undeclared Storage paths **fail** for every role.

### Bootstrap assertions

| Case                                       | Expected                   | Where             |
| ------------------------------------------ | -------------------------- | ----------------- |
| First owner, correct token                 | ALLOW                      | guards + emulator |
| Second owner bootstrap                     | DENY `already-exists`      | guards + emulator |
| Unauthenticated bootstrap                  | DENY `unauthenticated`     | guards + emulator |
| Wrong / missing setup token                | DENY                       | guards + emulator |
| No token configured on the deployment      | DENY                       | guards            |
| Replay by the recorded owner               | ALLOW (idempotent)         | guards + emulator |
| Non-owner claiming OWNER via `setUserRole` | DENY `permission-denied`   | emulator          |
| Client modifying its own role in Firestore | DENY                       | rules + emulator  |
| Client modifying another user's role       | DENY                       | rules + emulator  |
| Client writing the bootstrap sentinel      | DENY                       | rules + emulator  |
| Owner changing their own role              | DENY `failed-precondition` | guards + emulator |
| Owner deactivating themselves              | DENY `failed-precondition` | guards + emulator |

### Audit assertions

Role changes and deactivations record actor, target, old value, new value,
server timestamp and reason. Verified against real Firestore writes in the
Functions integration suite.

---

## 9. Operational security

- Three isolated Firebase projects: local emulator, development, production.
  Production credentials are never used in development.
- Production requires `VITE_DEMO_MODE=false`; the environment validator refuses
  to start otherwise.
- `AZHARY_BOOTSTRAP_TOKEN` is set as a Functions secret before first run and
  rotated afterwards; it is single-use in effect, since bootstrap can only
  complete once.
- Firestore daily backups are enabled in production; restore is rehearsed and
  documented in `OPERATIONS.md`.

---

## 10. Threat notes

| Threat                                   | Mitigation                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| Staff escalating to owner                | Claims are Function-only; `users` is unwritable by every client                       |
| Stranger claiming ownership at first run | Setup token, constant-time compared, plus a transactional one-time sentinel           |
| Two people bootstrapping simultaneously  | Firestore transaction on `system/bootstrap` — one commit wins                         |
| Dismissed employee retaining access      | `active` read live from Firestore; tokens revoked; Auth account disabled              |
| Demoted owner acting on a stale token    | Effective role is the lower of claim and document                                     |
| Owner locking the boutique out of itself | Self-demotion and self-deactivation refused in the Function and the UI                |
| Deleting evidence of a refund            | Payments and invoices undeletable; void preserves the record                          |
| Altering an issued invoice               | No client write path at all; all figures are snapshots                                |
| Retroactive VAT change                   | Rate and amount stored per invoice, never referenced                                  |
| Forged audit entries                     | `actorUid` must equal the caller; entries are append-only                             |
| Leaked inventory or customer photos      | Storage is authenticated-only; no public read                                         |
| Staff account enumeration                | Sign-in and reset return identical messages regardless of account existence           |
| Stale session on a shared tablet         | Sign-out clears persistence, query cache and app state                                |
| Secrets in the bundle                    | Only `VITE_`-prefixed public config is bundled; the setup token is a Functions secret |
