import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.ODOO_API_KEY = 'odoo-test-key';
delete process.env.WAFEQ_API_KEY;

const { get, run, all } = await import('./db.js');
const managed = await import('./managed.js');
const { classify, odooCall, ODOO_TOOL, cleanContext, checkAgentCall, describeCall } = await import('./odoo.js');
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

test('secrets and admin models are off-limits even to read; configuration is read-only', () => {
  for (const m of ['ir.config_parameter', 'ir.mail_server', 'fetchmail.server', 'payment.provider', 'auth.oauth.provider', 'res.users', 'res.users.apikeys', 'res.groups', 'base_import.import', 'res.config.settings', 'mail.mail', 'mail.compose.message', 'iap.account'])
    assert.equal(classify(m, 'search_read'), 'forbidden', m);
  for (const m of ['account.tax.repartition.line', 'account.fiscal.position', 'account.reconcile.model', 'res.currency.rate', 'res.company', 'account.change.lock.date', 'account.journal.group']) {
    assert.equal(classify(m, 'search_read'), 'read', m);
    assert.equal(classify(m, 'write'), 'forbidden', m);
  }
  assert.equal(classify('ir.attachment', 'create'), 'write', 'attaching documents is allowed');
  assert.equal(classify('res.partner.bank', 'write'), 'write');
  assert.deepEqual(cleanContext({ check_move_validity: false, tracking_disable: true, lang: 'en_US', default_move_type: 'in_invoice' }), { lang: 'en_US', default_move_type: 'in_invoice' });
  assert.match(checkAgentCall({ model: 'account.move', method: 'create', company_id: 6 }), /company_id must be one of 1, 2, 3/);
  assert.equal(checkAgentCall({ model: 'account.move', method: 'create', company_id: 2 }), null);
  assert.match(describeCall({ model: 'account.move', method: 'unlink', company_id: 1, params: { ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } }), /\[1, 2, 3, 4, 5, 6, 7, 8, … 10 records\]/);
});

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

test('after a restart, unanswered calls are answered and finished Odoo changes are never run again', async () => {
  const fake = fakeAnthropic();
  managed.setManagedClient(fake);
  for (let i = 0; i < 2; i++) fake.script.push(() => [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
  const session = await fake.beta.sessions.create({});
  const agentId = Number(run("INSERT INTO agents (name, title, platform, api_token) VALUES ('Recover', 'X', 'managed', 'rc')").lastInsertRowid);
  const runId = Number(run("INSERT INTO runs (kind, agent_id, status, session_id) VALUES ('task', ?, 'running', ?)", agentId, session.id).lastInsertRowid);
  const call = (id, input) => {
    run("INSERT INTO run_events (run_id, event_id, type, data) VALUES (?, ?, 'agent.custom_tool_use', ?)", runId, id, JSON.stringify({ name: 'odoo', kind: 'x' }));
    run("INSERT INTO odoo_actions (run_id, agent_id, event_id, model, method, company_id, input, kind, status) VALUES (?, ?, ?, ?, ?, 2, ?, ?, 'queued')", runId, agentId, id, input.model, input.method, JSON.stringify(input), input.kind);
  };
  call('done_before', { model: 'account.move', method: 'create', company_id: 2, kind: 'write' });
  run("UPDATE odoo_actions SET status = 'executed', result = '[777]' WHERE event_id = 'done_before'");
  call('never_run', { model: 'account.move', method: 'search_read', company_id: 2, kind: 'read' });
  const before = odoo.length;

  await managed.recoverToolCalls(runId);
  const sent = fake.calls.sent.flatMap((s) => s.events);
  const byId = Object.fromEntries(sent.map((e) => [e.custom_tool_use_id, e]));
  assert.equal(byId.done_before.content[0].text, '[777]', 'the earlier result is reported');
  assert.match(byId.never_run.content[0].text, /Toters/, 'the read runs now');
  assert.equal(odoo.slice(before).filter((c) => c.method === 'create').length, 0, 'the create is not run twice');
});

test('an agent set to Never ask has its Odoo changes run straight away; forbidden calls are still refused', async () => {
  const fake = fakeAnthropic();
  managed.setManagedClient(fake);
  const agentId = Number(run("INSERT INTO agents (name, title, platform, status, integrations, approval, api_token) VALUES ('Auto', 'SAL Accountant', 'managed', 'idle', '[\"odoo\"]', 'autonomous', 'agt_auto')").lastInsertRowid);
  const taskId = Number(run("INSERT INTO tasks (title, agent_id) VALUES ('Toters — September', ?)", agentId).lastInsertRowid);
  fake.script.push(() => [
    { id: 'sevt_auto_create', type: 'agent.custom_tool_use', name: 'odoo', input: { model: 'account.move', method: 'create', company_id: 2, params: { vals_list: [{ move_type: 'in_invoice' }] } } },
    { id: 'sevt_auto_cfg', type: 'agent.custom_tool_use', name: 'odoo', input: { model: 'account.journal', method: 'write', company_id: 2, ids: [48], params: { vals: { name: 'x' } } } },
    { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_auto_create', 'sevt_auto_cfg'] } },
  ]);
  fake.script.push(() => [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
  const started = managed.startTaskRun(taskId);
  await waitFor(() => fake.calls.sent.length >= 2, 'results sent');

  assert.match(fake.calls.agentsCreate.at(-1).tools.find((t) => t.name === 'odoo').description, /also run immediately/);
  assert.deepEqual(fake.calls.sent[1].events.map((e) => [e.custom_tool_use_id, Boolean(e.is_error)]), [['sevt_auto_create', false], ['sevt_auto_cfg', true]]);
  assert.equal(get("SELECT approved_by FROM odoo_actions WHERE event_id = 'sevt_auto_create'").approved_by, 'automatic (agent set to Never ask)');
  assert.equal(get("SELECT status FROM odoo_actions WHERE event_id = 'sevt_auto_cfg'").status, 'refused');
  assert.notEqual(get('SELECT status FROM runs WHERE id = ?', started.id).status, 'needs_approval');
});
