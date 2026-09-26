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
  assert.match(agentConfig.system, /through Hive[\s\S]*wafeq_plan/);
  assert.ok(agentConfig.tools.some((t) => t.name === 'wafeq_plan'));
  assert.deepEqual(agentConfig.tools[0].configs.map((c) => [c.name, c.permission_policy?.type ?? (c.enabled === false ? 'off' : '?')]), [
    ['bash', 'always_ask'], ['write', 'always_ask'], ['edit', 'always_ask'], ['web_fetch', 'off'], ['web_search', 'off'],
  ]);
  assert.equal(fake.calls.environments[0].config.networking.allow_mcp_servers, false);

  // The Wafeq key never reaches the sandbox: no vault credential, and the only host is Hive's gateway.
  assert.equal(fake.calls.credentials.length, 0);
  assert.ok(!agentConfig.system.includes('wafeq-test-key'));
  assert.deepEqual(fake.calls.environments[0].config.networking.allowed_hosts, ['localhost']);

  // The task's file is uploaded and mounted; the kickoff message describes the task.
  const session = fake.calls.sessions[0];
  assert.deepEqual(session.resources.map((r) => r.mount_path), ['/workspace/inputs/TUAE-123.pdf', '/workspace/hive/wafeq.json']);
  assert.match(fake.calls.sent[0].events[0].content[0].text, /Talabat month-end — August[\s\S]*TUAE-123\.pdf/);

  // Waiting on you: the task shows in review with the pending command.
  // Still in progress, blocked until someone approves.
  const blocked = get('SELECT status, blocked_kind, blocked_reason FROM tasks WHERE id = ?', taskId);
  assert.equal(blocked.status, 'in_progress');
  assert.equal(blocked.blocked_kind, 'approval');
  assert.match(blocked.blocked_reason, /bash/);
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

  // Files the agent saved become downloadable outputs of the run.
  fake.outputs[session.sid] = [{ id: 'file_out1', filename: 'august-talabat-summary.xlsx', mime_type: 'application/vnd.ms-excel', size_bytes: 2048 }];
  const outputs = await managed.syncOutputs(started.id, [0]);
  assert.deepEqual(outputs.map((o) => o.filename), ['august-talabat-summary.xlsx']);
  const dl = await managed.downloadOutput(started.id, outputs[0].id);
  assert.equal(dl.body.toString(), 'contents of file_out1');

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

