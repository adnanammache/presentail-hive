# Odoo IDs, Make objects, and the poster blueprint

All values verified live against `presentail-gifts.odoo.com`. If Odoo is
reconfigured, re-probe with a temporary `odoo:makeApiCall search_read` scenario
(companies, `res.partner` ilike "meta", `account.account` ilike "advert", purchase
`account.tax`, `res.currency` EUR, purchase `account.journal`) rather than trusting
these blindly.

## Booking recipe (account.move, move_type = in_invoice)

**Shared** across all suppliers — the same for every vendor:

| Field | Value | Notes |
|---|---|---|
| `company_id` | **1** | Presentail LTD — Cyprus, VAT CY10422991V |
| `journal_id` | **8** | Purchases (code BILL) |
| `currency_id` | **125** | EUR |
| `invoice_date` / `date` | PDF Invoice/Payment Date | e.g. `2026-02-01` |
| line `price_unit` | the `Paid €` amount | = net = total under reverse charge |

**From the supplier profile** (`references/suppliers.md`) — differ per vendor:

| Field | Source |
|---|---|
| `partner_id` | profile's vendor (e.g. Meta = 87) |
| expense `account_id` | profile's expense account (e.g. Meta = 140 `6201 Advertising`) |
| `tax_ids` | profile's tax, format `[[6,0,[<id>]]]` (e.g. `19% RC` = 24) |
| `ref` | profile's invoice-number format |
| line `name` | profile's line name (e.g. `Meta ads - <ref>`) |

Other companies (do NOT use unless a profile says so): 2 = Presentail SAL (Lebanon),
3 = Presentail Flowers Trading L.L.C (UAE), 6 = PRESENTAIL S.A.L.

To onboard a new supplier, probe with a temporary `search_read`: `res.partner` ilike the
name, `account.account` ilike the expense category, purchase `account.tax`, purchase
`account.journal` — then save a profile.

## Reconciliation IDs and recipe (Step 6)

| Thing | Value | Notes |
|---|---|---|
| Accounts Payable | account **93** (code `2100`) | the bill's payable line; reconcilable |
| Bank Suspense | account **221** (code `1200`) | where most Revolut charges land; **non-reconcilable** (`recon=false`) |
| Realized FX / exchange | account **202** (code `7910` Exchange rate realized gains/losses) | currency differences AND Revolut card fees |
| MISC journal | journal **9** (`Miscellaneous Operations`, type `general`) | for the reclass / FX / fee journal entries |
| Data store | **152658** (`CY recon`) | for reading back query output |

Below, **`<vendor>`** = the supplier's `partner_id` from its profile (Meta = 87), and
**`<label>`** = the profile's bank-feed label (Meta = `Facebk`).

**Match a bill to its charge by amount + `date`.** Revolut labels charges
`<label> *<reference>` where `<reference>` is the receipt's reference string (NOT the
invoice number stored on the bill), so text-matching the bill isn't possible — pair
`account.move.line` rows by amount and by `date` (bill `invoice_date` ≈ charge date, often
+1 day). To pull both sides: bills = `account.move.line [account_id=93,
partner_id=<vendor>, reconciled=false]` fields `[id,balance,ref,date]`; suspense charges =
`account.move.line [name like <label>, account_id=221]` fields `[id,name,balance,date]`
(this pulls ALL history — filter to the period you're settling; old low-id lines are prior
months).

### ⛔ Do NOT set-reconcile a whole batch

An earlier version of this file recommended one `reconcile([[all_lines…]])` call over a set
that nets to zero. **It produces wrong books.** Every bill flips to `paid` and vendor AP hits
zero — so naive verification passes — but Odoo pairs the set **arbitrarily**, so the January
charge ends up linked to the July bill. Bank Matching then shows the wrong invoice number on
every row. Totals right, every individual pairing wrong.

**Reconcile one charge against one bill, always.** See the per-charge recipe below.

### The right way: reclass each charge *on its own statement line*, then pair 1:1

A separate reclass JE (Dr 93 / Cr 221) balances the *ledger* but never touches the
**bank statement line**, which stays unmatched in Bank Matching with "Set Partner / Set
Account" showing. Move the counterpart **inside the statement line's own move** instead:

