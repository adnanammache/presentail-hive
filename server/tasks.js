// Tasks shared by people and AI agents.
//
//   Stage (status):  backlog → ready → in_progress → review → done
//                    plus two sub-states: "scheduled" (Ready, waiting for its start date) and
//                    "waiting_approval" (Needs review, the agent's work waits for approval before it
//                    submits or pays anything).
//   Blocker:         separate from the stage (blocked_kind): info (waiting for information),
//                    approval (waiting for someone to approve), failed (execution failed). A task can
//                    be In progress and blocked; a failed run never resets or completes the stage.
//   Assignee:        one accountable owner: a person (assignee_email → users) or an AI agent
//                    (agent_id), or nobody. Never both.
//   Execution:       separate from assignment. Saving a task, assigning an agent or moving a card
//                    never starts, cancels or changes a run; only startExecution does, idempotently.
import { copyFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DATA_DIR, all, get, run, update } from './db.js';
import { emit } from './events.js';
import { logActivity } from './activity.js';
import { bad, check, conflict, notFound } from './http.js';
import { applyToFuture, cleanSchedule, spawnNext, startSeries } from './taskSchedule.js';
import { describeRule, dubaiNow, addDays, startReached } from './recurrence.js';
import { canApproveFor } from './roles.js';
import { pushToUser } from './push.js';
import { finishRun } from './scheduler.js';
import { avatarUrl } from './people.js';
import { dispatchTask } from './dispatch.js';

