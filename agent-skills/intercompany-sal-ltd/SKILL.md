---
name: intercompany-sal-ltd
description: Books Presentail's intercompany charges in Odoo — Presentail SAL (Lebanon) raises the sales invoice at 11% VAT, Presentail LTD (Cyprus) books the matching vendor bill at 0% VAT, and the SAL invoice PDF is generated and attached to the bill. Driven by nothing more than a screenshot of amounts or a typed message like "400 and 650 on Jul 10, 1000 on Jul 22". Use whenever the user wants intercompany invoices/bills between the two entities — "create sales invoices in SAL and bills in LTD", "book these intercompany amounts", "SAL bills LTD", "put these as bills in Presentail LTD", "Flowers Delivery invoices" — including when they just paste amounts with no further instruction. Presentail-specific; Odoo is reached through the Make MCP.
---

# Intercompany: Presentail SAL → Presentail LTD

Presentail SAL (Lebanon) sells to Presentail LTD (Cyprus). Money flows the other way:
LTD transfers cash to SAL. Every charge therefore has **two** halves that must both exist:

1. a **sales invoice in SAL**, USD, **11% VAT**, booked to `7010 Sales of Goods`
2. a **vendor bill in LTD**, USD, **0% VAT (0% OEU)**, booked to `5000 Cost of goods`,
   with the SAL invoice number as its Bill Reference and the SAL invoice **PDF attached**

The order matters: **invoice first, then bill.** The bill's reference and amount come from the
posted invoice, and the PDF can only be attached once the invoice exists.

All IDs, the VAT arithmetic, and the Make/Odoo gotchas are in
`references/odoo_ids.md`. The four saved Make scenarios and their blueprints are in
`references/blueprints.md`. **Read both before touching anything** — every ID below was
verified live, and several of them are counter-intuitive (account *codes* are not account
*ids*; there are two journals called "Sales" belonging to different companies).

## Step 1 — Read the amounts

The trigger is usually a screenshot of a Wafeq/Odoo transaction list, or a plain typed
message. Extract one row per charge:

- `gross` — the amount as shown (this is the VAT-**inclusive** total the user means)
- `date` — the transaction date, as `YYYY-MM-DD`. Screenshots show `Jul 10`; infer the year
  from context (today's year unless the month is in the future).
- `description` — default **`Flowers Delivery`**. Only deviate if the user names something
  else; the Wafeq category label ("Directors salaries", "Payable") is *not* the description.

Amounts in a screenshot may be shown negative (`$ -400.00`) because they are outflows in the
source system. Book them as **positive** amounts.

## Step 2 — Compute the VAT split

The user's number is the **gross**. Odoo needs the **net** on the invoice line:

```
net = round(gross / 1.11, 2)
```

Check each row round-trips before posting: `net + round(net * 0.11, 2)` must equal `gross`
exactly. If it lands a cent out, nudge `net` by ±0.01 until it matches. Verified examples:

| gross | net | VAT 11% |
|---|---|---|
| 400.00 | 360.36 | 39.64 |
| 650.00 | 585.59 | 64.41 |
| 1,000.00 | 900.90 | 99.10 |

The LTD bill takes the **gross** as its line price (0% VAT, so line = total). The saved
scenario reads this off the posted invoice rather than recomputing it, so the two sides can
never drift.

## Step 3 — Dedup

Never double-book. Query SAL for existing invoices to partner 137 with the same
`invoice_date` and `amount_total`, and LTD for bills whose `ref` is one of those invoice
numbers. Anything already there is skipped, not re-posted.

## Step 4 — State the plan, then go

Show a compact table — date, gross, net, VAT, description, action (post / skip-duplicate).
For a clean unambiguous batch, **proceed immediately**; the user expects this to be hands-off.
Stop and ask first only if a row is a possible duplicate, has no determinable date, the row
count doesn't match what the user sent, or the description is genuinely unclear.

## Step 5 — Post both sides

Run the saved scenario **"Intercompany: SAL invoice → LTD bill"** with one item per row:

```json
{"items": [{"date": "2026-07-10", "net": 360.36, "description": "Flowers Delivery"}]}
```

It creates and posts the SAL invoice, reads back its number and total, then creates and posts
the LTD bill referencing it — and logs the resulting id pair to the `CY recon` data store
under key `ic-<sal id>`. Read those keys back to get the ids for the next steps.

## Step 6 — Generate the invoice PDFs

Odoo only renders an invoice PDF when the invoice goes through its **send** flow, so the PDF
does not exist until you ask for it. Run **"Intercompany A: generate SAL invoice PDFs"** with
the `sal`/`ltd` id pairs. It creates an `account.move.send.wizard` per invoice with
**download-only** selected and calls `action_send_and_print`, which renders and stores the
PDF **without emailing anyone**.

Side effect to expect and to mention when reporting: the invoices become flagged **"Sent"**
in the list view (`is_move_sent = true`). The accounting state stays `posted`; nothing leaves
the mail queue.

## Step 7 — Attach each PDF to its bill

Run **"Intercompany B: copy SAL invoice PDF onto LTD bill"** with the same pairs. It finds the
invoice's stored PDF, server-side `copy()`s it onto the bill with `res_field` cleared, and sets
it as the bill's `message_main_attachment_id` so it previews in the bill form.

The trap here cost real time once: Odoo's ORM **silently appends `res_field = False`** to any
`ir.attachment` search whose domain doesn't mention `res_field` or `id`. Invoice PDFs are
stored *with* `res_field` set, so a naive search returns zero and looks like "no PDF exists".
Always include `["res_field","!=",false]` (to find report PDFs) or `["id","!=",0]` (to find
everything).

## Step 8 — Verify, then report

Confirm, per pair: invoice `state=posted`, net/VAT/total exactly matching Step 2; bill
`state=posted`, `amount_tax=0`, total equal to the invoice total, `ref` equal to the invoice
number; **exactly one** attachment on the bill with the same byte size as the source PDF; and
**no stray drafts** left in SAL for partner 137 (a failed earlier attempt can leave one).

Report the table, note that the bills are `not_paid`, and remind that they settle when the
LTD→SAL transfer is reconciled — booking is not payment.

## Guardrails

- **Invoice before bill.** Reversing the order means the bill has no reference and no PDF.
- **Use account/journal/tax *ids*, never codes.** `7010` and `5000` are codes; the ids are
  `384` and `127`. Odoo answers a code with "Record does not exist: account.account(7010,)".
- **Watch company crossover.** Journal `48` is SAL's sales journal; journal `7` is a
  different company's and Odoo rejects it with "no company crossover is allowed".
- **Every Make blueprint needs a declared `interface`.** Without it `var.input.items` resolves
  empty, the feeder yields zero bundles, and the run reports **SUCCESS having done nothing** —
  the single most misleading failure mode here. If a run "succeeds" but Odoo is unchanged,
  check the interface first.
- **Reuse the saved scenarios; don't spawn throwaways.** Find them by name (ids can change).
- **Never invent a payment.** Reconciliation against the bank feed is out of scope for this
  skill; leave the bills unpaid and say so.
