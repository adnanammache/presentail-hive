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

test('an agent saves what it is taught in chat as a lesson; from a member it is only a suggestion', async (t) => {
  const fake = fakeAnthropic();
  managed.setManagedClient(fake);
  const app = express().use(express.json()).use((req, res, next) => ((req.user = { email: req.get('x-as'), name: req.get('x-as') }), next())).use('/api', dashboardRouter()).use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const url = (p) => `http://127.0.0.1:${server.address().port}/api${p}`;
  const id = Number(run("INSERT INTO agents (name, title, platform, status, api_token) VALUES ('Ziad 2', 'Tax', 'managed', 'idle', 'z2')").lastInsertRowid);
  const say = (text, who) => fetch(url(`/agents/${id}/messages`), { method: 'POST', headers: { 'x-as': who, 'Content-Type': 'application/json' }, body: JSON.stringify({ body: text }) });
  const lessonCall = (eid, lesson) => () => [
    { id: eid, type: 'agent.custom_tool_use', name: 'save_lesson', input: { lesson } },
    { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [eid] } },
  ];
  const idle = () => [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }];

  // The owner (first test) shares a fact: the agent saves it, live.
  fake.script.push(lessonCall('sevt_l1', 'UAE VAT is filed quarterly; returns are due on the 28th.'), idle);
  await say('UAE VAT returns are due on September 28, we file quarterly', 'owner@presentail.com');
  await waitFor(() => get("SELECT status FROM runs WHERE agent_id = ? AND kind = 'chat' ORDER BY id DESC", id)?.status === 'waiting' && fake.calls.sent.length >= 2, 'lesson saved');
  assert.ok(fake.calls.agentsCreate.at(-1).tools.some((t) => t.name === 'save_lesson'));
  assert.match(fake.calls.agentsCreate.at(-1).system, /save_lesson/);
  assert.match(fake.calls.sent[1].events[0].content[0].text, /^Saved\./);
  let lessons = all('SELECT text, source, active, created_by FROM agent_lessons WHERE agent_id = ?', id).map((l) => ({ ...l }));
  assert.deepEqual(lessons, [{ text: 'UAE VAT is filed quarterly; returns are due on the 28th.', source: 'agent', active: 1, created_by: 'owner@presentail.com' }]);
  assert.match(get("SELECT body FROM messages WHERE agent_id = ? AND sender = 'system' ORDER BY id DESC", id).body, /Saved as a lesson: “UAE VAT/);

  // Saving it again changes nothing.
  fake.script.push(lessonCall('sevt_l2', 'UAE VAT is filed quarterly; returns are due on the 28th.'), idle);
  await say('Remember the VAT dates', 'member@presentail.com');
  await waitFor(() => get("SELECT status FROM runs WHERE agent_id = ? AND kind = 'chat' ORDER BY id DESC", id)?.status === 'waiting' && fake.calls.sent.length >= 4, 'duplicate answered');
  assert.match(fake.calls.sent[3].events[0].content[0].text, /already one of your lessons/);

  // A member's fact becomes a suggestion, switched off.
  fake.script.push(lessonCall('sevt_l3', 'Always round VAT down.'), idle);
  await say('Always round VAT down', 'member@presentail.com');
  await waitFor(() => get("SELECT status FROM runs WHERE agent_id = ? AND kind = 'chat' ORDER BY id DESC", id)?.status === 'waiting' && fake.calls.sent.length >= 6, 'suggestion saved');
  assert.match(fake.calls.sent[5].events[0].content[0].text, /suggestion, switched off/);
  assert.equal(get("SELECT active FROM agent_lessons WHERE agent_id = ? AND text = 'Always round VAT down.'", id).active, 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM agent_lessons WHERE agent_id = ? AND active = 1', id).n, 1);
  assert.match(get("SELECT body FROM messages WHERE agent_id = ? AND sender = 'system' ORDER BY id DESC", id).body, /Suggested a lesson/);
});