export const STAGES = ['backlog', 'ready', 'in_progress', 'review', 'done'];
export const TASK_STATUSES = ['backlog', 'ready', 'scheduled', 'in_progress', 'review', 'waiting_approval', 'done'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const BLOCKER_KINDS = ['info', 'approval', 'failed'];
export const stageOf = (status) => ({ scheduled: 'ready', waiting_approval: 'review', todo: 'ready', blocked: 'in_progress' })[status] ?? status;
const ACTIVE_RUN = ['starting', 'running', 'needs_approval'];

const TASK_FIELDS = [
  'title', 'description', 'status', 'priority', 'agent_id', 'assignee_email', 'due_date', 'result', 'handoff_agent_id', 'reviewer_email',
  'entity_id', 'done_definition', 'needs_approval', 'remind_days', 'start_on', 'project_id',
];

/** Who is acting: a signed-in person or an agent (Agent API). */
export const personActor = (user) => ({ type: 'user', ref: user.email, name: user.name || user.email, user });
export const agentActor = (agent) => ({ type: 'agent', ref: String(agent.id), name: agent.name, agent });

// ---------------------------------------------------------------- history

export function taskEvent(taskId, actor, kind, text) {
  const ref = actor?.type === 'user' ? `user:${actor.ref}` : actor?.type === 'agent' ? `agent:${actor.ref}` : null;
  run('INSERT INTO task_events (task_id, actor, kind, text, actor_ref) VALUES (?, ?, ?, ?, ?)', taskId, typeof actor === 'string' ? actor : actor?.name ?? 'Hive', kind, text, ref);
}

// ---------------------------------------------------------------- reading

const SELECT = `
  SELECT t.*, a.name AS agent_name, a.color AS agent_color, a.platform AS agent_platform, a.title AS agent_title, a.status AS agent_status,
    u.name AS assignee_name, u.photo_source AS a_photo_source, u.photo_version AS a_photo_version, u.provider_photo AS a_provider_photo,
    ru.name AS reviewer_person_name, ru.photo_source AS r_photo_source, ru.photo_version AS r_photo_version, ru.provider_photo AS r_provider_photo, pr.name AS project_name, pr.color AS project_color, pr.status AS project_status,
    w.name AS workflow_name, e.name AS entity_name, s.rule AS series_rule, s.ends_on AS series_ends_on, s.ended_at AS series_ended_at,
    COALESCE(t.handoff_agent_id, CASE WHEN t.parent_task_id IS NULL THEN a.reviewer_id END) AS reviewer_id,
    rv.name AS reviewer_name, p.title AS parent_title, h.status AS handoff_status, ha.name AS handoff_agent_name,
    (SELECT COUNT(*) FROM task_files f WHERE f.task_id = t.id) AS file_count,
    (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) AS comment_count,
    (SELECT COUNT(*) FROM task_links l WHERE l.task_id = t.id AND l.kind = 'deliverable')
      + (SELECT COUNT(*) FROM run_outputs o JOIN runs r ON r.id = o.run_id WHERE r.task_id = t.id) AS deliverable_count,
    (SELECT r.status FROM runs r WHERE r.task_id = t.id AND r.kind = 'task' ORDER BY r.id DESC LIMIT 1) AS run_status,
    (SELECT r.id FROM runs r WHERE r.task_id = t.id AND r.kind = 'task' ORDER BY r.id DESC LIMIT 1) AS run_id,
    (SELECT ev.text FROM task_events ev WHERE ev.task_id = t.id ORDER BY ev.id DESC LIMIT 1) AS last_event
  FROM tasks t
  LEFT JOIN agents a ON a.id = t.agent_id
  LEFT JOIN users u ON u.email = t.assignee_email
  LEFT JOIN users ru ON ru.email = t.reviewer_email
  LEFT JOIN projects pr ON pr.id = t.project_id
  LEFT JOIN workflows w ON w.id = t.workflow_id
  LEFT JOIN entities e ON e.id = t.entity_id
  LEFT JOIN task_series s ON s.id = t.series_id
  LEFT JOIN agents rv ON rv.id = COALESCE(t.handoff_agent_id, CASE WHEN t.parent_task_id IS NULL THEN a.reviewer_id END)
  LEFT JOIN tasks p ON p.id = t.parent_task_id
  LEFT JOIN tasks h ON h.id = t.handoff_task_id LEFT JOIN agents ha ON ha.id = h.agent_id`;

/** Add the derived fields every view uses. */
export function decorate(t) {
  const rule = t.series_rule ? JSON.parse(t.series_rule) : null;
  const assignee = t.agent_id
    ? { type: 'agent', ref: `agent:${t.agent_id}`, id: t.agent_id, name: t.agent_name, detail: t.agent_title, color: t.agent_color }
    : t.assignee_email
      ? {
          type: 'user', ref: `user:${t.assignee_email}`, email: t.assignee_email, name: t.assignee_name || t.assignee_email,
          avatar_url: avatarUrl({ email: t.assignee_email, photo_source: t.a_photo_source, photo_version: t.a_photo_version, provider_photo: t.a_provider_photo }),
        }
      : null;
  const reviewer = t.reviewer_email
    ? {
        type: 'user', ref: `user:${t.reviewer_email}`, email: t.reviewer_email, name: t.reviewer_person_name || t.reviewer_email,
        avatar_url: avatarUrl({ email: t.reviewer_email, photo_source: t.r_photo_source, photo_version: t.r_photo_version, provider_photo: t.r_provider_photo }),
      }
    : t.reviewer_id
      ? { type: 'agent', ref: `agent:${t.reviewer_id}`, id: t.reviewer_id, name: t.reviewer_name }
      : null;
  return {
    ...t,
    stage: stageOf(t.status),
    assignee,
    reviewer,
    blocker: t.blocked_kind ? { kind: t.blocked_kind, reason: t.blocked_reason, owner: t.blocked_owner, at: t.blocked_at } : null,
    progress: t.progress_total > 0 ? { done: t.progress_done ?? 0, total: t.progress_total, label: t.progress_label ?? '' } : null,
    repeat: t.series_ended_at ? null : rule,
    repeat_label: rule && !t.series_ended_at ? describeRule(rule) : null,
  };
}

export function getTask(id, user) {
  const t = get(`${SELECT} WHERE t.id = ?`, id);
  return t ? { ...decorate(t), ...(user ? { needs_me: needsMe(t, user), can_edit: canEditTask(user, t) } : {}) } : null;
}

const today = () => dubaiNow().date;

/**
 * Does this task need something from this person?
 *  - an approval they can give (an agent's command, blocker "approval"), or
 *  - a review they own: the task's reviewer, else the person who created it; tasks created before
 *    reviewers were recorded (no reviewer, no creator) go to workspace owners.
 * A task an agent is still reviewing (handed off, review not done) needs nobody yet.
 */
export function needsMe(t, user) {
  if (!user || t.status === 'done') return false;
  if (t.blocked_kind === 'approval') return canApproveFor(user, t.agent_id);
  if (!['review', 'waiting_approval'].includes(t.status)) return false;
  if (t.handoff_task_id && t.handoff_status && t.handoff_status !== 'done') return false;
  if (t.status === 'waiting_approval' && !canApproveFor(user, t.agent_id)) return false;
  const owner = t.reviewer_email || t.created_by;
  return owner ? owner === user.email : user.role === 'owner';
}

/**
 * Tasks for a view. Filters: mine, project_id (id | "none"), assignee ("user:email" | "agent:id" |
 * "none"), type (people | agents), priority, due (overdue | today | week | none), q, attention
 * (review_mine | blocked | overdue), plus agent_id, status, stage, workflow_id, entity_id, series_id.
 * Tasks in archived projects are left out unless that project is asked for.
 */
export function listTasks(f = {}, user) {
  const where = [];
  const params = [];
  const add = (sql, ...p) => (where.push(sql), params.push(...p));
  const d = today();
  if (f.mine) add('t.assignee_email = ?', user?.email ?? '');
  if (f.project_id === 'none') add('t.project_id IS NULL');
  else if (f.project_id) add('t.project_id = ?', Number(f.project_id));
  else add("(t.project_id IS NULL OR pr.status = 'active')");
  if (f.assignee === 'none') add('t.agent_id IS NULL AND t.assignee_email IS NULL');
  else if (f.assignee?.startsWith('user:')) add('t.assignee_email = ?', f.assignee.slice(5).toLowerCase());
  else if (f.assignee?.startsWith('agent:')) add('t.agent_id = ?', Number(f.assignee.slice(6)));
  if (f.type === 'people') add('t.assignee_email IS NOT NULL');
  if (f.type === 'agents') add('t.agent_id IS NOT NULL');
  if (f.priority) add('t.priority = ?', f.priority);
  if (f.due === 'overdue' || f.attention === 'overdue') add("t.due_date < ? AND t.status != 'done'", d);
  if (f.due === 'today') add('t.due_date = ?', d);
  if (f.due === 'week') add('t.due_date >= ? AND t.due_date <= ?', d, addDays(d, 7));
  if (f.due === 'none') add('t.due_date IS NULL');
  if (f.attention === 'blocked') add("t.blocked_kind IS NOT NULL AND t.status != 'done'");
  if (f.q) add("(t.title LIKE ? OR t.description LIKE ?)", `%${f.q}%`, `%${f.q}%`);
  if (f.agent_id) add('t.agent_id = ?', Number(f.agent_id));
  if (f.status) add('t.status = ?', f.status);
  if (f.stage) add(`t.status IN (${TASK_STATUSES.filter((s) => stageOf(s) === f.stage).map(() => '?').join(',')})`, ...TASK_STATUSES.filter((s) => stageOf(s) === f.stage));
  for (const k of ['workflow_id', 'series_id']) if (f[k]) add(`t.${k} = ?`, Number(f[k]));
  if (f.entity_id === 'none') add('t.entity_id IS NULL');
  else if (f.entity_id) add('t.entity_id = ?', Number(f.entity_id));
  let rows = all(
    `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.updated_at DESC`,
    ...params,
  );
  if (f.attention === 'review_mine') rows = rows.filter((t) => needsMe(t, user));
  return rows.map((t) => ({ ...decorate(t), needs_me: needsMe(t, user) }));
}

/** A board: every open task, the most recent `doneLimit` done ones, and true counts per stage. */
export function board(f, user, doneLimit = 20) {
  const tasks = listTasks(f, user);
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const t of tasks) counts[t.stage] = (counts[t.stage] ?? 0) + 1;
  const done = tasks.filter((t) => t.stage === 'done').sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
  return { tasks: [...tasks.filter((t) => t.stage !== 'done'), ...done.slice(0, doneLimit)], counts, done_total: done.length, done_loaded: Math.min(done.length, doneLimit) };
}

