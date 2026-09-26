// Wafeq through Hive: the real Talabat script runs against the gateway, its writes are queued,
// and one approval sends them to (a stand-in) Wafeq in order with the real ids filled in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.WAFEQ_API_KEY = 'wafeq-test-key';
delete process.env.ODOO_API_KEY;

const { get, run, all } = await import('./db.js');
const managed = await import('./managed.js');
const { wafeqGateway, tokenForRun, gatewayConfig, planSummary, executePlan, clearPlan } = await import('./wafeq.js');
const { fakeAnthropic } = await import('./testing/fake-anthropic.js');

// A stand-in Wafeq behind fetch; everything else (the test's own calls to the gateway) goes through.
const realFetch = globalThis.fetch;
const wafeq = [];
let failBills = false;
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('https://api.wafeq.com/v1')) return realFetch(url, init);
  const u = new URL(url);
  const method = init.method || 'GET';
  const body = init.body == null ? null : Buffer.from(init.body);
  wafeq.push({ method, path: u.pathname.replace(/^\/v1/, ''), query: u.search, headers: init.headers, body });
  if (method === 'GET' && u.pathname === '/v1/bills/')
    return u.searchParams.get('page') === '2'
      ? Response.json({ results: [{ bill_number: 'TUAE-OLD2' }], next: null })
      : Response.json({ results: [{ bill_number: 'TUAE-OLD' }], next: 'https://api.wafeq.com/v1/bills/?page=2' });
  if (method === 'POST' && u.pathname === '/v1/files/') return Response.json({ id: 'file_real' }, { status: 201 });
  if (method === 'POST' && u.pathname === '/v1/bills/')
    return failBills ? Response.json({ detail: 'bad contact' }, { status: 400 }) : Response.json({ id: 'bill_real', amount: 105 }, { status: 201 });
  if (method === 'PATCH' && u.pathname === '/v1/bills/bill_real/') return Response.json({ id: 'bill_real', amount: 105, status: 'AUTHORIZED' });
  if (method === 'POST' && u.pathname === '/v1/payments/') return Response.json({ id: 'pay_real', amount: 105 }, { status: 201 });
  return Response.json({ detail: 'not found' }, { status: 404 });
};

let server;
let origin;
before(async () => {
  const app = express();
  app.use(wafeqGateway());
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_URL = origin;
});
after(() => server.close());

const newRun = (status = 'running') => {
  const agentId = Number(run("INSERT INTO agents (name, title, platform, integrations, api_token) VALUES ('Ledger', 'UAE Accountant', 'managed', '[\"wafeq\"]', ?)", `t${Math.random()}`).lastInsertRowid);
  return Number(run("INSERT INTO runs (kind, agent_id, status) VALUES ('task', ?, ?)", agentId, status).lastInsertRowid);
};

