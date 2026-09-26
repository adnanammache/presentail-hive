// Shared tasks for people and AI agents: assignment vs execution, drafts, projects, filters,
// blockers, attention and the Agent API after the stage migration.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

process.env.DB_PATH = ':memory:';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.SLACK_BOT_TOKEN;
delete process.env.OWNER_EMAILS;

const express = (await import('express')).default;
const { agentRouter, dashboardRouter, errorHandler } = await import('./app.js');
const { get, all, run, migrateStages } = await import('./db.js');
const { stopScheduler } = await import('./scheduler.js');

let base;
let server;
before(() => {
  const app = express();
  app.use(express.json());
  // Stand-in for Google sign-in: the test says who is asking.
  app.use((req, res, next) => {
    const email = req.get('x-user');
    if (email) req.user = { email, name: email.split('@')[0].replace(/^./, (c) => c.toUpperCase()) };
    next();
  });
  app.use('/api/agent', agentRouter());
  app.use('/api', dashboardRouter());
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
});
after(() => {
  stopScheduler();
  server.closeAllConnections();
  server.close();
});

const call = async (path, { method = 'GET', body, as = 'adnan@presentail.com', token, raw, headers = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), 'x-user': as, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, body: await res.json() };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// People sign in once (the first is the workspace owner); agents exist in Hive.
await call('/me', { as: 'adnan@presentail.com' });
await call('/me', { as: 'sara@presentail.com' });
await call('/me', { as: 'omar@presentail.com' });
const agentId = Number(run("INSERT INTO agents (name, title, platform, status, api_token) VALUES ('Finance agent', 'UAE Accountant', 'custom', 'idle', 'agt_fin')").lastInsertRowid);
const pausedId = Number(run("INSERT INTO agents (name, title, platform, status, api_token) VALUES ('Sleepy', 'Paused bot', 'custom', 'paused', 'agt_zz')").lastInsertRowid);
const briefs = (id) => all("SELECT body FROM messages WHERE agent_id = ? AND sender = 'system' AND body LIKE 'New task #%'", id);

test('1. an unassigned task without a project: created, nobody notified, nothing started', async () => {
  const { status, body: t } = await call('/tasks', { method: 'POST', body: { title: 'Collect receipts', status: 'backlog', client_key: 'k-1' } });
  assert.equal(status, 200);
  assert.equal(t.stage, 'backlog');
  assert.equal(t.assignee, null);
  assert.equal(t.project_id, null);
  assert.equal(t.created_by, 'adnan@presentail.com');
  assert.equal(get('SELECT COUNT(*) n FROM reminders WHERE task_id = ?', t.id).n, 0);
  assert.equal((await call('/tasks', { method: 'POST', body: { title: 'x', start: true } })).status, 400, 'nothing to start without an agent');
});

test('2. assigning a person notifies them (only them) and starts nothing', async () => {
  const { body: t } = await call('/tasks', { method: 'POST', body: { title: 'Confirm supplier balances', assignee: { type: 'user', email: 'omar@presentail.com' }, client_key: 'k-2' } });
  assert.deepEqual([t.assignee.type, t.assignee.email, t.assignee.name], ['user', 'omar@presentail.com', 'Omar']);
  assert.equal(t.stage, 'ready');
  const notes = all('SELECT * FROM reminders WHERE task_id = ?', t.id);
  assert.deepEqual(notes.map((n) => n.user_email), ['omar@presentail.com']);
  assert.match(notes[0].text, /Adnan assigned you "Confirm supplier balances"/);
  assert.equal((await call('/reminders', { as: 'omar@presentail.com' })).body.filter((r) => r.task_id === t.id).length, 1);
  assert.equal((await call('/reminders', { as: 'sara@presentail.com' })).body.filter((r) => r.task_id === t.id).length, 0, 'not in anyone else\'s Inbox');
  assert.equal(get('SELECT COUNT(*) n FROM runs WHERE task_id = ?', t.id).n, 0);
  // Unknown people and "both" are refused; one person or one agent.
  assert.equal((await call('/tasks', { method: 'POST', body: { title: 'x', assignee: { type: 'user', email: 'stranger@x.com' } } })).status, 400);
  assert.equal((await call('/tasks', { method: 'POST', body: { title: 'x', assignee: 'agent:99999' } })).status, 400);
});

