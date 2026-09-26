// Each agent as its own Slack bot: created, installed and answering as itself. Slack is faked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express from 'express';
import { request } from 'node:http';

process.env.DB_PATH = ':memory:';
process.env.PUBLIC_URL = 'https://hive.presentail.com';
process.env.SLACK_BOT_TOKEN = 'xoxb-hive';
process.env.SLACK_ALERT_CHANNEL = 'C0ALERTS';
process.env.SLACK_SIGNING_SECRET = 'hive-secret';
process.env.OWNER_EMAILS = 'adnan@presentail.com';

const { get, run } = await import('./db.js');
const managed = await import('./managed.js');
const bots = await import('./slackBots.js');
const { handleEvent, slackRouter, verifySlack } = await import('./slack.js');
const { postMessage } = await import('./notify.js');
const { fakeAnthropic } = await import('./testing/fake-anthropic.js');

// ---- a fake Slack
const calls = [];
const slack = { rejectAgentView: false, rotations: 0, apps: 0, notInChannel: new Set() };
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (!url.startsWith('https://slack.com/api/')) throw new Error(`unexpected fetch ${url}`);
  const method = url.split('/').pop();
  const auth = init.headers?.Authorization ?? null;
  let body;
  if (init.body instanceof URLSearchParams) body = Object.fromEntries(init.body);
  else if (init.body instanceof FormData) body = Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : { file: v.name, type: v.type, size: v.size }]));
  else if (/x-www-form-urlencoded/.test(init.headers?.['Content-Type'] ?? '')) body = Object.fromEntries(new URLSearchParams(init.body));
  else body = JSON.parse(init.body);
  // Like Slack: read methods ignore a JSON body.
  if (method === 'users.info' && !/x-www-form-urlencoded/.test(init.headers?.['Content-Type'] ?? '')) return Response.json({ ok: false, error: 'user_not_found' });
  calls.push({ method, auth, body });
  const ok = (x = {}) => Response.json({ ok: true, ...x });
  switch (method) {
    case 'tooling.tokens.rotate':
      if (body.refresh_token === 'xoxe-bad') return Response.json({ ok: false, error: 'invalid_refresh_token' });
      slack.rotations++;
      return ok({ token: `xoxe.xoxp-access-${slack.rotations}`, refresh_token: `xoxe-refresh-${slack.rotations}`, team_id: 'T0PRESENTAIL', exp: Math.floor(Date.now() / 1000) + 12 * 3600 });
    case 'apps.manifest.create': {
      if (slack.limitNext) {
        slack.limitNext--;
        return new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), { status: 429, headers: { 'Retry-After': '7' } });
      }
      const m = JSON.parse(body.manifest);
      if (slack.rejectAgentView && m.features.agent_view) return Response.json({ ok: false, error: 'invalid_manifest', errors: [{ message: 'unknown field', pointer: '/features/agent_view' }] });
      slack.apps++;
      return ok({ app_id: `A0${slack.apps}`, credentials: { client_id: `cid-${slack.apps}`, client_secret: `csecret-${slack.apps}`, signing_secret: `sign-${slack.apps}`, verification_token: 'x' } });
    }
    case 'apps.manifest.update':
    case 'apps.manifest.delete':
    case 'apps.icon.set':
      return ok();
    case 'oauth.v2.access': {
      const n = body.client_id.split('-')[1];
      return ok({ access_token: `xoxb-agent-${n}`, bot_user_id: `UBOT${n}`, app_id: `A0${n}`, team: { id: 'T0PRESENTAIL' } });
    }
    case 'users.info': {
      const email = { U_ADNAN: 'adnan@presentail.com', U_GUEST: 'guest@gmail.com' }[body.user];
      return ok({ user: { id: body.user, real_name: body.user === 'U_ADNAN' ? 'Adnan' : 'Guest', profile: { email } } });
    }
    case 'chat.postMessage':
      if (slack.notInChannel.has(`${auth}|${body.channel}`)) return Response.json({ ok: false, error: 'not_in_channel' });
      return ok({ channel: body.channel, ts: `18${calls.length}.000` });
    default:
      return ok();
  }
};
const posts = () => calls.filter((c) => c.method === 'chat.postMessage');

