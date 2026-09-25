# Verified Odoo IDs and mechanics — Presentail SAL, BLOM

Read from the live database 28–29 July 2026. **Odoo 19.0.** Company **Presentail SAL,
`company_id = 2`**, company currency **LBP (96)**.

## Driving Odoo through the Make probe

Scenario **6727612** (`cf_generic_odoo_probe`) wraps one `odoo:makeApiCall` on
connection **6330934** ("Odoo finance new").

- `entity` = model, `action` = method, `params` = **positional args array for
  `execute_kw`**, as a JSON string. The kwargs field isn't mapped — everything positional.
- `search_read` → `[[domain],[fields],offset,limit,"order"]`
- `search_count` → `[[domain]]`
- `read_group` → `[[domain],[agg_fields],[groupby]]`
- `create` → `[{vals}]` — a **list** of vals dicts creates many at once
- `write` → `[[ids],{vals}]`
- `unlink` → `[[id, id, ...]]` — **one** level of nesting. `[[[ids]]]` fails with
  `TypeError: unhashable type: 'list'`.

### The scenario reports an error on success

Its mapping step expects an array, so any scalar return surfaces as
`Failed to map 'data.t1': ... '184' is not a valid array`. **The value in that
message is the answer** — a count, a new record id, or `true` from a write/unlink.
Never retry on it. Confirm with a follow-up `search_count`.

`... 'true' is not a valid array` is therefore the **success** signal for every
`write` and `unlink`. Verify by re-reading, never by re-running the write.

### Two mapping errors and what they actually mean

- `'{empty}' is not a valid key` — you left `f1`..`f4` / `m1` / `m2` unset. All six
  are mandatory on every call, even for a write where nothing comes back. Pad them
  with any real field name.
- `Cannot read properties of undefined (reading 'id')` — a field named in `m1`/`m2`
  is **not in the `fields` list of `params`**, or it isn't a many2one. Everything you
  reference in `f*`/`m*` must also be requested in the query. Many2many (e.g.
  `company_ids`) and unset many2ones both break it; on `account.account` use
  `root_id` as a harmless filler.

Only four scalars fit per call. Needing five means two calls — split rather than
guessing which one drops.

### read_group honours only the first groupby

`read_group` is lazy, so `[["balance"],["journal_id","account_id"]]` returns groups
keyed by `journal_id` alone and the `account_id` mapping then fails. **One groupby per
call**; pin the other dimension in the domain instead.

### Reaching statement lines from their move lines

`account.move.line.statement_line_id` is queryable, and dotted domains through it
work. This is how you select suspense legs by description without ever listing ids:

```json
[[["account_id","=",379],["journal_id","=",46],
  ["statement_line_id.payment_ref","like","SALE "],
  ["statement_line_id.amount","<",0]],
 ["id","date","name","amount_currency","statement_line_id","account_id"],0,200,"date,id"]
```

Classifying a statement line is then just `write` `account_id` on that leg — Odoo
recomputes `is_reconciled` itself. It works on **posted** moves and on lines that are
already reconciled to a wrong account, so this is also the repair tool. Chunk ids
~60 per write.

### Scenarios that look useful and aren't

`6748642` / `6748646` (`blom_probe_raw_dump`, `blom_recon_probe_raw_dump`) take
`entity`/`action`/`params` with no `f*` fields, which looks like a way around the
four-scalar limit — but they do not write to store **153740**, so nothing comes back.
`6758684` and `6734910` repoint statement lines to a *hard-coded* clearing/AP account,
not one you pass in. For anything new, use 6727612.

### Reading multi-field results back

Results land in Make data store **153740** under `key`, read via
`data-store-records_list`. Two catches: the list is **capped at 100 records** and
the store holds more than that, so a fresh key is often unreadable. Work around it
by **reusing an existing key that sits within the first 100** as a scratch slot —
`bal1903_byjournal` works — then grep the saved output file.

You must supply `f1`..`f4` (scalar fields) and `m1`,`m2` (relational fields) or the
mapping fails with `'{empty}' is not a valid key`. Note the last scalar field's
segment runs to the end of the `t1` string, so parse it differently from the others.

