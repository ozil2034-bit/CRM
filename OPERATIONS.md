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
is designed to support.

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

It cannot be, if both submissions came from the same form — a unique idempotency
key collapses retries into one payment. If two genuinely separate payments were
entered in error, the owner **voids** one with a reason. Payments are never
deleted; the void is recorded and audited.

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
