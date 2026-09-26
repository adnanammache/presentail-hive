// Scheduled, repeating and approval-gated tasks.
//
// - A task with a future start date waits in "scheduled"; the minute ticker starts it at 8:00 Dubai
//   time on that date.
// - A repeating task belongs to a series (task_series). When the latest instance is done, or its due
//   date passes, the next one is created with the next due date, copying the series' fields and the
//   previous instance's files. Its start date keeps the same distance from its due date.
// - Due-date reminders go to the Inbox, Slack and phones.
// - Tasks that need approval stop in "waiting_approval" when the agent finishes; Approve or Send back
//   resumes the agent with your decision.
import { copyFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Cron } from 'croner';
import { DATA_DIR, all, get, run } from './db.js';
import { emit } from './events.js';
import { logActivity } from './activity.js';
import { START_HOUR, addDays, daysBetween, dubaiNow, formatDay, isDate, normalizeRule, startReached, stepDate } from './recurrence.js';
import { baseUrl, sendSlack } from './notify.js';
import { pushToAll } from './push.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const parseRule = (s) => (s ? JSON.parse(s) : null);

// Dispatching lives in dispatch.js, which imports managed.js; injected to keep this module light.
let dispatcher = async () => {};
export const setDispatcher = (fn) => (dispatcher = fn);

// ---------------------------------------------------------------- what the agent is told

export const APPROVAL_LINE = 'Do not submit any filing, return or payment. Prepare everything, then stop and ask Adnan for approval.';

/** Extra lines for the agent's task brief: entity, definition of done, the approval rule. */
export function briefExtras(task) {
  const entity = task.entity_id ? get('SELECT name FROM entities WHERE id = ?', task.entity_id)?.name : null;
  return [
    entity ? `Entity: ${entity}` : '',
    task.done_definition?.trim() ? `Definition of done: ${task.done_definition.trim()}` : '',
    task.needs_approval && !task.approved_at
      ? `${APPROVAL_LINE} To ask, call task_complete with what you prepared; Hive shows it to Adnan with Approve and Send back buttons.`
      : '',
  ].filter(Boolean);
}

/** Where a task goes when the agent hands it back: approval first if it needs it and isn't approved yet. */
export function readyStatus(taskId) {
  const t = get('SELECT needs_approval, approved_at, parent_task_id FROM tasks WHERE id = ?', taskId);
  return t?.needs_approval && !t.approved_at && !t.parent_task_id ? 'waiting_approval' : 'review';
}

// ---------------------------------------------------------------- creating a series

/**
 * Validate the schedule fields of a new or edited task. Returns the cleaned values.
 * `start_on` is a Dubai date or null (start now); `repeat` a rule or null.
 */
export function cleanSchedule(body) {
  const out = {};
  for (const k of ['start_on', 'due_date', 'ends_on']) {
    if (body[k] === undefined) continue;
    if (body[k] !== null && body[k] !== '' && !isDate(body[k])) throw new Error(`${k} must be a date (YYYY-MM-DD)`);
    out[k] = body[k] || null;
  }
  if (body.remind_days !== undefined) {
    const n = body.remind_days === null || body.remind_days === '' ? null : Number(body.remind_days);
    if (n !== null && (!Number.isInteger(n) || n < 0 || n > 365)) throw new Error('Remind me must be 0 to 365 days before');
    out.remind_days = n;
  }
  if (body.repeat !== undefined) out.repeat = normalizeRule(body.repeat);
  if (body.entity_id !== undefined) {
    out.entity_id = body.entity_id ? Number(body.entity_id) : null;
    if (out.entity_id && !get('SELECT id FROM entities WHERE id = ?', out.entity_id)) throw new Error('Unknown entity');
  }
  return out;
}

/** The start offset for a series: from the chosen start date, or today if it starts now. */
function offsetFor(startOn, due, now) {
  const from = startOn || dubaiNow(now).date;
  return Math.max(0, daysBetween(from, due));
}