`fields_get` returns a dict and **cannot** be read back through this probe.
Many2many values render empty in `M:` output — prove m2m membership with a domain
query (`[('match_journal_ids','in',[23])]`) instead.

## Journals

| id | name | code | type | currency | default acct | suspense |
|---|---|---|---|---|---|---|
| 23 | Blom Bank USD - Business Plus | BNK2 | bank | 1 (USD) | 1903 | 379 |
| **46** | **Blom Bank POS USD** | **BNK5** | **bank** | **1 (USD)** | **1918** | **379** |
| 47 | Blom Bank LBP - Business Plus | BNK6 | bank | company | 1921 | 379 |
| 24 | Blom Bank LBP | BNK3 | bank | — | 1928 | 379 |
| 43 | CASH USD | CSH2 | cash | 1 (USD) | 1905 | — |
| 38 | Revolut CAD | BNK3 | bank | — | 1873 | 221 |
| 17 | Cash Basis Taxes | CABA | **general** | — | — | — |

Journal **46 is a zero-balance sweep account** — every statement is 0.00 → 0.00, and
its bank account 1918 should sit at zero once a month is fully reconciled. Its net
deposits arrive on journal 23 as `SALES VOUCHERS`; see "The POS settlement chain" in
SKILL.md.

Journals 23, 46, 47 and 24 **share** suspense account 379. Journal 17 is **not** a bank
journal — the retired POS Maya scenario had `journal_id: 17` hard-coded, which is why
bank activity ended up in a tax journal. Note journals 24 and 38 share the code BNK3.

## Accounts

**The numbers used throughout are Odoo internal IDs, not account codes.** Company 2's
chart uses French-style codes (`5121.5`, `673900`, `7010`).

| id | co-2 code | name | type |
|---|---|---|---|
| 515 | 673900 | Bank charges & commissions | expense |
| 513 | 673601 | Interest - banks & financial operation | expense |
| 1905 | 5300.4 | Cash USD | asset_cash |
| 1918 | 5121.3 | POS Blom USD | asset_cash |
| 1903 | 5121.5 | Blom Bank USD - Business Plus | asset_cash |
| 1921 | 5121.1 | Blom Bank LBP - Business | asset_cash |
| 1928 | — | Blom Current LBP | asset_cash |
| 1661 | 6111 | Purchase of Raw Materials | expense |
| 1703 | 6310 | Salaries and Wages | expense |
| **1559** | **4211** | **Salaries and Wages due to Personnel** | asset_receivable |
| 516 | 675100 | Difference on exchange - negative | expense |
| 582 | 7751 | Exchange Profits on Current Operations | income |
| 379 | 540002 | Bank Suspense Account | asset_cash |
| **603** | — | **Liquidity Transfer** | asset_current, **reconcile=true** — clearing account for the POS→Business Plus sweep (both legs) |
| 1650 | — | INTERNAL TRANSFERS | liability_credit_card, reconcile=false — **not** the transfer account, don't use it |
| 286 | — | Notes receivable | asset_receivable — the AR account POS card invoices land on |
| 1927 | 1680.3 | Loan Zakaria Ammache | liability_non_current, reconcile=true (**corrected 28 Jul 2026 — was `expense`**) |

### Reading account codes correctly

The connection's **active company is company 1 (Presentail LTD)**. So the plain
`code` field renders `false` for company-2-only accounts, `search([('code','=',…)])`
matches only company-1 codes, and `search([('code_store','like',…)])` **silently
fails** for accounts whose code exists only in a non-active company — it found
`7910` but missed `4211`.

**Always resolve company-2 codes through `account.code.mapping`** with
`company_id = 2`. Anything else is untrustworthy; this produced one wrong answer
already (`4211` reported non-existent when it is account 1559).

Also: **`7910` is not a Presentail SAL account** — it's id 202 in Presentail LTD.
Use 516 (loss) / 582 (gain) for company 2. And **1559 is typed `asset_receivable`**
although a "salaries due to personnel" account should be a liability — flag it,
don't work around it.

