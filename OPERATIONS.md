# Azhary Boutique — Operations

Runbooks for the people who keep the platform running.

---

## 1. Roles

| Role  | Who                | Can                                                                                                                            |
| ----- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| OWNER | Boutique owner     | Everything, including settings, VAT, business profile, terms, users, financial reports                                         |
| STAFF | Boutique employees | All day-to-day operations: customers, dresses, reservations, fittings, payments, pickup, return, WhatsApp, operational reports |

Staff cannot change VAT settings, edit the business profile, change global pricing
or numbering settings, edit Terms & Conditions, manage users, or delete financial
history. These limits are enforced by security rules, not by hiding buttons
(SECURITY.md §3).

---

## 2. Adding a staff member

1. Owner signs in → **Settings → Users → Add user**.
2. Enter name and email. The user receives a Firebase invitation to set their own
   password — the owner never sets or sees it, and no password is stored in
   Firestore.
3. Assign the STAFF role. Role assignment runs as a Cloud Function that writes an
   Auth custom claim; it cannot be performed by editing a database field.
4. The new claim takes effect on the user's next token refresh (within an hour,
   or immediately if they sign out and in).

### Removing access

Set the user to **inactive**. Rules reject every request from an inactive user.
Do not delete the account: their `createdBy` and audit references must remain
resolvable for the financial history to stay meaningful.

---

## 3. Backup and restore

### Scheduled backups

Production runs a daily Firestore export to a dedicated Cloud Storage bucket.

```bash
gcloud firestore export gs://<backup-bucket>/$(date +%Y-%m-%d) \
  --project <production-project-id>
```

Retention is agreed with the boutique; the bucket has a lifecycle rule so old
exports expire rather than accumulating cost.

### Manual backup before a risky change

Before a schema migration, a bulk import, or any bulk edit:

1. Run an export as above and confirm it completed.
2. Note the export path in the change record.

### Restore

```bash
gcloud firestore import gs://<backup-bucket>/<timestamp> \
  --project <production-project-id>
```

**Restore is destructive** — it overwrites documents in the target. Never restore
a production backup into production without first exporting the current state.
Practice restores into the development project.

### Restore drill

Rehearse quarterly, into development, and record the date and outcome. A backup
that has never been restored is a hypothesis.

---

## 4. Data export for the boutique

- **JSON backup** — full business data, from **Settings → Data → Export**.
- **CSV** — customers, dresses, reservations, payments, invoices, individually.

Import requires explicit confirmation, passes validation, and warns to take a
backup first (specification §49).

---

## 5. Daily operational checks

Nothing here is automated alerting yet; these are the human checks the dashboard
supports directly. Since Phase 7 the dashboard opens on **Today** — collections,
returns and fittings, then **Needs attention**, then what is coming. With no
records at all it says so rather than showing zeroes.

**Sheets** (`/sheets`) prints four lists on A4: today's collections, today's
returns, the cleaning queue and the alteration queue. Each row has a box to tick
and a signature line, because the person carrying it to the rail is not carrying
a tablet.

**Morning**

- Today's pickups — is each reservation paid to the configured threshold and is
  the security deposit received?
- Today's returns — which dresses are due back?
- Today's fittings — confirmed?
- Overdue returns — contact the customer.

**End of day**

- Returned dresses moved to _In Cleaning_.
- Payments recorded against the correct reservation.
- Damage logged with photographs while the evidence is fresh.

---

## 5a. Accessories and alterations

### The catalogue

`/accessories` holds veils, tiaras, boleros and jewellery. Each entry carries a
rental price, an optional sale price and a security deposit. Whether an item is
for rental, for sale, or either is recorded per entry — a sold item carries no
deposit, because the customer keeps it.

Entries are **retired**, never deleted. Past bookings reference them, and a
deleted entry would leave that revenue unattributable in the reports.

### Adding one to a booking

Open the reservation and use the Accessories panel. The catalogue price is
suggested and may be overridden — a customer may have been quoted differently —
but the price is snapshotted onto the booking, so a later catalogue change never
alters what was agreed.

Before you commit, the panel shows exactly what the change adds: the charge
including VAT, and any further deposit to hold.

### Recording an alteration

Same panel. Describe the work, enter the amount, and it is charged with VAT at
the booking's own rate. Who recorded it and when are both stored and frozen: an
alteration billed at 15.000 in September still reads 15.000 next year, whatever
the boutique charges for hemming by then.

