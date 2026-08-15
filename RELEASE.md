# Azhary Boutique — Release Record

---

## 1. Release candidate

| Field                  | Value                                                        |
| ---------------------- | ------------------------------------------------------------ |
| Application version    | `0.9.0`                                                       |
| Git commit             | `e88f495` (the commit adding this record; gate ran at `764e5ac`) |
| Branch                 | `claude/azhary-boutique-env-setup-fyoja2`                     |
| Gate run               | 2026-08-15                                                    |
| Node / npm             | 22.22.2 / 10.9.7                                              |
| Environment tested     | **Local Firebase Emulator Suite only** (`demo-azhary-functions`) |
| Production project     | **Not configured.** No project id, no hosting site, no secret |
| Bootstrap token        | **Not configured.** Emulator uses `emulator-setup-token`      |
| Deployed               | **No.** Nothing has been deployed anywhere                    |

The version is `0.9.0` and not `1.0.0` deliberately: `1.0.0` is the version that
runs the boutique, and this candidate has not been on a real device, a real
printer or a real phone. It becomes `1.0.0` when §7 below is closed out.

---

## 2. Automated gate (§2) — PASS

Every command run at the commit above.

| Command                  | Result | Files | Assertions |
| ------------------------ | ------ | ----- | ---------- |
| `npm run lint`           | PASS   | —     | 0 errors, 0 warnings |
| `npm run typecheck`      | PASS   | —     | app + functions, 0 errors |
| `npm run test`           | PASS   | 44    | **1,452** |
| `npm run test:rules`     | PASS   | 8     | **817**   |
| `npm run test:functions` | PASS   | 9     | **292**   |
| `npm run build`          | PASS   | —     | 31 precache entries, 1,850.87 KiB |

**Total: 2,561 automated assertions, all passing.**

`test:functions` breakdown: auth-flow 31 · catalogue 16 · reservations 37 ·
payments 60 · documents 38 · amendments 22 · backup 32 · release-e2e 35 ·
security-audit 21.

### Flakiness (§2)

Repeated runs, same commit, no failures and no variation:

| Suite            | Runs | Result             |
| ---------------- | ---- | ------------------ |
| Unit             | 3    | 1,452 every run    |
| Rules            | 2    | 817 every run      |
| release-e2e      | 2    | 35 every run       |
| security-audit   | 2    | 21 every run       |
| backup           | 3    | stable (Phase 9)   |

No test was changed to make the gate green. Two suites were **added**, and one
application defect was fixed — see §4.

---

## 3. Full regression (§3)

Every Phase 1–9 capability is covered by the suites above and was re-run at this
commit.

| Capability        | Where it is proven                                    |
| ----------------- | ----------------------------------------------------- |
| Authentication    | auth-flow (31) · security-audit §20                   |
| Authorization     | rules/identity + authorization (138) · security-audit |
| Inventory         | catalogue-crud · rules/catalogue · release-e2e        |
| Customers         | catalogue-crud · release-e2e (all three journeys)     |
| Reservations      | reservations (37) · release-e2e                       |
| Availability      | reservations · release-e2e (double-booking refused)   |
| Cleaning buffer   | reservations · release-e2e (dress held after return)  |
| Fittings          | reservations · release-e2e                            |
| Accessories       | amendments · release-e2e · **documents (new)**        |
| Alterations       | amendments · release-e2e · **documents (new)**        |
| Payments          | payments (60) · release-e2e                           |
| VAT               | domain/reservation-pricing · release-e2e (to the baisa)|
| Deposits          | payments · release-e2e (forfeit + refund)             |
| Refunds           | payments · security-audit (owner-only)                |
| Invoices          | documents (38) · release-e2e                          |
| Receipts          | documents                                             |
| Agreements        | documents · release-e2e                               |
| Reports           | domain/financial-reporting + operational-reporting     |
| WhatsApp          | domain/whatsapp · release-e2e (EN + AR)               |
| Arabic            | i18n/dictionary coverage · release-e2e journey B      |
| RTL               | dictionary + print components                          |
| PWA               | build artefacts (§8 below)                            |
| Offline           | domain/connectivity · **services/offline-guard (new)**|
| Backup            | domain/backup · backup suite                          |
| Restore           | backup suite · **interrupted restore (new)**          |
| Audit             | release-e2e · security-audit §18                      |

