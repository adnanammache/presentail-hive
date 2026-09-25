---
name: talabat-month-end
description: >-
  Automates Presentail's monthly Talabat bookkeeping in Wafeq. Handles BOTH sides
  from Talabat's statement archive: turns the TUAE fee tax-invoice PDFs into
  itemized expense bills (commission / subscription / marketing / premium marketing,
  with payment charges rolled into commission), and turns the per-store Balance
  Summary PDFs into one paid sales invoice per branch (Dubai vs Abu Dhabi place of
  supply, using the branch Earnings). Everything settles through the Talabat
  Transactions clearing account. Use whenever the user wants to process, add, or
  reconcile Talabat in Wafeq — "do the Talabat invoices", "add Talabat to Wafeq",
  "month-end Talabat", "Talabat commission/marketing bills", "Talabat sales /
  statements / SOA" — even if they don't spell out the steps. Presentail-specific;
  assumes the Wafeq REST API and a Wafeq API key are available.
---

# Talabat → Wafeq monthly bookkeeping

Talabat is the most involved platform. Its statement archive folder
(`additonalStatementsArchive_TB_AE_<from>_to_<to>`) contains four document types:

- **`TUAE-*.pdf`** — fee tax invoices → one **itemized expense bill** each.
- **`BalanceSummary_<store>.pdf`** — per-store balance summaries; page with
  "Branches balance summary" gives **Earnings per branch** → the **sales invoices**.
- **`SOA_*.pdf`** — Statements of Account (settlement summaries) → reference only,
  not posted.
- **`Detailed_*.xlsx`** — per-order detail → not needed for posting (sales come
  from the branch Earnings, per the user's chosen method).

Both posted sides settle through the **Talabat Transactions** clearing account, so
the clearing nets to Talabat's payout for the Wio bank reconciliation.

Downloading the archive is a manual step the user does first. All Wafeq IDs and the
fee-type mapping are in `references/wafeq_ids.md` — read it before posting.

## Prerequisites
- **Network access to `api.wafeq.com`** (test `GET /v1/accounts/?limit=1`; stop if 403).
- **Wafeq API key**: `WAFEQ_API_KEY` env or `wafeq_key.txt` in the working folder.
- The downloaded **archive folder** (stage its PDFs into the workspace).

## Part 1 — Expense bills (from the TUAE fee PDFs)

```
python scripts/parse_talabat.py <tuae-dir>  > talabat_parsed.json
python scripts/post_talabat.py --parsed talabat_parsed.json --pdf-dir <tuae-dir> [--dry-run]
```

One **fully itemized** bill per TUAE PDF — every fee line kept — routed by
description (case-insensitive):

- "subscription" → **Talabat Subscription Fee**
- "premium" / "placement" → **Talabat Premium Marketing Fee**
- "sponsored" / "boosted" → **Talabat Marketing Expense**
- everything else → **Talabat Commission** (this deliberately absorbs commission,
  the payment-processing charges — Credit Card / Talabat Credit / Cash Handling —
  plus loyalty/pro-delivery and any negative Discount line)

Lines can be **negative** (Discount adjustments) — kept as-is, they net the bill
down. Bill fields: `bill_number` = the TUAE number, `bill_date` = Issue Date,
`bill_due_date` = Due Date, tax-exclusive at 5% VAT on Purchases, `reference` = the
Restaurant Name, PDF attached. After create it authorizes and marks the bill **PAID**
via a BILL payment through the Talabat Transactions clearing account.
**Dedup:** skips any TUAE number already booked.

## Part 2 — Sales invoices (from the Balance Summary PDFs)

```
python scripts/post_talabat_sales.py --balance-dir <balance-summary-dir> --period-end YYYY-MM-DD [--dry-run]
```

Each `BalanceSummary_<store>.pdf` has a "Branches balance summary" table listing,
per branch, its **Earnings**. The poster creates one **PAID** simplified invoice per
branch: `place_of_supply` from the branch area (`Al Barsha 1` → **DUBAI**,
`Al Nahyan` → **ABU_DHABI**), amount = that branch's Earnings (treated as VAT 5%
**inclusive**, VAT on Sales), booked to Talabat Revenue, description = the store
brand, SINV numbering, paid through the Talabat Transactions clearing account.
`--period-end` is the month-end date to stamp on the invoices.
**Dedup:** skips a (brand, place-of-supply, amount, date) already invoiced.

## Guardrails
- Always `--dry-run` first and show the user before posting to live books.
- Amounts can differ a cent from stated totals (Wafeq recomputes 5% VAT per line) — normal.
- The fee mapping (esp. payment charges → Commission, sponsored → Marketing) was the
  user's decision; if a genuinely new fee type appears that isn't marketing/
  subscription/premium, it defaults to Commission — surface it to the user if it's
  material rather than silently burying it.
- Never hard-delete the user's downloaded files. Never post without a go-ahead.