## Statement creation payload (validated)

```json
[{"name":"BLOM USD June 2026","journal_id":23,
  "balance_start":-16.0,"balance_end_real":835.78,
  "line_ids":[[0,0,{"date":"2026-06-01","payment_ref":"SALES VOUCHERS 1260526",
                    "amount":19.52,"journal_id":23,
                    "unique_import_id":"20260601db2100177d01"}]]}]
```

`unique_import_id` **is accepted verbatim on direct create** — readonly only applies
to the import wizard, so the SQL unique constraint still protects you. Confirm with
`is_complete = true`.

To move existing lines into a statement:
`write` on `account.bank.statement.line`, `[[ids…],{"statement_id":124}]`.

## Reconciliation models

Odoo 19 uses **`trigger`** (`'manual'` | `'auto_reconcile'`, labelled *Manual* /
*Automated* in the UI). Odoo 18's `rule_type`, `auto_reconcile`, `match_nature`,
`counterpart_type`, `matching_order`, `past_months_limit` **do not exist**.

There is **no menu entry** for reconciliation models. Reach them via Accounting →
Dashboard → ⋮ on the journal card → Reconciliation Models, or the direct URL
`/odoo/action-273`.

Current set on journal 23, in sequence order:

| Seq | ID | Name | Regex | → |
|---|---|---|---|---|
| 10 | 79 | BLOM: bank fees & commissions | `^(ACCOUNT CHARGES\|STATEMENT FEES\|STAMPS CHARGES\|HIGHEST DB\|POS MONTHLY FEES\|SWIFT CHARGES\|OUTGOING TRANSFER COMMISSION\|COMMISSION ON CHECK WITHDRAWAL)` | 515 |
| 20 | 80 | BLOM: incoming-transfer commission | `^COMMISSION\s*/\s*INCOMING` | 515 |
| 30 | 81 | BLOM: ATM cash fees | `^ATM CASH WITHDRAWAL FEE\|^ATM CASH DEP\S*\s.*COMM` | 515 |
| 40 | 82 | BLOM: Alfa / MIC line commission | `^MIC \d+ \(ALFA\) COMMISSION` | 515 |
| 45 | 83 | BLOM: audit confirmation fee | `^COMM AUDIT CONF` | 515 |
| 50 | 87 | BLOM: debit interest | `^DEBIT INTEREST` | 515 |
| 60 | 21 | Cash USD | `^ATM WITHDRAWAL` | 1905 |
| 70 | 84 | BLOM: ATM cash deposit | `^ATM CASH DEPOSIT` | 1905 |
| 80 | 47 | Salaries and Wages | `^SALAR(Y\|IES)` | 1559 |
| 90 | 85 | BLOM: POS card settlements | `^SALES VOUCHERS` | 1918 ⚠️ **wrong target — should be 603** |
| 100 | 86 | BLOM: FX conversion | `^FX OPR` | 516 |
| 130 | 20 | Purchase of Raw Materials | `TOTERS USD…` | 1661 |

The `^COMMISSION\s*/\s*INCOMING` optional space is load-bearing: BLOM writes both
`Commission/Incoming Tfr` and `Commission /Incoming Transfer`. The retired Make rule
matched only the first and silently dropped five transactions a month.

**Model 85 is booby-trapped.** Its counterpart 1918 is journal 46's *own* bank
account, so every `SALES VOUCHERS` line it matches credits 1918 a second time —
journal 46 already credited it on the sweep-out line. It is still Manual, so it only
fires when somebody clicks the suggestion; it did fire on Apr and May 2026. Repoint
it to **603 Liquidity Transfer** before letting it anywhere near Automated. Left as-is
30 Jul 2026 at the user's request.

Deliberately **not** on journal 23: model **22 Transportation** (identical TOTERS
regex to model 20 but a different account — undefined winner) and model **42 Loan
Zakaria Ammache** (blanket `IPO/` write-off). Model **52** was removed too, after
switching it to Automated blew up on a broken entry on the LBP journal it shares.

