---
name: now-now-month-end
description: >-
  Automates Presentail's monthly Now Now bookkeeping in Wafeq. Now Now is
  sales-only: it turns the per-store Now Now order spreadsheets (EX*.xlsx) into one
  paid sales invoice per delivered order, booked to Now Now Revenue and paid through
  the Now Now Transactions clearing account. There is no expense/commission side —
  the commission column is intentionally ignored. Use whenever the user wants to
  process, add, or reconcile Now Now in Wafeq — "do the Now Now invoices", "add Now
  Now to Wafeq", "month-end Now Now", "Now Now sales" — even if they don't spell out
  the steps. Presentail-specific; assumes the Wafeq REST API and a Wafeq API key.
---

# Now Now → Wafeq monthly bookkeeping

Now Now is the simplest platform: **sales only, no expense bills**. Historically
Presentail books Now Now purely as revenue (the commission Now Now deducts is not
recorded), and the current data confirms that choice.

The input is a set of **`EX*.xlsx`** spreadsheets (one per store/statement). Each is
**order-line level** — an order with several products has several rows sharing one
`order_nr`. The important columns:

- `order_nr` — the order id (repeats across an order's product rows)
- `order_date`, `store_code`, `statement_nr`
- `order_status_code` — only **`delivered`** rows are sales
- `discounted_price` — the sale amount, **VAT 5% inclusive** (price after discount,
  what the customer paid). Use this, not `price` (pre-discount) or `net_payable`
  (net of commission).

## What it does

```
python scripts/post_nownow_sales.py --dir <xlsx-dir> [--dry-run]
```

Groups delivered order-lines by `order_nr` and creates **one PAID simplified
invoice per order** — `unit_amount` = the summed `discounted_price` for that order,
tax-inclusive at 5% VAT on Sales, booked to Now Now Revenue, paid through the Now
Now Transactions clearing account. `invoice_number` = `order_nr`, `invoice_date` =
`order_date`, `description` = the store brand (decoded from `store_code`).

**Place of supply:** all **DUBAI** — Now Now revenue is minimal and there's no
emirate field in the data, so per the user's decision every invoice is Dubai. If
that ever changes (an emirate field appears, or volume grows), revisit this.

**Only delivered orders** become invoices; canceled / returned / failed / rejected
are skipped, as are any zero-value lines.

**Dedup:** skips any `order_nr` already invoiced — safe to re-run.

## Prerequisites
- Network access to `api.wafeq.com` (test `GET /v1/accounts/?limit=1`).
- Wafeq API key: `WAFEQ_API_KEY` env or `wafeq_key.txt` in the working folder.
- The `EX*.xlsx` spreadsheets staged into the workspace. Needs `openpyxl`.

## Guardrails
- `--dry-run` first and show the user before posting.
- **Aggregate per `order_nr`** — never one invoice per row, or you'd both duplicate
  the order number and understate each multi-item order.
- Amounts may differ a cent from a hand-sum because Wafeq recomputes 5% VAT per
  invoice — normal. Never hard-delete the user's files; never post without go-ahead.
