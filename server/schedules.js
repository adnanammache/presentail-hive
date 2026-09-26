// Recurring tasks: schedules that create a normal Hive task on every occurrence.
//
// One source of truth: a schedule is a row in `workflows` (the Workflows screen and each agent's
// Tasks → Recurring view both show these), and each occurrence is a row in `workflow_runs`.
//
//   Identities   creator (the person or agent that set it up), assignee (the person or agent that
//                gets each task) and the authorizing person (whose instruction permits it) are kept
//                apart. The creator and authorizing person come from trusted context (the signed-in
//                person, or the agent run and the person it's answering), never from a model's input.
//   Occurrence   one per schedule and instant (occurrence_key is unique), with its own state:
//                  state            pending → created | skipped | failed
//                  dispatch_status  none (create only, or a person) | pending → dispatched | retrying | failed
//                The agent's execution (runs) and the task's stage (tasks.status) are separate again.
//                An occurrence is never "successful" because its task exists: its outcome follows the
//                task (running → success when the task is done, failed when it couldn't start).
//   Scheduler    durable: next_run_at is stored, a minute ticker claims due schedules in a write
//                transaction (compare-and-set on next_run_at), so any number of workers can run and
//                each occurrence is created once. Delivery is leased, task creation is keyed by the
//                occurrence, and starting the agent is keyed too, so retries never make a second task
//                or a second run. A start that fails is retried (1, 5, 15 minutes) on the same task.
//   Missed runs  after downtime only the latest missed occurrence is created; earlier ones are
//                recorded as skipped (missed_policy 'run_latest'), or all are skipped ('skip_all').
//                Nothing missed while a schedule was paused is caught up.
//   Overlap      agents: an occurrence is skipped while the previous one is still running
//                (skip_if_running). People: every occurrence is created (always_create), or skipped
//                while the previous task is open (skip_if_open). Skips are recorded with the reason.
//   Eligibility  checked again before every occurrence: the assignee still exists and isn't paused,
//                still has access to the project, and the authorizing person is still a member with
//                access. If not, the occurrence is skipped, the schedule is suspended (status 'error')
//                with the reason, and someone who can manage it must resume it. Work is never reassigned.
import { Cron } from 'croner';
import { all, db, get, run } from './db.js';
import { emit } from './events.js';
import { logActivity } from './activity.js';
import { bad, conflict, forbidden, notFound } from './http.js';
import { baseUrl, notifyWorkflowFailed } from './notify.js';
import { canContribute, createTask, getTask, notifyUser, personActor, startExecution } from './tasks.js';
import {
  DEFAULT_TIMEZONE, RuleError, checkTemplate, describeDeadlineRule, describePeriodRule, describeRule, fillTemplate, formatDate, formatLocal,
  isDateStr, isTimeZone, localDate, normalizeDeadlineRule, normalizePeriodRule, normalizeRule, occurrencesAfter, occurrencesBetween,
  periodLabel, resolveDeadline, resolvePeriod,
} from './recurring.js';

export const MODES = ['create_and_start', 'create_only'];
export const OVERLAP_POLICIES = ['skip_if_running', 'skip_if_open', 'always_create'];
export const MISSED_POLICIES = ['run_latest', 'skip_all'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const LATE_AFTER_MS = 10 * 60 * 1000; // an occurrence claimed this late was missed (Hive was down)
const LEASE_MS = 2 * 60 * 1000;
const RETRY_MINUTES = [1, 5, 15]; // after the 1st, 2nd and 3rd failed start; then it's failed
const MAX_SKIPPED_ROWS = 50; // a long outage records at most this many skipped occurrences

export const MODE_LABELS = {
  create_and_start: 'Create the task and start the agent',
  create_only: 'Create the task only (nothing starts automatically)',
};
export const OVERLAP_LABELS = {
  skip_if_running: 'Skip a run while the previous one is still running',
  skip_if_open: 'Skip a run while the previous task is still open',
  always_create: 'Create every run, even if the previous task is still open',
};
export const MISSED_LABELS = {
  run_latest: 'If Hive was offline when runs were due, only the latest missed run is created; earlier ones are recorded as skipped.',
  skip_all: 'Runs missed while Hive was offline are skipped.',
};

const iso = (d) => new Date(d).toISOString();
const parse = (s) => (s ? JSON.parse(s) : null);
const clip = (s, n) => String(s ?? '').slice(0, n);
export const manageUrl = (id) => `${baseUrl()}/#/workflows/${id}`;

// ---------------------------------------------------------------- transactions

let depth = 0;
/** Run `fn` in one write transaction (BEGIN IMMEDIATE takes the write lock up front). Nested calls join it. */
export function tx(fn) {
  if (depth) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn();
    depth--;
    db.exec('COMMIT');
    return out;
  } catch (err) {
    depth--;
    db.exec('ROLLBACK');
    throw err;
  }
}

function event(workflowId, actor, kind, text, data) {
  run('INSERT INTO schedule_events (workflow_id, actor, kind, text, data) VALUES (?, ?, ?, ?, ?)', workflowId, typeof actor === 'string' ? actor : actor?.name ?? 'Hive', kind, clip(text, 2000), data ? JSON.stringify(data) : null);
}

// ---------------------------------------------------------------- who

const userRow = (email) => (email ? get('SELECT * FROM users WHERE email = ?', String(email).toLowerCase()) : null);
/** A person who can use Hive now: in this workspace and not deactivated. */
const memberRow = (email) => {
  const u = userRow(email);
  return u && (u.status ?? 'active') !== 'deactivated' ? u : null;
};
/** Why this email can't take or authorize work, in words: never a member, or access turned off. */
const notMember = (email, what = 'is not a member of this workspace') => {
  const u = userRow(email);
  return u ? `${u.name || u.email}'s access to Hive is turned off` : `${email || 'That person'} ${what}`;
};
const agentRow = (id) => (id ? get('SELECT * FROM agents WHERE id = ?', id) : null);
const projectRow = (id) => (id ? get('SELECT * FROM projects WHERE id = ?', id) : null);
const withTeams = (u) => (u ? { ...u, teams: JSON.parse(u.teams || '[]') } : null);
/** Who authorizes a schedule. Workflows from before this was recorded were set up by owners: the first owner. */
const authorizerOf = (email) =>
  withTeams(email ? memberRow(email) : get("SELECT * FROM users WHERE role = 'owner' AND COALESCE(status, 'active') != 'deactivated' ORDER BY created_at, email LIMIT 1"));
/** An owner acting on a workflow from before authorization was recorded becomes its authorizer. */
function adopt(wf, ctx) {
  if (!wf.authorized_by && ctx.user?.email) {
    run('UPDATE workflows SET authorized_by = ? WHERE id = ? AND authorized_by IS NULL', ctx.user.email, wf.id);
    wf.authorized_by = ctx.user.email;
  }
}

