// Direct Odoo access for agents, executed by Hive (not in the agent's sandbox).
//
// Agents get an `odoo` custom tool. When they call it, the session pauses and Hive runs the
// call against Odoo 19's JSON-2 API with its own API key, so the key never leaves Hive.
// Reads run straight away; anything that creates, changes, posts or deletes waits for a human
// to click Approve in Hive. Every call is logged in odoo_actions.
//
// Env: ODOO_API_KEY (required), ODOO_URL (default https://presentail.odoo.com),
//      ODOO_DB (default: the subdomain, e.g. "presentail").

import { recordHealth } from './health.js';

export const odooConfigured = () => Boolean(process.env.ODOO_API_KEY);
const odooUrl = () => (process.env.ODOO_URL || 'https://presentail.odoo.com').replace(/\/$/, '');
const odooDb = () => process.env.ODOO_DB || new URL(odooUrl()).hostname.split('.')[0];

export const COMPANIES = {
  1: 'Presentail LTD (Cyprus, EUR books)',
  2: 'Presentail SAL (Lebanon)',
  3: 'Presentail Flowers Trading L.L.C (UAE)',
};

// Methods that only read. Everything else is treated as a change and needs approval.
const READ_METHODS = new Set([
  'search_read', 'read', 'search', 'search_count', 'fields_get', 'name_search', 'read_group',
  'formatted_read_group', 'web_search_read', 'web_read', 'default_get', 'has_access', 'check_access_rights',
  'get_views', 'context_get',
]);

// No access at all, not even reads: secrets (system parameters, mail/SSO/payment credentials,
// API keys), user and access management, imports that can write anywhere, email sending, settings.
// ir.attachment is the one ir.* model agents need (to read and attach documents).
const SECRET_OR_ADMIN =
  /^(ir\.(?!attachment$)|base\.|base_import\.|auth\.|auth_|iap\.|payment\.provider|fetchmail\.|res\.users\.apikeys|res\.users$|res\.groups|res\.config|change\.password|portal\.wizard|mail\.(mail|template|compose\.message)$)/;

// Configuration: agents may read it (to find ids) but never change it.
const CONFIG = /^(account\.(account|journal|tax|fiscal\.position|reconcile\.model|group|chart\.template|report|change\.lock\.date|lock_exception)|account\.account\.tag|res\.company|res\.currency)/;

/** read: run now · write: needs approval · forbidden: refuse */
export function classify(model, method) {
  if (!/^[a-z][a-z0-9_.]*$/.test(model || '') || !/^[a-z][a-z0-9_]*$/.test(method || '')) return 'forbidden';
  if (SECRET_OR_ADMIN.test(model)) return 'forbidden';
  if (READ_METHODS.has(method)) return 'read';
  if (CONFIG.test(model)) return 'forbidden';
  return 'write';
}

// Context keys an agent may pass. Others can switch off Odoo's own safety checks
// (e.g. check_move_validity) or its audit trail (tracking_disable, mail_notrack).
const SAFE_CONTEXT = /^(lang|tz|active_test|default_[a-z0-9_]+)$/;
export const cleanContext = (ctx) =>
  Object.fromEntries(Object.entries(ctx && typeof ctx === 'object' ? ctx : {}).filter(([k]) => SAFE_CONTEXT.test(k)));

/** Problems with an agent's call before it runs (null when fine). */
export function checkAgentCall(input) {
  if (!COMPANIES[input?.company_id]) return `company_id must be one of ${Object.keys(COMPANIES).join(', ')} (${Object.values(COMPANIES).join('; ')}).`;
  if (input.params != null && (typeof input.params !== 'object' || Array.isArray(input.params))) return 'params must be an object of named arguments.';
  return null;
}