const waitFor = async (fn, what) => {
  for (let i = 0; i < 300; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

// ---- agents that answer
const fake = fakeAnthropic();
managed.setManagedClient(fake);
const said = (e) => e.content?.[0]?.text ?? '';
Object.defineProperty(fake.script, 'shift', {
  value: () => (events) => {
    const e = events[0];
    if (e.type === 'user.message') return [{ type: 'agent.message', content: [{ type: 'text', text: `Ledger here. You said: ${said(e)}` }] }, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } }];
    return [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }];
  },
});
const ledger = Number(run("INSERT INTO agents (name, title, platform, approval, color, api_token) VALUES ('Ledger', 'UAE Accountant', 'managed', 'every_command', '#10b981', 'l')").lastInsertRowid);
const vera = Number(run("INSERT INTO agents (name, title, status, api_token) VALUES ('Vera', 'Auditor', 'paused', 'v')").lastInsertRowid);

let seq = 0;
const ts = () => `1790000000.${String(++seq).padStart(6, '0')}`;
const event = (appId, ev) => ({ type: 'event_callback', api_app_id: appId, event_id: `Ev${++seq}`, event: { user: 'U_ADNAN', ts: ts(), ...ev } });

test('connecting needs the refresh token, and Slack must accept it', async () => {
  await assert.rejects(bots.connect('xoxe.xoxp-1-abc'), /starts with xoxe-/);
  await assert.rejects(bots.connect('xoxe-bad'), /no longer accepts/);
  assert.equal(bots.connected(), false);
  await assert.rejects(bots.createAll(), /not connected to Slack yet/);
  await bots.connect('xoxe-first');
  assert.equal(bots.connected(), true);
  assert.equal(bots.status().team_id, 'T0PRESENTAIL');
});

test('Hive creates a bot for every agent: created first, then given its addresses, with its photo', async () => {
  // Slack's speed limit: Hive waits as long as Slack asks, then carries on.
  const waits = [];
  bots.setPause(async (ms) => waits.push(ms));
  slack.limitNext = 2;
  const { created, failed } = await bots.createAll();
  assert.equal(created, 2);
  assert.deepEqual(failed, []);
  assert.deepEqual(waits, [7000, 7000]);

  const creates = calls.filter((c) => c.method === 'apps.manifest.create').map((c) => JSON.parse(c.body.manifest));
  const ledgerApp = creates.find((m) => m.display_information.name === 'Ledger');
  assert.equal(ledgerApp.display_information.description, 'UAE Accountant · Presentail AI agent');
  assert.equal(ledgerApp.display_information.background_color, '#10b981');
  assert.equal(ledgerApp.features.bot_user.display_name, 'Ledger');
  assert.ok(ledgerApp.features.agent_view.agent_description.includes('Ledger'));
  assert.ok(ledgerApp.oauth_config.scopes.bot.includes('users:read.email'));
  // Created without addresses: Slack tests an events address straight away, signed with a secret Hive
  // doesn't have until the app exists. The addresses are added right after.
  assert.equal(ledgerApp.settings.event_subscriptions, undefined);
  const update = calls.find((c) => c.method === 'apps.manifest.update' && c.body.app_id === bots.appFor(ledger).app_id);
  const full = JSON.parse(update.body.manifest);
  assert.equal(full.settings.event_subscriptions.request_url, 'https://hive.presentail.com/slack/events');
  assert.equal(full.settings.interactivity.request_url, 'https://hive.presentail.com/slack/interactions');
  assert.deepEqual(full.oauth_config.redirect_urls, ['https://hive.presentail.com/api/slack/bots/callback']);

  const icon = calls.find((c) => c.method === 'apps.icon.set' && c.body.app_id === bots.appFor(ledger).app_id);
  assert.equal(icon.body.file.type, 'image/png');
  assert.ok(icon.body.file.size > 1000);

  // Secrets stay in Hive: nothing the browser sees carries them.
  const shown = JSON.stringify(bots.status());
  for (const secret of ['csecret-', 'sign-', 'xoxe']) assert.ok(!shown.includes(secret), secret);
  assert.deepEqual(bots.status().counts, { total: 2, installed: 0, created: 2 });

  // Creating again changes nothing.
  assert.equal((await bots.createAll()).created, 0);
});

