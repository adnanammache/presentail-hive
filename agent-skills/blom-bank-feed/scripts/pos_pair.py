#!/usr/bin/env python3
"""Prove the BLOM POS settlement chain before writing anything to Odoo.

One card sale on journal 46 (Blom Bank POS USD) produces a sweep-out line and a
COMMISSION rebate; the *net* lands on journal 23 as a SALES VOUCHERS deposit. This
script pairs the two sides and refuses to bless a month that does not tie.

    python3 pos_pair.py --sweeps sweeps_dump.txt --deposits deposits_dump.txt

Both inputs are saved `data-store-records_list` dumps from probe scenario 6727612.
Query them like this (see references/odoo_ids.md for the mechanics):

  sweeps    account.bank.statement.line, journal_id=46, is_reconciled=false, and
            either payment_ref like 'SALE ' with amount<0, or
            payment_ref='COMMISSION' with amount>0
  deposits  account.bank.statement.line, journal_id=23, is_reconciled=false,
            payment_ref like 'SALES VOUCHERS'

Feed it the *suspense leg* dumps instead (account_id=379, same filters via
statement_line_id.*) and add --chunks to get write-ready id batches:

    python3 pos_pair.py --sweeps legs46.txt --deposits legs23.txt --chunks

Exit status is 1 if any month fails to tie, so it is safe to gate a write on it.
"""

import argparse
import collections
import json
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from probe_parse import DEFAULT_KEY, parse_dump  # noqa: E402

CENT = 0.005
CHUNK = 60


def month_of(row):
    return str(row.get("date", ""))[:7]


def totals_by_month(rows, field="amount"):
    out = collections.defaultdict(float)
    for r in rows:
        out[month_of(r)] += r.get(field, 0) or 0
    return out


def pair_sweeps(rows):
    """Group journal 46 lines into (sale, commission) settlements.

    BLOM emits the sale immediately followed by its commission, so pair on
    adjacency. Do NOT infer pairs from a rate: commission is 2.4% on Visa but
    3.25% on Mastercard, and a lone rate test mismatches them.
    """
    rows = sorted(rows, key=lambda r: (str(r.get("date", "")), r.get("id", 0)))
    settlements, pending = [], None
    for r in rows:
        ref = str(r.get("payment_ref", ""))
        if ref.startswith("SALE ") and (r.get("amount") or 0) < 0:
            if pending is not None:
                settlements.append((pending, None))
            pending = r
        elif ref == "COMMISSION" and (r.get("amount") or 0) > 0:
            settlements.append((pending, r))
            pending = None
        else:
            settlements.append((r, None))
    if pending is not None:
        settlements.append((pending, None))
    return settlements


def describe(settlements):
    lines = []
    for sale, comm in settlements:
        gross = abs(sale.get("amount", 0) or 0) if sale else 0
        fee = (comm.get("amount", 0) or 0) if comm else 0
        net = gross - fee
        date = (sale or comm).get("date", "?")
        ref = (sale or comm).get("payment_ref", "?")
        flag = "" if comm else "   <-- no COMMISSION rebate found"
        lines.append(f"  {date}  {ref:<16} {gross:>9.2f} - {fee:>6.2f} = {net:>9.2f}{flag}")
    return lines


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--sweeps", required=True, help="probe dump of journal 46 sweep lines/legs")
    ap.add_argument("--deposits", required=True, help="probe dump of journal 23 SALES VOUCHERS lines/legs")
    ap.add_argument("--key", default=DEFAULT_KEY, help="data store key (default %(default)s)")
    ap.add_argument("--field", default="amount", help="amount field: 'amount' for statement lines, 'amount_currency' for move lines")
    ap.add_argument("--detail", action="store_true", help="print every settlement")
    ap.add_argument("--chunks", action="store_true", help="emit id batches for the account_id=603 write")
    ap.add_argument("--account", type=int, default=603, help="clearing account id (default %(default)s)")
    args = ap.parse_args()

    sweeps = parse_dump(args.sweeps, key=args.key)
    deposits = parse_dump(args.deposits, key=args.key)
    field = args.field
    if sweeps and field not in sweeps[0]:
        field = "amount_currency" if "amount_currency" in sweeps[0] else field
        print(f"note: using field {field!r}", file=sys.stderr)

    sw = totals_by_month(sweeps, field)
    dp = totals_by_month(deposits, field)

    print(f"journal 46 sweeps   {len(sweeps):>4} lines")
    print(f"journal 23 deposits {len(deposits):>4} lines\n")
    print("month      POS sweeps    deposits        diff   status")
    failed = []
    for m in sorted(set(sw) | set(dp)):
        a, b = sw.get(m, 0.0), dp.get(m, 0.0)
        # The two sides always carry opposite signs — money out of the POS account,
        # money into Business Plus — whether you feed statement lines or their
        # suspense legs. So a clean month sums to zero.
        diff = a + b
        ok = abs(diff) < CENT
        if ok:
            diff = 0.0  # avoid printing -0.00 from float noise
        if not ok:
            failed.append(m)
        print(f"{m}  {a:>12.2f} {b:>11.2f} {diff:>11.2f}   {'ok' if ok else 'MISMATCH'}")

    total_sw = sum(sw.values())
    total_dp = sum(dp.values())
    print(f"\ntotal      {total_sw:>12.2f} {total_dp:>11.2f}")

    if args.detail:
        print("\nsettlements (gross - commission = net deposit expected):")
        for line in describe(pair_sweeps(sweeps)):
            print(line)

    if failed:
        print(
            "\nMISMATCH on: " + ", ".join(failed) + "\nDo not write yet. Either the deposits for that month are already booked\n"
            "(check accounts 1918 and 603 by journal), or a card sale is missing from\n"
            "one of the two feeds. Remember several sweeps can be swept as ONE deposit,\n"
            "so a per-month total that ties is the real test, not a 1:1 count.",
            file=sys.stderr,
        )
        return 1

    print("\nAll months tie. Both sides clear through the transfer account.")

    if args.chunks:
        ids = [int(r["id"]) for r in sweeps + deposits if "id" in r]
        print(f"\n{len(ids)} lines to repoint to account {args.account}.")
        print("Pilot ONE settlement first (3 lines), confirm is_reconciled, then bulk.")
        print("entity=account.move.line  action=write")
        for i in range(0, len(ids), CHUNK):
            batch = ids[i : i + CHUNK]
            params = json.dumps([batch, {"account_id": args.account}], separators=(",", ":"))
            print(f"\n-- batch {i // CHUNK + 1} ({len(batch)} ids)\nparams={params}")
        print("\nA write returns 'true', which the probe reports as an error. That is success.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
