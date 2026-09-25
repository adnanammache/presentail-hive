# Odoo IDs, VAT maths, and the traps

Everything below was verified live against `presentail.odoo.com` on 2026-07-28 by reading it
back off posted records (SAL invoice 23372 / LTD bill 23375). If Odoo is reconfigured,
re-probe with the saved **"Intercompany: probe move config"** scenario rather than trusting
these blindly — it reads journal / currency / company / partner / account straight off an
existing move.

## The two halves

| | SAL sales invoice | LTD vendor bill |
|---|---|---|
| `move_type` | `out_invoice` | `in_invoice` |
| `company_id` | **2** — Presentail SAL (Lebanon) | **1** — Presentail LTD (Cyprus) |
| `partner_id` | **137** — PRESENTAIL LTD (as customer) | **9** — Presentail SAL (as vendor), VAT 3616289-601 |
| `journal_id` | **48** — Customer Sales, prefix `INV1` | **8** — Purchases (names come out as `IN########`) |
| `currency_id` | **1** — USD | **1** — USD |
| line `account_id` | **384** — code `7010 Sales of Goods` | **127** — code `5000 Cost of goods` |
| line `tax_ids` | **34** — `11% G` (11%, goods, Lebanon fiscal position) → `[[6,0,[34]]]` | **28** — `0% OEU` (0%, partner outside EU) → `[[6,0,[28]]]` |
| line `price_unit` | the **net** (VAT-exclusive) | the **gross** (= invoice `amount_total`) |
| `ref` | leave unset | the SAL invoice `name`, e.g. `INV1/2026/00098` |
| line `name` | `Flowers Delivery` (default) | same as the invoice line |

Don't set payment terms explicitly — Odoo applies the partner default (currently 15 days on
the SAL side), which is what the July 2026 batch used.

**Other companies, for orientation only — do not use:** 3 = Presentail Flowers Trading L.L.C
(UAE), 6 = PRESENTAIL S.A.L.

**Tax picker, for reference.** Presentail LTD's purchase side offers `19%`, `19% S`, `9%`,
`9% S`, `5%`, `5% S`, `3%`, `3% S`, `0%`, `19% RC`, `0% E` (exempt), **`0% OEU`** (outside
EU — the right one for Lebanon), `0% EU`, `0% EU S`. `0% OEU` carries fiscal position
"Partner outside of EU" and replaces 19/9/5/3.

## VAT arithmetic

The user gives the **gross**. Odoo wants the **net** on the line:

```
net = round(gross / 1.11, 2)
```

Then assert the round-trip before posting: `net + round(net * 0.11, 2) == gross`. If it lands
a cent out, adjust `net` by ±0.01. Verified: 400 → 360.36 + 39.64; 650 → 585.59 + 64.41;
1000 → 900.90 + 99.10.

The LTD side is 0%, so its line price **is** the total. Read it off the posted invoice
(`amount_total`) instead of recomputing — that way the halves cannot drift.

## Reconciliation IDs (out of scope here, noted for later)

The LTD→SAL transfer settles the bills. Cyprus-side accounts: Accounts Payable **93**
(`2100`), Bank Suspense **221** (`1200`, non-reconcilable), realized FX **202** (`7910`),
MISC journal **9**. See the `odoo-supplier-invoices` skill for the full reclass-and-reconcile
recipe.

## Make objects

- Finance team **451472**; Odoo connection **6330934** ("Odoo finance new").
- Data store **152658** (`CY recon`), two text fields `t1` / `t2` — the only way to read
  values out of a run. Use unique keys; it is shared with live CY reconciliation work.

## Traps, in the order they will bite

**A blueprint with no `interface` silently does nothing.** `var.input.items` resolves empty,
the feeder yields zero bundles, every downstream module is skipped, and the run reports
**SUCCESS**. Symptom: "the scenario succeeded but Odoo is unchanged." Always declare:

