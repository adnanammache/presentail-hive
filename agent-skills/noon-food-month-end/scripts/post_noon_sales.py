#!/usr/bin/env python3
"""Post Noon Food per-order sales invoices from the outlet statement CSVs.

Usage:
    python post_noon_sales.py --statements-dir <csv-dir> [--dry-run] [--only ORDER] [--limit N]

One PAID simplified invoice per order where rest_invoice != 0. place_of_supply from
the outlet-name suffix; amount = rest_invoice (VAT-inclusive); paid through the Noon
Food Transactions clearing account. Idempotent — dedups on order number, so if a run
is interrupted (hundreds of orders), just re-run to resume.
Key: $WAFEQ_API_KEY or ./wafeq_key.txt. ALWAYS --dry-run first.
"""
import argparse, csv, glob, json, os, sys, uuid, urllib.request, urllib.error
# Inside Hive, Wafeq is reached through Hive's gateway (/workspace/hive/wafeq.json): reads are live,
# writes are QUEUED until a person approves them in Hive. Elsewhere, straight to Wafeq with your own key.
def _hive_gateway():
    try: return json.load(open(os.environ.get("HIVE_WAFEQ_CONFIG","/workspace/hive/wafeq.json")))["base"].rstrip("/")
    except (OSError, ValueError, KeyError): return None
HIVE=_hive_gateway()
B=HIVE or "https://api.wafeq.com/v1"
if HIVE: print("Wafeq via Hive: reads are live; writes are QUEUED (shown with $s ids) until approved in Hive.", file=sys.stderr)
NOON_REV="acc_67dfwewVN6FPuDsYFpVHH7"    # Noon Food Revenue
CLR="acc_PM5ufMuhfZ6aYEUE34QpCK"         # Noon Food Transactions
VAT_SALES="tax_WAss52jmQnUvyH8UTCyRYe"   # 5% VAT on Sales

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
def brand(outlet):
    s=outlet
    for t in ['__abu_dhabi','__al_nahyan','__barsha']: s=s.replace(t,'')
    s=s.replace('the_','').replace('__',' ').replace('_',' ').strip()
    s=' '.join(w.capitalize() for w in s.split())
    return {'Blooms Balloons':'Blooms & Balloons','Pollen':'Pollen Flowers'}.get(s,s)

ap=argparse.ArgumentParser()
ap.add_argument("--statements-dir",required=True)
ap.add_argument("--dry-run",action="store_true"); ap.add_argument("--only"); ap.add_argument("--limit",type=int)
a=ap.parse_args()

orders=[]
for f in sorted(glob.glob(os.path.join(a.statements_dir,"*.csv"))):
    try: rows=list(csv.DictReader(open(f)))
    except Exception: continue
    for r in rows:
        if 'rest_invoice' not in r: continue
        amt=float(r['rest_invoice'] or 0)
        if amt==0: continue
        orders.append({'order_nr':r['order_nr'],'date':r['order_date'],'statement':r['statement_nr'],
                       'brand':brand(r['outlet_name']),
                       'pos':'ABU_DHABI' if 'abu_dhabi' in r['outlet_name'] else 'DUBAI','amount':amt})
existing={si['invoice_number'] for si in paginate("/simplified-invoices/?limit=200")}
done=0
for o in orders:
    if a.only and o['order_nr']!=a.only: continue
    if a.limit and done>=a.limit: break
    if o['order_nr'] in existing:
        print(f"{o['order_nr']:<18}{o['brand']:<20}{o['pos']:<10}{o['amount']:>9}  exists (skip)"); continue
    if a.dry_run:
        print(f"{o['order_nr']:<18}{o['brand']:<20}{o['pos']:<10}{o['amount']:>9}  would create"); done+=1; continue
    payload={"invoice_number":o['order_nr'],"invoice_date":o['date'],"currency":"AED","place_of_supply":o['pos'],
             "tax_amount_type":"TAX_INCLUSIVE","status":"PAID","paid_through_account":CLR,"reference":o['statement'],
             "line_items":[{"account":NOON_REV,"description":o['brand'],"quantity":1,"unit_amount":o['amount'],"tax_rate":VAT_SALES}]}
    res,err=api("/simplified-invoices/","POST",payload,idem=True)
    if err: print(f"{o['order_nr']:<18} FAIL {err}")
    else: print(f"{o['order_nr']:<18}{o['brand']:<20}{o['pos']:<10}{o['amount']:>9}  {res['status']}")
    done+=1
print(f"\nprocessed {done} (re-run to resume if interrupted; it dedups on order number)")