---

## 4. Release-gate findings

### P1 — FIXED: issued documents omitted their accessory and alteration lines

Found by the §4 end-to-end journey, the first test to invoice a reservation that
had been amended.

A reservation carrying two accessories (OMR 59.000) and an alteration
(OMR 25.000) was invoiced. The invoice's `financials` charged for both. Its
`accessories` and `alterations` arrays were **empty**, and the printed document
showed two category subtotals with no line items. The customer's total was
correct; 84.000 of it had nothing behind it.

**Why nine phases missed it.** When documents were built in Phase 6 a reservation
could not *have* an accessory — amendments arrived in Phase 7 — so an empty array
was correct. Phase 7 tested repricing; the documents suite kept issuing documents
for reservations with no amendments. Neither side was wrong on its own. The seam
between them had no test until one journey ran through both.

**Severity.** P1, not P2: an immutable tax invoice that cannot say what it
charged for is not a document the boutique can defend to a bride four months
later, and the snapshot the architecture treats as evidence was provably
incomplete.

**Fixed** in `functions/src/documents.ts` (read both line sets off the frozen
pricing snapshot) and `src/print/parts.tsx` (a new `AmendmentLines` part on the
tax invoice and the rental agreement, in whichever language the document is in).
Guarded twice — the emulator journey and the print suite — and both were
confirmed to fail without the fix.

**Already-issued documents are not backfilled.** They are immutable by design.
In a live boutique this would mean documents issued before this fix stay as they
were; the boutique has issued none, because nothing has been deployed.

### P2 — ACCEPTED: operational screens read whole collections

`observeLiveReservations` (dashboard, reservations list, reports, sheets) joins
two unbounded listeners: every reservation and every financial event.
`observeCustomers` and `observeDresses` are likewise unbounded, and customer
search runs client-side over the full list.

| Records                    | Reads on dashboard mount | Assessment            |
| -------------------------- | ------------------------ | --------------------- |
| Year 1 (~200 reservations) | ~1,500                   | Unnoticeable          |
| Year 3 (~700)              | ~5,000                   | Slower first paint    |
| Year 5 (~1,200)            | ~9,000                   | Noticeable on a phone |
| Year 10 (~2,500)           | ~20,000                  | Needs fixing          |

Firestore's persistent cache absorbs most of this in steady state; the full read
happens on a device's first sync and after each sign-out, which clears the cache.
On a shared tablet signed in and out several times a day, that is the case that
bites first.

**Not fixed, deliberately.** The boutique starts with zero records and this does
not bite for years. The fix — date-windowing the dashboard query and paginating
two lists — is a behaviour change to four screens, and a release gate is the
wrong moment for it. Recorded in ARCHITECTURE.md §11e with the threshold and the
remedy. **Owner decision** per §44.

### P3 — ACCEPTED: transitive `uuid` advisory in the Functions runtime

7 moderate advisories, one root cause: `uuid@9.0.1` reached through
`@google-cloud/storage` → `teeny-request`, inside Google's own transport layer.
Our code never calls `uuid`. `npm audit fix --force` proposes downgrading
`firebase-admin` to 10.3.0 and `firebase-functions` to 4.9.0, which would remove
years of security fixes and the v2 API this codebase is built on — that is not a
fix and was not taken. `firebase-admin` was moved 13.10 → 14.2, which cleared two
of the nine.

### Documentation defects — FIXED

Found while auditing for §42, all corrected:

- ARCHITECTURE described a TanStack Query + Zustand data layer, and `src/stores`
  and `src/types` directories. **None existed.** The two packages were installed
  and imported nowhere; both removed.
- DEPLOYMENT described a guarded `npm run seed:demo` "added in Phase 3". **It was
  never written.** That is the better outcome, and now says so.
- OPERATIONS claimed CSV export existed before it did (built in Phase 9).
- ESLint version stated as 9; it is 10.

---

## 5. Security audit (§16–§21) — PASS

| Check                                          | Result | Evidence                              |
| ---------------------------------------------- | ------ | ------------------------------------- |
| Unauthenticated read, every collection         | DENIED | security-audit, swept over 18 names   |
| Unauthenticated write, every collection        | DENIED | security-audit                        |
| Unauthenticated call, 16 privileged Functions  | DENIED | security-audit                        |
| Staff → refund / reverse / settle deposit      | DENIED | `permission-denied`, at the callable  |
| Staff → createEmployee / setUserRole / setUserActive | DENIED | `permission-denied`             |
| Staff → restoreBackupChunk / finishRestore     | DENIED | `permission-denied`                   |
| Staff → VAT, late fee, cancellation scale      | DENIED | rules                                 |
| Staff → business profile, logo, T&C            | DENIED | rules                                 |
| Staff → delete financial event / audit entry   | DENIED | rules                                 |
| Staff → forge a financial event                | DENIED | rules                                 |
| Staff → read audit log                         | DENIED | rules (stricter than expected)        |
| Staff → read dress purchase cost               | DENIED | rules                                 |
| **Owner** → modify or delete an issued invoice | DENIED | rules                                 |
| **Owner** → edit or delete a financial event   | DENIED | rules                                 |
| **Owner** → edit or delete an audit entry      | DENIED | rules                                 |
| **Owner** → write a user document directly     | DENIED | rules                                 |
| **Owner** → demote or deactivate themselves    | DENIED | `failed-precondition` (lockout guard) |
| Deactivated employee, next request             | DENIED | security-audit §20                    |
| Deny-by-default catch-all                      | PASS   | rules/deny-by-default                 |

Two things the audit established that were not previously proven:

1. **Restore is owner-only at the callable level**, not merely hidden in the
   interface. It was untested there before this gate.
2. **Staff cannot list `auditLogs` at all** — stricter than the audit assumed.
   An audit trail its own subjects can read is a trail they can check their
   tracks against.

### Storage (§19)

33 assertions in `tests/rules/storage.test.ts`: authorised upload, unauthorised
upload, read, unauthorised read, invalid content type (SVG refused — it is an
image format that can carry script), oversized file. No public read, no public
write.

**Known token-window limitation, carried forward from Phase 2 and unchanged
(§19).** The Firestore rules read `active` live from the user document; the
Storage rules **cannot**. `firestore.get()` inside a Storage rule is valid in
production but is not implemented by the Storage emulator, so any rule using it
evaluates to a denial locally and its ALLOW path could never be tested. An
untestable rule is how a deploy silently breaks every image — or silently opens
the bucket — with a green build either way. Storage therefore resolves identity
from the **custom claim**, which the emulator evaluates exactly as production
does.

*The residual exposure:* a deactivated employee holding an unexpired ID token can
fetch objects whose exact paths they already know, for up to one hour.

*What bounds it:* `setUserActive` writes `active: false` into the claim so any
newly minted token is refused; it revokes refresh tokens so no new ID token can
be obtained; it disables the Auth account; and object paths are discovered
through Firestore, which revokes immediately — so a stale token cannot enumerate
anything it did not already hold.

All of that is asserted in `tests/rules/storage.test.ts › documented limitation`,
so a change to the window surfaces as a failing test rather than a silent
regression. Full reasoning in SECURITY.md §6. Revisit if the Storage emulator
gains cross-service support: the stronger document-based rule is a two-line
change.