test('3. saving an agent task does not start it; moving it between columns does not either', async () => {
  const before = briefs(agentId).length;
  const { body: t } = await call('/tasks', { method: 'POST', body: { title: 'Check expense categories', assignee: `agent:${agentId}`, client_key: 'k-3' } });
  assert.equal(t.assignee.type, 'agent');
  assert.equal(t.stage, 'ready');
  await call(`/tasks/${t.id}`, { method: 'PATCH', body: { status: 'in_progress' } });
  await call(`/tasks/${t.id}`, { method: 'PATCH', body: { status: 'ready' } });
  await wait(50);
  assert.equal(briefs(agentId).length, before, 'no task was sent to the agent');
});

test('4. "Create & start" creates the task and starts the agent explicitly', async () => {
  const before = briefs(agentId).length;
  const { body: t } = await call('/tasks', { method: 'POST', body: { title: 'Reconcile supplier invoices', assignee: `agent:${agentId}`, status: 'backlog', start: true, client_key: 'k-4' } });
  assert.equal(t.start.ok, true);
  assert.equal(t.stage, 'in_progress', 'starting decides the stage, whatever column was chosen');
  assert.equal(briefs(agentId).length, before + 1);
  assert.match(all('SELECT text FROM task_events WHERE task_id = ?', t.id).map((e) => e.text).join('\n'), /started Finance agent/);
});

test('5. a failed start keeps the task; retrying never duplicates the task or the start', async () => {
  const body = { title: 'Run the Talabat month-end', assignee: `agent:${pausedId}`, start: true, client_key: 'k-5' };
  const first = await call('/tasks', { method: 'POST', body });
  assert.equal(first.body.start.ok, false);
  assert.match(first.body.start.error, /paused/);
  assert.equal(first.body.blocker.kind, 'failed');
  assert.equal(first.body.stage, 'ready', 'the stage is kept, not reset or completed');

  // The same submission again (a double click, a retry): the same task.
  const again = await call('/tasks', { method: 'POST', body });
  assert.equal(again.body.id, first.body.id);
  assert.equal(get("SELECT COUNT(*) n FROM tasks WHERE client_key = 'k-5'").n, 1);

  run("UPDATE agents SET status = 'idle' WHERE id = ?", pausedId);
  const retry = await call(`/tasks/${first.body.id}/start`, { method: 'POST', body: { key: 'k-5' } });
  assert.equal(retry.body.start.ok, true);
  assert.equal(retry.body.blocker, null, 'the failure is cleared once it starts');
  const retryAgain = await call(`/tasks/${first.body.id}/start`, { method: 'POST', body: { key: 'k-5' } });
  assert.equal(retryAgain.body.start.already, true);
  assert.equal(briefs(pausedId).length, 1, 'started exactly once');
});

