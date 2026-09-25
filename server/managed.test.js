// End-to-end test of the Managed Agents engine against a simulated Anthropic API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = ':memory:';
process.env.WAFEQ_API_KEY = 'wafeq-test-key';

const { get, run } = await import('./db.js');
const managed = await import('./managed.js');
const { fakeAnthropic } = await import('./testing/fake-anthropic.js');

const waitFor = async (fn, what) => {
  for (let i = 0; i < 200; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

test('a Talabat task runs on Managed Agents: skills, vault, files, approval, result and cost', async () => {
  const fake = fakeAnthropic();
  managed.setManagedClient(fake);

  const teamId = Number(run("INSERT INTO teams (name) VALUES ('Accounting')").lastInsertRowid);
  const agentId = Number(
    run(
      `INSERT INTO agents (name, title, team_id, platform, status, skills, integrations, approval, api_token)
       VALUES ('Ledger', 'UAE Accountant', ?, 'managed', 'idle', ?, ?, 'every_command', 'agt_test')`,
      teamId,
      JSON.stringify(['talabat-month-end', 'anthropic:pdf']),
      JSON.stringify(['wafeq']),
    ).lastInsertRowid,
  );
  const taskId = Number(run("INSERT INTO tasks (title, description, agent_id) VALUES ('Talabat month-end — August', 'Post August fee bills and branch sales.', ?)", agentId).lastInsertRowid);
  const dir = mkdtempSync(join(tmpdir(), 'hive-files-'));
  writeFileSync(join(dir, 'TUAE-123.pdf'), '%PDF-1.4 fake');
  run('INSERT INTO task_files (task_id, filename, path, size) VALUES (?, ?, ?, ?)', taskId, 'TUAE-123.pdf', join(dir, 'TUAE-123.pdf'), 13);

  // The agent's first turn: a dry run, then it asks to run the posting command.
  fake.script.push(() => [
    { type: 'session.status_running' },
    { type: 'agent.message', content: [{ type: 'text', text: 'Dry run: 1 fee bill, AED 1,234.00. Posting now needs your approval.' }] },
    { id: 'sevt_post', type: 'agent.tool_use', name: 'bash', input: { command: 'python scripts/post_talabat.py --parsed talabat_parsed.json' }, evaluated_permission: 'ask' },
    { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_post'] } },
  ]);

  const started = managed.startTaskRun(taskId);
  assert.equal(started.status, 'starting');

  const waiting = await waitFor(() => {
    const r = get('SELECT * FROM runs WHERE id = ?', started.id);
    return r.status === 'needs_approval' && r;
  }, 'approval request');

  // Skill uploaded as a directory with its scripts; built-in skill referenced by name.
  const upload = fake.calls.skills[0];
  assert.ok(upload.names.includes('talabat-month-end/SKILL.md'));
  assert.ok(upload.names.includes('talabat-month-end/scripts/post_talabat.py'));
  const agentConfig = fake.calls.agentsCreate[0];
  assert.deepEqual(agentConfig.skills.map((s) => s.type), ['custom', 'anthropic']);
  assert.match(agentConfig.system, /Ledger, UAE Accountant on Presentail's Accounting team/);
  assert.match(agentConfig.system, /\$WAFEQ_API_KEY/);
  assert.deepEqual(agentConfig.tools[0].configs.map((c) => [c.name, c.permission_policy.type]), [['bash', 'always_ask'], ['write', 'always_ask'], ['edit', 'always_ask']]);

  // Secret goes to the vault (never the prompt), limited to Wafeq's host, header-only.
  const cred = fake.calls.credentials[0];
  assert.equal(cred.auth.secret_name, 'WAFEQ_API_KEY');
  assert.equal(cred.auth.secret_value, 'wafeq-test-key');
  assert.deepEqual(cred.auth.networking.allowed_hosts, ['api.wafeq.com']);
  assert.ok(!agentConfig.system.includes('wafeq-test-key'));
  assert.deepEqual(fake.calls.environments[0].config.networking.allowed_hosts, ['api.wafeq.com']);

  // The task's file is uploaded and mounted; the kickoff message describes the task.
  const session = fake.calls.sessions[0];
  assert.deepEqual(session.resources, [{ type: 'file', file_id: session.resources[0].file_id, mount_path: '/workspace/inputs/TUAE-123.pdf' }]);
  assert.equal(session.vault_ids.length, 1);
  assert.match(fake.calls.sent[0].events[0].content[0].text, /Talabat month-end — August[\s\S]*TUAE-123\.pdf/);

  // Waiting on you: the task shows in review with the pending command.
  assert.equal(get('SELECT status FROM tasks WHERE id = ?', taskId).status, 'review');
  const pending = JSON.parse(waiting.pending);
  assert.equal(pending[0].event_id, 'sevt_post');
  assert.match(pending[0].detail, /post_talabat\.py/);

  // Approve: the agent posts and reports back.
  fake.script.push(() => [
    { type: 'session.status_running' },
    { type: 'agent.tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'Created bill BILL-0042' }] },
    { type: 'agent.message', content: [{ type: 'text', text: 'Posted 1 bill (BILL-0042), AED 1,234.00, paid through Talabat Transactions.' }] },
    { type: 'session.usage', usage: { list_cost: { amount: '42', currency: 'USD' } } },
    { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
  ]);
  await managed.confirmTool(started.id, 'sevt_post', true);
  await waitFor(() => fake.calls.sent.length === 2, 'approval sent');
  assert.deepEqual(fake.calls.sent[1].events[0], { type: 'user.tool_confirmation', tool_use_id: 'sevt_post', result: 'allow' });

  const done = await waitFor(() => {
    const r = get('SELECT * FROM runs WHERE id = ?', started.id);
    return r.status === 'waiting' && r;
  }, 'end of turn');
  assert.equal(done.cost_cents, 42);
  const task = get('SELECT status, result FROM tasks WHERE id = ?', taskId);
  assert.equal(task.status, 'review');
  assert.match(task.result, /BILL-0042/);

  // The activity log has everything, once.
  const view = managed.runWithEvents(started.id);
  assert.ok(view.events.some((e) => e.type === 'agent.tool_use' && /post_talabat/.test(e.data.detail)));
  assert.equal(new Set(view.events.map((e) => e.event_id)).size, view.events.length);

  // Replying continues the same session.
  fake.script.push(() => [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
  await managed.replyToRun(started.id, 'Great, also do Careem.');
  await waitFor(() => fake.calls.sent.length === 3, 'reply sent');
  assert.equal(fake.calls.sent[2].sid, session.sid);

  // Re-syncing an unchanged agent does nothing; changing its skills updates it in place.
  await managed.syncAgent(agentId);
  assert.equal(fake.calls.agentsUpdate.length, 0);
  run('UPDATE agents SET skills = ? WHERE id = ?', JSON.stringify(['talabat-month-end', 'careem-month-end']), agentId);
  await managed.syncAgent(agentId);
  assert.equal(fake.calls.agentsUpdate.length, 1);
  assert.equal(fake.calls.agentsUpdate[0].version, 1);
  assert.equal(fake.calls.skills.length, 2, 'only the new skill is uploaded');
});

test('runs refuse to start for agents that are not Claude Managed Agents', () => {
  const agentId = Number(run("INSERT INTO agents (name, title, platform, api_token) VALUES ('Old', 'Bot', 'claude', 'agt_x')").lastInsertRowid);
  const taskId = Number(run("INSERT INTO tasks (title, agent_id) VALUES ('x', ?)", agentId).lastInsertRowid);
  assert.throws(() => managed.startTaskRun(taskId), /not assigned to a Claude Managed Agent/);
});
