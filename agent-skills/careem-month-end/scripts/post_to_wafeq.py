#!/usr/bin/env python3
"""Post Careem commission bills + cash (simplified) invoices to Wafeq.

Usage:
    python post_to_wafeq.py --parsed parsed.json --period-end 2026-06-30 \
        --pdf-dir <folder-with-pdfs> [--dry-run]

- Reads the Wafeq API key from $WAFEQ_API_KEY, else ./wafeq_key.txt, else errors.
- --dry-run prints what would be created and writes nothing. ALWAYS run this first.
- Dedup: skips a bill whose number already exists under the Careem supplier, and a
  cash invoice matching (brand, gross, period-end) already booked to Careem Revenue.
- Cash invoices are finalized to PAID by assigning the next SINV-000NNN number.

IMPORTANT: verify STORE_MAP against the live tracker Google Sheet before running —
a store's emirate can change, which flips its cash-invoice place_of_supply.
"""
import argparse, json, os, re, sys, uuid, subprocess, urllib.request, urllib.error

B = "https://api.wafeq.com/v1"

# --- Presentail Wafeq IDs (see references/wafeq_ids.md) ---
CAREEM_SUPPLIER = "co_TGW2p5Kokxs7fApZRLtYMU"
ACC_COMMISSION  = "acc_kd64DxUxUTVJGwifwJeree"   # 503 Careem Commission
ACC_REVENUE     = "acc_mFxKxJQbwXZ5kR2AuTpCQV"   # 415 Careem Revenue
ACC_CLEARING    = "acc_LXa8CizucFw6uVVonQ2PbF"   # 120 Careem Transactions
TAX_PURCHASES   = "tax_oEzW9XTqZWxJAUMSvaTSP9"   # 5% VAT on Purchases
TAX_SALES       = "tax_WAss52jmQnUvyH8UTCyRYe"   # 5% VAT on Sales
PROJECT         = "pro_TQ5QT6SfEur6DcXmTaJnmh"   # Presentail
BR_DUBAI        = "br_6Wyrs9iNwpybGFczAG5zmJ"    # Barsha
BR_ABUDHABI     = "br_EC6YHtmTfPBXPKsYH4HrxM"    # Abu Dhabi

# merchant number -> (place_of_supply, bill branch, cash-invoice brand)
STORE_MAP = {
    "1068765": ("DUBAI",     BR_DUBAI,    "The Single Flower by Presentail"),
    "1068769": ("DUBAI",     BR_DUBAI,    "Flower Bag"),
    "1071168": ("DUBAI",     BR_DUBAI,    "Presentail"),
    "1072404": ("DUBAI",     BR_DUBAI,    "Flower Scent"),
    "1074359": ("DUBAI",     BR_DUBAI,    "Pollen Flowers"),
    "1081919": ("DUBAI",     BR_DUBAI,    "Eternal Rose"),
    "1082118": ("DUBAI",     BR_DUBAI,    "Mini Blooms"),
    "1088963": ("DUBAI",     BR_DUBAI,    "Blooms & Balloons"),
    "1080388": ("ABU_DHABI", BR_ABUDHABI, "Presentail"),
    "1080614": ("ABU_DHABI", BR_ABUDHABI, "Flower Scent"),
    "1080620": ("ABU_DHABI", BR_ABUDHABI, "The Single Flower by Presentail"),
    "1083092": ("ABU_DHABI", BR_ABUDHABI, "Mini Blooms"),
}

def load_key():
    k = os.environ.get("WAFEQ_API_KEY")
    if not k and os.path.exists("wafeq_key.txt"):
        k = open("wafeq_key.txt").read().strip()
    if not k:
        sys.exit("No Wafeq API key: set $WAFEQ_API_KEY or provide ./wafeq_key.txt")
    return k

def api(key, path, method="GET", data=None, idem=False):
    h = {'Authorization': f'Api-Key {key}', 'Content-Type': 'application/json'}
    if idem:
        h['X-Wafeq-Idempotency-Key'] = str(uuid.uuid4())
    req = urllib.request.Request(B + path, headers=h, method=method)
    if data is not None:
        req.data = json.dumps(data).encode()
    try:
        return json.load(urllib.request.urlopen(req)), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read().decode()[:300]}"

def paginate(key, path):
    out, url = [], B + path
    while url:
        req = urllib.request.Request(url, headers={'Authorization': f'Api-Key {key}'})
        d = json.load(urllib.request.urlopen(req)); out += d['results']; url = d.get('next')
    return out

def upload_pdf(key, path):
    out = subprocess.run(["curl", "-sS", "-H", f"Authorization: Api-Key {key}",
                          "-F", f"file=@{path};type=application/pdf", f"{B}/files/"],
                         capture_output=True, text=True).stdout
    return json.loads(out)["id"]