/** The attention strip: what needs me, what's blocked, what's overdue. */
export function attention(user, projectId) {
  const scope = projectId ? { project_id: projectId } : {};
  const open = listTasks(scope, user).filter((t) => t.status !== 'done');
  const d = today();
  return {
    review_mine: open.filter((t) => needsMe(t, user)).length,
    blocked: open.filter((t) => t.blocked_kind).length,
    overdue: open.filter((t) => t.due_date && t.due_date < d).length,
  };
}

// ---------------------------------------------------------------- validation

/** Turn {type, id|email} (or a "user:x" / "agent:1" string, or null) into columns. */
export function parseAssignee(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '' || value === 'none') return { agent_id: null, assignee_email: null };
  const v = typeof value === 'string' ? (value.startsWith('agent:') ? { type: 'agent', id: value.slice(6) } : value.startsWith('user:') ? { type: 'user', email: value.slice(5) } : null) : value;
  if (v?.type === 'agent') {
    const id = Number(v.id);
    if (!Number.isInteger(id) || !get('SELECT id FROM agents WHERE id = ?', id)) throw bad('Unknown agent');
    return { agent_id: id, assignee_email: null };
  }
  if (v?.type === 'user') {
    const email = String(v.email ?? '').toLowerCase();
    const u = get('SELECT email, status FROM users WHERE email = ?', email);
    if (!u) throw bad('That person is not a member of this workspace');
    if (u.status !== 'active') throw bad(`${email}'s access is turned off, so they can't be given work. Reassign it to someone else.`);
    return { agent_id: null, assignee_email: email };
  }
  throw bad('assignee must be a person or an AI agent');
}