### Secrets (§45)

- No API key, private key or service-account JSON anywhere in the repository.
- No `.env` file is tracked; only `.env.example`, which contains placeholders
  and a warning.
- The only token literal in the tree is `emulator-setup-token`, used by the
  emulator suites against the `demo-azhary-functions` project.
- A production build **refuses to start** if configuration still contains
  `REPLACE_WITH`, `your-project`, `changeme`, `placeholder`, `todo` or `xxxx`.

---

## 6. End-to-end results (§4, §5, §6, §7) — PASS

`tests/functions-emulator/release-e2e.test.ts`, 35 assertions across three
complete journeys sharing one database.

**Journey A — English, full lifecycle (§4).** Owner signs in → customer (a
five-part Omani name) → two dresses → availability confirmed → reservation →
a competing booking of the same gown refused → two accessories and an
alteration → VAT reconciled to the baisa → fitting scheduled → security deposit
+ two payments → a double-tapped payment collapsed → tax invoice (figures
matched against the ledger) → rental agreement → WhatsApp message prepared with
no gaps → pickup (dresses *Out with Customer*) → **late** return → late fee at
the frozen daily rate → second late-fee attempt refused → damage recorded →
dresses *In Cleaning* and not released early → deposit part-forfeited for the
damage and the balance refunded → over-refund refused → balance settled →
reservation *Closed* → **every baisa reconciled by an independent sum** → audit
trail complete → customer and dress histories → reports → invoice still
immutable.

**Journey B — Arabic (§5).** Arabic customer (`عائشة بنت سعيد بن محمد الفارسي
المعمري`) and an Arabic-named gown, both stored byte-for-byte. Arabic tax
invoice with every Arabic snapshot field populated and Arabic terms. Money
rendered in Western-Arabic digits so the Arabic and English documents cannot
disagree about a number. Arabic WhatsApp message surviving the URL round trip
including a literal `&`. Arabic search matching an unnormalised spelling.

**Journey C — Bilingual (§6).** One tax invoice carrying both languages for
every piece of text, with Arabic script actually present rather than English
copied into the Arabic slot; one set of financial figures, one phone in Western
digits, dates as instants formatted per language; and the document **rendered to
A4 HTML** so a renderer that dropped the Arabic would fail here rather than in
print.

**Data (§7).** Realistic synthetic throughout — long Omani and Gulf names,
multiple dresses, multiple accessories, alterations, VAT, security deposit,
multiple payments, a refund. No `Test Test`, no `John Doe`, and no real person's
details. VAT and CR numbers deliberately left blank, because this boutique has
not supplied them.

---

## 7. MANUAL VERIFICATION REQUIRED

**None of the following was performed.** This session runs in a headless Linux
container with no phone, no tablet, no printer and no WhatsApp account. Each is
listed as unperformed rather than approximated, because a browser viewport is
not a device and a PDF is not a printout.

| §   | Check                                                    | Status |
| --- | -------------------------------------------------------- | ------ |
| 8   | iPhone Safari                                            | **NOT PERFORMED** |
| 8   | Android Chrome                                           | **NOT PERFORMED** |
| 8   | iPad Safari / tablet                                     | **NOT PERFORMED** |
| 8   | Desktop Chrome                                           | **NOT PERFORMED** |
| 8   | Desktop Edge / Safari                                    | **NOT PERFORMED** |
| 9   | Mobile critical workflow, end to end on a real phone     | **NOT PERFORMED** |
| 9   | No horizontal scroll; no keyboard covering fields        | **NOT PERFORMED** |
| 10  | Tablet at 768×1024 and 1024×768                          | **NOT PERFORMED** |
| 11  | Arabic on a real device: keyboard, input, search, calendar | **NOT PERFORMED** |
| 12  | Print / save-as-PDF: invoice, agreement, receipt × EN/AR/bilingual, one- and multi-page | **NOT PERFORMED** |
| 13  | Physical print on a real A4 printer                      | **NOT PERFORMED** |
| 14  | WhatsApp on a real phone: contact, message, language     | **NOT PERFORMED** |
| 26  | PWA install and launch on a real device                  | **NOT PERFORMED** |
| 27  | Version N → N+1 update prompt on an installed device     | **NOT PERFORMED** |
| 28  | Runtime performance on a real phone over a real network  | **NOT PERFORMED** |

