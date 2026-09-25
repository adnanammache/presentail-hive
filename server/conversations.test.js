// People DM agents in Slack; agents message each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.PUBLIC_URL = 'https://hive.presentail.com';
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ALERT_CHANNEL = 'C0ALERTS';
process.env.SLACK_AGENTS_CHANNEL = 'C0AGENTS';
process.env.SLACK_SIGNING_SECRET = 'shh';
process.env.OWNER_EMAILS = 'adnan@presentail.com';

const { all, get, run } = await import('./db.js');
const managed = await import('./managed.js');
const conv = await import('./conversations.js');
const { handleEvent } = await import('./slack.js');
const { agentAvatarPng } = await import('./avatars.js');
const { fakeAnthropic } = await import('./testing/fake-anthropic.js');

const posts = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.endsWith('/users.info')) {
    const { user } = JSON.parse(init.body);
    const email = { U_ADNAN: 'adnan@presentail.com', U_GUEST: 'guest@gmail.com' }[user];
    return Response.json({ ok: true, user: { id: user, real_name: user === 'U_ADNAN' ? 'Adnan' : 'Guest', profile: { email } } });
  }
  if (url.startsWith('https://files.slack.com/')) {
    assert.equal(init.headers.Authorization, 'Bearer xoxb-test');
    return new Response('%PDF careem');
  }
  if (url.startsWith('https://slack.com/api/')) {
    const body = JSON.parse(init.body);
    posts.push({ method: url.split('/').pop(), ...body });
    return Response.json({ ok: true, channel: body.channel, ts: `17${posts.length}.000` });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const waitFor = async (fn, what) => {
  for (let i = 0; i < 300; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};
const said = (e) => e.content?.[0]?.text ?? '';
const idle = { type: 'session.status_idle', stop_reason: { type: 'end_turn' } };

const fake = fakeAnthropic();
managed.setManagedClient(fake);
// One responder for every session, by what was sent.
Object.defineProperty(fake.script, 'shift', {
  value: () => (events) => {
    const e = events[0];
    if (e.type === 'user.message' && said(e).startsWith('Message from Ledger'))
      return [{ type: 'agent.message', content: [{ type: 'text', text: 'The August SAL→LTD balance is EUR 4,050.00.' }] }, idle];
    if (e.type === 'user.message' && said(e).startsWith('Task #') && said(e).includes('intercompany'))
      return [
        { id: 'ask_1', type: 'agent.custom_tool_use', name: 'message_agent', input: { agent: 'Cyprus Accountant', message: 'What is the August intercompany balance?' } },
        { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['ask_1'] } },
      ];
    if (e.type === 'user.message' && said(e).startsWith('Task #'))
      return [
        { id: 'post_1', type: 'agent.tool_use', name: 'bash', input: { command: 'python post_careem.py' }, evaluated_permission: 'ask' },
        { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['post_1'] } },
      ];
    if (e.type === 'user.message') return [{ type: 'agent.message', content: [{ type: 'text', text: `**Hi Adnan**, you said: ${said(e)}` }] }, idle];
    if (e.type === 'user.custom_tool_result') return [{ type: 'agent.message', content: [{ type: 'text', text: 'Thanks, noted.' }] }, idle];
    return [idle];
  },
});

const ledger = Number(run("INSERT INTO agents (name, title, platform, approval, color, api_token) VALUES ('Ledger', 'UAE Accountant', 'managed', 'every_command', '#10b981', 'l')").lastInsertRowid);
const kyros = Number(run("INSERT INTO agents (name, title, platform, api_token) VALUES ('Kyros', 'Cyprus Accountant', 'managed', 'k')").lastInsertRowid);
run("INSERT INTO agents (name, title, status, api_token) VALUES ('Vera', 'Auditor', 'paused', 'v')");

let seq = 0; // Slack timestamps are unique per message
const dm = (text, extra = {}) => ({ type: 'event_callback', event_id: `Ev${++seq}`, event: { type: 'message', channel_type: 'im', channel: 'D_ADNAN', user: 'U_ADNAN', ts: `1790000000.${String(++seq).padStart(6, '0')}`, text, ...extra } });

test('addressing an agent by name or title', async () => {
  assert.equal((await agentAvatarPng(ledger)).subarray(1, 4).toString(), 'PNG');
  assert.equal(conv.splitAddressee('Ledger: do Careem').agent.id, ledger);
  assert.equal(conv.splitAddressee('ledger, do Careem').rest, 'do Careem');
  assert.equal(conv.splitAddressee('@Kyros what is the balance').agent.id, kyros);
  assert.equal(conv.splitAddressee('Cyprus Accountant: hi').agent.id, kyros);
  assert.equal(conv.splitAddressee('Note: this is not an agent').agent, null);
  
});

test('only Presentail people are served', async () => {
  await handleEvent({ ...dm('Ledger: hi'), event: { ...dm('Ledger: hi').event, user: 'U_GUEST' } });
  assert.match(posts.at(-1).text, /only works with Presentail accounts/);
  assert.equal(get('SELECT COUNT(*) AS n FROM messages').n, 0);
});