function checkPerson(email, what) {
  if (!email) return;
  const u = get('SELECT status FROM users WHERE email = ?', String(email).toLowerCase());
  if (!u) throw bad(`${what} is not a member of this workspace`);
  if (u.status !== 'active') throw bad(`${what}'s access is turned off`);
}

/** Can this person put tasks in (or take them out of) this project? */
export function canContribute(user, project) {
  if (!user || !project) return false;
  if (user.role === 'owner' || project.owner_email === user.email) return true;
  return Boolean(get("SELECT 1 FROM project_members WHERE project_id = ? AND member_type = 'user' AND member_ref = ?", project.id, user.email));
}

/**
 * May this person change this task? Anyone in the workspace, for tasks outside projects; inside a
 * project, its members, owner and workspace owners, plus whoever the task is assigned to, created it
 * or reviews it. (Everyone can read; the server checks every change.)
 */
export function canEditTask(user, t) {
  if (!user || !t) return false;
  if (!t.project_id || user.role === 'owner') return true;
  if ([t.assignee_email, t.created_by, t.reviewer_email].includes(user.email)) return true;
  return canContribute(user, get('SELECT * FROM projects WHERE id = ?', t.project_id));
}

function checkProject(projectId, actor) {
  if (projectId === undefined || projectId === null) return;
  const p = get('SELECT * FROM projects WHERE id = ?', Number(projectId));
  if (!p) throw bad('Unknown project');
  if (p.status !== 'active') throw bad('That project is archived');
  if (actor?.type !== 'user' || !canContribute(actor.user, p)) throw bad("You can add tasks only to projects you're a member of");
}

/** Legacy statuses from older callers: "todo" is Ready; "blocked" becomes a blocker on the current stage. */
function normalizeStatus(obj) {
  if (obj.status === 'todo') obj.status = 'ready';
  if (obj.status === 'blocked') {
    delete obj.status;
    obj.blocked ??= { kind: 'info', reason: obj.result || 'Blocked' };
  }
}

// ---------------------------------------------------------------- blockers

export function setBlocker(taskId, { kind, reason = '', owner = null }, actor = 'Hive') {
  check(kind, BLOCKER_KINDS, 'blocker kind');
  const t = get('SELECT status, blocked_kind, blocked_reason FROM tasks WHERE id = ?', taskId);
  if (!t || t.status === 'done') return;
  if (t.blocked_kind === kind && t.blocked_reason === (reason || null)) return;
  run(
    "UPDATE tasks SET blocked_kind = ?, blocked_reason = ?, blocked_owner = ?, blocked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    kind, String(reason || '').slice(0, 2000) || null, owner ? String(owner).slice(0, 200) : null, taskId,
  );
  const label = { info: 'Waiting for information', approval: 'Waiting for approval', failed: 'Execution failed' }[kind];
  taskEvent(taskId, actor, 'blocked', `${label}${reason ? `: ${String(reason).slice(0, 300)}` : ''}`);
  emit('task', { task_id: taskId });
}