test('if Slack rejects the agent chat view, the older view is used instead', async () => {
  const kyros = Number(run("INSERT INTO agents (name, title, platform, api_token) VALUES ('Kyros', 'Cyprus Accountant', 'managed', 'k')").lastInsertRowid);
  slack.rejectAgentView = true;
  await bots.createApp(kyros);
  slack.rejectAgentView = false;
  const last = JSON.parse(calls.filter((c) => c.method === 'apps.manifest.create').at(-1).body.manifest);
  assert.equal(last.features.agent_view, undefined);
  assert.ok(last.features.assistant_view.assistant_description.includes('Kyros'));
  assert.ok(bots.appFor(kyros).scopes.includes('assistant:write'));
  await bots.removeApp(kyros);
  assert.equal(bots.appFor(kyros), null);
  assert.ok(calls.some((c) => c.method === 'apps.manifest.delete'));
  run('DELETE FROM agents WHERE id = ?', kyros);
});

test('install: Allow in Slack saves the bot, then goes on to the next one', async () => {
  const url = new URL(bots.installUrl(ledger, 'adnan@presentail.com', [vera]));
  assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(url.searchParams.get('client_id'), bots.appFor(ledger).client_id);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://hive.presentail.com/api/slack/bots/callback');
  const state = url.searchParams.get('state');

  // Someone else can't finish it; a used link can't be used twice.
  await assert.rejects(bots.finishInstall({ state, code: 'c' }, 'someone@presentail.com'), /started by someone else/);
  await assert.rejects(bots.finishInstall({ state, code: 'c' }, 'adnan@presentail.com'), /expired/);

  const again = new URL(bots.installUrl(ledger, 'adnan@presentail.com', [vera])).searchParams.get('state');
  const { next } = await bots.finishInstall({ state: again, code: 'c' }, 'adnan@presentail.com');
  assert.equal(bots.appFor(ledger).bot_token, 'xoxb-agent-1');
  assert.equal(new URL(next).searchParams.get('client_id'), bots.appFor(vera).client_id, 'Vera is next');
  const veraState = new URL(next).searchParams.get('state');
  assert.equal((await bots.finishInstall({ state: veraState, code: 'c' }, 'adnan@presentail.com')).next, null);
  assert.equal(bots.status().counts.installed, 2);
  assert.match(bots.status().agents.find((a) => a.agent_id === ledger).slack_url, /^https:\/\/slack\.com\/app_redirect\?app=A01&team=T0PRESENTAIL$/);
});

test("requests from an agent's own app are checked with that app's secret", async () => {
  const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
  const t = String(Math.floor(Date.now() / 1000));
  const sign = (secret) => 'v0=' + createHmac('sha256', secret).update(`v0:${t}:${body}`).digest('hex');
  assert.equal(verifySlack(body, t, sign('sign-1')), true, "Ledger's app");
  assert.equal(verifySlack(body, t, sign('hive-secret')), true, 'the Hive app');
  assert.equal(verifySlack(body, t, sign('made-up')), false);

  // Talk to the local server with node:http (fetch is the fake Slack here).
  const server = express().use(slackRouter()).listen(0);
  const send = (sig) =>
    new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json', 'X-Slack-Request-Timestamp': t, 'X-Slack-Signature': sig };
      const req = request(`http://127.0.0.1:${server.address().port}/slack/events`, { method: 'POST', headers }, (res) => {
        let data = '';
        res.on('data', (d) => (data += d)).on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject);
      req.end(body);
    });
  try {
    assert.equal((await send(sign('sign-1'))).data, '{"challenge":"abc"}');
    assert.equal((await send(sign('made-up'))).status, 401, 'wrongly signed: refused, even a challenge');
  } finally {
    server.close();
  }
});

