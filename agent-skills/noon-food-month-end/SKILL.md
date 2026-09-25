---
name: noon-food-month-end
description: >-
  Automates Presentail's monthly Noon Food bookkeeping in Wafeq. Handles BOTH
  sides: turns Noon Food fee tax-invoice PDFs into itemized commission/marketing
  expense bills, and turns the per-outlet order statement CSVs into one paid sales
  invoice per order (place of supply from the outlet name). Everything settles
  through the Noon Food Transactions clearing account. Use whenever the user wants
  to process, add, or reconcile Noon Food in Wafeq — "do the Noon Food invoices",
  "add Noon to Wafeq", "month-end Noon Food", "Noon commission/marketing bills",
  "Noon Food sales invoices / statements" — even if they don't spell out the steps.
  Presentail-specific; assumes the Wafeq REST API and a Wafeq API key are available.
---

# Noon Food → Wafeq monthly bookkeeping

Noon Food has two independent document streams each month, and this skill handles
both:

1. **Fee tax-invoice PDFs** → one **expense bill** each, itemized so that
   **marketing** is separated from **commission**. (This is expense-only — the fee
   PDFs do NOT carry sales figures, so no cash/sales invoice comes from them.)
2. **Per-outlet order statement CSVs** → one **sales invoice per order**, with the
   Dubai/Abu Dhabi place of supply read from the outlet name.

Both post through the **Noon Food Transactions** clearing account, so the clearing
balance nets to Noon's actual payout for the Wio bank reconciliation.

Downloading the documents from Noon's portal is a manual step the user does first;
don't try to automate it. All concrete Wafeq IDs are in `references/wafeq_ids.md` —
read that before posting.

## Prerequisites
- **Network access to `api.wafeq.com`** enabled for the sandbox (test with
  `GET /v1/accounts/?limit=1`; stop with a clear message if it 403s).
- **Wafeq API key**: `WAFEQ_API_KEY` env var, or `wafeq_key.txt` in the working
  folder, else ask. Never echo it.
- The **Noon Food Marketing Expense** account must exist (code ~6027). If it
  doesn't, ask the user to create it in Wafeq (or map marketing to an agreed
  account) — don't silently fall back to Commission.
- The downloaded **fee PDFs** and **statement CSVs** (stage them into the workspace).

## Part 1 — Expense bills (from the fee PDFs)

```
python scripts/parse_noon.py <fee-pdf-dir>  > noon_parsed.json
python scripts/post_noon.py --parsed noon_parsed.json --pdf-dir <fee-pdf-dir> [--dry-run]
```

Each PDF is one Noon tax invoice with several fee lines. The poster creates one
**fully itemized** bill per PDF — every fee line kept as its own bill line — and
routes each line by type:

- Any line whose description contains **"marketing"** (case-insensitive) →
  **Noon Food Marketing Expense**.
- Every other fee (Lead generation, Payment, Delivery, Device, Platform,
  Long Distance, Cancellation, …) → **Noon Food Commission**.

This keyword rule is deliberately open-ended so new fee types default to Commission
rather than breaking. Line amounts can be **negative** (Noon issues in-invoice
adjustments) — that's fine, they net down the bill.

Bill fields: `bill_number` = Noon's Invoice Nr (e.g. `AE1PQ3DSQ-…`), `bill_date` =
the invoice's own date, tax-exclusive at 5% VAT on Purchases, `reference` = the
Source Document statement (`NOON_R_…`), PDF attached. After create it authorizes
the bill and marks it **PAID** via a BILL payment through the Noon Food Transactions
clearing account. **Dedup:** skips any Invoice Nr already booked.

## Part 2 — Sales invoices (from the statement CSVs)

```
python scripts/post_noon_sales.py --statements-dir <csv-dir> [--dry-run]
```

Each CSV is one outlet's orders. The two columns that matter:
- **`outlet_name`** (col C) — its suffix is the emirate: `…__barsha` → **DUBAI**,
  `…__abu_dhabi` (incl. `al_nahyan`) → **ABU_DHABI**. This sets `place_of_supply`.
- **`rest_invoice`** (col U) — the actual sale amount, **VAT 5% inclusive**.

The poster creates one **PAID simplified invoice per order** where
`rest_invoice != 0` (this includes undelivered orders that still carry a value;
canceled/zero orders are skipped naturally). Fields: `invoice_number` = the Noon
order number (`order_nr`), `invoice_date` = `order_date`, booked to Noon Food
Revenue at 5% VAT on Sales (tax-inclusive), `reference` = the statement number,
paid through the Noon Food Transactions clearing account. **Dedup:** skips any
order number already invoiced.

## Guardrails
- Always `--dry-run` first and show the user before posting to their live books.
- Sales invoices can run to a few hundred — more than a single command may finish
  in one go. The poster is **idempotent** (dedups on invoice number), so if it's
  interrupted, just re-run it and it resumes where it left off.
- Amounts may differ a cent or two from stated totals because Wafeq recomputes 5%
  VAT per line — normal, matches prior months.
- Never hard-delete the user's downloaded files. Never post without a go-ahead.
