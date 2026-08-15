# Azhary Boutique — UAT Record

> **Status: NOT DEPLOYED.** The development Firebase project is not configured
> and this environment holds no Firebase credentials. §1 lists exactly what is
> required. Everything below is prepared and ready to execute the moment those
> exist.
>
> **Every manual result in this document reads NOT PERFORMED.** None of it has
> been run. A row changes only when a person has actually done it on the device
> named in that row.

---

## 1. Deployment status

| Field                  | Value                                                      |
| ---------------------- | ---------------------------------------------------------- |
| Release commit         | `f760b16` (branch `claude/azhary-boutique-env-setup-fyoja2`) |
| Application version    | `0.9.0`                                                     |
| UAT URL                | **none — not deployed**                                     |
| Firebase project       | **not configured** (`.firebaserc` → `REPLACE_WITH_DEV_PROJECT_ID`) |
| Environment            | development / UAT (intended)                                |
| Deployed by            | —                                                           |
| Deployed at            | —                                                           |

### Why it is not deployed

Four things are required and none is present in this environment. They are not
guessable, and this session will not invent any of them.

| # | Required                                    | Why it is missing here                                      |
| - | ------------------------------------------- | ----------------------------------------------------------- |
| 1 | **Development Firebase project id**         | `.firebaserc` holds the placeholder `REPLACE_WITH_DEV_PROJECT_ID` |
| 2 | **Firebase Web config** (6 `VITE_*` values) | No `.env.development` exists; only `.env.example`            |
| 3 | **A Firebase CLI credential**               | `firebase login:list` → *No authorized accounts*. `firebase login` is an interactive browser OAuth flow and this is a non-interactive container. No `FIREBASE_TOKEN` or service account is present. |
| 4 | **A UAT bootstrap token**                   | Must be chosen by whoever deploys and set via `functions:secrets:set` — never committed |

Also required on the Firebase side: the project must be on the **Blaze** plan.
Cloud Functions cannot deploy on Spark, and booking, payments and documents are
all Functions — on Spark you would get a Hosting deployment of an application
that cannot take a booking.

Network is not the obstacle: outbound HTTPS works from this container.
Authentication is.

### To deploy

Follow **DEPLOYMENT.md §12**, then:

```bash
npm run deploy:uat
```

`npm run predeploy:uat` runs first and refuses unless the target is
unmistakably development. It currently reports:

```
UAT deploy target is not ready:

  ✗ .firebaserc "development" is still the placeholder "REPLACE_WITH_DEV_PROJECT_ID".
  ✗ .env.development is missing.
```

---

## 2. UAT test data (§8)

Create everything through the application. There is no seeding script in this
repository — not even a guarded one — and UAT data is no exception.

**Every value below is synthetic and prefixed `UAT`,** so a record cannot be
mistaken for a real customer at a glance.

> **Never enter a real customer's name, phone number or event date in this
> environment.**

### A warning about the phone number

The validator accepts any Omani-shaped number — `[279]` followed by seven digits
— so `99990001` passes. **Whether that number belongs to a real person is not
something this project can tell you**, and a WhatsApp link built from it would
open a chat with whoever holds it.

So:

- Use `99990001` for everything **except** the WhatsApp test. It only has to be
  valid, and no message is sent by creating a customer.
- For the WhatsApp test (§6), **change the customer's number to the tester's
  own phone** first. That is the only way to be certain no stranger receives a
  test message, and it makes the test stronger: you can confirm the message
  actually arrived and read it in the app it was written for.
- Change it back afterwards if the record is being kept.

### 2.1 Customer

| Field              | Value                                    |
| ------------------ | ---------------------------------------- |
| Name (English)     | `UAT Customer 001 Al Habsi`              |
| Name (Arabic)      | `عميلة الاختبار ٠٠١ الحبسية`             |
| Phone              | `99990001`                               |
| WhatsApp           | yes                                      |
| Email              | `uat.customer.001@example.test`          |
| Event date         | 60 days from today                       |
| Preferred language | Arabic                                   |
| Source             | Referral                                 |
| Notes (Arabic)     | `ملاحظة اختبار: تفضل الطرحة الطويلة.`    |

The long Arabic name is deliberate — it is the case that breaks a layout sized
for `Bride One`.

### 2.2 Dress

| Field            | Value                                            |
| ---------------- | ------------------------------------------------ |
| Name             | `UAT Dress 001 — ivory silk-mikado cathedral`     |
| Designer         | `UAT Atelier`                                     |
| Size             | `38`                                              |
| Colour           | `Ivory`                                           |
| Condition        | Excellent                                         |
| Rental price     | `450.000` OMR                                     |
| Security deposit | `150.000` OMR                                     |
| Cleaning buffer  | `3` days                                          |
| Location         | `UAT Rail A — 01`                                 |
| **Photo**        | Upload one — needed for the invoice photo test    |