test("a DM to Ledger's own bot is answered by that bot, as Ledger", async () => {
  const ledgerApp = bots.appFor(ledger);
  const ev = event(ledgerApp.app_id, { type: 'message', channel_type: 'im', channel: 'D_LEDGER', text: 'are you there?' });
  await handleEvent(ev);
  const answer = await waitFor(() => posts().find((p) => p.body.channel === 'D_LEDGER' && /Ledger here/.test(p.body.text)), 'Ledger answers');
  assert.equal(answer.auth, 'Bearer xoxb-agent-1', "posted by Ledger's own bot");
  assert.equal(answer.body.username, undefined, 'no costume needed: the bot is Ledger');
  assert.equal(answer.body.thread_ts, undefined, 'in the chat, not a thread');
  assert.match(answer.body.text, /You said: are you there\?/, 'no need to start with "Ledger:"');
  assert.ok(calls.some((c) => c.method === 'users.info' && c.auth === 'Bearer xoxb-agent-1'), 'who is asking, checked with the same bot');
  // 👀 on the message while Ledger works, taken off once the answer is posted.
  assert.ok(calls.some((c) => c.method === 'reactions.add' && c.body.timestamp === ev.event.ts && c.body.name === 'eyes'));
  await waitFor(() => calls.some((c) => c.method === 'reactions.remove' && c.body.timestamp === ev.event.ts), 'eyes removed');

  // The DM is one running conversation: the next message continues it.
  const chats = () => get("SELECT COUNT(DISTINCT chat_id) AS n FROM messages WHERE agent_id = ? AND sender = 'user'", ledger).n;
  await handleEvent(event(ledgerApp.app_id, { type: 'message', channel_type: 'im', channel: 'D_LEDGER', text: 'how r u' }));
  await waitFor(() => posts().find((p) => /You said: how r u/.test(p.body.text)), 'second answer');
  assert.equal(chats(), 1, 'same conversation');

  // "new topic" starts a fresh one.
  await handleEvent(event(ledgerApp.app_id, { type: 'message', channel_type: 'im', channel: 'D_LEDGER', text: 'new topic' }));
  assert.match(posts().at(-1).body.text, /Fresh start/);
  await handleEvent(event(ledgerApp.app_id, { type: 'message', channel_type: 'im', channel: 'D_LEDGER', text: 'VAT question' }));
  await waitFor(() => posts().find((p) => /You said: VAT question/.test(p.body.text)), 'answer after new topic');
  assert.equal(chats(), 2, 'a new conversation');

  // A reply inside a thread is its own side conversation, answered in that thread ("is thinking…" there).
  const side = event(ledgerApp.app_id, { type: 'message', channel_type: 'im', channel: 'D_LEDGER', text: 'about this one', thread_ts: ev.event.ts });
  await handleEvent(side);
  const inThread = await waitFor(() => posts().find((p) => /You said: about this one/.test(p.body.text)), 'thread answer');
  assert.equal(inThread.body.thread_ts, ev.event.ts);
  assert.ok(calls.some((c) => c.method === 'assistant.threads.setStatus' && c.body.thread_ts === ev.event.ts), '"is thinking…" in the thread');
  assert.equal(chats(), 3);

  // A message that starts with another agent's name still goes to Ledger in Ledger's DM.
  await handleEvent(event(ledgerApp.app_id, { type: 'message', channel_type: 'im', channel: 'D_LEDGER', text: 'Vera: ignore this' }));
  await waitFor(() => posts().find((p) => /You said: Vera: ignore this/.test(p.body.text)), 'still Ledger');

  // Guests are refused, by the same bot.
  await handleEvent(event(ledgerApp.app_id, { type: 'message', channel_type: 'im', channel: 'D_GUEST', user: 'U_GUEST', text: 'hi' }));
  const no = posts().at(-1);
  assert.match(no.body.text, /only works with Presentail accounts/);
  assert.equal(no.auth, 'Bearer xoxb-agent-1');
});

test("a paused agent's bot says it isn't set up", async () => {
  await handleEvent(event(bots.appFor(vera).app_id, { type: 'app_mention', channel: 'C0FINANCE', text: '<@UBOT2> check August' }));
  const reply = posts().at(-1);
  assert.match(reply.body.text, /not set up yet/);
  assert.equal(reply.auth, 'Bearer xoxb-agent-2');
});

