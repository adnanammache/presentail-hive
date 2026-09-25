---
name: sal-supplier-statement-reconciliation
description: "Reconcile a Lebanese supplier's statement of account against Presentail SAL's Odoo ledger in USD — book missing bills with their documents, reclass payments out of cash/Whish suspense into AP, and re-pair 1:1 so AP equals the statement."
---

# Supplier statement → Presentail SAL's Odoo (Lebanon, USD)

A supplier sends a statement of account. The job is to make **Odoo's AP for that partner equal
the statement's closing balance**, with every bill documented and every payment paired to the
bill it actually settled. This is the Lebanon/USD counterpart to `odoo-supplier-invoices`
(which covers Cyprus/EUR/Revolut) — do not mix their IDs.

Odoo is `https://presentail.odoo.com`, reached through the **Make MCP** (`odoo:makeApiCall`,
connection **6330934**). There is no direct REST API.

## The shape of the problem, every time

The statement is usually right and Odoo is usually incomplete, in two specific ways:

1. **Invoices were never booked** — the shop took delivery, nobody entered the bill.
2. **Payments left the till but never reached AP** — the cash/Whish move was recorded, but its
   counterpart sits in a suspense account with no partner, so it shows as pending in Bank
   Matching and the bill still looks unpaid.

These two errors offset, so **AP can look plausible while being wrong on both sides**. Never
conclude from a near-matching total that the account is fine.

## Step 1 — Identify the partner and its AP account

```
search_read res.partner  [["name","ilike","<name>"]]  fields [name,vat,company_id,supplier_rank]
```

Suppliers here often carry a **partner-specific AP account** (Vaco → 1998, Moukhallalati → 1960),
not a shared payable. Find it from an existing bill:

```
search_read account.move.line [["partner_id","=",<id>],["account_id.account_type","=","liability_payable"]]
```

Also read an existing bill's product line (`display_type = product`) to get the **expense account**
and tax this vendor is actually booked with, rather than guessing.

| Shared | Value |
|---|---|
| company_id | **2** (Presentail SAL) |
| purchases journal | **14** |
| currency | USD (**1**) |
| VAT | some suppliers carry 11%, others none — check an existing bill before assuming |

Cash-side accounts you will meet: **1905** Cash USD, **1895** Whish Money, **1929** BOB Finance
Usd, **1896** Warehouse Cash — each with a suspense counterpart, usually **1900** Cash Suspense
or **1894** Whish Money Account, occasionally **379** Bank Suspense. Journals: **43** CASH USD,
**45** Warehouse Cash, **52** Bob Finance Usd.

## Step 2 — Transcribe the statement and pull the ledger

List every charge and every credit with date, reference and amount, and check your transcription
against the statement's own closing balance before touching Odoo.

Then pull, in this order:

```
search_read account.move       [["partner_id","=",<id>],["move_type","in",["in_invoice","in_refund"]]]
search_read account.move.line  [["account_id","=",<AP account>]]
search_read account.move       [["partner_id","=",<id>]]        ← catches moves that never hit AP
```

The third query is the one that finds misposted payments: a cash-out tagged with the partner but
booked to a suspense account appears there and nowhere else.

### Finding the payments the partner tag missed

**Do not trust a name search.** Shop staff type the supplier's name freehand, differently every
time — one vendor appeared as *Vaco*, *Vako* and *vaco*, and the payee as both
*wartex kouyoumdjian* and *wartex kouyomdajian*. Two of that supplier's nine payments were
invisible to every name search and were found only this way:

```
search_read account.move.line
  [["account_id","in",[1905,1895,1929,1894,1900,379]],
   ["date",">=","<window start>"],["date","<=","<window end>"],
   ["amount_currency","=",-<statement amount>]]
```

Run it for each statement credit you cannot otherwise place. **Search by amount + date, then read
the name to confirm** — never the reverse.

## Step 3 — Build the bridge and get a go-ahead

