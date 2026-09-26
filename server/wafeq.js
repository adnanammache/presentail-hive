// Wafeq through Hive: the agent never holds the Wafeq key.
//
// Each agent run gets its own gateway address (in /workspace/hive/wafeq.json). The Wafeq scripts
// use it instead of api.wafeq.com:
//   - reads (GET) go straight through to Wafeq with Hive's key, so checking what's already booked
//     needs no clicks;
//   - writes (POST/PUT/PATCH/DELETE, including file uploads) are QUEUED, not sent. The script gets a
//     stand-in answer (ids like "$s3.id") so it can carry on and queue the whole month.
// The agent then calls `wafeq_plan` to submit the batch: a person sees every bill, invoice and
// payment in one approval, and on approval Hive sends them in order, filling in the real ids.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, all, get, run } from './db.js';
import { recordHealth } from './health.js';
import { baseUrl } from './notify.js';

const WAFEQ = 'https://api.wafeq.com/v1';
export const wafeqConfigured = () => Boolean(process.env.WAFEQ_API_KEY);

// Never through Hive, not even with approval: keys, users, webhooks and organisation settings.
const FORBIDDEN = /^\/?(api-keys|api_keys|users|members|webhooks|organi[sz]ations?|settings|integrations|subscriptions?)(\/|$)/i;
const SAFE_PATH = /^\/?[a-z0-9_\-]+(\/[a-zA-Z0-9_\-.$]+)*\/?$/;
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const uploadsDir = (runId) => join(DATA_DIR, 'wafeq-uploads', String(runId));

// ---------------------------------------------------------------- run tokens

export function tokenForRun(runId) {
  const existing = get('SELECT token FROM wafeq_tokens WHERE run_id = ?', runId)?.token;
  if (existing) return existing;
  const token = randomBytes(24).toString('hex');
  run('INSERT INTO wafeq_tokens (token, run_id) VALUES (?, ?)', token, runId);
  return token;
}

function runForToken(token) {
  const row = get(
    `SELECT t.run_id, r.status FROM wafeq_tokens t JOIN runs r ON r.id = t.run_id
     WHERE t.token = ? AND t.created_at >= datetime('now', '-7 days')`,
    String(token || ''),
  );
  return row && !['failed', 'ended'].includes(row.status) ? row.run_id : null;
}

/** What goes in the run's /workspace/hive/wafeq.json. */
export const gatewayConfig = (baseUrl, runId) => ({
  base: `${baseUrl.replace(/\/$/, '')}/wafeq/r/${tokenForRun(runId)}/v1`,
  note: 'Reads go to Wafeq; writes are queued until a person approves them in Hive (call the wafeq_plan tool to submit).',
});

// ---------------------------------------------------------------- the gateway

