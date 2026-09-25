#!/usr/bin/env python3
"""Parse Toters "Invoice-Report" fee-bill PDFs into structured JSON (one per PDF).

Usage:
    python parse_toters_fee_bills.py <pdf-dir>  > toters_fee_bills_parsed.json

Each PDF is a per-store monthly statement named
`Invoice-Report-(<Store>)-<Month>-<Year>.pdf`. It has two tables: an Activity
table (the VAT billing breakdown — NOT used here) and a "Balance Information"
table, which is the authoritative ledger of every fee/discount/settlement
movement for that store that month. This script reads Balance Information
only, maps its rows to the fixed set of Odoo fee-line accounts (see
references/odoo_ids.md for the account ids), and verifies
Opening Balance + all movements = Closing Balance for every invoice before
you trust the output enough to post it.

Requires `pdftotext` (poppler-utils). If pdftotext isn't available (e.g. a
scanned/image PDF with no text layer), fall back to reading a Google Drive
`search_files` OCR content-snippet dump instead — pass a JSON file of
`{"title": ..., "contentSnippet": ...}` objects with --snippets instead of a
PDF directory. This was how the original 99-bill historical catch-up was
done in bulk, since re-OCRing 99 PDFs one at a time is much slower than one
Drive search call.
"""
import sys, re, glob, os, subprocess, json, argparse

MONTHS = {'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04', 'May': '05', 'Jun': '06',
          'Jul': '07', 'Aug': '08', 'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'}


def num(s):
    if s is None:
        return 0.0
    s = s.replace(',', '').strip()
    if s in ('', '-', '?', 'NULL'):
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def parse_text(title, txt):
    m = re.search(r'-\((.+)\)-(\w+)-\d{4}', title)
    store = m.group(1) if m else None

    inv_m = re.search(r'Invoice\\?#\s*(\d+)', txt)
    invoice_number = inv_m.group(1) if inv_m else None

    date_m = re.search(r'Date:\s*(\w{3})\s+(\d{1,2}),\s*(\d{4})', txt)
    if date_m:
        mon, day, yr = date_m.groups()
        invoice_date = f'{yr}-{MONTHS.get(mon, "00")}-{int(day):02d}'
    else:
        invoice_date = None

    idx = txt.find('Balance Information')
    bal = {}
    if idx != -1:
        section = txt[idx:]
        for p in section.split('\n\n'):
            p = p.strip()
            if not p or p.startswith('Balance Information'):
                continue
            mm = re.match(r'^(.*?)\s+(-?[\d,]+\.?\d*)$', p)
            if mm:
                label, val = mm.group(1).strip(), num(mm.group(2))
                bal[label] = bal.get(label, 0.0) + val

    opening = bal.get('Opening Balance', 0.0)
    closing = bal.get('Closing Balance', 0.0)
    movement_sum = sum(v for k, v in bal.items() if k not in ('Opening Balance', 'Closing Balance'))
    recon_ok = abs((opening + movement_sum) - closing) < 1.0

    other_adv_m = re.search(r'Other Advertising[^\d\-]*(-?[\d,]+\.?\d*)\s*LBP', txt)
    other_marketing = num(other_adv_m.group(1)) if other_adv_m else 0.0

    return {
        'title': title,
        'store': store,
        'invoice_number': invoice_number,
        'invoice_date': invoice_date,
        # These field names match the LINE_ACCOUNTS mapping in odoo_ids.md —
        # keep them in sync if you add or rename a fee category.
        'DeliveryFeesLBP': abs(bal.get('Courier on Demand', 0.0)),
        'MarketplaceListingFeesLBP': abs(bal.get('Marketplace Listing Fee', 0.0)),
        'MarketingHighlightsLBP': abs(bal.get('Marketing Highlights', 0.0)),
        'OtherMarketingLBP': other_marketing,
        'MarketingFreeDeliveryLBP': abs(bal.get('Marketing Free Delivery', 0.0)),
        'MarketingPunchCardRewardsLBP': abs(bal.get('Marketing Punch Card Rewards', 0.0)),
        'MarketingImmediateDiscountLBP': abs(
            bal.get('Marketing Immediate Discount', 0.0)
            + bal.get('Marketing Item Discounts', 0.0)
            + bal.get('Marketing Item Discount', 0.0)
        ),
        'MarketingCreditNoteLBP': abs(bal.get('Marketing Credit note', 0.0)),
        'GrossMerchantRevenueLBP': abs(bal.get('Gross Merchant Revenue', 0.0)),
        'BeginningBalanceLBP': opening,
        'ClosingBalanceLBP': closing,
        'BalanceSettlementLBP': abs(bal.get('Balance Settlement', 0.0)),
        'CollectionsLBP': abs(bal.get('Collections', 0.0)),
        'recon_ok': recon_ok,
        'raw_balance': bal,
    }


def parse_pdf(path):
    txt = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, text=True).stdout
    return parse_text(os.path.basename(path), txt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf_dir', nargs='?', help='Directory of Invoice-Report-*.pdf files')
    ap.add_argument('--snippets', help='JSON file of [{"title":..., "contentSnippet":...}] '
                                        '(Drive search_files dump) instead of local PDFs')
    args = ap.parse_args()

    if args.snippets:
        items = json.load(open(args.snippets))
        rows = [parse_text(it['title'], it.get('contentSnippet', '')) for it in items]
    elif args.pdf_dir:
        paths = sorted(glob.glob(os.path.join(args.pdf_dir, "Invoice-Report-*.pdf")))
        rows = [parse_pdf(p) for p in paths]
    else:
        sys.exit("usage: parse_toters_fee_bills.py <pdf-dir> | --snippets <drive-dump.json>")

    errors = [r for r in rows if not r['invoice_number'] or not r['store'] or not r['invoice_date']]
    recon_fails = [r for r in rows if not r['recon_ok']]
    nums = [r['invoice_number'] for r in rows]
    dupes = len(nums) - len(set(nums))

    print(f"parsed {len(rows)}, missing core fields {len(errors)}, "
          f"recon failures {len(recon_fails)}, duplicate invoice numbers {dupes}", file=sys.stderr)
    for r in errors:
        print(f"  MISSING FIELD: {r['title']}", file=sys.stderr)
    for r in recon_fails:
        print(f"  RECON FAIL: {r['title']} (opening {r['BeginningBalanceLBP']}, "
              f"closing {r['ClosingBalanceLBP']})", file=sys.stderr)

    json.dump(rows, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
