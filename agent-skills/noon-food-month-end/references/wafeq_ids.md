# Wafeq IDs & conventions — Noon Food (Presentail)

Resolved against Presentail's Wafeq account. IDs are stable.

## API
- Base: `https://api.wafeq.com/v1` · Auth: `Authorization: Api-Key <KEY>`
- Idempotency (recommended on writes): `X-Wafeq-Idempotency-Key: <uuid4>`
- Currency: `AED`

## Supplier
- **Noon Food L.L.C**: `co_MaAEikWqckWAKEE2xPbASY` (TRN 100596351500003) — bill contact.
- Sales (simplified) invoices carry **no contact** (leave blank).

## Accounts
- Noon Food Commission (expense, code 504): `acc_J5exitoi7i68E3d33utHB6`
- Noon Food Marketing Expense (expense, code 6027): `acc_fooAfBQbtCP9gJcd5PiZZ9`
- Noon Food Revenue (revenue, code 418): `acc_67dfwewVN6FPuDsYFpVHH7`
- Noon Food Transactions (asset clearing, code 122): `acc_PM5ufMuhfZ6aYEUE34QpCK`
  — `paid_through_account` for both the bill payments and the sales invoices.

## Tax (5%)
- VAT on Purchases: `tax_oEzW9XTqZWxJAUMSvaTSP9` — expense bills (tax-exclusive)
- VAT on Sales: `tax_WAss52jmQnUvyH8UTCyRYe` — sales invoices (tax-inclusive)

## Fee-type → account rule (bills)
Classify each fee line by its description (case-insensitive):
- contains **"marketing"** → Noon Food Marketing Expense
- otherwise → Noon Food Commission

Fee types seen historically: Marketing, Lead generation, Payment, Delivery, Device,
Platform, Long Distance, Cancellation. New ones default to Commission. Lines may be
negative (adjustments).

## Document conventions
- **Bill**: one per fee PDF, fully itemized. `bill_number` = Noon Invoice Nr
  (`AE1PQ3DSQ-…`), `bill_date`/`bill_due_date` = the invoice date, tax-exclusive,
  `reference` = Source Document (`NOON_R_…`), PDF attached. Authorize, then mark
  PAID with a BILL payment (`payment_type=BILL`, `currency=AED`,
  `paid_through_account` = Noon clearing, `bill_payments:[{bill,amount,amount_to_pcy}]`).
- **Sales invoice** (`/simplified-invoices/`): one per order with `rest_invoice != 0`.
  `invoice_number` = `order_nr`, `status=PAID`, `invoice_date` = `order_date`,
  `place_of_supply` from the outlet-name suffix (`barsha`→DUBAI, `abu_dhabi`/`al_nahyan`→ABU_DHABI),
  `tax_amount_type=TAX_INCLUSIVE`, one line to Noon Food Revenue at VAT on Sales,
  `unit_amount` = `rest_invoice`, `reference` = `statement_nr`, `paid_through_account`
  = Noon clearing.

## Statement CSV columns (per-outlet order files)
`statement_nr`(A), `outlet_code`(B), **`outlet_name`(C)**, `order_nr`(D),
`order_date`(E), `statement_date`(F), … , **`rest_invoice`(U)** — the VAT-inclusive
sale amount, … , `order_status` (delivered / undelivered / canceled).