export const ODOO_TOOL = {
  type: 'custom',
  name: 'odoo',
  description: [
    "Call Presentail's Odoo 19 (presentail.odoo.com) through Hive. One call = one model method.",
    'Reads (search_read, read, search, search_count, fields_get, name_search, read_group) run immediately.',
    'Anything that changes data (create, write, action_post, reconcile, unlink, …) pauses until a human approves it in Hive,',
    'so batch related changes into as few calls as you sensibly can, and describe them in your message first.',
    'Configuration models (ir.*, users, groups, journals, chart of accounts, taxes) cannot be changed.',
    `Companies: ${Object.entries(COMPANIES).map(([id, n]) => `${id} = ${n}`).join('; ')}. Always pass company_id.`,
    'Arguments follow Odoo JSON-2: record methods take `ids`; other arguments go in `params` by name, e.g.',
    'search_read → params {domain, fields, limit, order}; create → params {vals_list: [{…}]}; write → ids + params {vals: {…}};',
    'action_post → ids. Where a skill describes a Make scenario or execute_kw call, make the equivalent call here.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      model: { type: 'string', description: 'Odoo model, e.g. account.move' },
      method: { type: 'string', description: 'Model method, e.g. search_read, create, write, action_post' },
      company_id: { type: 'integer', description: 'Company to act as: 1 LTD, 2 SAL, 3 UAE' },
      ids: { type: 'array', items: { type: 'integer' }, description: 'Record ids, for methods that act on records' },
      params: { type: 'object', description: 'Named arguments for the method (domain, fields, vals, vals_list, limit, …)' },
      reason: { type: 'string', description: 'For changes: one line on what this does and why, shown to the approver' },
    },
    required: ['model', 'method', 'company_id'],
  },
};

const MAX_RESULT = 60_000;

/** Run one call against Odoo's JSON-2 API. */
export async function odooCall({ model, method, ids, params = {}, company_id }) {
  if (!odooConfigured()) throw new Error('Odoo is not connected (ODOO_API_KEY is not set)');
  if (classify(model, method) === 'forbidden') throw new Error(`${model}.${method} is not allowed through Hive`);
  const body = { ...(params || {}) };
  if (Array.isArray(ids)) body.ids = ids;
  body.context = cleanContext(body.context);
  if (company_id) body.context.allowed_company_ids = [company_id];
  let res;
  try {
    res = await fetch(`${odooUrl()}/json/2/${model}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `bearer ${process.env.ODOO_API_KEY}`,
        'X-Odoo-Database': odooDb(),
        'User-Agent': 'Presentail-Hive',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    recordHealth('odoo', false, err.message);
    throw err;
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const message = (json && (json.message || json.error?.message)) || `HTTP ${res.status}`;
    // 401/403/5xx mean Odoo itself isn't reachable for Hive; a 4xx on one call is that call's problem.
    if (res.status === 401 || res.status === 403 || res.status >= 500) recordHealth('odoo', false, `Odoo: ${message}`);
    throw new Error(`Odoo: ${message}`);
  }
  recordHealth('odoo', true);
  return json;
}

export function formatResult(result) {
  const text = JSON.stringify(result);
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}… [truncated ${text.length - MAX_RESULT} characters; narrow the fields or domain]` : text;
}

/** For Settings: check the key works and list the companies it can see. */
export async function testOdoo() {
  const companies = await odooCall({ model: 'res.company', method: 'search_read', params: { fields: ['id', 'name'], order: 'id' } });
  return { url: odooUrl(), db: odooDb(), companies };
}

export function describeCall(input) {
  const company = input.company_id ? ` · ${COMPANIES[input.company_id]?.split(' (')[0] ?? `company ${input.company_id}`}` : '';
  // Record ids can arrive as `ids` or inside params: show whichever the call will actually use.
  const all = Array.isArray(input.ids) ? input.ids : Array.isArray(input.params?.ids) ? input.params.ids : [];
  const ids = all.length ? ` [${all.slice(0, 8).join(', ')}${all.length > 8 ? `, … ${all.length} records` : ''}]` : '';
  return `${input.model}.${input.method}${ids}${company}`;
}