test('6. drafts: saved per person, files kept, restored after closing, cleared on submit or discard', async () => {
  assert.equal((await call('/task-draft', { as: 'sara@presentail.com' })).body.data, null);
  await call('/task-draft', { method: 'PUT', as: 'sara@presentail.com', body: { data: { title: 'Document closing checklist', priority: 'low' } } });
  const file = await call('/task-draft/files', { method: 'POST', as: 'sara@presentail.com', raw: Buffer.from('a,b'), headers: { 'x-filename': 'Discrepancies.csv' } });
  assert.equal(file.body.filename, 'Discrepancies.csv');
  // Reopening: the draft and its file come back; nobody else sees it; it's not a task.
  const restored = await call('/task-draft', { as: 'sara@presentail.com' });
  assert.equal(restored.body.data.title, 'Document closing checklist');
  assert.deepEqual(restored.body.files.map((f) => f.filename), ['Discrepancies.csv']);
  assert.equal((await call('/task-draft', { as: 'omar@presentail.com' })).body.data, null);
  assert.equal(get("SELECT COUNT(*) n FROM tasks WHERE title = 'Document closing checklist'").n, 0);

  const { body: t } = await call('/tasks', {
    method: 'POST', as: 'sara@presentail.com',
    body: { title: 'Document closing checklist', client_key: 'k-6', from_draft: true, draft_file_ids: [file.body.id], links: [{ url: 'https://example.com/guide', label: 'Guide' }] },
  });
  const files = all('SELECT * FROM task_files WHERE task_id = ?', t.id);
  assert.deepEqual(files.map((f) => f.filename), ['Discrepancies.csv']);
  assert.equal(readFileSync(files[0].path, 'utf8'), 'a,b');
  assert.equal(all('SELECT url FROM task_links WHERE task_id = ?', t.id)[0].url, 'https://example.com/guide');
  assert.equal((await call('/task-draft', { as: 'sara@presentail.com' })).body.data, null, 'submitted: the draft is gone');

  await call('/task-draft', { method: 'PUT', as: 'sara@presentail.com', body: { data: { title: 'Throwaway' } } });
  const f2 = await call('/task-draft/files', { method: 'POST', as: 'sara@presentail.com', raw: Buffer.from('x'), headers: { 'x-filename': 'x.txt' } });
  const path = get('SELECT path FROM draft_files WHERE id = ?', f2.body.id).path;
  await call('/task-draft', { method: 'DELETE', as: 'sara@presentail.com' });
  assert.equal((await call('/task-draft', { as: 'sara@presentail.com' })).body.data, null);
  assert.equal(existsSync(path), false, 'discarding removes its files');
});

