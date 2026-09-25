#!/usr/bin/env python3
"""Parse Talabat TUAE fee tax-invoice PDFs into structured JSON (one per PDF).

Usage:
    python parse_talabat.py <tuae-dir>  > talabat_parsed.json

Each object: invoice_nr, issue_date, due_date, restaurant, subtotal, and
line_items[] each {desc, key (account bucket), excl}. Handles negative lines
(Discount) and multi-line descriptions. Requires pdftotext.
"""
import sys, re, glob, os, subprocess, json
from datetime import datetime

def money(s): return float(s.replace(',', ''))
def iso(s):
    try: return datetime.strptime(s.strip(), "%d %b, %Y").strftime("%Y-%m-%d")
    except Exception: return None
def acct_key(desc):
    d = desc.lower()
    if 'subscription' in d: return 'subscription'
    if 'premium' in d or 'placement' in d: return 'premium_marketing'
    if 'sponsored' in d or 'boosted' in d: return 'marketing'
    return 'commission'   # commissions, payment charges, loyalty/pro-delivery, discount

def parse(path):
    txt = subprocess.run(["pdftotext","-layout",path,"-"],capture_output=True,text=True).stdout
    inv = re.search(r'Invoice Number\s+(TUAE-\d+)', txt)
    issue = re.search(r'Issue Date\s+([0-9]{1,2} [A-Za-z]+, \d{4})', txt)
    due = re.search(r'Due Date\s+([0-9]{1,2} [A-Za-z]+, \d{4})', txt)
    rest = re.search(r'Restaurant Name\s*:\s*(.+)', txt)
    sub = re.search(r'Subtotal\s+(-?[\d,]+\.\d+)', txt)
    lines = re.findall(r'\d+\.\s+(.+?)\s{2,}(-?[\d,]+\.\d+)\s+5\s+(-?[\d,]+\.\d+)\s+(-?[\d,]+\.\d+)', txt)
    items = [{'desc': re.sub(r'\s+',' ',d).strip(), 'key': acct_key(d), 'excl': money(s)}
             for d,s,v,t in lines]
    return {'file': os.path.basename(path), 'invoice_nr': inv.group(1) if inv else None,
            'issue_date': iso(issue.group(1)) if issue else None,
            'due_date': iso(due.group(1)) if due else None,
            'restaurant': rest.group(1).strip() if rest else '',
            'subtotal': money(sub.group(1)) if sub else None, 'line_items': items}

def main():
    if len(sys.argv) < 2: sys.exit("usage: parse_talabat.py <tuae-dir>")
    rows = [parse(p) for p in sorted(glob.glob(os.path.join(sys.argv[1], "TUAE-*.pdf")))]
    rows = [r for r in rows if r['invoice_nr']]
    json.dump(rows, sys.stdout, indent=2)

if __name__ == "__main__":
    main()
