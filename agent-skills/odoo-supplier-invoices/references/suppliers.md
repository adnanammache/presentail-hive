# Supplier profiles

Each supplier the skill books is described by a profile below. A profile carries the few
things that differ per vendor; everything else (company, journals, AP/Suspense/FX accounts,
the reconciliation mechanics) is shared and lives in `odoo_ids.md`.

To add a supplier, copy the **blank template** and fill it in — probe Odoo for the vendor,
expense account, and tax with a temporary `search_read` (see `odoo_ids.md`), and confirm
the expense account + tax with the user on first use. Then run the normal Step 1–7 flow.

## Profile fields

| Field | Meaning |
|---|---|
| `partner_id` | the Odoo vendor (res.partner id) + VAT number |
| `expense account_id` | where the spend is booked (e.g. Advertising, Software) |
| `tax` | VAT treatment — usually `19% RC` (reverse charge) for non-Cyprus EU/US suppliers |
| `bank-feed label` | how Revolut names the card charge; used to find it for reconciliation |
| `ref format` | shape of the invoice number to store in the bill's `ref` |
| `PDF source` | Drive folder (batch) or "user uploads" |
| `line name` | the description on the bill's single line |
| `classify / skip` | any receipt types that are NOT tax invoices and must be skipped |
| `currency` | usually EUR; note if the card charge settles from a non-EUR account (FX) |

---

## Meta (Facebook / Instagram ads) — WORKED EXAMPLE

Meta charges the Cyprus entity for Facebook/Instagram advertising in EUR on the Revolut
card. Fully automated, including a monthly Drive-folder batch.

