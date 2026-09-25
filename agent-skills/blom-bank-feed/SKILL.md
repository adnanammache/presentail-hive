---
name: blom-bank-feed
description: >-
  Runs Presentail SAL's BLOM Bank reconciliation in Odoo end to end. BLOM has no bank-
  sync connector, so this converts raw eBLOM statement exports (CSV or XLS) into bank
  statements with stable transaction IDs and correct opening/closing balances, then lets
  Odoo's reconciliation models classify the lines. Covers the BLOM POS card journal too
  — pairing each SALE VISA / MASTERCARD sweep and its COMMISSION rebate against the net
  SALES VOUCHERS deposit that lands in Business Plus, clearing both legs through
  Liquidity Transfer. Also repairs a drifted journal: finding missing and duplicated
  transactions, regrouping lines into monthly statements, spotting entries that double-
  count the bank. Use whenever the user wants to import, reconcile, repair or audit a
  BLOM statement in Odoo — "do the BLOM month-end", "reconcile Blom USD", "reconcile the
  POS / sales vouchers", "why doesn't the bank agree", "the difference is deposited in
  the other account", "add Jan/Feb/March". Presentail-specific; Odoo via the Make MCP.
---

# BLOM Bank → Odoo

BLOM Bank Lebanon is not reachable by **any** Odoo-supported bank-sync aggregator
(Salt Edge, Ponto, Plaid, Yodlee, Enable Banking, Basiq). Lebanon sits outside PSD2
with no domestic open-banking mandate. File import is the only path.

**eBLOM export → `blom2odoo.py` → statement in Odoo → reconciliation models.**
Odoo owns the ledger, the dedupe and the classification. Nothing outside Odoo
decides what a transaction means.

Read `references/odoo_ids.md` before touching anything — it has every verified ID
and the non-obvious mechanics of driving Odoo through the Make probe.

## Monthly run

**1. Convert.**

```bash
python3 scripts/blom2odoo.py <export.csv|.xls|.xlsx> --account USD|LBP|POS
# combined multi-month export? slice it:
python3 scripts/blom2odoo.py q1.csv --account USD --from 2026-03-01 --to 2026-03-31 --label mar
```

Emits `.ofx`, `.xlsx` and `.json`. **Read the JSON first** — you need
`opening_balance` and `closing_balance`, and `integrity_problems` must be empty.

The converter refuses to write a file that doesn't foot: it recomputes the running
balance against BLOM's own balance column row by row and exits 2 naming the first
break. If it refuses, go back to the bank rather than reaching for `--force`.

**2. Check the chain.** The new month's `opening_balance` must equal the previous
month's `closing_balance`. If it doesn't, a month is missing — fill gaps oldest
first, or the statement chain will never validate.

**3. Check for collisions.** Zero draft `account.move` on the journal for the
period, and no existing statement lines in the date range. If either is non-empty,
you are in repair territory — go to the section below.

**4. Import.** Either drag the `.ofx` onto the journal, or `create` an
`account.bank.statement` with the balances and `line_ids` inline (payload shape in
`references/odoo_ids.md`). Either way **set `balance_start` and
`balance_end_real`** — they are what make "Invalid Statement(s)" mean anything.

**5. Verify.** Every statement must come back `is_valid = true` and
`is_complete = true`. That is the proof the month footed, not a formality.

**6. Classify.**

```bash
python3 scripts/recon_models.py apr.xlsx may.xlsx jun.xlsx
```

Lists which model claims each transaction and, critically, anything
**UNCLASSIFIED** — meaning a new BLOM description has appeared and the rule set
needs extending. That is a signal, not an error to suppress.

## Repair mode

When a journal has already drifted, **never delete and re-import.** Existing lines
are usually already reconciled, and that matching work is expensive to recreate.
Compare first:

```bash
python3 scripts/compare_odoo.py --bank jan.xlsx feb.xlsx mar.xlsx \
                                --odoo odoo_lines.csv --out comparison.xlsx
```

It matches on description + amount, ignoring date (ad-hoc imports often map value
date instead of business date), respects multiplicity, and produces a tab each for
Missing, Extra, Date mismatches and Matched. The repair is then surgical: delete the
extras, import the missing, leave everything else alone.

To regroup lines into proper monthly statements: create the statements with correct
balances, then `write` `statement_id` on the existing lines in bulk. Odoo removes a
statement automatically once its last line leaves, so old broken statements clean
themselves up.

If a statement shows `is_complete = false` while its balances plainly tie, the flag
is stale — write `balance_end_real` to a different value and back to force the
recompute.

Odoo only auto-deletes a statement when its last line *leaves*. Statements that were
created empty, or emptied by a bulk `statement_id` rewrite, survive — and an empty
statement carrying a non-zero `balance_end_real` fails `is_valid` forever, which is
usually the whole "Invalid Statement(s)" banner. Check for line-less statements
before hunting for a real imbalance; `unlink` them and the banner clears.

## The POS settlement chain

Journal **46 Blom Bank POS USD** is a **zero-balance sweep account** — every
statement runs 0.00 → 0.00. One card sale produces **four** lines across two
journals, and the deposit that lands in Business Plus is the **net**, so the two
journals only agree after the commission is added back:

| # | journal | line | booking |
|---|---|---|---|
| 1 | 46 | `SALE VISA` **+30.00** | Dr 1918 / Cr AR — match to the sales invoice |
| 2 | 46 | `COMMISSION` **−0.72** | Dr 515 / Cr 1918 — model 79/80 territory |
| 3 | 46 | `SALE VISA` **−30.00** | Cr 1918 / Dr **603** — the sweep out |
| 4 | 46 | `COMMISSION` **+0.72** | Dr 1918 / Cr **603** — commission rebated on sweep |
| 5 | 23 | `SALES VOUCHERS 1260625` **+29.28** | Dr 1903 / Cr **603** — the net deposit |