Add a second dress (`UAT Dress 002`, rental `180.000`, deposit `50.000`) so the
multi-dress reservation and the multi-page print case can be exercised.

### 2.3 Reservation

| Field      | Value                            |
| ---------- | -------------------------------- |
| Customer   | UAT Customer 001                 |
| Dresses    | UAT Dress 001 **and** 002        |
| Event date | 60 days from today               |
| Pickup     | Event date − 2 days, 10:00       |
| Return     | Event date + 2 days, 18:00       |
| Notes      | `UAT scenario — do not action.`  |

Then schedule a **fitting** for event date − 9 days, 17:30, 60 minutes.

### 2.4 Amendments

| Type       | Detail                                     | Amount     |
| ---------- | ------------------------------------------ | ---------- |
| Accessory  | `UAT Cathedral veil, 3 m` × 1              | `35.000`   |
| Accessory  | `UAT Pearl hair comb` × 2                  | `12.000` ea |
| Alteration | `UAT hem shortened 4 cm, bodice taken in`  | `25.000`   |

**Check as you go:** the accessory subtotal must read `59.000`
(35.000 + 2 × 12.000) and the alteration subtotal `25.000`.

### 2.5 Money

| Step             | Amount      | Method        |
| ---------------- | ----------- | ------------- |
| Security deposit | `210.000`   | Card          |
| Payment 1        | `300.000`   | Bank Transfer |
| Payment 2        | `200.000`   | Cash          |
| Final payment    | the balance | Card          |

Expected before the final payment: rental `630.000` + accessories `59.000` +
alterations `25.000` = taxable `714.000`; VAT at 5% = `35.700`; grand total
including the deposit = `959.700`. The deposit is held separately and must not
reduce the rental balance.

### 2.6 Documents

Issue, in this order: **Tax Invoice**, **Rental Agreement**, **Payment Receipt**
— each in **English**, **Arabic** and **bilingual** (nine documents). Every one
goes on the §5 print checklist.

Confirm on each: both accessories and the alteration appear as **itemised
lines**, not only as subtotals. This is the P1 fixed at the Phase 10 gate and is
the single most important thing to look at on a printed page.

### 2.7 The rest of the lifecycle

1. **WhatsApp** — open the composer, check the message, open WhatsApp (§6).
2. **Pickup** — both dresses become *Out with Customer*.
3. **Return** — mark returned; set the actual return **2 days late** to exercise
   the late fee. Both dresses become *In Cleaning* and must not be bookable.
4. **Damage** — record damage on UAT Dress 001 with an estimated cost of
   `40.000`.
5. **Deposit** — forfeit `40.000` against the damage, refund the remaining
   `170.000`.
6. **Close** the reservation.
7. **Reconcile** — outstanding `0.000`, deposit held `0.000`.
8. **Backup** — Settings → Data → Export, and check the file downloads.
9. **CSV** — export all five lists and open one in Excel to confirm Arabic reads
   correctly rather than as mojibake.

---

## 3. Automated results (already performed)

These ran against the **local emulator** at commit `f760b16`. They are reported
here for completeness and are **not** a substitute for anything in §4–§7.

| Suite                    | Result | Assertions |
| ------------------------ | ------ | ---------- |
| `npm run lint`           | PASS   | 0 errors   |
| `npm run typecheck`      | PASS   | —          |
| `npm run test`           | PASS   | 1,452      |
| `npm run test:rules`     | PASS   | 817        |
| `npm run test:functions` | PASS   | 292        |
| `npm run build`          | PASS   | —          |

**Total 2,561.** Detail in RELEASE.md.

### Post-deploy automated smoke test (§6)

**NOT PERFORMED** — requires a deployment. Once the UAT URL exists:

| # | Check                                              | Result |
| - | -------------------------------------------------- | ------ |
| 1 | Hosting URL returns 200 and the app shell loads     | NOT PERFORMED |
| 2 | Setup screen appears (no owner exists yet)          | NOT PERFORMED |
| 3 | Owner bootstrap succeeds with the UAT token         | NOT PERFORMED |
| 4 | A wrong bootstrap token is refused                  | NOT PERFORMED |
| 5 | Firestore shows zero business collections           | NOT PERFORMED |
| 6 | Sign in / sign out / sign in again                  | NOT PERFORMED |
| 7 | All nine callable Functions respond                 | NOT PERFORMED |
| 8 | Unauthenticated read of `customers` is refused      | NOT PERFORMED |
| 9 | `sw.js` and `manifest.webmanifest` served correctly | NOT PERFORMED |