| Field | Value |
|---|---|
| `partner_id` | **87** — Meta Platforms Ireland Limited, VAT IE9692928F |
| `expense account_id` | **140** — code `6201 Advertising` |
| `tax` | **24** — `19% RC` reverse charge; format `[[6,0,[24]]]` |
| `bank-feed label` | **`Facebk *<reference>`** (fees appear as `Fee for Facebk *…`) |
| `ref format` | **`FBADS-632-XXXXXXXXX`** (the Meta invoice #; strip any "Invoice #" prefix) |
| `PDF source` | Drive folder **"Meta Invoices"** (id `11DJFdBjL_xPkUsLjoyB65dzi1_jTgNem`), shared with `maya@presentail.com`; user also uploads singles |
| `line name` | `Meta ads - <ref>` |
| `classify / skip` | **skip** `Advertising credit` receipts (promo credit — no FBADS #, no VAT, no cash). `Visa ···· <digits>` and `Prepaid balance` are real tax invoices → book both. |
| `currency` | EUR; some charges settle from a USD/other card account → FX difference to 7910 |

**Monthly batch:** read every PDF in the folder, classify, dedup, preview, then feed the new
card+prepaid invoices to the saved poster scenario **"Meta ads → Odoo bill poster"** (blueprint
in `odoo_ids.md`), then run Step 6 reconciliation across the batch. Prepaid bills settle
against their single Revolut top-up charge (e.g. €154 + €46 ↔ one €200 charge) — that
many-to-one grouping is correct, don't force it to 1:1.

**Meta-specific gotchas:**
- Meta bills in **EUR**, but the Revolut card often settles from a **USD** sub-account, so
  the charge's EUR value differs from the bill by a euro or two. Those residuals need a
  per-charge FX entry to 7910; they do not clear themselves.
- The bank line's `Facebk *<ref>` string is Revolut's, **not** a Meta invoice number, so it
  can't be searched in Ads Manager. Match on date + amount.
- 2026 is fully booked and correctly paired (repaired 29 Jul 2026 — see `odoo_ids.md`).
  **2025 is not**: 43 charges, **€12,640.71**, Apr–Dec 2025, still unbooked in Bank Suspense
  for want of invoices. Sep 2025 has no Meta charges at all, which is worth a look. Three
  sub-€5 lines in that set are card fees, not ad spend.

---

## Cloudflare — WORKED EXAMPLE (US supplier, USD invoices, multi-currency card)

Cloudflare bills the Cyprus entity in **USD**; the Revolut card settles in USD, EUR, CAD or
CHF depending on which sub-account funds it. Monthly service invoice on the 3rd, plus ad-hoc
domain registrar renewals. 25 bills booked, Apr 2025 – Jul 2026.

| Field | Value |
|---|---|
| `partner_id` | **58** — Cloudflare, Inc. (US), VAT 4710875 |
| `expense account_id` | **186** — code `6255 Computer software` |
| `tax` | **24** — `19% RC` reverse charge; format `[[6,0,[24]]]` |
| `bank-feed label` | **`Cloudflare`** (plain). Card fees appear separately and are already booked to `7901 Bank charges` — leave them alone |
| `ref format` | **`IN-XXXXXXXX`** — the PDF shows `Invoice number IN 54582598`; strip the space, add a dash |
| `PDF source` | Drive folder **"Cloudflare"** (`14a64_1GJxU-OrXOmfbJ6R_h6WaUj8Oyb`); 2025 in subfolder **"Cloudflare 2025"** (`1eCbztSl72D6BE7zRmL1DweNnXSHogaWa`) |
| `line name` | `Cloudflare - <ref>` |
| `classify / skip` | none — every PDF is a real tax invoice. Registrar renewals ($10–12) charge same-day rather than +1 |
| `currency` | invoiced USD. **Book in the currency the charge settled in** — see the currency rule in `odoo_ids.md` |

**Scenarios:** "Cloudflare → Odoo bill poster" (`ref/date/amt/cur`), "Cloudflare attach PDFs".

---

## ManyChat — WORKED EXAMPLE (two invoice streams on one vendor)

ManyChat bills the Cyprus entity in **USD**. **Two separate streams share one vendor** and
both are real cash out — neither is a duplicate of the other:

1. **Subscription** — monthly PRO plan + AI add-on; invoice suffix is a plain number (`44`…`58`)
2. **Wallet top-ups** — "Top up wallet by user / by auto refill"; suffix is `W###`

| Field | Value |
|---|---|
| `partner_id` | **100** — ManyChat, Inc. (US), VAT 5958825 |
| `expense account_id` | **186** — code `6255 Computer software` |
| `tax` | **28** — `0% OEU`; format `[[6,0,[28]]]` — **see the VAT note below** |
| `bank-feed label` | **`manychat.com Manychat.com`** |
| `ref format` | **`264712310857310-<suffix>`** — the full ManyChat invoice ID; suffix is `54` or `W146` |
| `PDF source` | Drive folder **"ManyChat Invoices"** (`135J-jFVacOjHEVm3NIxws1e5RWp8dFct`). User uploads **screenshots (PNG)**, not PDFs — attach with `mimetype` `image/png` |
| `line name` | `ManyChat subscription - <suffix>` / `ManyChat wallet top-up - <suffix>` |
| `classify / skip` | none — wallet top-ups ARE booked, as **expense on the payment date**, not as a prepaid asset (confirmed with the user) |
| `currency` | invoiced USD; charges settle USD / EUR / GBP. **Book in the charge currency** |

> **VAT note — unresolved, ask before copying.** ManyChat is booked `0% OEU` while Cloudflare
> — identical facts: US supplier, no VAT number, no VAT on the invoice — is booked `19% RC`.
> The user chose this knowingly and it is pending accountant review. Do **not** treat either
> as settled precedent for a new US supplier without asking.

**Gotchas that cost real time here:**
- **Repeated identical amounts.** Six $100 charges on one day is normal. Amount+date is NOT
  unique for this vendor — you need invoice numbers. Where several invoices share a date and
  amount, assignment among them is arbitrary but equivalent; say so rather than implying
  precision you don't have.
- **Screenshots duplicate.** 47 files contained 41 distinct invoices. Dedupe on invoice
  suffix, never on file count.
- **Sequence gaps name the missing document.** A missing `W146` in an otherwise dense
  `W###` run, or `54` between `53` and `55`, tells you exactly what to ask the user for.

**Scenarios:** "ManyChat → Odoo bill poster", "ManyChat attach invoice images".

---

## Google Workspace — WORKED EXAMPLE (EUR invoice, card alternates EUR/USD)

Google Cloud EMEA Limited (Ireland) bills the Cyprus entity for Google Workspace Business
Starter in **EUR**, one invoice per month dated the **last day of the billing month**, emailed
to adnan@presentail.com on the 1st–2nd and auto-charged to the Revolut card on the 2nd.
15 bills booked and reconciled, Apr 2025 – Jun 2026 (done 30 Jul 2026).

| Field | Value |
|---|---|
| `partner_id` | **76** — Google Cloud Emea Limited, VAT IE3668997OH |
| `expense account_id` | **186** — code `6255 Computer software` |
| `tax` | **24** — `19% RC` reverse charge; format `[[6,0,[24]]]` |
| `bank-feed label` | varies over time — **`Google*gsuite Presenta`**, **`Google Gsuite_presentail.`**, **`Google Workspace_presenta`**, **`Google*workspace Prese`**. Search `payment_ref ilike workspace` **OR** `ilike gsuite`, and exclude `Fee for` |
| `ref format` | the 10-digit Google invoice number, e.g. **`5611591387`**; it is in the email's plaintext body as `Invoice number <digits>` |
| `PDF source` | Gmail attachment (`<invoice#>.pdf`); archived to Drive folder **"Google Workspace Invoices"** (`1dNIIoh8MLlBzCtqhncYirdX33aXgviFK`) |
| `line name` | `Google Workspace - <ref>` |
| `classify / skip` | none for Workspace. Google Cloud is a **separate stream on the same vendor** — see below; it is booked, but separately |
| `currency` | invoiced **EUR**; the card settles from either the EUR or the USD sub-account, month to month |

**The one thing that will confuse you.** Roughly half the months the Revolut charge is larger
than the invoice — €218.70 invoiced vs €254.71 on the feed. That is **not** a second invoice
and not a fee: those months settled from the **USD** sub-account, so the statement line's
`amount` is USD while its `balance` is the correct EUR. Read `account.bank.statement.line.
currency_id`: EUR months match the invoice to the cent; USD months leave an FX difference of
a few euros (largest seen €5.39) that goes to **7910**. Book the bill at the invoice's EUR
face value either way — never at the feed amount.

**Google Cloud Platform — two billing accounts, only one of which emails you.**

- **`01F0DB-591340-22B792`** emails a monthly invoice titled *"Google Cloud Platform & APIs:
  Your invoice is available for 01F0DB-591340-22B792"*. Every one of these is **€0.00** —
  nothing to book, ever. Don't be fooled into creating zero-value bills.
- **`0142C3-4CEC0E-354307`** is the account that actually spends money. It produces the small
  `Google*cloud <ref>` card charges (€0.01–€0.93) — **and it sends no invoice email at all**.
  Those invoices exist only in the Cloud console and have to be downloaded by hand from
  *Billing → Documents*. Four were booked on 31 Jul 2026 (Jan, Apr, May, Jun 2026, €1.21
  total) from PDFs Adnan pulled manually.

Book Cloud on the **same vendor and treatment as Workspace** (partner 76, account 186, tax
24), line name `Google Cloud - <ref>`, via scenario **"Google Cloud → Odoo bill poster"**
(same shape as the Workspace poster, on-demand, feed it `ref/date/amt/drive`). Then reclass
and reconcile by hand — it is a handful of cents a year and does not justify automation.

Two Cloud-specific traps:
- One Cloud charge (Feb 2026, €0.93) had been reclassed to AP against **Google Ireland
  Limited (86)** — the *Ads* vendor — not Google Cloud EMEA. Its statement line therefore read
  as matched in Bank Matching while sitting against the wrong supplier. Check partner, not
  just `is_reconciled`.
- The Jun 2026 charge shows **€0.14** on the feed against a **€0.12** invoice: that month
  settled in USD, so €0.14 is the USD figure and €0.12 is the EUR balance — the same trap as
  Workspace. It reconciled to the cent with no FX at all.

**The weekly automation does not cover Cloud.** The bill poster keys off the Workspace
invoice email, which Cloud's spending account never sends; the reconciler's search is
scoped to `workspace` / `gsuite` labels only, deliberately, so a stray Cloud charge can
never break its "exactly one of each" gate.

**Scenarios (both live, weekly):**
- **"Google Workspace → Odoo (auto)"** (Mon 09:30) — Gmail search → archive PDF to Drive →
  Drive `files/copy` to a Google Doc with `ocrLanguage=en` → export `text/plain` → regex the
  total and invoice date → dedup on `ref` → create + attach + post → label the email
  *Odoo Processed*. Writes an audit row per invoice to data store **154966**.
- **"Google Workspace → reconcile charges (auto)"** (Mon 10:00) — reclass the charge inside
  its own statement line, reconcile 1:1, sweep the FX residual to 7910. **Gated: it only acts
  when there is exactly one unreconciled Workspace charge and exactly one unpaid bill, and
  only posts FX when the residual is a single line under €10.** Anything else and it emails
  adnan@presentail.com and touches nothing.

**Make gotchas that cost time here:**
- `google-drive:uploadAFile` with `convert: true` does **not** OCR a PDF into a Doc — it just
  stores the PDF. Use `google-drive:makeApiCall` `POST /v3/files/<id>/copy?ocrLanguage=en`
  with body `{"mimeType":"application/vnd.google-apps.document"}`, then `getAFile` with
  `formatDocuments: "text/plain"`. The resulting text is clean and stable across both PDF
  layouts Google uses.
- A blueprint `filter` with `conditions: [[A],[B]]` is **A OR B**. To AND two conditions they
  must share one inner array: `conditions: [[A, B]]`. Getting this wrong made a dedup filter
  always pass and created duplicate bills.
- `{{1.body[1].move_id.id}}` **does** work for indexing into a `search_read` result and
  reading a many2one id. It is only `map()`/`join()`/`flatten()` over many2one that fail.
- `google-email:executeEmailSearchQuery` takes `filterType`/`q`/`limit`/`format` in its
  **mapper**, not in `parameters` — put them in `parameters` and it silently ignores the query
  and returns the whole inbox.

---

## Loom (Atlassian) — WORKED EXAMPLE (US supplier, USD invoice, card settles USD *or* GBP)

Loom (now billed through Atlassian, but the Odoo vendor is `Loom, Inc.`) charges the Cyprus
entity in **USD** for the Loom Business + AI plan. The card settles from the Revolut **USD**
sub-account some months and the **GBP** one others — which is the only thing that makes this
vendor interesting. 5 bills, May 2025 – Aug 2026.

| Field | Value |
|---|---|
| `partner_id` | **272** — Loom, Inc. (US, Austin TX), **no VAT number** |
| `expense account_id` | **186** — code `6255 Computer software` |
| `tax` | **28** — `0% OEU`; format `[[6,0,[28]]]` — **see the VAT note below** |
| `bank-feed label` | **`Loom Subscription`** (plain — no `*<reference>` suffix, unlike Meta) |
| `ref format` | **`B70785B3-XXXX`** — the PDF prints `Invoice number B70785B3 0009`; replace the space with a dash |
| `PDF source` | Drive folder **"Accounting Bills"** (`1grFLfJ_upJCufsFL90tX_yyH4HqHaVYZ`), owned by adnan@presentail.com, link-shared so Maya's Drive connection can read it |
| `line name` | `Loom subscription - <ref>` |
| `classify / skip` | none — every PDF is a real invoice |
| `currency` | invoiced **USD**. Book in USD at invoice face value. **But read the charge's journal first** — see below |

**The one thing that will confuse you: the charge is not always in USD.** Loom's own
invoices are always USD, but Revolut settles them from whichever sub-account has funds.
Check `account.bank.statement.line.currency_id` (or `journal_id`) before booking:

- **USD charge** (journal 37, `Revolut USD`) — book the bill in USD at face value. Odoo
  matches on `amount_currency` and posts any EUR difference itself to 7910. No manual JE.
- **GBP charge** (journal 39, `Revolut GBP`) — USD bill vs GBP charge is the
  *two different foreign currencies* case from `odoo_ids.md`: Odoo falls back to company
  currency and leaves a small EUR residual that does **not** clear itself. Book the bill in
  USD anyway (so the books show the real invoice), reconcile 1:1, then post the residual as
  a manual JE `Dr 93 <residual> (partner 272) / Cr 202 <residual>` and reconcile that too.
  Give the AP side `currency_id` **1** and `amount_currency` = the residual, or
  `amount_residual_currency` is left dangling even though `amount_residual` clears.

  The alternative — booking the bill in EUR at the charge's exact EUR balance — reconciles
  to the cent with no JE at all, but loses the USD face value. Adnan chose the USD + FX
  route on 27 Aug 2026; ask before switching.

> **VAT note — the same unresolved question as ManyChat.** Loom is booked `0% OEU` while
> Cloudflare and Semrush — identical facts: US supplier, no VAT number, no VAT on the
> invoice — are booked `19% RC`. The four pre-existing Loom bills all use `0% OEU`, so new
> Loom bills follow them for vendor consistency. Pending accountant review; do **not** treat
> it as settled precedent.

**Watch the ref sequence.** Loom numbers its invoices `B70785B3-0004`, `-0005`, `-0006`,
`-0007`, `-0009` … A gap names a document you have not been given — but check the bank feed
before chasing it: as of Aug 2026 there is no `0008` and no charge that would correspond to
one, so that gap is almost certainly a voided or zero-value invoice rather than a missing
one. Also note the plan changed shape over time: `-0006` was a **$173.33 annual** charge,
`-0007` was $52.47, and from `-0009` it is **$24.00/month**.

**Scenarios:** **"Loom → Odoo bill poster (USD)"** (7121183) — feed it `ref/date/amt/drive`;
it dedups on `ref` against partner 272, creates, attaches the PDF, posts, and writes an
audit row. **"Loom: Odoo generic exec+probe"** (7121138) — feed it
`{"items":[{"action","entity","params","key"}]}` and read results back from data store
**173143** (`Loom scratch`, fields `t1`/`t2`/`t3`); `t1` holds the raw `search_read` body,
which is far easier to work with than the flattened `join(map(...))` probes.

**Worked reference (Aug 2026).** Invoice `B70785B3-0009`, 20 Aug 2026, $24.00 → bill 31535
(`IN55672705`), EUR value €20.55. Charge: statement line 14864, 21 Aug, £17.60 / €20.53 on
`Revolut GBP`. Suspense line 96514 repointed to AP 93 / partner 272 inside its own statement
move `BNK4/2026/00166` and renamed `Loom B70785B3-0009 (Loom Subscription)`, reconciled 1:1,
and the €0.02 residual posted as `MISC/2026/08/0005` to 7910 and reconciled out. Final:
vendor AP 0, no unmatched `Loom Subscription` statement lines, two partial-reconcile rows on
the bill (its own charge + its own FX line).

---

## OpenAI — STARTER (confirm before first use)

Not yet run — confirm the bracketed fields against Odoo on first use, then finalise.

| Field | Value |
|---|---|
| `partner_id` | [find/create the OpenAI vendor in Odoo] |
| `expense account_id` | [Software / Subscriptions expense — confirm the code] |
| `tax` | likely **24** `19% RC` (US supplier, reverse charge) — confirm |
| `bank-feed label` | Revolut usually shows `OPENAI` / `OpenAI *…` — confirm from the feed |
| `ref format` | the OpenAI receipt/invoice number |
| `PDF source` | user uploads (no dedicated folder yet) |
| `line name` | `OpenAI - <ref>` |
| `classify / skip` | none known |
| `currency` | billed in USD → the EUR card charge will differ → FX difference to 7910 |

---

## Blank template — copy for a new supplier

```
## <Supplier name>

| Field | Value |
|---|---|
| partner_id          | <res.partner id> — <legal name>, VAT <..> |
| expense account_id  | <id> — <code / name> |
| tax                 | <id> — <e.g. 19% RC>  (format [[6,0,[<id>]]]) |
| bank-feed label     | <how Revolut names the charge> |
| ref format          | <invoice-number shape> |
| PDF source          | <Drive folder id / "user uploads"> |
| line name           | <Supplier> - <ref> |
| classify / skip     | <receipt types that are not tax invoices, if any> |
| currency            | EUR / <other> (note if the card settles from a non-EUR account) |
```
