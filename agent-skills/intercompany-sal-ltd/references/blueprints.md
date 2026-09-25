# The saved Make scenarios

Four scenarios do the whole job. **Find them by name** — ids drift if anything is rebuilt.
All live in Finance team **451472**, scheduling `{"type":"on-demand"}`, Odoo connection
**6330934**. Each starts inactive when created: `scenarios_activate` before `scenarios_run`.

| Scenario | Was id | Does |
|---|---|---|
| Intercompany: SAL invoice → LTD bill | 6730456 | creates + posts both halves, logs the id pair |
| Intercompany A: generate SAL invoice PDFs | 6730821 | renders each invoice PDF, download-only (no email) |
| Intercompany B: copy SAL invoice PDF onto LTD bill | 6730828 | copies the PDF onto the bill, sets it as main attachment |
| Intercompany: probe move config | 6730776 | read-only: journal / currency / company / partner / account off any move |

Two more read-only helpers may exist (`Intercompany: verify SAL/LTD pair`) with hardcoded ids;
edit or rewrite them per run rather than trusting their inputs.

---

## 1. Poster — invoice then bill

Run with one item per charge; `net` is the VAT-exclusive figure:

```json
{"items": [
  {"date": "2026-07-10", "net": 360.36, "description": "Flowers Delivery"},
  {"date": "2026-07-10", "net": 585.59, "description": "Flowers Delivery"},
  {"date": "2026-07-22", "net": 900.90, "description": "Flowers Delivery"}
]}
```

Afterwards read data-store keys `ic-<sal id>` for the `sal` / `ltd` id pairs.

```json
{
  "name": "Intercompany: SAL invoice → LTD bill",
  "metadata": {"instant": false, "version": 1},
  "scheduling": {"type": "on-demand"},
  "flow": [
    {"id": 1, "module": "builtin:BasicFeeder", "version": 1,
     "mapper": {"array": "{{var.input.items}}"}},
    {"id": 2, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "create", "entity": "account.move", "headers": [],
       "parameters": "[{\"move_type\":\"out_invoice\",\"partner_id\":137,\"journal_id\":48,\"company_id\":2,\"currency_id\":1,\"invoice_date\":\"{{1.date}}\",\"date\":\"{{1.date}}\",\"invoice_line_ids\":[[0,0,{\"name\":\"{{1.description}}\",\"account_id\":384,\"quantity\":1,\"price_unit\":{{1.net}},\"tax_ids\":[[6,0,[34]]]}]]}]"}},
    {"id": 3, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "action_post", "entity": "account.move", "headers": [],
       "parameters": "[[{{2.body}}]]"}},
    {"id": 4, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "search_read", "entity": "account.move", "headers": [],
       "parameters": "[[[\"id\",\"=\",{{2.body}}]]]",
       "search_params": "{\"fields\": [\"id\",\"name\",\"amount_total\",\"amount_untaxed\",\"amount_tax\"], \"limit\": 1}"}},
    {"id": 5, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "create", "entity": "account.move", "headers": [],
       "parameters": "[{\"move_type\":\"in_invoice\",\"partner_id\":9,\"journal_id\":8,\"company_id\":1,\"currency_id\":1,\"invoice_date\":\"{{1.date}}\",\"date\":\"{{1.date}}\",\"ref\":\"{{join(map(4.body; \"name\"); \"\")}}\",\"invoice_line_ids\":[[0,0,{\"name\":\"{{1.description}}\",\"account_id\":127,\"quantity\":1,\"price_unit\":{{join(map(4.body; \"amount_total\"); \"\")}},\"tax_ids\":[[6,0,[28]]]}]]}]"}},
    {"id": 6, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "action_post", "entity": "account.move", "headers": [],
       "parameters": "[[{{5.body}}]]"}},
    {"id": 7, "module": "datastore:AddRecord", "version": 1,
     "parameters": {"datastore": 152658},
     "mapper": {"key": "ic-{{2.body}}", "overwrite": true, "data": {
       "t1": "sal={{2.body}} ltd={{5.body}} date={{1.date}} desc={{1.description}}",
       "t2": "inv={{join(map(4.body; \"name\"); \"\")}} net={{join(map(4.body; \"amount_untaxed\"); \"\")}} vat={{join(map(4.body; \"amount_tax\"); \"\")}} tot={{join(map(4.body; \"amount_total\"); \"\")}}"}}}
  ],
  "interface": {"input": [{"name": "items", "type": "array", "spec": [
    {"name": "date", "type": "text"}, {"name": "net", "type": "number"},
    {"name": "description", "type": "text"}]}], "output": []}
}
```

---

## 2. A — generate the invoice PDFs

```json
{"items": [{"sal": 23372, "ltd": 23375}, {"sal": 23373, "ltd": 23376}]}
```

```json
{
  "name": "Intercompany A: generate SAL invoice PDFs",
  "metadata": {"version": 1},
  "flow": [
    {"id": 1, "module": "builtin:BasicFeeder", "version": 1,
     "mapper": {"array": "{{var.input.items}}"}},
    {"id": 2, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "create", "entity": "account.move.send.wizard", "headers": [],
       "parameters": "[{\"move_id\": {{1.sal}}, \"sending_method_checkboxes\": {\"manual\": {\"checked\": true}}}]"}},
    {"id": 3, "module": "datastore:AddRecord", "version": 1,
     "parameters": {"datastore": 152658},
     "mapper": {"key": "wiz-{{1.sal}}", "overwrite": true,
       "data": {"t1": "sal={{1.sal}} wizard={{2.body}}", "t2": "pending send"}}},
    {"id": 4, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "action_send_and_print", "entity": "account.move.send.wizard",
       "headers": [], "parameters": "[[{{2.body}}]]"}},
    {"id": 5, "module": "datastore:AddRecord", "version": 1,
     "parameters": {"datastore": 152658},
     "mapper": {"key": "wiz-{{1.sal}}", "overwrite": true,
       "data": {"t1": "sal={{1.sal}} wizard={{2.body}}", "t2": "sent ok"}}}
  ],
  "interface": {"input": [{"name": "items", "type": "array", "spec": [
    {"name": "sal", "type": "number"}, {"name": "ltd", "type": "number"}]}], "output": []}
}
```

