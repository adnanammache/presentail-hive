import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.PUBLIC_URL = 'https://hive.presentail.com';
const { run } = await import('./db.js');
const { notifyRun, sendSlack } = await import('./notify.js');

const sent = [];
globalThis.fetch = async (url, init) => {
  sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ ok: true }));
};

test('no Slack configuration means no messages', async () => {
  delete process.env.SLACK_BOT_TOKEN;
  assert.deepEqual(await sendSlack({ text: 'hi' }), { ok: false, skipped: true });
  assert.equal(sent.length, 0);
});

test('approval, done and failure alerts link straight to the task', async () => {
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_ALERT_CHANNEL = 'U123';
  const agentId = Number(run("INSERT INTO agents (name, title, platform, api_token) VALUES ('Ledger', 'UAE Accountant', 'managed', 'agt')").lastInsertRowid);
  const taskId = Number(run("INSERT INTO tasks (title, agent_id) VALUES ('Talabat <August>', ?)", agentId).lastInsertRowid);
  const runId = Number(run("INSERT INTO runs (task_id, agent_id, status, last_message, error) VALUES (?, ?, 'waiting', 'Posted 3 bills, AED 18,420.55', 'Wafeq returned 403')", taskId, agentId).lastInsertRowid);

  await notifyRun(runId, 'approval', { pending: [{ name: 'bash', detail: 'python post_talabat.py' }] });
  await notifyRun(runId, 'done');
  await notifyRun(runId, 'failed');

  assert.equal(sent.length, 3);
  assert.equal(sent[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(sent[0].headers.Authorization, 'Bearer xoxb-test');
  assert.equal(sent[0].body.channel, 'U123');
  assert.match(sent[0].body.blocks[0].text.text, /Ledger\* needs your approval on \*Talabat &lt;August&gt;\*/);
  assert.match(sent[0].body.blocks[1].text.text, /post_talabat\.py/);
  assert.equal(sent[0].body.blocks.at(-1).elements[0].url, `https://hive.presentail.com/#/tasks/${taskId}`);
  assert.match(sent[1].body.blocks[1].text.text, /18,420\.55/);
  assert.match(sent[2].body.blocks[1].text.text, /Wafeq returned 403/);
});
