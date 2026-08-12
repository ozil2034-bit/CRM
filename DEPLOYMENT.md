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

`npm run seed:demo` (added in Phase 3) exists for development only. It refuses to
run unless `VITE_DEMO_MODE=true` **and** the target is the emulator. It is never
executed automatically, never in CI, and never against a live project
(specification §52).

---

## 8. Backups

Production enables Firestore scheduled daily exports to a Cloud Storage bucket
with a retention period agreed with the boutique. Restore procedure and rehearsal
schedule are in [OPERATIONS.md](./OPERATIONS.md).

A backup that has never been restored is a hypothesis, not a backup — the restore
drill is part of the operations runbook for that reason.
