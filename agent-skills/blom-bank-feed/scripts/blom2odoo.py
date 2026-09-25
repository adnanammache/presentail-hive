#!/usr/bin/env python3
"""
blom2odoo.py - Convert a raw eBLOM statement export into files Odoo can import.

Usage:
    python3 blom2odoo.py <input.csv|input.xls|input.xlsx> --account USD [--out-dir .]

Produces, next to the input file:
    <stem>.ofx   -> primary import file for Odoo (native dedupe via FITID)
    <stem>.xlsx  -> fallback import file for Odoo (dedupe via External ID)
    <stem>.json  -> machine-readable summary (balances, counts, integrity check)

Design notes
------------
* eBLOM exports carry a title row, a blank row, a "Brought Forward Balance" row,
  a blank row, and only THEN the real header. We locate the header by content,
  never by position, so the layout can shift without breaking the parser.
* "Brought Forward Balance: USD 16.00 D" -> D means the account is in debit,
  i.e. the opening balance is NEGATIVE. Verified against the running balance
  column: -16.00 + 19.52 = 3.52, which matches row 1's balance exactly.
* FITID (the dedupe key Odoo stores in unique_import_id) is built from
  business date + amount + normalised description + an occurrence counter for
  that exact triplet. It deliberately does NOT include the running balance,
  so that a re-issued statement containing an extra earlier transaction does
  not shift every subsequent ID and duplicate the whole month.
* Every run asserts opening balance + sum(amounts) == closing balance from the
  bank's own final running-balance figure. If that fails, the file is refused.
"""

import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime
from decimal import Decimal, InvalidOperation

HEADER_TOKENS = ("business date", "value date", "description", "amount", "balance")

# Account profiles. Add a new BLOM account by adding an entry here.
ACCOUNTS = {
    "USD": {
        "label": "BLOM Business Plus USD",
        "acctid": "057-02-353-1695386-1-1",
        "currency": "USD",
        "odoo_journal_hint": "Blom Bank USD - Business Plus (journal 23)",
    },
    "LBP": {
        "label": "BLOM LBP",
        "acctid": "057-01-353-1695386-1-2",
        "currency": "LBP",
        "odoo_journal_hint": "Blom LBP (journal 47)",
    },
    "POS": {
        "label": "BLOM POS USD",
        "acctid": "057-02-860-1695386-1-5",
        "currency": "USD",
        "odoo_journal_hint": "POS Blom USD (journal 17)",
    },
}


def dec(raw):
    """Parse '-2,000.00' / '1,109.14' / '' into Decimal. Returns None if not a number."""
    if raw is None:
        return None
    s = str(raw).strip().replace(",", "").replace(" ", "")
    if s in ("", "-", "nan", "None"):
        return None
    neg = False
    if s.startswith("(") and s.endswith(")"):
        neg, s = True, s[1:-1]
    try:
        v = Decimal(s)
    except InvalidOperation:
        return None
    return -v if neg else v


