#!/usr/bin/env python3
"""Post Talabat sales invoices — one per branch, from the Balance Summary PDFs.

Usage:
    python post_talabat_sales.py --balance-dir <dir> --period-end YYYY-MM-DD [--dry-run] [--only STORE]

Reads each BalanceSummary_<store>.pdf's "Branches balance summary" table and creates
one PAID simplified invoice per branch, using that branch's Earnings as the (VAT 5%
inclusive) sale amount, place of supply from the branch area, booked to Talabat
Revenue, paid through the Talabat Transactions clearing account, SINV numbering.
Dedups on (brand, place-of-supply, amount, date). Key: $WAFEQ_API_KEY or ./wafeq_key.txt.
"""
import argparse, glob, json, os, re, sys, uuid, subprocess, urllib.request, urllib.error
# Inside Hive, Wafeq is reached through Hive's gateway (/workspace/hive/wafeq.json): reads are live,
# writes are QUEUED until a person approves them in Hive. Elsewhere, straight to Wafeq with your own key.
def _hive_gateway():
    try: return json.load(open(os.environ.get("HIVE_WAFEQ_CONFIG","/workspace/hive/wafeq.json")))["base"].rstrip("/")
    except (OSError, ValueError, KeyError): return None
HIVE=_hive_gateway()
B=HIVE or "https://api.wafeq.com/v1"
if HIVE: print("Wafeq via Hive: reads are live; writes are QUEUED (shown with $s ids) until approved in Hive.", file=sys.stderr)
TAL_REV="acc_A9TZgvqqo7KmwXqx2pA9tr"    # Talabat Revenue
TAL_CLR="acc_DDapSPi55Qr8FyaYPQsXfn"    # Talabat Transactions
VAT_SALES="tax_WAss52jmQnUvyH8UTCyRYe"  # 5% VAT on Sales

def load_key():
    if HIVE: return "hive"  # Hive adds the key; the sandbox never sees it
    k=os.environ.get("WAFEQ_API_KEY")
    if not k and os.path.exists("wafeq_key.txt"): k=open("wafeq_key.txt").read().strip()
    if not k: sys.exit("No Wafeq API key ($WAFEQ_API_KEY or ./wafeq_key.txt)")
    return k
KEY=load_key()
def api(path,method="GET",data=None,idem=False):
    h={'Authorization':f'Api-Key {KEY}','Content-Type':'application/json'}
    if idem:h['X-Wafeq-Idempotency-Key']=str(uuid.uuid4())
    req=urllib.request.Request(B+path,headers=h,method=method)
    if data is not None:req.data=json.dumps(data).encode()
    try:return json.load(urllib.request.urlopen(req)),None
    except urllib.error.HTTPError as e:return None,f"HTTP {e.code}: {e.read().decode()[:200]}"
def paginate(path):
    out,url=[],B+path
    while url:
        d=json.load(urllib.request.urlopen(urllib.request.Request(url,headers={'Authorization':f'Api-Key {KEY}'})));out+=d['results'];url=d.get('next')
    return out
def parse_branches(pdf):
    txt=subprocess.run(["pdftotext","-layout",pdf,"-"],capture_output=True,text=True).stdout
    out=[]
    # Branch, ServiceType, NetBalance, Earnings, Expenses
    for m in re.finditer(r'([A-Za-z][A-Za-z ]+?),\s*(Al Barsha 1|Al Nahyan)\s+\w+\s+(-?[\d,]+\.\d+)\s+(-?[\d,]+\.\d+)\s+(-?[\d,]+\.\d+)', txt):
        brand=m.group(1).strip().title()
        pos='ABU_DHABI' if 'Nahyan' in m.group(2) else 'DUBAI'
        out.append({'brand':brand,'pos':pos,'earnings':float(m.group(4).replace(',',''))})
    return out

ap=argparse.ArgumentParser()
ap.add_argument("--balance-dir",required=True); ap.add_argument("--period-end",required=True)
ap.add_argument("--dry-run",action="store_true"); ap.add_argument("--only")
a=ap.parse_args()
branches=[]
for f in sorted(glob.glob(os.path.join(a.balance_dir,"BalanceSummary_*.pdf"))):
    branches+=parse_branches(f)
existing=paginate("/simplified-invoices/?limit=200")
# Dedup on brand + place-of-supply + date, scoped to Talabat Revenue lines. Amount is
# left out on purpose: Wafeq's tax-inclusive rounding can shift the stored total by a
# cent, and scoping to TAL_REV avoids colliding with another platform's same-named invoice.
seen={(si['line_items'][0]['description'],si['place_of_supply'],si['invoice_date'])
      for si in existing if si['line_items'] and si['line_items'][0]['account']==TAL_REV}
nxt=max([int(m.group(1)) for si in existing for m in [re.match(r'SINV-0*(\d+)',si.get('invoice_number') or '')] if m] or [0])

print(f"{'Brand':<16}{'PoS':<11}{'Earnings':>10}  status")
for b in branches:
    if a.only and b['brand']!=a.only: continue
    k=(b['brand'],b['pos'],a.period_end)
    if k in seen: print(f"{b['brand']:<16}{b['pos']:<11}{b['earnings']:>10,.2f}  exists (skip)"); continue
    if a.dry_run: print(f"{b['brand']:<16}{b['pos']:<11}{b['earnings']:>10,.2f}  would create"); continue
    nxt+=1; num=f"SINV-{nxt:06d}"
    payload={"invoice_number":num,"invoice_date":a.period_end,"currency":"AED","place_of_supply":b['pos'],
             "tax_amount_type":"TAX_INCLUSIVE","status":"PAID","paid_through_account":TAL_CLR,
             "line_items":[{"account":TAL_REV,"description":b['brand'],"quantity":1,"unit_amount":b['earnings'],"tax_rate":VAT_SALES}]}
    res,err=api("/simplified-invoices/","POST",payload,idem=True)
    if err: nxt-=1; print(f"{b['brand']:<16} FAIL {err}")
    else: print(f"{b['brand']:<16}{b['pos']:<11}{b['earnings']:>10,.2f}  {res['status']} {res['invoice_number']}")
