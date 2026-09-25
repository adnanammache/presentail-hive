# Odoo IDs, Make objects, and the scenario blueprints

All values verified live against Presentail's Odoo, Presentail SAL (Lebanon, company **2**).
If Odoo is reconfigured, re-probe rather than trusting these blindly — Odoo is only reachable
through the **Make** MCP (the `odoo:makeApiCall` module), there is no direct Odoo REST API, and
list/array results generally don't surface back through ad-hoc probe tools in this environment
(only scalars do, via an error-message trick) — so any step that needs a prior step's id should
be chained *inside* one Make scenario, never resolved by reading data back out mid-conversation.

## Booking recipe (account.move, move_type = in_invoice)

**Shared** across every Toters fee bill:

| Field | Value | Notes |
|---|---|---|
| `company_id` | **2** | Presentail SAL — Lebanon |
| `partner_id` | **88** | Toters |
| `journal_id` | **14** | Purchases |
| `currency_id` | **96** | LBP |
| `ref` | the PDF's invoice number | dedup key — always `search_count` by `ref` first, skip if it exists |
| `invoice_date` / `date` | the PDF's statement date | `YYYY-MM-DD` |

**Fee-line accounts** — every bill always includes all 8 lines, even at 0, because that's how
the live scenario was built and it makes every month's bill structurally identical (easier to
audit, easier to diff month to month). Each line carries `tax_ids: [[6,0,[40]]]` (11% VAT).
Source field names below match `scripts/parse_toters_fee_bills.py`'s output — the mapping from
that field to the Balance Information row(s) it comes from is documented in the script itself.

| Field (from parser) | account_id | Label |
|---|---|---|
| `DeliveryFeesLBP` | **1868** | Delivery as a Service |
| `MarketplaceListingFeesLBP` | **1869** | Store Listing Fee |
| `MarketingHighlightsLBP` | **1870** | Highlighted Ad Placements |
| `OtherMarketingLBP` | **1871** | Other Advertising |
| `MarketingFreeDeliveryLBP` | **1915** | Marketing Free Delivery |
| `MarketingPunchCardRewardsLBP` | **1920** | Marketing Punch Card Rewards |
| `MarketingImmediateDiscountLBP` | **539** | Marketing Immediate Discount |
| `MarketingCreditNoteLBP` | **1909** | Marketing Credit Note (unmapped — suspense) |

**Marketing Immediate Discount is booked as a positive fee line despite its negative sign in
Balance Information.** It reduces the cash Toters would otherwise settle to Presentail —
i.e. it's a promotional discount Toters extends to customers but bills back to the merchant, a
genuine cost to Presentail, correctly booked as money owed to Toters. This has been the single
largest non-listing fee category in past runs (~933M LBP across 43 invoices in one quarter) —
worth a second look from whoever reviews the books if it swings unusually large or small.

Line item shape:
```json
{"name": "Toters - <Label> - <Store> - <YYYY-MM>", "account_id": <id>, "quantity": 1,
 "price_unit": <amount>, "tax_ids": [[6,0,[40]]]}
```

## Attaching the source PDF (mandatory, not optional)

Every bill gets its source PDF attached as an `ir.attachment` — confirmed as a standing
requirement, not a one-off nice-to-have. `res_model: "account.move"`, `res_id` = the bill's id,
`datas` = base64 file content, `mimetype: "application/pdf"`, `name` = the original filename.

**Google Drive access gotcha:** if PDFs live in a Drive folder, the Make connection doing the
attaching needs actual access to that folder. In this account the proven connection is
**"Maya's Google Drive"** (id **6668027**), scoped to maya@presentail.com — if a new folder was
created under a different account (e.g. adnan@presentail.com), that connection will 404 until
the folder is shared with maya@presentail.com. Confirm folder sharing *before* running a bulk
attach, not after it fails.

## The payment gap and its fix

