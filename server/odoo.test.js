import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.ODOO_API_KEY = 'odoo-test-key';
delete process.env.WAFEQ_API_KEY;

const { get, run, all } = await import('./db.js');
const managed = await import('./managed.js');
const { classify, odooCall, ODOO_TOOL } = await import('./odoo.js');
const { fakeAnthropic } = await import('./testing/fake-anthropic.js');

// A stand-in Odoo: records every JSON-2 call and answers by method.
const odoo = [];
globalThis.fetch = async (url, init) => {
  const [, model, method] = new URL(url).pathname.match(/^\/json\/2\/([^/]+)\/([^/]+)$/) ?? [];
  const body = JSON.parse(init.body);
  odoo.push({ url, model, method, body, headers: init.headers });
  if (method === 'search_read') return Response.json([{ id: 7, name: 'Toters', amount_total: 120 }]);
  if (method === 'create') return Response.json([501]);
  if (method === 'action_post') return Response.json(true);
  return Response.json({ message: `No method ${method}` }, { status: 404 });
};

const waitFor = async (fn, what) => {
  for (let i = 0; i < 200; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

test('classify: reads run, changes need approval, configuration is off-limits', () => {
  assert.equal(classify('account.move', 'search_read'), 'read');
  assert.equal(classify('account.account', 'read'), 'read');
  assert.equal(classify('account.move', 'create'), 'write');
  assert.equal(classify('account.move.line', 'reconcile'), 'write');
  assert.equal(classify('account.account', 'write'), 'forbidden');
  assert.equal(classify('res.users', 'write'), 'forbidden');
  assert.equal(classify('ir.config_parameter', 'set_param'), 'forbidden');
  assert.equal(classify('account.move', '_private'), 'forbidden');
  assert.equal(classify('account.move; drop', 'read'), 'forbidden');
});

test('odooCall uses JSON-2 with a bearer key, the database header and the company context', async () => {
  odoo.length = 0;
  const rows = await odooCall({ model: 'account.move', method: 'search_read', company_id: 2, params: { domain: [['state', '=', 'draft']], fields: ['name'] } });
  assert.equal(rows[0].name, 'Toters');
  const call = odoo[0];
  assert.equal(call.url, 'https://presentail.odoo.com/json/2/account.move/search_read');
  assert.equal(call.headers.Authorization, 'bearer odoo-test-key');
  assert.equal(call.headers['X-Odoo-Database'], 'presentail');
  assert.deepEqual(call.body.context, { allowed_company_ids: [2] });
  await assert.rejects(odooCall({ model: 'res.users', method: 'write', ids: [1], params: { vals: { active: false } } }), /not allowed/);
});

test('an agent reads Odoo freely, changes wait for approval, and everything is logged', async () => {
  const fake = fakeAnthropic();
  managed.setManagedClient(fake);
  const agentId = Number(
    run("INSERT INTO agents (name, title, platform, status, integrations, api_token) VALUES ('Odoo Operator', 'Lebanon Accountant', 'managed', 'idle', ?, 'agt')", JSON.stringify(['odoo'])).lastInsertRowid,
  );
  const taskId = Number(run("INSERT INTO tasks (title, agent_id) VALUES ('Toters fee bills — August', ?)", agentId).lastInsertRowid);

  // Turn 1: a read and a create in the same pause.
  fake.script.push(() => [
    { type: 'session.status_running' },
    { id: 'sevt_read', type: 'agent.custom_tool_use', name: 'odoo', input: { model: 'account.move', method: 'search_read', company_id: 2, params: { domain: [], fields: ['name'] } } },
    { id: 'sevt_create', type: 'agent.custom_tool_use', name: 'odoo', input: { model: 'account.move', method: 'create', company_id: 2, params: { vals_list: [{ move_type: 'in_invoice', partner_id: 55 }] }, reason: 'Toters fee bill for Achrafieh, August' } },
    { id: 'sevt_cfg', type: 'agent.custom_tool_use', name: 'odoo', input: { model: 'account.journal', method: 'write', company_id: 2, ids: [48], params: { vals: { name: 'x' } } } },
    { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_read', 'sevt_create', 'sevt_cfg'] } },
  ]);
  const started = managed.startTaskRun(taskId);

  // The tool is on the agent, and Odoo's key is not in the vault or the prompt.
  await waitFor(() => fake.calls.agentsCreate.length, 'agent created');
  assert.ok(fake.calls.agentsCreate[0].tools.some((t) => t.name === ODOO_TOOL.name && t.type === 'custom'));
  assert.equal(fake.calls.credentials.length, 0);
  assert.ok(!JSON.stringify(fake.calls.agentsCreate[0]).includes('odoo-test-key'));

  const waiting = await waitFor(() => {
    const r = get('SELECT * FROM runs WHERE id = ?', started.id);
    return r.status === 'needs_approval' && r;
  }, 'approval');
  const pending = JSON.parse(waiting.pending);
  assert.deepEqual(pending.map((p) => p.event_id), ['sevt_create']);
  assert.match(pending[0].detail, /account\.move\.create · Presentail SAL/);
  assert.match(pending[0].reason, /Achrafieh/);

  // The read was answered straight away; the journal change was refused; the create has not run.
  await waitFor(() => fake.calls.sent.length >= 2, 'read results sent');
  const answered = fake.calls.sent[1].events;
  assert.deepEqual(answered.map((e) => [e.custom_tool_use_id, Boolean(e.is_error)]), [['sevt_read', false], ['sevt_cfg', true]]);
  assert.match(answered[0].content[0].text, /Toters/);
  assert.match(answered[1].content[0].text, /not allowed/);
  assert.ok(!odoo.some((c) => c.method === 'create'));

  // Approve: Hive runs the create and sends the new id back to the agent.
  fake.script.push(() => [
    { id: 'sevt_post', type: 'agent.custom_tool_use', name: 'odoo', input: { model: 'account.move', method: 'action_post', company_id: 2, ids: [501] } },
    { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_post'] } },
  ]);
  await managed.confirmTool(started.id, 'sevt_create', true, undefined, { by: 'Adnan' });
  await waitFor(() => fake.calls.sent.length >= 3, 'create result sent');
  assert.deepEqual(fake.calls.sent[2].events[0], { type: 'user.custom_tool_result', custom_tool_use_id: 'sevt_create', content: [{ type: 'text', text: '[501]' }] });
  assert.deepEqual(odoo.find((c) => c.method === 'create').body.vals_list, [{ move_type: 'in_invoice', partner_id: 55 }]);

  // Next change waits too; "approve all for this run" clears it and later ones.
  await waitFor(() => JSON.parse(get('SELECT pending FROM runs WHERE id = ?', started.id).pending)[0]?.event_id === 'sevt_post', 'post pending');
  fake.script.push(() => [
    { id: 'sevt_post2', type: 'agent.custom_tool_use', name: 'odoo', input: { model: 'account.move', method: 'action_post', company_id: 2, ids: [502] } },
    { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_post2'] } },
  ]);
  fake.script.push(() => [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
  await managed.confirmTool(started.id, 'sevt_post', true, undefined, { by: 'Adnan', approveRest: true });
  await waitFor(() => get("SELECT status FROM odoo_actions WHERE event_id = 'sevt_post2'")?.status === 'executed', 'auto-approved post');

  const log = all('SELECT event_id, kind, status, approved_by FROM odoo_actions ORDER BY id').map((r) => ({ ...r }));
  assert.deepEqual(log, [
    { event_id: 'sevt_read', kind: 'read', status: 'executed', approved_by: 'automatic (read-only)' },
    { event_id: 'sevt_create', kind: 'write', status: 'executed', approved_by: 'Adnan' },
    { event_id: 'sevt_cfg', kind: 'forbidden', status: 'refused', approved_by: null },
    { event_id: 'sevt_post', kind: 'write', status: 'executed', approved_by: 'Adnan' },
    { event_id: 'sevt_post2', kind: 'write', status: 'executed', approved_by: 'approved for this run' },
  ]);
});

test('rejecting a change tells the agent and changes nothing', async () => {
  const fake = fakeAnthropic();
  managed.setManagedClient(fake);
  const agentId = Number(run("INSERT INTO agents (name, title, platform, status, integrations, api_token) VALUES ('Kyros', 'Cyprus Accountant', 'managed', 'idle', ?, 'agt2')", JSON.stringify(['odoo'])).lastInsertRowid);
  const taskId = Number(run("INSERT INTO tasks (title, agent_id) VALUES ('Revolut recon', ?)", agentId).lastInsertRowid);
  fake.script.push(() => [
    { id: 'sevt_unlink', type: 'agent.custom_tool_use', name: 'odoo', input: { model: 'account.move', method: 'unlink', company_id: 1, ids: [9] } },
    { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_unlink'] } },
  ]);
  const started = managed.startTaskRun(taskId);
  await waitFor(() => get('SELECT status FROM runs WHERE id = ?', started.id).status === 'needs_approval', 'approval');
  const before = odoo.length;
  fake.script.push(() => [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
  await managed.confirmTool(started.id, 'sevt_unlink', false, 'Never delete posted entries', { by: 'Adnan' });
  await waitFor(() => fake.calls.sent.length >= 2, 'rejection sent');
  const ev = fake.calls.sent[1].events[0];
  assert.equal(ev.is_error, true);
  assert.match(ev.content[0].text, /Rejected by Adnan: Never delete posted entries/);
  assert.equal(odoo.length, before);
  assert.equal(get("SELECT status FROM odoo_actions WHERE event_id = 'sevt_unlink'").status, 'rejected');
});
