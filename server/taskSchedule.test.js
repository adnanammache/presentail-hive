// Scheduled, repeating and approval-gated tasks, through the same API the New task panel uses.
// Dates are in 2030 so "now" (the real clock) is always before them; the ticker gets explicit times.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

process.env.DB_PATH = ':memory:';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.SLACK_BOT_TOKEN;

const express = (await import('express')).default;
const { dashboardRouter, errorHandler } = await import('./app.js');
const { get, all, run } = await import('./db.js');
const { tick, setDispatcher } = await import('./taskSchedule.js');
const { finishTask } = await import('./handoff.js');

const started = [];
setDispatcher(async (id) => started.push(id));

let base;
let server;
before(() => {
  const app = express();
  app.use(express.json());
  app.use('/api', dashboardRouter());
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const call = async (path, { method = 'GET', body, raw, headers } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: raw ? headers : body ? { 'Content-Type': 'application/json' } : undefined,
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json();
  return { status: res.status, data };
};
const dubai = (date, hhmm) => new Date(`${date}T${hhmm}:00+04:00`);
const agentId = Number(run("INSERT INTO agents (name, title, platform, status, api_token) VALUES ('Ziad Karam', 'Tax Accountant', 'custom', 'idle', 'agt_z')").lastInsertRowid);
const entity = (code) => get('SELECT id FROM entities WHERE code = ?', code).id;

test('existing-style tasks still work: no schedule fields means start now, no repeat, no approval', async () => {
  const { status, data } = await call('/tasks', { method: 'POST', body: { title: 'Old style', description: 'x' } });
  assert.equal(status, 200);
  assert.equal(data.status, 'ready');
  assert.equal(data.needs_approval, 0);
  assert.equal(data.series_id, null);
  assert.equal(data.repeat, null);
});

test('a task with a start date waits in Scheduled and starts at 8:00 Dubai time on that day', async () => {
  const { data: t } = await call('/tasks', {
    method: 'POST',
    body: { title: 'UAE VAT return Q3', agent_id: agentId, start_on: '2030-10-10', due_date: '2030-10-28', entity_id: entity('uae') },
  });
  assert.equal(t.status, 'scheduled');
  assert.equal(t.entity_name, 'Presentail Flowers Trading LLC – UAE (Dubai + Abu Dhabi)');

  tick(dubai('2030-10-09', '23:00'));
  tick(dubai('2030-10-10', '07:59'));
  assert.equal(get('SELECT status FROM tasks WHERE id = ?', t.id).status, 'scheduled', 'not before 8:00 on the day');
  assert.ok(!started.includes(t.id));

  const { started: now } = tick(dubai('2030-10-10', '08:00'));
  assert.ok(now.includes(t.id));
  assert.equal(get('SELECT status FROM tasks WHERE id = ?', t.id).status, 'ready');
  await new Promise((r) => setImmediate(r));
  assert.ok(started.includes(t.id), 'handed to the agent');
  tick(dubai('2030-10-10', '08:01'));
  assert.equal(started.filter((id) => id === t.id).length, 1, 'started once');

  // "Create & start" ignores the start date (but keeps it for the record).
  const { data: now2 } = await call('/tasks', { method: 'POST', body: { title: 'Right away', agent_id: agentId, start_on: '2030-10-10', start: true, due_date: '2030-10-28' } });
  assert.equal(now2.start.ok, true);
  assert.equal(now2.status, 'in_progress');
  assert.equal(now2.start_on, '2030-10-10');

  // Moving a scheduled task's start date to "now" makes it ready.
  const { data: later } = await call('/tasks', { method: 'POST', body: { title: 'Later', start_on: '2030-11-01' } });
  assert.equal(later.status, 'scheduled');
  const { data: moved } = await call(`/tasks/${later.id}`, { method: 'PATCH', body: { start_on: null } });
  assert.equal(moved.status, 'ready');
});

test('a monthly task: the next one is created when this one is done or overdue, with the same start offset, files and settings', async () => {
  const { data: t1 } = await call('/tasks', {
    method: 'POST',
    body: {
      title: 'Intercompany check', description: 'Check SAL→LTD', done_definition: 'List sent to Adnan', agent_id: agentId, priority: 'high',
      entity_id: entity('sal'), due_date: '2030-01-31', start_on: '2030-01-13', remind_days: 14, needs_approval: true,
      repeat: { freq: 'monthly' }, ends_on: '2030-04-15',
    },
  });
  assert.equal(t1.status, 'scheduled');
  assert.equal(t1.repeat_label, 'Monthly');
  assert.equal(t1.series_index, 1);
  // The board's list carries the repeat too (the panel opens from it: without it, saving would look like "stop repeating").
  const { data: listed } = await call(`/tasks?series_id=${t1.series_id}`);
  assert.deepEqual(listed.map((t) => [t.id, t.repeat_label, t.repeat]), [[t1.id, 'Monthly', { freq: 'monthly' }]]);
  const up = await call(`/tasks/${t1.id}/files`, { method: 'POST', raw: Buffer.from('statement'), headers: { 'x-filename': 'statement.pdf', 'Content-Type': 'application/pdf' } });
  assert.equal(up.status, 200);

  // Done → #2 is due 28 Feb (31st → 28th) and starts 18 days before.
  await call(`/tasks/${t1.id}`, { method: 'PATCH', body: { status: 'done' } });
  const t2 = get('SELECT * FROM tasks WHERE series_id = ? AND series_index = 2', t1.series_id);
  assert.equal(t2.due_date, '2030-02-28');
  assert.equal(t2.start_on, '2030-02-10');
  assert.equal(t2.status, 'scheduled');
  for (const f of ['title', 'description', 'done_definition', 'agent_id', 'priority', 'entity_id', 'remind_days', 'needs_approval']) assert.equal(t2[f], get('SELECT * FROM tasks WHERE id = ?', t1.id)[f], f);
  const files = all('SELECT * FROM task_files WHERE task_id = ?', t2.id);
  assert.deepEqual(files.map((f) => f.filename), ['statement.pdf']);
  assert.ok(existsSync(files[0].path));
  assert.equal(readFileSync(files[0].path, 'utf8'), 'statement');

  // #2 is never marked done: once its due date passes, #3 is created anyway (31 Mar, back to the 31st).
  tick(dubai('2030-02-28', '12:00'));
  assert.equal(get('SELECT COUNT(*) n FROM tasks WHERE series_id = ?', t1.series_id).n, 2, 'not while it is still due today');
  tick(dubai('2030-03-01', '09:00'));
  tick(dubai('2030-03-01', '09:01'));
  const rows = all('SELECT series_index, due_date, start_on, status FROM tasks WHERE series_id = ? ORDER BY series_index', t1.series_id);
  assert.deepEqual(rows.map((r) => [r.series_index, r.due_date, r.start_on]), [[1, '2030-01-31', '2030-01-13'], [2, '2030-02-28', '2030-02-10'], [3, '2030-03-31', '2030-03-13']]);
  assert.equal(rows[1].status, 'ready', '#2 was handed to its agent when its start date passed');
  assert.equal(rows[2].status, 'scheduled');

  // "Ends on" 15 Apr: the one due 30 Apr is never created.
  await call(`/tasks/${get('SELECT id FROM tasks WHERE series_id = ? AND series_index = 3', t1.series_id).id}`, { method: 'PATCH', body: { status: 'done' } });
  tick(dubai('2030-05-01', '09:00'));
  assert.equal(get('SELECT COUNT(*) n FROM tasks WHERE series_id = ?', t1.series_id).n, 3);
  assert.ok(get('SELECT ended_at FROM task_series WHERE id = ?', t1.series_id).ended_at);
});

test('quarterly and yearly series step correctly; a repeating task needs a due date', async () => {
  const bad = await call('/tasks', { method: 'POST', body: { title: 'No due', repeat: { freq: 'monthly' } } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /due date/);

  for (const [freq, due, next] of [['quarterly', '2030-11-30', '2031-02-28'], ['yearly', '2032-02-29', '2033-02-28'], ['custom', '2030-06-01', '2030-06-15']]) {
    const repeat = freq === 'custom' ? { freq, every: 2, unit: 'week' } : { freq };
    const { data: t } = await call('/tasks', { method: 'POST', body: { title: `${freq} thing`, due_date: due, repeat } });
    await call(`/tasks/${t.id}`, { method: 'PATCH', body: { status: 'done' } });
    assert.equal(get('SELECT due_date FROM tasks WHERE series_id = ? AND series_index = 2', t.series_id).due_date, next, freq);
  }
});

test('editing a repeating task: only this one, or this and future ones', async () => {
  const { data: t1 } = await call('/tasks', { method: 'POST', body: { title: 'Cyprus VAT', due_date: '2030-03-31', start_on: '2030-03-10', repeat: { freq: 'quarterly' } } });
  await call(`/tasks/${t1.id}`, { method: 'PATCH', body: { status: 'done' } });
  const t2 = get('SELECT * FROM tasks WHERE series_id = ? AND series_index = 2', t1.series_id);
  assert.equal(t2.due_date, '2030-06-30');

  await call(`/tasks/${t2.id}`, { method: 'PATCH', body: { title: 'Cyprus VAT (late invoices)', scope: 'this' } });
  assert.equal(get('SELECT title FROM task_series WHERE id = ?', t1.series_id).title, 'Cyprus VAT', 'only this one');

  // This and future: new title and a new due date re-anchor the series.
  await call(`/tasks/${t2.id}`, { method: 'PATCH', body: { title: 'Cyprus VAT return', due_date: '2030-07-10', start_on: '2030-06-20', scope: 'future' } });
  await call(`/tasks/${t2.id}`, { method: 'PATCH', body: { status: 'done' } });
  const t3 = get('SELECT * FROM tasks WHERE series_id = ? AND series_index = 3', t1.series_id);
  assert.equal(t3.title, 'Cyprus VAT return');
  assert.equal(t3.due_date, '2030-10-10');
  assert.equal(t3.start_on, '2030-09-20');

  // Stop repeating.
  await call(`/tasks/${t3.id}`, { method: 'PATCH', body: { repeat: null, scope: 'future' } });
  await call(`/tasks/${t3.id}`, { method: 'PATCH', body: { status: 'done' } });
  assert.equal(get('SELECT COUNT(*) n FROM tasks WHERE series_id = ?', t1.series_id).n, 3);
  assert.equal((await call(`/tasks/${t3.id}`)).data.repeat, null);
});

test('reminders go out once, on the right day, and show in the Inbox list', async () => {
  const { data: t } = await call('/tasks', { method: 'POST', body: { title: 'Lebanon VAT', due_date: '2030-10-28', remind_days: 14 } });
  tick(dubai('2030-10-13', '09:00'));
  assert.equal(get('SELECT reminded_at FROM tasks WHERE id = ?', t.id).reminded_at, null, '15 days before');
  tick(dubai('2030-10-14', '07:00'));
  assert.equal(get('SELECT reminded_at FROM tasks WHERE id = ?', t.id).reminded_at, null, 'not before 8:00');
  const { reminded } = tick(dubai('2030-10-14', '08:00'));
  assert.ok(reminded.includes(t.id));
  tick(dubai('2030-10-15', '08:00'));
  const { data: list } = await call('/reminders');
  const mine = list.filter((r) => r.task_id === t.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].text, '"Lebanon VAT" is due 28 Oct 2030 (in 14 days).');
  await call(`/reminders/${mine[0].id}/read`, { method: 'POST' });
  assert.equal((await call('/reminders')).data.filter((r) => r.task_id === t.id).length, 0);

  // Moving the due date re-arms the reminder.
  await call(`/tasks/${t.id}`, { method: 'PATCH', body: { due_date: '2030-11-30' } });
  assert.equal(get('SELECT reminded_at FROM tasks WHERE id = ?', t.id).reminded_at, null);
});

test('approval: the agent stops in "Waiting for approval"; Approve lets it submit, Send back needs a note', async () => {
  const { data: t } = await call('/tasks', { method: 'POST', body: { title: 'UAE VAT return', agent_id: agentId, needs_approval: true, entity_id: entity('uae'), done_definition: 'Return drafted in Wafeq' } });
  await call(`/tasks/${t.id}/start`, { method: 'POST', body: { key: 'approval-test' } });
  const brief = get("SELECT body FROM messages WHERE agent_id = ? AND body LIKE ? ORDER BY id DESC", agentId, `New task #${t.id}:%`);
  assert.match(brief.body, /Entity: Presentail Flowers Trading LLC – UAE/);
  assert.match(brief.body, /Definition of done: Return drafted in Wafeq/);
  assert.match(brief.body, /Do not submit any filing, return or payment\. Prepare everything, then stop and ask Adnan for approval\./);

  assert.match(await finishTask(t.id, { summary: 'Output VAT 12,345' }), /do not submit/);
  assert.equal(get('SELECT status FROM tasks WHERE id = ?', t.id).status, 'waiting_approval');

  const back = await call(`/tasks/${t.id}/send-back`, { method: 'POST', body: {} });
  assert.equal(back.status, 400);
  const sent = await call(`/tasks/${t.id}/send-back`, { method: 'POST', body: { note: 'Box 1b looks low' } });
  assert.equal(sent.data.status, 'in_progress');
  assert.match(get('SELECT body FROM messages WHERE agent_id = ? ORDER BY id DESC', agentId).body, /sent "UAE VAT return" back:\nBox 1b looks low/);

  await finishTask(t.id, { summary: 'Fixed' });
  const ok = await call(`/tasks/${t.id}/approve`, { method: 'POST', body: {} });
  assert.equal(ok.data.status, 'in_progress');
  assert.ok(ok.data.approved_at);
  assert.match(get('SELECT body FROM messages WHERE agent_id = ? ORDER BY id DESC', agentId).body, /approved "UAE VAT return"\. Go ahead/);

  // Once approved, finishing goes to the normal review.
  await finishTask(t.id, { summary: 'Filed, ref 123' });
  assert.equal(get('SELECT status FROM tasks WHERE id = ?', t.id).status, 'review');
  assert.equal((await call(`/tasks/${t.id}/approve`, { method: 'POST', body: {} })).status, 400);
});

test('templates, entities and the entity filter', async () => {
  const { data: templates } = await call('/task-templates');
  assert.deepEqual(templates.map((t) => t.name), ['Cyprus VAT return', 'Intercompany SAL→LTD check', 'Lebanon VAT return', 'UAE VAT return']);
  const uae = templates.find((t) => t.name === 'UAE VAT return');
  assert.equal(uae.agent_id, agentId, 'starter templates find Ziad Karam by name');
  assert.deepEqual(uae.repeat, { freq: 'quarterly' });
  assert.equal(uae.entity_id, entity('uae'));
  assert.equal(uae.remind_days, 14);
  assert.equal(uae.needs_approval, true);
  assert.equal(templates.find((t) => t.name === 'Lebanon VAT return').repeat, null, 'Lebanon frequency is left to fill in');

  const { data: saved } = await call('/task-templates', { method: 'POST', body: { name: 'Payroll', title: 'Payroll', repeat: { freq: 'monthly' }, start_offset_days: 5, remind_days: 7, needs_approval: true } });
  assert.equal(saved.start_offset_days, 5);
  assert.equal((await call('/task-templates', { method: 'POST', body: { title: 'x' } })).status, 400);

  const { data: added } = await call('/entities', { method: 'POST', body: { name: 'Presentail KSA' } });
  assert.ok((await call('/entities')).data.some((e) => e.id === added.id));

  const { data: sal } = await call(`/tasks?entity_id=${entity('sal')}`);
  assert.ok(sal.length && sal.every((t) => t.entity_name === 'Presentail SAL (Lebanon)'));
  const { data: none } = await call('/tasks?entity_id=none');
  assert.ok(none.length && none.every((t) => t.entity_id === null));
});