Presentail SAL (company 2) pays Toters through a journal called **Toters Wallet Transactions**
(id **31**, type `bank`) — Odoo's ledger for Toters' actual bank-feed-style merchant wallet
(visible in the Toters merchant admin at merchant.totersapp.com as the "Main wallet log", an
order-by-order feed of every fee/VAT/discount/payout line that nets to a running balance per
store; the monthly PDF bill is just that feed's rolled-up summary for one store/month).

**Before ever registering a payment through a company-2 journal for the first time**, check
whether it's actually wired up — this gap has shown up more than once in this Odoo instance:

```
search_count  account.payment.method.line
  domain: [["journal_id","=",<journal>],["payment_account_id","=",false]]
```

A non-zero count means that journal's payment method(s) have no Outstanding
Payments/Receipts account configured. Symptom if you skip this check and register payment
anyway: the payment reaches `state=in_process` but `move_id` stays `false` forever — it looks
done but nothing actually posted or reconciled.

**One-time fix, per journal that needs it:**
1. Create fresh company-2-scoped accounts (don't try to just add company 2 to an *existing*
   shared Outstanding account's `company_ids` — Odoo in this version requires a code set
   per company on a shared account, so that write is rejected; creating new accounts is both
   simpler and the more standard setup anyway):
   ```
   create  account.account
     {"name": "Outstanding Payments - <thing> (SAL)", "code": "<unused code>",
      "account_type": "asset_current", "reconcile": true, "company_ids": [[6,0,[2]]]}
   ```
   One for Outstanding Payments (outbound side), one for Outstanding Receipts (inbound side).
   `account_type` and `reconcile` should mirror whatever the existing company-1 Outstanding
   accounts use — confirm with a quick `search_count` rather than assuming.
2. Wire them onto the journal's two payment method lines:
   ```
   write  account.payment.method.line  [[<outbound line id>], {"payment_account_id": <new payments account>}]
   write  account.payment.method.line  [[<inbound line id>],  {"payment_account_id": <new receipts account>}]
   ```
   Find the outbound/inbound line ids via `search_count` with `payment_type` in the domain
   (`account.payment.method.line` has a working `payment_type` field even though
   `account.journal.outstanding_payments_account_id` does **not** exist in this Odoo version —
   don't waste a call on that field).
3. **Verify with a real test, not just a search.** Create a small test `account.payment`
   through the fixed journal, `action_post` it, confirm `move_id` is now populated and the
   underlying move reaches `state=posted`, then `action_cancel` + `unlink` the test payment so
   nothing fake is left in the books.

**Toters Wallet Transactions (journal 31) specifics, already fixed:**
- Outbound payment method line **80** → Outstanding Payments account **1955** (code `999001`)
- Inbound payment method line **79** → Outstanding Receipts account **1956** (code `999002`)

## Paying a posted bill through journal 31

```
1. create       account.payment
     {"payment_type":"outbound","partner_type":"supplier","partner_id":88,
      "amount":<bill amount_total>,"journal_id":31,"payment_method_line_id":80,
      "company_id":2,"date":"<today>","memo":"Toters fee bill payment - <ref>"}
2. action_post  account.payment   [[<payment id>]]
3. search       account.move.line   ← the bill's own payable line
     domain: [["move_id.ref","=","<ref>"],["move_id.move_type","=","in_invoice"],
              ["move_id.company_id","=",2],["account_id.account_type","=","liability_payable"]]
4. search       account.move.line   ← the new payment's payable line
     domain: [["payment_id","=",<payment id>],["account_id.account_type","=","liability_payable"]]
5. reconcile    account.move.line   [[<bill's line id>, <payment's line id>]]
```

Step 3/4's dot-notation domains (`move_id.ref`, `account_id.account_type`) avoid ever needing
to resolve the bill's own numeric move id — search directly by `ref` instead.

**Gotchas:**
- `action_post` and `action_cancel` on `account.payment` both return `None`/`True` in Odoo,
  which the Make/Odoo RPC bridge can't marshal — you'll get a `cannot marshal None unless
  allow_none is enabled` `RuntimeError` **even when the call actually succeeded**. Wrap these
  calls with `onerror: Resume` in any Make scenario, and verify success by re-checking state
  afterward (`move_id != false`, `state`) rather than trusting the response.
- After a successful reconcile, `account.move`'s `payment_state` normally becomes
  **`in_payment`**, not `paid`. That's the correct, expected state for a payment reconciled
  through an outstanding account before any bank-statement-level confirmation — not a partial
  failure, don't chase it further.
- **Zero-amount bills can't be meaningfully paid.** A bill with `amount_total = 0` (a genuine
  zero-fee month) will let you create and post a `$0` payment, but it won't reconcile against
  anything and just clutters the journal. Skip payment entirely for any bill with
  `amount_total = 0`; if one slips through a bulk run, `action_cancel` + `unlink` the resulting
  payment.

## Make objects (Finance team, teamId 451472)

- Odoo connection: **6330934**.
- Google Drive connection (for attachments): **6668027** ("Maya's Google Drive").
- Live mailhook scenario (single-invoice, GPT extraction): **6774911** — handles one incoming
  Toters bill email at a time. Don't touch this for a bulk catch-up; build a temporary scenario
  instead (below) so the live path is never at risk.

## Bulk-catchup scenario blueprints

For many invoices at once (a historical backfill), build temporary on-demand scenarios rather
than looping the live mailhook scenario (which expects one email attachment, not a batch).
Recreate with `scenarios_create` (teamId 451472, scheduling `{"type":"on-demand"}`), then
`scenarios_activate`, then `scenarios_run` with `data:{"items":[...]}` or `{"refs":[...]}`.
Test on one item first with `responsive:true` before scaling to the full batch — bulk runs of
dozens of items can take minutes and the tool call itself may time out (502) even though the
scenario keeps running server-side; poll with `executions_get` / a `search_count` check rather
than assuming a timed-out tool call means the run failed.

### Poster (search dedup → create → attach → post)

```json
{
  "name": "Toters fee bill poster (bulk)",
  "metadata": {"version": 1},
  "flow": [
    {"id": 1, "module": "builtin:BasicFeeder", "version": 1,
     "mapper": {"array": "{{var.input.items}}"}},
    {"id": 2, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "search_count", "entity": "account.move", "headers": [],
       "parameters": "[[[\"ref\",\"=\",\"{{1.ref}}\"],[\"move_type\",\"=\",\"in_invoice\"],[\"company_id\",\"=\",2]]]"}},
    {"id": 3, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "filter": {"name": "not already in odoo",
       "conditions": [[{"a": "{{2.body}}", "o": "number:equal", "b": "0"}]]},
     "mapper": {"action": "create", "entity": "account.move", "headers": [],
       "parameters": "[{\"move_type\":\"in_invoice\",\"partner_id\":88,\"journal_id\":14,\"company_id\":2,\"currency_id\":96,\"invoice_date\":\"{{1.date}}\",\"date\":\"{{1.date}}\",\"ref\":\"{{1.ref}}\",\"invoice_line_ids\":{{1.lines}}}]"}},
    {"id": 4, "module": "google-drive:getAFile", "version": 4,
     "parameters": {"__IMTCONN__": 6668027},
     "mapper": {"select": "map", "file": "{{1.drive}}"}},
    {"id": 5, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "create", "entity": "ir.attachment", "headers": [],
       "parameters": "[{\"name\":\"{{1.name}}\",\"res_model\":\"account.move\",\"res_id\":{{3.body}},\"type\":\"binary\",\"datas\":\"{{base64(4.data)}}\",\"mimetype\":\"application/pdf\"}]"}},
    {"id": 6, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "action_post", "entity": "account.move", "headers": [],
       "parameters": "[[{{3.body}}]]"}}
  ],
  "interface": {"input": [{"name": "items", "type": "array", "spec": [
    {"name": "ref", "type": "text"}, {"name": "date", "type": "text"},
    {"name": "lines", "type": "text"}, {"name": "drive", "type": "text"},
    {"name": "name", "type": "text"}]}], "output": []}
}
```

`lines` is the pre-built `invoice_line_ids` JSON string (the 8 fee lines, see the booking
recipe above) — build it in Python before calling `scenarios_run` rather than trying to
construct it inside Make's mapper language.

If the bills are already posted and only the attachment is missing, drop modules 2/3/6 and
just do `search` on `account.move` by `ref` → `getAFile` → `create ir.attachment`, as its own
scenario — this is what was needed the one time PDF attachment was retrofitted after the fact.

### Payer (per-bill payment + reconcile — see "Paying a posted bill" above)

```json
{
  "name": "Toters fee bills - pay via wallet journal (bulk)",
  "metadata": {"version": 1},
  "flow": [
    {"id": 1, "module": "builtin:BasicFeeder", "version": 1,
     "mapper": {"array": "{{var.input.refs}}"}},
    {"id": 2, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "search_read", "entity": "account.move", "headers": [],
       "parameters": "[[[\"ref\",\"=\",\"{{1.ref}}\"],[\"move_type\",\"=\",\"in_invoice\"],[\"company_id\",\"=\",2]],[\"id\",\"amount_total\"]]"}},
    {"id": 3, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "filter": {"name": "amount > 0",
       "conditions": [[{"a": "{{2.body[1].amount_total}}", "o": "number:greater", "b": "0"}]]},
     "mapper": {"action": "create", "entity": "account.payment", "headers": [],
       "parameters": "[{\"payment_type\":\"outbound\",\"partner_type\":\"supplier\",\"partner_id\":88,\"amount\":{{2.body[1].amount_total}},\"journal_id\":31,\"payment_method_line_id\":80,\"company_id\":2,\"date\":\"{{formatDate(now;\\\"YYYY-MM-DD\\\")}}\",\"memo\":\"Toters fee bill payment - {{1.ref}}\"}]"}},
    {"id": 4, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "onerror": [{"id": 40, "module": "builtin:Resume", "version": 1, "mapper": {"output": "posted-or-marshal-error"}}],
     "mapper": {"action": "action_post", "entity": "account.payment", "headers": [],
       "parameters": "[[{{3.body}}]]"}},
    {"id": 5, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "search", "entity": "account.move.line", "headers": [],
       "parameters": "[[[\"move_id.ref\",\"=\",\"{{1.ref}}\"],[\"move_id.move_type\",\"=\",\"in_invoice\"],[\"move_id.company_id\",\"=\",2],[\"account_id.account_type\",\"=\",\"liability_payable\"]]]"}},
    {"id": 6, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "search", "entity": "account.move.line", "headers": [],
       "parameters": "[[[\"payment_id\",\"=\",{{3.body}}],[\"account_id.account_type\",\"=\",\"liability_payable\"]]]"}},
    {"id": 7, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "onerror": [{"id": 70, "module": "builtin:Resume", "version": 1, "mapper": {"output": "reconcile-error"}}],
     "mapper": {"action": "reconcile", "entity": "account.move.line", "headers": [],
       "parameters": "[[{{5.body[1]}},{{6.body[1]}}]]"}}
  ],
  "interface": {"input": [{"name": "refs", "type": "array", "spec": [{"name": "ref", "type": "text"}]}], "output": []}
}
```

The `filter` on module 3 (`amount > 0`) is the fix for the zero-amount-bill gotcha above — skip
those items rather than creating a payment that will never reconcile. Test on one real ref
first with `responsive:true`, confirm `payment_state` flips to `in_payment` and the bill's
payable line shows `reconciled=true`, before running the rest of the batch.

## Verify

- Bill count matches PDF count, dedup didn't skip anything it shouldn't have:
  `search_count account.move [move_type=in_invoice, partner_id=88, company_id=2, ref in <refs>]`
- All posted: same domain + `state=posted`.
- Attachment count matches: `search_count ir.attachment [res_model=account.move, res_id in <bill ids>]`
  (or `name like 'Invoice-Report-'` if the bills are all Toters).
- Paid bills: same domain + `payment_state=in_payment` — expect this to be less than 100% if
  any bills are genuinely zero-amount; confirm the shortfall is exactly the zero-amount bills,
  not a real failure, by cross-checking `amount_total = 0` on whichever refs didn't flip.
