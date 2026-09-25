#!/usr/bin/env python3
"""Parse Noon Food fee tax-invoice PDFs into structured JSON (one object per PDF).

Usage:
    python parse_noon.py <fee-pdf-dir>  > noon_parsed.json

Each object: invoice_nr, invoice_date, source (NOON_R_... statement), subtotal,
total, and line_items[] each {fee, category (marketing|commission), excl, vat, incl}.
Requires pdftotext (poppler-utils).
"""
import sys, re, glob, os, subprocess, json

def money(s): return float(s.replace(',', ''))

def parse(path):
    txt = subprocess.run(["pdftotext","-layout",path,"-"],capture_output=True,text=True).stdout
    inv = re.search(r'Invoice Nr\s+(\S+)', txt)
    date = re.search(r'Invoice\s+(\d{4}-\d{2}-\d{2})', txt)
    src = re.search(r'Source\s+(\S+)', txt)
    sub = re.search(r'Subtotal\s+(-?[\d,\.]+)\s+AED', txt)
    total = re.search(r'Total\s+(-?[\d,\.]+)\s+AED', txt)
    # each fee line: "<Fee type> fee for statement: ... <excl> 5.00% <vat> <incl>"
    items = re.findall(
        r'([A-Za-z][A-Za-z ]*?fee)\s+for statement:.*?\s+1\s+(-?[\d,\.]+)\s+5\.00%\s+(-?[\d,\.]+)\s+(-?[\d,\.]+)',
        txt, re.IGNORECASE)
    lines = []
    for fee, excl, vat, incl in items:
        fee = re.sub(r'\s+', ' ', fee).strip()
        cat = 'marketing' if 'marketing' in fee.lower() else 'commission'
        lines.append({'fee': fee, 'category': cat,
                      'excl': money(excl), 'vat': money(vat), 'incl': money(incl)})
    return {'file': os.path.basename(path),
            'invoice_nr': inv.group(1) if inv else None,
            'invoice_date': date.group(1) if date else None,
            'source': src.group(1) if src else None,
            'subtotal': money(sub.group(1)) if sub else None,
            'total': money(total.group(1)) if total else None,
            'line_items': lines}

def main():
    if len(sys.argv) < 2:
        sys.exit("usage: parse_noon.py <fee-pdf-dir>")
    rows = [parse(p) for p in sorted(glob.glob(os.path.join(sys.argv[1], "*.pdf")))]
    rows = [r for r in rows if r['invoice_nr']]
    json.dump(rows, sys.stdout, indent=2)

if __name__ == "__main__":
    main()
