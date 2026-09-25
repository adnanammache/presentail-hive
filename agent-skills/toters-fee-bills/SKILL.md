---
name: toters-fee-bills
description: "Books Toters' monthly per-store fee bills as vendor bills in Presentail SAL's Odoo (Lebanon, LBP) and settles them through the Toters Wallet journal so nothing is left in Accounts Payable. The Activity table at the top of each \"Invoice-Report-(Store)-Month-Year.pdf\" is the invoice; the Balance Information block below it is the wallet statement and must never be booked as expense. IDs, the fee-account mapping and Make scenario blueprints live in references/odoo_ids.md — read it first. Use whenever the user wants to process, add, post, catch up, correct or pay Toters fee bills / Invoice-Reports in Odoo — \"do the Toters bills\", \"month-end Toters expenses\", \"why are the Toters bills unpaid\" — even for one invoice or a multi-month backfill. Presentail-specific; Odoo via the Make MCP."
---

# Toters fee bills → Presentail SAL vendor bills

Toters is a delivery/marketplace platform. Two flows exist between Toters and Presentail
SAL: the **sales side** (Toters collects revenue on Presentail's behalf — a separate
concern, not this skill) and the **expense side** — the commission Toters charges each
store, calculated as a percentage of that store's sales. This skill is the expense side.

All shared Odoo ids, the fee-account mapping, the payment-account gotcha and its fix, and
ready-to-reuse Make scenario blueprints live in **`references/odoo_ids.md`** — read it
before posting or paying anything. The job is three parts: **(1) parse and verify**,
**(2) post + attach**, **(3) settle**.

## The single most important rule

Each PDF has **two tables**, and only the first is the bill:

1. **Activity** (top) — `Activity | QTY | Rate | Amount`, then `Amount Due Before VAT`,
   `Value Added Tax:(11%)`, `Total amount with VAT due`. **This is the invoice.** Only
   four line types have ever appeared in it: *Delivery as a Service*, *Store Listing Fee*,
   *Highlighted Ad Placements*, *Other Advertising*.
2. **Balance Information** (below) — Opening Balance, Gross Merchant Revenue, Marketplace
   Listing Fee, Collections, Courier on Demand, Balance Settlement, Other, Marketing
   Immediate Discount, Marketing Item Discounts, Marketing Free Delivery, Marketing
   Highlights, Marketing Punch Card Rewards, Marketing Credit note, VAT, Closing Balance.
   **This is the merchant wallet statement, not a bill.**

The bill is built **only** from the Activity table. The Balance Information discount and
marketing rows are merchant-funded deductions from Presentail's own revenue — they belong
on the **sales** side, are never invoiced by Toters, and carry **no input VAT**.

> Gotten wrong once, at scale: an earlier version of this skill declared Balance
> Information authoritative, so 8 lines per bill were posted including the discounts.
> Across Jan–Aug 2026 that overstated 262 bills by **3,234,447,313 LBP net /
> 3,590,236,517 gross**, including **355,789,204 LBP of input VAT Toters never charged**.
> It also *under*stated Other Advertising, because Balance Information doesn't break
> advertising out. Do not reintroduce this.

## Activity amounts can be negative — keep the sign

Toters occasionally issues a **credit** on the Activity table. It prints with the empty
Rate column first, so the row reads `4 - -75,180,000.00 LBP` — two dashes: the blank Rate,
then the minus sign. A regex that grabs digits and drops the sign turns a credit into a
charge and doubles the error.

The corresponding Balance Information row is `Marketing Credit note`, printed **positive**
(money back into the wallet). Seeing it there is the tell that the Activity row is negative.

Post the credit as a negative `price_unit` on its own account line. Do not net it into
another line, and never force the total to agree by adjusting a different row.

## The two arithmetic checks

Run both on every invoice:

- **(a) sum of the Activity rows = `Amount Due Before VAT`.** Exact, no tolerance. This is
  the check that catches real errors — a misread row, a dropped minus sign, a value taken
  from the wrong table. If it fails, re-read the PDF.
- **(b) `Amount Due Before VAT` + `Value Added Tax` = `Total amount with VAT due`.** Exact.

Separately, Toters' stated VAT will not always equal exactly 11% of the net, because they
round VAT per order and sum. Measured across 262 invoices: 29 differ, in **both**
directions, by a few hundred LBP each and **1,985.64 LBP for a whole year** — about two US
cents. That is Toters' rounding, not an error: accept it, let Odoo compute VAT at 11%, and
do not override tax lines to chase it. A monthly gap materially above ~1,000 LBP is not
rounding — investigate.

## Step 0 — Scope

- **A few bills** — the user uploads the PDF(s), or they're in the Drive folder
  (`1dCaZL-wKvNFEpLzkpcRB3o_VYiD6ARDY`, "Toters Fee Bills"). Read each directly.
- **A catch-up** — the Google Drive connector's `search_files` returns each PDF's extracted
  text in `contentSnippet`, so one call yields many statements. Query **one month at a
  time** (`parentId = '<folder>' and title contains 'April-2026'`): multi-month queries
  paginate unreliably and repeat page 1. A ~34-file month exceeds the inline limit and gets
  saved to a file, which is ideal — parse it with a script and spend no context.

In the snippet layout the label and its description sit on one line before the values, so
the amount is the **last** `<number> LBP` on the row.

## Step 1 — Parse

Extract per invoice: store (from the filename between `Invoice-Report-(` and `)`),
`Invoice#` (the Odoo `ref` / dedup key), `Date:`, the four Activity amounts **with sign**,
and the three total lines. Amounts may print without decimals (`0 LBP`) — a regex requiring
`\.\d{2}` silently drops the genuine nil invoices, which are real and post as zero bills.