/** A person may be given work in a project if they can contribute to it or are its member. */
function personInProject(email, project) {
  const u = withTeams(memberRow(email));
  return Boolean(u && (u.role === 'owner' || canContribute(u, project)));
}

/** Can this person see this schedule? Everyone for schedules outside projects (like tasks). */
export function canViewSchedule(user, wf) {
  if (!user || !wf) return false;
  if (user.role === 'owner' || !wf.project_id) return true;
  if ([wf.authorized_by, wf.assignee_email].includes(user.email) || (wf.created_by_type === 'user' && wf.created_by_ref === user.email)) return true;
  return canContribute(user, projectRow(wf.project_id) ?? {});
}

/**
 * Can this person change, pause, resume, cancel or run this schedule? Workspace owners; the person
 * who authorized it or created it; the project's owner. Being its assignee is not enough, and an
 * agent creating a schedule gets no standing authority over it: every change needs a person's say.
 */
export function canManageSchedule(user, wf) {
  if (!user || !wf) return false;
  if (user.role === 'owner') return true;
  if (wf.authorized_by === user.email || (wf.created_by_type === 'user' && wf.created_by_ref === user.email)) return true;
  const p = projectRow(wf.project_id);
  return Boolean(p && p.owner_email === user.email);
}

/** Why this person may not give recurring work to this assignee (in this project), or null. */
function assignmentProblem(user, { agent_id, assignee_email, project_id }) {
  if (!memberRow(user?.email)) return 'Only active members of this workspace can schedule work';
  const project = project_id ? projectRow(project_id) : null;
  if (project_id && !project) return 'Unknown project';
  if (project && project.status !== 'active') return `The project “${project.name}” is archived`;
  if (project && !(user.role === 'owner' || canContribute(user, project))) return `You can add recurring tasks only to projects you're a member of (not “${project.name}”)`;
  if (agent_id) {
    const a = agentRow(agent_id);
    if (!a) return 'Unknown agent';
    if (a.status === 'paused') return `${a.name} is paused, so it can't take recurring work. Resume it first.`;
  } else if (assignee_email) {
    const u = memberRow(assignee_email);
    if (!u) return notMember(assignee_email);
    if (project && !personInProject(u.email, project)) return `${u.name || u.email} is not a member of the project “${project.name}”`;
  } else return 'Choose who gets the task: a person or an AI agent';
  return null;
}

/** Why the next occurrence can't be delivered as authorized, or null. Checked before every occurrence. */
export function eligibilityProblem(wf, snap = wf) {
  const authorizer = authorizerOf(wf.authorized_by);
  if (!authorizer) return wf.authorized_by ? `${notMember(wf.authorized_by, 'is no longer a member of this workspace')}, so the schedule has no one authorizing it` : 'No workspace owner can authorize this older workflow';
  if (snap.agent_id) {
    const a = agentRow(snap.agent_id);
    if (!a) return 'The assigned agent was removed';
    if (a.status === 'paused') return `${a.name} is paused`;
  } else if (snap.assignee_email) {
    if (!memberRow(snap.assignee_email)) return notMember(snap.assignee_email, 'is no longer a member of this workspace');
  } else return 'The schedule has no assignee (the agent was removed)';
  if (snap.project_id) {
    const p = projectRow(snap.project_id);
    if (!p) return 'Its project was deleted';
    if (p.status !== 'active') return `The project “${p.name}” is archived`;
    if (snap.assignee_email && !personInProject(snap.assignee_email, p)) return `${userRow(snap.assignee_email)?.name || snap.assignee_email} no longer has access to the project “${p.name}”`;
    if (!(authorizer.role === 'owner' || canContribute(authorizer, p))) return `${authorizer.name || authorizer.email} no longer has access to the project “${p.name}”`;
  }
  return null;
}

// ---------------------------------------------------------------- the schedule's fields

/** "agent:3" | "user:a@b" | {type: 'agent'|'person'|'user', id|email} → columns (no permission checks). */
export function parseAssigneeRef(value) {
  if (value == null || value === '') return null;
  let v = value;
  if (typeof v === 'string') v = v.startsWith('agent:') ? { type: 'agent', id: v.slice(6) } : v.startsWith('user:') ? { type: 'user', email: v.slice(5) } : null;
  if (v?.type === 'agent') {
    const id = Number(v.id);
    if (!Number.isInteger(id) || !agentRow(id)) throw bad('Unknown agent');
    return { agent_id: id, assignee_email: null };
  }
  if (v?.type === 'user' || v?.type === 'person') {
    const email = String(v.email ?? v.id ?? '').toLowerCase();
    if (!memberRow(email)) throw bad(notMember(email));
    return { agent_id: null, assignee_email: email };
  }
  throw bad('The assignee must be a person or an AI agent');
}

const today = (tz) => localDate(Date.now(), tz);

/**
 * Validate a new schedule, or an edit merged over `current`. Returns { cols, notes } where cols are
 * the columns to store and notes say which defaults were used (for the confirmation).
 */