What *was* verified automatically for those areas is in §8. It does not
substitute for any row above.

---

## 8. What was verified without a device

### PWA artefacts (§26)

- `manifest.webmanifest` valid: name, `start_url: /`, `display: standalone`,
  `scope: /`, four icons including two maskable, `theme_color`, `lang`, `dir`.
- Service worker generated (`dist/sw.js`), `registerType: 'prompt'` — an
  employee is never swapped mid-payment.
- **Precache contains only the application shell**: JS, CSS, 12 WOFF2 fonts,
  icons, `index.html`, the manifest. 31 entries.
- **No Firebase endpoint appears in the service worker at all** — grepped for
  `firestore.googleapis`, `firebasestorage`, `cloudfunctions`, `googleapis`:
  zero matches. No runtime caching of business data, by construction.
- Source maps excluded from the precache.
- Offline refusals proven at the **service** layer, not just the domain:
  reservation create / change dates / change status, payment, deposit, refund,
  deposit settlement, document issue, document void — nine operations, each
  throwing before any network call. Verified by removing the guard and watching
  four fail with "reached the network".

### Payload and build (§28)

| Measure                            | Value                     |
| ---------------------------------- | ------------------------- |
| Cold-load JS + CSS (gzip)          | **414.6 kB**              |
| — firebase chunk                   | 195.5 kB gzip             |
| — application                      | 118.5 kB gzip             |
| — react                            | 89.6 kB gzip              |
| — CSS                              | 8.7 kB gzip               |
| Fonts (12 WOFF2, on demand)        | 404.8 KiB raw             |
| Precache total                     | 1,850.87 KiB              |
| Production build (incl. typecheck) | ~18.5 s, 3 runs           |

The Firebase SDK is the largest single chunk and the obvious target if the cold
load ever needs to come down.

### Print (§12) — partial

The A4 documents are rendered and asserted in `src/print/documents.test.tsx`
(44 assertions) and, for the bilingual invoice, rendered to static HTML inside
the end-to-end journey. That proves structure and content, in all three
languages, including the accessory and alteration lines added at this gate.

It does **not** prove pagination, margins, page breaks, logo placement or Arabic
shaping on paper. §12 and §13 stay open.

### Concurrency (§15) — PASS

Already covered and re-run at this commit:

| Scenario                                 | Expected                    | Result |
| ---------------------------------------- | --------------------------- | ------ |
| 8 simultaneous bookings, same dress/dates | 1 success, 7 conflicts     | PASS   |
| 8 simultaneous bookings, different dresses | 8 successes               | PASS   |
| 8 simultaneous part payments             | never exceeds the balance   | PASS   |
| 8 simultaneous sends of one payment key  | collapses to one           | PASS   |
| 8 simultaneous deposit settlements       | never returns more than held| PASS   |
| Concurrent refund + forfeiture           | never exceeds the deposit   | PASS   |
| 8 simultaneous invoice issues            | 8 unique numbers            | PASS   |
| 8 simultaneous sends of one document key | collapses to one            | PASS   |
| 8 simultaneous dress/customer creations  | 8 distinct codes            | PASS   |

### Backup and restore (§22, §23, §24, §25) — PASS

- Export carries `schemaVersion`, `applicationVersion`, `exportedAt`,
  `projectId`, `environment`.
- **No secret in any export**, asserted over the raw JSON text rather than the
  parsed structure, so a credential in a field the test does not know about is
  still caught.