### When charges are locked

Two situations, and the screen names which:

1. **An invoice has been issued.** The customer is holding a document. Void the
   invoice, make the change, and issue a new one — that leaves both on the
   record. Silently changing the booking would make the paper and the system
   disagree.
2. **The booking is finished** — Returned, Closed, Cancelled or No-Show. The
   account is being settled, and a new charge appearing mid-settlement is how a
   deposit gets refunded against a total that has since moved.

A gown that is still out with the customer can still gain an alteration: a hem
taken up at the last fitting is billed after the dress has left.

---

## 5b. Reading the reports

`/reports` covers one month at a time. Every money figure comes from the payment
ledger — not from a booking's status, not from a dress's current price.

**Security deposits are never counted as revenue.** They are the customer's
money, held against damage, and most of it goes back. They have their own line.

**Utilisation** is blocked days divided by operating days:

- *Blocked days* include the cleaning buffer, because the gown cannot earn
  during it.
- *Operating days* are only the days the dress was actually in the inventory. A
  gown bought on the 20th is measured over eleven days, not thirty.
- **N/A is not 0%.** A dress with no operating days in the month — bought later,
  or already retired — shows N/A. Zero percent would be a judgement: "available
  all month and never booked". The average across the inventory excludes N/A
  rows for the same reason.

**Revenue by dress** splits a booking's collection across its gowns in
proportion to their agreed prices. It is the best answer to "which gowns pay for
themselves"; it is not a claim that a particular customer paid a particular sum
for a particular dress, because a payment is made against a booking, not a gown.

**Accessory and alteration revenue** is what was *agreed* on the month's
bookings, not cash received — the ledger cannot say which part of a payment
settled a veil.

**The cancellation rate** is computed over bookings that actually concluded.
Live bookings are excluded: one has not failed, and counting it as a success
would be equally wrong. With nothing concluded the rate shows N/A.

---

## 6. Inventory and customer records

### Nothing is ever deleted

- A dress is **retired**, which removes it from the working inventory and
  prevents booking. The record and its photographs remain.
- A customer is **archived**, which removes them from everyday lists. Archiving
  is the only removal available: reservations, payments and invoices reference
  customers, and deleting one would orphan financial history.

Both are reversible except dress retirement, which is final — a retired dress
cannot return to the inventory. Add it again as a new record if it genuinely
comes back into service.

### Dress statuses staff cannot set by hand

`Reserved` and `Out with Customer` are set by the reservation engine. The status
control does not offer them, and the service refuses them, so the inventory
cannot be made to disagree with the bookings that drive it.

### Adding a dress or a customer needs a connection

Creating a record reserves a unique code on the server, which cannot be done
offline. Editing an existing record works offline and syncs later — the screen
says "Saved on this device" rather than claiming it reached the cloud.

### A duplicate phone number

The form warns and names who already holds the number. Family members share
numbers, so this never blocks — but saving requires ticking the acknowledgement,
so a second record for the same bride is never created by accident. Check the
named customers first; the usual cause is that search did not find her.

### Purchase cost is owner-only

It lives in a separate protected record, not on the dress itself, so staff
cannot see it even by reading the database directly.

---

## 7. Common situations

### A dress shows as unavailable but is physically on the rail

Check its status. `In Alteration`, `Under Repair` and `Retired` block booking
regardless of dates. Also check the cleaning buffer: a dress returned yesterday
with a three-day buffer is not bookable until the buffer expires. This is
intended — the buffer exists so a dress is not promised before it has been
cleaned.

The conflict message says which of the two it is. "Already booked for these
dates" and "still being cleaned after an earlier rental" are different
conversations to have with the customer, so the system does not blur them.

If a particular gown genuinely needs longer or less than three days, set
`cleaningBufferDays` on the dress itself. The dress-level value always wins over
the boutique default.

### The dress came back early and is clean — can we re-let it sooner?

Not by editing the buffer after the fact, which would change the answer for every
past and future booking of that gown. Move the earlier reservation's **return
date** to the day it actually came back; the blocked interval is recomputed from
it, and the gown frees up exactly three days later.

### Two employees tried to reserve the same dress

