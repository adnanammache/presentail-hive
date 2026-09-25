# Wafeq IDs & conventions — Talabat (Presentail)

Resolved against Presentail's Wafeq account. IDs are stable.

## API
- Base: `https://api.wafeq.com/v1` · Auth: `Authorization: Api-Key <KEY>`
- Idempotency (recommended on writes): `X-Wafeq-Idempotency-Key: <uuid4>` · Currency `AED`

## Supplier
- **Delivery Hero Talabat DB L.L.C**: `co_D2vSPDvaPGJKJY6G5YP3jL` (TRN 100000978500003) — bill contact.
- Sales (simplified) invoices carry **no contact**.

## Accounts
- Talabat Commission (505): `acc_4J9jT5pdg9pgcA4nPFYsDy`
- Talabat Subscription Fee (506): `acc_RyqS3EC2ZgQHQSHRaoMnH8`
- Talabat Marketing Expense (6022): `acc_dnCh6QNz5WGJHAvcrvHTBT`
- Talabat Premium Marketing Fee (6023): `acc_fPjYTCuSpXG7wixfDUMUgm`
- Talabat Revenue (421): `acc_A9TZgvqqo7KmwXqx2pA9tr`
- Talabat Transactions (asset clearing): `acc_DDapSPi55Qr8FyaYPQsXfn`
  — `paid_through_account` for both bill payments and sales invoices.

## Tax (5%)
- VAT on Purchases: `tax_oEzW9XTqZWxJAUMSvaTSP9` — expense bills (tax-exclusive)
- VAT on Sales: `tax_WAss52jmQnUvyH8UTCyRYe` — sales invoices (tax-inclusive)

## Fee-type → account rule (bills), by description (case-insensitive)
- contains "subscription" → Talabat Subscription Fee
- contains "premium" or "placement" → Talabat Premium Marketing Fee
- contains "sponsored" or "boosted" → Talabat Marketing Expense
- otherwise → Talabat Commission

Fee types seen: Partner Subscription Fee, Commissions, Premium Placement Organic List,
Sponsored Deal Fee (Boosted), Credit Card Charges, Talabat Credit Charges, Cash
Handling Charges, Loyalty Charges - Pro Delivery, Discount (negative). Everything
except subscription/premium/sponsored intentionally lands in Commission.

## Document conventions
- **Bill**: one per TUAE PDF, fully itemized. `bill_number` = TUAE number,
  `bill_date` = Issue Date, `bill_due_date` = Due Date, tax-exclusive,
  `reference` = Restaurant Name, PDF attached. Authorize, then mark PAID with a BILL
  payment through Talabat Transactions clearing (`payment_type=BILL`, `currency=AED`,
  `bill_payments:[{bill,amount,amount_to_pcy}]`).
- **Sales invoice** (`/simplified-invoices/`): one per branch. `invoice_number` =
  next `SINV-000NNN`, `status=PAID`, `invoice_date` = period month-end,
  `place_of_supply` from branch area (Al Barsha 1→DUBAI, Al Nahyan→ABU_DHABI),
  `tax_amount_type=TAX_INCLUSIVE`, one line to Talabat Revenue at VAT on Sales,
  `unit_amount` = the branch **Earnings** figure, `paid_through_account` = clearing.

## Talabat statement archive (4 doc types)
- `TUAE-*.pdf` → expense bills (fee invoices).
- `BalanceSummary_<store>.pdf` → "Branches balance summary" table → per-branch Earnings → sales invoices.
- `SOA_*.pdf` → settlement summary, reference only (not posted).
- `Detailed_*.xlsx` → per-order detail, not needed for posting under the Earnings-based method.
