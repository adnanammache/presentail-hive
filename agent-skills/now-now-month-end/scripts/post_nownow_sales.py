#!/usr/bin/env python3
"""Post Now Now sales invoices — one per delivered order, from the EX*.xlsx files.

Usage:
    python post_nownow_sales.py --dir <xlsx-dir> [--dry-run] [--limit N]

Now Now is sales-only. Each spreadsheet is order-line level; this groups delivered
lines by order_nr and posts one PAID simplified invoice per order (summed
discounted_price, VAT 5% inclusive, place of supply DUBAI, booked to Now Now Revenue,
paid through the Now Now Transactions clearing account). Dedups on order_nr — safe to
re-run. Key: $WAFEQ_API_KEY or ./wafeq_key.txt. Needs openpyxl. ALWAYS --dry-run first.
"""
import argparse, glob, json, os, sys, uuid, urllib.request, urllib.error
import openpyxl
B="https://api.wafeq.com/v1"
NN_REV="acc_bbDvRzNEpmi6E7ZH8UhTRJ"     # Now Now Revenue
NN_CLR="acc_RArGUFjKUjdfkm8qAERawg"     # Now Now Transactions
VAT_SALES="tax_WAss52jmQnUvyH8UTCyRYe"  # 5% VAT on Sales

def load_key():
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
PREFIX=[('FLWRBG','Flower Bag'),('FLWRSC','Flower Scent'),('MNBLMS','Mini Blooms'),
        ('PLLNFL','Pollen Flowers'),('PNRSFL','Presentail'),('PRSNTL','Presentail'),
        ('SNGLFL','Single Flower'),('THSNGL','Single Flower')]
def brand(c):
    for p,b in PREFIX:
        if str(c).startswith(p): return b
    return str(c)

def load_orders(folder):
    orders={}
    for f in sorted(glob.glob(os.path.join(folder,'*.xlsx'))):
        ws=openpyxl.load_workbook(f,data_only=True).active
        rows=list(ws.iter_rows(values_only=True)); hdr=rows[0]; idx={h:i for i,h in enumerate(hdr)}
        for r in rows[1:]:
            if r[idx['order_nr']] is None: continue
            if str(r[idx['order_status_code']]).lower()!='delivered': continue
            amt=float(r[idx['discounted_price']] or 0)
            if amt==0: continue
            onr=str(r[idx['order_nr']])
            o=orders.setdefault(onr,{'order_nr':onr,'amount':0.0,'brand':brand(r[idx['store_code']]),
                                     'date':str(r[idx['order_date']])[:10],'statement':str(r[idx['statement_nr']] or '')})
            o['amount']+=amt
    return list(orders.values())

ap=argparse.ArgumentParser()
ap.add_argument("--dir",required=True); ap.add_argument("--dry-run",action="store_true"); ap.add_argument("--limit",type=int)
a=ap.parse_args()
orders=load_orders(a.dir)
existing={si['invoice_number'] for si in paginate("/simplified-invoices/?limit=200")}
done=0
print(f"{'Order':<20}{'Brand':<16}{'Amount':>10}  status")
for o in orders:
    if a.limit and done>=a.limit: break
    if o['order_nr'] in existing:
        print(f"{o['order_nr']:<20}{o['brand']:<16}{o['amount']:>10,.2f}  exists (skip)"); continue
    if a.dry_run:
        print(f"{o['order_nr']:<20}{o['brand']:<16}{o['amount']:>10,.2f}  would create"); done+=1; continue
    payload={"invoice_number":o['order_nr'],"invoice_date":o['date'],"currency":"AED","place_of_supply":"DUBAI",
             "tax_amount_type":"TAX_INCLUSIVE","status":"PAID","paid_through_account":NN_CLR,"reference":o['statement'],
             "line_items":[{"account":NN_REV,"description":o['brand'],"quantity":1,"unit_amount":round(o['amount'],2),"tax_rate":VAT_SALES}]}
    res,err=api("/simplified-invoices/","POST",payload,idem=True)
    print(f"{o['order_nr']:<20}{o['brand']:<16}{o['amount']:>10,.2f}  {'FAIL '+err if err else res['status']}")
    done+=1
print(f"\n{len(orders)} distinct delivered orders")