One succeeded, one received a conflict naming the clashing reservation. This is
correct behaviour: the booking is committed inside a server-side transaction that
re-checks availability, so a double booking cannot occur (SECURITY.md §5).

This holds under genuine simultaneity, not just near-misses — it is tested with
eight requests fired at once, and exactly one wins.

### "A connection is required to create a reservation"

Correct, and deliberate. Availability can only be judged against current server
state; a booking saved offline and synced later could be committed against dates
somebody else has since taken. Nothing is queued, so nothing will surprise you an
hour later. Edits to dresses, customers and reservation notes **do** work offline
and sync when the connection returns — it is only booking that refuses.

### The customer wants a dress that is taken

The conflict offers three routes, and an employee can take any of them without
leaving the screen: open the booking that holds the gown, shift the whole booking
to the next free date, or pick from similar dresses that are free for the dates
already entered. Similar means size first — a gown that does not fit is not an
alternative — then style, colour and designer.

If none will do, add the customer to the waitlist. **This sends no message.** It
records that they want the gown; somebody must still ring them. Automatic
notification arrives in a later phase, and until then the system will not claim
a customer was contacted when nobody was.

### A payment was recorded twice

It cannot be, if both submissions came from the same form. The request key is
generated when the form opens and becomes the event's identity, so a double
click, a retry after a timeout and a replayed request all land on the same
record. The screen says "already recorded" rather than posting a second one.

If two genuinely separate entries were made — the same cash counted twice, or a
payment put against the wrong booking — the owner **reverses** one with a
reason. Nothing is deleted and nothing is edited: the original stays exactly as
posted and the reversal sits beside it, so the statement shows both and they net
to zero. That is what makes the record answer "what happened" rather than only
"what do we currently believe".

Reverse only when the payment should never have been recorded. If money
genuinely went back to the customer, that is a **refund**, and recording it as a
reversal would leave the balance right and the cash position wrong.

### A customer paid more than the balance

The system refuses it. An amount above the outstanding balance is almost always
a typing error — an extra zero, or the security deposit entered on the payment
tab — and accepting it would create a credit the boutique then has to explain
and give back.

If the customer genuinely wants to pay ahead, take the correct amount now and
the rest when it falls due.

### The customer paid a deposit — why does the reservation still say unpaid?

Because a security deposit is not payment for anything. It is the customer's
money, held against damage, and it goes back at the end. It is shown in its own
block and never counted toward the rental.

This is also why a dress cannot be collected on a deposit alone: collection
needs the deposit held **and** the configured share of the rental paid.

### The dress came back damaged

Keep part of the deposit — "Keep part of the deposit" on the reservation — and
give the reason. The reason is required and is recorded: keeping a customer's
money without a written reason is indefensible if it is ever questioned, and it
will be.

Keeping the deposit is not the same as charging for the damage. It reduces what
is returned; it does not settle any rental the customer still owes.

### A dress came back late

Charge the late fee from the reservation, entering the date it actually came
back. The daily rate comes from settings and the calculation — rate, days and
dates — is frozen onto the charge, so changing the rate later cannot re-price a
fee already agreed with a customer.

It can only be charged once per reservation. A gown is returned late once.

### A customer wants to cancel

Open the reservation and choose "Cancel and calculate the refund". The screen
shows the notice period, which tier applies, what the boutique keeps and what
goes back — read those figures to the customer before confirming.

Confirming **calculates** the refund; it does not pay it. Record the refund
separately when the money actually leaves the till, with the method and
reference. The system will not let you refund more than the cancellation made
refundable, however many times you try.

### Only the owner can do some of this

Recording money coming in is everyone's job. Money going **out** — refunds,
returning or keeping a deposit — and any correction to a posted entry needs the
owner. That is the ordinary separation a boutique keeps over its till, and it is
enforced by the system rather than by convention.

### "A connection is required to record money"

Correct, and deliberate. Whether a payment is allowed depends on the balance
right now, so a payment saved offline and synced later could be committed
against a reservation that has since been refunded or cancelled. Nothing is
queued, so nothing will surprise you an hour later.

### Giving a customer their paperwork

Open the reservation and choose **Issue a document**. Pick the document and the
language, check the preview — it is exactly what will print — and issue.

Three documents, for three purposes:

- **Tax invoice** — the full record: what was rented, VAT, what has been paid,
  what is left. This is the document for the customer's records and the
  boutique's.
