import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.PUBLIC_URL = 'https://hive.presentail.com';
process.env.SLACK_BOT_TOKEN = 'xoxb';
process.env.SLACK_ALERT_CHANNEL = 'U1';

const { get, run } = await import('./db.js');
const { buildBrief, sendBrief, setBriefConfig, briefConfig, stopBrief } = await import('./brief.js');
const push = await import('./push.js');

const slack = [];
globalThis.fetch = async (url, init) => (slack.push(JSON.parse(init.body)), new Response(JSON.stringify({ ok: true })));
const pushed = [];
push.setPushSender(async (sub, payload) => {
  if (sub.endpoint.includes('gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
  pushed.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
});

test('the brief covers each department, what waits on you, failures, today and spend', async () => {
  const acc = Number(run("INSERT INTO teams (name, color) VALUES ('Accounting', '#10b981')").lastInsertRowid);
  const exec = Number(run("INSERT INTO teams (name) VALUES ('Executive Office')").lastInsertRowid);
  const ledger = Number(run("INSERT INTO agents (name, title, team_id, api_token) VALUES ('Ledger', 'UAE Accountant', ?, 'a1')", acc).lastInsertRowid);
  const cos = Number(run("INSERT INTO agents (name, title, team_id, api_token) VALUES ('Morning Briefer', 'Chief of Staff', ?, 'a2')", exec).lastInsertRowid);
  run("INSERT INTO tasks (title, status, agent_id, completed_at) VALUES ('Careem July', 'done', ?, datetime('now', '-2 hours'))", ledger);
  run("INSERT INTO tasks (title, status, agent_id, completed_at) VALUES ('Ancient task', 'done', ?, datetime('now', '-9 days'))", ledger);
  const t3 = Number(run("INSERT INTO tasks (title, status, agent_id) VALUES ('Talabat August', 'review', ?)", ledger).lastInsertRowid);
  run("INSERT INTO runs (task_id, agent_id, status, pending, cost_cents) VALUES (?, ?, 'needs_approval', ?, 125)", t3, ledger, JSON.stringify([{ event_id: 'e1' }, { event_id: 'e2' }]));
  run("INSERT INTO tasks (title, status, agent_id) VALUES ('BLOM June', 'blocked', ?)", ledger);
  run("INSERT INTO runs (agent_id, status, error) VALUES (?, 'failed', 'Wafeq returned 403')", ledger);
  run("INSERT INTO workflows (name, schedule, timezone, enabled, agent_id) VALUES ('Hourly check', '0 * * * *', 'UTC', 1, ?)", ledger);

  const b = buildBrief();
  assert.deepEqual(b.approvals.map((a) => [a.agent, a.title, a.count]), [['Ledger', 'Talabat August', 2]]);
  assert.deepEqual(b.review.map((t) => t.title), ['BLOM June'], 'a task already listed as an approval is not repeated');
  assert.deepEqual(b.teams.map((g) => [g.team, g.items.map((i) => i.title)]), [['Accounting', ['Careem July', 'Talabat August']]]);
  assert.equal(b.failed[0].error, 'Wafeq returned 403');
  assert.equal(b.today[0].name, 'Hourly check');
  assert.equal(b.spend.month_cents, 125);
  assert.equal(b.headline, '2 things waiting on you · 2 tasks finished · 1 failure · 1 scheduled today.');

  push.saveSubscription({ endpoint: 'https://push.example/phone', keys: { p256dh: 'p', auth: 'a' } }, 'adnan');
  push.saveSubscription({ endpoint: 'https://push.example/gone', keys: { p256dh: 'p', auth: 'a' } }, 'old');
  const sent = await sendBrief({ trigger: 'manual' });

  // Posted by the Chief of Staff in their inbox thread…
  const msg = get('SELECT * FROM messages WHERE agent_id = ? ORDER BY id DESC', cos);
  assert.match(msg.body, /^2 things waiting on you/);
  assert.match(msg.body, /Accounting: Careem July \(Ledger\)/);
  assert.equal(JSON.parse(msg.meta).brief_id, sent.id);
  // …to Slack, with links into Hive…
  assert.match(slack[0].blocks[0].text.text, /Daily brief\* from Morning Briefer, Chief of Staff/);
  assert.match(slack[0].blocks[1].text.text, new RegExp(`<https://hive.presentail.com/#/tasks/${t3}\\|Talabat August>`));
  // …and as a notification. Dead devices are cleaned up.
  assert.deepEqual(pushed.map((p) => [p.endpoint, p.title]), [['https://push.example/phone', 'Daily brief']]);
  assert.equal(push.subscriptionCount(), 1);

  // The next brief only covers what happened since this one.
  assert.equal(buildBrief().teams.length, 0);
});

test('brief schedule settings are validated', () => {
  assert.equal(briefConfig().time, '07:45');
  assert.equal(setBriefConfig({ time: '08:30', timezone: 'Asia/Beirut' }).time, '08:30');
  assert.throws(() => setBriefConfig({ time: '8am' }), /HH:MM/);
  assert.throws(() => setBriefConfig({ timezone: 'Mars/Base' }), /time zone/);
  assert.equal(briefConfig().timezone, 'Asia/Beirut');
  stopBrief();
});

test('push subscriptions must look real', () => {
  assert.throws(() => push.saveSubscription({ endpoint: 'http://x', keys: {} }), /Invalid/);
  assert.ok(push.vapidKeys().publicKey.length > 40);
  assert.equal(push.vapidKeys().publicKey, JSON.parse(get("SELECT value FROM app_meta WHERE key = 'vapid'").value).publicKey);
});