let projectId;
test('7 & 11. projects: create, membership, authorization, favorites, archive', async () => {
  const { body: p } = await call('/projects', {
    method: 'POST', as: 'omar@presentail.com',
    body: { name: 'September month-end', description: 'Close September accounts.', due_date: '2026-09-30', members: [{ type: 'user', ref: 'sara@presentail.com' }, { type: 'agent', ref: agentId }] },
  });
  projectId = p.id;
  assert.equal(p.owner_email, 'omar@presentail.com', 'the creator owns it by default');
  assert.deepEqual(p.members.map((m) => [m.type, m.name]).sort(), [['agent', 'Finance agent'], ['user', 'Sara']]);
  assert.equal(p.health, null, 'no health is made up');

  // Members add tasks; people outside the project can't; the agent member is not started.
  const { body: t } = await call('/tasks', { method: 'POST', as: 'sara@presentail.com', body: { title: 'Verify warehouse adjustments', project_id: p.id } });
  assert.equal(t.project_name, 'September month-end');
  await call('/me', { as: 'lee@presentail.com' });
  assert.equal((await call('/tasks', { method: 'POST', as: 'lee@presentail.com', body: { title: 'x', project_id: p.id } })).status, 400);
  assert.equal(get('SELECT COUNT(*) n FROM runs WHERE agent_id = ?', agentId).n, 0);
  // Everyone can read the project's tasks; only members (and the task's people) can change them.
  assert.equal((await call(`/tasks/${t.id}`, { as: 'lee@presentail.com' })).status, 200);
  assert.equal((await call(`/tasks/${t.id}`, { method: 'PATCH', as: 'lee@presentail.com', body: { title: 'Hijacked' } })).status, 403);
  assert.equal((await call(`/tasks/${t.id}`, { method: 'DELETE', as: 'lee@presentail.com' })).status, 403);
  assert.equal((await call(`/tasks/${t.id}`, { method: 'PATCH', as: 'sara@presentail.com', body: { priority: 'high' } })).status, 200);

  // Only the owner (or a workspace owner) manages it.
  assert.equal((await call(`/projects/${p.id}`, { method: 'PATCH', as: 'sara@presentail.com', body: { name: 'Mine now' } })).status, 403);
  assert.equal((await call(`/projects/${p.id}`, { method: 'PATCH', as: 'omar@presentail.com', body: { health: 'on_track' } })).body.health, 'on_track');
  assert.equal((await call(`/projects/${p.id}`, { method: 'DELETE', as: 'sara@presentail.com' })).status, 403);

  // Favorites are per person.
  await call(`/projects/${p.id}/favorite`, { method: 'PUT', as: 'sara@presentail.com' });
  assert.equal((await call('/projects?favorites=1', { as: 'sara@presentail.com' })).body.length, 1);
  assert.equal((await call('/projects?favorites=1', { as: 'omar@presentail.com' })).body.length, 0);

  // Resources.
  const link = await call(`/projects/${p.id}/resources`, { method: 'POST', as: 'sara@presentail.com', body: { url: 'https://docs.example.com/guidelines', label: 'Finance guidelines' } });
  assert.equal(link.body.label, 'Finance guidelines');
  assert.equal((await call(`/projects/${p.id}/resources`, { method: 'POST', as: 'lee@presentail.com', body: { url: 'https://x.com' } })).status, 403);
  assert.equal((await call(`/projects/${p.id}/resources`, { method: 'POST', as: 'sara@presentail.com', body: { url: 'javascript:alert(1)' } })).status, 400);

  // Archiving keeps the tasks, hides them from All tasks, and stops new ones.
  const archived = await call('/projects', { method: 'POST', as: 'omar@presentail.com', body: { name: 'Old campaign' } });
  const { body: oldTask } = await call('/tasks', { method: 'POST', as: 'omar@presentail.com', body: { title: 'Old thing', project_id: archived.body.id } });
  await call(`/projects/${archived.body.id}`, { method: 'PATCH', as: 'omar@presentail.com', body: { status: 'archived' } });
  assert.ok(!(await call('/tasks')).body.some((x) => x.id === oldTask.id));
  assert.ok((await call(`/tasks?project_id=${archived.body.id}`)).body.some((x) => x.id === oldTask.id));
  assert.equal((await call('/tasks', { method: 'POST', as: 'omar@presentail.com', body: { title: 'x', project_id: archived.body.id } })).status, 400);
  assert.equal((await call('/projects?status=archived')).body[0].name, 'Old campaign');
  // Deleting a project keeps its tasks.
  await call(`/projects/${archived.body.id}`, { method: 'DELETE', as: 'omar@presentail.com' });
  assert.equal(get('SELECT project_id FROM tasks WHERE id = ?', oldTask.id).project_id, null);
});

test('8. filters across projects, assignee types, assignees, priority, due dates and search', async () => {
  const ids = (res) => res.body.tasks.map((t) => t.id);
  const { body: a } = await call('/tasks', { method: 'POST', body: { title: 'Filter: agent in project', assignee: `agent:${agentId}`, project_id: projectId, priority: 'urgent', due_date: '2020-01-01' } });
  const { body: b } = await call('/tasks', { method: 'POST', body: { title: 'Filter: person, no project', assignee: 'user:sara@presentail.com', priority: 'low' } });
  assert.ok(ids(await call(`/board?project_id=${projectId}`)).includes(a.id));
  assert.ok(!ids(await call(`/board?project_id=${projectId}`)).includes(b.id));
  assert.ok(ids(await call('/board?project_id=none')).includes(b.id));
  assert.ok((await call('/board?type=agents')).body.tasks.every((t) => t.assignee?.type === 'agent'));
  assert.ok((await call('/board?type=people')).body.tasks.every((t) => t.assignee?.type === 'user'));
  assert.deepEqual(ids(await call('/board?assignee=user:sara@presentail.com&q=Filter')), [b.id]);
  assert.deepEqual(ids(await call('/board?priority=urgent&q=Filter')), [a.id]);
  assert.deepEqual(ids(await call('/board?due=overdue&q=Filter')), [a.id]);
  assert.ok(ids(await call('/board?mine=1', { as: 'sara@presentail.com' })).includes(b.id));
  assert.ok(!ids(await call('/board?mine=1', { as: 'omar@presentail.com' })).includes(b.id));
});

