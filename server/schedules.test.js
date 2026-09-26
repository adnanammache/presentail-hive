// Recurring tasks end to end: agent tools, permissions, the durable scheduler, delivery, retries,
// concurrency, lifecycle and the HTTP API. Time is controlled (every engine call takes `now`); the
// Anthropic API is simulated; webhooks are local test servers. Nothing real is scheduled or posted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const DB_FILE = join(mkdtempSync(join(tmpdir(), 'hive-schedules-')), 'hive.db'); // a file, so other processes can share it
process.env.DB_PATH = DB_FILE;
process.env.HIVE_SCHEDULER = 'off';
process.env.PUBLIC_URL = 'https://hive.test';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.SLACK_BOT_TOKEN;
delete process.env.OWNER_EMAILS;

const express = (await import('express')).default;
const { agentRouter, dashboardRouter, errorHandler } = await import('./app.js');
const { all, get, run } = await import('./db.js');
const managed = await import('./managed.js');
const { fakeAnthropic } = await import('./testing/fake-anthropic.js');
const S = await import('./schedules.js');
const { handleScheduleTool, SCHEDULE_TOOLS } = await import('./scheduleTools.js');
const { knownUser } = await import('./roles.js');
const { formatLocal } = await import('./recurring.js');

const fake = fakeAnthropic();
managed.setManagedClient(fake);

let base;
let server;
const hooks = []; // local webhook servers
before(() => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const email = req.get('x-user');
    if (email) req.user = { email, name: get('SELECT name FROM users WHERE email = ?', email)?.name ?? email };
    next();
  });
  app.use('/api/agent', agentRouter());
  app.use('/api', dashboardRouter());
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
});
after(() => {
  S.stopScheduleTicker();
  server.closeAllConnections();
  server.close();
  for (const h of hooks) (h.closeAllConnections(), h.close());
});