---

## 4. Real device checklist (§9) — ALL NOT PERFORMED

One row per device. **Do not fill in a result you did not observe on that
device.** A desktop browser resized to 390 px is not an iPhone: it has a
different font stack, a different keyboard, a different scroll container and a
different Safari.

### 4.1 iPhone — Safari

| # | Test | Expected | Actual | Result |
| - | ---- | -------- | ------ | ------ |
| 1 | Sign in | Dashboard loads | | NOT PERFORMED |
| 2 | Search a customer | Results filter as you type | | NOT PERFORMED |
| 3 | Create a customer | Saved; code `CU-000n` issued | | NOT PERFORMED |
| 4 | Search a dress | Results filter | | NOT PERFORMED |
| 5 | Create a dress + photo | Photo uploads and displays | | NOT PERFORMED |
| 6 | Create a reservation | Availability checked; code issued | | NOT PERFORMED |
| 7 | View a dress photo | Full size, correct aspect ratio | | NOT PERFORMED |
| 8 | Schedule a fitting | Appears on the reservation | | NOT PERFORMED |
| 9 | Record a payment | Balance updates | | NOT PERFORMED |
| 10 | Generate an invoice | Renders on screen | | NOT PERFORMED |
| 11 | Open WhatsApp | Correct contact and message | | NOT PERFORMED |
| 12 | Process pickup | Dress → *Out with Customer* | | NOT PERFORMED |
| 13 | Process return | Dress → *In Cleaning* | | NOT PERFORMED |
| 14 | View the dashboard | Today's collections and returns | | NOT PERFORMED |
| 15 | Switch to Arabic | Whole UI mirrors to RTL | | NOT PERFORMED |
| 16 | **No horizontal scroll** on any screen | Page never scrolls sideways | | NOT PERFORMED |
| 17 | **Keyboard does not cover the field** being typed into | Field stays visible | | NOT PERFORMED |
| 18 | Dialogs open, scroll and close | No trapped or clipped dialog | | NOT PERFORMED |

Record: device model, iOS version, Safari version, screen size.

### 4.2 Android — Chrome

Same 18 rows. **ALL NOT PERFORMED.** Record: device, Android version, Chrome
version, screen size.

### 4.3 iPad — Safari

Same 18 rows, **plus** the tablet layout checks in §4.5. **ALL NOT PERFORMED.**

### 4.4 Desktop — Chrome, and Edge or Safari

Same 18 rows. **ALL NOT PERFORMED.** Record: OS, browser, version, window size.

### 4.5 Tablet layout (§10) — NOT PERFORMED

At **768 × 1024** (portrait) and **1024 × 768** (landscape):

| Screen       | 768×1024 | 1024×768 |
| ------------ | -------- | -------- |
| Dashboard    | NOT PERFORMED | NOT PERFORMED |
| Calendar     | NOT PERFORMED | NOT PERFORMED |
| Reservation  | NOT PERFORMED | NOT PERFORMED |
| Inventory    | NOT PERFORMED | NOT PERFORMED |
| Customer     | NOT PERFORMED | NOT PERFORMED |
| Reports      | NOT PERFORMED | NOT PERFORMED |
| Settings     | NOT PERFORMED | NOT PERFORMED |

### 4.6 Arabic on a real device (§11) — NOT PERFORMED

| # | Test | Expected | Result |
| - | ---- | -------- | ------ |
| 1 | Switch to Arabic | Entire UI mirrors; nothing stays LTR | NOT PERFORMED |
| 2 | Arabic keyboard input | Types correctly into every field | NOT PERFORMED |
| 3 | Arabic customer name | Saves and redisplays unchanged | NOT PERFORMED |
| 4 | Arabic notes, multi-line | Wraps and aligns right | NOT PERFORMED |
| 5 | Arabic search | Finds a customer typed without diacritics | NOT PERFORMED |
| 6 | Arabic calendar | Month, weekday and dates read correctly | NOT PERFORMED |
| 7 | Money in Arabic | Western-Arabic digits, same as English | NOT PERFORMED |
| 8 | Arabic invoice on screen | Shaping and joining correct | NOT PERFORMED |
| 9 | Mixed Arabic + Latin in one field | Neither reverses | NOT PERFORMED |
| 10 | Arabic WhatsApp message | Arrives intact | NOT PERFORMED |

---

## 5. Print checklist (§10, §12, §13) — ALL NOT PERFORMED