```
1. button_draft   account.move   [[<statement_line_move_ids…>]]     ← batchable
2. write          account.move.line [[<suspense_line_ids…>], {"account_id":93,"partner_id":<vendor>}]
3. action_post    account.move   [[<statement_line_move_ids…>]]     ← batchable
4. reconcile      account.move.line [[<charge_line>,<bill_AP_line>]]  ← ONE PAIR PER CALL
```

Steps 1–3 batch across every charge at once. Step 4 must be per pair. Odoo refuses
`account.bank.statement.line.write({'line_ids': …})` on a posted move ("You can't delete a
posted journal item") — the draft/write/post route is what works.

**Batch the 1:1 reconciles with a `builtin:Resume` error handler.** `reconcile()` returns
None → the Make module always errors with `cannot marshal None` even though it committed.
`builtin:Ignore` stops the chain after the first item; **`builtin:Resume` does not**, so one
scenario can process a whole list:

```json
{"id":2,"module":"odoo:makeApiCall","version":1,
 "parameters":{"__IMTCONN__":6330934},
 "mapper":{"action":"reconcile","entity":"account.move.line",
           "parameters":"[[{{1.a}},{{1.b}}]]"},
 "onerror":[{"id":99,"module":"builtin:Resume","version":1,"mapper":{"output":"ok"}}]}
```

Saved as scenario **"Odoo pair reconciler (Resume)"** — feed it `{"pairs":[{"a":<charge>,"b":<bill>}…]}`.

### Currency rule — book in the currency the charge settled in

Read the charge line's `currency_id` and branch:

| Charge settled in | Book the bill as | What happens |
|---|---|---|
| **USD** (or the invoice currency) | bill `currency_id` = USD at the **invoice face value** | Odoo matches on `amount_currency`, then posts the EUR difference itself as an `EXCH/…` entry to 7910. No manual JE. |
| **EUR / GBP / CAD** (anything else) | bill `currency_id` = **EUR at the charge's exact EUR balance** | reconciles to the cent, no FX at all |

This mirrors how the money actually moved and avoids a manual plug in almost every case.
Odoo's automatic exchange entry needs `res.company.expense/income_currency_exchange_account_id`
set — on company 1 both are **202** (`7910`), already correct.

**When both sides are in *different* foreign currencies** (e.g. USD bill vs CAD charge)
Odoo falls back to company currency and leaves a residual. Only then post a manual JE:
`Dr 202 <residual> / Cr 93 <residual> (partner <vendor>)`, then reconcile the residual
against that new credit line.

### Missing exchange rates (2025)

`res.currency.rate` had **no 2025 rows for company 1**, so Odoo converted 2025 foreign
amounts at **1.0** — which is why 2025 bank lines carry the USD figure as EUR. Before
booking any 2025 bill in a foreign currency, load the real rates:

```
create res.currency.rate
  [[{"currency_id":1,"name":"2025-05-13","rate":1.1112,"company_id":1}, …]]
```

`rate` = **units of foreign currency per 1 EUR** (ECB convention: the EUR/USD quote itself).
Source them live from `https://api.frankfurter.dev/v1/<YYYY-MM-DD>?base=EUR&symbols=USD`
(ECB daily reference rates) — **never estimate a rate from memory**. Weekends return the
previous business day in the response's `date` field; store the row under the invoice date.
Loading rates changes how *all* 2025 foreign-currency activity is valued in reports (posted
balances don't move) — tell the user.

Currency ids: EUR **125**, USD **1**, CAD **3**, GBP **143**, CHF **4**.

**Card/FX fee lines** (`Fee for <label> *…`, in AP partner `<vendor>`) are card/FX fees,
not invoices. Reclass to 7910 and reconcile out: JE `Dr 202 total / Cr 93 total (partner
<vendor>)`, then `reconcile([[fee_line_ids…, new_AP_credit_line_id]])`.

### Verify — four checks, not one

Vendor AP = 0 is **not** sufficient; a wrongly-paired batch passes it. Run all four:

1. `account.move.line [account_id=93, partner_id=<vendor>, reconciled=false]` → empty
2. `account.move [move_type=in_invoice, partner_id=<vendor>, payment_state in (not_paid,partial)]` → empty
3. `account.move.line [account_id=221, name ilike <label>]` → empty (or nets to zero)
4. **`account.partial.reconcile [credit_move_id in <bill_AP_lines>]`** → one row per bill,
   and each row's `debit_move_id` is **that bill's own charge**. This is the check that
   catches mis-pairing. Expect a couple of extra rows for Odoo's auto `EXCH` entries.

**The authoritative check is `account.bank.statement.line.is_reconciled`**, not the 221
balance. Suspense can net to zero while every statement line is still unmatched — that is
exactly the failure mode below. Query
`account.bank.statement.line [payment_ref ilike <label>, is_reconciled = false]`; anything
it returns is what the user sees as "pending" in Bank Matching.

### ⚠️ Suspense counterpart lines do NOT carry the bank label

Only the **bank-side** line of a statement move gets the `<label> *<ref>` name. Its
counterpart in Suspense has a different (often blank) `name`. So
`account.move.line [account_id=221, name ilike <label>]` **silently returns nothing** even
when charges are sitting there. This cost a full day: the search came back empty, and the
wrong conclusion drawn was "the data is inconsistent" rather than "the query is wrong".

**Find suspense counterparts by move, never by name:**
```
1. account.bank.statement.line [payment_ref ilike <label>, is_reconciled = false]  → move_ids
2. account.move.line [move_id in <those>, balance > 0]                             → the counterparts
```

### Repairing a supplier that was previously set-reconciled

When an older batch used one big `reconcile()` (see the ⛔ section), fix it like this:

```
1. remove_move_reconcile  on the affected bill AP lines
2. button_draft + unlink  the old reclass JE
3. draft → write(account_id 93, partner_id <vendor>) → post   on each statement move
4. reconcile 1:1, one pair per call
5. one FX JE for the residuals, one line per charge, then reconcile those 1:1 too
```

**Read the old JE's line names before deleting it.** A well-built reclass JE names each line
with both identifiers — `Meta FBADS-632-106169002 (Facebk *ku2mlxmps2)` — which is an exact,
verifiable bill↔charge mapping and removes all guesswork. **When you create any reclass or FX
line, name it the same way** so the next person can repair your work.

**Many-to-one is legitimate for prepaid vendors.** One €200 top-up charge can settle a €46
bill and a €154 bill. That is a real three-line reconciliation, not a mis-pairing — don't
force it to 1:1.

**Worked reference (Meta, Jul 2026):** 60 bills. Originally set-reconciled behind JE 22685,
which balanced the ledger but left all 31 statement lines unmatched in Bank Matching. Repaired
on 29 Jul with the recipe above: JE 22685 deleted, 31 charges repointed inside their own
statement lines and reconciled 1:1, €1.88 FX re-posted per-charge as MISC/2026/07/0029, and
the 5 Feb €200 top-up reconciled against its two bills (€46 + €154). Verified: 31/31 pairings
correct, 0 unmatched statement lines, vendor AP = 0.
*(Meta's 2025 charges — 43 lines, €12,640.71 — remain unbooked for want of invoices.)*

**Worked reference (Cloudflare + ManyChat, Jul 2026):** 75 bills across two vendors, every
one reconciled 1:1 via the statement-line reclass route; ECB 2025 rates loaded; Odoo
auto-posted the USD FX to 7910; final AP = 0 and suspense = 0 for both.

**Worked reference (Loom, Aug 2026):** the *two different foreign currencies* case, in
miniature. USD $24.00 invoice vs a **GBP** card charge (£17.60 / €20.53) — they do not
self-match. Bill booked in USD (EUR value €20.55), charge repointed inside its own statement
move and reconciled 1:1, and the €0.02 residual posted as `MISC/2026/08/0005`
(`Dr 93 / Cr 202`, partner 272) and reconciled out. Give the AP side of that JE
`currency_id` **1** and `amount_currency` = the residual — clearing `amount_residual` alone
leaves `amount_residual_currency` dangling.

> Make's `filter()` is not an expression function (only a module) — don't use it in a
> `map()`; dump raw parallel arrays (ids, amounts, dates) and pick lines in your own code.

> Many2one fields come back from Make as a collection with keys **`id`** and **`value`** —
> `join(map(map(N.body; "account_id"); "id"); "|")`. `flatten()` and index access both fail.
> There is no `toJSON()` in Make.

> `data-store-records_list` caps at **100 records** and the shared `CY recon` store (152658)
> is already near it, so a fresh probe result can be unreadable. Create a private scratch
> store instead (structure: two text fields `t1`/`t2`) and delete your records when done.

## Make objects (Finance team, teamId 451472)

- Odoo connection: **6330934** ("Odoo finance new").
- Google Drive connection (for attachments inside Make): **6668027** ("Maya's Google
  Drive"). Needs the "Meta Invoices" folder shared with maya@presentail.com.
- Data store for read-back of query results: **152658** ("CY recon"), structure is two
  text fields `t1` / `t2`. Use unique keys and delete your scratch records when done —
  this store is shared with the live CY reconciliation work.
- Poster scenario: **"Meta ads → Odoo bill poster"** (was id 6710226 when built;
  find it by name — IDs can change if rebuilt).

### Reading query output via the data store

Make's responsive `scenarios_run` does not return module output, and
`executions_get-detail` only returns status. To read values, append a
`datastore:AddRecord` that flattens them, then `data-store-records_list`. Odoo
many-to-one fields render as `{object}` when joined, so select scalar fields (or the
id) instead. Example flatten mapper for a `search_read` in module 1:

```
t1: "n[{{length(1.body)}}] refs[{{join(map(1.body; \"ref\"); \" || \")}}]"
t2: "tot[{{join(map(1.body; \"amount_total\"); \",\")}}] pay[{{join(map(1.body; \"payment_state\"); \",\")}}]"
```

## The poster blueprint

Recreate with `scenarios_create` (teamId 451472, scheduling `{"type":"on-demand"}`),
then `scenarios_activate`, then `scenarios_run` with `data:{"items":[...]}`. `action_post`
is not in the module's action picklist but passes through and posts correctly.

```json
{
  "name": "Meta ads → Odoo bill poster",
  "metadata": {"version": 1},
  "flow": [
    {"id": 1, "module": "builtin:BasicFeeder", "version": 1,
     "mapper": {"array": "{{var.input.items}}"}},
    {"id": 2, "module": "google-drive:getAFile", "version": 4,
     "parameters": {"__IMTCONN__": 6668027},
     "mapper": {"select": "map", "file": "{{1.drive}}"}},
    {"id": 3, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "search_count", "entity": "account.move", "headers": [],
       "parameters": "[[[\"move_type\",\"=\",\"in_invoice\"],[\"partner_id\",\"=\",87],[\"ref\",\"like\",\"{{1.ref}}\"]]]"}},
    {"id": 4, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "filter": {"name": "not already in odoo",
       "conditions": [[{"a": "{{3.body}}", "o": "number:equal", "b": "0"}]]},
     "mapper": {"action": "create", "entity": "account.move", "headers": [],
       "parameters": "[{\"move_type\":\"in_invoice\",\"partner_id\":87,\"journal_id\":8,\"company_id\":1,\"currency_id\":125,\"invoice_date\":\"{{1.date}}\",\"date\":\"{{1.date}}\",\"ref\":\"{{1.ref}}\",\"invoice_line_ids\":[[0,0,{\"name\":\"Meta ads - {{1.ref}}\",\"account_id\":140,\"quantity\":1,\"price_unit\":{{1.amt}},\"tax_ids\":[[6,0,[24]]]}]]}]"}},
    {"id": 5, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "create", "entity": "ir.attachment", "headers": [],
       "parameters": "[{\"name\":\"Meta {{1.ref}}.pdf\",\"res_model\":\"account.move\",\"res_id\":{{4.body}},\"type\":\"binary\",\"datas\":\"{{base64(2.data)}}\",\"mimetype\":\"application/pdf\"}]"}},
    {"id": 6, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "action_post", "entity": "account.move", "headers": [],
       "parameters": "[[{{4.body}}]]"}}
  ],
  "interface": {"input": [{"name": "items", "type": "array", "spec": [
    {"name": "ref", "type": "text"}, {"name": "date", "type": "text"},
    {"name": "amt", "type": "number"}, {"name": "drive", "type": "text"}]}], "output": []}
}
```

Input shape for `scenarios_run`:

```json
{"items": [
  {"ref": "FBADS-632-105362701", "date": "2026-02-01", "amt": 801.75, "drive": "<drive file id>"}
]}
```

### One-off attach to an existing bill

If a bill was created without its PDF, attach it directly (getAFile → create
ir.attachment with `res_id` = the move id), since the poster's dedup would otherwise
skip it:

```
create ir.attachment
  [{"name":"Meta <ref>.pdf","res_model":"account.move","res_id":<moveid>,
    "type":"binary","datas":"{{base64(<getAFile>.data)}}","mimetype":"application/pdf"}]
```
