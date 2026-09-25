#!/usr/bin/env python3
"""Post Noon Food fee invoices as itemized expense bills (marketing vs commission).

Usage:
    python post_noon.py --parsed noon_parsed.json --pdf-dir <fee-pdf-dir> [--dry-run]

One bill per PDF, fully itemized. Marketing lines -> Noon Food Marketing Expense;
all other fees -> Noon Food Commission. Authorizes and marks PAID through the Noon
Food Transactions clearing account. Dedups on bill number (Noon Invoice Nr).
Key: $WAFEQ_API_KEY or ./wafeq_key.txt. ALWAYS --dry-run first.
"""
import argparse, json, os, re, sys, uuid, subprocess, urllib.request, urllib.error
B="https://api.wafeq.com/v1"
NOON="co_MaAEikWqckWAKEE2xPbASY"
ACC_MKT="acc_fooAfBQbtCP9gJcd5PiZZ9"    # Noon Food Marketing Expense
ACC_COMM="acc_J5exitoi7i68E3d33utHB6"   # Noon Food Commission
CLR="acc_PM5ufMuhfZ6aYEUE34QpCK"        # Noon Food Transactions
VAT_PUR="tax_oEzW9XTqZWxJAUMSvaTSP9"    # 5% VAT on Purchases

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
    except urllib.error.HTTPError as e:return None,f"HTTP {e.code}: {e.read().decode()[:250]}"
def paginate(path):
    out,url=[],B+path
    while url:
        d=json.load(urllib.request.urlopen(urllib.request.Request(url,headers={'Authorization':f'Api-Key {KEY}'})));out+=d['results'];url=d.get('next')
    return out
def upload(path):
    return json.loads(subprocess.run(["curl","-sS","-H",f"Authorization: Api-Key {KEY}","-F",f"file=@{path};type=application/pdf",f"{B}/files/"],capture_output=True,text=True).stdout)["id"]

ap=argparse.ArgumentParser()
ap.add_argument("--parsed",required=True); ap.add_argument("--pdf-dir",required=True)
ap.add_argument("--dry-run",action="store_true"); ap.add_argument("--only")
a=ap.parse_args()
rows=json.load(open(a.parsed))
# map invoice_nr -> pdf path
fmap={}
for p in os.listdir(a.pdf_dir):
    if p.endswith(".pdf"):
        t=subprocess.run(["pdftotext","-layout",os.path.join(a.pdf_dir,p),"-"],capture_output=True,text=True).stdout
        m=re.search(r'Invoice Nr\s+(\S+)',t)
        if m: fmap[m.group(1)]=os.path.join(a.pdf_dir,p)
existing={b['bill_number'] for b in paginate(f"/bills/?contact={NOON}&limit=200")}

print(f"{'Invoice':<22}{'Date':<12}{'#L':>3}{'Mkt':>10}{'Comm':>11}{'Total':>10}  status")
for r in rows:
    inv=r['invoice_nr']
    if a.only and inv!=a.only: continue
    mkt=round(sum(li['excl'] for li in r['line_items'] if li['category']=='marketing'),2)
    comm=round(sum(li['excl'] for li in r['line_items'] if li['category']=='commission'),2)
    if inv in existing: st="exists (skip)"
    elif a.dry_run: st="WOULD CREATE"
    else:
        att=upload(fmap[inv])
        lines=[{"account":(ACC_MKT if li['category']=='marketing' else ACC_COMM),
                "description":li['fee'],"quantity":1,"unit_amount":li['excl'],"tax_rate":VAT_PUR}
               for li in r['line_items']]
        payload={"contact":NOON,"bill_number":inv,"bill_date":r['invoice_date'],"bill_due_date":r['invoice_date'],
                 "currency":"AED","tax_amount_type":"TAX_EXCLUSIVE","status":"DRAFT",
                 "reference":r.get('source') or "","attachments":[att],"line_items":lines}
        res,err=api("/bills/","POST",payload,idem=True)
        if err: st=f"FAIL {err}"
        else:
            a2,_=api(f"/bills/{res['id']}/","PATCH",{"status":"AUTHORIZED"})
            tot=(a2 or res).get('amount')
            pay={"payment_type":"BILL","paid_through_account":CLR,"contact":NOON,"currency":"AED",
                 "date":r['invoice_date'],"amount":tot,
                 "bill_payments":[{"bill":res['id'],"amount":tot,"amount_to_pcy":tot}]}
            _,perr=api("/payments/","POST",pay,idem=True)
            st=f"PAID ({tot})" if not perr else f"AUTH pay-fail {perr}"
    print(f"{inv:<22}{r['invoice_date'] or '?':<12}{len(r['line_items']):>3}{mkt:>10,.2f}{comm:>11,.2f}{(r['total'] or 0):>10,.2f}  {st}")