Lines 3 + 4 + 5 sum to **exactly zero on 603 Liquidity Transfer**. That is the test:
repoint all three suspense legs to 603 and the transfer proves itself.

**Never send `SALES VOUCHERS` to 1918.** 1918 *is* journal 46's own bank account, so
booking the deposit against it credits 1918 a second time — journal 46 already
credited it on line 3. Reconciliation model **85 still points at 1918** and will
recreate this every import; it is Manual, so it only bites when someone clicks it.
Measured 30 Jul 2026: Apr + May had been auto-matched that way, putting
**−1,110.77** on 1918 from journal 23 and leaving the journal 46 sweeps stranded.

### Running it

1. **Pull both sides** (the domains that isolate them):
   - sweeps — journal 46, `is_reconciled = false`, and either
     `payment_ref like 'SALE '` with `amount < 0`, or `payment_ref = 'COMMISSION'`
     with `amount > 0`. The trailing space in `'SALE '` matters: it excludes
     `SALES VOUCHERS`.
   - deposits — journal 23, `is_reconciled = false`,
     `payment_ref like 'SALES VOUCHERS'`.
2. **Prove the month before writing.**

   ```bash
   python3 scripts/pos_pair.py --sweeps sweeps_dump.txt --deposits deposits_dump.txt --detail
   ```

   Both inputs are saved `data-store-records_list` dumps;
   `scripts/probe_parse.py` turns the probe's `t1`/`t2` pipe strings back into rows
   and is reusable for any probe query. `pos_pair.py` pairs each sale with its
   commission, shows `gross − fee = net`, and exits non-zero unless every month sums
   to zero — so you can gate the write on it. A month that doesn't tie means either
   the deposits were already booked (check 1918 and 603 by journal) or a card sale is
   missing from one feed. **Several sweeps can be swept as one deposit** — 4 Jun 2026
   combined 58.05 + 19.52 into a single 77.57, so a per-month total is the real test,
   not a 1:1 count.
3. **Repoint the suspense legs**, don't build journal entries. Fetch them with
   `account.move.line` on `account_id = 379` filtered by
   `statement_line_id.payment_ref`, then one bulk
   `write [[ids…],{"account_id":603}]`. Odoo flips `is_reconciled` to true by itself
   once nothing of the line remains in suspense. Chunk the ids ~60 at a time —
   `--chunks` prints the batches ready to paste.

   Months whose deposits were already matched to **1918** by model 85 are repaired the
   same way: repoint those existing `POS Blom USD settlement` lines from 1918 to 603.
   The write works on posted, already-reconciled lines.
4. **Pilot one transfer first** — three lines, verify `is_reconciled`, then bulk.
5. **Verify**: 603 nets 0.00, journal 23 contributes 0.00 to 1918, and every journal
   46 statement is `is_valid` and `is_complete`.

Commission is **2.4% on Visa and 3.25% on Mastercard**, so don't use a single rate to
infer a pairing — pair on adjacency and confirm with the deposit arithmetic.

What is left open on journal 46 after this is the **revenue** side: unmatched positive
`SALE VISA` / `SALE MASTERCARD` lines and `DCC MERCHANT INCENTIVE`, which need sales
invoices, not a transfer. Keep the two jobs separate.

## Watch for double-counting

The most damaging failure mode is not a missing transaction, it is the same
transaction recorded twice: once as a statement line, once as a manual journal
entry someone keyed from the same statement.

Symptom: the journal's bank account carries far more movement than the bank did.
Diagnosis: `read_group` posted `account.move.line` on the bank account, grouped by
`journal_id`. Anything on a *cash* or *general* journal is suspect — bank movements
belong on the bank journal.

Found in July 2026: **$58,000** through journal 43 (CASH USD) and **$2,465.49**
through journal 17 (Cash Basis Taxes), all duplicating statement lines. The fix is
**reversal, not reclassification** — and read both legs of every move first, because
a journal that busy touches dozens of accounts and a blind reversal moves balances
nobody intended.

## Traps this skill exists to avoid

- **The "Pending Transactions" table.** eBLOM appends one with the same column
  shape as the statement — a date in column 0, an amount in column 3. A naive
  parser swallows those as real transactions. `blom2odoo.py` truncates at the
  marker; without it, April 2026 picks up a phantom −220.00.
- **`Brought Forward Balance: USD 16.00 D`** — the trailing `D` means debit, so the
  opening balance is **negative**. `C` means positive.
- **Rule ordering.** ATM cash fees must sit above ATM cash movements, and the
  deposit arm must be narrow (`^ATM CASH DEP\S*\s.*COMM`) or a loose
  `^ATM CASH DEP` swallows the cash deposit into fees.
- **Never auto-classify `IPO/`.** Mixed shareholder funding, customer receipts and
  deposit refunds. A blanket rule once pushed $95,000 into the P&L.
- **Never hard-code an FX rate.** The retired Make scenarios had 89,500 baked into
  six places. Use Odoo's currency table.
- **Don't scope a shared reconciliation model to a new journal** just to reuse it.
  Model 52 was shared with the LBP journal; switching it to Automated blew up on a
  pre-existing broken entry there. Create a BLOM-only model instead.

## Worth asking once a year

Ask BLOM corporate cash management whether they can deliver **CAMT.053** or
**MT940** by SFTP or scheduled email. CAMT.053 imports natively with no mapping and
would make step 1 unnecessary.
