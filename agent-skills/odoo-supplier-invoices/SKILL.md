---
name: odoo-supplier-invoices
description: "Books a supplier's invoice as a vendor bill in Presentail's Odoo (Cyprus, EUR) AND reconciles it against the Revolut bank feed — two halves of one job. Use whenever the user wants to add, book, post, reconcile, match, re-pair or pay a supplier invoice in Odoo — even a single invoice. Presentail-specific; Odoo via the Make MCP."
---

# Supplier invoice → Odoo (book + reconcile)

Presentail's **Cyprus** entity (Presentail LTD, VAT CY10422991V) pays suppliers in **EUR**
from Revolut — usually on the card, sometimes by wire. Each payment produces a PDF
invoice/receipt. The job is always two halves: **(1) book** the invoice as a posted vendor
bill, and **(2) reconcile** it against the Revolut charge that is already in Odoo's bank
feed, so the bill is marked paid and **nothing is left in Accounts Payable**. Booking
without reconciling is an unfinished job.

**The Odoo database is `https://presentail.odoo.com`.** (An earlier version of this file
said `presentail-gifts.odoo.com`; that host is dead and returns Odoo's "Page not found".)
Odoo is reached two ways, good at different things:

- **The Make MCP** (`odoo:makeApiCall` on the "Odoo finance new" connection, id 6330934) —
  for all reading, creating, posting and reconciling. There is no direct Odoo REST API.
- **Claude in Chrome** — for attaching documents (Step 4) and for eyeballing a record when a
  query result is confusing.

All shared Odoo IDs, the booking recipe, and the reconciliation recipe live in
`references/odoo_ids.md` — **read it before doing anything**. The per-supplier details live
in `references/suppliers.md`.

**For a Lebanese supplier statement in Presentail SAL (company 2, USD), this is the wrong
skill** — use `sal-supplier-statement-reconciliation`. The entity, journals, accounts and
payment rails are all different.

## Step 0 — Identify the supplier and load its profile

Figure out which supplier the invoice is for, then open its profile in
`references/suppliers.md`. A profile supplies everything supplier-specific:

- `partner_id` (the Odoo vendor) and VAT number
- `expense account_id` (e.g. Advertising, Software/Subscriptions)
- `tax` treatment (usually 19% reverse charge for non-Cyprus EU/US suppliers)
- `bank-feed label` — how Revolut names the charge (e.g. `Facebk *…`, `OPENAI`), used to
  find the charge for reconciliation
- `ref` format, PDF source (a Drive folder, or the user uploads it), and any
  classification quirks (e.g. Meta's "Advertising credit" receipts that are skipped)

**If there is no profile for this supplier**, gather those fields (probe Odoo for the
vendor / expense account / tax with a temporary `search_read` — see `odoo_ids.md`), do the
job, then offer to save a new profile so next time is one step. Never guess an expense
account or tax silently — confirm with the user on first use of a new supplier.

**Payroll / contractor platforms bill in two streams.** Oyster HR, Deel, Remote and the like
send (a) their own platform-fee invoice and (b) one invoice per contractor, and both hit the
feed as separate charges. They are different suppliers with different expense accounts —
platform fee to software, each contractor to Sub-contractors on the contractor's own vendor.
Ask before assuming they share a vendor.

**A partner scoped to another company cannot be used on a Cyprus bill.** Many contacts carry
`company_id` = 2 (Presentail SAL). Clear `company_id` to `false` to make the contact shared
— non-destructive, and keeps one contact per human — rather than creating a same-named
duplicate. Confirm which the user wants.

## Step 1 — Read the invoice and capture the booking fields

Read the PDF (the user uploads it, or pull it from the profile's Drive folder with the
Drive connector's `read_file_content`). Capture:
- `ref` — the supplier's invoice number (profile says the format).
- `date` — the invoice / payment date, as `YYYY-MM-DD`.
- `amt` — the amount actually paid. Under reverse charge this is both the untaxed amount
  and the total (the RC VAT nets to zero).
- `drive` — the Drive file id, if attaching from Drive.

Apply any profile classification rules (e.g. skip promotional-credit receipts that are not
tax invoices). For a **batch** (a whole folder / many PDFs), classify each and build a table.

## Step 2 — Dedup against Odoo

Never double-book. Query existing bills for this vendor and match on the invoice number:
```
search_read  account.move
  domain: [["move_type","=","in_invoice"],["partner_id","=",<vendor>]]
  fields: ["ref","amount_total","payment_state","invoice_date"]
```
Make's responsive run doesn't surface output — dump results to a scratch data store and read
them back (pattern in `odoo_ids.md`, and see "Reading query output" under Step 7). Skip
anything already present.

## Step 3 — Preview and get a go-ahead

This posts to live books — never fire silently. Show a short table (date, invoice #,
amount, expense account, action = post / skip-duplicate / skip) and wait for approval. A
spreadsheet is a nice deliverable when there are many rows. For one invoice, a one-line
confirmation is enough.

## Step 4 — Book the bill, and always attach the document

Create the vendor bill with the booking recipe in `odoo_ids.md`, using the **profile's**
vendor, expense account, and tax. `action_post` it. Leave it **unpaid** — payment is settled
by reconciliation in Step 6, not by registering a payment. For a batch, the saved poster
scenario iterates download → dedup → create → attach → post (see `odoo_ids.md`).

**Attaching the source document is not optional.** The user's standing instruction is that
every bill carries the supplier's own invoice — photo, scan or PDF. A bill posted without
its document is an unfinished bill.

### Getting the document into Odoo

**Route 1 — Claude in Chrome, for a file the session already holds.** Odoo's chatter has a
hidden `<input type="file">`, and `file_upload` writes straight to it. A few calls per bill,
no size ceiling, no transcription risk:

```
1. navigate   https://presentail.odoo.com/odoo/bills/<move_id>
2. wait       Odoo's SPA takes ~5-10s; `find` returns a bare accessibility tree until it loads
3. find       "hidden file input element used by the Attach files paperclip button"
4. file_upload  paths=[<local path>]  ref=<that ref>
```

Never *click* the paperclip — that opens a native file dialog which cannot be driven.
`file_upload` only accepts files the session already has: chat attachments, the session's
uploads/outputs folders, or a connected device folder. Files on the user's machine must be
staged with `device_stage_files` first.

**Route 2 — the file lives in a web app the user is signed in to: browser → Make webhook.**
Reach for this when the file is in Slack, because Make's Slack connections at this org go stale
and return **`token_revoked`**, killing every server-side Slack→Odoo attacher. It passes no bytes
through the conversation and has no practical size limit:

```
1. navigate Chrome to the file's own URL
   Slack: https://files.slack.com/files-pri/<TEAM_ID>-<FILE_ID>/<name>.<ext>   (team TGAGWLJS1)
2. javascript_tool on that page:
   fetch(url, {credentials:'include'}) → blob → FileReader → base64
   POST {fname, moveid, mime, datas} to the Make webhook "Odoo attachment intake"
   (scenario 7236177, <Make webhook URL — redacted; not used in Hive>)
   — it creates the ir.attachment on the move. Space posts ~1s apart.
3. verify in ir.attachment
```

Set the final filename in the webhook payload, so no rename is needed afterwards.

**Route 3 — already in Gmail.** Scenario **"Attach invoice PDF from Gmail (filtered)"**
(6764335). Feed it `{msg, fname, moveid, match}`; it pulls the attachment server-side.

**Route 4 — already in Drive.** The generic poster (7121887) does dedup → create → attach →
post in one pass from a Drive file id. Also server-side.

**Route 5 — the chunked base64 route. Last resort, and now almost never needed** — Route 2
supersedes it for anything reachable in a browser. What it costs: split the base64 into
~7,400-character chunks (9 for a 50 KB PDF); dispatch one subagent per chunk, each writing to a
scratch data store (`data-store-records_create`, key `pdfc_<n>`, field `t1`) and **verifying with
`printf '%s'` + `cmp` against the source** — several chunks came back wrong first time, once
with 48 characters dropped inside a repetitive run; then a Make scenario with one
`datastore:GetRecord` per chunk and `"datas":"{{1.t1}}{{2.t1}}…"`. Working example: **"Oyster:
PDF chunks (9) → Odoo attachment"** (7239005); the 3-chunk ManyChat original is 7235668.
Delete the chunk records afterwards. A single-shot upload of a hand-transcribed base64 string
silently produces a truncated, corrupt file that the API accepts without complaint — never
attempt one.

**Verify against Odoo, not against the screenshot** — the chatter panel re-renders and tells
you nothing:
```
search_read  ir.attachment
  domain: [["res_model","=","account.move"],["res_id","in",[<move ids>]]]
  fields: ["name","res_id","file_size","checksum","mimetype"]
```
**PDFs are stored byte-for-byte**: `file_size` and `checksum` (a SHA-1) must equal the local
file's. **Images are not.** Odoo re-encodes large images on upload — a 431 KB photo is stored at
~163 KB with a different checksum. That is image optimisation, not truncation, and is not
evidence of a bad upload; check instead that exactly one attachment landed per move and that the
stored size is plausible rather than a fraction of a fraction.

Camera filenames are useless in the chatter — rename after upload:
`write ir.attachment [[<id>],{"name":"<Supplier> invoice <ref> - <DD.MM.YYYY>.<ext>"}]`.

Send the **original** file the user gave you, not a re-compressed copy — let Odoo do any
downsizing itself, so what arrives is a real audit link back to their document.

## Step 5 — (batch only) verify the booking

For a batch, re-query the vendor's bills: confirm the new count, no duplicate invoice
numbers, all posted, and the euro total matches the preview; sanity-check the attachment
count. For a single invoice, just confirm it posted.

## Step 6 — Reconcile the bill against its bank charge (mark it paid)

Every bill is paid by a Revolut charge already in Odoo's bank feed — usually a card charge,
sometimes a wire. Connect each charge to its invoice and mark the bill paid so **no line is
left in Accounts Payable**.

**Find the charge.** The profile's **bank-feed label** identifies it (e.g. `Facebk *…`,
`OPENAI`, `To OYSTER HR, INC.`). The charge is a debit sitting in one of two places:
- **Bank Suspense** (account **221**, code `1200`) — most charges; **non-reconcilable**.
- **Accounts Payable** (account **93**) already — e.g. a prepaid top-up charge.

**Never search Suspense by the bank label** — only the bank-side line carries it, so
`account.move.line [account_id=221, name ilike <label>]` returns nothing even when charges
are sitting there. Go via `account.bank.statement.line [payment_ref ilike <label>,
is_reconciled=false]` → `move_id` → the counterpart line. Full detail in `odoo_ids.md`.

**Match by amount + `date`, not by label text.** For card charges the label's reference
string is not stored on the bill, and identical amounts repeat — so pair by amount and by
charge date (bill `invoice_date` ≈ charge date, often +1 day). Pull `account.move.line.date`
on both sides. **Wires are the happy exception**: Revolut renders them
`To <VENDOR NAME> <invoice ref>`, carrying the real invoice number, so the pairing is exact.
Read the label before assuming you have to infer.

**Reclass each charge inside its own statement line.** Do NOT post a separate reclass
journal entry — that balances the ledger but leaves the bank statement line unmatched in
Bank Matching, still showing "Set Partner / Set Account". Instead: `button_draft` the
statement lines' moves (batchable) → `write` each suspense line to `account_id` 93 +
`partner_id` = vendor (batchable) → `action_post` (batchable). Charges already sitting in
AP need no reclass. A move containing a **reconciled** line cannot be drafted — un-reconcile it
first.

**Never change a line's amount without reading the move's own debit/credit first.** When you
split or repoint a line, the replacement amounts must sum to exactly what was there, in
company currency. Do not compute them from a headline FX rate — individual entries carry
their own rates, and a split built on the wrong one is rejected as unbalanced. Through the
`builtin:Resume` handler that failure comes back as an empty body, which reads like success
at a glance, so re-query the move afterwards rather than trusting the run.

**Reconcile ONE charge against ONE bill.** Never pass a whole netting-to-zero set to a
single `reconcile()` call: Odoo pairs it arbitrarily, so bills end up linked to the wrong
charges. Every bill still shows `paid` and AP still hits zero, so the failure is invisible
unless you check the pairings themselves. Batch the 1:1 calls behind a `builtin:Resume`
error handler — ready-made scenario and blueprint in `odoo_ids.md`. Where a payment spans two
bills, that is two calls; Odoo applies `min(residual)` each time, so order them oldest-first.

**Repairing an over-matched account.** If bills show `paid` against far less payment than
actually exists, look at `amount_residual_currency` on the payment lines: a residual whose
sign is **opposite** to the line's own balance means Odoo has applied more credit than the
line carries. `remove_move_reconcile` on the affected lines resets everything to clean open
residuals (and reverses Odoo's auto `EXCH` entries), after which you can re-pair correctly.
Before accepting it as a cosmetic artefact, check whether the underlying charge was only
*partly* posted to AP — where that is the cause, moving the remainder in fixes line and
residual at once.

**Let Odoo do the FX.** Book each bill in the currency its charge settled in: the foreign
currency at invoice face value when the charge is in that currency (Odoo then posts the EUR
difference itself to 7910), or EUR at the exact charge amount otherwise. A manual FX entry
is only needed when bill and charge are in two *different* foreign currencies. For any 2025
bill, first check `res.currency.rate` actually has rates loaded — see `odoo_ids.md`.

A foreign-currency invoice that **prints its own EUR payable amount** and is settled in EUR
is not an FX case at all: book it in EUR at that figure and it reconciles to the cent.

**Card/FX fee lines are not invoices.** Bank-feed lines like `Fee for <label> *…` are the
card's own fees — no supplier invoice exists. Reclass them to **7910** (`Dr 202 / Cr 93
partner`) and reconcile out of AP. Never match a fee to a bill.

**Mechanics / gotchas** (full detail in `odoo_ids.md`):
- `reconcile()`, `remove_move_reconcile()` and `action_post` return `None` → the Make run
  reports `cannot marshal None`, **but it already committed** server-side. Don't retry —
  verify state instead.
- Chain 1:1 reconciles behind **`builtin:Resume`**, never `builtin:Ignore` (Ignore stops
  after the first commit; Resume carries on through the whole list). Give the handler the
  real error text — `output: "ERR: {{2.error.message}}"` — or a bad argument shape, an
  unreadable model, an empty result and the benign marshal-None all look identical.
- **The `odoo:makeApiCall` argument shape is the opposite of what the field names suggest.**
  `parameters` carries the **positional** args (`[[domain]]`, `[[ids],{vals}]`, `[{vals}]`);
  `search_params` carries the **kwargs** (`{"fields":[…],"limit":n,"order":"…"}`). Reversing
  them fails with `dictionary update sequence element #0 has length 3; 2 is required`.
- A probe scenario that maps a many2one via `map(map(body; <field>); "id")` fails with
  "Cannot read properties of undefined" when the **field does not exist on that model** —
  `company_id` is `company_ids` on `account.account` in this Odoo. A `false` value is fine;
  a missing field is not. Map a field you know exists (`currency_id`) when you only need the
  mapper not to crash.
- If the charge **isn't in the bank feed yet**, book+post the bill and tell the user it
  will reconcile on the next run — don't invent a payment.

## Step 7 — Verify and report

Vendor AP = 0 is **not** proof the job is right — a mis-paired batch passes that check.
Confirm all four:

1. `account.move.line [account_id=93, partner_id=<vendor>, reconciled=false]` → empty
2. `account.move [move_type=in_invoice, partner_id=<vendor>, payment_state in (not_paid,partial)]` → empty
3. `account.bank.statement.line [payment_ref ilike <label>, is_reconciled=false]` → empty.
   **This is the one the user actually sees** — anything here shows as pending in Bank
   Matching, even when Suspense nets to zero and every bill says Paid.
4. `account.partial.reconcile` → **one row per bill, each pointing at that bill's own
   charge**. This is the check that catches wrong pairings.

Report: N posted (total), M skipped and why, all reconciled 1:1 and paid, FX to 7910, and
anything deliberately left in suspense.

### Reading query output without drowning in it

`data-store-records_list` returns **every** record in the store — no key filter, no offset —
so a shared store full of large rows is unreadable, and one holding base64 chunks is
catastrophic. Create a **private scratch store** per job (structure: text fields
`t1`/`t2`/`t3`), point a clone of the generic exec+probe scenario at it, and delete your
records after each read so the next `list` stays small. Existing: **"Oyster: Odoo generic
exec+probe"** (7239011 → store 179766), **"Stripe: Odoo generic exec+probe"** (7236172 →
store 173143). Never probe into the shared `CY recon` store (152658) — it is at its
100-record cap, so anything written there comes back unreadable. When you must share a store
with another session, prefix your keys and delete only your own.

## Guardrails

- **Never leave the supplier in Accounts Payable.** Booking without reconciling is
  unfinished. Currency differences and card fees go to **7910**, never parked in AP or
  Suspense.
- **Every bill carries its document.** Attach via Route 1 or 2, then prove it by querying
  `ir.attachment` — one per move, byte-exact for PDFs, plausibly sized for images.
- **Match by amount + date, never amount alone.** Duplicate amounts are common; the charge
  date usually makes each pairing unique. When it doesn't — several identical amounts on
  one day, as with ManyChat — use the invoice numbers, and where the assignment is genuinely
  arbitrary among identical invoices, **say so** rather than implying precision you lack.
- **One charge, one bill.** Never set-reconcile a batch. Verify the pairings, not just the
  AP total. (Exception: a prepaid top-up that genuinely settles several bills — that is a
  real many-to-one group.)
- **Name every reclass and FX line with both identifiers** — `<Vendor> <invoice ref>
  (<bank ref>)`. It costs nothing and it is the only thing that makes a botched batch
  repairable later.
- **Never claim an attachment landed without querying `ir.attachment`.** A truncated base64
  upload returns a perfectly normal-looking id and a corrupt file.
- **An empty query result is a claim about your query, not about the books.** If a search
  returns nothing where something should exist, suspect the domain — especially a `name`
  filter — before concluding the data is inconsistent.
- **No document, no bill.** A charge with no invoice stays in suspense and gets reported to
  the user — don't manufacture a bill from a bank line.
- **Never invent a payment.** Bills are paid only by reconciling a real bank-feed charge. A
  cash movement carrying someone else's name is not this supplier's payment, however well
  the date and amount fit — surface it and let the user confirm.
- **Reverse charge nets to zero.** For RC-taxed bills, `amount_total` = `amount_untaxed` =
  the figure on the receipt. If the total comes out higher, the wrong tax was used.
- **Right entity.** Presentail LTD Cyprus (company **1**, EUR) — not Lebanon (id 2) or UAE
  (id 3), unless a profile says otherwise.
- **New supplier = confirm the profile.** Don't guess expense account or tax; confirm, then
  offer to save the profile.
- **Never post without a preview and go-ahead.** Don't hard-delete the user's PDFs.

---

## Appendix — profile pending merge into `references/suppliers.md`

*A saved proposal can only replace this file, so a new profile is parked here until the
reference file is next edited by hand. Move it across and delete this appendix.*

### OysterHR — contractor platform, TWO streams, paid by EUR wire

Oyster HR, Inc. (US) is the payment agent for Presentail LTD's Lebanese contractors. Each
cycle produces **two kinds of invoice**, both wired in EUR from **Revolut EUR (journal 12)**
— not the card — so they land in Bank Suspense with a clean, invoice-numbered label.

| Field | Value |
|---|---|
| `partner_id` | **312** — Oyster HR, Inc., 301 S McDowell St, Charlotte NC, US (country 233). No VAT number |
| `expense account_id` | **186** — code `6255 Computer software` |
| `tax` | **24** — `19% RC`; format `[[6,0,[24]]]` |
| `bank-feed label` | **`To OYSTER HR, INC. <invoice ref>`** — carries the real invoice number, so pairing is exact |
| `ref format` | **`OY-Pres-<hash>-<MMYY>-CF-INV<n>`** |
| `PDF source` | emailed by `noreply@email.oysterhr.com`, subject `Oyster invoice <ref> due <date>` — attach with scenario 6764335 |
| `line name` | `Oyster subscription fee <Mon YYYY> (<contractors>) - <ref>` |
| `currency` | EUR throughout — no FX |

The `-CF-INV` invoice is Oyster's own platform fee and lists **one line per contractor**
(€27 each). It is a single bill on partner 312 however many contractors it covers.

**Contractor invoices are a separate vendor per person.**

| Field | Value |
|---|---|
| `partner_id` | the contractor's own contact — e.g. **15** Mohammad Ballan (Beirut, tax 03110078169). Existing SAL contacts have `company_id` = 2; clear it to `false` to reuse them |
| `expense account_id` | **137** — code `6002 Sub-contractors` |
| `tax` | **28** — `0% OEU`; format `[[6,0,[28]]]` — **see the VAT note** |
| `bank-feed label` | **`To OYSTER HR, INC. OY-PRES-<NAME4>-<hash>-<seq>`** — payee is Oyster, invoice is the contractor's |
| `ref format` | **`OY-PRES-<NAME4>-<hash>-0000001`**, sequence per contractor |
| `PDF source` | **Oyster dashboard only — never emailed.** The user downloads it; attach via Route 1 in Step 4 |
| `line name` | `Contractor services <Mon YYYY> (via Oyster HR) - <ref>` |
| `invoice_date` | the PDF's **Issue Date**, mid-month and well before the payment date |
| `currency` | invoiced **USD**, with the EUR payable printed on the invoice. Book **EUR at that figure** — it equals the wire to the cent, so no FX |

> **VAT note — unresolved, same question as ManyChat and Loom.** The contractor is booked
> `0% OEU` at the user's direction. Cyprus would normally reverse-charge services from
> outside the EU (`19% OEU`, tax **29**, currently unused). Pending accountant review — do
> not treat it as settled precedent.

**Worked reference (Sep 2026).** Two wires on 4 Sep, both Revolut EUR. €54.00
(`OY-Pres-BwDyHSm9-0826-CF-INV1`, 1 Sep, covering Ahmad Saade + Mohamad Ballan for Aug) →
bill 45543 `IN55672784` on partner 312, PDF pulled from Gmail. €1,436.83
(`OY-PRES-MOHA-Gt9IfSCb-0000001`, issued 10 Aug, USD $1,600 @ 1.1136) → bill 45544
`IN55672783` on partner 15, PDF transferred in 9 verified base64 chunks and checksum-matched
(49,994 bytes, sha1 `2a1d0a23…`). Suspense lines 132478 / 132476 repointed inside their own
statement moves and reconciled 1:1. All four checks clean.

Ahmad Saade has his own contractor stream (`OY-PRES-AHMA-arjFaKgE-…`) not yet in the feed —
expect it next cycle, on its own vendor.