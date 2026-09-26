// Approving agent actions straight from a Slack alert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ALERT_CHANNEL = 'U0ADNAN';
process.env.SLACK_SIGNING_SECRET = 'shh';

const { get, run } = await import('./db.js');
const managed = await import('./managed.js');
const { slackRouter, verifySlack, approvers } = await import('./slack.js');
const { fakeAnthropic } = await import('./testing/fake-anthropic.js');

const slack = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('https://slack.com/') && !String(url).startsWith('https://hooks.slack.com/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  slack.push({ url: String(url), body });
  return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '171.001' }));
};

const waitFor = async (fn, what) => {
  for (let i = 0; i < 200; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

function signed(payload, { secret = 'shh', ts = Math.floor(Date.now() / 1000) } = {}) {
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const sig = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
  return { body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Slack-Request-Timestamp': String(ts), 'X-Slack-Signature': sig } };
}

test('signatures are checked and approvers default to the DM recipient', () => {
  const { body, headers } = signed({ a: 1 });
  assert.equal(verifySlack(body, headers['X-Slack-Request-Timestamp'], headers['X-Slack-Signature']), true);
  assert.equal(verifySlack(body + 'x', headers['X-Slack-Request-Timestamp'], headers['X-Slack-Signature']), false);
  const old = signed({ a: 1 }, { ts: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal(verifySlack(old.body, old.headers['X-Slack-Request-Timestamp'], old.headers['X-Slack-Signature']), false);
  assert.deepEqual(approvers(), ['U0ADNAN']);
});

test('Approve in Slack resolves exactly the calls in the alert and updates the message', async () => {
  const fake = fakeAnthropic();
  managed.setManagedClient(fake);
  const agentId = Number(run("INSERT INTO agents (name, title, platform, approval, api_token) VALUES ('Ledger', 'UAE Accountant', 'managed', 'every_command', 'agt_s')").lastInsertRowid);
  const taskId = Number(run("INSERT INTO tasks (title, agent_id) VALUES ('Talabat August', ?)", agentId).lastInsertRowid);
  fake.script.push(() => [
    { id: 'e1', type: 'agent.tool_use', name: 'bash', input: { command: 'python post.py --bills' }, evaluated_permission: 'ask' },
    { id: 'e2', type: 'agent.tool_use', name: 'bash', input: { command: 'python post.py --sales' }, evaluated_permission: 'ask' },
    { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['e1', 'e2'] } },
  ]);
  const started = managed.startTaskRun(taskId);
  await waitFor(() => get('SELECT status FROM runs WHERE id = ?', started.id).status === 'needs_approval', 'approval');
  const alert = await waitFor(() => slack.find((s) => s.url.endsWith('chat.postMessage')), 'alert');
  const actions = alert.body.blocks.at(-1).elements;
  assert.deepEqual(actions.map((a) => a.action_id), ['hive_approve', 'hive_reject', 'hive_open']);
  assert.equal(actions[0].text.text, 'Approve all 2');
  assert.equal(actions[0].value, `${started.id}:e1,e2`);
  await waitFor(() => get('SELECT slack_ts FROM runs WHERE id = ?', started.id).slack_ts, 'alert remembered');

  const app = express().use(slackRouter());
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/slack/interactions`;
  try {
    const click = (user, action = 'hive_approve') =>
      signed({ user: { id: user, name: user === 'U0ADNAN' ? 'adnan' : 'someone' }, response_url: 'https://hooks.slack.com/actions/x', actions: [{ action_id: action, value: actions[0].value }] });

    // Unsigned requests are refused.
    assert.equal((await fetch(url, { method: 'POST', body: 'payload={}' })).status, 401);

    // Someone who isn't an approver gets a private "not allowed" and nothing happens.
    let req = click('U0OTHER');
    assert.equal((await fetch(url, { method: 'POST', ...req })).status, 200);
    await waitFor(() => slack.some((s) => s.url.includes('hooks.slack.com') && /can't approve/.test(s.body.text)), 'refusal');
    assert.equal(get('SELECT status FROM runs WHERE id = ?', started.id).status, 'needs_approval');

    // The approver approves both calls in one go.
    fake.script.push(() => [{ type: 'agent.message', content: [{ type: 'text', text: 'Posted.' }] }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }]);
    req = click('U0ADNAN');
    assert.equal((await fetch(url, { method: 'POST', ...req })).status, 200);
    const sent = await waitFor(() => fake.calls.sent[1], 'confirmations sent');
    assert.deepEqual(sent.events.map((e) => [e.tool_use_id, e.result]), [['e1', 'allow'], ['e2', 'allow']]);
    const update = await waitFor(() => slack.find((s) => s.url.endsWith('chat.update')), 'alert updated');
    assert.equal(update.body.ts, '171.001');
    assert.match(JSON.stringify(update.body.blocks), /Approved by adnan \(Slack\)/);
    assert.ok(!JSON.stringify(update.body.blocks).includes('hive_approve'), 'buttons are gone');

    // A second click on the same (stale) alert changes nothing.
    req = click('U0ADNAN');
    await fetch(url, { method: 'POST', ...req });
    await waitFor(() => slack.some((s) => /Already handled/.test(s.body.text || '')), 'stale click');
    assert.equal(fake.calls.sent.length, 2);
  } finally {
    server.close();
  }
});

test('a lesson an agent proposes is announced with Approve / Reject, and only approvers can use them', async () => {
  const { handleAction } = await import('./slack.js');
  const { proposeLesson, setLessonJudge } = await import('./lessons.js');
  setLessonJudge(null);
  const agentId = Number(run("INSERT INTO agents (name, title, api_token) VALUES ('Ziad', 'Tax', 'zl')").lastInsertRowid);
  const before = slack.length;
  await proposeLesson({ kind: 'task', agent_id: agentId }, { text: 'UAE sales in Wafeq sit in two places: Cash invoices (`simplified-invoices`) and Invoices (`invoices`). Always check both.', reason: 'Missed marketplace revenue' });
  const lesson = get('SELECT * FROM agent_lessons WHERE agent_id = ?', agentId);
  const alert = await waitFor(() => slack.slice(before).find((m) => m.url.endsWith('chat.postMessage') && m.body.text.includes('proposed a lesson')), 'lesson alert');
  const actions = alert.body.blocks.find((b) => b.type === 'actions').elements;
  assert.deepEqual(actions.map((a) => a.action_id), ['hive_lesson_approve', 'hive_lesson_reject', 'hive_open']);
  assert.match(actions[2].url, new RegExp(`/#/agents/${agentId}/lessons$`));
  assert.match(JSON.stringify(alert.body.blocks), /Missed marketplace revenue/);

  const click = (user, action_id) => handleAction({ user: { id: user, name: user }, actions: [{ action_id, value: String(lesson.id) }] });
  assert.match(await click('U0STRANGER', 'hive_lesson_approve'), /can't approve this agent's lessons/);
  assert.equal(get('SELECT status FROM agent_lessons WHERE id = ?', lesson.id).status, 'pending_approval');
  assert.equal(await click('U0ADNAN', 'hive_lesson_approve'), `Approved lesson #${lesson.id}.`);
  assert.equal(get('SELECT status, reviewed_by FROM agent_lessons WHERE id = ?', lesson.id).reviewed_by, 'U0ADNAN (Slack)');
  assert.match(await click('U0ADNAN', 'hive_lesson_reject'), /Already handled: lesson #\d+ is approved/);
});
