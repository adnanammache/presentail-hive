import express from 'express';
import { all, get, run, update, newToken } from './db.js';
import { emit, subscribe } from './events.js';
import { logActivity } from './activity.js';
import { claudeConfigured, dispatchTask, postMessage, sendToAgent } from './dispatch.js';
import { finishRun, nextRuns, runWorkflow, schedule, unschedule, validateSchedule } from './scheduler.js';

const PLATFORMS = ['claude', 'make', 'replit', 'n8n', 'custom', 'human'];
const AGENT_STATUSES = ['active', 'idle', 'paused', 'error'];
const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done', 'blocked'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const RUN_STATUSES = ['running', 'success', 'failed'];

const AGENT_FIELDS = ['name', 'role', 'description', 'platform', 'status', 'model', 'system_prompt', 'webhook_url', 'color'];
const TASK_FIELDS = ['title', 'description', 'status', 'priority', 'agent_id', 'due_date', 'result'];
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
    `SELECT t.*, a.name AS agent_name, a.color AS agent_color, w.name AS workflow_name
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

  // Agents
  r.get('/agents', wrap(() =>
    all(
      `SELECT a.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.agent_id = a.id AND t.status != 'done') AS open_tasks,
        (SELECT COUNT(*) FROM workflows w WHERE w.agent_id = a.id AND w.enabled = 1) AS workflows,
        (SELECT body FROM messages m WHERE m.agent_id = a.id ORDER BY id DESC LIMIT 1) AS last_message,
        (SELECT created_at FROM messages m WHERE m.agent_id = a.id ORDER BY id DESC LIMIT 1) AS last_message_at
       FROM agents a ORDER BY a.name`,
    ).map(publicAgent),
  ));

  r.get('/agents/:id', wrap((req) => {
    const agent = get('SELECT * FROM agents WHERE id = ?', req.params.id);
    if (!agent) throw notFound('Agent');
    return agent; // includes api_token: the dashboard is the admin surface
  }));

  r.post('/agents', wrap((req) => {
    const b = req.body;
    if (!b.name?.trim()) throw bad('name is required');
    check(b.platform, PLATFORMS, 'platform');
    check(b.status, AGENT_STATUSES, 'status');
    const { lastInsertRowid } = run(
      `INSERT INTO agents (name, role, description, platform, status, model, system_prompt, webhook_url, color, api_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.name.trim(), b.role ?? '', b.description ?? '', b.platform ?? 'custom', b.status ?? 'idle',
      b.model ?? '', b.system_prompt ?? '', b.webhook_url ?? '', b.color ?? '#6366f1', newToken(),
    );
    logActivity(lastInsertRowid, 'agent', `Agent "${b.name.trim()}" added`);
    emit('agent');
    return get('SELECT * FROM agents WHERE id = ?', lastInsertRowid);
  }));

  r.patch('/agents/:id', wrap((req) => {
    if (!get('SELECT id FROM agents WHERE id = ?', req.params.id)) throw notFound('Agent');
    check(req.body.platform, PLATFORMS, 'platform');
    check(req.body.status, AGENT_STATUSES, 'status');
    update('agents', req.params.id, req.body, AGENT_FIELDS);
    emit('agent', { agent_id: Number(req.params.id) });
    return get('SELECT * FROM agents WHERE id = ?', req.params.id);
  }));

  r.post('/agents/:id/rotate-token', wrap((req) => {
    run('UPDATE agents SET api_token = ? WHERE id = ?', newToken(), req.params.id);
    return get('SELECT * FROM agents WHERE id = ?', req.params.id);
  }));

  r.delete('/agents/:id', wrap((req) => {
    run('DELETE FROM agents WHERE id = ?', req.params.id);
    emit('agent');
    return { ok: true };
  }));

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
      `SELECT t.*, a.name AS agent_name, a.color AS agent_color, w.name AS workflow_name
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