export function cleanSchedule(input, current = null, { now = new Date() } = {}) {
  const notes = [];
  const cur = current ? { ...current, rule: parse(current.rule), period_rule: parse(current.period_rule), deadline_rule: parse(current.deadline_rule) } : {};
  const has = (k) => input[k] !== undefined;
  const pick = (k, fallback) => (has(k) ? input[k] : cur[k] !== undefined ? cur[k] : fallback);
  try {
    const title = String(pick('title', undefined) ?? pick('name', '') ?? '').trim();
    if (!title) throw bad('A title is required');
    const instructions = String(pick('instructions', '') ?? '');
    const expected = String(pick('expected_result', '') ?? '');

    // Who gets it.
    let who;
    if (has('assignee')) who = parseAssigneeRef(input.assignee);
    else if (has('agent_id') || has('assignee_email')) who = parseAssigneeRef(input.assignee_email ? `user:${input.assignee_email}` : input.agent_id ? `agent:${input.agent_id}` : null);
    else who = current ? { agent_id: cur.agent_id, assignee_email: cur.assignee_email } : null;
    if (!who || (!who.agent_id && !who.assignee_email)) throw bad('Choose who gets the task: a person or an AI agent');
    const person = Boolean(who.assignee_email);
    const typeChanged = current && Boolean(cur.assignee_email) !== person;

    // When.
    let tz = pick('timezone', undefined);
    if (!tz) {
      tz = DEFAULT_TIMEZONE;
      notes.push(`No time zone given, so it uses the workspace default, ${DEFAULT_TIMEZONE}.`);
    }
    if (!isTimeZone(tz)) throw bad(`Unknown time zone "${tz}". Use an IANA name such as Asia/Dubai`);
    const startsOn = pick('starts_on', null) || (current ? cur.starts_on : null) || today(tz);
    if (!isDateStr(startsOn)) throw bad('The start date must be a date (YYYY-MM-DD)');
    const endsOn = pick('ends_on', null) || null;
    if (endsOn && !isDateStr(endsOn)) throw bad('The end date must be a date (YYYY-MM-DD)');
    if (endsOn && endsOn < startsOn) throw bad('The end date is before the start date');
    const maxRaw = pick('max_occurrences', null);
    const max = maxRaw === null || maxRaw === '' ? null : Number(maxRaw);
    if (max !== null && (!Number.isInteger(max) || max < 1 || max > 10000)) throw bad('The number of occurrences must be from 1 to 10000');
    let ruleInput = has('rule') ? input.rule : has('schedule') ? { freq: 'cron', expr: input.schedule } : cur.rule;
    if (!ruleInput) throw bad('A recurrence is required');
    const { rule, notes: ruleNotes } = normalizeRule(ruleInput, { startsOn });
    if (has('rule')) notes.push(...ruleNotes);

    // How.
    let mode = pick('mode', undefined);
    if (has('mode') && !MODES.includes(mode)) throw bad(`mode must be one of: ${MODES.join(', ')}`);
    if (!mode || (typeChanged && !has('mode'))) {
      mode = person ? 'create_only' : 'create_and_start';
      if (typeChanged) notes.push(`The assignee is now ${person ? 'a person' : 'an agent'}, so the mode is ${MODE_LABELS[mode].toLowerCase()}.`);
    }
    if (person && mode === 'create_and_start') throw bad('People are never started automatically: use mode create_only for a person');
    let overlap = pick('overlap_policy', undefined);
    if (has('overlap_policy') && !OVERLAP_POLICIES.includes(overlap)) throw bad(`overlap_policy must be one of: ${OVERLAP_POLICIES.join(', ')}`);
    if (!overlap || (typeChanged && !has('overlap_policy'))) overlap = person ? 'always_create' : 'skip_if_running';
    if (person && overlap === 'skip_if_running') throw bad('People have no runs to overlap: use skip_if_open or always_create');
    const missed = pick('missed_policy', 'run_latest');
    if (!MISSED_POLICIES.includes(missed)) throw bad(`missed_policy must be one of: ${MISSED_POLICIES.join(', ')}`);
    const periodRule = normalizePeriodRule(pick('period_rule', null));
    const deadlineRule = normalizeDeadlineRule(pick('deadline_rule', null), periodRule);
    for (const text of [title, instructions, expected]) checkTemplate(text, { periodRule, deadlineRule });
    const priority = pick('priority', 'medium');
    if (!PRIORITIES.includes(priority)) throw bad(`priority must be one of: ${PRIORITIES.join(', ')}`);
    const remindRaw = pick('remind_days', null);
    const remind = remindRaw === null || remindRaw === '' ? null : Number(remindRaw);
    if (remind !== null && (!Number.isInteger(remind) || remind < 0 || remind > 365)) throw bad('Remind days must be 0 to 365');
    if (remind !== null && !deadlineRule) throw bad('A reminder before the due date needs a deadline rule');
    const projectRaw = pick('project_id', null);
    const projectId = projectRaw === null || projectRaw === '' ? null : Number(projectRaw);
    if (projectId !== null && !projectRow(projectId)) throw bad('Unknown project');

    const cols = {
      name: clip(title, 200), instructions, expected_result: expected, description: clip(pick('description', '') ?? '', 500),
      agent_id: who.agent_id, assignee_email: who.assignee_email, project_id: projectId, timezone: tz, rule: JSON.stringify(rule),
      starts_on: startsOn, ends_on: endsOn, max_occurrences: max, mode, overlap_policy: overlap, missed_policy: missed,
      period_rule: periodRule ? JSON.stringify(periodRule) : null, deadline_rule: deadlineRule ? JSON.stringify(deadlineRule) : null,
      priority, needs_approval: pick('needs_approval', 0) ? 1 : 0, remind_days: remind,
      schedule: rule.freq === 'cron' ? rule.expr : '',
    };
    return { cols, notes };
  } catch (err) {
    if (err instanceof RuleError) throw bad(err.message);
    throw err;
  }
}

/** The next occurrence after `after`, honouring the end date and the occurrence limit. */
function nextAfter(cols, after, countSoFar = cols.occurrence_count ?? 0) {
  if (cols.max_occurrences && countSoFar >= cols.max_occurrences) return null;
  return occurrencesAfter(cols, after, 1)[0] ?? null;
}

// ---------------------------------------------------------------- views

const lastRunOf = (id) =>
  get(
    `SELECT r.*, t.status AS task_status, t.title AS task_title FROM workflow_runs r LEFT JOIN tasks t ON t.id = r.task_id
     WHERE r.workflow_id = ? AND r.state != 'pending' ORDER BY COALESCE(r.scheduled_for, r.started_at) DESC, r.id DESC LIMIT 1`,
    id,
  );

/** What a run looks like to people: its occurrence, dispatch, execution and task states, and one outcome. */
function runView(r) {
  const execution = r.task_id ? get("SELECT status, error FROM runs WHERE task_id = ? AND kind = 'task' ORDER BY id DESC LIMIT 1", r.task_id) : null;
  const outcome =
    r.state === 'skipped' ? 'skipped'
    : r.state === 'failed' || r.dispatch_status === 'failed' ? 'failed'
    : r.state === 'pending' ? 'pending'
    : r.task_status === 'done' ? 'done'
    : r.dispatch_status === 'retrying' ? 'retrying'
    : 'open';
  return {
    ...r, snapshot: undefined, lease_until: undefined,
    outcome,
    execution_status: execution?.status ?? null,
    execution_error: execution?.error ?? null,
  };
}