- **Rental agreement** — the contract. Carries the terms and the signature
  lines, and omits the payment history, because it records an undertaking rather
  than a settlement.
- **Payment receipt** — a short slip acknowledging one payment. It says on its
  face that it is **not** a tax invoice, so a customer does not leave believing
  they have one.

The language follows the customer's preference and can be overridden per
document. Bilingual puts English and Arabic side by side on one page.

### Printing and PDFs

**Print / Save as PDF** opens the browser's own print dialogue; choose "Save as
PDF" there for a file. There is no separate download button, because the browser
already does this correctly — including Arabic shaping, which is exactly where
add-on PDF tools tend to go wrong.

The system records that printing was _started_. It cannot know whether paper
came out, whether the dialogue was cancelled, or whether it went to a file, so
the log says "print initiated" and not "printed".

### An invoice has the wrong amount

Issued invoices are immutable. Void it with a reason and issue a corrected one.
The voided invoice remains in the record, which is what makes the correction
auditable.

### The VAT rate changed

Change it in **Settings**. Historical invoices are unaffected — each stores the
rate and amount that applied when it was issued (specification §11). Reservations
created before the change keep their snapshot pricing.

### Someone is offline

The application shows: _Offline — Changes are saved locally and will synchronize
when connection returns._ Reads work from cache. Writes queue. **Nothing is
reported as saved until the server confirms it.** WhatsApp requires a connection.

---

## 7a. Documents, the logo and the terms

### The boutique's details on documents

**Settings → Business profile**, owner only. Whatever is filled in appears on
every document; whatever is left blank is simply omitted.

**Leave the VAT and CR numbers blank until the boutique has the real ones.** The
system will never invent or default them, and a guessed registration number on a
tax invoice is a false statement to a customer and to the tax authority.

### The logo

Upload a PNG, JPEG or WebP under 2 MB. Replacing it does **not** change any
invoice already issued: each document holds the logo it was printed with, so old
paperwork keeps its own header. Only the owner can change it.

If no logo is uploaded, documents show the business name in its place. Nothing
is broken; that is the intended fallback.

### The terms

**Settings → Terms and conditions**, owner only. Six topics are prompted —
damage and loss, late return, cancellation and refunds, alterations, security
deposit, hygiene and cleaning — and **no wording is supplied**. The boutique
writes its own, in English and in Arabic. A section left blank is not printed.

Publishing creates a **new version** and makes it active. A published version is
never edited: documents already issued carry a frozen copy of the wording their
customer agreed to, and editing it would silently rewrite signed contracts.

To change a clause, edit the text and publish again. Old agreements keep their
own text, and each document prints the version it used.

### Voiding a document

Only the owner, and only with a reason. The document is kept, marked VOIDED, and
its number stays in the sequence — a missing invoice number is indistinguishable
from tampering, which is exactly what an auditor would ask about.

Voiding withdraws the **document**. It does not reverse a payment; if money needs
to go back, record a refund separately.

---

## 8. Print checklist (manual)

Browser print output is the actual deliverable for invoices, so it is verified by
hand. Before any release that touches documents:

- [ ] Invoice fits A4 (210 × 297 mm) with correct margins
- [ ] A long reservation flows across pages with nothing clipped
- [ ] Table headers repeat on continuation pages
- [ ] No orphaned signature block
- [ ] English invoice — correct layout, logo, business details
- [ ] Arabic invoice — RTL, correct letter shaping, correct numerals
- [ ] Bilingual invoice — both languages legible, no overlap
- [ ] Dress photograph renders at correct aspect ratio, not stretched
- [ ] Verified in Chrome and Safari, and on the boutique's own printer

---

## 9. Audit log

Every financially or legally significant change records who, when, what, the
entity and the before/after values: reservations, payments, cancellations,
deposit decisions, price changes, terms changes, settings changes, role changes
and voids.

Readable by the OWNER under **Settings → Audit**. Append-only — no role can edit
or delete an audit entry.

---

## 10. Support escalation

1. Reproduce and note the exact time, the user, and the record involved.
2. Check the audit log for that entity.
3. Check the browser console and the Firebase console (Firestore usage, rules
   denials, Functions logs).
4. A rules denial in the logs usually means the correct control fired — confirm
   the user's role and active flag before treating it as a bug.