Print or save-as-PDF each of the nine documents from §2.6.

| Document          | Language  | Result |
| ----------------- | --------- | ------ |
| Tax Invoice       | English   | NOT PERFORMED |
| Tax Invoice       | Arabic    | NOT PERFORMED |
| Tax Invoice       | Bilingual | NOT PERFORMED |
| Rental Agreement  | English   | NOT PERFORMED |
| Rental Agreement  | Arabic    | NOT PERFORMED |
| Rental Agreement  | Bilingual | NOT PERFORMED |
| Payment Receipt   | English   | NOT PERFORMED |
| Payment Receipt   | Arabic    | NOT PERFORMED |
| Payment Receipt   | Bilingual | NOT PERFORMED |

On **every** document check:

| # | Check | Result |
| - | ----- | ------ |
| 1 | Paper size is **A4**, not Letter | NOT PERFORMED |
| 2 | Margins even; nothing runs off the edge | NOT PERFORMED |
| 3 | Logo present, correct size, not stretched | NOT PERFORMED |
| 4 | Business name, address, phone, email correct | NOT PERFORMED |
| 5 | VAT and CR **blank** if not configured — never invented | NOT PERFORMED |
| 6 | Customer name correct in both scripts | NOT PERFORMED |
| 7 | Dress photo renders, correct aspect ratio | NOT PERFORMED |
| 8 | **Accessories itemised** — name, qty, unit price, total | NOT PERFORMED |
| 9 | **Alterations itemised** — description and amount | NOT PERFORMED |
| 10 | Financial totals correct and aligned | NOT PERFORMED |
| 11 | VAT line shows rate and amount | NOT PERFORMED |
| 12 | Security deposit shown separately from the rental | NOT PERFORMED |
| 13 | Payment history complete | NOT PERFORMED |
| 14 | Balance correct | NOT PERFORMED |
| 15 | T&C present, both languages where bilingual | NOT PERFORMED |
| 16 | Signature areas present and not split across a page break | NOT PERFORMED |
| 17 | **Arabic shaping correct** — letters joined, not isolated | NOT PERFORMED |
| 18 | **Arabic direction correct** — not reversed | NOT PERFORMED |
| 19 | **Numbers not reversed** in RTL context | NOT PERFORMED |
| 20 | No clipping, no overlap, no unexpected blank page | NOT PERFORMED |

### Multi-page

| # | Check | Result |
| - | ----- | ------ |
| 1 | One-page document fits on one page | NOT PERFORMED |
| 2 | Two-dress reservation paginates correctly | NOT PERFORMED |
| 3 | Table headers repeat, or the table is not split mid-row | NOT PERFORMED |
| 4 | T&C do not orphan a heading at a page foot | NOT PERFORMED |

### Physical print (§13) — **MANDATORY, NOT PERFORMED**

At least one document must go through a **real A4 printer**. A PDF preview does
not show what a printer does with margins, colour or hairline rules.

| Check | Result |
| ----- | ------ |
| Printed on real A4 paper | **NOT PERFORMED** |
| Margins correct on paper | NOT PERFORMED |
| Logo legible in print | NOT PERFORMED |
| Text legible at printed size | NOT PERFORMED |
| Table rules and borders print | NOT PERFORMED |
| Signature areas usable with a pen | NOT PERFORMED |
| Arabic legible on paper | NOT PERFORMED |

Printer make and model: ________________

---

## 6. WhatsApp checklist (§11, §14) — ALL NOT PERFORMED

On a **real phone with WhatsApp installed**. Before starting, set UAT Customer
001's phone to **the tester's own number** — see the warning in §2.1. Sending a
test message to an unverified number means sending it to whoever holds that
number.

| # | Test | Expected | Result |
| - | ---- | -------- | ------ |
| 1 | Open a reservation → Notify | Composer opens | NOT PERFORMED |
| 2 | Choose a template | Message renders with real values | NOT PERFORMED |
| 3 | Check every variable | No `undefined`, `null`, `NaN`, no `{placeholder}` | NOT PERFORMED |
| 4 | Check the customer name | Matches the reservation | NOT PERFORMED |
| 5 | Check dates | Match the reservation, Muscat time | NOT PERFORMED |
| 6 | Check the amount | Matches the balance, three decimals | NOT PERFORMED |
| 7 | Tap to open WhatsApp | WhatsApp opens | NOT PERFORMED |
| 8 | **Check the contact** | The number in the composer, not another chat | NOT PERFORMED |
| 9 | Check the message in WhatsApp | Arrives complete, nothing truncated | NOT PERFORMED |
| 10 | Repeat in **Arabic** | Arabic intact, RTL correct, not reversed | NOT PERFORMED |
| 11 | Message containing `&` | Nothing truncated at the ampersand | NOT PERFORMED |
| 12 | Return to the app | Status recorded as **Opened** | NOT PERFORMED |
| 13 | Use **Copy** instead | Status recorded as **Copied** | NOT PERFORMED |
| 14 | **Read the wording** | Nowhere says *Sent*, *Delivered* or *Read* | NOT PERFORMED |