export function scheduleView(wf, user) {
  if (!wf) return null;
  const rule = parse(wf.rule);
  const period = parse(wf.period_rule);
  const deadline = parse(wf.deadline_rule);
  const agent = agentRow(wf.agent_id);
  const person = wf.assignee_email ? userRow(wf.assignee_email) : null;
  const project = projectRow(wf.project_id);
  const creator = wf.created_by_type === 'agent' ? agentRow(Number(wf.created_by_ref)) : wf.created_by_ref ? userRow(wf.created_by_ref) : null;
  const authorizer = userRow(wf.authorized_by);
  const last = lastRunOf(wf.id);
  const counts = get("SELECT COUNT(*) AS n FROM workflow_runs WHERE workflow_id = ?", wf.id);
  return {
    id: wf.id,
    title: wf.name,
    name: wf.name,
    description: wf.description,
    instructions: wf.instructions,
    expected_result: wf.expected_result,
    status: wf.status,
    status_reason: wf.status_reason,
    // Active, but the next occurrence won't be delivered as things stand (e.g. its agent is paused).
    warning: wf.status === 'active' ? eligibilityProblem(wf) : null,
    enabled: wf.status === 'active',
    assignee: agent
      ? { type: 'agent', ref: `agent:${agent.id}`, id: agent.id, name: agent.name, detail: agent.title, color: agent.color }
      : wf.assignee_email
        ? { type: 'user', ref: `user:${wf.assignee_email}`, email: wf.assignee_email, name: person?.name || wf.assignee_email }
        : null,
    agent_id: wf.agent_id,
    agent_name: agent?.name ?? null,
    agent_color: agent?.color ?? null,
    assignee_email: wf.assignee_email,
    created_by: wf.created_by_type
      ? { type: wf.created_by_type, ref: wf.created_by_ref, name: wf.created_by_name || (wf.created_by_type === 'agent' ? creator?.name : creator?.name || wf.created_by_ref) }
      : null,
    authorized_by: wf.authorized_by ? { email: wf.authorized_by, name: authorizer?.name || wf.authorized_by } : null,
    project: project ? { id: project.id, name: project.name, color: project.color } : null,
    project_id: wf.project_id,
    rule,
    recurrence: describeRule(rule),
    timezone: wf.timezone,
    starts_on: wf.starts_on,
    ends_on: wf.ends_on,
    max_occurrences: wf.max_occurrences,
    occurrence_count: wf.occurrence_count,
    mode: wf.mode,
    mode_label: wf.assignee_email ? 'Create and assign the task (people are never started automatically)' : MODE_LABELS[wf.mode],
    period_rule: period,
    period_label: describePeriodRule(period),
    deadline_rule: deadline,
    deadline_label: describeDeadlineRule(deadline),
    missed_policy: wf.missed_policy,
    missed_label: MISSED_LABELS[wf.missed_policy],
    overlap_policy: wf.overlap_policy,
    overlap_label: OVERLAP_LABELS[wf.overlap_policy],
    priority: wf.priority,
    needs_approval: Boolean(wf.needs_approval),
    remind_days: wf.remind_days,
    next_run_at: wf.status === 'active' ? wf.next_run_at : null,
    next_run_local: wf.status === 'active' && wf.next_run_at ? formatLocal(wf.next_run_at, wf.timezone) : null,
    last_run: last ? runView(last) : null,
    last_status: last ? runView(last).outcome : null,
    last_run_at: wf.last_run_at,
    run_count: counts.n,
    version: wf.version,
    schedule: wf.schedule,
    created_at: wf.created_at,
    updated_at: wf.updated_at,
    manage_url: manageUrl(wf.id),
    ...(user ? { can_manage: canManageSchedule(user, wf) } : {}),
  };
}

const row = (id) => get('SELECT * FROM workflows WHERE id = ?', Number(id));

/** A schedule for someone who may see it (404 otherwise, so ids don't leak). */
export function scheduleFor(id, user) {
  const wf = row(id);
  if (!wf || !canViewSchedule(user, wf)) throw notFound('Recurring task');
  return wf;
}

export function upcoming(wf, count = 5, now = new Date()) {
  if (wf.status !== 'active' || !wf.next_run_at) return [];
  const list = [new Date(wf.next_run_at), ...occurrencesAfter(wf, new Date(wf.next_run_at), count - 1)];
  const left = wf.max_occurrences ? wf.max_occurrences - wf.occurrence_count : Infinity;
  const period = parse(wf.period_rule);
  const deadline = parse(wf.deadline_rule);
  return list.slice(0, Math.max(0, Math.min(count, left))).filter((d) => d >= new Date(now.getTime() - LATE_AFTER_MS)).map((d) => {
    const onDate = localDate(d, wf.timezone);
    const p = resolvePeriod(period, onDate);
    return { at: iso(d), local: formatLocal(d, wf.timezone), period: p, due_date: resolveDeadline(deadline, onDate, p) };
  });
}

export function scheduleDetails(id, user, now = new Date()) {
  const wf = scheduleFor(id, user);
  const runs = all(
    `SELECT r.*, t.status AS task_status, t.title AS task_title FROM workflow_runs r LEFT JOIN tasks t ON t.id = r.task_id
     WHERE r.workflow_id = ? ORDER BY COALESCE(r.scheduled_for, r.started_at) DESC, r.id DESC LIMIT 50`,
    wf.id,
  ).map(runView);
  const events = all('SELECT actor, kind, text, created_at FROM schedule_events WHERE workflow_id = ? ORDER BY id DESC LIMIT 50', wf.id);
  return { ...scheduleView(wf, user), upcoming: upcoming(wf, 5, now), runs, events };
}

/**
 * Schedules this person may see. Filters: agent_id (assigned to or created by that agent),
 * assignee / created_by ("me", "user:email", "agent:id"), project_id, status.
 */
export function listSchedules(f = {}, user) {
  const where = [];
  const params = [];
  const add = (sql, ...p) => (where.push(sql), params.push(...p));
  const ref = (v) => (v === 'me' ? `user:${user?.email}` : String(v));
  if (f.agent_id) add("(w.agent_id = ? OR (w.created_by_type = 'agent' AND w.created_by_ref = ?))", Number(f.agent_id), String(Number(f.agent_id)));
  if (f.assignee) {
    const r = ref(f.assignee);
    if (r.startsWith('agent:')) add('w.agent_id = ?', Number(r.slice(6)));
    else add('w.assignee_email = ?', r.replace(/^user:/, '').toLowerCase());
  }
  if (f.created_by) {
    const r = ref(f.created_by);
    if (r.startsWith('agent:')) add("w.created_by_type = 'agent' AND w.created_by_ref = ?", r.slice(6));
    else add("((w.created_by_type = 'user' AND w.created_by_ref = ?) OR w.authorized_by = ?)", r.replace(/^user:/, '').toLowerCase(), r.replace(/^user:/, '').toLowerCase());
  }
  if (f.project_id) add('w.project_id = ?', Number(f.project_id));
  if (f.status) add('w.status = ?', f.status);
  return all(`SELECT w.* FROM workflows w ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE w.status WHEN 'error' THEN 0 WHEN 'active' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, w.name COLLATE NOCASE`, ...params)
    .filter((wf) => (f.visible ? f.visible(wf) : canViewSchedule(user, wf)))
    .map((wf) => scheduleView(wf, user));
}

// ---------------------------------------------------------------- creating and changing

/**
 * ctx: { actor: { type: 'user'|'agent', ref, name }, user (the authorizing person, a users row with
 * role), via: 'ui' | 'chat' | 'slack' | 'task', provenance: {…} }. Returns { schedule, notes, existing }.
 */