async function forwardGet(path, query, gatewayBase) {
  const url = `${WAFEQ}${path}${query ? `?${query}` : ''}`;
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Api-Key ${process.env.WAFEQ_API_KEY}`, Accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    recordHealth('wafeq', false, err.message);
    return { status: 502, body: JSON.stringify({ detail: `Wafeq unreachable: ${err.message}` }) };
  }
  if (res.status === 401 || res.status === 403 || res.status >= 500) recordHealth('wafeq', false, `Wafeq answered ${res.status}`);
  else recordHealth('wafeq', true);
  // Pagination links point at Wafeq; send them back through the gateway.
  const text = (await res.text()).split(WAFEQ).join(gatewayBase);
  return { status: res.status, body: text, type: res.headers.get('content-type') || 'application/json' };
}

/** Queue one write; answer with a stand-in so the script can carry on. */
function queueWrite(runId, method, path, query, req) {
  const seq = (get('SELECT MAX(seq) AS s FROM wafeq_steps WHERE run_id = ? AND status = ?', runId, 'queued')?.s ?? 0) + 1;
  const type = String(req.get('content-type') || 'application/json');
  let body = null;
  let file = null;
  let summary = '';
  if (/multipart\/form-data/.test(type)) {
    mkdirSync(uploadsDir(runId), { recursive: true });
    file = join(uploadsDir(runId), `${seq}-${Date.now()}.bin`);
    writeFileSync(file, req.body);
    const name = /filename="([^"]+)"/.exec(req.body.toString('latin1', 0, 2000))?.[1] ?? 'file';
    summary = `upload ${name} (${Math.ceil(req.body.length / 1024)} KB)`;
  } else {
    try {
      body = req.body?.length ? JSON.parse(req.body.toString('utf8')) : null;
    } catch {
      return { status: 400, json: { detail: 'Hive gateway: request body must be JSON' } };
    }
  }
  run(
    'INSERT INTO wafeq_steps (run_id, seq, method, path, query, body, file, content_type, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    runId, seq, method, path, query || null, body == null ? null : JSON.stringify(body), file, type, summary || null,
  );
  const stand = (field) => `$s${seq}.${field}`;
  return {
    status: 201,
    json: {
      ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}),
      id: stand('id'),
      amount: stand('amount'),
      invoice_number: body?.invoice_number ?? stand('invoice_number'),
      bill_number: body?.bill_number ?? stand('bill_number'),
      status: 'QUEUED',
      _hive: `Queued as step ${seq}. Nothing is sent to Wafeq until a person approves the plan in Hive (wafeq_plan tool, action "submit").`,
    },
  };
}

export function wafeqGateway() {
  const r = express.Router();
  r.all(/^\/wafeq\/r\/([a-f0-9]{48})\/v1(\/.*)$/, express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
    const runId = runForToken(req.params[0]);
    if (!runId) return res.status(401).json({ detail: 'Hive gateway: this address has expired. Start a new run.' });
    if (!wafeqConfigured()) return res.status(503).json({ detail: 'Wafeq is not connected in Hive (WAFEQ_API_KEY is not set).' });
    const path = req.params[1];
    const query = req.originalUrl.split('?')[1] ?? '';
    if (!SAFE_PATH.test(path) || path.includes('..')) return res.status(400).json({ detail: 'Hive gateway: unexpected path' });
    const method = req.method.toUpperCase();
    if (method === 'GET') {
      const out = await forwardGet(path, query, `${baseUrl()}/wafeq/r/${req.params[0]}/v1`);
      return res.status(out.status).type(out.type || 'application/json').send(out.body);
    }
    if (!WRITE.has(method)) return res.status(405).json({ detail: 'Method not allowed' });
    if (FORBIDDEN.test(path)) return res.status(403).json({ detail: `Hive gateway: ${path} can't be changed through Hive. Ask the user to do it in Wafeq.` });
    const out = queueWrite(runId, method, path, query, req);
    res.status(out.status).json(out.json);
  });
  return r;
}

// ---------------------------------------------------------------- the plan

/** The wafeq_plan tool. `autonomous`: the agent is set to "Never ask", so a submitted batch posts straight away. */
export const wafeqTool = ({ autonomous = false } = {}) => ({
  type: 'custom',
  name: 'wafeq_plan',
  description: [
    "Submit, show or clear the Wafeq changes your scripts have queued in this run. Wafeq is reached through Hive:",
    'the address is in /workspace/hive/wafeq.json (the Presentail scripts read it automatically). Reads run immediately;',
    autonomous
      ? 'every write (bills, invoices, payments, file uploads, status changes) is queued and sent when you submit, with no one approving it.'
      : 'every write (bills, invoices, payments, file uploads, status changes) is queued and only sent after a person approves.',
    'Workflow: run the script with --dry-run, check the numbers, then run it for real (this queues the writes), then call',
    `wafeq_plan with action "submit" and a one-line reason. ${autonomous ? 'Hive then' : 'After approval Hive'} posts everything in order and returns the`,
    'real ids. Use "show" to review what is queued and "clear" to throw the queue away (e.g. after a mistake).',
    'Queued writes are not in Wafeq yet, so re-running the script queues them again: clear first if you need to re-run.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['submit', 'show', 'clear'] },
      reason: { type: 'string', description: 'For submit: what this batch is, e.g. "Talabat August 2026: 3 fee bills and payments"' },
    },
    required: ['action'],
  },
});
export const WAFEQ_TOOL = wafeqTool();

const queued = (runId) => all("SELECT * FROM wafeq_steps WHERE run_id = ? AND status = 'queued' ORDER BY seq", runId);

function describeStep(s) {
  const body = s.body ? JSON.parse(s.body) : null;
  const what = s.summary || [
    body?.bill_number && `bill ${body.bill_number}`,
    body?.invoice_number && `invoice ${body.invoice_number}`,
    body?.payment_type && `${String(body.payment_type).toLowerCase()} payment`,
    body?.status && `status → ${body.status}`,
    body?.amount != null && `amount ${body.amount}`,
    body?.currency,
    Array.isArray(body?.line_items) && `${body.line_items.length} line${body.line_items.length === 1 ? '' : 's'}`,
  ].filter(Boolean).join(', ');
  return `${s.seq}. ${s.method} ${s.path}${what ? `: ${what}` : ''}`;
}

