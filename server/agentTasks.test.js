// Agents creating tasks from a chat: straight away for owners and approvers, approved otherwise,
// and never starting any work by themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'hive-agent-tasks-')), 'hive.db');
process.env.ANTHROPIC_API_KEY = 'test';
const { run, get, all } = await import('./db.js');
const { dashboardRouter, errorHandler } = await import('./app.js');
const managed = await import('./managed.js');
const { planTask, createPlannedTask } = await import('./agentTasks.js');
const { fakeAnthropic } = await import('./testing/fake-anthropic.js');

const waitFor = async (fn, what) => {
  for (let i = 0; i < 300; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

test('an agent creates the task it is asked for in chat', async (t) => {
  const fake = fakeAnthropic();
  managed.setManagedClient(fake);
  const app = express().use(express.json()).use((req, res, next) => ((req.user = { email: req.get('x-as'), name: req.get('x-name') }), next())).use('/api', dashboardRouter()).use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const url = (p) => `http://127.0.0.1:${server.address().port}/api${p}`;
  const owner = { 'x-as': 'adnan@presentail.com', 'x-name': 'Adnan Ammache' };
  const member = { 'x-as': 'maya@presentail.com', 'x-name': 'Maya' };
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
  const chatRun = () => get("SELECT * FROM runs WHERE agent_id = ? AND kind = 'chat'", ziad);

  // The agent knows it can, and is told never to claim a task it didn't create.
  managed.setManagedClient(fake);
  fake.script.push(call('sevt_t1', { title: 'Prepare UAE VAT documents', description: 'Wafeq exports for the quarter', assignee: 'me', due_date: '2026-10-28', repeat: 'quarterly', remind_days: 7 }), idle);
  await say('Create a recurring task for me to prepare the UAE VAT documents, due the 28th after each quarter', owner);
  await waitFor(() => toolResult('sevt_t1'), 'task created');
  const tools = fake.calls.agentsCreate.at(-1).tools.map((x) => x.name).filter(Boolean);
  assert.ok(tools.includes('create_task'));
  assert.match(fake.calls.agentsCreate.at(-1).system, /create_task[\s\S]*Never say a task exists/);

  // Asked by the owner: created straight away, for them, repeating, and not started.
  const task = get("SELECT * FROM tasks WHERE title = 'Prepare UAE VAT documents'");
  assert.equal(task.assignee_email, 'adnan@presentail.com');
  assert.equal(task.agent_id, null);
  assert.equal(task.due_date, '2026-10-28');
  assert.equal(task.remind_days, 7);
  assert.equal(task.status, 'ready');
  assert.equal(task.start_on, null, 'an agent-made task never starts itself');
  const series = get('SELECT * FROM task_series WHERE id = ?', task.series_id);
  assert.deepEqual(JSON.parse(series.rule), { freq: 'quarterly' });
  assert.equal(series.auto_start, 0);
  assert.match(toolResult('sevt_t1').content[0].text, new RegExp(`^Created task #${task.id}: "Prepare UAE VAT documents" for Adnan Ammache, due 28 Oct 2026, quarterly`));
  const note = get("SELECT * FROM messages WHERE agent_id = ? AND sender = 'system' ORDER BY id DESC", ziad);
  assert.match(note.body, new RegExp(`^📋 Ziad Karam created task #${task.id}`));
  assert.deepEqual(JSON.parse(note.meta), { type: 'task_created', task_id: task.id, origin: 'hive' });
  await waitFor(() => chatRun().status === 'waiting', 'turn over');

  // Asked by a member: it waits for an approver, shown in the chat.
  fake.script.push(call('sevt_t2', { title: 'Chase Careem statement', assignee: 'Ledger', due_date: '2026-10-05', reason: 'Maya asked' }));
  await say('Can you make a task for Ledger to chase the Careem statement by 5 Oct?', member);
  await waitFor(() => chatRun().status === 'needs_approval', 'approval asked');
  assert.equal(get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Chase Careem statement'").n, 0);
  const ask = get("SELECT * FROM messages WHERE agent_id = ? AND sender = 'system' ORDER BY id DESC", ziad);
  assert.match(ask.body, /^Approval needed: create a task, "Chase Careem statement" for Ledger, due 5 Oct 2026\nMaya asked$/);
  assert.equal(JSON.parse(ask.meta).type, 'approval');
  const confirm = (who, eid, result) =>
    fetch(url(`/runs/${chatRun().id}/confirm`), { method: 'POST', headers: { ...who, 'Content-Type': 'application/json' }, body: JSON.stringify({ event_id: eid, result }) });
  assert.equal((await confirm(member, 'sevt_t2', 'allow')).status, 403, 'members cannot approve');
  fake.script.push(idle);
  assert.equal((await confirm(owner, 'sevt_t2', 'allow')).status, 200);
  await waitFor(() => toolResult('sevt_t2'), 'approved task created');
  const chase = get("SELECT * FROM tasks WHERE title = 'Chase Careem statement'");
  assert.equal(chase.agent_id, ledger);
  assert.equal(chase.status, 'ready', 'on the board, not started');
  assert.equal(get("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?", chase.id).n, 0);
  assert.match(get("SELECT body FROM messages WHERE agent_id = ? AND sender = 'system' ORDER BY id DESC", ziad).body, /\(approved by Adnan Ammache\)\.$/);
  await waitFor(() => chatRun().status === 'waiting', 'turn over');

  // Rejected: nothing is created and the agent is told.
  fake.script.push(call('sevt_t3', { title: 'Delete old bills', assignee: 'you' }));
  await say('Make yourself a task to delete old bills', member);
  await waitFor(() => chatRun().status === 'needs_approval', 'second approval');
  fake.script.push(idle);
  await confirm(owner, 'sevt_t3', 'deny');
  await waitFor(() => toolResult('sevt_t3'), 'rejection sent');
  assert.equal(toolResult('sevt_t3').is_error, true);
  assert.match(toolResult('sevt_t3').content[0].text, /^Rejected by Adnan Ammache\. No task was created\./);
  assert.equal(get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Delete old bills'").n, 0);
  await waitFor(() => chatRun().status === 'waiting', 'turn over');

  // Bad requests come back to the agent to fix, and create nothing.
  fake.script.push(call('sevt_t4', { title: 'Monthly thing', repeat: 'monthly' }), idle);
  await say('Make it monthly', owner);
  await waitFor(() => toolResult('sevt_t4'), 'error sent');
  assert.equal(toolResult('sevt_t4').is_error, true);
  assert.match(toolResult('sevt_t4').content[0].text, /needs its first due date/);
  assert.equal(get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Monthly thing'").n, 0);

  // Direct checks: who "me", "you", names and emails mean, and what's refused.
  const r = chatRun();
  assert.equal(planTask(r, { title: 'x', assignee: 'Nobody Here' }, 'e1').error, 'There is no one called "Nobody Here" in Hive. Use "me", "you", an agent\'s name, or a colleague\'s name or email.');
  assert.deepEqual(planTask(r, { title: 'x', assignee: 'you' }, 'e2').body.assignee, { type: 'agent', id: ziad });
  assert.deepEqual(planTask(r, { title: 'x', assignee: 'Maya' }, 'e3').body.assignee, { type: 'user', email: 'maya@presentail.com' });
  assert.deepEqual(planTask(r, { title: 'x', assignee: 'MAYA@presentail.com' }, 'e4').body.assignee, { type: 'user', email: 'maya@presentail.com' });
  assert.match(planTask(r, { title: 'x', due_date: '28/10/2026' }, 'e5').error, /due_date must be a date/);
  assert.match(planTask({ ...r, kind: 'consult' }, { title: 'x' }, 'e6').error, /cannot create tasks here/);
  assert.equal(planTask(r, { title: 'x', assignee: 'you' }, 'e7').body.start_on, undefined);

  // The same call answered twice (e.g. after a restart) is still one task.
  const plan = planTask(r, { title: 'Once only', assignee: 'you' }, 'sevt_dup');
  const a = createPlannedTask(r, plan.body, plan.summary);
  const b = createPlannedTask(r, plan.body, plan.summary);
  assert.equal(a.id, b.id);
  assert.ok(a.note && !b.note, 'announced once');
  assert.match(b.text, /already exists/);
  assert.equal(get("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Once only'").n, 1);
  assert.ok(all('SELECT id FROM tasks').length >= 3);
});