test('9. stage changes and blockers persist separately; done clears the blocker', async () => {
  const { body: t } = await call('/tasks', { method: 'POST', body: { title: 'Blocker test', assignee: 'user:omar@presentail.com' } });
  await call(`/tasks/${t.id}`, { method: 'PATCH', body: { status: 'in_progress' } });
  const blocked = await call(`/tasks/${t.id}`, { method: 'PATCH', body: { blocked: { kind: 'info', reason: 'Waiting for stock count', owner: 'Sara' } } });
  assert.equal(blocked.body.stage, 'in_progress', 'still in progress while blocked');
  assert.deepEqual([blocked.body.blocker.kind, blocked.body.blocker.reason, blocked.body.blocker.owner], ['info', 'Waiting for stock count', 'Sara']);
  assert.equal((await call(`/tasks/${t.id}`, { method: 'PATCH', body: { status: 'review' } })).body.blocker.kind, 'info');
  assert.equal((await call(`/tasks/${t.id}`, { method: 'PATCH', body: { blocked: { kind: 'nope' } } })).status, 400);
  const done = await call(`/tasks/${t.id}`, { method: 'PATCH', body: { status: 'done' } });
  assert.equal(done.body.blocker, null);
  const history = all('SELECT text FROM task_events WHERE task_id = ? ORDER BY id', t.id).map((e) => e.text);
  assert.ok(history.includes('Moved to Needs review') && history.some((h) => /Waiting for information: Waiting for stock count/.test(h)));
  // Legacy "blocked" from older callers becomes a blocker, not a stage.
  const legacy = await call(`/tasks/${t.id}`, { method: 'PATCH', body: { status: 'blocked', result: 'Missing export' } });
  assert.equal(legacy.body.stage, 'done');
});

test('10. attention counts: review ownership, blocked and overdue', async () => {
  const before = {
    sara: (await call('/attention', { as: 'sara@presentail.com' })).body,
    omar: (await call('/attention', { as: 'omar@presentail.com' })).body,
  };
  // Sara creates a task for Omar; when it reaches Needs review it waits on Sara (the creator), not Omar.
  const { body: t } = await call('/tasks', { method: 'POST', as: 'sara@presentail.com', body: { title: 'Approve invoice adjustments', assignee: 'user:omar@presentail.com' } });
  await call(`/tasks/${t.id}`, { method: 'PATCH', as: 'omar@presentail.com', body: { status: 'review' } });
  let sara = (await call('/attention', { as: 'sara@presentail.com' })).body;
  let omar = (await call('/attention', { as: 'omar@presentail.com' })).body;
  assert.equal(sara.review_mine, before.sara.review_mine + 1);
  assert.equal(omar.review_mine, before.omar.review_mine);
  // Naming a reviewer moves it to them.
  await call(`/tasks/${t.id}`, { method: 'PATCH', body: { reviewer_email: 'omar@presentail.com' } });
  sara = (await call('/attention', { as: 'sara@presentail.com' })).body;
  omar = (await call('/attention', { as: 'omar@presentail.com' })).body;
  assert.equal(sara.review_mine, before.sara.review_mine);
  assert.equal(omar.review_mine, before.omar.review_mine + 1);
  const mine = await call('/board?attention=review_mine', { as: 'omar@presentail.com' });
  assert.ok(mine.body.tasks.some((x) => x.id === t.id));
  // Only the reviewer (or an owner) decides.
  assert.equal((await call(`/tasks/${t.id}/review`, { method: 'POST', as: 'sara@presentail.com', body: { decision: 'approve' } })).status, 403);
  assert.equal((await call(`/tasks/${t.id}/review`, { method: 'POST', as: 'omar@presentail.com', body: { decision: 'approve' } })).body.stage, 'done');

  // Overdue ignores done tasks; blocked counts open blocked tasks.
  const count = async () => (await call('/attention')).body;
  const c0 = await count();
  const { body: late } = await call('/tasks', { method: 'POST', body: { title: 'Late', due_date: '2020-02-02' } });
  assert.equal((await count()).overdue, c0.overdue + 1);
  await call(`/tasks/${late.id}`, { method: 'PATCH', body: { blocked: { kind: 'failed', reason: 'x' } } });
  assert.equal((await count()).blocked, c0.blocked + 1);
  await call(`/tasks/${late.id}`, { method: 'PATCH', body: { status: 'done' } });
  const c2 = await count();
  assert.equal(c2.overdue, c0.overdue);
  assert.equal(c2.blocked, c0.blocked);
  // Project-scoped.
  assert.equal(typeof (await call(`/attention?project_id=${projectId}`)).body.overdue, 'number');
});