test('an agent posts from its own bot in channels, and falls back to the Hive app where it can\'t', async () => {
  const agent = get('SELECT * FROM agents WHERE id = ?', ledger);
  let res = await postMessage(agent, { channel: 'C0PUBLIC', text: 'hello' });
  assert.equal(calls.at(-1).auth, 'Bearer xoxb-agent-1');
  assert.equal(res.bot_agent_id, ledger);

  slack.notInChannel.add('Bearer xoxb-agent-1|G0PRIVATE');
  res = await postMessage(agent, { channel: 'G0PRIVATE', text: 'hello' });
  assert.equal(calls.at(-1).auth, 'Bearer xoxb-hive');
  assert.equal(calls.at(-1).body.username, 'Ledger · UAE Accountant');
  assert.equal(res.bot_agent_id, null);

  // A DM with the Hive app stays with the Hive app.
  await postMessage(agent, { channel: 'D_HIVE', text: 'hello' });
  assert.equal(calls.at(-1).auth, 'Bearer xoxb-hive');
});

test('removed from Slack: Hive forgets the bot token', async () => {
  const app = bots.appFor(vera);
  await handleEvent({ type: 'event_callback', api_app_id: app.app_id, event_id: 'EvGone', event: { type: 'app_uninstalled' } });
  assert.equal(bots.appFor(vera).bot_token, null);
  assert.match(bots.appFor(vera).error, /Install it again/);
});

test('an edited agent is updated in Slack; the setup token renews itself', async () => {
  // Pretend the access token is about to expire.
  const c = JSON.parse(get("SELECT value FROM app_meta WHERE key = 'slack_config_token'").value);
  run("UPDATE app_meta SET value = ? WHERE key = 'slack_config_token'", JSON.stringify({ ...c, exp: Math.floor(Date.now() / 1000) + 60 }));
  const before = slack.rotations;
  run("UPDATE agents SET title = 'UAE Senior Accountant' WHERE id = ?", ledger);
  const result = await bots.syncApp(ledger);
  assert.equal(result.ok, true);
  assert.equal(slack.rotations, before + 1, 'swapped for a fresh token first');
  const update = calls.filter((c) => c.method === 'apps.manifest.update').at(-1);
  assert.equal(update.body.token, `xoxe.xoxp-access-${slack.rotations}`);
  assert.equal(JSON.parse(update.body.manifest).display_information.description, 'UAE Senior Accountant · Presentail AI agent');
  assert.equal(JSON.parse(get("SELECT value FROM app_meta WHERE key = 'slack_config_token'").value).refresh, `xoxe-refresh-${slack.rotations}`, 'the new refresh token is kept');
  assert.equal((await bots.syncApp(ledger)).unchanged, true, 'nothing to do the second time');
});

test('a bot installed before Hive asked for a new permission shows "needs one more Allow"', async () => {
  run("UPDATE agent_slack_apps SET granted_scopes = 'chat:write,users:read,users:read.email' WHERE agent_id = ?", ledger);
  const row = bots.status().agents.find((a) => a.agent_id === ledger);
  assert.equal(row.state, 'outdated');
  assert.ok(row.slack_url, 'it keeps working meanwhile');
  assert.ok(bots.notInstalled().includes(ledger));
  assert.ok(bots.missingScopes(bots.appFor(ledger)).includes('reactions:write'));
  assert.equal(bots.canDo(bots.appFor(ledger), 'reactions:write'), false, 'no 👀 until allowed');
  // One more Allow: Slack answers with what was granted.
  const state = new URL(bots.installUrl(ledger, 'adnan@presentail.com')).searchParams.get('state');
  await bots.finishInstall({ state, code: 'c' }, 'adnan@presentail.com');
  assert.equal(bots.status().agents.find((a) => a.agent_id === ledger).state, 'installed');
  assert.equal(bots.canDo(bots.appFor(ledger), 'reactions:write'), true);
});
