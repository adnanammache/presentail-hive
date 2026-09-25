---
name: careem-month-end
description: >-
  Automates Presentail's monthly Careem-to-Wafeq bookkeeping. Turns downloaded
  Careem tax-invoice PDFs into Wafeq commission bills and cash (simplified) sales
  invoices, sets the correct Dubai/Abu Dhabi place-of-supply from the tracker
  Google Sheet, dedupes against what's already posted, and Slacks the check-mark
  list. Use this whenever the user wants to process, add, or reconcile Careem
  invoices in Wafeq — including phrasings like "do the Careem invoices", "add
  Careem to Wafeq", "month-end Careem", "Careem commission bills", or "Careem
  revenue / cash invoices" — even if they don't spell out the individual steps.
  Presentail-specific; assumes the Wafeq REST API, a Wafeq API key, and the
  Google Drive + Slack connectors are available.
---

# Careem → Wafeq monthly bookkeeping

Each month Careem issues one tax invoice **per store** (merchant reference). Every
invoice has two sides that must land in Wafeq:

1. **Commission bill** — the fees Careem charges Presentail (logistic, platform,
   CPlus, processing, payment-gateway fees). This is a **purchase bill** from the
   supplier *Careem Deliveries FZ LLC*.
2. **Cash sales invoice** — the gross order value customers paid through Careem.
   This is a **simplified (cash) invoice** booked to Careem Revenue.

The Dubai vs Abu Dhabi split for each store comes from a tracker **Google Sheet**
and drives the `place_of_supply` on the cash invoice (it does not affect the bill).

This skill does everything from "the PDFs are downloaded" onward. Downloading the
PDFs from Careem's dashboard is a manual step the user does first (it needs an
email OTP login), so **do not** try to automate the Careem download.

## Prerequisites (check these first, fail loudly if missing)

- **Network access to `api.wafeq.com`** must be enabled for the sandbox
  (Org settings → Capabilities → Code execution allowlist). A fresh session
  won't have it unless it was turned on before the session started. Test with a
  simple `GET /v1/accounts/?limit=1` and stop with a clear message if it 403s.
- **Wafeq API key.** Look for it in this order: the `WAFEQ_API_KEY` env var; a
  file named `wafeq_key.txt` in the connected Downloads/working folder; otherwise
  ask the user for it. Never echo the key back in text.
- **Google Drive connector** — to read the tracker Sheet.
- **Slack connector** — to send the check-mark list (DM the logged-in user).
- **The Careem invoice PDFs** — usually in the user's Downloads folder, named
  like `104101335800003-YYYYMMDD-<invoiceID>.pdf`. Stage them into the workspace.

All the concrete Wafeq IDs (accounts, tax rates, branches, the supplier contact,
the clearing account) and the store→emirate→brand mapping live in
`references/wafeq_ids.md`. Read that file before posting anything.

## Workflow

### 1. Collect and parse the invoices
Stage the Careem PDFs into the workspace, then run:

```
python scripts/parse_careem.py <folder-with-pdfs> > parsed.json
```

This extracts, per invoice: `merchant_ref` (store number), `invoice_id`,
`invoice_date`, period, `gross_sales` (Total Gross Amount → cash invoice),
`fees_excl_vat` (Total Excl VAT → bill net), and the fee line items. Sanity-check
the totals against the PDFs before continuing.

### 2. Read the Sheet for the emirate mapping
Read the tracker Google Sheet (the "Careem" store table) with the Google Drive
connector. For each store merchant number it gives the **emirate** (Barsha = Dubai,
or Abu Dhabi) and the **brand/store name** used as the cash-invoice description.

`references/wafeq_ids.md` contains the last known mapping, but **re-read the Sheet
every run** — stores get added and occasionally move emirate. Trust the Sheet over
the stored mapping, and over last month's Wafeq data (a store's Wafeq branch may
have been mis-set in a prior month; the Sheet is the source of truth).

### 3. Post to Wafeq
Run the poster with the parsed data and the period's month-end date:

```
python scripts/post_to_wafeq.py --parsed parsed.json --period-end 2026-06-30 \
    --pdf-dir <folder-with-pdfs> [--dry-run]
```

Always do a `--dry-run` first — it prints exactly what would be created (per store:
bill number, amounts, emirate, cash-invoice gross) without writing anything. Show
that to the user and get a go-ahead before the real run.

For each store the poster:
- **Bill**: uploads the PDF (`POST /v1/files/` → `att_…`), creates the bill
  (`POST /v1/bills/`) as one merged line "Commission and Fees" to the Careem
  Commission account at 5% VAT-on-Purchases (tax-exclusive), branch per emirate,
  project Presentail, PDF attached, `bill_number` = the store merchant number,
  `bill_date`/`bill_due_date` = the period-end date, authorizes it
  (`PATCH status=AUTHORIZED`), then **marks it PAID** by posting a BILL payment
  (`POST /v1/payments/`) through the Careem Transactions clearing account. Careem
  nets its commission out of the settlement, so the bill is effectively paid via
  that clearing account — and this is what makes the clearing balance reconcile
  (cash-invoice gross in, bill fees out, remainder = Careem's actual payout).
  **Dedup:** skips any store whose bill number already exists under the Careem
  Deliveries contact.
- **Cash invoice**: creates a simplified invoice (`POST /v1/simplified-invoices/`)
  booked to Careem Revenue at 5% VAT-on-Sales (tax-inclusive), `place_of_supply`
  per emirate, paid through the Careem Transactions clearing account, description =
  the store brand, `unit_amount` = gross sales, **and an explicit `invoice_number`**
  (see step 4) with `status=PAID`. **Dedup:** skips if a period-dated
  Careem-revenue cash invoice with the same brand + gross already exists.

### 4. Cash invoices need an invoice number to post as PAID
The key quirk: a simplified invoice will only finalize to **PAID** if you supply an
explicit `invoice_number`. Without one it silently stays a DRAFT (a missing customer
is *not* the blocker — Presentail keeps these contact-free on purpose). Wafeq's
native series is `SINV-000NNN`. Before posting, fetch the current simplified
invoices, find the highest `SINV-` number, and assign the next ones sequentially
(`SINV-000251`, `252`, …). Set `status=PAID` in the same create call (or, for an
existing draft, `PATCH {invoice_number, status:"PAID"}`). The poster script does
this automatically; never leave the month's cash invoices as drafts.

### 5. Slack the check-mark list
The tracker Sheet has "added to Wafeq?" check boxes the user ticks manually (the
Drive connector can read the Sheet but not tick a cell). DM the logged-in Slack
user a concise summary: the stores processed, the bill + cash-invoice totals, and
which boxes to tick (the main Careem cell + the per-store Careem boxes). See
`references/wafeq_ids.md` for the Slack user id.

### 6. Cleaning up the downloaded PDFs
If asked to delete the PDFs from Downloads: **do not hard-delete** the user's files.
Move them into a `_to_delete/` subfolder (via the device shell) if available, and
tell the user; otherwise ask them to delete the `104101335800003-*.pdf` files
themselves. If the device shell is unavailable, just say so and let them clean up.

## Guardrails
- This writes real financial records. Always `--dry-run` and confirm before the
  live run, especially the first time each month.
- Dedup is built in, but it's keyed on bill number (stores) and brand+gross+date
  (cash invoices). If the user re-runs, trust the "skipped" lines.
- Amounts may differ by a cent from the PDF's stated totals because Wafeq recomputes
  5% VAT from the net — this is normal and matches how prior months were booked.
- Never expose the API key. Never post to production without the user's go-ahead.