test('reassigning while an agent is working is refused with a reason', async () => {
  const { body: t } = await call('/tasks', { method: 'POST', body: { title: 'Busy', assignee: `agent:${agentId}` } });
  run("INSERT INTO runs (kind, task_id, agent_id, status) VALUES ('task', ?, ?, 'running')", t.id, agentId);
  const res = await call(`/tasks/${t.id}`, { method: 'PATCH', body: { assignee: 'user:sara@presentail.com' } });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /working on this task right now/);
});

test('12. the Agent API after the stage migration: same vocabulary, blockers and progress', async () => {
  // Old rows as they were: "todo" and "blocked".
  const oldTodo = Number(run("INSERT INTO tasks (title, status, agent_id) VALUES ('Old todo', 'backlog', ?)", agentId).lastInsertRowid);
  run("UPDATE tasks SET status = 'todo' WHERE id = ?", oldTodo);
  const oldBlocked = Number(run("INSERT INTO tasks (title, status, agent_id, result) VALUES ('Old blocked', 'backlog', ?, 'Could not start: webhook down')", agentId).lastInsertRowid);
  run("UPDATE tasks SET status = 'blocked' WHERE id = ?", oldBlocked);
  run("DELETE FROM app_meta WHERE key = 'stages_v2'");
  migrateStages();
  assert.equal(get('SELECT status FROM tasks WHERE id = ?', oldTodo).status, 'ready');
  const b = get('SELECT * FROM tasks WHERE id = ?', oldBlocked);
  assert.deepEqual([b.status, b.blocked_kind, b.blocked_reason], ['ready', 'failed', 'Could not start: webhook down']);

  const token = 'agt_fin';
  const list = (await call('/agent/tasks', { token })).body;
  assert.equal(list.find((t) => t.id === oldTodo).status, 'todo');
  assert.equal(list.find((t) => t.id === oldBlocked).status, 'blocked');
  assert.equal(list.find((t) => t.id === oldTodo).stage, 'ready');

  const patched = await call(`/agent/tasks/${oldTodo}`, { method: 'PATCH', token, body: { status: 'in_progress', progress: { done: 42, total: 58, label: 'invoices matched' } } });
  assert.equal(patched.body.status, 'in_progress');
  assert.deepEqual(patched.body.progress, { done: 42, total: 58, label: 'invoices matched' });
  const stuck = await call(`/agent/tasks/${oldTodo}`, { method: 'PATCH', token, body: { status: 'blocked', result: 'Need the stock count' } });
  assert.equal(stuck.body.status, 'blocked');
  assert.equal(stuck.body.stage, 'in_progress');
  assert.equal(get('SELECT blocked_reason FROM tasks WHERE id = ?', oldTodo).blocked_reason, 'Need the stock count');
  const back = await call(`/agent/tasks/${oldTodo}`, { method: 'PATCH', token, body: { status: 'in_progress' } });
  assert.equal(back.body.status, 'in_progress', 'working again clears "waiting for information"');
  const done = await call(`/agent/tasks/${oldTodo}`, { method: 'PATCH', token, body: { status: 'done', result: 'All matched' } });
  assert.equal(done.body.status, 'done');
  const created = await call('/agent/tasks', { method: 'POST', token, body: { title: 'Self-assigned', status: 'todo' } });
  assert.equal(created.body.status, 'todo');
  assert.equal(get('SELECT status FROM tasks WHERE id = ?', created.body.id).status, 'ready');
});