def m(s):
    return float(str(s).replace(',', ''))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parsed", required=True)
    ap.add_argument("--period-end", required=True, help="YYYY-MM-DD (month end)")
    ap.add_argument("--pdf-dir", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    key = load_key()
    rows = json.load(open(a.parsed))
    end = a.period_end

    existing_bills = {b['bill_number'] for b in
                      paginate(key, f"/bills/?contact={CAREEM_SUPPLIER}&limit=200")}
    all_si = paginate(key, "/simplified-invoices/?limit=200&ordering=-created_ts")
    booked_ci = {(si['line_items'][0]['description'], round(si['amount'], 2))
                 for si in all_si if si['invoice_date'] == end
                 and any(li['account'] == ACC_REVENUE for li in si['line_items'])}
    next_sinv = max([int(mm.group(1)) for si in all_si
                     for mm in [re.match(r'SINV-0*(\d+)', si.get('invoice_number') or '')] if mm]
                    or [0])

    print(f"{'Store':<9}{'Emirate':<11}{'Bill':<30}{'Cash invoice':<22}")
    for r in rows:
        store = r['merchant_ref']
        if store not in STORE_MAP:
            print(f"{store:<9}{'??':<11}UNKNOWN STORE — check the Sheet"); continue
        pos, branch, brand = STORE_MAP[store]
        net, gross = m(r['fees_excl_vat']), m(r['gross_sales'])
        emirate = 'Dubai' if pos == 'DUBAI' else 'Abu Dhabi'

        # ---- BILL ----
        if store in existing_bills:
            bill_msg = "exists (skip)"
        elif a.dry_run:
            bill_msg = f"CREATE+PAY {store} ({net*1.05:,.2f})"
        else:
            pdf = os.path.join(a.pdf_dir, r['file'])
            att = upload_pdf(key, pdf)
            payload = {"contact": CAREEM_SUPPLIER, "bill_number": store,
                       "bill_date": end, "bill_due_date": end, "currency": "AED",
                       "tax_amount_type": "TAX_EXCLUSIVE", "status": "DRAFT",
                       "branch": branch, "project": PROJECT, "attachments": [att],
                       "line_items": [{"account": ACC_COMMISSION,
                                       "description": "Commission and Fees",
                                       "quantity": 1, "unit_amount": net,
                                       "tax_rate": TAX_PURCHASES}]}
            res, err = api(key, "/bills/", "POST", payload, idem=True)
            if err:
                bill_msg = f"FAIL {err}"
            else:
                a2, _ = api(key, f"/bills/{res['id']}/", "PATCH", {"status": "AUTHORIZED"})
                total = (a2 or res).get('amount')
                # Mark PAID by settling through the Careem Transactions clearing
                # account (Careem nets commission out of the payout). This is what
                # makes the clearing account reconcile: gross in, fees out.
                pay = {"payment_type": "BILL", "paid_through_account": ACC_CLEARING,
                       "contact": CAREEM_SUPPLIER, "currency": "AED", "date": end,
                       "amount": total,
                       "bill_payments": [{"bill": res['id'], "amount": total,
                                          "amount_to_pcy": total}]}
                _, perr = api(key, "/payments/", "POST", pay, idem=True)
                bill_msg = (f"AUTH (pay FAIL {perr})" if perr
                            else f"PAID {store} ({total})")

        # ---- CASH INVOICE ----
        if (brand, round(gross, 2)) in booked_ci:
            ci_msg = "exists (skip)"
        elif a.dry_run:
            ci_msg = f"PAID {brand} ({gross:,.2f})"
        else:
            next_sinv += 1
            num = f"SINV-{next_sinv:06d}"
            payload = {"invoice_number": num, "invoice_date": end, "currency": "AED",
                       "place_of_supply": pos, "tax_amount_type": "TAX_INCLUSIVE",
                       "status": "PAID", "paid_through_account": ACC_CLEARING,
                       "line_items": [{"account": ACC_REVENUE, "description": brand,
                                       "quantity": 1, "unit_amount": gross,
                                       "tax_rate": TAX_SALES}]}
            res, err = api(key, "/simplified-invoices/", "POST", payload, idem=True)
            if err:
                next_sinv -= 1
                ci_msg = f"FAIL {err}"
            else:
                ci_msg = f"{res['status']} {res.get('invoice_number')} ({res.get('amount')})"
        print(f"{store:<9}{emirate:<11}{bill_msg:<30}{ci_msg:<22}")

    print("\nDone. Next: tick the Careem check marks in the tracker Sheet "
          "(main Careem cell + the per-store boxes) and Slack the user the list.")

if __name__ == "__main__":
    main()