/** Make `taskId` the first instance of a new series. */
export function startSeries(taskId, rule, { ends_on = null, now = new Date() } = {}) {
  const t = get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!t.due_date) throw new Error('Set a due date to make a task repeat');
  if (ends_on && ends_on < t.due_date) throw new Error('"Ends on" is before the first due date');
  const id = Number(
    run(
      `INSERT INTO task_series (rule, anchor_due, anchor_index, ends_on, start_offset_days, last_index, title, description, done_definition, priority,
         agent_id, handoff_agent_id, entity_id, remind_days, needs_approval)
       VALUES (?, ?, 1, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      JSON.stringify(rule), t.due_date, ends_on, offsetFor(t.start_on, t.due_date, now), t.title, t.description, t.done_definition, t.priority,
      t.agent_id, t.handoff_agent_id, t.entity_id, t.remind_days, t.needs_approval,
    ).lastInsertRowid,
  );
  run('UPDATE tasks SET series_id = ?, series_index = 1 WHERE id = ?', id, taskId);
  return id;
}

const SERIES_FIELDS = ['title', 'description', 'done_definition', 'priority', 'agent_id', 'handoff_agent_id', 'entity_id', 'remind_days', 'needs_approval'];

/**
 * "This and future ones": copy the edited task's fields to its series and to instances not started
 * yet, and re-anchor the dates on it.
 */
export function applyToFuture(taskId, { repeat, ends_on } = {}, now = new Date()) {
  const t = get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!t?.series_id) return;
  const s = get('SELECT * FROM task_series WHERE id = ?', t.series_id);
  if (repeat === null) {
    // Stop repeating from here: later instances not started yet go too.
    run("UPDATE task_series SET ended_at = datetime('now') WHERE id = ?", s.id);
    run("DELETE FROM tasks WHERE series_id = ? AND series_index > ? AND status = 'scheduled'", s.id, t.series_index);
    return;
  }
  const sets = SERIES_FIELDS.map((f) => `${f} = ?`).join(', ');
  run(`UPDATE task_series SET ${sets} WHERE id = ?`, ...SERIES_FIELDS.map((f) => t[f]), s.id);
  if (t.due_date) {
    run(
      'UPDATE task_series SET anchor_due = ?, anchor_index = ?, start_offset_days = ?, rule = ?, ends_on = ? WHERE id = ?',
      t.due_date, t.series_index, offsetFor(t.start_on, t.due_date, now), JSON.stringify(repeat ?? parseRule(s.rule)), ends_on === undefined ? s.ends_on : ends_on, s.id,
    );
  }
  const later = all("SELECT id, series_index FROM tasks WHERE series_id = ? AND series_index > ? AND status IN ('scheduled', 'backlog', 'todo')", s.id, t.series_index);
  const fresh = get('SELECT * FROM task_series WHERE id = ?', s.id);
  for (const l of later) {
    const due = dueOf(fresh, l.series_index);
    run(
      `UPDATE tasks SET ${sets}, due_date = ?, start_on = ?, reminded_at = NULL, updated_at = datetime('now') WHERE id = ?`,
      ...SERIES_FIELDS.map((f) => t[f]), due, fresh.start_offset_days != null ? addDays(due, -fresh.start_offset_days) : null, l.id,
    );
    emit('task', { task_id: l.id });
  }
}

const dueOf = (s, index) => stepDate(s.anchor_due, parseRule(s.rule), index - s.anchor_index);

// ---------------------------------------------------------------- the next instance

function copyFiles(fromTaskId, toTaskId) {
  const files = all('SELECT * FROM task_files WHERE task_id = ? ORDER BY id', fromTaskId);
  if (!files.length) return;
  const dir = join(DATA_DIR, 'uploads', String(toTaskId));
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    try {
      const path = join(dir, basename(f.path));
      copyFileSync(f.path, path);
      run('INSERT INTO task_files (task_id, filename, path, size) VALUES (?, ?, ?, ?)', toTaskId, f.filename, path, f.size);
    } catch (err) {
      console.error('[schedule] could not copy', f.filename, err.message);
    }
  }
}

/**
 * Create the series' next instance if the latest is done or overdue. Returns the new task id, or
 * null. Safe to call any time: it only ever creates each instance once.
 */
export function spawnNext(seriesId, now = new Date()) {
  const s = get('SELECT * FROM task_series WHERE id = ?', seriesId);
  if (!s || s.ended_at) return null;
  const today = dubaiNow(now).date;
  const latest = get('SELECT * FROM tasks WHERE series_id = ? AND series_index = ?', s.id, s.last_index);
  const latestDue = latest?.due_date ?? dueOf(s, s.last_index);
  if (latest && latest.status !== 'done' && latestDue >= today) return null;

  const index = s.last_index + 1;
  const due = dueOf(s, index);
  if (s.ends_on && due > s.ends_on) {
    run("UPDATE task_series SET ended_at = datetime('now') WHERE id = ?", s.id);
    return null;
  }
  // Claim the index first, so two callers can't both create it.
  if (!run('UPDATE task_series SET last_index = ? WHERE id = ? AND last_index = ?', index, s.id, s.last_index).changes) return null;

  const startOn = s.start_offset_days != null ? addDays(due, -s.start_offset_days) : null;
  const status = startReached(startOn, now) ? 'todo' : 'scheduled';
  const id = Number(
    run(
      `INSERT INTO tasks (title, description, done_definition, status, priority, agent_id, handoff_agent_id, entity_id, due_date, start_on,
         remind_days, needs_approval, series_id, series_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.title, s.description, s.done_definition, status, s.priority, s.agent_id, s.handoff_agent_id, s.entity_id, due, startOn,
      s.remind_days, s.needs_approval, s.id, index,
    ).lastInsertRowid,
  );
  if (latest) copyFiles(latest.id, id);
  logActivity(s.agent_id, 'task', `Next "${s.title}" created, due ${formatDay(due)}${status === 'scheduled' ? `, starts ${formatDay(startOn)}` : ''}`);
  emit('task', { task_id: id });
  if (status === 'todo' && s.agent_id) startTask(id);
  return id;
}

