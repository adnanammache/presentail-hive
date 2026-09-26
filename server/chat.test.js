// Hive's chat: files and voice notes reach the agent's session, and "remember:" saves a lesson.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'hive-chat-')), 'hive.db');
process.env.ANTHROPIC_API_KEY = 'test';
const { run, get, all } = await import('./db.js');
const { dashboardRouter, errorHandler } = await import('./app.js');
const managed = await import('./managed.js');
const { fakeAnthropic } = await import('./testing/fake-anthropic.js');
const { setLessonJudge } = await import('./lessons.js');
const { saveSubscription, setPushSender } = await import('./push.js');

const waitFor = async (fn, what) => {
  for (let i = 0; i < 300; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

test('chat: attach files, send a voice note, and teach with "remember:"', async (t) => {
  const fake = fakeAnthropic();
  managed.setManagedClient(fake);
  const app = express().use(express.json()).use((req, res, next) => ((req.user = { email: req.get('x-as'), name: 'Adnan' }), next())).use('/api', dashboardRouter()).use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const url = (p) => `http://127.0.0.1:${server.address().port}/api${p}`;
  const owner = { 'x-as': 'owner@presentail.com' };
  const member = { 'x-as': 'member@presentail.com' };
  await fetch(url('/me'), { headers: owner }); // first person: owner
  await fetch(url('/me'), { headers: member });
  const id = Number(run("INSERT INTO agents (name, title, platform, status, api_token) VALUES ('Ziad', 'Tax', 'managed', 'idle', 'z')").lastInsertRowid);
  const upload = (name, body, headers = {}) =>
    fetch(url(`/agents/${id}/chat-files`), { method: 'POST', headers: { ...owner, 'X-Filename': encodeURIComponent(name), ...headers }, body }).then((r) => r.json());
  const send = (body, headers = owner) => fetch(url(`/agents/${id}/messages`), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // A file goes into the running chat session and the agent is told where it is.
  const file = await upload('Q3 VAT.xlsx', Buffer.from('spreadsheet'));
  assert.equal(file.filename, 'Q3 VAT.xlsx');
  fake.script.push(() => [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
  let res = await send({ body: 'Check this return', file_ids: [file.id] });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse((await res.json()).meta).files, [{ id: file.id, filename: 'Q3 VAT.xlsx', size: 11, voice: false }]);
  await waitFor(() => fake.calls.sent.length, 'message sent');
  assert.equal(fake.calls.resources[0].mount_path, '/workspace/inputs/chat/Q3 VAT.xlsx');
  assert.equal(fake.calls.resources[0].sid, fake.calls.sessions[0].sid);
  assert.match(fake.calls.sent[0].events[0].content[0].text, /^Check this return\n\nAttached file \(in \/workspace\/inputs\/chat\/\):\n- Q3 VAT\.xlsx$/);
  assert.equal((await send({ body: 'again', file_ids: [file.id] })).status, 400, 'a file is sent once');

  // The same name again gets its own name (it is its mount path).
  assert.equal((await upload('Q3 VAT.xlsx', Buffer.from('v2'))).filename, 'Q3 VAT (2).xlsx');

  // A voice note: the agent reads the transcript; the recording stays in Hive and plays back.
  const audio = await upload('Voice note.webm', Buffer.from('audio'), { 'Content-Type': 'audio/webm', 'X-Voice': '1' });
  assert.equal((await send({ body: '', file_ids: [audio.id], voice: true })).status, 400, 'no words, no message');
  fake.script.push(() => [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
  res = await send({ body: 'UAE VAT is due on the 28th', file_ids: [audio.id], voice: true });
  assert.equal(JSON.parse((await res.json()).meta).voice, true);
  await waitFor(() => fake.calls.sent.length === 2, 'voice note sent');
  assert.equal(fake.calls.sent[1].events[0].content[0].text, '(Voice note, transcribed automatically)\nUAE VAT is due on the 28th');
  assert.equal(fake.calls.resources.length, 1, 'the recording is not sent to the agent');
  const played = await fetch(url(`/chat-files/${audio.id}`), { headers: owner });
  assert.equal(played.headers.get('content-type'), 'audio/webm');
  assert.equal(await played.text(), 'audio');

  // "remember:" saves a lesson (approvers and owners only) and tells the running chat too.
  assert.equal((await send({ body: 'remember: file UAE VAT quarterly' }, member)).status, 403);
  fake.script.push(() => [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
  res = await send({ body: 'Remember: UAE VAT is filed quarterly, due on the 28th' });
  assert.equal(res.status, 200);
  assert.deepEqual(all('SELECT text, source, created_by FROM agent_lessons WHERE agent_id = ?', id).map((l) => ({ ...l })), [
    { text: 'UAE VAT is filed quarterly, due on the 28th', source: 'chat', created_by: 'Adnan' },
  ]);
  await waitFor(() => fake.calls.sent.length === 3, 'lesson sent');
  assert.match(fake.calls.sent[2].events[0].content[0].text, /saved in your lessons[\s\S]*UAE VAT is filed quarterly/);
  assert.match(get("SELECT body FROM messages WHERE agent_id = ? AND sender = 'system' ORDER BY id DESC", id).body, /Saved as a lesson/);
});

test('an agent proposes a lesson mid-chat; it waits for approval, then reaches the running chat', async (t) => {
  const fake = fakeAnthropic();
  managed.setManagedClient(fake);
  setLessonJudge(null); // wording only: no calls to a real model from tests
  const pushed = [];
  setPushSender(async (sub, payload) => pushed.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }));
  const app = express().use(express.json()).use((req, res, next) => ((req.user = { email: req.get('x-as'), name: req.get('x-as') }), next())).use('/api', dashboardRouter()).use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const url = (p) => `http://127.0.0.1:${server.address().port}/api${p}`;
  const as = (who) => ({ 'x-as': who, 'Content-Type': 'application/json' });
  const owner = 'owner@presentail.com';
  const member = 'member@presentail.com';
  saveSubscription({ endpoint: 'https://push.example/owner', keys: { p256dh: 'p', auth: 'a' } }, owner);
  saveSubscription({ endpoint: 'https://push.example/member', keys: { p256dh: 'p', auth: 'a' } }, member);
  const id = Number(run("INSERT INTO agents (name, title, platform, status, api_token) VALUES ('Ziad 2', 'Tax', 'managed', 'idle', 'z2')").lastInsertRowid);
  const say = (text, who = owner) => fetch(url(`/agents/${id}/messages`), { method: 'POST', headers: as(who), body: JSON.stringify({ body: text }) });
  const post = (path, body, who = owner) => fetch(url(path), { method: 'POST', headers: as(who), body: JSON.stringify(body ?? {}) });
  const call = (eid, name, input) => () => [
    { id: eid, type: 'agent.custom_tool_use', name, input },
    { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [eid] } },
  ];
  const idle = () => [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }];
  const turn = async (n, what) => waitFor(() => get("SELECT status FROM runs WHERE agent_id = ? AND kind = 'chat'", id)?.status === 'waiting' && fake.calls.sent.length >= n, what);
  const toolReply = (i) => fake.calls.sent[i].events[0].content[0].text;
  const lastNote = () => get("SELECT body, meta FROM messages WHERE agent_id = ? AND sender = 'system' ORDER BY id DESC", id);
  const count = () => get('SELECT COUNT(*) AS n FROM agent_lessons WHERE agent_id = ?', id).n;
  const WAFEQ = 'UAE sales in Wafeq sit in two places: Cash invoices (`simplified-invoices`) and Invoices (`invoices`). Always check both.';

  // The agent finds its own mistake and proposes a lesson. It waits: it does not apply yet.
  fake.script.push(call('sevt_l1', 'save_lesson', { text: WAFEQ, reason: 'I reported six months of UAE revenue missing; I had only queried `invoices`.', scope: 'self' }), idle);
  await say('we may sometimes have invoices as well, you need to always check both');
  await turn(2, 'lesson proposed');
  const tools = fake.calls.agentsCreate.at(-1).tools.map((x) => x.name);
  for (const name of ['save_lesson', 'list_lessons', 'lesson_applied']) assert.ok(tools.includes(name), name);
  assert.match(toolReply(1), /^Proposed as lesson #\d+\. It is waiting .* does NOT apply yet/);
  const lesson = get('SELECT * FROM agent_lessons WHERE agent_id = ?', id);
  assert.equal(lesson.status, 'pending_approval');
  assert.equal(lesson.created_by, 'Ziad 2');
  assert.match(lesson.reason, /six months/);
  assert.equal(lesson.run_id, get("SELECT id FROM runs WHERE agent_id = ? AND kind = 'chat'", id).id, 'linked to the chat it came from');
  // The chat says so (with Approve / Reject), and the people who can approve are told.
  assert.match(lastNote().body, /proposed a lesson \(waiting for approval\)[\s\S]*Why: I reported/);
  assert.deepEqual(JSON.parse(lastNote().meta), { origin: 'hive', type: 'lesson', lesson_id: lesson.id });
  await waitFor(() => pushed.length, 'push sent');
  assert.deepEqual(pushed.map((p) => p.endpoint), ['https://push.example/owner'], 'approvers only');
  assert.equal(pushed[0].url, `/#/agents/${id}/lessons`);

  // A member can't approve it; the owner can.
  assert.equal((await post(`/lessons/${lesson.id}/approve`, {}, member)).status, 403);
  assert.equal((await post(`/lessons/${lesson.id}/approve`)).status, 200);
  assert.equal(get('SELECT status FROM agent_lessons WHERE id = ?', lesson.id).status, 'approved');

  // The running chat started before the approval, so its next message carries the lesson (once).
  fake.script.push(idle);
  await say('ok, redo the revenue check');
  await turn(3, 'next message');
  assert.match(toolReply(2), new RegExp(`^\\[Hive\\] New lessons were approved[\\s\\S]*\\[#${lesson.id}\\] UAE sales in Wafeq[\\s\\S]*ok, redo the revenue check$`));
  fake.script.push(idle);
  await say('thanks');
  await turn(4, 'following message');
  assert.equal(toolReply(3), 'thanks');

  // Proposing the same thing in other words is caught: nothing new is created.
  fake.script.push(call('sevt_l2', 'save_lesson', { text: 'Always check both Wafeq Cash invoices (simplified-invoices) and Invoices (invoices) for UAE sales.', reason: 'again' }), idle);
  await say('remember to check both places');
  await turn(6, 'duplicate answered');
  assert.match(toolReply(5), new RegExp(`already have this as lesson #${lesson.id}`));
  assert.equal(count(), 1);
  assert.match(lastNote().body, /Already a lesson/);

  // Vague lessons are turned away, and the chat says it wasn't saved.
  fake.script.push(call('sevt_l3', 'save_lesson', { text: 'Be more careful with revenue.', reason: 'mistake' }), idle);
  await say('be careful');
  await turn(8, 'vague answered');
  assert.match(toolReply(7), /^Not saved\. Too vague/);
  assert.match(lastNote().body, /was not saved: Too vague to act on\./);
  assert.equal(count(), 1);

  // Rejected lessons stay rejected: the agent sees why and can't propose them again.
  fake.script.push(call('sevt_l4', 'save_lesson', { lesson: 'Always round UAE VAT down to the nearest fils on Wafeq invoices.' }), idle); // the tool's old field still works
  await say('round VAT down');
  await turn(10, 'second proposal');
  const rounding = get("SELECT * FROM agent_lessons WHERE agent_id = ? AND status = 'pending_approval'", id);
  assert.ok(rounding, 'saved from the old "lesson" field');
  assert.equal((await post(`/lessons/${rounding.id}/reject`, { note: 'Wafeq rounds per line; never round yourself.' })).status, 200);
  fake.script.push(call('sevt_l5', 'save_lesson', { text: 'Always round UAE VAT down to the nearest fils on Wafeq invoices.', reason: 'asked again' }), idle);
  await say('are you sure about rounding?');
  await turn(12, 'rejected re-proposal');
  assert.match(toolReply(11), /rejected this before as #\d+ \(“Wafeq rounds per line; never round yourself\.”\)\. Do not propose it again\./);
  assert.equal(count(), 2);
  fake.script.push(call('sevt_l6', 'list_lessons', {}), idle);
  await say('what do you know?');
  await turn(14, 'lessons listed');
  assert.match(toolReply(13), /In force:\n- #\d+: UAE sales in Wafeq[\s\S]*Rejected \(never propose these again\):\n- #\d+: Always round UAE VAT down[\s\S]*reason: Wafeq rounds per line/);

  // "Always trust this agent": proposals apply without a person.
  assert.equal((await fetch(url(`/agents/${id}/trust-lessons`), { method: 'PUT', headers: as(member), body: '{"trust":true}' })).status, 403);
  assert.equal((await fetch(url(`/agents/${id}/trust-lessons`), { method: 'PUT', headers: as(owner), body: '{"trust":true}' })).status, 200);
  fake.script.push(call('sevt_l7', 'save_lesson', { text: 'File UAE VAT returns quarterly; each is due on the 28th of the month after the quarter ends.', reason: 'Owner told me the filing schedule.' }), idle);
  await say('UAE VAT is quarterly, due the 28th after quarter end');
  await turn(16, 'trusted proposal');
  assert.match(toolReply(15), /^Saved as lesson #\d+\. You are trusted/);
  assert.equal(get("SELECT status FROM agent_lessons WHERE agent_id = ? AND text LIKE 'File UAE VAT%'", id).status, 'approved');

  // lesson_applied records when a lesson was last relevant.
  fake.script.push(call('sevt_l8', 'lesson_applied', { ids: [lesson.id] }), idle);
  await say('check July revenue');
  await turn(18, 'lesson applied');
  assert.equal(get('SELECT use_count FROM agent_lessons WHERE id = ?', lesson.id).use_count, 1);
});