```json
"interface": {"input": [{"name": "items", "type": "array", "spec": [
  {"name": "date", "type": "text"}, {"name": "net", "type": "number"},
  {"name": "description", "type": "text"}]}], "output": []}
```

**`scenarios_run` returns no module output.** Append a `datastore:AddRecord` that flattens
what you need, then read it with `data-store-records_list`. That tool has **no offset
parameter** and the store holds ~80 records, so the response overflows — save it and grep for
your key.

**Many-to-one fields don't survive the readback.** Joined into a string they render
`{object}`; `field[1]` / `field[2]` indexing yields empty. Use **`field.id`** (and `field.name`
if needed). `tax_ids` is a plain id list and joins fine.

**`search_read` argument shape.** Domain goes in `parameters` as `[[...domain...]]`; fields
and limit go in a separate `search_params` JSON: `{"fields": [...], "limit": 10}`. Passing
fields as the second positional argument inside `parameters` produces the baffling
`argument of LIMIT must be type bigint, not type text[]`.

**Account codes are not ids.** `account_id: 7010` fails with `Record does not exist or has
been deleted. (Record: account.account(7010,))`. The id is 384.

**Company crossover.** Using another company's journal fails with *"'Draft Invoice' belongs to
company 'Presentail SAL' while 'Journal' belongs to another company. To avoid a mess, no
company crossover is allowed!"* Journal 48 = SAL sales; journal 7 is **not** SAL's.

**Private methods are blocked over RPC.** Anything starting with `_` — notably
`_render_qweb_pdf` — cannot be called. Generate invoice PDFs through the public
`account.move.send.wizard` flow instead (see below).

**`ir.attachment` searches hide report PDFs.** Odoo's ORM appends `('res_field','=',False)` to
any attachment domain that mentions neither `res_field` nor `id`. Invoice PDFs are stored with
`res_field = 'invoice_pdf_report_file'`, so a naive search returns **0** and looks like the PDF
was never created — while `account.move.invoice_pdf_report_id` is plainly set. Include
`["res_field","!=",false]` to find report PDFs, or `["id","!=",0]` to see everything.

**`action_post` / `reconcile` / some `write`s return `None`.** Make reports `cannot marshal
None` **but the change committed.** Verify state; do not retry.

## Generating the invoice PDF without sending mail

```
create account.move.send.wizard
  [{"move_id": <sal invoice id>, "sending_method_checkboxes": {"manual": {"checked": true}}}]
action_send_and_print account.move.send.wizard  [[<wizard id>]]
```

`manual` = download-only, so Odoo renders and stores the PDF and **no email is sent**. The
invoice becomes `is_move_sent = true` (shows as "Sent" in the list view); `state` stays
`posted`. The stored attachment is then reachable with the `res_field` domain above, and
copied onto the bill with:

```
copy ir.attachment
  [[<source att id>], {"res_model": "account.move", "res_id": <bill id>,
                       "res_field": false, "name": "<same name>"}]
write account.move  [[<bill id>], {"message_main_attachment_id": <new att id>}]
```

Clearing `res_field` is what makes it show in the bill's Attachments box; setting
`message_main_attachment_id` is what makes it render in the preview pane.

## Worked reference — July 2026 batch

Three charges (400 / 650 / 1000 USD, dated Jul 10 / Jul 10 / Jul 22), description
"Flowers Delivery":

| SAL invoice | id | net | VAT | total | LTD bill | id | attachment |
|---|---|---|---|---|---|---|---|
| INV1/2026/00098 | 23372 | 360.36 | 39.64 | 400.00 | IN55671974 | 23375 | 5468, 49,186 B |
| INV1/2026/00099 | 23373 | 585.59 | 64.41 | 650.00 | IN55671975 | 23376 | 5470, 49,108 B |
| INV1/2026/00100 | 23374 | 900.90 | 99.10 | 1,000.00 | IN55671976 | 23377 | 5471, 48,773 B |

All six moves posted, bills at 0% VAT and `not_paid`, one PDF each set as main attachment,
no stray drafts.
