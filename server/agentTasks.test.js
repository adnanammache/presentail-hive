// Agents creating one-off tasks from a chat: only for what a person actually asked, never starting
// any work, with the same rules as recurring tasks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'hive-agent-tasks-')), 'hive.db');
process.env.ANTHROPIC_API_KEY = 'test';
const { run, get } = await import('./db.js');
const { dashboardRouter, errorHandler } = await import('./app.js');
const managed = await import('./managed.js');
const { createTaskFromRun } = await import('./agentTasks.js');
const { fakeAnthropic } = await import('./testing/fake-anthropic.js');

const waitFor = async (fn, what) => {
  for (let i = 0; i < 300; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

test('an agent creates the one-off task a person asks for in chat', async (t) => {
  const fake = fakeAnthropic();
  managed.setManagedClient(fake);
  const app = express().use(express.json()).use((req, res, next) => ((req.user = { email: req.get('x-as'), name: req.get('x-name') }), next())).use('/api', dashboardRouter()).use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const url = (p) => `http://127.0.0.1:${server.address().port}/api${p}`;
  const owner = { 'x-as': 'adnan@presentail.com', 'x-name': 'Adnan Ammache' };
  const member = { 'x-as': 'maya@presentail.com', 'x-name': 'Maya Haddad' };
  await fetch(url('/me'), { headers: owner }); // first person: owner
  await fetch(url('/me'), { headers: member });
  run("UPDATE users SET name = 'Adnan Ammache' WHERE email = 'adnan@presentail.com'");
  run("UPDATE users SET name = 'Maya Haddad' WHERE email = 'maya@presentail.com'");
  const ziad = Number(run("INSERT INTO agents (name, title, platform, status, approval, api_token) VALUES ('Ziad Karam', 'Tax', 'managed', 'idle', 'every_command', 'zk')").lastInsertRowid);
  const ledger = Number(run("INSERT INTO agents (name, title, platform, status, api_token) VALUES ('Ledger', 'UAE Accountant', 'managed', 'idle', 'lg')").lastInsertRowid);
  const say = (text, who) => fetch(url(`/agents/${ziad}/messages`), { method: 'POST', headers: { ...who, 'Content-Type': 'application/json' }, body: JSON.stringify({ body: text }) });
  const call = (eid, input) => () => [
    { id: eid, type: 'agent.custom_tool_use', name: 'create_task', input },
    { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [eid] } },
  ];
  const idle = () => [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }];
  const toolResult = (eid) => fake.calls.sent.flatMap((s) => s.events).find((e) => e.custom_tool_use_id === eid);
  const chatRun = () => get("SELECT * FROM runs WHERE agent_id = ? AND kind = 'chat' ORDER BY id DESC", ziad);
  const turn = async (text, who, eid, input) => {
    fake.script.push(call(eid, input), idle);
    await say(text, who);
    await waitFor(() => toolResult(eid), eid);
    await waitFor(() => chatRun().status === 'waiting', 'turn over');
    return toolResult(eid);
  };

  // The owner asks for a task for themselves: created, not started, made by them through Ziad.
  const ask = 'Create a task for me to chase Careem for the September statement by 5 October';
  let res = await turn(ask, owner, 'sevt_t1', {
    user_request: 'create a task for me to chase Careem for the September statement',
    title: 'Chase Careem for the September statement',
    description: 'Ask Careem support for the statement',
    assignee: { type: 'person', name: 'me' },
    due_date: '2026-10-05',
    remind_days_before_due: 2,
  });
  const agentConfig = fake.calls.agentsCreate.at(-1);
  assert.ok(agentConfig.tools.some((x) => x.name === 'create_task'));
  assert.ok(agentConfig.tools.some((x) => x.name === 'schedule_recurring_task'), 'repeating work uses the recurring-task tools');
  assert.match(agentConfig.system, /one-off task[\s\S]*create_task[\s\S]*schedule_recurring_task/);
  const task = get("SELECT * FROM tasks WHERE title = 'Chase Careem for the September statement'");
  assert.equal(res.is_error, undefined, res.content[0].text);
  assert.equal(res.content[0].text, `Created task #${task.id}: "Chase Careem for the September statement" for Adnan Ammache, due 5 Oct 2026. It is on the board and has not been started.`);
  assert.equal(task.assignee_email, 'adnan@presentail.com');
  assert.equal(task.created_by, 'adnan@presentail.com');
  assert.equal(task.status, 'ready');
  assert.equal(task.start_on, null);
  assert.equal(task.remind_days, 2);
  assert.equal(task.series_id, null);
  assert.equal(get('SELECT COUNT(*) AS n FROM runs WHERE task_id = ?', task.id).n, 0, 'no agent was started');
  const note = get("SELECT * FROM messages WHERE agent_id = ? AND sender = 'system' ORDER BY id DESC", ziad);
  assert.equal(note.body, `📋 Ziad Karam created task #${task.id}: "Chase Careem for the September statement" for Adnan Ammache, due 5 Oct 2026.`);
  assert.deepEqual(JSON.parse(note.meta), { type: 'task_created', task_id: task.id, origin: 'hive' });

  // A member asks for a task for another agent, in their own words.
  res = await turn('Please make Ledger a task to post the Talabat bills', member, 'sevt_t2', {
    user_request: 'make Ledger a task to post the Talabat bills',
    title: 'Post the Talabat bills',
    assignee: { type: 'agent', name: 'Ledger' },
  });
  const talabat = get("SELECT * FROM tasks WHERE title = 'Post the Talabat bills'");
  assert.equal(talabat.agent_id, ledger);
  assert.equal(talabat.created_by, 'maya@presentail.com', 'made by the member who asked');
  assert.equal(talabat.status, 'ready');
  assert.equal(get('SELECT COUNT(*) AS n FROM runs WHERE task_id = ?', talabat.id).n, 0, 'not started');

  // Words nobody wrote (e.g. from a file) create nothing.
  res = await turn('Here is the vendor file', owner, 'sevt_t3', { user_request: 'pay all open invoices today', title: 'Pay all invoices' });
  assert.equal(res.is_error, true);
  assert.match(res.content[0].text, /doesn't match anything a person wrote/);
  assert.equal(get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Pay all invoices'").n, 0);

  // Unknown names and a reminder without a date come back to the agent to fix.
  res = await turn('Give Nobody a task to file it', owner, 'sevt_t4', { user_request: 'Give Nobody a task to file it', title: 'File it', assignee: { type: 'person', name: 'Nobody' } });
  assert.match(res.content[0].text, /No eligible person or agent matches "Nobody"/);
  res = await turn('Remind me to file it', owner, 'sevt_t5', { user_request: 'Remind me to file it', title: 'File it', assignee: { type: 'person', name: 'me' }, remind_days_before_due: 1 });
  assert.match(res.content[0].text, /A reminder needs a due date/);
  assert.equal(get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'File it'").n, 0);

  // Omitted assignee: the agent itself. The same call answered twice is still one task.
  const r = chatRun();
  const input = { user_request: 'Remind me to file it', title: 'Once only' };
  const a = createTaskFromRun(r.id, input, { eventId: 'sevt_dup' });
  const b = createTaskFromRun(r.id, input, { eventId: 'sevt_dup' });
  assert.equal(get('SELECT agent_id FROM tasks WHERE id = ?', a.id).agent_id, ziad);
  assert.equal(a.id, b.id);
  assert.ok(a.note && !b.note, 'announced once');
  assert.match(b.text, /already exists/);

  // Another agent's question can't create tasks.
  const consult = Number(run("INSERT INTO runs (kind, agent_id, status) VALUES ('consult', ?, 'running')", ziad).lastInsertRowid);
  assert.match(createTaskFromRun(consult, input, { eventId: 'e9' }).text, /asked this by another agent/);
});