def parse_date(raw):
    """eBLOM uses DD/MM/YYYY. Also tolerate DD-MM-YYYY and real date objects."""
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return raw.date()
    s = str(raw).strip()
    if not s:
        return None
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%Y-%m-%d", "%d %b %Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def read_rows(path):
    """Return a list of raw cell-lists, from CSV or XLS/XLSX, preserving order."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xls", ".xlsx", ".xlsm"):
        import pandas as pd

        engine = "xlrd" if ext == ".xls" else "openpyxl"
        df = pd.read_excel(path, header=None, dtype=object, engine=engine)
        return [
            ["" if (v is None or (isinstance(v, float) and v != v)) else v for v in row]
            for row in df.itertuples(index=False, name=None)
        ]
    # CSV: utf-8-sig strips the BOM eBLOM emits. newline='' keeps quoted
    # multi-line "Details" cells intact instead of splitting them into rows.
    with open(path, "r", encoding="utf-8-sig", newline="") as fh:
        return [row for row in csv.reader(fh)]


def truncate_at_pending(rows):
    """eBLOM appends a 'Pending Transactions' table with its own header
    (Business Date, Description, Merchant Name, Amount). Its rows have a date in
    column 0 and an amount in column 3, so a naive parser silently swallows them
    as real transactions -- they are NOT on the statement and must be dropped.
    Everything from that marker onward is cut."""
    for i, row in enumerate(rows):
        joined = " ".join(str(c) for c in row).lower()
        if "pending transactions" in joined:
            return rows[:i]
    return rows


def find_header(rows):
    for i, row in enumerate(rows):
        joined = " ".join(str(c).strip().lower() for c in row)
        if sum(tok in joined for tok in HEADER_TOKENS) >= 4:
            cols = {}
            for j, c in enumerate(row):
                key = str(c).strip().lower().rstrip(".")
                if key:
                    cols[key] = j
            return i, cols
    raise SystemExit("ERROR: could not locate the statement header row. Is this an eBLOM export?")


def find_opening_balance(rows, upto):
    """Read 'Brought Forward Balance: USD 16.00 D'. D (debit) => negative."""
    pat = re.compile(
        r"brought\s+forward\s+balance\s*:?\s*([A-Z]{3})?\s*([\d,]+\.?\d*)\s*([DC])?",
        re.I,
    )
    for row in rows[:upto]:
        for cell in row:
            m = pat.search(str(cell))
            if m:
                amt = dec(m.group(2))
                if amt is None:
                    continue
                if (m.group(3) or "").upper() == "D":
                    amt = -amt
                return amt
    return None


def normalise_desc(s):
    return re.sub(r"\s+", " ", str(s or "").strip()).upper()


def build_transactions(rows, header_idx, cols, acct_key):
    def col(*names):
        for n in names:
            if n in cols:
                return cols[n]
        return None

    c_bdate = col("business date", "date")
    c_vdate = col("value date")
    c_desc = col("description", "details of transaction")
    c_amt = col("amount")
    c_bal = col("balance")
    c_ref = col("transaction ref", "transaction reference", "ref")
    c_det = col("details")

    if None in (c_bdate, c_desc, c_amt):
        raise SystemExit(f"ERROR: missing a required column. Found: {sorted(cols)}")

    txns, seen = [], Counter()
    for row in rows[header_idx + 1 :]:
        def cell(idx):
            return row[idx] if idx is not None and idx < len(row) else ""

        bdate = parse_date(cell(c_bdate))
        amt = dec(cell(c_amt))
        # A real transaction needs both a parseable date and a parseable amount.
        # This is what silently skips the trailing legal disclaimer and the
        # Arabic footer, without hard-coding "delete the last N rows".
        if bdate is None or amt is None:
            continue

        desc = normalise_desc(cell(c_desc))
        vdate = parse_date(cell(c_vdate)) or bdate
        bal = dec(cell(c_bal))
        ref = str(cell(c_ref) or "").strip()
        detail = re.sub(r"\s+", " ", str(cell(c_det) or "")).strip()

        # Stable dedupe key: date + amount + description + occurrence index.
        base = f"{acct_key}|{bdate.isoformat()}|{amt}|{desc}"
        seen[base] += 1
        fitid = f"{bdate:%Y%m%d}{hashlib.sha1(base.encode()).hexdigest()[:10]}{seen[base]:02d}"

        txns.append(
            {
                "fitid": fitid,
                "date": bdate,
                "value_date": vdate,
                "desc": desc,
                "amount": amt,
                "balance": bal,
                "ref": ref,
                "detail": detail,
            }
        )
    return txns


def verify(txns, opening):
    """The bank's own running balance is the audit trail. Recompute against it."""
    problems = []
    if opening is None:
        problems.append("No 'Brought Forward Balance' row found; opening balance unknown.")
        return problems, None

    running = opening
    for t in txns:
        running += t["amount"]
        if t["balance"] is not None and running != t["balance"]:
            problems.append(
                f"Running balance breaks at {t['date']:%d/%m/%Y} '{t['desc'][:40]}': "
                f"computed {running}, statement says {t['balance']}"
            )
            running = t["balance"]  # resync so we report each break once
    closing = txns[-1]["balance"] if txns and txns[-1]["balance"] is not None else running
    return problems, closing


def esc(s):
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .strip()
    )


def write_ofx(path, txns, opening, closing, profile):
    """OFX 1.0.2 / SGML - the dialect Odoo's ofxparse-based importer expects."""
    d0 = min(t["date"] for t in txns)
    d1 = max(t["date"] for t in txns)
    now = f"{d1:%Y%m%d}120000"
    out = io.StringIO()
    out.write(
        "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\n"
        "ENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\n"
        "OLDFILEUID:NONE\nNEWFILEUID:NONE\n\n"
    )
    out.write("<OFX>\n<SIGNONMSGSRSV1><SONRS>\n")
    out.write(f"<STATUS><CODE>0<SEVERITY>INFO</STATUS>\n<DTSERVER>{now}\n<LANGUAGE>ENG\n")
    out.write("<FI><ORG>BLOM BANK SAL<FID>BLOMLBBX</FI>\n</SONRS></SIGNONMSGSRSV1>\n")
    out.write("<BANKMSGSRSV1><STMTTRNRS>\n<TRNUID>1\n")
    out.write("<STATUS><CODE>0<SEVERITY>INFO</STATUS>\n<STMTRS>\n")
    out.write(f"<CURDEF>{profile['currency']}\n")
    out.write(f"<BANKACCTFROM><BANKID>BLOMLBBX<ACCTID>{profile['acctid']}<ACCTTYPE>CHECKING</BANKACCTFROM>\n")
    out.write(f"<BANKTRANLIST>\n<DTSTART>{d0:%Y%m%d}\n<DTEND>{d1:%Y%m%d}\n")
    for t in txns:
        ttype = "CREDIT" if t["amount"] > 0 else "DEBIT"
        name = esc(t["desc"])[:32]
        out.write("<STMTTRN>\n")
        out.write(f"<TRNTYPE>{ttype}\n<DTPOSTED>{t['date']:%Y%m%d}\n")
        out.write(f"<TRNAMT>{t['amount']}\n<FITID>{t['fitid']}\n")
        out.write(f"<NAME>{name}\n")
        memo = " | ".join(x for x in (esc(t["desc"]), esc(t["ref"]), esc(t["detail"])) if x)
        if memo:
            out.write(f"<MEMO>{memo[:255]}\n")
        out.write("</STMTTRN>\n")
    out.write("</BANKTRANLIST>\n")
    out.write(f"<LEDGERBAL><BALAMT>{closing}<DTASOF>{d1:%Y%m%d}</LEDGERBAL>\n")
    out.write("</STMTRS></STMTTRNRS></BANKMSGSRSV1>\n</OFX>\n")
    with open(path, "w", encoding="ascii", errors="replace") as fh:
        fh.write(out.getvalue())


