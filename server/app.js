import express from 'express';
import { DATA_DIR, all, get, run, update, newToken } from './db.js';
import { emit, subscribe } from './events.js';
import { logActivity } from './activity.js';
import { claudeConfigured, dispatchTask, postMessage, sendToAgent } from './dispatch.js';
import { integrationList, skillLibrary } from './capabilities.js';
import { confirmTool, interruptRun, managedReady, replyToRun, runWithEvents, startTaskRun, syncAgent } from './managed.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { finishRun, nextRuns, runWorkflow, schedule, unschedule, validateSchedule } from './scheduler.js';

const PLATFORMS = ['managed', 'claude', 'make', 'replit', 'n8n', 'custom', 'human'];
const APPROVALS = ['agent_asks', 'every_command'];
const AGENT_STATUSES = ['active', 'idle', 'paused', 'error'];
const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done', 'blocked'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const RUN_STATUSES = ['running', 'success', 'failed'];

const AGENT_FIELDS = ['name', 'title', 'team_id', 'description', 'platform', 'status', 'model', 'system_prompt', 'webhook_url', 'color', 'skills', 'integrations', 'approval'];
const TASK_FIELDS = ['title', 'description', 'status', 'priority', 'agent_id', 'due_date', 'result'];
const TEAM_FIELDS = ['name', 'description', 'color'];
const WORKFLOW_FIELDS = ['name', 'description', 'agent_id', 'schedule', 'timezone', 'instructions', 'enabled'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);
const notFound = (what) => new HttpError(404, `${what} not found`);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((data) => data !== undefined && res.json(data), next);

function check(value, allowed, field) {
  if (value !== undefined && !allowed.includes(value)) throw bad(`${field} must be one of: ${allowed.join(', ')}`);
}

// ---------- serializers ----------
const publicAgent = ({ api_token, ...a }) => a;
const withNext = (wf) => ({ ...wf, enabled: Boolean(wf.enabled), next_run_at: wf.enabled ? nextRuns(wf.schedule, wf.timezone)[0] ?? null : null });

function getTask(id) {
  return get(
    `SELECT t.*, a.name AS agent_name, a.color AS agent_color, a.platform AS agent_platform, w.name AS workflow_name
     FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id LEFT JOIN workflows w ON w.id = t.workflow_id WHERE t.id = ?`,
    id,
  );
}

/** Shared by the dashboard and the Agent API: apply a patch to a task, with side effects. */
function patchTask(id, patch, actor) {
  const before = get('SELECT * FROM tasks WHERE id = ?', id);
  if (!before) throw notFound('Task');
  check(patch.status, TASK_STATUSES, 'status');
  check(patch.priority, PRIORITIES, 'priority');
  if (patch.agent_id !== undefined && patch.agent_id !== null && !get('SELECT id FROM agents WHERE id = ?', patch.agent_id)) throw bad('Unknown agent_id');
  update('tasks', id, patch, TASK_FIELDS);
  run("UPDATE tasks SET updated_at = datetime('now') WHERE id = ?", id);

  if (patch.status && patch.status !== before.status) {
    run(`UPDATE tasks SET completed_at = ${patch.status === 'done' ? "datetime('now')" : 'NULL'} WHERE id = ?`, id);
    logActivity(before.agent_id, 'task', `${actor} moved "${before.title}" to ${patch.status.replace('_', ' ')}`);
    // A workflow run is complete once its task is.
    const openRun = get("SELECT id FROM workflow_runs WHERE task_id = ? AND status = 'running'", id);
    if (openRun && patch.status === 'done') finishRun(openRun.id, 'success', patch.result ?? before.result);
    if (openRun && patch.status === 'blocked') finishRun(openRun.id, 'failed', patch.result ?? 'Task blocked');
  }
  emit('task', { task_id: id });
  return getTask(id);
}