const call = async (path, { method = 'GET', body, as = 'adnan@presentail.com' } = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'x-user': as }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const waitFor = async (fn, what) => {
  for (let i = 0; i < 300; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

// ---------------------------------------------------------------- fixtures

for (const [email, name, role] of [
  ['adnan@presentail.com', 'Adnan Ammache', 'owner'],
  ['omar@presentail.com', 'Omar Haddad', 'member'],
  ['omar.k@presentail.com', 'Omar Khalil', 'member'],
  ['sara@presentail.com', 'Sara Nassar', 'member'],
  ['lina@presentail.com', 'Lina Aoun', 'member'],
]) run('INSERT INTO users (email, name, role) VALUES (?, ?, ?)', email, name, role);
const team = Number(run("INSERT INTO teams (name) VALUES ('Accounting')").lastInsertRowid);
const agent = (name, title, platform = 'managed', extra = {}) =>
  Number(
    run(
      'INSERT INTO agents (name, title, team_id, platform, status, api_token, webhook_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
      name, title, team, platform, extra.status ?? 'idle', `agt_${name}`, extra.webhook_url ?? '',
    ).lastInsertRowid,
  );
const LEDGER = agent('Ledger', 'UAE Accountant');
const KYROS = agent('Kyros', 'Finance Agent');
const POLLER = agent('Poller', 'Queue Worker', 'custom');

/** A local webhook whose answers the test controls. */
async function webhookAgent(name, respond) {
  const hits = [];
  const h = createServer((req, res) => {
    hits.push(req.url);
    const [status, body] = respond(hits.length);
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise((r) => h.listen(0, r));
  hooks.push(h);
  return { id: agent(name, 'Webhook Bot', 'custom', { webhook_url: `http://localhost:${h.address().port}/hook` }), hits };
}

const person = (email) => ({ actor: { type: 'user', ref: email, name: knownUser(email).name }, user: knownUser(email), via: 'ui' });
/**
 * A Hive chat turn: the person's message, and the agent's chat run answering it. (Stored as ended so
 * the real chat in the end-to-end test starts its own session; the tools don't look at the status.)
 */
function chat(agentId, by, text) {
  run("INSERT INTO messages (agent_id, sender, body, meta) VALUES (?, 'user', ?, ?)", agentId, text, JSON.stringify({ by, origin: 'hive' }));
  return Number(run("INSERT INTO runs (kind, agent_id, status, origin, requested_by) VALUES ('chat', ?, 'ended', 'hive', ?)", agentId, by).lastInsertRowid);
}
let eventN = 0;
const tool = (runId, name, input, now) => {
  const r = handleScheduleTool(runId, name, input, { eventId: `evt_${++eventN}`, now });
  return { ...JSON.parse(r.text), is_error: Boolean(r.is_error) };
};
const wf = (id) => get('SELECT * FROM workflows WHERE id = ?', id);
const occs = (id) => all('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY scheduled_for, id', id);
const tasksOf = (id) => all('SELECT * FROM tasks WHERE workflow_id = ? ORDER BY id', id);
const T = (s) => new Date(s);
/** A task's run, once its (simulated) session exists. */
const runOf = (taskId) => waitFor(() => get('SELECT * FROM runs WHERE task_id = ? AND session_id IS NOT NULL', taskId), `the run for task ${taskId}`);
const plus = (d, ms) => new Date(new Date(d).getTime() + ms);
const MIN = 60000;
const DAY = 86400000;

const WEEKLY_MON = { freq: 'weekly', weekdays: ['mon'], time: '09:00' };
const T0 = T('2026-10-01T06:00:00Z'); // Thursday 1 Oct 2026, 10:00 in Dubai

// ---------------------------------------------------------------- agent tools

test('the tools are registered on every managed agent, and agents are told when to use them', async () => {
  const names = SCHEDULE_TOOLS.map((t) => t.name);
  assert.deepEqual(names, ['schedule_recurring_task', 'list_recurring_tasks', 'get_recurring_task', 'update_recurring_task', 'pause_recurring_task', 'resume_recurring_task', 'cancel_recurring_task', 'find_assignees']);
  await managed.syncAgent(LEDGER);
  const config = fake.calls.agentsCreate.at(-1);
  for (const n of names) assert.ok(config.tools.some((t) => t.type === 'custom' && t.name === n), `${n} is registered`);
  assert.match(config.system, /## Recurring tasks/);
  assert.match(config.system, /Only when a person explicitly asks you/);
  assert.match(config.system, /Never tell people to set up a schedule by hand/);
});

test('an agent schedules recurring work for itself from a request, and confirms what was stored', () => {
  const text = 'Every Monday at 9 AM Dubai time, check outstanding supplier invoices and prepare a summary.';
  const runId = chat(LEDGER, 'adnan@presentail.com', text);
  const input = {
    user_request: 'Every Monday at 9 AM Dubai time, check outstanding supplier invoices and prepare a summary',
    title: 'Check outstanding supplier invoices',
    instructions: 'Check outstanding supplier invoices in Wafeq and prepare a summary by supplier with ageing.',
    expected_result: 'A summary of outstanding supplier invoices',
    recurrence: { frequency: 'weekly', weekdays: ['mon'], time: '09:00' },
    timezone: 'Asia/Dubai',
  };
  const res = handleScheduleTool(runId, 'schedule_recurring_task', input, { eventId: 'sevt_create_1', now: T0 });
  const out = JSON.parse(res.text);
  assert.equal(out.ok, true, res.text);
  const stored = wf(out.schedule_id);
  // Structured result, read back from the database.
  assert.equal(out.status, 'active');
  assert.equal(out.recurrence, 'Every Monday at 9:00 AM');
  assert.equal(out.timezone, 'Asia/Dubai');
  assert.equal(out.next_run, stored.next_run_at);
  assert.equal(stored.next_run_at, '2026-10-05T05:00:00.000Z');
  assert.equal(out.execution_mode, 'create_and_start');
  assert.equal(out.manage_url, `https://hive.test/#/workflows/${stored.id}`);
  assert.deepEqual(out.assigned_to, { type: 'agent', id: LEDGER, name: 'Ledger' });
  // Identities come from the run, not from the model.
  assert.equal(stored.agent_id, LEDGER);
  assert.equal(stored.created_by_type, 'agent');
  assert.equal(stored.created_by_ref, String(LEDGER));
  assert.equal(stored.authorized_by, 'adnan@presentail.com');
  assert.equal(JSON.parse(stored.authorization).request, input.user_request);
  // The confirmation matches the stored schedule.
  assert.equal(
    out.confirmation,
    `Scheduled: every Monday at 9:00 AM, Asia/Dubai. I'll check outstanding supplier invoices. Each occurrence will create a task and start automatically. Next run: ${formatLocal(stored.next_run_at, 'Asia/Dubai')}. Manage schedule: https://hive.test/#/workflows/${stored.id}`,
  );
  assert.match(out.confirmation, /Next run: Mon 5 Oct 2026, 9:00 AM/);

  // The same tool call delivered twice, and the same request made twice: still one schedule.
  assert.equal(JSON.parse(handleScheduleTool(runId, 'schedule_recurring_task', input, { eventId: 'sevt_create_1', now: T0 }).text).schedule_id, stored.id);
  const again = tool(runId, 'schedule_recurring_task', input, T0);
  assert.equal(again.schedule_id, stored.id);
  assert.equal(again.already_existed, true);
  assert.equal(get("SELECT COUNT(*) AS n FROM workflows WHERE name = 'Check outstanding supplier invoices'").n, 1);
  // get / list read it back.
  const got = tool(runId, 'get_recurring_task', { schedule_id: stored.id }, T0);
  assert.equal(got.next_occurrences.length, 5);
  assert.equal(got.next_occurrences[1].local, 'Mon 12 Oct 2026, 9:00 AM');
  assert.equal(tool(runId, 'list_recurring_tasks', {}, T0).recurring_tasks[0].schedule_id, stored.id);
});

test('scheduling needs the person’s own words: documents and the agent’s ideas are not enough', () => {
  const runId = chat(LEDGER, 'adnan@presentail.com', 'Can you read the attached SOP and tell me what it says?');
  const r = tool(runId, 'schedule_recurring_task', {
    user_request: 'The SOP says: reconcile the bank every Friday',
    title: 'Bank reconciliation', instructions: 'Reconcile the bank', recurrence: { frequency: 'weekly', weekdays: ['fri'] },
  }, T0);
  assert.equal(r.is_error, true);
  assert.match(r.error, /doesn't match anything the person wrote/);
  assert.equal(get("SELECT COUNT(*) AS n FROM workflows WHERE name = 'Bank reconciliation'").n, 0);

  // Another agent asking (a consult) can look but not schedule.
  const consult = Number(run("INSERT INTO runs (kind, agent_id, status) VALUES ('consult', ?, 'ended')", LEDGER).lastInsertRowid);
  const c = tool(consult, 'schedule_recurring_task', { user_request: 'x', title: 'X', instructions: 'X', recurrence: { frequency: 'daily' } }, T0);
  assert.match(c.error, /asked this by another agent/);
  // A chat with no known person behind it (e.g. a system message) can't either.
  const anon = Number(run("INSERT INTO runs (kind, agent_id, status, origin) VALUES ('chat', ?, 'ended', 'hive')", LEDGER).lastInsertRowid);
  assert.match(tool(anon, 'pause_recurring_task', { schedule_id: 1, user_request: 'pause it' }, T0).error, /can't tell which workspace member/);
});

test('an agent schedules work for another agent and for people, resolving names first', () => {
  const text = 'Every Monday, have the Finance agent reconcile invoices. Create a task for Omar every month to approve the expense report. Every Friday, remind me to review outstanding payments.';
  const runId = chat(LEDGER, 'adnan@presentail.com', text);

  // Another agent: its own id; tasks will start with ITS runtime.
  const fin = tool(runId, 'schedule_recurring_task', {
    user_request: 'Every Monday, have the Finance agent reconcile invoices',
    assignee: { type: 'agent', name: 'Finance agent' },
    title: 'Reconcile invoices', instructions: 'Reconcile last week’s invoices against the bank.', recurrence: { frequency: 'weekly', weekdays: ['mon'], time: '09:00' }, timezone: 'Asia/Dubai',
  }, T0);
  assert.equal(fin.ok, true, fin.error);
  assert.deepEqual(fin.assigned_to, { type: 'agent', id: KYROS, name: 'Kyros' });
  assert.equal(fin.confirmation, `Scheduled: Kyros will reconcile invoices every Monday at 9:00 AM, Asia/Dubai. Tasks will start automatically. Next run: Mon 5 Oct 2026, 9:00 AM. Manage schedule: https://hive.test/#/workflows/${fin.schedule_id}`);
  assert.equal(wf(fin.schedule_id).created_by_ref, String(LEDGER), 'created by Ledger');
  assert.equal(wf(fin.schedule_id).agent_id, KYROS, 'assigned to Kyros');

  // "Omar" is two people: asked, not guessed.
  const found = tool(runId, 'find_assignees', { query: 'omar' }, T0);
  assert.deepEqual(found.candidates.map((c) => c.id), ['omar@presentail.com', 'omar.k@presentail.com']);
  const ambiguous = tool(runId, 'schedule_recurring_task', {
    user_request: 'Create a task for Omar every month to approve the expense report', assignee: { type: 'person', name: 'Omar' },
    title: 'Approve the expense report', instructions: 'Approve last month’s expense report.', recurrence: { frequency: 'monthly', day_of_month: 1 }, timezone: 'Asia/Dubai',
  }, T0);
  assert.equal(ambiguous.is_error, true);
  assert.match(ambiguous.error, /matches 2: Omar Haddad \(person omar@presentail.com.*Omar Khalil.*Ask the person which one/);
  assert.equal(get("SELECT COUNT(*) AS n FROM workflows WHERE name = 'Approve the expense report'").n, 0);

  // People are never started: create_and_start is refused, create_only is the default.
  const started = tool(runId, 'schedule_recurring_task', {
    user_request: 'Create a task for Omar every month', assignee: { type: 'person', id: 'omar@presentail.com' }, mode: 'create_and_start',
    title: 'Approve the expense report', instructions: 'Approve it.', recurrence: { frequency: 'monthly', day_of_month: 1 },
  }, T0);
  assert.match(started.error, /People are never started automatically/);
  const omar = tool(runId, 'schedule_recurring_task', {
    user_request: 'Create a task for Omar every month to approve the expense report', assignee: { type: 'person', id: 'omar@presentail.com' },
    title: 'Approve the expense report', instructions: 'Approve last month’s expense report.', recurrence: { frequency: 'monthly', day_of_month: 1 }, timezone: 'Asia/Dubai',
  }, T0);
  assert.equal(omar.ok, true, omar.error);
  assert.equal(omar.execution_mode, 'create_only');
  assert.equal(omar.confirmation, `Scheduled: Omar Haddad will receive a task “Approve the expense report” monthly on the 1st at 9:00 AM, Asia/Dubai. Next task: Sun 1 Nov 2026, 9:00 AM. Manage schedule: https://hive.test/#/workflows/${omar.schedule_id}`);
  assert.match(omar.notes.join(' '), /time/i, 'the default time is stated');

  // "me" is the person asking.
  const me = tool(runId, 'schedule_recurring_task', {
    user_request: 'Every Friday, remind me to review outstanding payments', assignee: { type: 'person', name: 'me' }, mode: 'create_only',
    title: 'Review outstanding payments', instructions: 'Review outstanding payments.', recurrence: { frequency: 'weekly', weekdays: ['fri'] },
  }, T0);
  assert.equal(me.ok, true, me.error);
  assert.equal(wf(me.schedule_id).assignee_email, 'adnan@presentail.com');
  assert.match(me.confirmation, /^Scheduled: You will receive a task “Review outstanding payments” every Friday at 9:00 AM, Asia\/Dubai\./);
  assert.match(me.notes.join(' '), /No time zone given, so it uses the workspace default, Asia\/Dubai/);

  // Outside this workspace: refused.
  const outsider = tool(runId, 'schedule_recurring_task', {
    user_request: 'Create a task for Omar every month', assignee: { type: 'person', id: 'omar@othercompany.com' },
    title: 'X', instructions: 'X', recurrence: { frequency: 'monthly', day_of_month: 1 },
  }, T0);
  assert.match(outsider.error, /not a member of this workspace/);
  assert.match(tool(runId, 'schedule_recurring_task', { user_request: 'Every Monday', assignee: { type: 'agent', id: 9999 }, title: 'X', instructions: 'X', recurrence: { frequency: 'daily' } }, T0).error, /Unknown agent/);
});

// ---------------------------------------------------------------- delivery

test('people get a normal task and a notice; they are never started', async () => {
  const { schedule } = S.createSchedule({ title: 'Approve expense report', instructions: 'Approve it.', assignee: 'user:omar@presentail.com', rule: { freq: 'monthly', month_day: 1 }, timezone: 'Asia/Dubai' }, person('adnan@presentail.com'), { now: T0 });
  assert.equal(schedule.mode, 'create_only');
  const due = T(schedule.next_run_at);
  await S.tickSchedules(plus(due, 30000));
  const [task] = tasksOf(schedule.id);
  assert.equal(task.assignee_email, 'omar@presentail.com');
  assert.equal(task.agent_id, null);
  assert.equal(task.status, 'ready', 'not In progress');
  assert.equal(get('SELECT COUNT(*) AS n FROM runs WHERE task_id = ?', task.id).n, 0, 'no AI execution');
  const [o] = occs(schedule.id);
  assert.equal(o.state, 'created');
  assert.equal(o.dispatch_status, 'none');
  assert.equal(o.status, 'running', 'delivered, but the task itself is not done');
  assert.ok(get("SELECT 1 FROM reminders WHERE user_email = 'omar@presentail.com' AND task_id = ?", task.id), 'Omar is notified');
  assert.equal(task.created_by, 'adnan@presentail.com', 'the authorizing person owns the review');
  assert.equal(task.occurrence_id, o.id);
  assert.equal(task.scheduled_for, o.scheduled_for);
});

test('create only vs create and start; another agent runs with its own runtime', async () => {
  const only = S.createSchedule({ title: 'Prepare VAT workings', instructions: 'Prepare them.', assignee: `agent:${LEDGER}`, mode: 'create_only', rule: WEEKLY_MON, timezone: 'Asia/Dubai' }, person('adnan@presentail.com'), { now: T0 }).schedule;
  // Ledger (acting for Adnan) schedules work for Kyros: Kyros's runtime runs it.
  const r = chat(LEDGER, 'adnan@presentail.com', 'Every Monday have Kyros post the bank feed');
  const cross = tool(r, 'schedule_recurring_task', { user_request: 'Every Monday have Kyros post the bank feed', assignee: { type: 'agent', id: KYROS }, title: 'Post the bank feed', instructions: 'Post it.', recurrence: { frequency: 'weekly', weekdays: ['mon'], time: '10:00' }, timezone: 'Asia/Dubai' }, T0);
  assert.equal(cross.ok, true, cross.error);

  const at = plus(T('2026-10-05T06:00:00Z'), 30000); // Monday 10:00:30 Dubai: both are due
  const sessionsBefore = fake.calls.sessions.length;
  await S.tickSchedules(at);
  const [a] = tasksOf(only.id);
  assert.equal(a.status, 'ready');
  assert.equal(get('SELECT COUNT(*) AS n FROM runs WHERE task_id = ?', a.id).n, 0, 'create only: nothing starts');
  assert.equal(occs(only.id)[0].dispatch_status, 'none');

  const [b] = tasksOf(cross.schedule_id);
  assert.equal(b.agent_id, KYROS);
  const execution = await runOf(b.id);
  assert.equal(execution.agent_id, KYROS, "the recipient's own agent runs it");
  await waitFor(() => fake.calls.sessions.length > sessionsBefore, 'a session');
  assert.equal(fake.calls.sessions.at(-1).agent.id, get('SELECT ma_agent_id FROM agents WHERE id = ?', KYROS).ma_agent_id, "Kyros's configuration, tools and approval rules");
  assert.equal(occs(cross.schedule_id)[0].dispatch_status, 'dispatched');
});

test('one task per occurrence: repeated ticks, concurrent workers in this process and in two others', async () => {
  const { schedule } = S.createSchedule({ title: 'Weekly timesheet', instructions: 'Submit it.', assignee: 'user:sara@presentail.com', rule: WEEKLY_MON, timezone: 'Asia/Dubai' }, person('adnan@presentail.com'), { now: T0 });
  const at = plus(T(schedule.next_run_at), 5000);
  await Promise.all([S.tickSchedules(at), S.tickSchedules(at), S.tickSchedules(at)]);
  await S.tickSchedules(at);
  assert.equal(occs(schedule.id).length, 1);
  assert.equal(tasksOf(schedule.id).length, 1);
  // Delivering the same occurrence again (a retry) is a no-op.
  await Promise.all([S.deliverOccurrence(occs(schedule.id)[0].id, at), S.deliverOccurrence(occs(schedule.id)[0].id, at)]);
  assert.equal(tasksOf(schedule.id).length, 1);

  // Two separate worker processes sharing the database file claim the same due occurrence at once.
  const other = S.createSchedule({ title: 'Daily cash count', instructions: 'Count it.', assignee: 'user:sara@presentail.com', rule: { freq: 'daily', time: '08:00' }, timezone: 'Asia/Dubai' }, person('adnan@presentail.com'), { now: T0 }).schedule;
  const when = plus(T(other.next_run_at), 1000).toISOString();
  const script = `const S = await import('./server/schedules.js'); const now = new Date('${when}'); await S.tickSchedules(now); process.exit(0);`;
  const exec = promisify(execFile);
  const env = { ...process.env, DB_PATH: DB_FILE, HIVE_SCHEDULER: 'off' };
  await Promise.all([1, 2, 3].map(() => exec(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { cwd: process.cwd(), env })));
  assert.equal(occs(other.id).length, 1, 'one occurrence');
  assert.equal(tasksOf(other.id).length, 1, 'one task');
  assert.equal(wf(other.id).occurrence_count, 1);
});

test('the task is created, the start fails: retried on the same task, never a second task', async () => {
  let failing = true;
  const hook = await webhookAgent('Hooky', () => (failing ? [500, {}] : [200, {}]));
  const { schedule } = S.createSchedule({ title: 'Sync bank feed', instructions: 'Sync it.', assignee: `agent:${hook.id}`, rule: WEEKLY_MON, timezone: 'Asia/Dubai' }, person('adnan@presentail.com'), { now: T0 });
  const due = plus(T(schedule.next_run_at), 1000);
  await S.tickSchedules(due);
  let [o] = occs(schedule.id);
  assert.equal(o.state, 'created');
  assert.equal(o.dispatch_status, 'retrying');
  assert.equal(o.attempts, 1);
  assert.match(o.last_error, /HTTP 500/);
  assert.equal(o.next_attempt_at, plus(due, MIN).toISOString());
  const [task] = tasksOf(schedule.id);
  assert.equal(get('SELECT blocked_kind FROM tasks WHERE id = ?', task.id).blocked_kind, 'failed', 'the failed start is visible on the task');
  await S.tickSchedules(plus(due, 30000));
  assert.equal(occs(schedule.id)[0].attempts, 1, 'not before the retry time');
  failing = false;
  await S.tickSchedules(plus(due, MIN + 1000));
  [o] = occs(schedule.id);
  assert.equal(o.dispatch_status, 'dispatched');
  assert.equal(tasksOf(schedule.id).length, 1);
  assert.equal(tasksOf(schedule.id)[0].id, task.id, 'the same task');
  assert.equal(hook.hits.length, 2);

  // Always failing: three retries, then failed, and the person who set it up is told.
  const broken = await webhookAgent('Broken', () => [503, {}]);
  const b = S.createSchedule({ title: 'Broken sync', instructions: 'Sync.', assignee: `agent:${broken.id}`, rule: WEEKLY_MON, timezone: 'Asia/Dubai' }, person('adnan@presentail.com'), { now: T0 }).schedule;
  const t0 = plus(T(b.next_run_at), 1000);
  for (const m of [0, 1, 6, 21]) await S.tickSchedules(plus(t0, m * MIN + 1000));
  const [f] = occs(b.id);
  assert.equal(f.dispatch_status, 'failed');
  assert.equal(f.attempts, 4);
  assert.equal(f.status, 'failed');
  assert.equal(tasksOf(b.id).length, 1);
  assert.ok(get("SELECT 1 FROM reminders WHERE user_email = 'adnan@presentail.com' AND text LIKE '%couldn''t start%'"));
  assert.ok(get("SELECT 1 FROM schedule_events WHERE workflow_id = ? AND kind = 'dispatch_failed'", b.id));
});

test('retries keep the occurrence’s reporting period and due date', async () => {
  const hook = await webhookAgent('Quarterly', (n) => (n === 1 ? [500, {}] : [200, {}]));
  const { schedule } = S.createSchedule(
    {
      title: 'VAT workings', instructions: 'Prepare VAT workings for {{period_label}} ({{period_start}} to {{period_end}}).', assignee: `agent:${hook.id}`,
      rule: { freq: 'quarterly', month_day: 14, months: [3, 6, 9, 12] }, timezone: 'Asia/Dubai',
      period_rule: { kind: 'anchored', months: 3, anchor_month: 12 }, deadline_rule: { kind: 'days_after_period_end', days: 28 },
    },
    person('adnan@presentail.com'),
    { now: T('2026-11-20T00:00:00Z') },
  );
  assert.equal(schedule.next_run_at, '2026-12-14T05:00:00.000Z');
  await S.tickSchedules(T('2026-12-14T05:00:30Z'));
  // The retry happens weeks later, in another quarter: the period is the original occurrence's.
  await S.tickSchedules(T('2027-01-20T00:00:00Z'));
  const [o] = occs(schedule.id);
  assert.equal(o.dispatch_status, 'dispatched');
  const [task] = tasksOf(schedule.id);
  assert.equal(task.period_start, '2026-09-01');
  assert.equal(task.period_end, '2026-11-30');
  assert.equal(task.due_date, '2026-12-28', 'due is separate from the start and from the period');
  assert.match(task.title, /VAT workings — Sep 2026 – Nov 2026/);
  assert.match(task.description, /Prepare VAT workings for Sep 2026 – Nov 2026 \(1 Sept? 2026 to 30 Nov 2026\)/);
  assert.match(task.description, /Reporting period: Sep 2026 – Nov 2026 \(2026-09-01 to 2026-11-30\)/);
});

// ---------------------------------------------------------------- lifecycle

test('edits apply to future occurrences, atomically with occurrences already due', async () => {
  const ctx = person('adnan@presentail.com');
  const { schedule } = S.createSchedule({ title: 'Payables review', instructions: 'Old instructions.', assignee: `agent:${POLLER}`, mode: 'create_only', rule: WEEKLY_MON, timezone: 'Asia/Dubai' }, ctx, { now: T0 });
  const first = T(schedule.next_run_at);
  await S.tickSchedules(plus(first, 1000));
  const [a] = tasksOf(schedule.id);
  assert.match(a.description, /^Old instructions\./);

  // The next occurrence is claimed (due), then someone edits before it's delivered: it keeps the
  // version it was due under; nothing half-updated, nothing twice.
  const second = plus(first, 7 * DAY);
  S.claimDue(plus(second, 1000));
  const { schedule: edited, notes } = S.updateSchedule(schedule.id, { title: 'Payables review (new)', instructions: 'New instructions.', rule: { freq: 'weekly', weekdays: ['tue'], time: '09:00' } }, ctx, { now: plus(second, 2000) });
  assert.deepEqual(notes, []);
  assert.equal(edited.version, 2);
  assert.equal(edited.recurrence, 'Every Tuesday at 9:00 AM');
  assert.equal(edited.next_run_at, '2026-10-13T05:00:00.000Z', 'recomputed from now, in the future');
  await S.deliverPending(plus(second, 3000));
  const [, b] = tasksOf(schedule.id);
  assert.match(b.description, /^Old instructions\./, 'claimed before the edit: the old version');
  await S.tickSchedules(T('2026-10-13T05:00:10Z'));
  const [, , c] = tasksOf(schedule.id);
  assert.match(c.description, /^New instructions\./);
  assert.match(c.title, /^Payables review \(new\)/);
  assert.match(get('SELECT description FROM tasks WHERE id = ?', a.id).description, /^Old instructions\./, 'history keeps what it had');
});

test('pause, resume (no catch-up of paused weeks) and cancel (history stays, running work continues)', async () => {
  const ctx = person('adnan@presentail.com');
  const { schedule } = S.createSchedule({ title: 'AR chase', instructions: 'Chase.', assignee: `agent:${LEDGER}`, rule: WEEKLY_MON, timezone: 'Asia/Dubai' }, ctx, { now: T0 });
  await S.tickSchedules(plus(T(schedule.next_run_at), 1000));
  const [task] = tasksOf(schedule.id);
  const execution = await runOf(task.id);
  run("UPDATE runs SET status = 'running' WHERE id = ?", execution.id);

  const paused = S.pauseSchedule(schedule.id, ctx, { now: T('2026-10-06T00:00:00Z') });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.next_run_at, null);
  await S.tickSchedules(T('2026-10-27T00:00:00Z'));
  assert.equal(occs(schedule.id).length, 1, 'nothing while paused');
  const resumed = S.resumeSchedule(schedule.id, ctx, { now: T('2026-10-27T00:00:00Z') });
  assert.equal(resumed.next_run_at, '2026-11-02T05:00:00.000Z', 'the next one after resuming; paused weeks are not caught up');

  const cancelled = S.cancelSchedule(schedule.id, ctx, { now: T('2026-10-28T00:00:00Z') });
  assert.equal(cancelled.status, 'ended');
  await S.tickSchedules(T('2026-12-01T00:00:00Z'));
  assert.equal(occs(schedule.id).length, 1);
  assert.equal(tasksOf(schedule.id).length, 1, 'its task stays');
  assert.equal(get('SELECT status FROM runs WHERE id = ?', execution.id).status, 'running', 'cancelling never stops running work');
  assert.throws(() => S.resumeSchedule(schedule.id, ctx), /ended/);
});

test('after downtime only the latest missed occurrence runs; earlier ones are recorded as skipped', async () => {
  const ctx = person('adnan@presentail.com');
  const { schedule } = S.createSchedule({ title: 'Weekly sales report', instructions: 'Report.', assignee: 'user:lina@presentail.com', rule: WEEKLY_MON, timezone: 'Asia/Dubai' }, ctx, { now: T0 });
  // Hive was down from before 5 Oct until 26 Oct 11:00 Dubai: 5, 12, 19 and 26 Oct were missed.
  await S.tickSchedules(T('2026-10-26T07:00:00Z'));
  const rows = occs(schedule.id);
  assert.deepEqual(rows.map((r) => [r.scheduled_for.slice(0, 10), r.state, r.trigger]), [
    ['2026-10-05', 'skipped', 'schedule'], ['2026-10-12', 'skipped', 'schedule'], ['2026-10-19', 'skipped', 'schedule'], ['2026-10-26', 'created', 'catchup'],
  ]);
  assert.match(rows[0].skip_reason, /Missed while Hive was not running; only the latest missed run is created/);
  assert.equal(tasksOf(schedule.id).length, 1);
  assert.match(tasksOf(schedule.id)[0].description, /created late because Hive was offline/);
  assert.equal(wf(schedule.id).next_run_at, '2026-11-02T05:00:00.000Z');
  assert.equal(wf(schedule.id).occurrence_count, 4);

  const skipAll = S.createSchedule({ title: 'Stale check', instructions: 'Check.', assignee: 'user:lina@presentail.com', rule: WEEKLY_MON, timezone: 'Asia/Dubai', missed_policy: 'skip_all' }, ctx, { now: T0 }).schedule;
  await S.tickSchedules(T('2026-10-13T07:00:00Z'));
  assert.deepEqual(occs(skipAll.id).map((r) => r.state), ['skipped', 'skipped']);
  assert.equal(tasksOf(skipAll.id).length, 0);
});

test('overlap: agents skip while the previous run is going; people get every task unless told otherwise', async () => {
  const ctx = person('adnan@presentail.com');
  const agentSchedule = S.createSchedule({ title: 'Daily reconciliation', instructions: 'Reconcile.', assignee: `agent:${KYROS}`, rule: { freq: 'daily', time: '09:00' }, timezone: 'Asia/Dubai' }, ctx, { now: T0 }).schedule;
  assert.equal(agentSchedule.overlap_policy, 'skip_if_running');
  const d1 = plus(T(agentSchedule.next_run_at), 1000);
  await S.tickSchedules(d1);
  const [t1] = tasksOf(agentSchedule.id);
  await runOf(t1.id);
  run("UPDATE runs SET status = 'running' WHERE task_id = ?", t1.id);
  await S.tickSchedules(plus(d1, DAY));
  const second = occs(agentSchedule.id)[1];
  assert.equal(second.state, 'skipped');
  assert.match(second.skip_reason, new RegExp(`previous run \\(task #${t1.id}\\) is still in progress`));
  assert.equal(tasksOf(agentSchedule.id).length, 1);

  const peopleDefault = S.createSchedule({ title: 'Daily standup notes', instructions: 'Write them.', assignee: 'user:lina@presentail.com', rule: { freq: 'daily', time: '09:00' }, timezone: 'Asia/Dubai' }, ctx, { now: T0 }).schedule;
  const skipOpen = S.createSchedule({ title: 'Daily invoice check', instructions: 'Check.', assignee: 'user:lina@presentail.com', rule: { freq: 'daily', time: '09:00' }, timezone: 'Asia/Dubai', overlap_policy: 'skip_if_open' }, ctx, { now: T0 }).schedule;
  await S.tickSchedules(d1);
  await S.tickSchedules(plus(d1, DAY));
  assert.equal(tasksOf(peopleDefault.id).length, 2, 'a person gets each one even with the previous open');
  assert.equal(tasksOf(skipOpen.id).length, 1);
  assert.match(occs(skipOpen.id)[1].skip_reason, /previous task .* is still open/);
  assert.throws(() => S.createSchedule({ title: 'X', assignee: 'user:lina@presentail.com', rule: WEEKLY_MON, overlap_policy: 'skip_if_running' }, ctx), /People have no runs/);
});

test('a paused or removed agent, a departed person or lost access suspends delivery with the reason', async () => {
  const ctx = person('adnan@presentail.com');
  const pausable = agent('Pausable', 'Clerk');
  const { schedule } = S.createSchedule({ title: 'Clerk run', instructions: 'Run.', assignee: `agent:${pausable}`, rule: WEEKLY_MON, timezone: 'Asia/Dubai' }, ctx, { now: T0 });
  run("UPDATE agents SET status = 'paused' WHERE id = ?", pausable);
  assert.equal(S.scheduleDetails(schedule.id, knownUser('adnan@presentail.com')).warning, 'Pausable is paused', 'visible before the next run');
  await S.tickSchedules(plus(T(schedule.next_run_at), 1000));
  assert.equal(tasksOf(schedule.id).length, 0, 'no work dispatched to a paused agent');
  assert.match(occs(schedule.id)[0].skip_reason, /Not delivered: Pausable is paused/);
  let s = wf(schedule.id);
  assert.equal(s.status, 'error');
  assert.equal(s.status_reason, 'Pausable is paused');
  assert.equal(s.agent_id, pausable, 'never reassigned');
  assert.throws(() => S.resumeSchedule(schedule.id, ctx), /Can't resume yet: Pausable is paused/);
  run("UPDATE agents SET status = 'idle' WHERE id = ?", pausable);
  assert.equal(S.resumeSchedule(schedule.id, ctx, { now: T('2026-10-07T00:00:00Z') }).status, 'active', 'resumed explicitly');

  // Deleting the agent suspends its schedules at once.
  assert.equal((await call(`/agents/${pausable}`, { method: 'DELETE' })).status, 200);
  s = wf(schedule.id);
  assert.equal(s.status, 'error');
  assert.equal(s.status_reason, 'Pausable was removed');
  assert.equal(occs(schedule.id).length, 1, 'history kept');

  // A person loses access to the project their recurring task is in.
  const project = Number(run("INSERT INTO projects (name, owner_email, status) VALUES ('Month-end UAE', 'adnan@presentail.com', 'active')").lastInsertRowid);
  run("INSERT INTO project_members (project_id, member_type, member_ref) VALUES (?, 'user', 'lina@presentail.com')", project);
  const inProject = S.createSchedule({ title: 'UAE checklist', instructions: 'Tick it.', assignee: 'user:lina@presentail.com', project_id: project, rule: WEEKLY_MON, timezone: 'Asia/Dubai' }, ctx, { now: T0 }).schedule;
  run("DELETE FROM project_members WHERE project_id = ? AND member_ref = 'lina@presentail.com'", project);
  await S.tickSchedules(plus(T(inProject.next_run_at), 1000));
  assert.equal(wf(inProject.id).status, 'error');
  assert.match(wf(inProject.id).status_reason, /Lina Aoun no longer has access to the project “Month-end UAE”/);
  assert.equal(tasksOf(inProject.id).length, 0);

  // The recipient leaves the workspace; and separately the person who authorized one leaves.
  run("INSERT INTO users (email, name, role) VALUES ('temp@presentail.com', 'Temp Person', 'member')");
  const theirs = S.createSchedule({ title: 'Temp task', instructions: 'Do it.', assignee: 'user:temp@presentail.com', rule: WEEKLY_MON, timezone: 'Asia/Dubai' }, ctx, { now: T0 }).schedule;
  const authorized = S.createSchedule({ title: 'Temp authorized', instructions: 'Do it.', assignee: `agent:${POLLER}`, mode: 'create_only', rule: WEEKLY_MON, timezone: 'Asia/Dubai' }, person('temp@presentail.com'), { now: T0 }).schedule;
  run("DELETE FROM users WHERE email = 'temp@presentail.com'");
  await S.tickSchedules(plus(T(theirs.next_run_at), 1000));
  assert.match(wf(theirs.id).status_reason, /temp@presentail.com is no longer a member/);
  assert.match(wf(authorized.id).status_reason, /temp@presentail.com is no longer a member of this workspace, so the schedule has no one authorizing it/);
  assert.equal(tasksOf(theirs.id).length + tasksOf(authorized.id).length, 0);
});

test('Run now makes an extra occurrence without moving the regular schedule', async () => {
  const ctx = person('adnan@presentail.com');
  const { schedule } = S.createSchedule({ title: 'Cash position', instructions: 'Report it.', assignee: 'user:sara@presentail.com', rule: WEEKLY_MON, timezone: 'Asia/Dubai' }, ctx, { now: T0 });
  const before = wf(schedule.id);
  const r1 = await S.runNow(schedule.id, ctx, { key: 'click-1', now: T('2026-10-02T08:00:00Z') });
  const r2 = await S.runNow(schedule.id, ctx, { key: 'click-1', now: T('2026-10-02T08:00:05Z') });
  assert.equal(r1.id, r2.id, 'the same click twice is one run');
  assert.equal(r1.trigger, 'manual');
  assert.equal(tasksOf(schedule.id).length, 1);
  const afterRun = wf(schedule.id);
  assert.equal(afterRun.next_run_at, before.next_run_at);
  assert.equal(afterRun.occurrence_count, before.occurrence_count);
  // Via HTTP too.
  const res = await call(`/workflows/${schedule.id}/run`, { method: 'POST', body: { key: 'click-2' } });
  assert.equal(res.status, 200);
  assert.equal(tasksOf(schedule.id).length, 2);
  assert.equal(wf(schedule.id).next_run_at, before.next_run_at);
});

test('reassigning changes future occurrences only', async () => {
  const runId = chat(LEDGER, 'adnan@presentail.com', 'Every Monday, reconcile Careem. Actually, from now on give the Careem reconciliation to Sara.');
  const created = tool(runId, 'schedule_recurring_task', { user_request: 'Every Monday, reconcile Careem', title: 'Reconcile Careem', instructions: 'Reconcile.', mode: 'create_only', recurrence: { frequency: 'weekly', weekdays: ['mon'] }, timezone: 'Asia/Dubai' }, T0);
  const first = T(wf(created.schedule_id).next_run_at);
  await S.tickSchedules(plus(first, 1000));
  const updated = tool(runId, 'update_recurring_task', { schedule_id: created.schedule_id, user_request: 'from now on give the Careem reconciliation to Sara', assignee: { type: 'person', name: 'Sara' } }, plus(first, 2000));
  assert.equal(updated.ok, true, updated.error);
  assert.equal(updated.assigned_to.id, 'sara@presentail.com');
  assert.equal(updated.execution_mode, 'create_only');
  assert.match(updated.confirmation, /^Updated: Sara Nassar will receive a task/);
  await S.tickSchedules(plus(first, 7 * DAY + 1000));
  const [a, b] = tasksOf(created.schedule_id);
  assert.equal(a.agent_id, LEDGER, 'the earlier task keeps its assignee');
  assert.equal(b.assignee_email, 'sara@presentail.com');
  assert.ok(get("SELECT 1 FROM schedule_events WHERE workflow_id = ? AND kind = 'reassigned'", created.schedule_id));
  assert.equal(get('SELECT COUNT(*) AS n FROM workflows WHERE name = ?', 'Reconcile Careem').n, 1, 'updated, not duplicated');
});

test('who can see and change schedules: explicit checks, not ownership by creation', async () => {
  // Sara sets one up; Ledger acting for Omar can't change it, acting for Sara it can; owners can.
  const sara = S.createSchedule({ title: 'Petty cash', instructions: 'Count.', assignee: `agent:${LEDGER}`, mode: 'create_only', rule: WEEKLY_MON, timezone: 'Asia/Dubai' }, person('sara@presentail.com'), { now: T0 }).schedule;
  const asOmar = chat(LEDGER, 'omar@presentail.com', 'pause the petty cash one');
  const denied = tool(asOmar, 'pause_recurring_task', { schedule_id: sara.id, user_request: 'pause the petty cash one' }, T0);
  assert.match(denied.error, /can't pause this recurring task/);
  assert.equal(wf(sara.id).status, 'active');
  const asSara = chat(LEDGER, 'sara@presentail.com', 'please pause petty cash');
  assert.equal(tool(asSara, 'pause_recurring_task', { schedule_id: sara.id, user_request: 'please pause petty cash' }, T0).status, 'paused');
  assert.equal((await call(`/workflows/${sara.id}/resume`, { method: 'POST' })).body.status, 'active', 'an owner can');
  assert.equal((await call(`/workflows/${sara.id}/pause`, { method: 'POST', as: 'omar@presentail.com' })).status, 403);

  // The assignee can look at the recurrence behind their task but not change it.
  const forOmar = S.createSchedule({ title: 'Approve payroll', instructions: 'Approve.', assignee: 'user:omar@presentail.com', rule: WEEKLY_MON, timezone: 'Asia/Dubai' }, person('adnan@presentail.com'), { now: T0 }).schedule;
  const seen = await call(`/workflows/${forOmar.id}`, { as: 'omar@presentail.com' });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.can_manage, false);
  assert.equal((await call(`/workflows/${forOmar.id}`, { method: 'PATCH', as: 'omar@presentail.com', body: { title: 'Mine now' } })).status, 403);

  // A project's schedules are private to it.
  const project = Number(run("INSERT INTO projects (name, owner_email, status) VALUES ('Board pack', 'sara@presentail.com', 'active')").lastInsertRowid);
  const inProject = S.createSchedule({ title: 'Board pack draft', instructions: 'Draft.', assignee: `agent:${KYROS}`, mode: 'create_only', project_id: project, rule: WEEKLY_MON, timezone: 'Asia/Dubai' }, person('sara@presentail.com'), { now: T0 }).schedule;
  assert.equal((await call(`/workflows/${inProject.id}`, { as: 'omar@presentail.com' })).status, 404);
  assert.ok(!(await call('/workflows', { as: 'omar@presentail.com' })).body.some((w) => w.id === inProject.id));
  assert.ok((await call('/workflows', { as: 'sara@presentail.com' })).body.some((w) => w.id === inProject.id));
  const kyrosForOmar = chat(KYROS, 'omar@presentail.com', 'what recurring tasks do you have?');
  assert.ok(!tool(kyrosForOmar, 'list_recurring_tasks', { assigned_to: 'you' }, T0).recurring_tasks.some((w) => w.schedule_id === inProject.id), 'Kyros acting for Omar sees only what Omar may');
  const kyrosForSara = chat(KYROS, 'sara@presentail.com', 'what recurring tasks do you have?');
  assert.ok(tool(kyrosForSara, 'list_recurring_tasks', { assigned_to: 'you' }, T0).recurring_tasks.some((w) => w.schedule_id === inProject.id));
  // …and only its members may put recurring work in it.
  const intoProject = chat(LEDGER, 'omar@presentail.com', 'every Monday draft the board pack in the Board pack project');
  assert.match(tool(intoProject, 'schedule_recurring_task', { user_request: 'every Monday draft the board pack', project: 'Board pack', title: 'Draft', instructions: 'Draft.', recurrence: { frequency: 'weekly', weekdays: ['mon'] } }, T0).error, /only to projects you're a member of/);
  assert.equal((await call('/workflows', { method: 'POST', as: 'omar@presentail.com', body: { title: 'Sneaky', assignee: `agent:${KYROS}`, project_id: project, rule: WEEKLY_MON } })).status, 403);
  // Tasks made by a schedule can't make schedules (no schedule spawns schedules).
  const generated = tasksOf(sara.id)[0] ?? { id: Number(run("INSERT INTO tasks (title, agent_id, workflow_id, created_by) VALUES ('gen', ?, ?, 'sara@presentail.com')", LEDGER, sara.id).lastInsertRowid) };
  const taskRun = Number(run("INSERT INTO runs (kind, task_id, agent_id, status, session_id) VALUES ('task', ?, ?, 'ended', 'fixture')", generated.id, LEDGER).lastInsertRowid);
  assert.match(tool(taskRun, 'schedule_recurring_task', { user_request: 'gen', title: 'Loop', instructions: 'x', recurrence: { frequency: 'daily' } }, T0).error, /created by a recurring schedule/);
});

test('workflows from before this change keep working: cron rule, status, owner authorization', async () => {
  const { normalizeLegacyWorkflows } = await import('./db.js');
  const id = Number(run("INSERT INTO workflows (name, schedule, timezone, enabled, agent_id, instructions) VALUES ('Old Talabat month-end', '0 9 2 * *', 'Asia/Dubai', 1, ?, 'Do Talabat.')", POLLER).lastInsertRowid);
  normalizeLegacyWorkflows();
  const legacy = wf(id);
  assert.equal(legacy.status, 'active');
  assert.deepEqual(JSON.parse(legacy.rule), { freq: 'cron', expr: '0 9 2 * *' });
  assert.equal(legacy.authorized_by, null);
  assert.equal(S.scheduleDetails(id, knownUser('adnan@presentail.com')).recurrence, 'Custom schedule (cron: 0 9 2 * *)');
  // Set up by owners before authorization was recorded: members can't run it, owners can (and adopt it).
  assert.equal((await call(`/workflows/${id}/run`, { method: 'POST', as: 'omar@presentail.com', body: { key: 'k' } })).status, 403);
  const ran = await call(`/workflows/${id}/run`, { method: 'POST', body: { key: 'k' } });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(ran.body.state, 'created');
  assert.equal(wf(id).authorized_by, 'adnan@presentail.com');
  // An un-adopted one due on its schedule is delivered as authorized by the first owner.
  const other = Number(run("INSERT INTO workflows (name, schedule, timezone, enabled, agent_id) VALUES ('Old weekly', '0 9 * * 1', 'Asia/Dubai', 1, ?)", POLLER).lastInsertRowid);
  normalizeLegacyWorkflows();
  run("UPDATE workflows SET next_run_at = '2026-10-05T05:00:00.000Z' WHERE id = ?", other);
  await S.tickSchedules(T('2026-10-05T05:00:30Z'));
  const [task] = tasksOf(other);
  assert.equal(task.created_by, 'adnan@presentail.com');
});

// ---------------------------------------------------------------- HTTP API (people)

test('people create, preview, edit and inspect recurring tasks in Hive', async () => {
  const preview = await call('/schedule/preview', { method: 'POST', body: { rule: { freq: 'monthly', month_day: 31 }, timezone: 'Asia/Dubai', starts_on: '2027-01-01', period_rule: { kind: 'previous_month' }, deadline_rule: { kind: 'days_after_start', days: 5 } } });
  assert.equal(preview.body.ok, true);
  assert.deepEqual(preview.body.next.slice(0, 2).map((n) => [n.local, n.period.label, n.due_date]), [
    ['Sun 31 Jan 2027, 9:00 AM', 'December 2026', '2027-02-05'],
    ['Sun 28 Feb 2027, 9:00 AM', 'January 2027', '2027-03-05'],
  ]);
  assert.equal((await call('/schedule/preview', { method: 'POST', body: { rule: { freq: 'monthly', months: [2], month_day: 30 } } })).body.error, 'February never has a day 30');

  assert.equal((await call('/workflows', { method: 'POST', as: 'omar@presentail.com', body: { title: 'Expense report', assignee: 'user:sara@presentail.com', mode: 'create_and_start', rule: { freq: 'monthly', month_day: 1 } } })).status, 400);
  const created = await call('/workflows', {
    method: 'POST', as: 'omar@presentail.com',
    body: { title: 'Expense report', instructions: 'Collect receipts.', expected_result: 'Report submitted', assignee: 'user:sara@presentail.com', rule: { freq: 'monthly', month_day: 1, time: '08:00' }, timezone: 'Europe/Nicosia', ends_on: '2027-06-30', client_key: 'ui-1' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual([created.body.created_by.name, created.body.assignee.name, created.body.mode], ['Omar Haddad', 'Sara Nassar', 'create_only']);
  assert.equal((await call('/workflows', { method: 'POST', as: 'omar@presentail.com', body: { title: 'Expense report', assignee: 'user:sara@presentail.com', rule: { freq: 'monthly', month_day: 1 }, client_key: 'ui-1' } })).body.id, created.body.id, 'a resubmitted form is the same schedule');

  const detail = (await call(`/workflows/${created.body.id}`, { as: 'omar@presentail.com' })).body;
  assert.equal(detail.can_manage, true);
  assert.equal(detail.upcoming.length, 5);
  assert.match(detail.upcoming[0].local, /1 .* 2026, 8:00 AM|1 .* 2027, 8:00 AM/);
  assert.equal(detail.events[0].kind, 'created');
  assert.equal(detail.missed_label, 'If Hive was offline when runs were due, only the latest missed run is created; earlier ones are recorded as skipped.');

  const edited = await call(`/workflows/${created.body.id}`, { method: 'PATCH', as: 'omar@presentail.com', body: { rule: { freq: 'monthly', month_day: 'last', time: '17:00' } } });
  assert.equal(edited.body.recurrence, 'Monthly on the last day at 5:00 PM');
  assert.equal((await call(`/workflows/${created.body.id}/cancel`, { method: 'POST', as: 'omar@presentail.com' })).body.status, 'ended');
  // Listing by creator and assignee.
  assert.ok((await call('/workflows?created_by=me', { as: 'omar@presentail.com' })).body.some((w) => w.id === created.body.id));
  assert.ok((await call('/workflows?assignee=user:sara@presentail.com')).body.some((w) => w.id === created.body.id));
});

// ---------------------------------------------------------------- end to end

test('end to end: a chat request calls the tool, the schedule is saved, a task is made when due and started', async () => {
  const request = 'Every Monday at 9 AM Dubai time, check outstanding supplier invoices and prepare a summary.';
  // Runs started by earlier tests have all reached the simulated API, so these answers are ours.
  await waitFor(() => !get("SELECT 1 FROM runs WHERE status = 'starting' OR (kind = 'task' AND session_id IS NULL AND status != 'failed')"), 'earlier runs to start');
  fake.script.length = 0;
  // The simulated agent: calls the tool with the person's words, then relays the confirmation.
  fake.script.push(() => [
    { type: 'session.status_running' },
    {
      id: 'sevt_sched', type: 'agent.custom_tool_use', name: 'schedule_recurring_task',
      input: { user_request: request, title: 'Summarize outstanding supplier invoices', instructions: 'Check outstanding supplier invoices and prepare a summary.', recurrence: { frequency: 'weekly', weekdays: ['mon'], time: '09:00' }, timezone: 'Asia/Dubai' },
    },
    { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['sevt_sched'] } },
  ]);
  fake.script.push((events) => {
    const result = JSON.parse(events[0].content[0].text);
    return [
      { type: 'agent.message', content: [{ type: 'text', text: result.ok ? result.confirmation : `I couldn't schedule it: ${result.error}` }] },
      { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ];
  });
  const sent = await call(`/agents/${LEDGER}/messages`, { method: 'POST', body: { body: request } });
  assert.equal(sent.status, 200);

  const reply = await waitFor(() => get("SELECT * FROM messages WHERE agent_id = ? AND sender = 'agent' AND body LIKE 'Scheduled:%' ORDER BY id DESC", LEDGER), "the agent's confirmation");
  const stored = get("SELECT * FROM workflows WHERE name = 'Summarize outstanding supplier invoices'");
  assert.ok(stored, 'the schedule was saved');
  assert.equal(stored.authorized_by, 'adnan@presentail.com', 'authorized by the person who sent the message');
  assert.equal(stored.created_by_ref, String(LEDGER));
  const toolResult = fake.calls.sent.find((s) => s.events[0]?.custom_tool_use_id === 'sevt_sched');
  assert.equal(JSON.parse(toolResult.events[0].content[0].text).schedule_id, stored.id);
  // The confirmation the person reads is what was stored.
  assert.equal(reply.body, `Scheduled: every Monday at 9:00 AM, Asia/Dubai. I'll summarize outstanding supplier invoices. Each occurrence will create a task and start automatically. Next run: ${formatLocal(stored.next_run_at, 'Asia/Dubai')}. Manage schedule: https://hive.test/#/workflows/${stored.id}`);

  // When it's due, the scheduler makes the task and starts Ledger on it.
  fake.script.push(() => [
    { type: 'session.status_running' },
    { type: 'agent.message', content: [{ type: 'text', text: '3 suppliers with overdue invoices; summary saved.' }] },
    { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
  ]);
  const due = T(stored.next_run_at);
  await S.tickSchedules(plus(due, 20000));
  const [task] = tasksOf(stored.id);
  assert.ok(task, 'a task for the occurrence');
  assert.equal(task.agent_id, LEDGER);
  assert.equal(task.scheduled_for, stored.next_run_at);
  const [o] = occs(stored.id);
  assert.equal(o.dispatch_status, 'dispatched');
  const session = await waitFor(() => fake.calls.sessions.find((s) => s.metadata?.hive_task_id === String(task.id)), 'a session for the task');
  assert.ok(session);
  await waitFor(() => get("SELECT 1 FROM tasks WHERE id = ? AND status = 'review'", task.id), 'the result back for review');
  assert.equal(o.state, 'created');
  assert.notEqual(runViewOutcome(stored.id), 'done', 'delivered is not done: the task still needs review');
  assert.equal(wf(stored.id).next_run_at, plus(due, 7 * DAY).toISOString());
});

const runViewOutcome = (id) => S.scheduleDetails(id, knownUser('adnan@presentail.com')).runs[0].outcome;