`scripts/parse_toters_fee_bills.py` parses the Balance Information block. It remains useful
for the sales/wallet side and for cross-checking, but its output must **not** build bill
lines.

## Step 2 — Preview and get a go-ahead

Live books — never fire silently. Show store, month, invoice #, net, total, dedup status,
and totals by month. Wait for approval.

## Step 3 — Post + attach

Four lines from the Activity table, per the account map in `odoo_ids.md` (Delivery as a
Service → 1868, Store Listing Fee → 1869, Highlighted Ad Placements → 1870, Other
Advertising → 1871), each with `tax_ids: [[6,0,[40]]]` (11% EXP). Post all four even at
zero — it keeps every month structurally identical and diffable. Dedup by `ref`, attach the
source PDF as an `ir.attachment` (**always**), then `action_post`.

Attach **before** paying. If the attachment step sits after a payment module whose filter
skips zero-amount bills, nil invoices silently lose their document.

For more than a handful, drive it from a Make scenario with a **compact feeder**
(`{id|ref, store, ym, a1..a4}`) that builds the line JSON inside the mapper — sending
pre-built `invoice_line_ids` per bill is ~15× the payload for no benefit. Scenario
**7243245** "Toters bill line corrector (Activity table)" does exactly this (write +
`action_post`, keyed by move id) and is reusable for corrections.

Verify: bill count = PDF count, no duplicate refs, all `state=posted`, attachment count
matches, and posted net per month = sum of `Amount Due Before VAT`.

## Step 4 — Settle

Toters commission is netted out of the same period's Toters revenue — **nothing leaves the
bank**. Settlement runs through the **Toters Wallet Transactions journal (31)**, which is
also where the sales receipts land; both sides meet in that one account and the remainder
is the payout.

One `account.payment` per bill in journal 31 (`payment_method_line_id` 80), posted and
reconciled 1:1 against that bill's own payable line. Scenario **7243442** "Toters fee bills
- pay via wallet journal (partner 49)" does this from a `{ref, d}` feeder. Reconcile the
bill to its own payment — never sweep all open payables together.

**Never book a Toters fee payment in a BLOM journal.** It has happened twice — 66 payments
in Jul/Aug 2026 plus 4 stragglers in June — landing in BLOM's Outstanding Payments account
where they can never match a statement line, quietly corrupting the bank reconciliation. A
Toters payment in journal 23 or 24 is wrong by definition.

All Toters payables belong on account **1980** (Integrated Marketplace SAL – Other Payables
Operational). Account **2037** ("Toters – Other Payables Operational") is a dead legacy
account from the partner 88→49 merge — now empty; don't let new entries land there. If a
bill's payable line is on the wrong account the payment cannot reconcile: draft the bill,
`write` `account_id` on the payable line, repost, then pay. Drafting and reposting alone
does **not** regenerate that account.

Before paying through a company-2 journal for the **first time**, check that journal's
Outstanding Payments/Receipts accounts are configured (`odoo_ids.md` has the check and the
one-time fix — a real recurring gap here). Skip bills with `amount_total = 0`. Verify
after: `payment_state = in_payment` on every non-zero bill and `amount_residual = 0`.

## Guardrails

- **The Activity table is the bill. Balance Information is the wallet statement.** Never
  book a Balance Information deduction as expense, never claim input VAT on one.
- **Keep the sign on Activity amounts** — credits are real and print as negatives.
- **Check (a) exactly; tolerate VAT rounding.** Line sum must tie; VAT may drift a few
  hundred LBP a month and that is fine.
- **Discounts belong to the sales side** — if a correction removes them from bills, say
  plainly that the sales side still has to absorb them.
- **A shrinking bill leaves an over-applied payment** — surface the number, don't bury it
  in a new entry.
- **The source PDF gets attached, always.** Nil invoices too.
- **Nil invoices are real.** `0 LBP` with no decimals is a valid statement: parse it, post
  a zero bill, don't pay it.
- **`action_post` / `action_cancel` / `reconcile` / `remove_move_reconcile` "fail" with
  `cannot marshal None unless allow_none is enabled` even when they succeed** — verify
  state afterward, never retry blindly on that error.
- **A 502 from the tool gateway does not mean the Make run failed** — it usually executed
  server-side; verify in Odoo before re-running, or use `responsive: false` and pace calls
  ~55s apart (a scenario cannot run twice concurrently).
- **`params` for the Odoo exec probe (scenario 7122626) is a JSON *string* of the
  positional args array** — e.g. `"[[[\"id\",\"in\",[1,2]]],[\"id\",\"state\"]]"`. Passing
  a real array yields `Domain() invalid argument type for domain: 'domain'`.
- **Never post, pay or delete without a preview and go-ahead**, and never hard-delete the
  user's source PDFs.
- **Check for other sessions on the same ledger** before bulk-mutating — the sales/wallet
  and BLOM sides are often being worked in parallel.

## The live monthly scenario

Scenario **6774911** "Toters → Odoo fee bill poster" (mailhook on Maya's inbox + GPT
extraction) was rewritten in Sep 2026 to read the Activity table, post the four lines at
tax 40, attach before paying, pay through journal 31 and reconcile 1:1. If it is ever seen
posting 8 lines, using tax 44, or creating payments in journal 24, it has been reverted —
fix it before running a month through it.

## Known open item

Outstanding-payments account **1955** collects every wallet payment and never clears,
because clearing requires matching against a bank statement and the Toters wallet feed is
not imported as one. It grows at the monthly fee run-rate. The fix is importing the Toters
merchant-admin "Main wallet log" into journal 31 the way `blom-bank-feed` imports BLOM
statements — a project, not a tweak. Flag it; don't build it unprompted.