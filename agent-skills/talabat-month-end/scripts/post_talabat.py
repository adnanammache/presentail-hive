#!/usr/bin/env python3
"""Post Talabat TUAE fee invoices as itemized expense bills.

Usage:
    python post_talabat.py --parsed talabat_parsed.json --pdf-dir <tuae-dir> [--dry-run]

One bill per TUAE PDF, fully itemized, each line routed by fee type (see
references/wafeq_ids.md). Authorizes and marks PAID through the Talabat Transactions
clearing account. Dedups on bill number. Key: $WAFEQ_API_KEY or ./wafeq_key.txt.
ALWAYS --dry-run first.
"""
import argparse, json, os, re, sys, uuid, subprocess, urllib.request, urllib.error
B="https://api.wafeq.com/v1"
TAL="co_D2vSPDvaPGJKJY6G5YP3jL"
ACCT={'commission':"acc_4J9jT5pdg9pgcA4nPFYsDy",
      'subscription':"acc_RyqS3EC2ZgQHQSHRaoMnH8",
      'marketing':"acc_dnCh6QNz5WGJHAvcrvHTBT",
      'premium_marketing':"acc_fPjYTCuSpXG7wixfDUMUgm"}
CLR="acc_DDapSPi55Qr8FyaYPQsXfn"
VAT_PUR="tax_oEzW9XTqZWxJAUMSvaTSP9"

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
def upload(path):
    return json.loads(subprocess.run(["curl","-sS","-H",f"Authorization: Api-Key {KEY}","-F",f"file=@{path};type=application/pdf",f"{B}/files/"],capture_output=True,text=True).stdout)["id"]

ap=argparse.ArgumentParser()
ap.add_argument("--parsed",required=True); ap.add_argument("--pdf-dir",required=True)
ap.add_argument("--dry-run",action="store_true"); ap.add_argument("--only")
a=ap.parse_args()
rows=json.load(open(a.parsed))
fmap={}
for p in os.listdir(a.pdf_dir):
    m=re.match(r'(TUAE-\d+)',p)
    if m and p.endswith('.pdf'): fmap[m.group(1)]=os.path.join(a.pdf_dir,p)
existing={b['bill_number'] for b in paginate(f"/bills/?contact={TAL}&limit=200")}
print(f"{'Invoice':<15}{'#L':>3}{'Total':>10}  status")
for r in rows:
    inv=r['invoice_nr']
    if a.only and inv!=a.only: continue
    if inv in existing: print(f"{inv:<15}{len(r['line_items']):>3}{'':>10}  exists (skip)"); continue
    if a.dry_run:
        print(f"{inv:<15}{len(r['line_items']):>3}{round(sum(li['excl'] for li in r['line_items'])*1.05,2):>10,.2f}  WOULD CREATE"); continue
    att=upload(fmap[inv])
    lines=[{"account":ACCT[li['key']],"description":li['desc'],"quantity":1,"unit_amount":li['excl'],"tax_rate":VAT_PUR} for li in r['line_items']]
    payload={"contact":TAL,"bill_number":inv,"bill_date":r['issue_date'],"bill_due_date":r.get('due_date') or r['issue_date'],
             "currency":"AED","tax_amount_type":"TAX_EXCLUSIVE","status":"DRAFT","reference":r.get('restaurant') or "",
             "attachments":[att],"line_items":lines}
    res,err=api("/bills/","POST",payload,idem=True)
    if err: print(f"{inv:<15} FAIL {err}"); continue
    a2,_=api(f"/bills/{res['id']}/","PATCH",{"status":"AUTHORIZED"}); tot=(a2 or res).get('amount')
    pay={"payment_type":"BILL","paid_through_account":CLR,"contact":TAL,"currency":"AED","date":r['issue_date'],
         "amount":tot,"bill_payments":[{"bill":res['id'],"amount":tot,"amount_to_pcy":tot}]}
    _,perr=api("/payments/","POST",pay,idem=True)
    print(f"{inv:<15}{len(r['line_items']):>3}{tot:>10,.2f}  {'PAID' if not perr else 'AUTH payfail '+str(perr)}")