test('a DM to an agent is answered in the thread, as the agent', async () => {
  const ev = dm('Ledger: are you there?');
  await handleEvent(ev);
  const answer = await waitFor(() => posts.find((p) => p.username?.startsWith('Ledger') && /Hi Adnan/.test(p.text)), 'Ledger answers');
  assert.equal(answer.channel, 'D_ADNAN');
  assert.equal(answer.thread_ts, ev.event.ts);
  assert.equal(answer.username, 'Ledger · UAE Accountant');
  assert.match(answer.icon_url, new RegExp(`^https://hive.presentail.com/avatars/${ledger}\\.png`));
  assert.match(answer.text, /^\*Hi Adnan\*/, 'Markdown bold becomes Slack bold');
  // The conversation is also in Hive's inbox, marked as from Slack.
  const q = get("SELECT * FROM messages WHERE agent_id = ? AND sender = 'user'", ledger);
  assert.equal(JSON.parse(q.meta).user, 'Adnan');

  // Same event again (Slack retry): handled once.
  const before = posts.length;
  await handleEvent(ev);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(posts.length, before);

  // "remember:" teaches the agent instead of chatting.
  await handleEvent(dm('Ledger: remember: Careem Dubai orders use place of supply Dubai, never Abu Dhabi.'));
  assert.match(posts.at(-1).text, /Noted/);
  assert.equal(get("SELECT text FROM agent_lessons WHERE agent_id = ?", ledger).text, 'Careem Dubai orders use place of supply Dubai, never Abu Dhabi.');

  // No name: the last agent in this DM. Paused agents say so.
  await handleEvent(dm('Vera: can you check August?'));
  assert.match(posts.at(-1).text, /not set up yet/);
});

test('files in a DM become a task; its approval comes back to the same thread', async () => {
  const ev = dm('Careem for August', { subtype: 'file_share', files: [{ name: 'careem-aug.pdf', url_private_download: 'https://files.slack.com/careem-aug.pdf' }] });
  await handleEvent(ev);
  const task = await waitFor(() => get("SELECT * FROM tasks WHERE title = 'Careem for August'"), 'task');
  assert.equal(task.agent_id, ledger, 'the last agent in this DM');
  assert.deepEqual(all('SELECT filename FROM task_files WHERE task_id = ?', task.id).map((f) => f.filename), ['careem-aug.pdf']);
  const approval = await waitFor(() => posts.find((p) => p.thread_ts === ev.event.ts && /need your approval before/.test(p.text)), 'approval in thread');
  assert.equal(approval.channel, 'D_ADNAN');
  assert.equal(approval.username, 'Ledger · UAE Accountant');
  assert.ok(JSON.stringify(approval.blocks).includes('hive_approve'));
  assert.ok(!posts.some((p) => p.channel === 'C0ALERTS' && /approval/.test(p.text)), 'not duplicated in the alerts channel');
});

test('agents message each other; the exchange is logged and shown in Slack', async () => {
  const t = Number(run("INSERT INTO tasks (title, description, agent_id) VALUES ('Check intercompany', 'Reconcile intercompany for August', ?)", ledger).lastInsertRowid);
  const r = managed.startTaskRun(t);
  const dmRow = await waitFor(() => get("SELECT * FROM agent_dms WHERE status = 'answered'"), 'answer');
  assert.equal(dmRow.from_agent_id, ledger);
  assert.equal(dmRow.to_agent_id, kyros);
  assert.match(dmRow.reply, /EUR 4,050\.00/);

  // Ledger got Kyros's answer as the tool result.
  const result = await waitFor(() => fake.calls.sent.find((s) => s.events[0].type === 'user.custom_tool_result' && s.events[0].custom_tool_use_id === 'ask_1'), 'tool result');
  assert.match(result.events[0].content[0].text, /Kyros replied:[\s\S]*EUR 4,050\.00/);

  // Mirrored in the agents channel: the question from Ledger, the answer in its thread from Kyros.
  const q = posts.find((p) => p.channel === 'C0AGENTS' && !p.thread_ts);
  assert.equal(q.username, 'Ledger · UAE Accountant');
  assert.match(q.text, /→ Kyros/);
  const a = await waitFor(() => posts.find((p) => p.channel === 'C0AGENTS' && p.thread_ts), 'answer mirrored');
  assert.equal(a.username, 'Kyros · Cyprus Accountant');
  await waitFor(() => get('SELECT status FROM runs WHERE id = ?', r.id).status === 'waiting', 'Ledger done');

  // Asking someone unknown or unavailable fails politely.
  assert.match((await conv.askAgent(ledger, 'Nobody', 'hi')).text, /no agent called/);
  assert.match((await conv.askAgent(ledger, 'Auditor', 'hi')).text, /isn't set up yet/);
  assert.match((await conv.askAgent(ledger, 'directory', '')).text, /Kyros: Cyprus Accountant/);
});