/** Clear the blocker (only of these kinds, if given). */
export function clearBlocker(taskId, kinds, actor = 'Hive') {
  const t = get('SELECT blocked_kind FROM tasks WHERE id = ?', taskId);
  if (!t?.blocked_kind || (kinds && !kinds.includes(t.blocked_kind))) return;
  run('UPDATE tasks SET blocked_kind = NULL, blocked_reason = NULL, blocked_owner = NULL, blocked_at = NULL WHERE id = ?', taskId);
  taskEvent(taskId, actor, 'unblocked', 'No longer blocked');
  emit('task', { task_id: taskId });
}

// ---------------------------------------------------------------- notifications

/** A person's notice: their Inbox list and their devices (the existing push notifications). */
export function notifyUser(email, { taskId, text, title }) {
  run('INSERT INTO reminders (task_id, text, user_email) VALUES (?, ?, ?)', taskId ?? null, text, email);
  emit('reminder');
  pushToUser(email, { title: title ?? 'Presentail Hive', body: text, url: taskId ? `/#/tasks/${taskId}` : '/', tag: taskId ? `task-${taskId}` : undefined }).catch(() => {});
}

function notifyAssigned(taskId, email, actor) {
  if (!email || (actor?.type === 'user' && actor.ref === email)) return; // assigning yourself needs no notice
  const t = get('SELECT title FROM tasks WHERE id = ?', taskId);
  notifyUser(email, { taskId, title: 'New task for you', text: `${actor?.name ?? 'Someone'} assigned you "${t.title}".` });
}

// ---------------------------------------------------------------- files and links

function moveDraftFiles(taskId, ids, email) {
  if (!ids?.length) return;
  const dir = join(DATA_DIR, 'uploads', String(taskId));
  mkdirSync(dir, { recursive: true });
  for (const id of ids) {
    const f = get('SELECT * FROM draft_files WHERE id = ? AND user_email = ?', Number(id), email);
    if (!f) continue;
    let name = f.filename;
    for (let i = 2; get('SELECT 1 FROM task_files WHERE task_id = ? AND filename = ?', taskId, name); i++) name = f.filename.replace(/(\.[^.]*)?$/, (ext) => ` (${i})${ext || ''}`);
    const path = join(dir, `${Date.now()}-${basename(f.path)}`);
    try {
      renameSync(f.path, path);
    } catch {
      copyFileSync(f.path, path);
      rmSync(f.path, { force: true });
    }
    run('INSERT INTO task_files (task_id, filename, path, size) VALUES (?, ?, ?, ?)', taskId, name, path, f.size);
    run('DELETE FROM draft_files WHERE id = ?', f.id);
  }
}

