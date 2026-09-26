// The agent workspace: conversations (migration, privacy, paging, one session each), truthful status,
// stopping one run, tasks and lessons linked to the message they came from, and the Work overview.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'hive-ws-')), 'hive.db');
process.env.ANTHROPIC_API_KEY = 'test';
const { run, get, all, migrateChats } = await import('./db.js');
const { dashboardRouter, errorHandler } = await import('./app.js');
const managed = await import('./managed.js');
const events = await import('./events.js');
const { fakeAnthropic } = await import('./testing/fake-anthropic.js');

const waitFor = async (fn, what) => {
  for (let i = 0; i < 300; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

let server;
let fake;
const OWNER = 'owner@presentail.com';
const MEMBER = 'member@presentail.com';
const APPROVER = 'approver@presentail.com';
const url = (p) => `http://127.0.0.1:${server.address().port}/api${p}`;
const call = async (who, method, path, body) => {
  const res = await fetch(url(path), { method, headers: { 'x-as': who, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const agentId = () => Number(run("INSERT INTO agents (name, title, platform, status, api_token) VALUES (?, 'Tax', 'managed', 'idle', ?)", `Ziad ${Math.random()}`, `t${Math.random()}`).lastInsertRowid);
const idle = () => [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }];
const chatStatus = (aid, origin) => get("SELECT status FROM runs WHERE agent_id = ? AND kind = 'chat' AND origin = ?", aid, origin)?.status;

before(async () => {
  fake = fakeAnthropic();
  managed.setManagedClient(fake);
  const app = express().use(express.json()).use((req, res, next) => ((req.user = { email: req.get('x-as'), name: req.get('x-as') }), next())).use('/api', dashboardRouter()).use(errorHandler);
  server = app.listen(0);
  await call(OWNER, 'GET', '/me'); // first person: owner
  await call(MEMBER, 'GET', '/me');
  await call(APPROVER, 'GET', '/me');
  run("UPDATE users SET role = 'approver' WHERE email = ?", APPROVER);
});
after(() => server.close());

test('the one thread from before conversations becomes a shared conversation; nothing is lost', () => {
  const aid = agentId();
  run("INSERT INTO messages (agent_id, sender, body) VALUES (?, 'user', 'UAE VAT is due on the 28th, quarterly')", aid);
  run("INSERT INTO messages (agent_id, sender, body) VALUES (?, 'agent', 'Noted.')", aid);
  run(`INSERT INTO messages (agent_id, sender, body, meta) VALUES (?, 'user', 'From Slack', '{"origin":"slack:C1:1.2","email":"member@presentail.com"}')`, aid);
  migrateChats();
  migrateChats(); // idempotent
  const chats = all('SELECT * FROM chats WHERE agent_id = ? ORDER BY id', aid);
  assert.deepEqual(chats.map((c) => [c.origin, c.title, c.visibility]), [
    ['hive', 'UAE VAT is due on the 28th, quarterly', 'shared'],
    ['slack:C1:1.2', 'Slack: From Slack', 'shared'],
  ]);
  assert.equal(get('SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND chat_id IS NULL', aid).n, 0);
});

test('conversations are private to whoever started them; each has its own session; messages page', async () => {
  const aid = agentId();
  const mine = (await call(MEMBER, 'POST', `/agents/${aid}/chats`, {})).body;
  assert.equal(mine.visibility, 'private');
  fake.script.push(idle);
  assert.equal((await call(MEMBER, 'POST', `/chats/${mine.id}/messages`, { body: 'First question about VAT' })).status, 200);
  await waitFor(() => chatStatus(aid, `chat:${mine.id}`) === 'waiting', 'first turn');
  assert.equal((await call(MEMBER, 'GET', `/chats/${mine.id}`)).body.title, 'First question about VAT', 'titled from the first message');

  // Another member can't see it, send to it, list it, or read its messages; an owner can.
  const other = 'other@presentail.com';
  await call(other, 'GET', '/me');
  assert.equal((await call(other, 'GET', `/chats/${mine.id}/messages`)).status, 404);
  assert.equal((await call(other, 'POST', `/chats/${mine.id}/messages`, { body: 'hi' })).status, 404);
  assert.deepEqual((await call(other, 'GET', `/agents/${aid}/chats`)).body, []);
  assert.equal((await call(other, 'GET', `/agents/${aid}/messages`)).body.length, 0, 'the old endpoint hides it too');
  assert.equal((await call(other, 'PATCH', `/chats/${mine.id}`, { title: 'x' })).status, 404);
  assert.equal((await call(OWNER, 'GET', `/chats/${mine.id}/messages`)).status, 200);
  const agents = (await call(other, 'GET', '/agents')).body;
  assert.equal(agents.find((a) => a.id === aid).last_message, null, 'no preview of a private conversation');

  // A second conversation gets its own Claude session; nothing is copied between them.
  const second = (await call(MEMBER, 'POST', `/agents/${aid}/chats`, {})).body;
  fake.script.push(idle);
  await call(MEMBER, 'POST', `/chats/${second.id}/messages`, { body: 'Unrelated' });
  await waitFor(() => chatStatus(aid, `chat:${second.id}`) === 'waiting', 'second turn');
  const sessions = all("SELECT session_id FROM runs WHERE agent_id = ? AND kind = 'chat'", aid).map((r) => r.session_id);
  assert.equal(new Set(sessions).size, 2);
  assert.deepEqual((await call(MEMBER, 'GET', `/chats/${second.id}/messages`)).body.messages.map((m) => m.body), ['Unrelated']);

  // Rename and share.
  assert.equal((await call(MEMBER, 'PATCH', `/chats/${second.id}`, { title: 'Q3 filing', visibility: 'shared' })).body.title, 'Q3 filing');
  assert.equal((await call(other, 'GET', `/chats/${second.id}/messages`)).status, 200, 'shared: others can read it');

  // Paging: the latest page, then earlier ones.
  for (let i = 0; i < 7; i++) run("INSERT INTO messages (agent_id, sender, body, chat_id) VALUES (?, 'agent', ?, ?)", aid, `m${i}`, mine.id);
  const page = (await call(MEMBER, 'GET', `/chats/${mine.id}/messages?limit=3`)).body;
  assert.deepEqual(page.messages.map((m) => m.body), ['m4', 'm5', 'm6']);
  assert.equal(page.has_more, true);
  const earlier = (await call(MEMBER, 'GET', `/chats/${mine.id}/messages?limit=3&before=${page.messages[0].id}`)).body;
  assert.deepEqual(earlier.messages.map((m) => m.body), ['m1', 'm2', 'm3']);
  const newer = (await call(MEMBER, 'GET', `/chats/${mine.id}/messages?after=${page.messages[1].id}`)).body;
  assert.deepEqual(newer.messages.map((m) => m.body), ['m6']);
});

test('live updates carry ids only, never the text of a message', async () => {
  const aid = agentId();
  const seen = [];
  const res = { write: (s) => seen.push(s) };
  let hangUp;
  events.subscribe({ on: (_e, fn) => (hangUp = fn) }, { writeHead: () => {}, write: res.write });
  const chat = (await call(MEMBER, 'POST', `/agents/${aid}/chats`, {})).body;
  fake.script.push(idle);
  await call(MEMBER, 'POST', `/chats/${chat.id}/messages`, { body: 'secret payroll figures' });
  await waitFor(() => chatStatus(aid, `chat:${chat.id}`) === 'waiting', 'turn');
  hangUp();
  const sent = seen.join('');
  assert.match(sent, /"type":"message"/);
  assert.doesNotMatch(sent, /secret payroll/);
});

test('status: real runs and tasks, several at once, and "for you" only when it is', async () => {
  const aid = agentId();
  let s = (await call(MEMBER, 'GET', `/agents/${aid}/workspace`)).body.status;
  assert.deepEqual([s.config, s.label], ['enabled', 'Idle']);

  run("INSERT INTO runs (kind, agent_id, status) VALUES ('task', ?, 'running'), ('task', ?, 'running'), ('chat', ?, 'needs_approval')", aid, aid, aid);
  s = (await call(APPROVER, 'GET', `/agents/${aid}/workspace`)).body.status;
  assert.equal(s.label, '2 running · 1 waiting for your approval');
  s = (await call(MEMBER, 'GET', `/agents/${aid}/workspace`)).body.status;
  assert.equal(s.label, '2 running · 1 waiting for approval', 'a member cannot approve, so it is not theirs');

  // A task in review is "for you" only for whoever reviews it.
  run("UPDATE runs SET status = 'waiting' WHERE agent_id = ?", aid);
  run("INSERT INTO tasks (title, agent_id, status, created_by) VALUES ('Prepare VAT', ?, 'review', ?)", aid, MEMBER);
  assert.equal((await call(MEMBER, 'GET', `/agents/${aid}/workspace`)).body.status.label, 'Waiting for you');
  assert.equal((await call(APPROVER, 'GET', `/agents/${aid}/workspace`)).body.status.label, 'Waiting for review');

  run("UPDATE agents SET status = 'paused' WHERE id = ?", aid);
  assert.equal((await call(MEMBER, 'GET', `/agents/${aid}/workspace`)).body.status.config, 'paused');
});

test('stop affects that run only, and only for people who may see its conversation', async () => {
  const aid = agentId();
  const chat = (await call(MEMBER, 'POST', `/agents/${aid}/chats`, {})).body;
  fake.script.push(idle);
  await call(MEMBER, 'POST', `/chats/${chat.id}/messages`, { body: 'go' });
  await waitFor(() => chatStatus(aid, `chat:${chat.id}`) === 'waiting', 'turn');
  const runId = get("SELECT id FROM runs WHERE agent_id = ? AND kind = 'chat'", aid).id;
  const taskRun = Number(run("INSERT INTO runs (kind, agent_id, status, session_id) VALUES ('task', ?, 'running', 'sesn_other')", aid).lastInsertRowid);
  const sentBefore = fake.calls.sent.length;
  assert.equal((await call('other@presentail.com', 'POST', `/runs/${runId}/interrupt`)).status, 404);
  assert.equal((await call(MEMBER, 'POST', `/runs/${runId}/interrupt`)).status, 200);
  const interrupt = fake.calls.sent.slice(sentBefore);
  assert.equal(interrupt.length, 1);
  assert.equal(interrupt[0].events[0].type, 'user.interrupt');
  assert.equal(interrupt[0].sid, get('SELECT session_id FROM runs WHERE id = ?', runId).session_id);
  assert.equal(get('SELECT status FROM runs WHERE id = ?', taskRun).status, 'running', 'the task run is untouched');
  assert.notEqual(get('SELECT status FROM agents WHERE id = ?', aid).status, 'paused', 'the agent is not paused');
});

test('a task and a lesson made from a message keep their source; the overview shows them', async () => {
  const aid = agentId();
  const chat = (await call(OWNER, 'POST', `/agents/${aid}/chats`, {})).body;
  fake.script.push(idle);
  const msg = (await call(OWNER, 'POST', `/chats/${chat.id}/messages`, { body: 'Please prepare the September VAT report' })).body;
  await waitFor(() => chatStatus(aid, `chat:${chat.id}`) === 'waiting', 'turn');

  // Creating the task doesn't start anything.
  const runsBefore = get('SELECT COUNT(*) AS n FROM runs WHERE agent_id = ?', aid).n;
  const task = (await call(OWNER, 'POST', '/tasks', { title: 'Prepare September VAT report', assignee: `agent:${aid}`, source_message_id: msg.id, client_key: 'k-ws-1' })).body;
  assert.equal(task.source_chat_id, chat.id);
  assert.equal(get('SELECT COUNT(*) AS n FROM runs WHERE agent_id = ?', aid).n, runsBefore, 'no run started');
  assert.equal((await call('other@presentail.com', 'POST', '/tasks', { title: 'x', source_message_id: msg.id })).status, 400, "can't link a message you can't see");

  run('INSERT INTO task_files (task_id, filename, path, size) VALUES (?, ?, ?, ?)', task.id, 'VAT checklist.pdf', '/nope', 10);
  run("INSERT INTO tasks (title, agent_id, status, due_date) VALUES ('File UAE VAT', ?, 'ready', '2099-09-28')", aid);
  const ws = (await call(OWNER, 'GET', `/agents/${aid}/workspace?chat_id=${chat.id}`)).body;
  assert.deepEqual(ws.current_tasks.map((t) => t.title), ['Prepare September VAT report']);
  assert.deepEqual(ws.upcoming.map((u) => [u.title, u.at_kind, u.at]), [['File UAE VAT', 'due', '2099-09-28']]);
  assert.equal(ws.files.scope, 'conversation');
  assert.deepEqual(ws.files.items.map((f) => f.filename), ['VAT checklist.pdf']);
  const elsewhere = (await call(OWNER, 'GET', `/agents/${aid}/workspace`)).body;
  assert.deepEqual(elsewhere.current_tasks, [], 'no guessing without a conversation');

  // Save as lesson: reviewed text, a title, and where it came from.
  const lesson = (await call(OWNER, 'POST', `/agents/${aid}/lessons`, { title: 'VAT report', text: 'Prepare the VAT report from Wafeq sales.', message_id: msg.id })).body;
  assert.deepEqual([lesson.title, lesson.source, lesson.chat_id, lesson.message_id], ['VAT report', 'chat', chat.id, msg.id]);
  assert.equal((await call(MEMBER, 'POST', `/agents/${aid}/lessons`, { text: 'x', message_id: msg.id })).status, 403);
});

test('a chat that cannot start is marked failed, so the agent does not look busy', async () => {
  const aid = agentId();
  const chat = (await call(OWNER, 'POST', `/agents/${aid}/chats`, {})).body;
  const create = fake.beta.sessions.create;
  fake.beta.sessions.create = async () => {
    throw new Error('Anthropic is unreachable');
  };
  await call(OWNER, 'POST', `/chats/${chat.id}/messages`, { body: 'hello' });
  await waitFor(() => chatStatus(aid, `chat:${chat.id}`) === 'failed', 'failed run');
  assert.equal((await call(OWNER, 'GET', `/agents/${aid}/workspace`)).body.status.label, 'Idle');
  fake.beta.sessions.create = create;
});