test('a second chat message gets its reply live, not only when the next message is sent', async () => {
  const fake = fakeAnthropic();
  managed.setManagedClient(fake);
  const agentId = Number(
    run("INSERT INTO agents (name, title, platform, status, approval, api_token) VALUES ('Ziad', 'Tax Specialist', 'managed', 'idle', 'every_command', 'agt_chat')").lastInsertRowid,
  );
  const reply = (text) => () => [
    { type: 'session.status_running' },
    { type: 'agent.message', content: [{ type: 'text', text }] },
    { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
  ];
  const agentSaid = (text) => get("SELECT id FROM messages WHERE agent_id = ? AND sender = 'agent' AND body = ?", agentId, text);

  fake.script.push(reply('Hello!'));
  await managed.chatWithManagedAgent(agentId, 'Hi');
  await waitFor(() => agentSaid('Hello!'), 'first reply');
  await waitFor(() => get("SELECT status FROM runs WHERE kind = 'chat' AND agent_id = ?", agentId)?.status === 'waiting', 'turn over');

  // The chat's run is now "waiting". The next message must still be followed to its reply.
  fake.script.push(reply('Recurring task created.'));
  await managed.chatWithManagedAgent(agentId, 'Please make it recurring');
  await waitFor(() => agentSaid('Recurring task created.'), 'second reply');
});

test('late-picked-up replies keep their time, and Stop re-attaches to a chat Hive lost track of', async () => {
  const fake = fakeAnthropic();
  managed.setManagedClient(fake);
  const agentId = Number(
    run("INSERT INTO agents (name, title, platform, status, approval, api_token) VALUES ('Nour', 'Auditor', 'managed', 'idle', 'every_command', 'agt_stop')").lastInsertRowid,
  );
  const sql = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
  const earlier = new Date(Date.now() - 2 * 60 * 1000); // picked up two minutes late
  const started = new Date(Math.floor(Date.now() / 1000) * 1000);
  const justNow = new Date(started.getTime() - 2000); // live, but Anthropic's clock may differ from ours
  fake.script.push(() => [
    { type: 'session.status_running' },
    { type: 'agent.message', content: [{ type: 'text', text: 'Written earlier' }], processed_at: earlier.toISOString() },
    { type: 'agent.message', content: [{ type: 'text', text: 'Written live' }], processed_at: justNow.toISOString() },
    { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
  ]);
  await managed.chatWithManagedAgent(agentId, 'Hi');
  const said = (body) => waitFor(() => get('SELECT * FROM messages WHERE agent_id = ? AND body = ?', agentId, body), body);
  assert.equal((await said('Written earlier')).created_at, sql(earlier));
  // Fresh replies get Hive's own time, so clock drift can't put an answer above its question.
  assert.ok((await said('Written live')).created_at >= sql(started), 'stamped now, not 2 s ago');

  // The stream was lost mid-turn: the run says "running" but nobody is listening.
  const r = get("SELECT * FROM runs WHERE kind = 'chat' AND agent_id = ?", agentId);
  run("UPDATE runs SET status = 'running' WHERE id = ?", r.id);
  fake.script.push(() => [
    { type: 'agent.message', content: [{ type: 'text', text: 'Stopped as asked.' }] },
    { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
  ]);
  await managed.interruptRun(r.id);
  assert.equal(fake.calls.sent.at(-1).events[0].type, 'user.interrupt');
  await waitFor(() => get("SELECT id FROM messages WHERE agent_id = ? AND body = 'Stopped as asked.'", agentId), 'reply after stop');
  await waitFor(() => get('SELECT status FROM runs WHERE id = ?', r.id).status === 'waiting', 'run settles');
});

test('a chat moves to a fresh session, with the conversation so far, once its agent has changed', async () => {
  const fake = fakeAnthropic();
  managed.setManagedClient(fake);
  const { sendToAgent } = await import('./dispatch.js');
  const { addLesson } = await import('./lessons.js');
  const agentId = Number(
    run("INSERT INTO agents (name, title, platform, status, approval, api_token) VALUES ('Rami', 'Payroll', 'managed', 'idle', 'every_command', 'agt_ver')").lastInsertRowid,
  );
  const reply = (text) => () => [
    { type: 'agent.message', content: [{ type: 'text', text }] },
    { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
  ];
  const chat = () => get("SELECT * FROM runs WHERE kind = 'chat' AND agent_id = ? ORDER BY id DESC", agentId);
  const turn = async (text, answer) => {
    fake.script.push(reply(answer));
    await sendToAgent(agentId, text);
    await waitFor(() => get('SELECT id FROM messages WHERE agent_id = ? AND body = ?', agentId, answer), answer);
    await waitFor(() => chat().status === 'waiting', 'turn over');
  };

  await turn('Payroll runs on the 25th', 'Noted.');
  await turn('And bonuses?', 'Same day.');
  assert.equal(fake.calls.sessions.length, 1, 'unchanged agent: same session');

  // The agent changes (a new lesson is part of its instructions): the next message starts over.
  addLesson(agentId, 'Payroll is paid in AED.', { source: 'test' });
  const before = chat();
  await turn('What currency?', 'AED.');
  assert.equal(get('SELECT status FROM runs WHERE id = ?', before.id).status, 'ended');
  assert.equal(fake.calls.sessions.length, 2);
  assert.notEqual(chat().id, before.id);
  assert.equal(chat().agent_version, 2);
  const first = fake.calls.sent.at(-1).events[0].content[0].text;
  assert.match(first, /^\[Hive: you have been updated[\s\S]*User: Payroll runs on the 25th\n\nYou: Noted\.\n\nUser: And bonuses\?\n\nYou: Same day\.\n\n\[New message:\]\nWhat currency\?$/);

  // And it stays there while nothing changes.
  await turn('Thanks', 'Welcome.');
  assert.equal(fake.calls.sessions.length, 2);
  assert.equal(fake.calls.sent.at(-1).events[0].content[0].text, 'Thanks');
});