- Full restore drill: export → wipe → import → every record under its original
  id, every relationship, both financial events, the pricing snapshot with its
  nested accessory lines, the issued invoice number, the whole audit trail,
  Arabic byte-for-byte, and `pickupAt` still a `Timestamp` and not a number.
- **Interrupted restore (§24):** abandoned after three collections, leaving the
  database half-written and — correctly — no audit entry claiming a restore
  happened. Re-running the same file converges: no duplicates, no dangling
  references, same balance.
- **§25 documented explicitly:** the JSON export is a Firestore backup and
  nothing else. It does not contain Storage photos, Firebase Auth accounts or
  custom claims, and OPERATIONS.md §3a gives the separate recovery procedure and
  the order to do it in.

### Dependency audit (§30)

| Scope                | Vulnerabilities | Note                                        |
| -------------------- | --------------- | ------------------------------------------- |
| Browser bundle       | **0**           | `npm audit --omit=dev` clean                |
| Functions runtime    | 7 moderate      | one root cause, unreachable — see §4         |
| firebase-tools (CLI) | 5 moderate      | dev-only; not in the bundle or the runtime  |

`@tanstack/react-query` and `zustand` removed after verifying across src,
functions, tests, every config and script, and confirming absence from the built
bundle. Every remaining dependency was checked for real usage.

---

## 9. Production configuration (§31–§39) — NOT STARTED

Deliberately. §46 requires explicit approval before deployment, and the
pre-production gate is what this document reports. Nothing below has been done:

- [ ] Production Firebase project id configured
- [ ] Production Hosting, Firestore, Storage, Functions provisioned
- [ ] `AZHARY_BOOTSTRAP_TOKEN` set as a Functions secret
- [ ] Rules deployed to production
- [ ] Functions deployed to production
- [ ] Owner account bootstrapped
- [ ] Production smoke test
- [ ] Observability checked

The procedures for all of these are in DEPLOYMENT.md. The rollback procedure —
including the fact that **Firestore data cannot be rolled back like frontend
assets** — is DEPLOYMENT.md §11.

---

## 10. Verdict

### PRE-PRODUCTION GATE: PASS

2,561 automated assertions green, no flakiness across repeated runs, one P1
defect found and fixed, security audit clean including deliberate attempts to
reach privileged operations as a real staff session.

### NOT READY FOR PRODUCTION

Not because anything is known to be broken — because **the manual verification
in §7 has not been performed**, and this environment cannot perform it.

The application is used on phones and tablets by employees standing with
customers, and prints legal documents in two scripts on A4 paper. An emulator
cannot tell you whether the Arabic keyboard works on an iPad, whether a bride's
invoice fits the page, or whether the WhatsApp link opens the right contact. A
gate that counted those as passed because the code looks right would be the kind
of claim this project has refused to make everywhere else.

**Blocking for production:**

1. §8–§11 — real device testing: iPhone Safari, Android Chrome, iPad, desktop.
2. §12–§13 — print QA and one physical A4 printout.
3. §14 — WhatsApp on a real phone.
4. §26–§27 — PWA install, and a real N → N+1 update on an installed device.

**Not blocking, owner's decision:**

- The P2 read-volume limitation (§4). Ships as-is; revisit within two to three
  years of real use.

**Recommended sequence:** run the §7 checks against a *development* deployment
first, close them out, then return for production approval. Nothing in §9 should
be started until §7 is closed — configuring a production project is the step
that makes a mistake expensive.

---

## 11. Sign-off

| Role                     | Name | Date | Verdict |
| ------------------------ | ---- | ---- | ------- |
| Automated gate           | —    | 2026-08-15 | PASS |
| Manual device testing    |      |      | **outstanding** |
| Print verification       |      |      | **outstanding** |
| Boutique owner acceptance|      |      | **outstanding** |
| Production deployment    |      |      | **not approved** |