const waitFor = async (fn, what) => {
  for (let i = 0; i < 300; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

test('the gateway refuses unknown addresses, finished runs and account settings', async () => {
  const bad = await realFetch(`${origin}/wafeq/r/${'0'.repeat(48)}/v1/bills/`);
  assert.equal(bad.status, 401);
  const ended = newRun('ended');
  assert.equal((await realFetch(`${gatewayConfig(origin, ended).base}/bills/`)).status, 401);

  const runId = newRun();
  const base = gatewayConfig(origin, runId).base;
  for (const p of ['/api-keys/', '/users/1/', '/webhooks/', '/organization/'])
    assert.equal((await realFetch(`${base}${p}`, { method: 'POST', body: '{}' })).status, 403, p);
  assert.equal((await realFetch(`${base}/bills/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' })).status, 400);
  assert.equal(all('SELECT * FROM wafeq_steps WHERE run_id = ?', runId).length, 0);
  assert.equal(tokenForRun(runId), tokenForRun(runId), 'one address per run');
});

test('the real Talabat script: reads are live, writes are queued, one approval posts them in order', async (t) => {
  const runId = newRun();
  const dir = mkdtempSync(join(tmpdir(), 'hive-wafeq-'));
  writeFileSync(join(dir, 'wafeq.json'), JSON.stringify(gatewayConfig(origin, runId)));
  writeFileSync(join(dir, 'TUAE-1.pdf'), '%PDF-1.4 fake');
  writeFileSync(join(dir, 'parsed.json'), JSON.stringify([
    { invoice_nr: 'TUAE-OLD', issue_date: '2026-08-31', line_items: [{ key: 'commission', desc: 'Commission', excl: 1 }] },
    { invoice_nr: 'TUAE-1', issue_date: '2026-08-31', line_items: [{ key: 'commission', desc: 'Commission', excl: 100 }] },
  ]));
  const env = { ...process.env, HIVE_WAFEQ_CONFIG: join(dir, 'wafeq.json'), WAFEQ_API_KEY: '', http_proxy: '', HTTP_PROXY: '', no_proxy: '*', NO_PROXY: '*' };
  let out;
  try {
    out = await promisify(execFile)('python3', ['agent-skills/talabat-month-end/scripts/post_talabat.py', '--parsed', join(dir, 'parsed.json'), '--pdf-dir', dir], { env });
  } catch (err) {
    if (err.code === 'ENOENT') return t.skip('python3 is not installed');
    throw err;
  }
  assert.match(out.stderr, /Wafeq via Hive/);
  assert.match(out.stdout, /TUAE-OLD .*exists \(skip\)/);
  assert.match(out.stdout, /TUAE-1 .*\$s3\.amount\s+QUEUED/);

  // Reads went to Wafeq with Hive's key, following the rewritten "next" link; nothing was written.
  assert.deepEqual(wafeq.map((c) => `${c.method} ${c.path}${c.query}`), ['GET /bills/?contact=co_D2vSPDvaPGJKJY6G5YP3jL&limit=200', 'GET /bills/?page=2']);
  assert.equal(wafeq[0].headers.Authorization, 'Api-Key wafeq-test-key');

  const plan = planSummary(runId);
  assert.deepEqual(plan.steps.map((s) => `${s.method} ${s.path}`), ['POST /files/', 'POST /bills/', 'PATCH /bills/$s2.id/', 'POST /payments/']);
  assert.equal(plan.headline, '1 bills, 1 payments, 1 attachments');
  assert.match(plan.full, /upload TUAE-1\.pdf/);

  wafeq.length = 0;
  const result = await executePlan(runId, 'Adnan', plan.steps.map((s) => s.id));
  assert.ok(result.ok, result.text);
  assert.deepEqual(wafeq.map((c) => `${c.method} ${c.path}`), ['POST /files/', 'POST /bills/', 'PATCH /bills/bill_real/', 'POST /payments/']);
  assert.match(wafeq[0].body.toString('latin1'), /filename="TUAE-1\.pdf"[\s\S]*%PDF-1\.4 fake/);
  assert.deepEqual(JSON.parse(wafeq[1].body).attachments, ['file_real']);
  assert.deepEqual(JSON.parse(wafeq[3].body).bill_payments, [{ bill: 'bill_real', amount: 105, amount_to_pcy: 105 }]);
  assert.equal(wafeq[3].headers['X-Wafeq-Idempotency-Key'], `hive-${runId}-${plan.steps[3].id}`);
  assert.deepEqual(all('SELECT status, approved_by FROM wafeq_steps WHERE run_id = ?', runId).map((s) => [s.status, s.approved_by]), Array(4).fill(['sent', 'Adnan']));
  assert.match(result.text, /All 4 steps were sent/);
});

test('a failure stops the batch; the rest is not attempted, and clear throws a queue away', async () => {
  const runId = newRun();
  const base = gatewayConfig(origin, runId).base;
  const post = (path, body) => realFetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const bill = await post('/bills/', { bill_number: 'X-1', amount: 10 });
  assert.equal(bill.id, '$s1.id');
  assert.equal(bill.status, 'QUEUED');
  await post('/payments/', { bill_payments: [{ bill: bill.id }] });

  failBills = true;
  wafeq.length = 0;
  const result = await executePlan(runId, 'Adnan');
  failBills = false;
  assert.equal(result.ok, false);
  assert.match(result.text, /Stopped at a failure: 0 of 2[\s\S]*bad contact/);
  assert.equal(wafeq.length, 1, 'the payment was never sent');
  assert.deepEqual(all('SELECT status FROM wafeq_steps WHERE run_id = ? ORDER BY seq', runId).map((s) => s.status), ['failed', 'skipped']);

  await post('/bills/', { bill_number: 'X-2' });
  clearPlan(runId);
  assert.equal(planSummary(runId).steps.length, 0);
});

test('the agent submits its queue with wafeq_plan; a person approves it once and gets the real ids back', async () => {
  const fake = fakeAnthropic();
  managed.setManagedClient(fake);
  const agentId = Number(run("INSERT INTO agents (name, title, platform, status, integrations, api_token) VALUES ('Ledger 2', 'UAE Accountant', 'managed', 'idle', '[\"wafeq\"]', 'agt_w')").lastInsertRowid);
  const taskId = Number(run("INSERT INTO tasks (title, agent_id) VALUES ('Talabat — August', ?)", agentId).lastInsertRowid);

  fake.script.push(() => [
    { id: 'sevt_empty', type: 'agent.custom_tool_use', name: 'wafeq_plan', input: { action: 'submit' } },
    { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_empty'] } },
  ]);
  fake.script.push(() => [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
  const started = managed.startTaskRun(taskId);
  await waitFor(() => fake.calls.sent.length >= 2, 'empty submit answered');
  assert.ok(fake.calls.agentsCreate.at(-1).tools.some((t) => t.name === 'wafeq_plan'));
  assert.equal(fake.calls.sessions.at(-1).resources.at(-1).mount_path, '/workspace/hive/wafeq.json');
  assert.equal(fake.calls.sent[1].events[0].is_error, true);
  assert.match(fake.calls.sent[1].events[0].content[0].text, /Nothing is queued/);
  await waitFor(() => get('SELECT status FROM runs WHERE id = ?', started.id).status === 'waiting', 'end of turn');

  // The script queued a bill and its payment (the agent's sandbox calls the gateway).
  const base = gatewayConfig(origin, started.id).base;
  const post = (path, body) => realFetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const bill = await post('/bills/', { bill_number: 'TUAE-9', line_items: [{ unit_amount: 100 }] });
  await post('/payments/', { payment_type: 'BILL', amount: '$s1.amount', bill_payments: [{ bill: bill.id }] });

  fake.script.push(() => [
    { id: 'sevt_submit', type: 'agent.custom_tool_use', name: 'wafeq_plan', input: { action: 'submit', reason: 'Talabat August: 1 fee bill, paid' } },
    { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_submit'] } },
  ]);
  await managed.replyToRun(started.id, 'Go ahead.');
  const waiting = await waitFor(() => {
    const r = get('SELECT * FROM runs WHERE id = ?', started.id);
    return r.status === 'needs_approval' && r;
  }, 'approval');
  const [pending] = JSON.parse(waiting.pending);
  assert.equal(pending.kind, 'wafeq');
  assert.match(pending.detail, /1 bills, 1 payments: Talabat August/);
  assert.match(pending.lines, /1\. POST \/bills\/\n2\. POST \/payments\//);
  assert.match(pending.preview, /TUAE-9/);

  // Something queued after the approval card was shown is not part of what was approved.
  await post('/bills/', { bill_number: 'SNEAKY' });

  fake.script.push(() => [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
  wafeq.length = 0;
  const sentBefore = fake.calls.sent.length;
  await managed.confirmTool(started.id, 'sevt_submit', true, undefined, { by: 'Adnan' });
  await waitFor(() => fake.calls.sent.length > sentBefore, 'result sent');
  const answer = fake.calls.sent.at(-1).events[0];
  assert.equal(answer.type, 'user.custom_tool_result');
  assert.equal(answer.custom_tool_use_id, 'sevt_submit');
  assert.match(answer.content[0].text, /All 2 steps were sent[\s\S]*→ bill_real[\s\S]*→ pay_real/);
  assert.equal(JSON.parse(wafeq[1].body).amount, 105);
  assert.ok(!wafeq.some((c) => c.body && /SNEAKY/.test(c.body)));
  assert.equal(planSummary(started.id).steps.length, 1, 'the later write is still queued, unapproved');
});
