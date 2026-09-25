# Wafeq IDs & conventions — Now Now (Presentail)

Sales-only platform. Resolved against Presentail's Wafeq account.

## API
- Base: `https://api.wafeq.com/v1` · Auth: `Authorization: Api-Key <KEY>`
- Idempotency (recommended): `X-Wafeq-Idempotency-Key: <uuid4>` · Currency `AED`

## Accounts
- Now Now Revenue: `acc_bbDvRzNEpmi6E7ZH8UhTRJ`  ← sales-invoice line
- Now Now Transactions (asset clearing): `acc_RArGUFjKUjdfkm8qAERawg`  ← paid_through
- (Now Now Commission `acc_7SXMhp67qZbFugtrrshaoj` exists but is **not used** —
  Now Now is booked sales-only.)

## Tax
- VAT on Sales 5%: `tax_WAss52jmQnUvyH8UTCyRYe` — tax-inclusive.

## Sales-invoice convention (`/simplified-invoices/`)
One PAID invoice per delivered order (grouped by `order_nr`):
`invoice_number` = order_nr, `invoice_date` = order_date, `place_of_supply` = DUBAI
(all), `tax_amount_type` = TAX_INCLUSIVE, one line to Now Now Revenue at VAT on
Sales, `unit_amount` = summed `discounted_price` for the order, `reference` =
statement_nr, `paid_through_account` = Now Now clearing. No contact.

## EX*.xlsx columns
order_nr, order_date, store_code, statement_nr, super_category, category,
sub_category, product_name, sku, brand, size, size_unit, barcodes,
order_status_code (use **delivered**), product_status_code, payment_method_code,
delivery_type_code, qty, price, price_discount, **discounted_price** (the sale, VAT
incl), store_refund, merchant_coupon_discount, merchant_total_discount, commission
(ignored), vat, commission_inc_vat, net_payable.

## store_code → brand (prefix)
FLWRBG→Flower Bag · FLWRSC→Flower Scent · MNBLMS→Mini Blooms · PLLNFL→Pollen Flowers ·
PNRSFL/PRSNTL→Presentail · SNGLFL/THSNGL→Single Flower. (Two codes per brand =
the Dubai and Abu Dhabi branches, but place of supply is set to Dubai for all.)