Row 14 is the one that matters most. Click-to-chat cannot observe delivery, and
the application must never claim it.

---

## 7. PWA checklist (§12) — ALL NOT PERFORMED

### 7.1 Install and run

| # | Test | iPhone | Android |
| - | ---- | ------ | ------- |
| 1 | Install to home screen | NOT PERFORMED | NOT PERFORMED |
| 2 | Icon correct, not a screenshot | NOT PERFORMED | NOT PERFORMED |
| 3 | Launches full screen, no browser chrome | NOT PERFORMED | NOT PERFORMED |
| 4 | Splash / first paint acceptable | NOT PERFORMED | NOT PERFORMED |
| 5 | Sign in from the installed app | NOT PERFORMED | NOT PERFORMED |

### 7.2 Offline behaviour

| # | Test | Expected | Result |
| - | ---- | -------- | ------ |
| 1 | Turn off the network | Offline banner appears | NOT PERFORMED |
| 2 | Navigate between cached screens | Screens still load | NOT PERFORMED |
| 3 | Open a customer viewed while online | Loads from cache | NOT PERFORMED |
| 4 | Edit an existing dress | Saves; says **"Saved on this device"** | NOT PERFORMED |
| 5 | **Create a reservation** | **REFUSED**, naming availability | NOT PERFORMED |
| 6 | **Record a payment** | **REFUSED**, naming the balance | NOT PERFORMED |
| 7 | **Refund** | **REFUSED** | NOT PERFORMED |
| 8 | **Settle a deposit** | **REFUSED** | NOT PERFORMED |
| 9 | **Issue an invoice** | **REFUSED**, naming the document number | NOT PERFORMED |
| 10 | Restore the network | Indicator returns to online | NOT PERFORMED |
| 11 | The queued dress edit | Syncs and confirms | NOT PERFORMED |

Rows 5–9 must **refuse**. If any of them succeeds offline, stop and report it —
that is a P0.

### 7.3 Update test (§12, §27)

Deploy `0.9.1` per DEPLOYMENT.md §12, then on a device already running `0.9.0`:

| # | Test | Expected | Result |
| - | ---- | -------- | ------ |
| 1 | Reopen the installed app | Update prompt appears | NOT PERFORMED |
| 2 | **Do not accept it yet** | App keeps working on the old version | NOT PERFORMED |
| 3 | Settings → About | Still shows `0.9.0` | NOT PERFORMED |
| 4 | Accept the update | App reloads | NOT PERFORMED |
| 5 | Settings → About | Now shows `0.9.1` | NOT PERFORMED |
| 6 | DevTools → Application → Service Workers | One active worker, no stale duplicate | NOT PERFORMED |
| 7 | Assets reloaded, not stale | No mixed-version behaviour | NOT PERFORMED |
| 8 | **Start a payment, then update mid-task** | Never swaps underneath you | NOT PERFORMED |

---

## 8. Defects found in UAT

None recorded — no testing has been performed.

| ID | Severity | Screen | Device | Description | Status |
| -- | -------- | ------ | ------ | ----------- | ------ |
| —  | —        | —      | —      | —           | —      |

Severity definitions are in TESTING.md §11. **P0 and P1 block production.**

---

## 9. Sign-off

| Role                | Name | Date | Result |
| ------------------- | ---- | ---- | ------ |
| UAT deployment      |      |      | **not deployed** |
| iPhone testing      |      |      | NOT PERFORMED |
| Android testing     |      |      | NOT PERFORMED |
| iPad testing        |      |      | NOT PERFORMED |
| Desktop testing     |      |      | NOT PERFORMED |
| Arabic testing      |      |      | NOT PERFORMED |
| Print — PDF         |      |      | NOT PERFORMED |
| Print — physical A4 |      |      | NOT PERFORMED |
| WhatsApp            |      |      | NOT PERFORMED |
| PWA install         |      |      | NOT PERFORMED |
| PWA update          |      |      | NOT PERFORMED |
| Owner acceptance    |      |      | NOT PERFORMED |

**Production remains blocked** until every row above is complete and any P0/P1
defect is fixed.