def write_xlsx(path, txns, acct_key, profile):
    """Fallback import file. Header names are fixed so Odoo's saved
    base_import.mapping re-applies itself automatically next month."""
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Transactions"
    ws.append(["External ID", "Date", "Label", "Amount", "Reference", "Notes"])
    for t in txns:
        ws.append(
            [
                f"blom_{acct_key.lower()}.{t['fitid']}",
                t["date"].isoformat(),
                t["desc"],
                float(t["amount"]),
                t["ref"],
                t["detail"],
            ]
        )
    ws.freeze_panes = "A2"
    for col, w in zip("ABCDEF", (34, 12, 46, 14, 20, 60)):
        ws.column_dimensions[col].width = w
    wb.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--account", required=True, choices=sorted(ACCOUNTS))
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--from", dest="dfrom", default=None, help="keep rows on/after this business date (YYYY-MM-DD)")
    ap.add_argument("--to", dest="dto", default=None, help="keep rows on/before this business date (YYYY-MM-DD)")
    ap.add_argument("--label", default=None, help="override the output file stem")
    ap.add_argument("--force", action="store_true", help="write files even if integrity checks fail")
    args = ap.parse_args()

    profile = ACCOUNTS[args.account]
    rows = truncate_at_pending(read_rows(args.input))
    hidx, cols = find_header(rows)
    opening = find_opening_balance(rows, hidx)
    txns = build_transactions(rows, hidx, cols, args.account)
    if not txns:
        raise SystemExit("ERROR: no transactions parsed.")

    # Optional date slice, for combined multi-month exports. The opening balance
    # is re-derived from the bank's own running balance on the first kept row
    # (balance - amount), so a slice is just as self-verifying as a full file.
    if args.dfrom or args.dto:
        lo = datetime.strptime(args.dfrom, "%Y-%m-%d").date() if args.dfrom else None
        hi = datetime.strptime(args.dto, "%Y-%m-%d").date() if args.dto else None
        kept = [t for t in txns if (lo is None or t["date"] >= lo) and (hi is None or t["date"] <= hi)]
        if not kept:
            raise SystemExit("ERROR: date slice kept no transactions.")
        first = kept[0]
        if first["balance"] is None:
            raise SystemExit("ERROR: cannot derive an opening balance for the slice.")
        opening = first["balance"] - first["amount"]
        txns = kept

    problems, closing = verify(txns, opening)

    out_dir = args.out_dir or os.path.dirname(os.path.abspath(args.input))
    stem = os.path.join(out_dir, args.label or os.path.splitext(os.path.basename(args.input))[0])

    summary = {
        "account": args.account,
        "odoo_journal": profile["odoo_journal_hint"],
        "currency": profile["currency"],
        "period_start": min(t["date"] for t in txns).isoformat(),
        "period_end": max(t["date"] for t in txns).isoformat(),
        "transactions": len(txns),
        "opening_balance": str(opening),
        "closing_balance": str(closing),
        "sum_of_amounts": str(sum(t["amount"] for t in txns)),
        "integrity_problems": problems,
        "duplicate_fitids": [k for k, v in Counter(t["fitid"] for t in txns).items() if v > 1],
    }

    print(json.dumps(summary, indent=2))

    if problems and not args.force:
        print("\nREFUSING TO WRITE: fix the source file or re-run with --force.", file=sys.stderr)
        sys.exit(2)

    write_ofx(stem + ".ofx", txns, opening, closing, profile)
    write_xlsx(stem + ".xlsx", txns, args.account, profile)
    with open(stem + ".json", "w") as fh:
        json.dump(summary, fh, indent=2)
    print(f"\nWrote:\n  {stem}.ofx\n  {stem}.xlsx\n  {stem}.json")


if __name__ == "__main__":
    main()
