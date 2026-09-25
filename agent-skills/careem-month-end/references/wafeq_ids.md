# Wafeq IDs, conventions & store mapping (Presentail)

Concrete identifiers resolved against Presentail's Wafeq account. IDs are stable,
but **re-verify the store→emirate mapping against the tracker Google Sheet each run**
(stores get added and occasionally change emirate).

## API basics
- Base URL: `https://api.wafeq.com/v1`
- Auth header: `Authorization: Api-Key <KEY>`
- Idempotency (optional but recommended on writes): `X-Wafeq-Idempotency-Key: <uuid4>`
- Currency: `AED`

## Supplier / customer
- Bill supplier — **CAREEM DELIVERIES FZ LLC**: `co_TGW2p5Kokxs7fApZRLtYMU`
  (TRN 104101335800003; matches the supplier TRN on the PDFs). Do **not** use the
  older bare "Careem" contact `co_DusiJoveDWvchBw3DtGW9x`.
- Cash (simplified) invoices: **no contact** — leave it blank.

## Accounts
- Careem Commission (expense, code 503): `acc_kd64DxUxUTVJGwifwJeree`  ← bill lines
- Careem Revenue (revenue, code 415): `acc_mFxKxJQbwXZ5kR2AuTpCQV`   ← cash-invoice line
- Careem Transactions (asset clearing, code 120): `acc_LXa8CizucFw6uVVonQ2PbF`
  ← `paid_through_account` on the cash invoice; this is what the Wio bank feed later
  reconciles against.

## Tax rates (all 5%)
- VAT on Purchases: `tax_oEzW9XTqZWxJAUMSvaTSP9`  ← bills (tax-exclusive)
- VAT on Sales:     `tax_WAss52jmQnUvyH8UTCyRYe`  ← Careem cash invoices (tax-inclusive)
  (Note: some other platforms' cash invoices use the Purchases rate; Careem uses Sales.)

## Branches & project
- Barsha (Dubai): `br_6Wyrs9iNwpybGFczAG5zmJ`
- Abu Dhabi:      `br_EC6YHtmTfPBXPKsYH4HrxM`
- Project (all): Presentail `pro_TQ5QT6SfEur6DcXmTaJnmh`
- Branch matters for the **bill** (cosmetic/reporting). Emirate matters for the
  **cash invoice** via `place_of_supply` (`DUBAI` / `ABU_DHABI`).

## Document conventions
- **Bill**: `bill_number` = the store merchant number, plain, no month suffix
  (e.g. `1088963`). `bill_date` = `bill_due_date` = period month-end. One merged
  line, description "Commission and Fees", `unit_amount` = net fees (Total Excl VAT),
  `tax_amount_type` = `TAX_EXCLUSIVE`. Attach the Careem PDF. Authorize after create,
  then mark **PAID** with a BILL payment through the Careem Transactions clearing
  account: `POST /v1/payments/` with `payment_type=BILL`, `currency=AED`,
  `paid_through_account` = clearing, and `bill_payments:[{bill, amount, amount_to_pcy}]`
  (both amount fields = the bill total).
- **Cash invoice** (`/simplified-invoices/`): `invoice_number` = next `SINV-000NNN`,
  `status` = `PAID`, `place_of_supply` per emirate, `paid_through_account` = Careem
  Transactions, `tax_amount_type` = `TAX_INCLUSIVE`, one line to Careem Revenue,
  description = store brand, `unit_amount` = gross sales (Total Gross Amount).

## Slack
- Notify by DM to the logged-in user: `channel_id = UGB9DSHPH`.

## Store mapping (last verified: June 2026 — re-check the Sheet)
Merchant number → (emirate, place_of_supply, cash-invoice brand description)

| Store   | Emirate   | place_of_supply | Brand (cash-invoice desc)         |
|---------|-----------|-----------------|-----------------------------------|
| 1068765 | Dubai     | DUBAI           | The Single Flower by Presentail   |
| 1068769 | Dubai     | DUBAI           | Flower Bag                        |
| 1071168 | Dubai     | DUBAI           | Presentail                        |
| 1072404 | Dubai     | DUBAI           | Flower Scent                      |
| 1074359 | Dubai     | DUBAI           | Pollen Flowers                    |
| 1081919 | Dubai     | DUBAI           | Eternal Rose                      |
| 1082118 | Dubai     | DUBAI           | Mini Blooms                       |
| 1088963 | Dubai     | DUBAI           | Blooms & Balloons                 |
| 1080388 | Abu Dhabi | ABU_DHABI       | Presentail                        |
| 1080614 | Abu Dhabi | ABU_DHABI       | Flower Scent                      |
| 1080620 | Abu Dhabi | ABU_DHABI       | The Single Flower by Presentail   |
| 1083092 | Abu Dhabi | ABU_DHABI       | Mini Blooms                       |

Other stores that may appear (from the Sheet's Careem table) but had no June invoice:
1074353 (Petal Cones, Dubai), 1080615 (Flower Bag, AD), 1080617 (Pollen Flowers, AD),
1080619 (Eternal Rose, AD), 1080621 (Petal Cones, AD). Always take the live Sheet as
the source of truth.

## The tracker Google Sheet
Careem "added to Wafeq?" tracking lives in the tracker spreadsheet. The relevant
tab has a Careem store table grouped by Barsha vs Abu Dhabi with each store's
merchant number, brand, and a TRUE/FALSE per month. Read it via the Google Drive
connector (`read_file_content` on the spreadsheet file id). The connector can read
but not tick cells — so the check marks are reported to the user over Slack.