// ---------------------------------------------------------------- starting and reminding

function startTask(taskId) {
  const t = get('SELECT t.id, a.status AS agent_status FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.id = ?', taskId);
  if (!t || t.agent_status == null || t.agent_status === 'paused') return; // stays in To do
  Promise.resolve()
    .then(() => dispatcher(taskId))
    .catch((err) => console.error(`[schedule] task ${taskId} could not start:`, err.message));
}

/** Scheduled tasks whose start date has come: move to To do and hand to the agent. */
function startDue(now) {
  const { date, hour } = dubaiNow(now);
  const due = all(
    "SELECT id FROM tasks WHERE status = 'scheduled' AND start_on IS NOT NULL AND (start_on < ? OR (start_on = ? AND ? >= ?))",
    date, date, hour, START_HOUR,
  );
  for (const { id } of due) {
    if (!run("UPDATE tasks SET status = 'todo', updated_at = datetime('now') WHERE id = ? AND status = 'scheduled'", id).changes) continue;
    emit('task', { task_id: id });
    startTask(id);
  }
  return due.map((d) => d.id);
}

function remind(now) {
  const { date, hour } = dubaiNow(now);
  if (hour < START_HOUR) return [];
  const tasks = all(
    `SELECT t.*, a.name AS agent_name FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id
     WHERE t.due_date IS NOT NULL AND t.remind_days IS NOT NULL AND t.reminded_at IS NULL AND t.status != 'done'`,
  ).filter((t) => addDays(t.due_date, -t.remind_days) <= date);
  for (const t of tasks) {
    const left = daysBetween(date, t.due_date);
    const when = left > 1 ? `in ${left} days` : left === 1 ? 'tomorrow' : left === 0 ? 'today' : `${-left} day${left === -1 ? '' : 's'} ago`;
    const text = `"${t.title}" is due ${formatDay(t.due_date)} (${when}).${t.agent_name ? ` ${t.agent_name}` : ''}${t.status === 'scheduled' ? ` starts ${formatDay(t.start_on)}` : ''}`.trim();
    run("UPDATE tasks SET reminded_at = datetime('now') WHERE id = ?", t.id);
    run('INSERT INTO reminders (task_id, text) VALUES (?, ?)', t.id, text);
    const url = `/#/tasks/${t.id}`;
    sendSlack({ text: `⏰ Reminder: *${esc(t.title)}* is due ${formatDay(t.due_date)} (${when})`, link: `${baseUrl()}${url}` }).catch(() => {});
    pushToAll({ title: `Due ${when}: ${t.title}`, body: text, url, tag: `remind-${t.id}` }).catch(() => {});
  }
  if (tasks.length) emit('reminder');
  return tasks.map((t) => t.id);
}

/** One pass: start what's due to start, send reminders, create next instances. Runs every minute. */
export function tick(now = new Date()) {
  const started = startDue(now);
  const reminded = remind(now);
  const spawned = all('SELECT id FROM task_series WHERE ended_at IS NULL').map((s) => spawnNext(s.id, now)).filter(Boolean);
  return { started, reminded, spawned };
}

let job;
export function startTaskTicker() {
  job?.stop();
  job = new Cron('* * * * *', { protect: true }, () => {
    try {
      tick();
    } catch (err) {
      console.error('[schedule]', err.message);
    }
  });
}
export const stopTaskTicker = () => job?.stop();
