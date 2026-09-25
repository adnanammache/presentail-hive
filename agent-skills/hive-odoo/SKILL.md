---
name: hive-odoo
description: How to work in Presentail's Odoo from Hive using the `odoo` tool. Read this before any Odoo task, and whenever another skill tells you to run a Make scenario, "exec probe", or execute_kw call. It maps those instructions onto the direct tool, explains companies, approvals and the safe order of operations.
---

# Working in Odoo from Hive

You reach Odoo (presentail.odoo.com, **Odoo 19**) only through the **`odoo` tool**. Hive runs
each call with its own key. You never see credentials and you don't need Make.

## The tool

```
odoo(model, method, company_id, ids?, params?, reason?)
```

- `company_id` is always required. Use **1** for Presentail LTD (Cyprus, EUR books), **2** for
  Presentail SAL (Lebanon) and **3** for Presentail Flowers Trading L.L.C (UAE). Company **6**
  (PRESENTAIL S.A.L) is a legacy company: never use it.
- `ids` are record ids, for methods that act on records (`read`, `write`, `action_post`, `unlink`).
- `params` holds named arguments (Odoo JSON-2 style):
  - `search_read`: `{domain, fields, limit, offset, order}`
  - `read`: `ids` plus `{fields}`
  - `search_count`: `{domain}`
  - `create`: `{vals_list: [{…}, …]}` returns the new ids
  - `write`: `ids` plus `{vals: {…}}`
  - `action_post`: `ids` only
  - Relational commands keep Odoo's syntax: `[[6, 0, [34]]]` sets many2many, and
    `[[0, 0, {…}]]` creates one2many lines.
- `reason`: for any change, a one-line description the approver sees. Example: "Create Toters
  fee bill for Achrafieh, August 2026, LBP 4,250,000".

## Approvals

- **Reads run immediately:** search_read, read, search, search_count, fields_get,
  name_search, read_group.
- **Every change pauses until a person approves it in Hive:** create, write, action_post,
  reconcile, unlink, and anything else that isn't a read. So:
  1. Do all the reading and checking first: duplicates, balances, partner and account ids.
  2. Tell the user in a message exactly what you are about to change: counts, totals, and
     anything unusual.
  3. Batch sensibly. One `create` with several records in `vals_list` beats ten single creates.
- If a change is **rejected**, the result says so and nothing was changed. Adjust or ask; do
  not retry the same call.
- Configuration is off-limits: chart of accounts, journals, taxes, users, groups and `ir.*`.
  If a task needs one of these, ask the user to do it in Odoo.

## Translating the other Presentail skills

Several Presentail skills (Toters, BLOM, intercompany, supplier invoices, SAL statements) were
written when Odoo was reached through **Make scenarios**. Their knowledge still applies: the ids,
accounts, taxes, journals, mappings, VAT maths and the traps. Only the *transport* changes:

| The skill says | In Hive, do |
|---|---|
| Run the "Odoo exec probe" / generic scenario with `model`, `method`, `args` | `odoo(model, method, company_id, ids/params)` directly |
| `execute_kw(model, 'search_read', [domain], {fields…})` | `odoo(model, 'search_read', co, params={domain, fields})` |
| `execute_kw(model, 'create', [vals])` | `odoo(model, 'create', co, params={vals_list: [vals]})` |
| `execute_kw(model, 'write', [[ids], vals])` | `odoo(model, 'write', co, ids=[…], params={vals})` |
| A Make "poster" scenario that loops over many records | One `create` with a `vals_list`, or a few batched calls |
| Make data stores, webhooks, feeders, gateway 502s, scenario ids | Ignore. They don't exist here |
| "Attach the PDF" via a Make/Drive step | `odoo('ir.attachment', 'create', co, params={vals_list: [{name, res_model, res_id, datas: <base64>, mimetype}]})` using the file in /workspace/inputs |

Always re-check an id with a quick read before relying on it if the skill says it was "verified
on" a past date.

## Safe order of operations

1. **Read and dedupe.** Search for existing records (by `ref`, bill number, amount + date +
   partner) before creating anything.
2. **Dry run in your head:** list what you'll create, with totals.
3. **Say it, then do it:** one message summarising the plan, then the batched changes.
4. **Verify:** read back what you created (state, totals, reconciliation status) and report.
5. **Never delete posted entries.** To undo a posted entry, propose a reversal and let the
   user decide.
