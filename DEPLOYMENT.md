# Azhary Boutique — Deployment

---

## 1. Environments

Three isolated environments. Demo data never touches production (specification §58).

| Environment | Firebase project               | Purpose                  | Demo data     |
| ----------- | ------------------------------ | ------------------------ | ------------- |
| Local       | Emulator Suite                 | Development, rules tests | Allowed       |
| Development | `REPLACE_WITH_DEV_PROJECT_ID`  | Shared testing           | Allowed       |
| Production  | `REPLACE_WITH_PROD_PROJECT_ID` | Real boutique operations | **Forbidden** |

Project aliases live in `.firebaserc`. The placeholders above are deliberate: a
command run before the real IDs are set fails loudly rather than silently
targeting the wrong project.

---

## 2. Firebase project setup

Repeat for development and production. **Never share one project between them** —
a mistaken write in development must not be able to reach real customer records.

1. Create the project in the [Firebase console](https://console.firebase.google.com).
2. **Authentication** → enable _Email/Password_.
   Do not create any user here; the first owner is created through the
   application's guarded bootstrap flow (SECURITY.md §2).
3. **Firestore Database** → create in production mode (locked). Choose a region
   close to Oman — `europe-west1` or `asia-south1`. The region cannot be changed
   later.
4. **Storage** → create the default bucket.
5. **Project settings → Your apps → Web** → register an app and copy the config.
6. Record the project ID in `.firebaserc`.
7. Set the owner bootstrap secret (see below) **before** anyone opens the app.

### The owner bootstrap secret

```bash
npx firebase functions:secrets:set AZHARY_BOOTSTRAP_TOKEN --project <project>
```

Generate a high-entropy value — e.g. `openssl rand -base64 32` — and give it to
the boutique owner through a channel separate from the application URL.

Without it, `claimInitialOwnership` refuses every request: with no configured
secret there is no way to distinguish the intended owner from whoever reaches the
URL first, so bootstrap fails closed rather than opening.

The secret lives only in the Functions runtime. It is never a `VITE_` variable,
never in the browser bundle, and never committed. Rotate it after the owner
account exists; bootstrap can only complete once, so it has no further use.

---

## 3. Environment configuration

```bash
cp .env.example .env.development
```

Fill in from the Firebase console:

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=          <project-id>.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=       <project-id>.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=

VITE_APP_ENV=development
VITE_DEMO_MODE=false
VITE_USE_EMULATORS=false
```

For production, create `.env.production` with `VITE_APP_ENV=production`,
`VITE_DEMO_MODE=false` and `VITE_USE_EMULATORS=false`. The environment validator
**refuses to start** a production build with demo mode or emulators enabled — this
is a startup error, not a warning.

### What must never appear in these files

Service-account keys, admin credentials, private keys, API secrets. Everything
prefixed `VITE_` is compiled into the public browser bundle. Firebase Web config
values are project identifiers, not credentials; security comes from the rules
(SECURITY.md §7).

`.env*` files are git-ignored apart from `.env.example`, which contains key names
only.

---

## 4. Local emulator

```bash
npm run emulators
```

| Service        | Port |
| -------------- | ---- |
| Authentication | 9099 |
| Firestore      | 8080 |
| Storage        | 9199 |
| Hosting        | 5000 |
| Emulator UI    | 4000 |

Set `VITE_USE_EMULATORS=true` to point the app at it. The application logs a
console warning when connected, so it is never ambiguous whether you are looking
at real data.

---

## 5. Deployment

### Pre-flight gate

Deployment is blocked until all of these pass:

```bash
npm run verify          # lint + typecheck + test + build
```

Plus:

```bash
npm run test:rules      # Firestore + Storage rules against the emulator
npm run test:functions  # Cloud Function integration against the emulator
```

Production additionally requires:

- [ ] `VITE_APP_ENV=production` and `VITE_DEMO_MODE=false`
- [ ] No dummy or demo records in the target project
- [ ] Firestore rules reviewed and rules tests green
- [ ] Storage rules reviewed
- [ ] `AZHARY_BOOTSTRAP_TOKEN` set, and rotated once the owner exists
- [ ] Cloud Functions deployed
- [ ] Business profile configured by the owner (no placeholder VAT or CR numbers)
- [ ] Daily backups enabled
- [ ] Owner account created through the bootstrap flow

### Commands

```bash
# Rules and indexes — deploy these before the application that depends on them.
npx firebase deploy --only firestore:rules,firestore:indexes,storage --project development

# Cloud Functions — required before first run; bootstrap depends on them.
npm run build:functions
npx firebase deploy --only functions --project development

# Application
npm run build
npx firebase deploy --only hosting --project development
```

Production is identical with `--project production`. Deploy rules **before**
hosting: an application build that expects tighter rules than are live runs
briefly against looser ones otherwise.

### Rollback

```bash
npx firebase hosting:rollback --project production
```

Firebase Hosting retains previous releases, so rollback is immediate. Firestore
rules are versioned in the console and can be reverted there; the authoritative
copy is `firestore.rules` in this repository, so revert the commit and redeploy.

---

## 6. First run in a new project

1. Deploy rules, Functions and hosting, and set `AZHARY_BOOTSTRAP_TOKEN`.
2. Open the application. It reports that no owner exists.
3. Create the owner account and enter the setup token. The Function verifies
   server-side, inside a transaction, that no owner exists — so the bootstrap
   cannot be claimed twice, and cannot be claimed by someone who merely found the
   URL (SECURITY.md §2).
4. Sign in as the owner and complete **Settings → Business Profile**: names,
   address, contact details, VAT registration number, CR number, logo.
5. Configure **Settings**: VAT rate, minimum pickup payment percentage,
   late-return daily fee, cleaning buffer, cancellation tiers, numbering prefixes.
6. Create the first Terms & Conditions version (English and Arabic).
7. Add staff accounts.

No step in this sequence involves seeded data. The database is empty and the
application says so.

---

## 7. Demo data

**There is none, and there is no script that could create any.**

Earlier drafts of this document described a guarded `npm run seed:demo`. It was
never written, and by Phase 10 that is the better outcome rather than an
oversight to correct: a seeding script that refuses to run in production is one
misconfiguration away from running in production, and the safest version of that
script is the one that does not exist.

`VITE_DEMO_MODE` remains in the environment schema and must be `false` in
production — it gates development affordances, not data.

Test fixtures live in `tests/`, run only against the emulator project
`demo-azhary-functions`, and have no path to a live project.

---

## 8. Backups

Production enables Firestore scheduled daily exports to a Cloud Storage bucket
with a retention period agreed with the boutique. Restore procedure and rehearsal
schedule are in [OPERATIONS.md](./OPERATIONS.md).

A backup that has never been restored is a hypothesis, not a backup — the restore
drill is part of the operations runbook for that reason.

The application also has its own JSON backup and restore under **Settings →
Data**, owner-only, which is what the boutique uses day to day. Restore runs as a
Cloud Function (`restoreBackupChunk`, `finishRestore`), so it must be deployed
along with everything else; a client alone cannot perform one, by design.

---

## 9. The build refuses to ship a placeholder

`readEnvironment()` scans configuration for placeholder markers —
`REPLACE_WITH`, `your-project`, `changeme`, `placeholder`, `todo`, `xxxx` and
others — and a **production** build fails with the offending variable named.

This exists because the alternative failure is silent and expensive: an
application built against `REPLACE_WITH_PROD_PROJECT_ID` deploys, loads, shows a
sign-in screen, and only reveals the problem when the first employee's first
write disappears into a project that does not exist.

```
Environment configuration is not production-ready:
  VITE_FIREBASE_PROJECT_ID contains the placeholder "REPLACE_WITH"
```

Development builds are unaffected — a placeholder there is a work in progress,
not a deployment.

---

## 10. The service worker and updates

The build produces `dist/sw.js` and a precache manifest alongside the bundle.
Three consequences at deploy time:

- **A deployment is what triggers the update prompt.** Installed devices notice
  the new service worker, and each shows a prompt on its next load. Nothing
  updates silently mid-task (`registerType: 'prompt'`).
- **Employees may run the previous version for a while.** They are prompted, not
  forced. A change that requires everyone to be on the new version — a Firestore
  rules tightening, say — needs that thought through, because the rules deploy
  instantly and the clients do not.
- **Outdated precaches are cleaned up automatically**
  (`cleanupOutdatedCaches: true`), so old asset revisions do not accumulate on a
  device.

Nothing private is precached: the manifest covers JS, CSS, fonts, icons and the
HTML shell, and there is **no runtime caching of Firestore, Storage or Cloud
Functions**. Source maps are excluded from the precache but are still emitted to
`dist/`; do not upload them to a public host if the bundle should stay opaque.

### Fonts

Four families ship as WOFF2 in the bundle (`src/assets/fonts/`) with their OFL
licences. Nothing is fetched from Google Fonts. A CSP that blocks
`fonts.googleapis.com` therefore breaks nothing, and the application renders its
own text with no network at all.


---

## 11. Rollback

Four things deploy independently, and **they roll back differently**. Treating
them as one release is the mistake that turns a bad deploy into a bad day.

### The application (Hosting) — instant, safe

```bash
npx firebase hosting:releases:list --project <production-project-id>
npx firebase hosting:rollback --project <production-project-id>
```

Hosting keeps previous releases. Rolling back swaps the served bundle in
seconds and loses nothing.

**The one wrinkle: installed devices.** A tablet running the PWA holds the old
service worker until it notices a new one and the employee accepts the prompt.
After a rollback, some devices will be on the rolled-back version and some on
the version you just withdrew, until each is prompted again. Plan for a short
window where both are in use; this is also why the two must be compatible with
the same Firestore rules.

### Cloud Functions — redeploy, not rollback

There is no `functions:rollback`. The way back is to deploy the previous commit:

```bash
git checkout <previous-release-tag>
npm run build:functions
npx firebase deploy --only functions --project <production-project-id>
```

Deploy functions **before** rolling back Hosting if the old client calls a
function the new one renamed, and **after** if the reverse. When in doubt,
deploy functions first: an old client calling a new function that still accepts
its arguments is survivable; a new client calling a function that no longer
exists is not.

### Firestore and Storage rules — redeploy from the previous commit

```bash
git checkout <previous-release-tag> -- firestore.rules storage.rules
npx firebase deploy --only firestore:rules,storage:rules --project <production-project-id>
```

Rules take effect within seconds and apply to every client immediately,
including ones running the old bundle. **Never roll rules back to something more
permissive than the deployed application needs** — a rules rollback that
re-opens a path is a security regression, not a recovery.

### Firestore data — NOT a rollback

This is the one that must not be described the way the others are.

**Data cannot be rolled back.** There is no previous version to swap to. What
exists is a restore: taking a backup from a point in time and writing it over
the current state — which **discards everything that happened since**, including
every reservation taken and every payment recorded in the meantime.

That is a business decision, not an operational one. It belongs to the owner,
not to whoever is deploying. Before any restore into production:

1. Export the current state first, whatever you believe is in it.
2. Establish what the boutique will lose — the reservations and payments between
   the backup's `exportedAt` and now.
3. Get the owner's explicit agreement to lose them.
4. Then restore, following OPERATIONS.md §3a.

A bad deploy is almost never fixed by restoring data. Roll the code back first;
the data is usually fine.

### Order of operations for a bad release

1. **Assess.** Is it the bundle, a function, or a rule? Hosting rollback fixes
   only the first.
2. Roll Hosting back. Most releases end here.
3. If a function is at fault, redeploy the previous commit's functions.
4. If a rule is at fault, redeploy the previous commit's rules — never a looser
   version.
5. Touch data only if data was actually corrupted, and only with the owner's
   agreement, per above.