/** A readable summary of the queue, and the full detail (everything that will be sent). */
export function planSummary(runId) {
  const steps = queued(runId);
  const count = (re) => steps.filter((s) => s.method === 'POST' && re.test(s.path)).length;
  const headline = [
    count(/^\/bills\/?$/) && `${count(/^\/bills\/?$/)} bills`,
    count(/^\/(simplified-)?invoices\/?$/) && `${count(/^\/(simplified-)?invoices\/?$/)} invoices`,
    count(/^\/payments\/?$/) && `${count(/^\/payments\/?$/)} payments`,
    count(/^\/files\/?$/) && `${count(/^\/files\/?$/)} attachments`,
  ].filter(Boolean).join(', ');
  const full = steps
    .map((s) => `${describeStep(s)}${s.body ? `\n${JSON.stringify(JSON.parse(s.body), null, 2)}` : ''}`)
    .join('\n\n');
  return { steps, headline: headline || `${steps.length} changes`, full };
}

export function clearPlan(runId) {
  for (const s of queued(runId)) if (s.file) rmSync(s.file, { force: true });
  run("UPDATE wafeq_steps SET status = 'discarded' WHERE run_id = ? AND status = 'queued'", runId);
}

/** Replace "$s3.id"-style stand-ins with the real values from earlier steps. */
function fill(value, results) {
  if (typeof value === 'string') {
    const whole = /^\$s(\d+)\.(\w+)$/.exec(value);
    if (whole) return results[whole[1]]?.[whole[2]] ?? value;
    return value.replace(/\$s(\d+)\.(\w+)/g, (m, n, f) => (results[n]?.[f] ?? m));
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, results));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, results)]));
  return value;
}

/** Send an approved plan to Wafeq, in order. Stops at the first failure. Returns a report. */
export async function executePlan(runId, by, stepIds) {
  // Only the steps the approver was shown (nothing queued later sneaks in).
  const steps = queued(runId).filter((s) => !stepIds || stepIds.includes(s.id));
  const results = {};
  const lines = [];
  let failed = false;
  for (const s of steps) {
    if (failed) {
      run("UPDATE wafeq_steps SET status = 'skipped' WHERE id = ?", s.id);
      continue;
    }
    const path = fill(s.path, results);
    const headers = { Authorization: `Api-Key ${process.env.WAFEQ_API_KEY}`, 'X-Wafeq-Idempotency-Key': `hive-${runId}-${s.id}` };
    let body;
    if (s.file) {
      headers['Content-Type'] = s.content_type;
      body = readFileSync(s.file);
    } else if (s.body) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(fill(JSON.parse(s.body), results));
    }
    try {
      const res = await fetch(`${WAFEQ}${path}${s.query ? `?${s.query}` : ''}`, { method: s.method, headers, body, signal: AbortSignal.timeout(60_000) });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text.slice(0, 500) };
      }
      if (!res.ok) throw new Error(`Wafeq ${res.status}: ${text.slice(0, 300)}`);
      results[s.seq] = json;
      run("UPDATE wafeq_steps SET status = 'sent', response = ?, approved_by = ?, sent_at = datetime('now') WHERE id = ?", text.slice(0, 20000), by, s.id);
      lines.push(`✓ ${describeStep(s)} → ${json?.id ?? 'ok'}${json?.invoice_number ? ` (${json.invoice_number})` : ''}${json?.amount != null ? ` amount ${json.amount}` : ''}`);
      recordHealth('wafeq', true);
    } catch (err) {
      failed = true;
      run("UPDATE wafeq_steps SET status = 'failed', response = ?, approved_by = ? WHERE id = ?", err.message, by, s.id);
      lines.push(`✗ ${describeStep(s)} → ${err.message}`);
      if (/fetch failed|ECONN|timed out|Wafeq (401|403|5\d\d)/.test(err.message)) recordHealth('wafeq', false, err.message);
    }
    if (s.file) rmSync(s.file, { force: true });
  }
  const sent = lines.filter((l) => l.startsWith('✓')).length;
  const skipped = steps.length - lines.length;
  return {
    ok: !failed,
    text: [
      failed ? `Stopped at a failure: ${sent} of ${steps.length} steps were sent${skipped ? `, ${skipped} not attempted` : ''}.` : `All ${steps.length} steps were sent to Wafeq.`,
      ...lines,
      failed ? 'Fix the problem, then queue and submit only what is still missing (re-run the script: it skips what already exists).' : '',
    ].filter(Boolean).join('\n'),
  };
}