Produce a reconciliation that ties exactly:

```
Odoo AP today
  + invoices on the statement not booked in Odoo
  − payments on the statement that never reached AP
  = statement closing balance
```

If it does not tie to the cent, something is still unidentified — find it before posting. Show
the user the bridge, the bills to create and the lines to reclass, and **wait for approval**.
This posts to live books.

Statement dates often drift a day or two from Odoo's; match on amount and near-date, and say so
rather than silently forcing a date.

## Step 4 — Book the missing bills, each with its document

```
create account.move
[{"move_type":"in_invoice","partner_id":<id>,"journal_id":14,"company_id":2,"currency_id":1,
  "invoice_date":"YYYY-MM-DD","date":"YYYY-MM-DD","ref":"<supplier invoice no>",
  "invoice_line_ids":[[0,0,{"name":"<what it was> - <vendor> inv <ref>",
    "account_id":<expense account>,"quantity":1,"price_unit":<amount>,"tax_ids":[[6,0,[]]]}]]}]
```

Then `action_post` them as a batch. Use the document's own date as `invoice_date`, even where the
statement posted it later.

**No document, no bill.** The user's standing rule is that every bill carries the supplier's own
invoice. Documents for these suppliers are usually **photos of a handwritten invoice book sent to
Slack #statement-ofaccount** — see the attachment route below.

## Step 5 — Reclass the stranded payments into AP

Move each counterpart **inside its own statement move**, never as a separate reclass JE — a JE
balances the ledger but leaves the line unmatched in Bank Matching:

```
1. button_draft  account.move       [[<all the statement move ids>]]        ← batchable
2. write         account.move.line  [[<line>],{"account_id":<AP>,"partner_id":<id>,
                                    "name":"<Vendor> payment <DD.MM.YYYY> (<move> <source>)"}]
3. action_post   account.move       [[<the same move ids>]]                 ← batchable
```

Name every line with **both identifiers**. It costs nothing and it is the only thing that makes a
botched batch repairable later.

**A move containing a reconciled line cannot be drafted.** Un-reconcile first — see Step 6.

## Step 6 — Tear down the old reconciliation, then re-pair 1:1

Where any of the partner's bills are already partly settled, **remove all of it and rebuild**:

```
remove_move_reconcile  account.move.line  [[<every AP line for this partner>]]
```

Then pair **FIFO by date, one payment against one bill per call**:

```
reconcile  account.move.line  [[<payment line>,<bill AP line>]]
```

A payment that spans two bills is two calls; Odoo applies `min(residual)` each time, so ordering
the calls oldest-first allocates correctly. **Never pass a whole netting-to-zero set to one
`reconcile()`** — Odoo pairs it arbitrarily, every bill still shows `paid`, AP still hits zero,
and every individual pairing is wrong.

### The over-matched line

A payment line whose `amount_residual_currency` has the **opposite sign to its own balance** has
been reconciled for more than it carries. On this ledger the usual cause is real, not cosmetic:
the payment was, say, 500 but only 300 was posted to AP and the rest went to suspense. Moving the
remainder into AP fixes the line and the residual together — look for that before writing it off
as an artefact to be lived with.

## Step 7 — Verify, four ways

AP = the statement is **not** sufficient; a mis-paired batch passes it.

1. `account.move.line [account_id=<AP>, reconciled=false]` → only the genuinely open bills, and
   their total equals the statement's closing balance.
2. `account.move [move_type=in_invoice, partner_id=<id>]` → every settled bill `paid` with
   `amount_residual` 0.
3. `account.partial.reconcile [credit_move_id in <the bill AP lines>]` → read **every row** and
   confirm each payment is against the bill you intended. This is the check that catches
   mis-pairing.
4. `ir.attachment [res_model=account.move, res_id in <the new bills>]` → exactly one per bill.

## Attaching the documents

### Preferred: browser → Make webhook (works when Make's Slack connection is down)