export function createSchedule(input, ctx, { now = new Date(), dedupe = false } = {}) {
  if (!ctx?.user?.email || !memberRow(ctx.user.email)) throw forbidden('Only an active member of this workspace can authorize a recurring task');
  if (input.client_key) {
    const existing = get('SELECT * FROM workflows WHERE client_key = ?', String(input.client_key));
    if (existing) return { schedule: scheduleView(existing, ctx.user), notes: [], existing: true };
  }
  const { cols, notes } = cleanSchedule(input, null, { now });
  const problem = assignmentProblem(ctx.user, cols);
  if (problem) throw forbidden(problem);
  if (dedupe) {
    // The same request twice (a repeated tool call) finds the first schedule instead of making a copy.
    const same = get(
      `SELECT * FROM workflows WHERE status IN ('active', 'paused', 'error') AND lower(name) = lower(?) AND rule = ? AND timezone = ?
         AND COALESCE(agent_id, 0) = COALESCE(?, 0) AND COALESCE(assignee_email, '') = COALESCE(?, '')`,
      cols.name, cols.rule, cols.timezone, cols.agent_id, cols.assignee_email,
    );
    if (same) return { schedule: scheduleView(same, ctx.user), notes: ['This recurring task already existed, so no new one was created.'], existing: true };
  }
  const first = nextAfter(cols, now, 0);
  if (!first) throw bad('This schedule would never run: its end date or occurrence limit leaves no future occurrence');
  if (cols.starts_on < localDate(now, cols.timezone)) notes.push(`The start date ${formatDate(cols.starts_on)} is in the past; nothing is backdated, the first run is ${formatLocal(first, cols.timezone)}.`);
  const id = tx(() => {
    const keys = Object.keys(cols);
    const res = run(
      `INSERT INTO workflows (${keys.join(', ')}, enabled, status, next_run_at, occurrence_count, created_by_type, created_by_ref, created_by_name, authorized_by, authorization, client_key, updated_at)
       VALUES (${keys.map(() => '?').join(', ')}, 1, 'active', ?, 0, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ...keys.map((k) => cols[k]),
      iso(first), ctx.actor.type, String(ctx.actor.ref), ctx.actor.name, ctx.user.email,
      JSON.stringify({ via: ctx.via ?? 'ui', at: iso(now), ...(ctx.provenance ?? {}) }),
      input.client_key ? clip(input.client_key, 120) : null,
    );
    const newId = Number(res.lastInsertRowid);
    event(newId, ctx.actor, 'created', `Created${ctx.actor.type === 'agent' ? ` by ${ctx.actor.name} at ${ctx.user.name || ctx.user.email}'s request` : ''}: ${describeRule(parse(cols.rule))} (${cols.timezone})`, { via: ctx.via, ...(ctx.provenance ?? {}) });
    return newId;
  });
  const wf = row(id);
  logActivity(wf.agent_id, 'workflow', `${ctx.actor.name} scheduled “${wf.name}”: ${describeRule(parse(wf.rule))}`);
  emit('workflow', { workflow_id: id });
  return { schedule: scheduleView(wf, ctx.user), notes, existing: false };
}

/** Edit a schedule. Applies to future occurrences only; history and created tasks keep what they had. */
export function updateSchedule(id, input, ctx, { now = new Date() } = {}) {
  const current = scheduleFor(id, ctx.user);
  if (!canManageSchedule(ctx.user, current)) throw forbidden("You can't change this recurring task. Ask the person who set it up, or a workspace owner.");
  adopt(current, ctx);
  if (current.status === 'ended') throw bad('This recurring task has ended. Create a new one instead.');
  const { cols, notes } = cleanSchedule(input, current, { now });
  const reassigned = cols.agent_id !== current.agent_id || cols.assignee_email !== current.assignee_email || cols.project_id !== current.project_id;
  if (reassigned) {
    const problem = assignmentProblem(ctx.user, cols);
    if (problem) throw forbidden(problem);
  }
  const changed = Object.keys(cols).filter((k) => String(cols[k] ?? '') !== String(current[k] ?? ''));
  if (!changed.length) return { schedule: scheduleView(current, ctx.user), notes: ['Nothing changed.'] };
  const whenChanged = changed.some((k) => ['rule', 'timezone', 'starts_on', 'ends_on', 'max_occurrences'].includes(k));
  tx(() => {
    const fresh = row(id); // re-read inside the write lock: a tick may have moved it on
    const merged = { ...fresh, ...cols };
    const next = fresh.status === 'active' ? (whenChanged ? nextAfter(merged, now) : fresh.next_run_at ? new Date(fresh.next_run_at) : nextAfter(merged, now)) : null;
    if (fresh.status === 'active' && !next) throw bad('After this change the schedule would never run again');
    const keys = Object.keys(cols);
    run(
      `UPDATE workflows SET ${keys.map((k) => `${k} = ?`).join(', ')}, version = version + 1, updated_at = datetime('now'),
         next_run_at = ?, authorized_by = ?, authorization = ? WHERE id = ?`,
      ...keys.map((k) => cols[k]),
      next ? iso(next) : fresh.next_run_at,
      // A new assignee or project is authorized by whoever made that change.
      reassigned ? ctx.user.email : fresh.authorized_by,
      reassigned ? JSON.stringify({ via: ctx.via ?? 'ui', at: iso(now), ...(ctx.provenance ?? {}) }) : fresh.authorization,
      id,
    );
    const who = cols.agent_id ? agentRow(cols.agent_id)?.name : userRow(cols.assignee_email)?.name || cols.assignee_email;
    event(id, ctx.actor, reassigned ? 'reassigned' : 'edited', reassigned ? `Future occurrences go to ${who}${changed.includes('project_id') ? ' (project changed)' : ''}` : `Changed ${changed.join(', ')}`, { changed, ...(ctx.provenance ?? {}) });
  });
  emit('workflow', { workflow_id: Number(id) });
  return { schedule: scheduleView(row(id), ctx.user), notes };
}

function setStatus(id, ctx, { from, to, reason, verb, now = new Date() }) {
  const current = scheduleFor(id, ctx.user);
  if (!canManageSchedule(ctx.user, current)) throw forbidden(`You can't ${verb} this recurring task. Ask the person who set it up, or a workspace owner.`);
  if (to === 'active') adopt(current, ctx);
  if (!from.includes(current.status)) {
    if (current.status === to) return scheduleView(current, ctx.user);
    throw conflict(`This recurring task is ${current.status}, so it can't be ${verb === 'cancel' ? 'cancelled' : `${verb}d`}`);
  }
  tx(() => {
    let next = null;
    if (to === 'active') {
      const problem = eligibilityProblem(current);
      if (problem) throw conflict(`Can't resume yet: ${problem}`);
      next = nextAfter(current, now); // nothing missed while paused is caught up
      if (!next) throw conflict('There are no future occurrences left to resume');
    }
    run(
      `UPDATE workflows SET status = ?, enabled = ?, status_reason = ?, next_run_at = ?, version = version + 1, updated_at = datetime('now')${to === 'ended' ? ", ended_at = datetime('now')" : ''} WHERE id = ?`,
      to, to === 'active' ? 1 : 0, reason ?? null, next ? iso(next) : null, current.id,
    );
    event(current.id, ctx.actor, verb, `${verb === 'cancel' ? 'Cancelled' : verb === 'pause' ? 'Paused' : 'Resumed'} by ${ctx.actor.name}${next ? `; next run ${formatLocal(next, current.timezone)}` : ''}`, ctx.provenance);
  });
  emit('workflow', { workflow_id: current.id });
  return scheduleView(row(current.id), ctx.user);
}

export const pauseSchedule = (id, ctx, o = {}) => setStatus(id, ctx, { from: ['active', 'error'], to: 'paused', reason: `Paused by ${ctx.actor.name}`, verb: 'pause', ...o });
export const resumeSchedule = (id, ctx, o = {}) => setStatus(id, ctx, { from: ['paused', 'error'], to: 'active', verb: 'resume', ...o });
/** Cancel future occurrences. Tasks already created (even running ones) and the history stay. */
export const cancelSchedule = (id, ctx, o = {}) => setStatus(id, ctx, { from: ['active', 'paused', 'error'], to: 'ended', reason: `Cancelled by ${ctx.actor.name}`, verb: 'cancel', ...o });

/** Suspend delivery (the assignee or authorization became invalid). Someone must resume it. */
function suspend(wf, reason) {
  const changed = run("UPDATE workflows SET status = 'error', enabled = 0, status_reason = ?, next_run_at = NULL, version = version + 1, updated_at = datetime('now') WHERE id = ? AND status = 'active'", reason, wf.id).changes;
  if (!changed) return;
  event(wf.id, 'Hive', 'suspended', `Suspended: ${reason}`);
  logActivity(wf.agent_id, 'error', `Recurring task “${wf.name}” suspended: ${reason}`);
  notifyWorkflowFailed(wf.name, `Suspended: ${reason}`, null);
  if (userRow(wf.authorized_by)) notifyUser(wf.authorized_by, { title: 'Recurring task suspended', text: `“${wf.name}” is suspended: ${reason}. Fix it, then resume it: ${manageUrl(wf.id)}` });
  emit('workflow', { workflow_id: wf.id });
}

/** A person's access is turned off: suspend what's assigned to them or authorized by them, with the reason. */
export function suspendSchedulesForPerson(email) {
  const e = String(email ?? '').toLowerCase();
  for (const wf of all("SELECT * FROM workflows WHERE (assignee_email = ? OR authorized_by = ?) AND status = 'active'", e, e)) suspend(wf, eligibilityProblem(wf) ?? `${e}'s access to Hive is turned off`);
}

/** An agent is going away: suspend what's assigned to it now, so the reason is visible (never reassigned). */
export function suspendSchedulesFor(agentId, reason) {
  for (const wf of all("SELECT * FROM workflows WHERE agent_id = ? AND status = 'active'", agentId)) suspend(wf, reason);
}

// ---------------------------------------------------------------- occurrences

function snapshotOf(wf) {
  const keys = ['name', 'instructions', 'expected_result', 'agent_id', 'assignee_email', 'project_id', 'mode', 'priority', 'needs_approval', 'remind_days', 'timezone', 'period_rule', 'deadline_rule', 'overlap_policy', 'authorized_by', 'created_by_name', 'version'];
  return Object.fromEntries(keys.map((k) => [k, wf[k]]));
}

/** Add an occurrence row (once per key). Its period and due date are fixed now and kept for retries. */
function addOccurrence(wf, at, { trigger, state = 'pending', reason = null, key, requestedBy = null }) {
  const onDate = localDate(at, wf.timezone);
  const period = resolvePeriod(parse(wf.period_rule), onDate);
  const due = resolveDeadline(parse(wf.deadline_rule), onDate, period);
  return run(
    `INSERT OR IGNORE INTO workflow_runs (workflow_id, trigger, status, state, skip_reason, scheduled_for, occurrence_key, period_start, period_end, due_date,
       schedule_version, snapshot, dispatch_status, started_at, requested_by, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', datetime('now'), ?, CASE WHEN ? = 'skipped' THEN datetime('now') END)`,
    wf.id, trigger, state === 'skipped' ? 'skipped' : 'running', state, reason, iso(at), key ?? `${wf.id}:${iso(at)}`, period?.start ?? null, period?.end ?? null, due,
    wf.version, JSON.stringify(snapshotOf(wf)), requestedBy, state,
  ).changes;
}

/**
 * Claim every due schedule and record its occurrences. One write transaction per schedule with a
 * compare-and-set on next_run_at, so concurrent workers never claim the same occurrence twice.
 */
export function claimDue(now = new Date()) {
  const due = all("SELECT id, next_run_at FROM workflows WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?", iso(now));
  let claimed = 0;
  for (const { id, next_run_at } of due) {
    tx(() => {
      const wf = row(id);
      if (!wf || wf.status !== 'active' || wf.next_run_at !== next_run_at) return; // someone else got it
      const first = new Date(wf.next_run_at);
      let slots = [first, ...occurrencesBetween(wf, first, now)];
      if (wf.max_occurrences) slots = slots.slice(0, Math.max(0, wf.max_occurrences - wf.occurrence_count));
      const latest = slots.at(-1);
      const late = latest && now - latest > LATE_AFTER_MS;
      const skipped = wf.missed_policy === 'skip_all' && late ? slots : slots.slice(0, -1);
      skipped.slice(-MAX_SKIPPED_ROWS).forEach((at, i, arr) => {
        const more = i === 0 && skipped.length > arr.length ? ` (and ${skipped.length - arr.length} earlier)` : '';
        addOccurrence(wf, at, { trigger: 'schedule', state: 'skipped', reason: `Missed while Hive was not running${more}; ${wf.missed_policy === 'skip_all' ? 'missed runs are skipped' : 'only the latest missed run is created'}` });
      });
      if (latest && !(wf.missed_policy === 'skip_all' && late)) addOccurrence(wf, latest, { trigger: late ? 'catchup' : 'schedule' });
      const count = wf.occurrence_count + slots.length;
      const next = nextAfter({ ...wf, occurrence_count: count }, now, count);
      const reason = next ? null : wf.max_occurrences && count >= wf.max_occurrences ? `Finished all ${wf.max_occurrences} occurrences` : 'Reached its end date';
      run(
        `UPDATE workflows SET next_run_at = ?, occurrence_count = ?, last_run_at = datetime('now'), status = ?, enabled = ?, status_reason = COALESCE(?, status_reason),
           ended_at = CASE WHEN ? = 'ended' THEN datetime('now') ELSE ended_at END WHERE id = ? AND next_run_at = ?`,
        next ? iso(next) : null, count, next ? 'active' : 'ended', next ? 1 : 0, reason, next ? 'active' : 'ended', wf.id, next_run_at,
      );
      if (!next) event(wf.id, 'Hive', 'ended', reason);
      claimed += slots.length;
    });
  }
  return claimed;
}

const hasActiveRun = (taskId) => get("SELECT id FROM runs WHERE task_id = ? AND status IN ('starting', 'running', 'needs_approval')", taskId);

/** Why this occurrence should be skipped because the previous one isn't finished, or null. */
function overlapProblem(occ, snap) {
  if (snap.overlap_policy === 'always_create') return null;
  const prev = get(
    `SELECT r.dispatch_status, t.id, t.status FROM workflow_runs r JOIN tasks t ON t.id = r.task_id
     WHERE r.workflow_id = ? AND r.id != ? AND r.state = 'created' ORDER BY r.id DESC LIMIT 1`,
    occ.workflow_id, occ.id,
  );
  if (!prev || prev.status === 'done') return null;
  if (snap.overlap_policy === 'skip_if_open') return `The previous task (#${prev.id}) is still open`;
  if (hasActiveRun(prev.id) || prev.status === 'in_progress' || ['pending', 'retrying'].includes(prev.dispatch_status)) return `The previous run (task #${prev.id}) is still in progress`;
  return null;
}

function taskBody(occ, snap) {
  const tz = snap.timezone;
  const onDate = localDate(occ.scheduled_for, tz);
  const period = occ.period_start ? { start: occ.period_start, end: occ.period_end, label: periodLabel(occ.period_start, occ.period_end) } : null;
  const vars = {
    scheduled_date: formatDate(onDate),
    due_date: occ.due_date ? formatDate(occ.due_date) : null,
    period_start: period ? formatDate(period.start) : null,
    period_end: period ? formatDate(period.end) : null,
    period_label: period?.label ?? null,
  };
  const title = fillTemplate(snap.name, vars);
  const lines = [
    fillTemplate(snap.instructions, vars).trim(),
    '',
    period ? `Reporting period: ${period.label} (${period.start} to ${period.end}). Use data for this period only.` : '',
    `Scheduled for: ${formatLocal(occ.scheduled_for, tz)} (${tz})${occ.trigger === 'manual' ? ', run manually' : occ.trigger === 'catchup' ? ', created late because Hive was offline when it was due' : ''}.`,
    occ.due_date ? `Due: ${formatDate(occ.due_date)}.` : '',
    `Recurring task #${occ.workflow_id}, set up by ${snap.created_by_name || 'someone'}. Manage it: ${manageUrl(occ.workflow_id)}`,
  ];
  return {
    title: /\{\{/.test(snap.name) ? title : `${title} — ${period?.label ?? formatDate(onDate)}`,
    description: lines.filter((l, i) => l || (i > 0 && lines[i - 1])).join('\n').trim(),
    done_definition: fillTemplate(snap.expected_result, vars),
  };
}
/** Create the occurrence's task (once), in the same transaction that marks the occurrence created. */
function createOccurrenceTask(occ, snap) {
  const authorizer = authorizerOf(snap.authorized_by);
  const actor = { ...personActor(authorizer), name: `${snap.created_by_name || authorizer.name || authorizer.email} (recurring)` };
  const body = taskBody(occ, snap);
  return tx(() => {
    const { id } = createTask(
      {
        ...body,
        priority: snap.priority,
        assignee: snap.agent_id ? { type: 'agent', id: snap.agent_id } : { type: 'user', email: snap.assignee_email },
        due_date: occ.due_date,
        remind_days: occ.due_date ? snap.remind_days : null,
        needs_approval: snap.needs_approval,
        project_id: snap.project_id,
        client_key: `occ:${occ.occurrence_key}`.slice(0, 80),
      },
      actor,
    );
    run('UPDATE tasks SET workflow_id = ?, occurrence_id = ?, scheduled_for = ?, period_start = ?, period_end = ? WHERE id = ?', occ.workflow_id, occ.id, occ.scheduled_for, occ.period_start, occ.period_end, id);
    const start = snap.agent_id && snap.mode === 'create_and_start';
    run("UPDATE workflow_runs SET state = 'created', task_id = ?, dispatch_status = ?, next_attempt_at = NULL WHERE id = ?", id, start ? 'pending' : 'none', occ.id);
    // Assigning yourself sends no notice for one-off tasks; a recurring one is exactly the reminder you asked for.
    if (snap.assignee_email && snap.assignee_email === snap.authorized_by) notifyUser(snap.assignee_email, { taskId: id, title: 'Recurring task', text: `“${body.title}” is ready for you.` });
    return id;
  });
}

const PERMANENT = /paused|budget|not set|not a claude|assign an ai|not found|is done/i;

/**
 * Deliver one occurrence: check eligibility and overlap, create its task, and start the agent if the
 * mode says so. Leased, so two workers never deliver the same occurrence at once; safe to repeat.
 */
export async function deliverOccurrence(occId, now = new Date()) {
  const leased = run(
    "UPDATE workflow_runs SET lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ?) AND (state = 'pending' OR (state = 'created' AND dispatch_status IN ('pending', 'retrying')))",
    iso(new Date(now.getTime() + LEASE_MS)), occId, iso(now),
  ).changes;
  if (!leased) return null;
  try {
    let occ = get('SELECT * FROM workflow_runs WHERE id = ?', occId);
    const wf = row(occ.workflow_id);
    const snap = { ...parse(occ.snapshot), authorized_by: wf?.authorized_by ?? parse(occ.snapshot)?.authorized_by };
    if (occ.state === 'pending') {
      const problem = !wf ? 'The schedule was deleted' : eligibilityProblem(wf, snap);
      if (problem) {
        run("UPDATE workflow_runs SET state = 'skipped', status = 'skipped', skip_reason = ?, finished_at = datetime('now') WHERE id = ?", `Not delivered: ${problem}`, occ.id);
        if (wf && occ.trigger !== 'manual') suspend(wf, problem);
        emit('workflow', { workflow_id: occ.workflow_id });
        return { skipped: problem };
      }
      const overlap = overlapProblem(occ, snap);
      if (overlap) {
        run("UPDATE workflow_runs SET state = 'skipped', status = 'skipped', skip_reason = ?, finished_at = datetime('now') WHERE id = ?", `${overlap} (${OVERLAP_LABELS[snap.overlap_policy].toLowerCase()})`, occ.id);
        event(occ.workflow_id, 'Hive', 'skipped', `Skipped ${formatLocal(occ.scheduled_for, snap.timezone)}: ${overlap}`);
        emit('workflow', { workflow_id: occ.workflow_id });
        return { skipped: overlap };
      }
      try {
        createOccurrenceTask(occ, snap);
      } catch (err) {
        run("UPDATE workflow_runs SET state = 'failed', status = 'failed', last_error = ?, output = ?, finished_at = datetime('now') WHERE id = ?", err.message, `Could not create the task: ${err.message}`, occ.id);
        event(occ.workflow_id, 'Hive', 'failed', `Could not create the task for ${formatLocal(occ.scheduled_for, snap.timezone)}: ${err.message}`);
        notifyWorkflowFailed(snap.name, `Could not create the task: ${err.message}`, null);
        emit('workflow', { workflow_id: occ.workflow_id });
        return { failed: err.message };
      }
      logActivity(snap.agent_id, 'workflow', `Recurring task “${snap.name}” created its task for ${formatLocal(occ.scheduled_for, snap.timezone)}`);
      occ = get('SELECT * FROM workflow_runs WHERE id = ?', occId);
    }
    if (['pending', 'retrying'].includes(occ.dispatch_status) && (!occ.next_attempt_at || occ.next_attempt_at <= iso(now))) {
      const task = get('SELECT * FROM tasks WHERE id = ?', occ.task_id);
      const agent = task && agentRow(task.agent_id);
      // Same rules as any task: the assignee's own runtime, tools and approval settings.
      const result = !task
        ? { ok: false, error: 'The task was deleted' }
        : !agent || agent.id !== snap.agent_id
          ? { ok: false, error: 'The task is no longer assigned to this agent' }
          : await startExecution(task.id, { key: `occ-${occ.id}`, actor: { type: 'user', ref: snap.authorized_by, name: `Recurring task #${occ.workflow_id}` } });
      if (result.ok) {
        run("UPDATE workflow_runs SET dispatch_status = 'dispatched', last_error = NULL, next_attempt_at = NULL WHERE id = ?", occ.id);
      } else {
        const attempts = occ.attempts + 1;
        const permanent = PERMANENT.test(result.error ?? '') || attempts > RETRY_MINUTES.length;
        if (permanent) {
          run("UPDATE workflow_runs SET dispatch_status = 'failed', attempts = ?, last_error = ?, status = 'failed', output = ?, finished_at = datetime('now') WHERE id = ?", attempts, result.error, `Could not start: ${result.error}`, occ.id);
          event(occ.workflow_id, 'Hive', 'dispatch_failed', `Task #${occ.task_id} could not start after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${result.error}`);
          notifyWorkflowFailed(snap.name, `Could not start: ${result.error}`, occ.task_id);
          if (userRow(snap.authorized_by)) notifyUser(snap.authorized_by, { taskId: occ.task_id, title: 'Recurring task could not start', text: `“${snap.name}” created task #${occ.task_id} but couldn't start it: ${result.error}` });
        } else {
          const retryAt = new Date(now.getTime() + RETRY_MINUTES[attempts - 1] * 60000);
          run("UPDATE workflow_runs SET dispatch_status = 'retrying', attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?", attempts, result.error, iso(retryAt), occ.id);
          event(occ.workflow_id, 'Hive', 'dispatch_retry', `Task #${occ.task_id} could not start (${result.error}); retrying ${formatLocal(retryAt, snap.timezone)}`);
        }
      }
    }
    emit('workflow', { workflow_id: occ.workflow_id });
    return get('SELECT * FROM workflow_runs WHERE id = ?', occId);
  } finally {
    run('UPDATE workflow_runs SET lease_until = NULL WHERE id = ?', occId);
  }
}

/** Deliver everything that's waiting: new occurrences and starts due for a retry. */
export async function deliverPending(now = new Date()) {
  const ids = all(
    `SELECT id FROM workflow_runs WHERE state = 'pending' OR (state = 'created' AND dispatch_status IN ('pending', 'retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
     ORDER BY scheduled_for, id`,
    iso(now),
  ).map((r) => r.id);
  const out = [];
  for (const id of ids) {
    try {
      const r = await deliverOccurrence(id, now);
      if (r) out.push(id);
    } catch (err) {
      console.error(`[schedules] occurrence ${id}:`, err.message);
    }
  }
  return out;
}

/** One scheduler pass: claim what's due, then deliver it. */
export async function tickSchedules(now = new Date()) {
  const claimed = claimDue(now);
  const delivered = await deliverPending(now);
  return { claimed, delivered };
}

/** "Run now": an extra, manual occurrence. The regular schedule and its count are not touched. */
export async function runNow(id, ctx, { key, now = new Date() } = {}) {
  const wf = scheduleFor(id, ctx.user);
  if (!canManageSchedule(ctx.user, wf)) throw forbidden("You can't run this recurring task. Ask the person who set it up, or a workspace owner.");
  if (wf.status === 'ended') throw conflict('This recurring task has ended');
  adopt(wf, ctx);
  const problem = eligibilityProblem(wf);
  if (problem) throw conflict(`Can't run it: ${problem}`);
  const occKey = `${wf.id}:manual:${key ? clip(key, 60) : now.getTime()}`;
  tx(() => {
    addOccurrence(wf, now, { trigger: 'manual', key: occKey, requestedBy: ctx.user.email });
    event(wf.id, ctx.actor, 'run_now', `Run now by ${ctx.actor.name}`);
  });
  const occ = get('SELECT * FROM workflow_runs WHERE occurrence_key = ?', occKey);
  await deliverOccurrence(occ.id, now);
  emit('workflow', { workflow_id: wf.id });
  return runView(get('SELECT r.*, t.status AS task_status, t.title AS task_title FROM workflow_runs r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.id = ?', occ.id));
}

/** Preview a rule without saving it: its words and next occurrences. */
export function previewSchedule(input, now = new Date()) {
  const tz = input.timezone || DEFAULT_TIMEZONE;
  if (!isTimeZone(tz)) throw bad(`Unknown time zone "${tz}"`);
  const startsOn = input.starts_on || localDate(now, tz);
  try {
    const { rule, notes } = normalizeRule(input.rule ?? (input.schedule ? { freq: 'cron', expr: input.schedule } : null), { startsOn });
    const s = { rule, timezone: tz, starts_on: startsOn, ends_on: input.ends_on || null };
    const period = normalizePeriodRule(input.period_rule ?? null);
    const deadline = normalizeDeadlineRule(input.deadline_rule ?? null, period);
    const next = occurrencesAfter(s, now, Math.min(Number(input.count) || 5, 12)).slice(0, input.max_occurrences ? Number(input.max_occurrences) : undefined);
    return {
      ok: true,
      recurrence: describeRule(rule),
      notes,
      timezone: tz,
      next: next.map((d) => {
        const onDate = localDate(d, tz);
        const p = resolvePeriod(period, onDate);
        return { at: iso(d), local: formatLocal(d, tz), period: p, due_date: resolveDeadline(deadline, onDate, p) };
      }),
    };
  } catch (err) {
    if (err instanceof RuleError) return { ok: false, error: err.message };
    throw err;
  }
}

// ---------------------------------------------------------------- the ticker

let job;
/** Every minute (and once now). Set HIVE_SCHEDULER=off on a process that shouldn't run schedules. */
export function startScheduleTicker() {
  job?.stop();
  if (process.env.HIVE_SCHEDULER === 'off') return console.log('[schedules] ticker disabled (HIVE_SCHEDULER=off)');
  const tick = () => tickSchedules().catch((err) => console.error('[schedules]', err.message));
  job = new Cron('* * * * *', { protect: true }, tick);
  setTimeout(tick, 2000); // catch up on anything missed while Hive was down
}
export const stopScheduleTicker = () => job?.stop();