The datastore write **before** the send is deliberate: if `action_send_and_print` errors, the
wizard ids are still recorded and the run is diagnosable.

---

## 3. B — copy the PDF onto the bill

Same `items` shape as A. Note the `res_field` domain in module 2 and the filter on module 3.

```json
{
  "name": "Intercompany B: copy SAL invoice PDF onto LTD bill",
  "metadata": {"version": 1},
  "flow": [
    {"id": 1, "module": "builtin:BasicFeeder", "version": 1,
     "mapper": {"array": "{{var.input.items}}"}},
    {"id": 2, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "search_read", "entity": "ir.attachment", "headers": [],
       "parameters": "[[[\"res_model\",\"=\",\"account.move\"],[\"res_id\",\"=\",{{1.sal}}],[\"res_field\",\"!=\",false]]]",
       "search_params": "{\"fields\": [\"id\",\"name\",\"mimetype\",\"file_size\"], \"limit\": 10}"}},
    {"id": 3, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "filter": {"name": "only if a PDF exists",
       "conditions": [[{"a": "{{length(2.body)}}", "o": "number:greater", "b": "0"}]]},
     "mapper": {"action": "copy", "entity": "ir.attachment", "headers": [],
       "parameters": "[[{{2.body[1].id}}], {\"res_model\": \"account.move\", \"res_id\": {{1.ltd}}, \"res_field\": false, \"name\": \"{{2.body[1].name}}\"}]"}},
    {"id": 4, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "write", "entity": "account.move", "headers": [],
       "parameters": "[[{{1.ltd}}], {\"message_main_attachment_id\": {{3.body}}}]"}},
    {"id": 5, "module": "datastore:AddRecord", "version": 1,
     "parameters": {"datastore": 152658},
     "mapper": {"key": "icpdf-{{1.sal}}", "overwrite": true, "data": {
       "t1": "sal={{1.sal}} ltd={{1.ltd}} srcAtt={{2.body[1].id}} name={{2.body[1].name}} size={{2.body[1].file_size}} mt={{2.body[1].mimetype}}",
       "t2": "newAtt={{3.body}} mainAttSet={{4.body}}"}}}
  ],
  "interface": {"input": [{"name": "items", "type": "array", "spec": [
    {"name": "sal", "type": "number"}, {"name": "ltd", "type": "number"}]}], "output": []}
}
```

Re-running B would attach a **second** copy — check `nAtt` first if you need to repeat it.

---

## 4. Probe — read config off any move

Pass any move id as `sal`. Returns journal / currency / company / partner / line account as
scalar ids via the `.id` accessor (plain `[1]` indexing does not work).

```json
{
  "name": "Intercompany: probe move config",
  "metadata": {"version": 1},
  "flow": [
    {"id": 1, "module": "builtin:BasicFeeder", "version": 1,
     "mapper": {"array": "{{var.input.items}}"}},
    {"id": 2, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "search_read", "entity": "account.move", "headers": [],
       "parameters": "[[[\"id\",\"=\",{{1.sal}}]]]",
       "search_params": "{\"fields\": [\"name\",\"journal_id\",\"currency_id\",\"company_id\",\"partner_id\"], \"limit\": 1}"}},
    {"id": 3, "module": "odoo:makeApiCall", "version": 1,
     "parameters": {"__IMTCONN__": 6330934},
     "mapper": {"action": "search_read", "entity": "account.move.line", "headers": [],
       "parameters": "[[[\"move_id\",\"=\",{{1.sal}}],[\"display_type\",\"=\",\"product\"]]]",
       "search_params": "{\"fields\": [\"account_id\"], \"limit\": 5}"}},
    {"id": 4, "module": "datastore:AddRecord", "version": 1,
     "parameters": {"datastore": 152658},
     "mapper": {"key": "cfg2-{{1.sal}}", "overwrite": true, "data": {
       "t1": "id={{1.sal}} name={{2.body[1].name}} J.id={{2.body[1].journal_id.id}} C.id={{2.body[1].currency_id.id}}",
       "t2": "CO.id={{2.body[1].company_id.id}} P.id={{2.body[1].partner_id.id}} ACCT.id={{3.body[1].account_id.id}}"}}}
  ],
  "interface": {"input": [{"name": "items", "type": "array",
    "spec": [{"name": "sal", "type": "number"}]}], "output": []}
}
```

---

## Verification queries

Run these as a final scenario (or extend the probe) before reporting:

```
# both halves
search_read account.move  [["id","in",[<sal ids>, <ltd ids>]]]
  fields: name, ref, invoice_date, amount_untaxed, amount_tax, amount_total, state, payment_state

# attachments on the bills — note ["id","!=",0] to defeat the res_field filter
search_read ir.attachment  [["id","!=",0],["res_model","=","account.move"],["res_id","=",<bill>]]
  fields: id, name, mimetype, res_field, file_size

# stray drafts from failed attempts
search_read account.move
  [["move_type","=","out_invoice"],["company_id","=",2],["partner_id","=",137],["state","=","draft"]]
```
