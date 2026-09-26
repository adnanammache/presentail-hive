// Conversation history and archiving: per-person archive state, resurfacing only on new qualifying
// events, unread counts, search and paging, the work waiting in a conversation, approvals tied to the
// version reviewed, and file references and previews checked against access.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const dir = mkdtempSync(join(tmpdir(), 'hive-archive-'));
process.env.DB_PATH = join(dir, 'hive.db');
const { run, get, all } = await import('./db.js');
const { dashboardRouter, errorHandler } = await import('./app.js');
const { postMessage } = await import('./dispatch.js');

let server;
const OWNER = 'owner@presentail.com';
const MEMBER = 'member@presentail.com';
const OTHER = 'other@presentail.com';
const APPROVER = 'approver@presentail.com';
const url = (p) => `http://127.0.0.1:${server.address().port}/api${p}`;
const call = async (who, method, path, body) => {
  const res = await fetch(url(path), { method, headers: { 'x-as': who, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
};
// A webhook-less custom agent: messages are stored and nothing is sent anywhere.
const agentId = () => Number(run("INSERT INTO agents (name, title, platform, status, api_token) VALUES (?, 'Tax', 'custom', 'idle', ?)", `Ziad ${Math.random()}`, `t${Math.random()}`).lastInsertRowid);
const newChat = async (who, aid, visibility) => {
  const c = (await call(who, 'POST', `/agents/${aid}/chats`, {})).body;
  if (visibility) await call(who, 'PATCH', `/chats/${c.id}`, { visibility });
  return c;
};
const say = (who, chatId, body, extra = {}) => call(who, 'POST', `/chats/${chatId}/messages`, { body, ...extra });
const origin = (chatId) => get('SELECT origin FROM chats WHERE id = ?', chatId).origin;
const history = async (who, aid, qs = '') => (await call(who, 'GET', `/agents/${aid}/conversations${qs}`)).body;
const ids = (page) => page.chats.map((c) => c.id);

before(async () => {
  const names = { [MEMBER]: 'Maya Haddad' };
  const app = express().use(express.json()).use((req, res, next) => ((req.user = { email: req.get('x-as'), name: names[req.get('x-as')] ?? req.get('x-as').split('@')[0] }), next())).use('/api', dashboardRouter()).use(errorHandler);
  server = app.listen(0);
  for (const who of [OWNER, MEMBER, OTHER, APPROVER]) await call(who, 'GET', '/me'); // first: owner
  run("UPDATE users SET role = 'approver' WHERE email = ?", APPROVER);
});
after(() => server.close());

test('history: active by activity, archived by archive time, search, paging; private stays private', async () => {
  const aid = agentId();
  const a = await newChat(MEMBER, aid);
  await say(MEMBER, a.id, 'Supplier balances for August');
  const b = await newChat(MEMBER, aid);
  await say(MEMBER, b.id, 'Branch mapping question');
  const c = await newChat(MEMBER, aid);
  await say(MEMBER, c.id, 'VAT return for Q3');
  run("UPDATE chats SET last_message_at = '2026-09-01 10:00:00' WHERE id = ?", a.id);
  run("UPDATE chats SET last_message_at = '2026-09-02 10:00:00' WHERE id = ?", b.id);
  run("UPDATE chats SET last_message_at = '2026-09-03 10:00:00' WHERE id = ?", c.id);

  let page = await history(MEMBER, aid, '?limit=2');
  assert.deepEqual(ids(page), [c.id, b.id]);
  assert.ok(page.next_cursor);
  page = await history(MEMBER, aid, `?limit=2&cursor=${page.next_cursor}`);
  assert.deepEqual(ids(page), [a.id]);
  assert.equal(page.next_cursor, null);
  assert.equal(page.chats[0].preview.text, 'Supplier balances for August');
  assert.equal(page.chats[0].audience.label, 'Private: you and workspace owners');

  // Search matches titles and message text, within the chosen filter.
  const found = await history(MEMBER, aid, '?q=mapping');
  assert.deepEqual(ids(found), [b.id]);
  assert.equal(found.chats[0].preview.match, true);
  assert.equal((await history(MEMBER, aid, `?q=${encodeURIComponent('100%')}`)).chats.length, 0, 'LIKE wildcards are literal');

  // Archive order is by archive time, not activity; archiving never changes activity.
  await call(MEMBER, 'POST', `/chats/${c.id}/archive`);
  run("UPDATE chat_user_state SET archived_at = '2026-09-10 00:00:00' WHERE chat_id = ?", c.id);
  await call(MEMBER, 'POST', `/chats/${a.id}/archive`);
  assert.deepEqual(ids(await history(MEMBER, aid, '?filter=archived')), [a.id, c.id]);
  assert.deepEqual(ids(await history(MEMBER, aid)), [b.id]);
  assert.deepEqual(ids(await history(MEMBER, aid, '?filter=all')), [c.id, b.id, a.id]);
  assert.equal(get('SELECT last_message_at FROM chats WHERE id = ?', c.id).last_message_at, '2026-09-03 10:00:00');
  assert.deepEqual(ids(await history(MEMBER, aid, '?filter=archived&q=VAT')), [c.id], 'search within archived');
  assert.deepEqual(ids(await history(MEMBER, aid, '?q=VAT')), [], 'search within active');

  // Another member sees none of it, even by searching message text; an owner sees them.
  assert.deepEqual(ids(await history(OTHER, aid, '?filter=all&q=VAT')), []);
  assert.equal((await call(OTHER, 'POST', `/chats/${b.id}/archive`)).status, 404);
  assert.equal((await history(OWNER, aid, '?filter=all')).chats.length, 3);
});

test('archiving is per person and changes nothing else; restore, Undo and repeats are safe', async () => {
  const aid = agentId();
  const chat = await newChat(MEMBER, aid, 'shared');
  await say(MEMBER, chat.id, 'Prepare the reconciliation');
  const taskId = Number(run("INSERT INTO tasks (title, status, agent_id, source_chat_id, created_by) VALUES ('Reconcile', 'in_progress', ?, ?, ?)", aid, chat.id, MEMBER).lastInsertRowid);
  const runId = Number(run("INSERT INTO runs (kind, agent_id, status, origin) VALUES ('chat', ?, 'waiting', ?)", aid, origin(chat.id)).lastInsertRowid);
  const wf = Number(run("INSERT INTO workflows (name, agent_id, schedule, status, next_run_at) VALUES ('Weekly', ?, '0 9 * * 1', 'active', '2026-10-01T05:00:00Z')", aid).lastInsertRowid);
  run("INSERT INTO agent_lessons (agent_id, text, chat_id) VALUES (?, 'Use 5104', ?)", aid, chat.id);
  const snapshot = () => JSON.stringify({
    chat: get('SELECT * FROM chats WHERE id = ?', chat.id),
    messages: all('SELECT id, body FROM messages WHERE chat_id = ?', chat.id),
    task: get('SELECT status, blocked_kind, completed_at FROM tasks WHERE id = ?', taskId),
    run: get('SELECT status FROM runs WHERE id = ?', runId),
    wf: get('SELECT status, next_run_at FROM workflows WHERE id = ?', wf),
    lessons: all('SELECT id, active FROM agent_lessons WHERE chat_id = ?', chat.id),
  });
  const before = snapshot();

  const archived = await call(MEMBER, 'POST', `/chats/${chat.id}/archive`);
  assert.equal(archived.status, 200);
  assert.equal(archived.body.archived, true);
  assert.equal(archived.body.changed, true);
  const again = await call(MEMBER, 'POST', `/chats/${chat.id}/archive`);
  assert.equal(again.body.changed, false, 'archiving twice is a no-op');
  assert.equal(again.body.archived_at, archived.body.archived_at);
  assert.equal(snapshot(), before, 'messages, task, run, schedule, lessons and sharing untouched');

  // Readable by link; sending is refused until restored, and the refusal sends nothing.
  assert.equal((await call(MEMBER, 'GET', `/chats/${chat.id}`)).body.archived, true);
  assert.equal((await call(MEMBER, 'GET', `/chats/${chat.id}/messages`)).status, 200);
  const n = get('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?', chat.id).n;
  const refused = await say(MEMBER, chat.id, 'hello?');
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Restore it to continue/);
  assert.equal(get('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?', chat.id).n, n);
  assert.equal((await call(MEMBER, 'POST', `/agents/${aid}/messages`, { chat_id: chat.id, body: 'old route' })).status, 409);

  // The other participant still has it in their active history and can keep chatting (which, being
  // a new message from someone else, brings it back for the person who archived it).
  assert.ok(ids(await history(OTHER, aid)).includes(chat.id));
  assert.equal((await say(OTHER, chat.id, 'I can still write here')).status, 200);
  const back = (await call(MEMBER, 'GET', `/chats/${chat.id}`)).body;
  assert.equal(back.archived, false);
  assert.equal(back.resurfaced.reason, 'message');
  const archived2 = await call(MEMBER, 'POST', `/chats/${chat.id}/archive`);

  // A stale Undo (from an earlier archive) changes nothing; the right one restores; restoring twice is a no-op.
  const seq = archived2.body.archive_seq;
  assert.ok(seq > archived.body.archive_seq);
  const stale = await call(MEMBER, 'POST', `/chats/${chat.id}/restore`, { seq: archived.body.archive_seq });
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.archived, true);
  const undo = await call(MEMBER, 'POST', `/chats/${chat.id}/restore`, { seq });
  assert.equal(undo.body.archived, false);
  assert.equal(undo.body.changed, true);
  assert.equal((await call(MEMBER, 'POST', `/chats/${chat.id}/restore`)).body.changed, false);
  assert.equal(ids(await history(MEMBER, aid)).filter((id) => id === chat.id).length, 1, 'restored once, not duplicated');
  assert.equal((await say(MEMBER, chat.id, 'back again')).status, 200);
  assert.equal(get('SELECT id FROM chats WHERE id = ?', chat.id).id, chat.id, 'same conversation id: links keep working');
});

test('archiving with work going on asks first, naming what continues; idle conversations don’t', async () => {
  const aid = agentId();
  const idle = await newChat(MEMBER, aid);
  await say(MEMBER, idle.id, 'Thanks, that is all');
  assert.equal((await call(MEMBER, 'POST', `/chats/${idle.id}/archive`)).status, 200);

  const busy = await newChat(MEMBER, aid);
  await say(MEMBER, busy.id, 'Run the checks');
  const runId = Number(run("INSERT INTO runs (kind, agent_id, status, origin) VALUES ('chat', ?, 'running', ?)", aid, origin(busy.id)).lastInsertRowid);
  const warned = await call(MEMBER, 'POST', `/chats/${busy.id}/archive`);
  assert.equal(warned.status, 409);
  assert.match(warned.body.warnings[0], /still working here.*will continue/);
  assert.equal((await call(MEMBER, 'GET', `/chats/${busy.id}`)).body.archived, false, 'not archived until confirmed');
  const forced = await call(MEMBER, 'POST', `/chats/${busy.id}/archive`, { force: true });
  assert.equal(forced.body.archived, true);
  assert.equal(get('SELECT status FROM runs WHERE id = ?', runId).status, 'running', 'the run carries on');
});

test('resurfacing: a new message from someone else, a mention or a new request, once each; never the agent’s replies', async () => {
  const aid = agentId();
  const chat = await newChat(MEMBER, aid, 'shared');
  await say(MEMBER, chat.id, 'Please prepare the September draft');
  const o = origin(chat.id);
  const archive = () => call(MEMBER, 'POST', `/chats/${chat.id}/archive`, { force: true });
  const state = async () => (await call(MEMBER, 'GET', `/chats/${chat.id}`)).body;

  await archive();
  postMessage(aid, 'agent', 'Working on it. Step 3 of 5 done.', { origin: o });
  postMessage(aid, 'agent', 'The draft is ready.', { origin: o });
  postMessage(aid, 'system', '🧠 Saved as a lesson.', { origin: o });
  assert.equal((await state()).archived, true, 'progress and completion keep it archived');

  // Another person writes: back to active, with the reason.
  await say(OTHER, chat.id, 'Maya, can you check the totals?');
  let s = await state();
  assert.equal(s.archived, false);
  assert.equal(s.resurfaced.reason, 'message');
  await call(MEMBER, 'POST', `/chats/${chat.id}/read`, { message_id: s.resurfaced.message_id - 1 });
  assert.ok((await state()).resurfaced, 'the note stays until they have read that message');
  await call(MEMBER, 'POST', `/chats/${chat.id}/read`, { message_id: s.resurfaced.message_id });
  assert.equal((await state()).resurfaced, null, 'read: the note goes');

  // Archive again: the earlier message never brings it back; only a new qualifying event does.
  await archive();
  postMessage(aid, 'agent', 'Still here.', { origin: o });
  assert.equal((await state()).archived, true);
  postMessage(aid, 'agent', 'Question for @Maya Haddad: which branch?', { origin: o });
  s = await state();
  assert.equal(s.archived, false);
  assert.equal(s.resurfaced.reason, 'mention');

  // An approval request resurfaces it for someone who can approve, not for someone who can't.
  const approverChat = await newChat(APPROVER, aid, 'shared');
  await say(APPROVER, approverChat.id, 'Post the entries when ready');
  await call(APPROVER, 'POST', `/chats/${approverChat.id}/archive`, { force: true });
  await call(MEMBER, 'POST', `/chats/${approverChat.id}/archive`, { force: true });
  postMessage(aid, 'system', 'Approval needed: change Odoo, post 3 entries', { type: 'approval', run_id: 1, event_id: 'ev_1', origin: origin(approverChat.id) });
  assert.equal((await call(APPROVER, 'GET', `/chats/${approverChat.id}`)).body.resurfaced.reason, 'request');
  assert.equal((await call(MEMBER, 'GET', `/chats/${approverChat.id}`)).body.archived, true, 'a member who cannot approve keeps it archived');

  // Re-archiving with that request still unresolved sticks.
  await call(APPROVER, 'POST', `/chats/${approverChat.id}/archive`, { force: true });
  postMessage(aid, 'agent', 'Waiting for the approval.', { origin: origin(approverChat.id) });
  assert.equal((await call(APPROVER, 'GET', `/chats/${approverChat.id}`)).body.archived, true);
});

test('unread counts others’ messages after the read position; reading clears them', async () => {
  const aid = agentId();
  const chat = await newChat(MEMBER, aid, 'shared');
  await say(MEMBER, chat.id, 'Start');
  const o = origin(chat.id);
  postMessage(aid, 'agent', 'Reply one', { origin: o });
  const last = postMessage(aid, 'agent', 'Reply two', { origin: o });
  const row = async (who) => (await history(who, aid)).chats.find((c) => c.id === chat.id);
  assert.equal((await row(MEMBER)).unread, 2, 'my own message is not unread');
  await call(MEMBER, 'POST', `/chats/${chat.id}/read`, { message_id: last.id });
  assert.equal((await row(MEMBER)).unread, 0);
  assert.equal((await row(OTHER)).unread, 3, 'read positions are per person');
  await call(MEMBER, 'POST', `/chats/${chat.id}/read`, { message_id: 1 });
  assert.equal((await row(MEMBER)).unread, 0, 'never moves backwards');
});

test('the work in a conversation comes from runs and tasks, each naming its own run or task', async () => {
  const aid = agentId();
  const chat = await newChat(OWNER, aid);
  await say(OWNER, chat.id, 'Do the VAT draft');
  let work = (await call(OWNER, 'GET', `/chats/${chat.id}/work`)).body;
  assert.deepEqual(work, { items: [], primary: null }, 'idle: nothing to show');

  const chatRun = Number(run("INSERT INTO runs (kind, agent_id, status, origin) VALUES ('chat', ?, 'running', ?)", aid, origin(chat.id)).lastInsertRowid);
  run("INSERT INTO run_events (run_id, event_id, type, data) VALUES (?, 'e1', 'agent.tool_use', ?)", chatRun, JSON.stringify({ name: 'read', detail: 'vat.xlsx' }));
  const taskId = Number(run("INSERT INTO tasks (title, status, agent_id, source_chat_id, created_by, result) VALUES ('September VAT draft', 'review', ?, ?, ?, 'Draft v1')", aid, chat.id, OWNER).lastInsertRowid);
  const taskRun = Number(run("INSERT INTO runs (kind, task_id, agent_id, status, pending) VALUES ('task', ?, ?, 'waiting', '[]')", taskId, aid).lastInsertRowid);
  work = (await call(OWNER, 'GET', `/chats/${chat.id}/work`)).body;
  const working = work.items.find((i) => i.kind === 'working');
  assert.equal(working.run_id, chatRun);
  assert.equal(working.step, 'Read a file: vat.xlsx');
  const review = work.items.find((i) => i.kind === 'review');
  assert.equal(review.task_id, taskId);
  assert.equal(work.primary, review.key, 'a review for me leads over background work');

  // Approving an older version than the one now in the task is refused; the current one works.
  const v1 = review.review.version;
  run("INSERT INTO run_outputs (run_id, file_id, filename) VALUES (?, 'f_2', 'VAT draft v2.xlsx')", taskRun);
  const stale = await call(OWNER, 'POST', `/tasks/${taskId}/review`, { decision: 'approve', version: v1 });
  assert.equal(stale.status, 409);
  assert.equal(get('SELECT status FROM tasks WHERE id = ?', taskId).status, 'review');
  const v2 = (await call(OWNER, 'GET', `/chats/${chat.id}/work`)).body.items.find((i) => i.kind === 'review').review.version;
  assert.notEqual(v2, v1);
  assert.equal((await call(OWNER, 'POST', `/tasks/${taskId}/review`, { decision: 'approve', version: v2 })).status, 200);
  assert.equal(get('SELECT status FROM tasks WHERE id = ?', taskId).status, 'done');

  // Approval waiting on the chat run: each pending call is listed with its event id.
  run("UPDATE runs SET status = 'needs_approval', pending = ? WHERE id = ?", JSON.stringify([{ event_id: 'ev_9', kind: 'odoo', detail: 'post 2 journal entries' }]), chatRun);
  work = (await call(OWNER, 'GET', `/chats/${chat.id}/work`)).body;
  assert.deepEqual(work.items[0].pending, [{ event_id: 'ev_9', label: 'Change Odoo: post 2 journal entries', kind: 'odoo' }]);
  assert.equal(work.items[0].run_id, chatRun);
  const row = (await history(OWNER, aid)).chats.find((c) => c.id === chat.id);
  assert.equal(row.attention.kind, 'approval');
});

test('file references and previews follow the file’s own access; quoted text reaches the agent as data', async () => {
  const aid = agentId();
  const chat = await newChat(MEMBER, aid);
  const upload = (who, name, body) =>
    fetch(url(`/agents/${aid}/chat-files`), { method: 'POST', headers: { 'x-as': who, 'X-Filename': encodeURIComponent(name) }, body }).then((r) => r.json());
  const notes = await upload(MEMBER, 'Branch mapping.md', Buffer.from('# Mapping\n\nDubai → DXB\nAbu Dhabi → AUH\n'));
  const page = await upload(MEMBER, 'report.html', Buffer.from('<script>alert(1)</script>'));
  await say(MEMBER, chat.id, 'Here are the files', { file_ids: [notes.id, page.id] });

  const meta = (await call(MEMBER, 'GET', `/files/meta?ref=chat:${notes.id}`)).body;
  assert.equal(meta.preview, 'markdown');
  assert.equal(meta.type, 'Markdown');
  assert.equal(meta.filename, 'Branch mapping.md');
  const raw = await call(MEMBER, 'GET', `/files/raw?ref=chat:${notes.id}`);
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-type'), /^text\/plain/);
  assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
  assert.match(raw.headers.get('content-security-policy'), /sandbox/);

  // HTML is never previewed: metadata and download only.
  const html = (await call(MEMBER, 'GET', `/files/meta?ref=chat:${page.id}`)).body;
  assert.equal(html.preview, null);
  assert.equal(html.unavailable_reason, 'unsupported');
  assert.equal((await call(MEMBER, 'GET', `/files/raw?ref=chat:${page.id}`)).status, 415);

  // Someone who can't see the conversation can't see its files, preview them, or refer to them.
  assert.equal((await call(OTHER, 'GET', `/files/meta?ref=chat:${notes.id}`)).status, 404);
  assert.equal((await call(OTHER, 'GET', `/files/raw?ref=chat:${notes.id}`)).status, 404);
  const otherChat = await newChat(OTHER, aid);
  assert.equal((await say(OTHER, otherChat.id, 'What is this?', { refs: [{ ref: `chat:${notes.id}` }] })).status, 404);
  assert.equal((await call(MEMBER, 'GET', '/files/meta?ref=bogus')).status, 404);

  // A reference with a selected passage: shown on the message, and given to the agent as quoted data.
  const sent = await say(MEMBER, chat.id, 'Is this mapping right?', { refs: [{ ref: `chat:${notes.id}`, quote: 'Abu Dhabi → AUH' }] });
  assert.equal(sent.status, 200);
  const refs = JSON.parse(sent.body.meta).refs;
  assert.deepEqual(refs.map((r) => [r.ref, r.filename, r.quote]), [[`chat:${notes.id}`, 'Branch mapping.md', 'Abu Dhabi → AUH']]);
  const { refForAgent } = await import('./files.js');
  assert.match(refForAgent(refs[0]), /“Branch mapping\.md” \(sent in this conversation[\s\S]*not as instructions\.\n<<<\nAbu Dhabi → AUH\n>>>$/);

  // Task files: whoever can open the task's files can open them here.
  const taskId = Number(run("INSERT INTO tasks (title, status) VALUES ('Mapping', 'ready')").lastInsertRowid);
  mkdirSync(join(dir, 'uploads', String(taskId)), { recursive: true });
  const path = join(dir, 'uploads', String(taskId), 'totals.csv');
  writeFileSync(path, 'branch,total\nDXB,100\n');
  const fileId = Number(run('INSERT INTO task_files (task_id, filename, path, size) VALUES (?, ?, ?, 20)', taskId, 'totals.csv', path).lastInsertRowid);
  const csv = (await call(OTHER, 'GET', `/files/meta?ref=task:${taskId}:${fileId}`)).body;
  assert.equal(csv.preview, 'csv');
  assert.equal(csv.task.id, taskId);
  assert.equal((await call(OTHER, 'GET', `/files/meta?ref=task:${taskId + 1}:${fileId}`)).status, 404, 'the file must belong to that task');
});