Make's Slack connections at this org go stale and return **`token_revoked`**, which kills every
server-side Slack→Odoo attacher. This route needs none of them and passes no bytes through the
conversation:

1. Drive the user's Chrome to the file's own URL —
   `https://files.slack.com/files-pri/<TEAM_ID>-<FILE_ID>/<name>.jpg` (team `TGAGWLJS1`; file ids
   and names come from `slack_read_channel` / `slack_read_file`).
2. With `javascript_tool` on that page, `fetch` each file **same-origin with
   `credentials:'include'`**, read it to base64 with `FileReader`, and `POST`
   `{fname, moveid, mime, datas}` to the Make webhook **"Odoo attachment intake"**
   (scenario **7236177**, `<Make webhook URL — redacted; not used in Hive>`), which
   creates the `ir.attachment` on the move. Space the posts ~1s apart.
3. Verify in `ir.attachment`.

The same trick works for any web app the user's browser is signed in to. It beats the base64
chunking route outright — no transcription risk, no context cost, no practical size limit.

**Odoo re-encodes large images on upload.** A 431 KB photo is stored at ~163 KB with a different
checksum. That is image optimisation, **not** truncation, and is not evidence of a bad upload.
Check instead that exactly one attachment landed per move and the stored size is plausible.
(PDFs are stored byte-for-byte; checksum those normally.)

### Alternatives

- Already in Gmail → scenario **6764335** "Attach invoice PDF from Gmail (filtered)".
- Already in Drive → scenario **6801562** "SAL: attach Drive file to Odoo move (generic)".
- A file the session already holds → Claude in Chrome `file_upload` into the Odoo chatter's
  hidden `<input type=file>` (find it; never click the paperclip — that opens a native dialog).

## Running Odoo calls through Make

Use a generic exec+probe scenario: `BasicFeeder` → `odoo:makeApiCall` with `action`/`entity`/
`parameters`/`search_params` from the feed, a `builtin:Resume` error handler carrying
`"ERR: {{2.error.message}}"`, and a `datastore:AddRecord` writing `{{2.body}}` so you can read
results back. Existing: **7297730** "Moukhallalati: Odoo generic exec+probe (JSON)" → store
**182639**.

- **The argument shape is the opposite of what the field names suggest.** `parameters` carries
  the **positional** args (`[[domain]]`, `[[ids],{vals}]`, `[{vals}]`); `search_params` carries
  the **kwargs** (`{"fields":[…],"limit":n,"order":"…"}`).
- `reconcile()`, `remove_move_reconcile()` and `action_post()` return `None`, so the module always
  raises `cannot marshal None` — **it committed anyway**. Verify state; never retry.
- Give the error handler the real error text. With a bare `"ERR"`, a bad argument shape, an
  unreadable model, an empty result and the benign marshal-None all look identical.
- Use your own key prefix in a shared store and delete only your own records — other sessions
  write there too. `data-store-records_list` has no key filter and caps at 100.
- Many2one fields come back as `{id, value}`; select scalars when you only need to read.

## Guardrails

- **Never invent a payment.** If a statement credit has no counterpart in Odoo, search harder by
  amount and date before concluding it is missing — and if it truly is, say so rather than
  manufacturing a cash entry.
- **Cash-outs tagged with the supplier that the statement does not show are a finding, not a
  payment.** Do not push them into AP to make things tie, and do not leave them sitting in
  suspense under a name now known to be wrong. The money left the till under someone's
  instruction; surface it and ask whoever keeps the cash book.
- **Never post without a preview and a go-ahead.**
- **Right entity** — company 2, Presentail SAL. Cyprus (1) and UAE (3) are different jobs.
- **An empty query result is a claim about your query, not about the books.**
- Record the outcome as a project doc alongside the other `claude/<vendor>-soa-reconciliation.md`
  files: the bridge, what was posted, the pairings, and what is still open.