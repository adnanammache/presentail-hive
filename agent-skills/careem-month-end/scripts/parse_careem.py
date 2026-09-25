#!/usr/bin/env python3
"""Parse Careem monthly tax-invoice PDFs into structured JSON.

Usage:
    python parse_careem.py <folder-with-pdfs>  > parsed.json

Emits a JSON list, one object per invoice, with the fields the poster needs:
merchant_ref (store number), invoice_id, invoice_date, period, gross_sales
(Total Gross Amount -> cash invoice), fees_excl_vat (Total Excl VAT -> bill net),
fees_incl_vat, and the fee line items. Requires `pdftotext` (poppler-utils).
"""
import sys, os, re, glob, json, subprocess

def money(s):
    return float(s.replace('AED', '').replace(',', '').strip())

def parse_pdf(path):
    txt = subprocess.run(["pdftotext", "-layout", path, "-"],
                         capture_output=True, text=True).stdout
    def grab(pat):
        m = re.search(pat, txt)
        return m.group(1).strip() if m else None
    items = re.findall(
        r'([A-Za-z][A-Za-z \+]+?)\s+1\s+([\d,\.]+) AED\s+([\d,\.]+) AED\s+'
        r'5\.00%\s+([\d,\.]+) AED\s+([\d,\.]+) AED', txt)
    return {
        'file': os.path.basename(path),
        'invoice_id': grab(r'Invoice ID:\s*(\d+)'),
        'invoice_date': grab(r'Invoice Date:\s*([0-9A-Za-z ]+?)\s{2,}'),
        'period': grab(r'Invoice Period:\s*([0-9A-Za-z \-]+?)\s{2,}'),
        'merchant_ref': (grab(r'Client Reference:\s*(\S+)') or '').split('-')[-1],
        'orders': grab(r'Total Number Of Orders:\s*(\d+)'),
        'gross_sales': grab(r'Total Gross Amount:\s*([\d,\.]+)\s*AED'),
        'fees_excl_vat': grab(r'Total \(Excl\. VAT\)\s*([\d,\.]+)\s*AED'),
        'fees_vat': grab(r'Total Tax\s*([\d,\.]+)\s*AED'),
        'fees_incl_vat': grab(r'Grand Total \(Incl\.VAT\)\s*([\d,\.]+)\s*AED'),
        'line_items': [
            {'desc': re.sub(r'\s+', ' ', d).strip(), 'net': money(n),
             'vat': money(v), 'incl': money(t)}
            for d, u, n, v, t in items],
    }

def main():
    if len(sys.argv) < 2:
        sys.exit("usage: parse_careem.py <folder-with-pdfs>")
    folder = sys.argv[1]
    pdfs = sorted(glob.glob(os.path.join(folder, "*.pdf")))
    rows = [parse_pdf(p) for p in pdfs]
    rows = [r for r in rows if r['invoice_id']]  # keep only real Careem invoices
    json.dump(rows, sys.stdout, indent=2)

if __name__ == "__main__":
    main()