## State as of 29 July 2026

- Make scenarios **6156417** (USD), **6142044** (LBP), **6123754** (POS) — all
  **deactivated**. Measured against the June USD statement they dropped **34 of 59
  transactions**, worth $19,238.
- **100 orphan draft entries** on journal 23 — deleted, manifest archived first.
- Journal 23 holds **613 statement lines** in six statements:
  Jan 124 · Feb 125 · Mar 126 · Apr 121 · May 122 · Jun 123.
  Chain: 108,775.72 → 781.63 → 6,502.15 → 372.87 → 966.45 → −16.00 → **835.78**.
  All six `is_valid` and `is_complete`. Zero statements fail either check, so the
  "Invalid Statement(s)" banner is clear.
- **Open — the ledger still won't agree with the bank until these are done:**
  - **$60,465.49 of double-counting** on account 1903: 26 moves on journal 43 and
    36 on journal 17, all duplicating statement lines. Reversal candidates; two
    (15915, 12534) need reading first, and journal 43's 7 Apr −2,000 has no bank
    cover at all.
  - The `IPO/` payer split (38 transfers, $279,139 Jan–Jun: Adnan Zakaria Ammache
    $136,444 · Adnan Ammache $134,273 · BLOOMS FLORA $4,056 · Lundy $3,200 ·
    Zeal SAL $1,109 · Amex $58). Partners 131 BLOOMS FLORA, 238 Zeal SAL; three
    duplicate "Adnan Ammache" records (ids 3, 48, 250).
  - 24 lines carrying value dates instead of business dates.
  - **35 lines on journal 24** whose bank leg sits on account 672 "Banks - Term
    Deposits Accounts" instead of 1928 "Blom Current LBP" — the entries that make
    that journal blow up when a reconciliation model is switched to Automated.

## POS journal 46 — done 30 July 2026

The full Jan–Jun settlement chain is reconciled. **202 lines repointed to 603**:
142 sweep legs on journal 46, 41 `SALES VOUCHERS` legs on journal 23, and 19 Apr/May
"POS Blom USD settlement" lines rescued off 1918. Account **603 nets 0.00**, and every
month ties on its own: Jan 743.91 · Feb 1,481.38 · Mar 300.64 · Apr 719.65 ·
May 391.12 · Jun 616.81.

Three empty statements (**99, 100, 105** — 105 claimed `balance_end_real` 2,314 with
zero lines) were unlinked; that was the entire "Invalid Statement(s)" banner. Journal
46 now holds exactly six statements, 127 Jan · 129 Feb · 128 Mar · 130 Apr · 131 May ·
132 Jun, all `is_valid` and `is_complete`.

- **Still open on journal 46: $3,341.00 of card revenue** — unmatched positive
  `SALE VISA` / `SALE MASTERCARD` and `DCC MERCHANT INCENTIVE` lines
  (Jan 767 · Feb 1,527 · Mar 309 · Apr 738). These need **sales invoices**, not a
  transfer. May and Jun are fully clear.
- **Account 1918 still carries −2,641.11**, now entirely from **journal 17** (Cash
  Basis Taxes) — the retired POS Maya scenario's double-counting. Journal 23's
  contribution is zero. Same disease as the 1903 case above; reversal candidate, read
  both legs first.
- **Journal 23 has $2,840.73 net still unreconciled** Jan–Jun after the vouchers came
  out: Jan −7,710.05 · Feb 11,978.90 · Mar −5,868.64 · Apr 6,953.77 · May 8,489.00 ·
  Jun −11,002.25. Includes 7 June salary lines ($14,900, deliberately left) and the
  `IPO/` split above.
- **New UNCLASSIFIED description:** `MIC 1 (ALFA) 3257553` −194.39 on 11 Jun. Model 82
  only matches `^MIC \d+ \(ALFA\) COMMISSION`, so the Alfa **bill** itself falls
  through. Worth its own rule to a telecom expense account.