export function addLinks(taskId, links, actor, kind = 'reference') {
  for (const l of links ?? []) {
    const url = cleanLink(l?.url ?? l);
    if (!url) throw bad(`Not a web link: ${String(l?.url ?? l).slice(0, 80)}`);
    run('INSERT INTO task_links (task_id, kind, url, label, created_by) VALUES (?, ?, ?, ?, ?)', taskId, kind, url, String(l?.label ?? '').slice(0, 200), actor?.name ?? null);
  }
}
function cleanLink(u) {
  try {
    const url = new URL(String(u ?? '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- create and change

/**
 * Create a task. The same client_key always returns the same task (a retried submit never makes a
 * second one). Creating never starts an agent: the caller asks for that with startExecution.
 * Returns { id, existing }.
 */
export function createTask(body, actor) {
  if (body.client_key) {
    const existing = get('SELECT id FROM tasks WHERE client_key = ?', String(body.client_key));
    if (existing) return { id: existing.id, existing: true };
  }
  body = { ...body };
  normalizeStatus(body);
  if (!body.title?.trim()) throw bad('title is required');
  check(body.status, TASK_STATUSES, 'status');
  check(body.priority, PRIORITIES, 'priority');
  const who = parseAssignee(body.assignee !== undefined ? body.assignee : body.assignee_email ? { type: 'user', email: body.assignee_email } : body.agent_id ? { type: 'agent', id: body.agent_id } : null);
  checkPerson(body.reviewer_email, 'The reviewer');
  if (body.handoff_agent_id && !get('SELECT id FROM agents WHERE id = ?', body.handoff_agent_id)) throw bad('Unknown reviewer');
  if (body.close_item_id && !get('SELECT id FROM close_items WHERE id = ?', body.close_item_id)) throw bad('Unknown close item');
  if (body.period && !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.period)) throw bad('period must be YYYY-MM');
  if (body.project_id != null) checkProject(body.project_id, actor);
  let sched;
  try {
    sched = cleanSchedule(body);
  } catch (err) {
    throw bad(err.message);
  }
  if (sched.repeat && !sched.due_date) throw bad('Set a due date to make a task repeat');
  if (sched.repeat && sched.ends_on && sched.ends_on < sched.due_date) throw bad('"Ends on" is before the first due date');
  // A future start date waits in Scheduled (unless it's being started now).
  const startOn = body.start ? null : sched.start_on ?? null;
  const status = startOn && !startReached(startOn) ? 'scheduled' : body.status ?? 'ready';
  const { lastInsertRowid } = run(
    `INSERT INTO tasks (title, description, status, priority, agent_id, assignee_email, due_date, handoff_agent_id, reviewer_email, close_item_id, period,
       entity_id, done_definition, needs_approval, remind_days, start_on, project_id, created_by, client_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    body.title.trim().slice(0, 300),
    body.description ?? '',
    status,
    body.priority ?? 'medium',
    who.agent_id,
    who.assignee_email,
    sched.due_date ?? null,
    body.handoff_agent_id ?? null,
    body.reviewer_email ? String(body.reviewer_email).toLowerCase() : null,
    body.close_item_id ?? null,
    body.close_item_id ? body.period ?? null : null,
    sched.entity_id ?? null,
    body.done_definition ?? '',
    body.needs_approval ? 1 : 0,
    sched.remind_days ?? null,
    // Kept even when started now, so a repeating task's later instances start as far ahead of their due date.
    sched.start_on ?? null,
    body.project_id ?? null,
    actor?.type === 'user' ? actor.ref : null,
    body.client_key ? String(body.client_key).slice(0, 80) : null,
  );
  const id = Number(lastInsertRowid);
  if (sched.repeat) {
    const seriesId = startSeries(id, sched.repeat, { ends_on: sched.ends_on ?? null });
    // Only a task that is started (now or on a start date) makes its repeats start themselves.
    if (!body.start && !sched.start_on) run('UPDATE task_series SET auto_start = 0 WHERE id = ?', seriesId);
  }
  if (body.links?.length) addLinks(id, body.links, actor);
  if (actor?.type === 'user') moveDraftFiles(id, body.draft_file_ids, actor.ref);
  if (body.blocked) setBlocker(id, body.blocked, actor);
  const assignee = who.agent_id ? get('SELECT name FROM agents WHERE id = ?', who.agent_id)?.name : who.assignee_email ? get('SELECT name FROM users WHERE email = ?', who.assignee_email)?.name ?? who.assignee_email : null;
  taskEvent(id, actor, 'created', `Created${assignee ? ` and assigned to ${assignee}` : ''}`);
  logActivity(who.agent_id, 'task', `${actor?.name ?? 'Someone'} created task "${body.title.trim()}"`);
  notifyAssigned(id, who.assignee_email, actor);
  emit('task', { task_id: id });
  return { id, existing: false };
}

const hasActiveRun = (taskId) => get(`SELECT id FROM runs WHERE task_id = ? AND status IN (${ACTIVE_RUN.map(() => '?').join(',')})`, taskId, ...ACTIVE_RUN);

/** Apply a change to a task, with its side effects. Never starts or stops an agent. */
export function patchTask(id, patch, actor, { scope = 'this' } = {}) {
  const before = get('SELECT * FROM tasks WHERE id = ?', id);
  if (!before) throw notFound('Task');
  patch = { ...patch };
  normalizeStatus(patch);
  check(patch.status, TASK_STATUSES, 'status');
  check(patch.priority, PRIORITIES, 'priority');
  let sched;
  try {
    sched = cleanSchedule(patch);
  } catch (err) {
    throw bad(err.message);
  }
  Object.assign(patch, sched);
  if (patch.needs_approval !== undefined) patch.needs_approval = patch.needs_approval ? 1 : 0;

  // Assignee: one person or one agent. Not while an agent is working on it.
  let who = parseAssignee(patch.assignee !== undefined ? patch.assignee : patch.agent_id !== undefined ? (patch.agent_id ? { type: 'agent', id: patch.agent_id } : null) : undefined);
  if (who && who.agent_id === before.agent_id && who.assignee_email === before.assignee_email) who = undefined;
  if (who) {
    if (hasActiveRun(id)) throw conflict(`${get('SELECT name FROM agents WHERE id = ?', before.agent_id)?.name ?? 'The agent'} is working on this task right now. Stop the run first, then reassign it.`);
    Object.assign(patch, who);
  } else {
    delete patch.agent_id;
    delete patch.assignee_email;
  }
  if (patch.reviewer_email !== undefined) {
    patch.reviewer_email = patch.reviewer_email ? String(patch.reviewer_email).toLowerCase() : null;
    checkPerson(patch.reviewer_email, 'The reviewer');
    if (patch.reviewer_email) patch.handoff_agent_id = null;
  }
  if (patch.handoff_agent_id !== undefined && patch.handoff_agent_id !== null) {
    if (!get('SELECT id FROM agents WHERE id = ?', patch.handoff_agent_id)) throw bad('Unknown reviewer');
    patch.reviewer_email = null;
  }
  if (patch.project_id !== undefined && patch.project_id !== before.project_id) {
    patch.project_id = patch.project_id === null || patch.project_id === '' ? null : Number(patch.project_id);
    if (patch.project_id !== null) checkProject(patch.project_id, actor);
    else if (before.project_id && actor?.type === 'user') {
      const p = get('SELECT * FROM projects WHERE id = ?', before.project_id);
      if (p && !canContribute(actor.user, p)) throw bad("You can move tasks only out of projects you're a member of");
    }
  }
  // A new start date in the future puts a task that hasn't started back to Scheduled.
  if (patch.start_on !== undefined && patch.status === undefined && ['scheduled', 'ready', 'backlog'].includes(before.status) && !get('SELECT id FROM runs WHERE task_id = ?', id))
    patch.status = startReached(patch.start_on) ? (before.status === 'scheduled' ? 'ready' : before.status) : 'scheduled';

  update('tasks', id, patch, TASK_FIELDS);
  run("UPDATE tasks SET updated_at = datetime('now') WHERE id = ?", id);
  if ((patch.due_date !== undefined && patch.due_date !== before.due_date) || (patch.remind_days !== undefined && patch.remind_days !== before.remind_days))
    run('UPDATE tasks SET reminded_at = NULL WHERE id = ?', id);

  // Repeat: turn it on, change it for this and future ones, or stop it.
  try {
    if (!before.series_id && sched.repeat) startSeries(id, sched.repeat, { ends_on: sched.ends_on ?? null });
    else if (before.series_id && (scope === 'future' || sched.repeat === null || sched.repeat || sched.ends_on !== undefined))
      applyToFuture(id, { repeat: sched.repeat, ends_on: sched.ends_on });
  } catch (err) {
    throw bad(err.message);
  }

  if (who) {
    const name = who.agent_id ? get('SELECT name FROM agents WHERE id = ?', who.agent_id)?.name : who.assignee_email ? get('SELECT name FROM users WHERE email = ?', who.assignee_email)?.name ?? who.assignee_email : null;
    taskEvent(id, actor, 'assigned', name ? `Assigned to ${name}` : 'Unassigned');
    notifyAssigned(id, who.assignee_email, actor);
  }
  if (patch.progress !== undefined) setProgress(id, patch.progress);
  if (patch.blocked !== undefined) {
    if (patch.blocked) setBlocker(id, patch.blocked, actor);
    else clearBlocker(id, null, actor);
  }
  if (patch.status && patch.status !== before.status) {
    run(`UPDATE tasks SET completed_at = ${patch.status === 'done' ? "datetime('now')" : 'NULL'} WHERE id = ?`, id);
    taskEvent(id, actor, 'moved', `Moved to ${STAGE_LABELS[stageOf(patch.status)] ?? patch.status}`);
    logActivity(before.agent_id, 'task', `${actor?.name ?? 'Someone'} moved "${before.title}" to ${(STAGE_LABELS[stageOf(patch.status)] ?? patch.status).toLowerCase()}`);
    // A workflow run is complete once its task is.
    const openRun = get("SELECT id FROM workflow_runs WHERE task_id = ? AND status = 'running'", id);
    if (openRun && patch.status === 'done') finishRun(openRun.id, 'success', patch.result ?? before.result);
    if (patch.status === 'done') clearBlocker(id, null, actor);
    // A repeating task is done: its next one is created now.
    if (patch.status === 'done' && before.series_id) spawnNext(before.series_id);
  }
  emit('task', { task_id: id });
  return getTask(id);
}

export const STAGE_LABELS = { backlog: 'Backlog', ready: 'Ready', in_progress: 'In progress', review: 'Needs review', done: 'Done' };

/** Measurable progress, as reported by an agent ("42 of 58 invoices matched"). null clears it. */
export function setProgress(taskId, p) {
  if (!p) return run('UPDATE tasks SET progress_done = NULL, progress_total = NULL, progress_label = NULL WHERE id = ?', taskId);
  const total = Number(p.total);
  const done = Number(p.done);
  if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(done) || done < 0 || done > total) throw bad('progress needs whole numbers: 0 ≤ done ≤ total');
  run('UPDATE tasks SET progress_done = ?, progress_total = ?, progress_label = ? WHERE id = ?', done, total, String(p.label ?? '').slice(0, 80) || null, taskId);
}

// ---------------------------------------------------------------- execution

/**
 * Ask the task's agent to start. Explicit and idempotent: an active run, or a start already done
 * with this key, is reported instead of starting another. A failure keeps the task (and its stage)
 * and records an "Execution failed" blocker, so it can be retried with the same key.
 */
export async function startExecution(taskId, { key, actor } = {}) {
  const t = get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!t) throw notFound('Task');
  const agent = t.agent_id && get('SELECT * FROM agents WHERE id = ?', t.agent_id);
  if (!agent) throw bad('Assign an AI agent before starting');
  if (key && t.start_key === String(key)) return { ok: true, already: true };
  if (agent.platform === 'managed' && hasActiveRun(taskId)) return { ok: true, already: true };
  if (t.status === 'done') throw bad('This task is done');
  try {
    if (agent.status === 'paused') throw new Error(`${agent.name} is paused. Resume it in Agents, then start again.`);
    await dispatchTask(taskId, { throwOnFail: true });
  } catch (err) {
    setBlocker(taskId, { kind: 'failed', reason: `Could not start: ${err.message}`, owner: actor?.name }, 'Hive');
    return { ok: false, error: err.message };
  }
  run('UPDATE tasks SET start_key = ? WHERE id = ?', key ? String(key).slice(0, 80) : `s-${Date.now()}`, taskId);
  clearBlocker(taskId, ['failed'], 'Hive');
  taskEvent(taskId, actor, 'started', `${actor?.name ?? 'Someone'} started ${agent.name}`);
  emit('task', { task_id: taskId });
  return { ok: true };
}

// ---------------------------------------------------------------- the Agent API's view

/**
 * The Agent API keeps its original vocabulary so existing automations keep working: Ready is
 * reported as "todo", a blocked task as "blocked". `stage` and `blocker` carry the new model.
 */
export function agentView(t) {
  if (!t) return t;
  const { api_token, ...rest } = t;
  const stage = stageOf(t.status);
  return { ...rest, stage, status: t.blocked_kind && t.status !== 'done' ? 'blocked' : stage === 'ready' && t.status !== 'scheduled' ? 'todo' : t.status };
}