function createTask(body, actor) {
  if (!body.title?.trim()) throw bad('title is required');
  check(body.status, TASK_STATUSES, 'status');
  check(body.priority, PRIORITIES, 'priority');
  const { lastInsertRowid } = run(
    'INSERT INTO tasks (title, description, status, priority, agent_id, due_date) VALUES (?, ?, ?, ?, ?, ?)',
    body.title.trim(),
    body.description ?? '',
    body.status ?? 'todo',
    body.priority ?? 'medium',
    body.agent_id ?? null,
    body.due_date ?? null,
  );
  const id = Number(lastInsertRowid);
  logActivity(body.agent_id, 'task', `${actor} created task "${body.title.trim()}"`);
  emit('task', { task_id: id });
  return id;
}

// ---------- dashboard API ----------
export function dashboardRouter() {
  const r = express.Router();

  r.get('/events', subscribe);
  r.get('/meta', (req, res) => res.json({ claude: claudeConfigured(), platforms: PLATFORMS, taskStatuses: TASK_STATUSES, priorities: PRIORITIES }));

  r.get('/overview', wrap(() => {
    const count = (sql, ...p) => get(sql, ...p).n;
    const workflows = all('SELECT w.*, a.name AS agent_name, a.color AS agent_color FROM workflows w LEFT JOIN agents a ON a.id = w.agent_id WHERE enabled = 1').map(withNext);
    return {
      stats: {
        agents: count('SELECT COUNT(*) n FROM agents'),
        agents_active: count("SELECT COUNT(*) n FROM agents WHERE status = 'active'"),
        agents_error: count("SELECT COUNT(*) n FROM agents WHERE status = 'error'"),
        tasks_open: count("SELECT COUNT(*) n FROM tasks WHERE status NOT IN ('done')"),
        tasks_review: count("SELECT COUNT(*) n FROM tasks WHERE status = 'review'"),
        tasks_blocked: count("SELECT COUNT(*) n FROM tasks WHERE status = 'blocked'"),
        tasks_done_week: count("SELECT COUNT(*) n FROM tasks WHERE status = 'done' AND completed_at >= datetime('now', '-7 days')"),
        workflows_enabled: workflows.length,
        runs_failed_week: count("SELECT COUNT(*) n FROM workflow_runs WHERE status = 'failed' AND started_at >= datetime('now', '-7 days')"),
      },
      upcoming: workflows.filter((w) => w.next_run_at).sort((a, b) => a.next_run_at.localeCompare(b.next_run_at)).slice(0, 6),
      attention: all(
        `SELECT t.*, a.name AS agent_name, a.color AS agent_color FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id
         WHERE t.status IN ('review', 'blocked') ORDER BY t.updated_at DESC LIMIT 8`,
      ),
      runs: all(
        `SELECT r.*, w.name AS workflow_name FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id ORDER BY r.id DESC LIMIT 8`,
      ),
    };
  }));

  r.get('/activity', wrap((req) =>
    all(
      `SELECT ac.*, a.name AS agent_name, a.color AS agent_color FROM activity ac LEFT JOIN agents a ON a.id = ac.agent_id
       ORDER BY ac.id DESC LIMIT ?`,
      Math.min(Number(req.query.limit) || 30, 200),
    ),
  ));

  // Teams
  const getTeams = () =>
    all(
      `SELECT tm.*, (SELECT COUNT(*) FROM agents a WHERE a.team_id = tm.id) AS agent_count
       FROM teams tm ORDER BY tm.id`,
    );
  r.get('/teams', wrap(getTeams));

  r.post('/teams', wrap((req) => {
    const name = req.body.name?.trim();
    if (!name) throw bad('Team name is required');
    if (get('SELECT id FROM teams WHERE name = ?', name)) throw bad(`A team called "${name}" already exists`);
    const { lastInsertRowid } = run('INSERT INTO teams (name, description, color) VALUES (?, ?, ?)', name, req.body.description ?? '', req.body.color ?? '#6366f1');
    logActivity(null, 'agent', `Team "${name}" created`);
    emit('agent');
    return getTeams().find((t) => t.id === Number(lastInsertRowid));
  }));

  r.patch('/teams/:id', wrap((req) => {
    if (!get('SELECT id FROM teams WHERE id = ?', req.params.id)) throw notFound('Team');
    const patch = { ...req.body };
    if (patch.name !== undefined) {
      patch.name = patch.name.trim();
      if (!patch.name) throw bad('Team name is required');
      if (get('SELECT id FROM teams WHERE name = ? AND id != ?', patch.name, req.params.id)) throw bad(`A team called "${patch.name}" already exists`);
    }
    update('teams', req.params.id, patch, TEAM_FIELDS);
    emit('agent');
    return getTeams().find((t) => t.id === Number(req.params.id));
  }));

  r.delete('/teams/:id', wrap((req) => {
    run('DELETE FROM teams WHERE id = ?', req.params.id); // agents keep existing, with no team
    emit('agent');
    return { ok: true };
  }));

  // Agents
  const AGENT_SELECT = `SELECT a.*, tm.name AS team_name, tm.color AS team_color FROM agents a LEFT JOIN teams tm ON tm.id = a.team_id`;
  const getAgent = (id) => get(`${AGENT_SELECT} WHERE a.id = ?`, id);
  const checkTeam = (teamId) => {
    if (teamId !== undefined && teamId !== null && !get('SELECT id FROM teams WHERE id = ?', teamId)) throw bad('Unknown team');
  };

  r.get('/agents', wrap(() =>
    all(
      `SELECT a.*, tm.name AS team_name, tm.color AS team_color,
        (SELECT COUNT(*) FROM tasks t WHERE t.agent_id = a.id AND t.status != 'done') AS open_tasks,
        (SELECT COUNT(*) FROM workflows w WHERE w.agent_id = a.id AND w.enabled = 1) AS workflows,
        (SELECT body FROM messages m WHERE m.agent_id = a.id ORDER BY id DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM messages m WHERE m.agent_id = a.id ORDER BY id DESC LIMIT 1) AS last_message_at
       FROM agents a LEFT JOIN teams tm ON tm.id = a.team_id ORDER BY a.name`,
    ).map(publicAgent),
  ));

  r.get('/agents/:id', wrap((req) => {
    const agent = getAgent(req.params.id);
    if (!agent) throw notFound('Agent');
    return agent; // includes api_token: the dashboard is the admin surface
  }));

  r.post('/agents', wrap((req) => {
    const b = req.body;
    if (!b.name?.trim()) throw bad('Name is required');
    if (!b.title?.trim()) throw bad('Title is required');
    if (!b.team_id) throw bad('Choose a team for this agent');
    checkTeam(b.team_id);
    check(b.platform, PLATFORMS, 'platform');
    check(b.status, AGENT_STATUSES, 'status');
    const { lastInsertRowid } = run(
      `INSERT INTO agents (name, title, team_id, description, platform, status, model, system_prompt, webhook_url, color, api_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.name.trim(), b.title.trim(), b.team_id, b.description ?? '', b.platform ?? 'custom', b.status ?? 'idle',
      b.model ?? '', b.system_prompt ?? '', b.webhook_url ?? '', b.color ?? '#6366f1', newToken(),
    );
    const agent = getAgent(lastInsertRowid);
    logActivity(agent.id, 'agent', `${agent.name} joined ${agent.team_name} as ${agent.title}`);
    emit('agent');
    return agent;
  }));

  r.patch('/agents/:id', wrap((req) => {
    if (!get('SELECT id FROM agents WHERE id = ?', req.params.id)) throw notFound('Agent');
    const b = { ...req.body };
    check(b.approval, APPROVALS, 'approval');
    for (const k of ['skills', 'integrations']) {
      if (b[k] === undefined) continue;
      if (!Array.isArray(b[k]) || b[k].some((v) => typeof v !== 'string')) throw bad(`${k} must be a list`);
      b[k] = JSON.stringify([...new Set(b[k])]);
    }
    if (b.name !== undefined && !String(b.name).trim()) throw bad('Name is required');
    if (b.title !== undefined && !String(b.title).trim()) throw bad('Title is required');
    checkTeam(b.team_id);
    check(b.platform, PLATFORMS, 'platform');
    check(b.status, AGENT_STATUSES, 'status');
    update('agents', req.params.id, b, AGENT_FIELDS);
    emit('agent', { agent_id: Number(req.params.id) });
    return getAgent(req.params.id);
  }));

  r.post('/agents/:id/rotate-token', wrap((req) => {
    run('UPDATE agents SET api_token = ? WHERE id = ?', newToken(), req.params.id);
    return getAgent(req.params.id);
  }));

  r.delete('/agents/:id', wrap((req) => {
    run('DELETE FROM agents WHERE id = ?', req.params.id);
    emit('agent');
    return { ok: true };
  }));

  r.post('/agents/:id/sync', wrap(async (req) => {
    const agent = await syncAgent(Number(req.params.id));
    return getAgent(agent.id);
  }));

  // Capabilities: what agents can be given
  r.get('/capabilities', wrap(() => ({ skills: skillLibrary(), integrations: integrationList(), managed: managedReady() })));

  // Chat
  r.get('/agents/:id/messages', wrap((req) =>
    all('SELECT * FROM (SELECT * FROM messages WHERE agent_id = ? ORDER BY id DESC LIMIT 200) ORDER BY id', req.params.id),
  ));
  r.post('/agents/:id/messages', wrap(async (req) => {
    if (!req.body.body?.trim()) throw bad('body is required');
    if (!get('SELECT id FROM agents WHERE id = ?', req.params.id)) throw notFound('Agent');
    return sendToAgent(Number(req.params.id), req.body.body.trim());
  }));

  // Tasks
  r.get('/tasks', wrap((req) => {
    const filters = { agent_id: 't.agent_id = ?', status: 't.status = ?', workflow_id: 't.workflow_id = ?' };
    const keys = Object.keys(filters).filter((k) => req.query[k]);
    const where = keys.map((k) => filters[k]);
    const params = keys.map((k) => req.query[k]);
    return all(
      `SELECT t.*, a.name AS agent_name, a.color AS agent_color, a.platform AS agent_platform, w.name AS workflow_name
       FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id LEFT JOIN workflows w ON w.id = t.workflow_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.updated_at DESC
       LIMIT 500`,
      ...params,
    );
  }));

  r.post('/tasks', wrap(async (req) => {
    const id = createTask(req.body, 'You');
    if (req.body.agent_id && req.body.dispatch !== false) dispatchTask(id).catch(() => {});
    return getTask(id);
  }));

  r.patch('/tasks/:id', wrap((req) => {
    const before = get('SELECT agent_id FROM tasks WHERE id = ?', req.params.id);
    const task = patchTask(Number(req.params.id), req.body, 'You');
    if (req.body.agent_id && before && req.body.agent_id !== before.agent_id) dispatchTask(task.id).catch(() => {});
    return task;
  }));

  r.post('/tasks/:id/dispatch', wrap(async (req) => {
    if (!getTask(req.params.id)) throw notFound('Task');
    dispatchTask(Number(req.params.id)).catch(() => {});
    return { ok: true };
  }));

  r.delete('/tasks/:id', wrap((req) => {
    run('DELETE FROM tasks WHERE id = ?', req.params.id);
    emit('task');
    return { ok: true };
  }));

  // Task files (inputs for the agent: statements, invoices, spreadsheets)
  r.get('/tasks/:id/files', wrap((req) => all('SELECT id, task_id, filename, size, created_at FROM task_files WHERE task_id = ? ORDER BY id', req.params.id)));

  r.post('/tasks/:id/files', express.raw({ type: () => true, limit: '50mb' }), wrap((req) => {
    if (!get('SELECT id FROM tasks WHERE id = ?', req.params.id)) throw notFound('Task');
    const raw = decodeURIComponent(req.get('x-filename') || '');
    const filename = raw.split(/[\\/]/).pop().replace(/[^\w.\- ()&+,]/g, '_').trim().slice(0, 180);
    if (!filename || filename.startsWith('.')) throw bad('Please give the file a normal name');
    if (!req.body?.length) throw bad('Empty file');
    if (get('SELECT id FROM task_files WHERE task_id = ? AND filename = ?', req.params.id, filename)) throw bad(`${filename} is already attached`);
    const dir = join(DATA_DIR, 'uploads', String(req.params.id));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, filename);
    writeFileSync(path, req.body);
    const { lastInsertRowid } = run('INSERT INTO task_files (task_id, filename, path, size) VALUES (?, ?, ?, ?)', req.params.id, filename, path, req.body.length);
    emit('task', { task_id: Number(req.params.id) });
    return get('SELECT id, task_id, filename, size, created_at FROM task_files WHERE id = ?', lastInsertRowid);
  }));

  r.delete('/tasks/:id/files/:fileId', wrap((req) => {
    const f = get('SELECT * FROM task_files WHERE id = ? AND task_id = ?', req.params.fileId, req.params.id);
    if (!f) throw notFound('File');
    rmSync(f.path, { force: true });
    run('DELETE FROM task_files WHERE id = ?', f.id);
    emit('task', { task_id: Number(req.params.id) });
    return { ok: true };
  }));

  // Runs: a Claude Managed Agents session working on a task
  r.get('/tasks/:id/runs', wrap((req) =>
    all('SELECT id FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 10', req.params.id).map((x) => runWithEvents(x.id)),
  ));
  r.post('/tasks/:id/runs', wrap((req) => startTaskRun(Number(req.params.id))));
  r.post('/runs/:id/reply', wrap(async (req) => {
    if (!req.body.text?.trim()) throw bad('text is required');
    await replyToRun(Number(req.params.id), req.body.text.trim());
    return { ok: true };
  }));
  r.post('/runs/:id/confirm', wrap(async (req) => {
    await confirmTool(Number(req.params.id), req.body.event_id, req.body.result === 'allow', req.body.deny_message);
    return { ok: true };
  }));
  r.post('/runs/:id/interrupt', wrap(async (req) => {
    await interruptRun(Number(req.params.id));
    return { ok: true };
  }));

  // Workflows
  r.get('/workflows', wrap(() =>
    all(
      `SELECT w.*, a.name AS agent_name, a.color AS agent_color,
        (SELECT status FROM workflow_runs r WHERE r.workflow_id = w.id ORDER BY id DESC LIMIT 1) AS last_status,
        (SELECT COUNT(*) FROM workflow_runs r WHERE r.workflow_id = w.id) AS run_count
       FROM workflows w LEFT JOIN agents a ON a.id = w.agent_id ORDER BY w.name`,
    ).map(withNext),
  ));

  r.post('/workflows', wrap((req) => {
    const b = req.body;
    if (!b.name?.trim()) throw bad('name is required');
    const v = validateSchedule(b.schedule, b.timezone);
    if (!v.ok) throw bad(`Invalid schedule: ${v.error}`);
    const { lastInsertRowid } = run(
      'INSERT INTO workflows (name, description, agent_id, schedule, timezone, instructions, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
      b.name.trim(), b.description ?? '', b.agent_id ?? null, b.schedule, b.timezone || 'UTC', b.instructions ?? '', b.enabled === false ? 0 : 1,
    );
    const wf = get('SELECT * FROM workflows WHERE id = ?', lastInsertRowid);
    schedule(wf);
    logActivity(wf.agent_id, 'workflow', `Workflow "${wf.name}" created`);
    emit('workflow');
    return withNext(wf);
  }));

  r.patch('/workflows/:id', wrap((req) => {
    const current = get('SELECT * FROM workflows WHERE id = ?', req.params.id);
    if (!current) throw notFound('Workflow');
    const b = { ...req.body };
    if (b.enabled !== undefined) b.enabled = b.enabled ? 1 : 0;
    if (b.schedule !== undefined || b.timezone !== undefined) {
      const v = validateSchedule(b.schedule ?? current.schedule, b.timezone ?? current.timezone);
      if (!v.ok) throw bad(`Invalid schedule: ${v.error}`);
    }
    update('workflows', req.params.id, b, WORKFLOW_FIELDS);
    const wf = get('SELECT * FROM workflows WHERE id = ?', req.params.id);
    schedule(wf);
    emit('workflow');
    return withNext(wf);
  }));

  r.delete('/workflows/:id', wrap((req) => {
    unschedule(Number(req.params.id));
    run('DELETE FROM workflows WHERE id = ?', req.params.id);
    emit('workflow');
    return { ok: true };
  }));

  r.post('/workflows/:id/run', wrap(async (req) => {
    if (!get('SELECT id FROM workflows WHERE id = ?', req.params.id)) throw notFound('Workflow');
    const started = runWorkflow(Number(req.params.id), 'manual');
    started.catch(() => {});
    return { ok: true };
  }));

  r.get('/workflows/:id/runs', wrap((req) => all('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY id DESC LIMIT 50', req.params.id)));

  r.post('/schedule/preview', wrap((req) => {
    const v = validateSchedule(req.body.schedule, req.body.timezone);
    return v.ok ? { ok: true, next: nextRuns(req.body.schedule, req.body.timezone, 3) } : v;
  }));

  return r;
}

// ---------- Agent API (bearer token per agent) ----------
export function agentRouter() {
  const r = express.Router();

  r.use((req, res, next) => {
    const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
    const agent = token && get('SELECT * FROM agents WHERE api_token = ?', token);
    if (!agent) return res.status(401).json({ error: 'Invalid or missing agent token' });
    run("UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?", agent.id);
    req.agent = agent;
    next();
  });

  r.get('/me', (req, res) => res.json(publicAgent(req.agent)));

  r.post('/heartbeat', wrap((req) => {
    check(req.body.status, AGENT_STATUSES, 'status');
    if (req.body.status) run('UPDATE agents SET status = ? WHERE id = ?', req.body.status, req.agent.id);
    emit('agent', { agent_id: req.agent.id });
    return { ok: true };
  }));

  r.get('/tasks', wrap((req) => {
    const statuses = req.query.status ? String(req.query.status).split(',') : ['todo', 'in_progress', 'blocked'];
    return all(
      `SELECT * FROM tasks WHERE agent_id = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY id`,
      req.agent.id,
      ...statuses,
    );
  }));

  r.post('/tasks', wrap((req) => getTask(createTask({ ...req.body, agent_id: req.body.agent_id ?? req.agent.id }, req.agent.name))));

  r.patch('/tasks/:id', wrap((req) => {
    const task = get('SELECT * FROM tasks WHERE id = ?', req.params.id);
    if (!task || task.agent_id !== req.agent.id) throw notFound('Task');
    const { status, result, description } = req.body;
    return patchTask(task.id, { status, result, description }, req.agent.name);
  }));

  r.get('/messages', wrap((req) =>
    all('SELECT * FROM messages WHERE agent_id = ? AND id > ? ORDER BY id LIMIT 200', req.agent.id, Number(req.query.since_id) || 0),
  ));

  r.post('/messages', wrap((req) => {
    if (!req.body.body?.trim()) throw bad('body is required');
    return postMessage(req.agent.id, 'agent', req.body.body.trim());
  }));

  r.patch('/runs/:id', wrap((req) => {
    const wfRun = get(
      'SELECT r.* FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ? AND w.agent_id = ?',
      req.params.id,
      req.agent.id,
    );
    if (!wfRun) throw notFound('Run');
    check(req.body.status, RUN_STATUSES, 'status');
    if (req.body.status && req.body.status !== 'running') finishRun(wfRun.id, req.body.status, req.body.output ?? wfRun.output);
    else if (req.body.output !== undefined) run('UPDATE workflow_runs SET output = ? WHERE id = ?', req.body.output, wfRun.id);
    return get('SELECT * FROM workflow_runs WHERE id = ?', wfRun.id);
  }));

  return r;
}

export function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
}
