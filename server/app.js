import express from 'express';
import { HttpError, bad, check, forbidden, notFound, wrap } from './http.js';
import { DATA_DIR, all, get, run, update, newToken } from './db.js';
import { emit, subscribe } from './events.js';
import { logActivity } from './activity.js';
import { claudeConfigured, dispatchTask, postMessage, sendToAgent } from './dispatch.js';
import { integrationList, skillLibrary } from './capabilities.js';
import { sendSlack, slackButtonsEnabled, slackConfigured } from './notify.js';
import { approvers } from './slack.js';
import { finishTask, handOff, reviewerFor } from './handoff.js';
import { agentSpend, parseBudget, teamSpend } from './budget.js';
import { removeAgentPhoto, saveAgentPhoto } from './avatars.js';
import { backupNow, backupPath, listBackups } from './backup.js';
import { healthReport, runChecks } from './health.js';
import { listModels } from './models.js';
import { canApproveFor, isOwner, listUsers, setUserRole, userFor } from './roles.js';
import { REMEMBER, addLesson, deleteLesson, listLessons, updateLesson } from './lessons.js';
import { saveChatFile, unsentFiles } from './chatFiles.js';
import { closeBoard, dueDate, itemInstructions, monthLabel, saveCloseItem } from './close.js';
import { briefConfig, latestBrief, nextBriefAt, sendBrief, setBriefConfig } from './brief.js';
import { pushToAll, removeSubscription, saveSubscription, subscriptionCount, vapidKeys } from './push.js';
import { COMPANIES, testOdoo } from './odoo.js';
import { authMode } from './auth.js';
import { markVerified, setHidden, setManualDone, setupChecklist, verified } from './setup.js';
import { confirmTool, downloadOutput, interruptRun, managedReady, replyToRun, runWithEvents, startTaskRun, syncAgent } from './managed.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { finishRun } from './scheduler.js';
import { canViewSchedule, suspendSchedulesFor, cancelSchedule, createSchedule, listSchedules, pauseSchedule, previewSchedule, resumeSchedule, runNow, scheduleDetails, updateSchedule } from './schedules.js';
import { cleanSchedule } from './taskSchedule.js';
import {
  PRIORITIES, TASK_STATUSES, addLinks, agentActor, agentView, attention, board, clearBlocker, createTask, getTask, listTasks, needsMe,
  canEditTask, patchTask, personActor, startExecution, taskEvent,
} from './tasks.js';
import {
  addDraftFile, addResource, createProject, deleteProject, discardDraft, getDraft, getProject, listProjects, listResources, removeDraftFile,
  removeResource, resourceFile, saveDraft, setFavorite, updateProject,
} from './projects.js';
import { cleanFilename } from './http.js';
import {
  addTeamMembers, createInvite, deactivate, directory, getPerson, listInvites, listPeople, photoFile, publicPerson, reactivate, removePhoto,
  removeTeamMember, resendInvite, revokeInvite, savePhoto, setMembership, setTeamRole, updateProfile, useAccountPhoto, avatarUrl,
} from './people.js';
import { mailConfigured } from './mail.js';

const PLATFORMS = ['managed', 'claude', 'make', 'replit', 'n8n', 'custom', 'human'];
const APPROVALS = ['agent_asks', 'every_command', 'autonomous'];
const AGENT_STATUSES = ['active', 'idle', 'paused', 'error'];
const RUN_STATUSES = ['running', 'success', 'failed'];

const AGENT_FIELDS = ['name', 'title', 'team_id', 'description', 'platform', 'status', 'model', 'system_prompt', 'webhook_url', 'color', 'skills', 'integrations', 'approval', 'reviewer_id', 'budget_cents'];
const TEAM_FIELDS = ['name', 'description', 'color', 'budget_cents'];

// ---------- serializers ----------
const publicAgent = ({ api_token, ...a }) => a;
const withNext = (wf) => ({ ...wf, enabled: wf.status === 'active', next_run_at: wf.status === 'active' ? wf.next_run_at : null });

/** Approve or send back a task that is waiting for approval, and tell the agent. */
async function decideTask(req, approve) {
  const t = get('SELECT * FROM tasks WHERE id = ?', req.params.id);
  if (!t) throw notFound('Task');
  if (!canApproveFor(req.hive, t.agent_id)) throw forbidden("You can't approve this agent's work. Ask an approver or an owner.");
  if (t.status !== 'waiting_approval') throw bad('This task is not waiting for approval');
  const note = String(req.body?.note ?? '').trim().slice(0, 4000);
  if (!approve && !note) throw bad('Say what needs changing');
  const by = req.hive?.name || req.user?.name || 'You';
  run(
    "UPDATE tasks SET status = 'in_progress', approved_at = ?, approved_by = ?, updated_at = datetime('now') WHERE id = ?",
    approve ? new Date().toISOString() : null, approve ? by : null, t.id,
  );
  const text = approve
    ? `${by} approved "${t.title}". Go ahead: submit, file or pay exactly what you prepared, nothing more. Then report back with the confirmation or reference numbers and call task_complete.${note ? `\n\nNote from ${by}: ${note}` : ''}`
    : `${by} sent "${t.title}" back:\n${note}\n\nFix this, then stop again and ask for approval (call task_complete). Do not submit or pay anything yet.`;
  logActivity(t.agent_id, 'task', `${by} ${approve ? 'approved' : 'sent back'} "${t.title}"`);
  taskEvent(t.id, by, approve ? 'approved' : 'changes', approve ? `Approved to submit${note ? `: ${note}` : ''}` : `Sent back: ${note.slice(0, 300)}`);
  emit('task', { task_id: t.id });
  try {
    await resumeTaskAgent(t, text);
  } catch (err) {
    run("UPDATE tasks SET status = 'waiting_approval', approved_at = NULL, approved_by = NULL WHERE id = ?", t.id);
    emit('task', { task_id: t.id });
    throw bad(`Couldn't reach the agent: ${err.message}`);
  }
  return getTask(t.id);
}

/** Continue the agent's work on a task with a message: its run if it's still open, else a new run. */
async function resumeTaskAgent(task, text) {
  const agent = task.agent_id && get('SELECT * FROM agents WHERE id = ?', task.agent_id);
  if (!agent) throw new Error('No agent is assigned');
  if (agent.platform !== 'managed') return sendToAgent(agent.id, `[Task #${task.id}] ${text}`);
  const last = get("SELECT id, status FROM runs WHERE task_id = ? AND kind = 'task' ORDER BY id DESC LIMIT 1", task.id);
  if (last && !['failed', 'ended'].includes(last.status)) return replyToRun(last.id, text);
  return startTaskRun(task.id, { note: text });
}

const TEMPLATE_FIELDS = ['name', 'title', 'description', 'done_definition', 'priority', 'agent_id', 'entity_id', 'start_offset_days', 'remind_days', 'needs_approval'];
function listTemplates() {
  return all(
    `SELECT t.*, COALESCE(t.agent_id, (SELECT id FROM agents a WHERE a.name = t.agent_name)) AS agent_id
     FROM task_templates t ORDER BY t.name COLLATE NOCASE`,
  ).map((t) => ({ ...t, repeat: t.rule ? JSON.parse(t.rule) : null, needs_approval: Boolean(t.needs_approval) }));
}

// ---------- dashboard API ----------
// What only owners may change. Everything else is open to anyone signed in, except approving
// agents' actions and teaching them lessons (approvers, checked in those routes).
const OWNER_ONLY = [
  ['post', '/teams'], ['patch', '/teams/:id'], ['delete', '/teams/:id'],
  ['post', '/agents'], ['patch', '/agents/:id'], ['delete', '/agents/:id'], ['post', '/agents/:id/photo'], ['delete', '/agents/:id/photo'], ['post', '/agents/:id/rotate-token'], ['post', '/agents/:id/sync'],
  ['delete', '/workflows/:id'],
  ['post', '/entities'], ['put', '/org/layout'],
  ['post', '/close/items'], ['patch', '/close/items/:id'], ['delete', '/close/items/:id'],
  ['put', '/brief/config'], ['post', '/setup'],
  ['get', '/backups'], ['post', '/backups'], ['get', '/backups/:name'],
  ['post', '/settings/slack/test'], ['post', '/settings/odoo/test'],
  ['get', '/users'], ['patch', '/users/:email'],
  ['get', '/invitations'], ['post', '/invitations'], ['post', '/invitations/:id/resend'], ['delete', '/invitations/:id'],
];

/** Webhooks go out to the internet over https only, never to Hive's own network. */
export function checkWebhookUrl(url) {
  if (!url) return;
  let u;
  try {
    u = new URL(url);
  } catch {
    throw bad('Webhook URL is not a valid URL');
  }
  const host = u.hostname.toLowerCase();
  const privateHost =
    host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.localhost') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || host.startsWith('[') || /^\d+$/.test(host);
  if (process.env.NODE_ENV !== 'production') return; // local development and tests use local webhooks
  if (u.protocol !== 'https:' || privateHost) throw bad('Webhook URL must be a public https:// address');
}

export function dashboardRouter() {
  const r = express.Router();

  // Who is asking, and what they may do.
  r.use((req, res, next) => {
    req.hive = userFor(req.user ?? {});
    // Without Google sign-in there is one admin; give them a stable identity so tasks can be theirs.
    if (!req.hive.email) {
      req.hive.email = 'admin@local';
      req.hive.name = req.user?.name && req.user.name !== 'Local' ? req.user.name : 'Admin';
      run("INSERT OR IGNORE INTO users (email, name, role) VALUES ('admin@local', ?, 'owner')", req.hive.name);
    }
    next();
  });
  const ownerOnly = (req, res, next) => (isOwner(req.hive) ? next() : next(forbidden('Only a Hive owner can do this. Ask an owner.')));
  for (const [method, path] of OWNER_ONLY) r[method](path, ownerOnly);

  r.get('/me', (req, res) => {
    const profile = publicPerson(get('SELECT * FROM users WHERE email = ?', req.hive.email)) ?? {};
    res.json({ ...req.user, ...profile, email: req.hive.email, name: profile.name || req.user?.name || req.hive.name, auth: authMode(), role: req.hive.role, teams: req.hive.teams });
  });

  // People: everyone active in the workspace (owners can ask for deactivated ones too).
  r.get('/people', wrap((req) => listPeople({ includeInactive: req.query.all === '1' && isOwner(req.hive) })));
  r.get('/people/:email', wrap((req) => getPerson(req.params.email, req.hive)));
  r.patch('/people/:email', wrap((req) => updateProfile(req.params.email, req.body ?? {}, req.hive)));
  r.get('/people/:email/photo', (req, res, next) => {
    const f = photoFile(req.params.email);
    if (!f) return next(notFound('Photo'));
    res.set('Cache-Control', 'private, max-age=31536000, immutable').type(f.type).send(f.body);
  });
  r.put('/people/:email/photo', express.raw({ type: () => true, limit: '4mb' }), wrap((req) => savePhoto(req.params.email, req.body, req.hive)));
  r.delete('/people/:email/photo', wrap((req) => removePhoto(req.params.email, req.hive)));
  r.post('/people/:email/photo/account', wrap((req) => useAccountPhoto(req.params.email, req.hive)));
  r.patch('/people/:email/membership', wrap((req) => setMembership(req.params.email, req.body ?? {}, req.hive)));
  r.post('/people/:email/deactivate', wrap((req) => deactivate(req.params.email, req.hive)));
  r.post('/people/:email/reactivate', wrap((req) => reactivate(req.params.email, req.hive)));

  // Team & agents: teams with their people and agents; membership changes.
  r.get('/directory', wrap((req) => directory(req.hive)));
  r.post('/teams/:id/members', wrap((req) => addTeamMembers(req.params.id, req.body?.members, req.hive)));
  r.delete('/teams/:id/members/:type/:ref', wrap((req) => removeTeamMember(req.params.id, req.params.type, req.params.ref, req.hive)));
  r.patch('/teams/:id/members/user/:email', wrap((req) => setTeamRole(req.params.id, req.params.email, req.body?.role, req.hive)));

  // Invitations (owners)
  r.get('/invitations', wrap(() => ({ invitations: listInvites(), email_configured: mailConfigured(), google: authMode() === 'google' })));
  r.post('/invitations', wrap((req) => createInvite(req.body ?? {}, req.hive)));
  r.post('/invitations/:id/resend', wrap((req) => resendInvite(req.params.id, req.hive)));
  r.delete('/invitations/:id', wrap((req) => revokeInvite(req.params.id, req.hive)));
  r.get('/users', wrap(() => listUsers()));
  r.patch('/users/:email', wrap((req) => {
    try {
      return setUserRole(req.params.email, req.body || {}, req.hive);
    } catch (err) {
      throw bad(err.message);
    }
  }));

  r.get('/events', subscribe);
  r.get('/meta', (req, res) => res.json({ claude: claudeConfigured(), platforms: PLATFORMS, taskStatuses: TASK_STATUSES, priorities: PRIORITIES }));

  r.get('/overview', wrap((req) => {
    const count = (sql, ...p) => get(sql, ...p).n;
    const workflows = all("SELECT w.*, COALESCE(a.name, u.name, w.assignee_email) AS agent_name, a.color AS agent_color FROM workflows w LEFT JOIN agents a ON a.id = w.agent_id LEFT JOIN users u ON u.email = w.assignee_email WHERE w.status = 'active'")
      .filter((w) => canViewSchedule(req.hive, w))
      .map(withNext);
    return {
      stats: {
        agents: count('SELECT COUNT(*) n FROM agents'),
        agents_active: count("SELECT COUNT(*) n FROM agents WHERE status = 'active'"),
        agents_error: count("SELECT COUNT(*) n FROM agents WHERE status = 'error'"),
        tasks_open: count("SELECT COUNT(*) n FROM tasks WHERE status NOT IN ('done')"),
        tasks_review: count("SELECT COUNT(*) n FROM tasks WHERE status IN ('review', 'waiting_approval')"),
        tasks_blocked: count("SELECT COUNT(*) n FROM tasks WHERE blocked_kind IS NOT NULL AND status != 'done'"),
        tasks_done_week: count("SELECT COUNT(*) n FROM tasks WHERE status = 'done' AND completed_at >= datetime('now', '-7 days')"),
        workflows_enabled: workflows.length,
        runs_failed_week: count("SELECT COUNT(*) n FROM workflow_runs WHERE status = 'failed' AND started_at >= datetime('now', '-7 days')"),
      },
      upcoming: workflows.filter((w) => w.next_run_at).sort((a, b) => a.next_run_at.localeCompare(b.next_run_at)).slice(0, 6),
      attention: all(
        `SELECT t.*, a.name AS agent_name, a.color AS agent_color FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id
         WHERE t.status IN ('review', 'waiting_approval') OR (t.blocked_kind IS NOT NULL AND t.status != 'done') ORDER BY t.updated_at DESC LIMIT 8`,
      ),
      runs: all(
        `SELECT r.*, w.name AS workflow_name FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id ORDER BY r.id DESC LIMIT 8`,
      ),
    };
  }));

  // AI spend: what Claude Managed Agents runs cost (list price, as reported by Anthropic).
  r.get('/spend', wrap(() => {
    const monthStart = "date('now', 'start of month')";
    const sum = (where) => get(`SELECT COALESCE(SUM(cost_cents), 0) AS c FROM runs WHERE ${where}`).c;
    return {
      month_cents: sum(`created_at >= ${monthStart}`),
      last_month_cents: sum(`created_at >= date('now', 'start of month', '-1 month') AND created_at < ${monthStart}`),
      runs_this_month: get(`SELECT COUNT(*) n FROM runs WHERE created_at >= ${monthStart}`).n,
      // Budgets with how much of each is used, most used first.
      budgets: [
        ...all('SELECT id, name, color, budget_cents FROM teams WHERE budget_cents IS NOT NULL').map((t) => ({ kind: 'team', ...t, cents: teamSpend(t.id) })),
        ...all('SELECT id, name, color, budget_cents FROM agents WHERE budget_cents IS NOT NULL').map((a) => ({ kind: 'agent', ...a, cents: agentSpend(a.id) })),
      ].sort((x, y) => y.cents / (y.budget_cents || 1) - x.cents / (x.budget_cents || 1)),
      daily: all(
        `SELECT date(created_at) AS day, SUM(cost_cents) AS cents, COUNT(*) AS runs FROM runs
         WHERE created_at >= date('now', '-29 days') GROUP BY day ORDER BY day`,
      ),
      by_agent: all(
        `SELECT a.id, a.name, a.title, a.color, a.budget_cents, tm.name AS team_name, SUM(r.cost_cents) AS cents, COUNT(r.id) AS runs
         FROM runs r JOIN agents a ON a.id = r.agent_id LEFT JOIN teams tm ON tm.id = a.team_id
         WHERE r.created_at >= ${monthStart} GROUP BY a.id HAVING cents > 0 ORDER BY cents DESC`,
      ),
      by_team: all(
        `SELECT COALESCE(tm.id, 0) AS id, COALESCE(tm.name, 'No team') AS name, COALESCE(tm.color, '#94a3b8') AS color, tm.budget_cents, SUM(r.cost_cents) AS cents
         FROM runs r JOIN agents a ON a.id = r.agent_id LEFT JOIN teams tm ON tm.id = a.team_id
         WHERE r.created_at >= ${monthStart} GROUP BY tm.id HAVING cents > 0 ORDER BY cents DESC`,
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
    ).map((t) => ({ ...t, month_cents: teamSpend(t.id) }));
  r.get('/teams', wrap(getTeams));

  r.post('/teams', wrap((req) => {
    const name = req.body.name?.trim();
    if (!name) throw bad('Team name is required');
    if (get('SELECT id FROM teams WHERE name = ?', name)) throw bad(`A team called "${name}" already exists`);
    let budget = null;
    try {
      budget = parseBudget(req.body.budget) ?? null;
    } catch (err) {
      throw bad(err.message);
    }
    const { lastInsertRowid } = run('INSERT INTO teams (name, description, color, budget_cents) VALUES (?, ?, ?, ?)', name, req.body.description ?? '', req.body.color ?? '#6366f1', budget);
    logActivity(null, 'agent', `Team "${name}" created`);
    emit('agent');
    return getTeams().find((t) => t.id === Number(lastInsertRowid));
  }));

  r.patch('/teams/:id', wrap((req) => {
    if (!get('SELECT id FROM teams WHERE id = ?', req.params.id)) throw notFound('Team');
    const patch = { ...req.body };
    try {
      if (patch.budget !== undefined) patch.budget_cents = parseBudget(patch.budget);
    } catch (err) {
      throw bad(err.message);
    }
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
  const AGENT_SELECT = `SELECT a.*, tm.name AS team_name, tm.color AS team_color,
    (SELECT COALESCE(SUM(cost_cents), 0) FROM runs r WHERE r.agent_id = a.id AND r.created_at >= date('now', 'start of month')) AS month_cents
    FROM agents a LEFT JOIN teams tm ON tm.id = a.team_id`;
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
        (SELECT created_at FROM messages m WHERE m.agent_id = a.id ORDER BY id DESC LIMIT 1) AS last_message_at,
        (SELECT COALESCE(SUM(cost_cents), 0) FROM runs r WHERE r.agent_id = a.id AND r.created_at >= date('now', 'start of month')) AS month_cents,
        (SELECT COUNT(*) FROM runs r WHERE r.agent_id = a.id AND r.status = 'needs_approval') AS pending_approvals,
        (SELECT COUNT(*) FROM runs r WHERE r.agent_id = a.id AND r.status IN ('starting', 'running')) AS running_runs
       FROM agents a LEFT JOIN teams tm ON tm.id = a.team_id ORDER BY a.name`,
    ).map(publicAgent),
  ));

  r.get('/agents/:id', wrap((req) => {
    const agent = getAgent(req.params.id);
    if (!agent) throw notFound('Agent');
    return isOwner(req.hive) ? agent : publicAgent(agent); // the Agent API token is for owners only
  }));

  r.post('/agents', wrap((req) => {
    const b = req.body;
    if (!b.name?.trim()) throw bad('Name is required');
    if (!b.title?.trim()) throw bad('Title is required');
    if (!b.team_id) throw bad('Choose a team for this agent');
    checkTeam(b.team_id);
    check(b.platform, PLATFORMS, 'platform');
    check(b.status, AGENT_STATUSES, 'status');
    checkWebhookUrl(b.webhook_url);
    const { lastInsertRowid } = run(
      `INSERT INTO agents (name, title, team_id, description, platform, status, model, system_prompt, webhook_url, color, api_token, approval)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.name.trim(), b.title.trim(), b.team_id, b.description ?? '', b.platform ?? 'custom', b.status ?? 'idle',
      b.model ?? '', b.system_prompt ?? '', b.webhook_url ?? '', b.color ?? '#6366f1', newToken(),
      b.approval ?? 'every_command', // new agents ask before every command until you decide otherwise
    );
    if (b.reviewer_id && get('SELECT id FROM agents WHERE id = ?', b.reviewer_id)) run('UPDATE agents SET reviewer_id = ? WHERE id = ?', b.reviewer_id, lastInsertRowid);
    try {
      if (b.budget != null && b.budget !== '') run('UPDATE agents SET budget_cents = ? WHERE id = ?', parseBudget(b.budget), lastInsertRowid);
    } catch (err) {
      throw bad(err.message);
    }
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
    try {
      if (b.budget !== undefined) b.budget_cents = parseBudget(b.budget);
    } catch (err) {
      throw bad(err.message);
    }
    checkWebhookUrl(b.webhook_url);
    if (b.reviewer_id !== undefined && b.reviewer_id !== null) {
      if (Number(b.reviewer_id) === Number(req.params.id)) throw bad('An agent cannot review its own work');
      if (!get('SELECT id FROM agents WHERE id = ?', b.reviewer_id)) throw bad('Unknown reviewer');
    }
    check(b.platform, PLATFORMS, 'platform');
    check(b.status, AGENT_STATUSES, 'status');
    update('agents', req.params.id, b, AGENT_FIELDS);
    emit('agent', { agent_id: Number(req.params.id) });
    return getAgent(req.params.id);
  }));

  // Org chart layout: each team's agents, top to bottom. Moving someone to another team changes their team.
  r.put('/org/layout', wrap((req) => {
    const columns = req.body?.teams;
    if (!Array.isArray(columns)) throw bad('teams must be a list');
    const seen = new Set();
    for (const c of columns) {
      if (c.team_id !== null) checkTeam(c.team_id);
      if (!Array.isArray(c.ids)) throw bad('ids must be a list');
      for (const id of c.ids) {
        if (seen.has(Number(id))) throw bad('An agent appears twice');
        seen.add(Number(id));
        if (!get('SELECT id FROM agents WHERE id = ?', id)) throw bad('Unknown agent');
      }
    }
    for (const c of columns) c.ids.forEach((id, i) => run('UPDATE agents SET team_id = ?, sort_order = ? WHERE id = ?', c.team_id, i, id));
    emit('agent');
    return { ok: true };
  }));

  r.post('/agents/:id/rotate-token', wrap((req) => {
    run('UPDATE agents SET api_token = ? WHERE id = ?', newToken(), req.params.id);
    return getAgent(req.params.id);
  }));

  r.delete('/agents/:id', wrap((req) => {
    const gone = get('SELECT name FROM agents WHERE id = ?', req.params.id);
    if (gone) suspendSchedulesFor(Number(req.params.id), `${gone.name} was removed`);
    removeAgentPhoto(Number(req.params.id));
    run('DELETE FROM agents WHERE id = ?', req.params.id);
    emit('agent');
    return { ok: true };
  }));

  r.post('/agents/:id/sync', wrap(async (req) => {
    const agent = await syncAgent(Number(req.params.id));
    return getAgent(agent.id);
  }));

  // Settings: what's connected
  r.get('/settings', wrap((req) => ({
    connections: [
      { key: 'anthropic', name: 'Anthropic (Claude)', connected: managedReady(), env: 'ANTHROPIC_API_KEY', purpose: 'Powers every agent.' },
      ...integrationList().map((i) => ({ key: i.key, name: i.name, connected: i.configured, env: i.env, purpose: i.description })),
      { key: 'slack', name: 'Slack alerts', connected: slackConfigured(), env: 'SLACK_BOT_TOKEN + SLACK_ALERT_CHANNEL', purpose: 'Pings you when an agent needs approval, finishes, or gets stuck.' },
      { key: 'google', name: 'Google sign-in', connected: authMode() === 'google', env: 'GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET', purpose: 'Continue with Google for @presentail.com accounts.' },
    ],
    slack: {
      buttons: slackButtonsEnabled(),
      interactivity_url: `${req.protocol}://${req.get('host')}/slack/interactions`,
      events_url: `${req.protocol}://${req.get('host')}/slack/events`,
      approvers: approvers().length,
      conversations: verified('slack-events'),
      agents_channel: Boolean(process.env.SLACK_AGENTS_CHANNEL),
    },
  })));
  // Claude models for the agent form
  r.get('/models', wrap(async () => ({ models: await listModels() })));

  // System health
  r.get('/health', wrap(() => healthReport()));
  r.post('/health/check', wrap(() => runChecks()));

  // Backups of the database
  r.get('/backups', wrap(() => listBackups()));
  r.post('/backups', wrap(() => backupNow()));
  r.get('/backups/:name', (req, res) => {
    const path = backupPath(req.params.name);
    if (!path) return res.status(404).json({ error: 'Backup not found' });
    res.download(path, req.params.name);
  });

  // Month-end close board
  r.get('/close', wrap((req) => closeBoard({ months: Math.min(Math.max(Number(req.query.months) || 6, 1), 12) })));
  // What to prefill when starting one job for one month (the UI then creates the task, with files).
  r.get('/close/items/:id/draft/:period', wrap((req) => {
    const item = get('SELECT * FROM close_items WHERE id = ?', req.params.id);
    if (!item) throw notFound('Close item');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(req.params.period)) throw bad('period must be YYYY-MM');
    return {
      title: `${item.name} (${item.entity}): ${monthLabel(req.params.period)}`,
      description: itemInstructions(item, req.params.period),
      agent_id: item.agent_id,
      due_date: dueDate(req.params.period, item.due_day),
      close_item_id: item.id,
      period: req.params.period,
      files_hint: item.files_hint,
      priority: 'high',
    };
  }));
  r.post('/close/items', wrap((req) => {
    try {
      const item = saveCloseItem(null, req.body || {});
      emit('task', {});
      return item;
    } catch (err) {
      throw bad(err.message);
    }
  }));
  r.patch('/close/items/:id', wrap((req) => {
    if (!get('SELECT id FROM close_items WHERE id = ?', req.params.id)) throw notFound('Close item');
    try {
      const item = saveCloseItem(Number(req.params.id), req.body || {});
      emit('task', {});
      return item;
    } catch (err) {
      throw bad(err.message);
    }
  }));
  r.delete('/close/items/:id', wrap((req) => {
    run('DELETE FROM close_items WHERE id = ?', req.params.id);
    emit('task', {});
    return { ok: true };
  }));

  // Daily brief
  r.get('/brief', wrap(() => ({ brief: latestBrief(), config: briefConfig(), next_at: nextBriefAt() })));
  r.post('/brief', wrap(async () => sendBrief({ trigger: 'manual' })));
  r.put('/brief/config', wrap((req) => {
    try {
      return { config: setBriefConfig(req.body || {}), next_at: nextBriefAt() };
    } catch (err) {
      throw bad(err.message);
    }
  }));

  // Push notifications on this device
  r.get('/push', wrap(() => ({ public_key: vapidKeys().publicKey, devices: subscriptionCount() })));
  r.post('/push/subscribe', wrap((req) => {
    try {
      saveSubscription(req.body?.subscription, req.user?.email ?? req.user?.name);
    } catch (err) {
      throw bad(err.message);
    }
    return { ok: true, devices: subscriptionCount() };
  }));
  r.post('/push/unsubscribe', wrap((req) => (removeSubscription(String(req.body?.endpoint || '')), { ok: true, devices: subscriptionCount() })));
  r.post('/push/test', wrap(async () => pushToAll({ title: 'Presentail Hive', body: 'Notifications are working on this device.', url: '/#/settings' })));

  r.get('/setup', wrap(() => setupChecklist()));
  r.post('/setup', wrap((req) => {
    const { key, done, hidden } = req.body || {};
    if (typeof hidden === 'boolean') setHidden(hidden);
    if (typeof key === 'string' && key) setManualDone(key, Boolean(done));
    emit('setup', {});
    return setupChecklist();
  }));
  r.post('/settings/slack/test', wrap(async (req) => {
    if (!slackConfigured()) throw bad('Slack is not configured: set SLACK_BOT_TOKEN and SLACK_ALERT_CHANNEL in Railway');
    const result = await sendSlack({ text: `👋 Test alert from *Presentail Hive*${req.user?.name ? `, sent by ${req.user.name}` : ''}. Alerts are working.` });
    if (!result.ok) throw bad(`Slack said: ${result.error}`);
    markVerified('slack-tested');
    return { ok: true };
  }));

  r.post('/settings/odoo/test', wrap(async () => {
    try {
      const result = await testOdoo();
      markVerified('odoo-tested');
      return result;
    } catch (err) {
      throw bad(err.message);
    }
  }));
  // Every Odoo call agents made through Hive, newest first
  r.get('/odoo/actions', wrap((req) =>
    all(
      `SELECT o.id, o.model, o.method, o.company_id, o.kind, o.status, o.approved_by, o.created_at, o.run_id, a.name AS agent_name, r.task_id,
        substr(o.result, 1, 300) AS result
       FROM odoo_actions o LEFT JOIN agents a ON a.id = o.agent_id LEFT JOIN runs r ON r.id = o.run_id
       WHERE (? = 1 OR o.kind != 'read') ORDER BY o.id DESC LIMIT 200`,
      req.query.reads === '1' ? 1 : 0,
    ).map((x) => ({ ...x, company: COMPANIES[x.company_id]?.split(' (')[0] ?? null })),
  ));

  // Capabilities: what agents can be given
  r.get('/capabilities', wrap(() => ({ skills: skillLibrary(), integrations: integrationList(), managed: managedReady() })));

  // Agent photos (owners). The body is the image itself; it's checked by its bytes, not its name.
  r.post('/agents/:id/photo', express.raw({ type: () => true, limit: '4mb' }), wrap((req) => {
    if (!get('SELECT id FROM agents WHERE id = ?', req.params.id)) throw notFound('Agent');
    try {
      saveAgentPhoto(Number(req.params.id), req.body);
    } catch (err) {
      throw bad(err.message);
    }
    emit('agent', { agent_id: Number(req.params.id) });
    return getAgent(req.params.id);
  }));
  r.delete('/agents/:id/photo', wrap((req) => {
    removeAgentPhoto(Number(req.params.id));
    emit('agent', { agent_id: Number(req.params.id) });
    return getAgent(req.params.id);
  }));

  // Lessons each agent has learned from corrections
  r.get('/agents/:id/lessons', wrap((req) => listLessons(req.params.id)));
  r.post('/agents/:id/lessons', wrap((req) => {
    if (!canApproveFor(req.hive, Number(req.params.id))) throw forbidden('Only approvers and owners can teach this agent.');
    try {
      return addLesson(Number(req.params.id), req.body?.text, { source: req.body?.task_id ? 'task' : 'manual', taskId: req.body?.task_id ?? null, by: req.user?.name || null });
    } catch (err) {
      throw bad(err.message);
    }
  }));
  const lessonGuard = (req) => {
    const l = get('SELECT agent_id FROM agent_lessons WHERE id = ?', req.params.id);
    if (l && !canApproveFor(req.hive, l.agent_id)) throw forbidden('Only approvers and owners can change what this agent has learned.');
  };
  r.patch('/lessons/:id', wrap((req) => {
    lessonGuard(req);
    try {
      return updateLesson(Number(req.params.id), req.body || {});
    } catch (err) {
      throw bad(err.message);
    }
  }));
  r.delete('/lessons/:id', wrap((req) => (lessonGuard(req), deleteLesson(Number(req.params.id)), { ok: true })));

  // Messages between agents
  r.get('/agents/:id/dms', wrap((req) =>
    all(
      `SELECT d.*, f.name AS from_name, t.name AS to_name FROM agent_dms d
       LEFT JOIN agents f ON f.id = d.from_agent_id LEFT JOIN agents t ON t.id = d.to_agent_id
       WHERE d.from_agent_id = ? OR d.to_agent_id = ? ORDER BY d.id DESC LIMIT 100`,
      req.params.id, req.params.id,
    ),
  ));

  // Chat
  r.get('/agents/:id/messages', wrap((req) =>
    all('SELECT * FROM (SELECT * FROM messages WHERE agent_id = ? ORDER BY id DESC LIMIT 200) ORDER BY id', req.params.id),
  ));
  // Whether the agent is still working on its Hive chat turn (managed agents), for the typing indicator.
  r.get('/agents/:id/chat-run', wrap((req) =>
    get("SELECT id, status FROM runs WHERE kind = 'chat' AND agent_id = ? AND COALESCE(origin, 'hive') = 'hive' ORDER BY id DESC LIMIT 1", req.params.id) ?? { id: null, status: null },
  ));
  // Send a message, with files uploaded beforehand (file_ids). voice: the text is a voice note's
  // transcript and one of the files is its recording. "remember: …" also saves a lesson.
  r.post('/agents/:id/messages', wrap(async (req) => {
    const agentId = Number(req.params.id);
    const agent = get('SELECT id, name FROM agents WHERE id = ?', agentId);
    if (!agent) throw notFound('Agent');
    const body = String(req.body.body ?? '').trim();
    let files;
    try {
      files = unsentFiles(agentId, req.body.file_ids);
    } catch (err) {
      throw bad(err.message);
    }
    const voice = Boolean(req.body.voice) && files.some((f) => f.voice);
    if (voice && !body) throw bad("Couldn't make out any words in that voice note. Try again a little closer to the mic.");
    if (!body && !files.length) throw bad('Write a message or attach a file');
    const text = body || `Sent ${files.length === 1 ? 'a file' : `${files.length} files`}.`;
    const meta = { email: req.user?.email ?? null, by: req.hive.email, ...(voice ? { voice: true } : {}) };
    let agentText = voice ? `(Voice note, transcribed automatically)\n${text}` : text;

    const lesson = REMEMBER.test(body) ? body.replace(REMEMBER, '').trim() : '';
    if (lesson) {
      if (!canApproveFor(req.hive, agentId)) throw forbidden(`Only approvers and owners can teach ${agent.name}. Send it without "remember", or ask one of them.`);
      addLesson(agentId, lesson, { source: 'chat', by: req.user?.name || req.user?.email || null });
      // The running chat was set up before this lesson, so tell the agent now as well.
      agentText = `${voice ? '(Voice note, transcribed automatically) ' : ''}Remember this from now on. It is saved in your lessons, so it applies to every future chat and task too: ${lesson}`;
    }
    const message = await sendToAgent(agentId, text, meta, { files, agentText });
    if (lesson) postMessage(agentId, 'system', `🧠 Saved as a lesson. ${agent.name} will follow it in every chat and task from now on. Edit it in the Lessons tab.`);
    return message;
  }));
  r.post('/agents/:id/chat-files', express.raw({ type: () => true, limit: '50mb' }), wrap((req) => {
    if (!get('SELECT id FROM agents WHERE id = ?', req.params.id)) throw notFound('Agent');
    let name;
    try {
      name = decodeURIComponent(req.get('x-filename') || '');
    } catch {
      throw bad('Please give the file a normal name');
    }
    try {
      return saveChatFile(Number(req.params.id), name, req.body, { mime: req.get('content-type') || null, voice: req.get('x-voice') === '1', by: req.user?.email ?? null });
    } catch (err) {
      throw bad(err.message);
    }
  }));
  r.get('/chat-files/:id', (req, res, next) => {
    const f = get('SELECT * FROM chat_files WHERE id = ?', Number(req.params.id));
    if (!f) return next(notFound('File'));
    // Voice notes play in the page; everything else downloads.
    if (f.voice) return res.type(f.mime?.split(';')[0] || 'audio/webm').sendFile(f.path, (err) => err && next(notFound('File')));
    res.download(f.path, f.filename, (err) => err && !res.headersSent && next(notFound('File')));
  });

  // Tasks
  const me = (req) => personActor(req.hive);
  const taskOr404 = (id) => {
    const t = getTask(Number(id));
    if (!t) throw notFound('Task');
    return t;
  };
  /** The task, if this person may change it (see canEditTask). */
  const editable = (req) => {
    const t = taskOr404(req.params.id);
    if (!canEditTask(req.hive, t)) throw forbidden(`Only members of “${t.project_name}” can change its tasks.`);
    return t;
  };

  r.get('/tasks', wrap((req) => listTasks({ ...req.query, mine: req.query.mine === '1' }, req.hive).slice(0, 1000)));
  // A board or list: open tasks, the latest done ones (done_limit), and true counts per stage.
  r.get('/board', wrap((req) => board({ ...req.query, mine: req.query.mine === '1' }, req.hive, Math.min(Number(req.query.done_limit) || 20, 500))));
  r.get('/attention', wrap((req) => attention(req.hive, req.query.project_id ? Number(req.query.project_id) : null)));

  /**
   * Create a task. Never starts an agent unless `start: true` ("Create & start"), and the same
   * client_key never makes two tasks or two runs. `from_draft` clears the composer's draft.
   */
  r.post('/tasks', wrap(async (req) => {
    const body = req.body ?? {};
    if (body.start && !(body.assignee?.type === 'agent' || String(body.assignee ?? '').startsWith('agent:') || body.agent_id)) throw bad('Choose an AI agent to start');
    const { id } = createTask(body, me(req));
    if (body.from_draft) discardDraft(req.hive.email);
    const start = body.start ? await startExecution(id, { key: body.client_key || `create-${id}`, actor: me(req) }) : undefined;
    return { ...getTask(id), ...(start ? { start } : {}) };
  }));

  r.patch('/tasks/:id', wrap((req) => {
    const { scope, ...patch } = req.body ?? {};
    editable(req);
    return patchTask(Number(req.params.id), patch, me(req), { scope });
  }));

  // Explicitly start (or retry) the assigned agent. Safe to repeat with the same key.
  r.post('/tasks/:id/start', wrap(async (req) => {
    editable(req);
    const result = await startExecution(Number(req.params.id), { key: req.body?.key, actor: me(req) });
    return { ...getTask(Number(req.params.id)), start: result };
  }));

  // Review a task that's in Needs review: approve (done) or request changes (back to In progress).
  r.post('/tasks/:id/review', wrap(async (req) => {
    const t = taskOr404(req.params.id);
    if (t.status !== 'review') throw bad('This task is not waiting for review');
    if (!needsMe(t, req.hive) && req.hive.role !== 'owner') throw forbidden("You aren't this task's reviewer.");
    const note = String(req.body?.note ?? '').trim().slice(0, 4000);
    if (req.body?.decision === 'approve') {
      const done = patchTask(t.id, { status: 'done' }, me(req));
      taskEvent(t.id, me(req), 'approved', `Approved${note ? `: ${note}` : ''}`);
      return done;
    }
    if (req.body?.decision !== 'changes') throw bad('decision must be approve or changes');
    if (!note) throw bad('Say what needs changing');
    run("INSERT INTO task_comments (task_id, author_type, author_ref, author_name, body) VALUES (?, 'user', ?, ?, ?)", t.id, req.hive.email, req.hive.name, note);
    patchTask(t.id, { status: 'in_progress' }, me(req));
    taskEvent(t.id, me(req), 'changes', `Changes requested: ${note.slice(0, 300)}`);
    if (t.agent_id) await resumeTaskAgent(t, `${req.hive.name} reviewed "${t.title}" and asked for changes:\n${note}\n\nMake the changes, then call task_complete again.`).catch(() => {});
    return getTask(t.id);
  }));

  // Give the assignee information (clears a "waiting for information" blocker). Agents get it as a reply.
  r.post('/tasks/:id/reply', wrap(async (req) => {
    const t = taskOr404(req.params.id);
    const text = String(req.body?.text ?? '').trim().slice(0, 8000);
    if (!text) throw bad('text is required');
    run("INSERT INTO task_comments (task_id, author_type, author_ref, author_name, body) VALUES (?, 'user', ?, ?, ?)", t.id, req.hive.email, req.hive.name, text);
    clearBlocker(t.id, ['info'], me(req));
    if (t.agent_id && t.run_id) await resumeTaskAgent(t, text);
    emit('task', { task_id: t.id });
    return getTask(t.id);
  }));

  const withAvatar = (row, email) => ({ ...row, avatar_url: email ? avatarUrl(get('SELECT email, photo_source, photo_version, provider_photo FROM users WHERE email = ?', email)) : null });
  r.get('/tasks/:id/comments', wrap((req) =>
    all('SELECT * FROM task_comments WHERE task_id = ? ORDER BY id', Number(taskOr404(req.params.id).id)).map((c) => withAvatar(c, c.author_type === 'user' ? c.author_ref : null)),
  ));
  r.post('/tasks/:id/comments', wrap((req) => {
    const t = taskOr404(req.params.id);
    const body = String(req.body?.body ?? '').trim().slice(0, 8000);
    if (!body) throw bad('Write a comment first');
    const id = run("INSERT INTO task_comments (task_id, author_type, author_ref, author_name, body) VALUES (?, 'user', ?, ?, ?)", t.id, req.hive.email, req.hive.name, body).lastInsertRowid;
    emit('task', { task_id: t.id });
    return get('SELECT * FROM task_comments WHERE id = ?', id);
  }));
  r.get('/tasks/:id/events', wrap((req) =>
    all('SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 200', Number(taskOr404(req.params.id).id)).map((e) => withAvatar(e, e.actor_ref?.startsWith('user:') ? e.actor_ref.slice(5) : null)),
  ));
  r.get('/tasks/:id/links', wrap((req) => all('SELECT * FROM task_links WHERE task_id = ? ORDER BY id', Number(taskOr404(req.params.id).id))));
  r.post('/tasks/:id/links', wrap((req) => {
    const t = editable(req);
    addLinks(t.id, [{ url: req.body?.url, label: req.body?.label }], me(req), req.body?.kind === 'deliverable' ? 'deliverable' : 'reference');
    emit('task', { task_id: t.id });
    return all('SELECT * FROM task_links WHERE task_id = ? ORDER BY id', t.id);
  }));
  r.delete('/tasks/:id/links/:linkId', wrap((req) => {
    editable(req);
    run('DELETE FROM task_links WHERE id = ? AND task_id = ?', req.params.linkId, req.params.id);
    emit('task', { task_id: Number(req.params.id) });
    return { ok: true };
  }));

  // Projects
  r.get('/projects', wrap((req) => listProjects(req.hive, { status: req.query.status || 'active', q: req.query.q, favorites: req.query.favorites === '1' })));
  r.post('/projects', wrap((req) => createProject(req.body ?? {}, req.hive)));
  r.get('/projects/:id', wrap((req) => getProject(req.params.id, req.hive)));
  r.patch('/projects/:id', wrap((req) => updateProject(req.params.id, req.body ?? {}, req.hive)));
  r.delete('/projects/:id', wrap((req) => deleteProject(req.params.id, req.hive)));
  r.put('/projects/:id/favorite', wrap((req) => setFavorite(req.params.id, req.hive, true)));
  r.delete('/projects/:id/favorite', wrap((req) => setFavorite(req.params.id, req.hive, false)));
  r.get('/projects/:id/resources', wrap((req) => listResources(req.params.id)));
  r.post('/projects/:id/resources', express.raw({ type: () => true, limit: '50mb' }), wrap((req) => {
    if (req.get('x-filename')) {
      const name = cleanFilename(req.get('x-filename'));
      if (!name || !req.body?.length) throw bad('Choose a file with a normal name');
      return addResource(req.params.id, req.hive, { file: { name, body: req.body } });
    }
    const b = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8') || '{}') : req.body ?? {};
    return addResource(req.params.id, req.hive, { url: b.url, label: b.label });
  }));
  r.delete('/projects/:id/resources/:rid', wrap((req) => removeResource(req.params.id, req.params.rid, req.hive)));
  r.get('/projects/:id/resources/:rid/file', (req, res, next) => {
    const f = resourceFile(req.params.id, req.params.rid);
    if (!f) return next(notFound('File'));
    res.download(f.path, f.label);
  });
  r.get('/projects/:id/activity', wrap((req) =>
    all(
      `SELECT e.*, t.title FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE t.project_id = ? ORDER BY e.id DESC LIMIT 30`,
      Number(req.params.id),
    ),
  ));

  // The New task composer's draft (one per person; never a task until submitted)
  r.get('/task-draft', wrap((req) => getDraft(req.hive.email)));
  r.put('/task-draft', wrap((req) => saveDraft(req.hive.email, req.body?.data)));
  r.delete('/task-draft', wrap((req) => discardDraft(req.hive.email)));
  r.post('/task-draft/files', express.raw({ type: () => true, limit: '50mb' }), wrap((req) => {
    const name = cleanFilename(req.get('x-filename'));
    if (!name || !req.body?.length) throw bad('Choose a file with a normal name');
    return addDraftFile(req.hive.email, { name, body: req.body });
  }));
  r.delete('/task-draft/files/:id', wrap((req) => removeDraftFile(req.hive.email, req.params.id)));

  // Templates for the New task panel
  r.get('/task-templates', wrap(() => listTemplates()));
  r.post('/task-templates', wrap((req) => {
    const b = req.body ?? {};
    if (!b.name?.trim()) throw bad('Give the template a name');
    check(b.priority, PRIORITIES, 'priority');
    let sched;
    try {
      sched = cleanSchedule({ repeat: b.repeat ?? null, remind_days: b.remind_days ?? null, entity_id: b.entity_id ?? null });
    } catch (err) {
      throw bad(err.message);
    }
    const offset = b.start_offset_days === null || b.start_offset_days === undefined || b.start_offset_days === '' ? null : Number(b.start_offset_days);
    if (offset !== null && (!Number.isInteger(offset) || offset < 0 || offset > 366)) throw bad('Start offset must be 0 to 366 days');
    const values = {
      name: b.name.trim().slice(0, 120), title: String(b.title ?? '').slice(0, 200), description: String(b.description ?? ''), done_definition: String(b.done_definition ?? ''),
      priority: b.priority ?? 'medium', agent_id: b.agent_id ? Number(b.agent_id) : null, entity_id: sched.entity_id, start_offset_days: offset,
      remind_days: sched.remind_days, needs_approval: b.needs_approval ? 1 : 0,
    };
    if (values.agent_id && !get('SELECT id FROM agents WHERE id = ?', values.agent_id)) throw bad('Unknown agent');
    const id = Number(
      run(
        `INSERT INTO task_templates (${TEMPLATE_FIELDS.join(', ')}, rule) VALUES (${TEMPLATE_FIELDS.map(() => '?').join(', ')}, ?)`,
        ...TEMPLATE_FIELDS.map((f) => values[f]), sched.repeat ? JSON.stringify(sched.repeat) : null,
      ).lastInsertRowid,
    );
    emit('template');
    return listTemplates().find((t) => t.id === id);
  }));
  r.delete('/task-templates/:id', wrap((req) => {
    run('DELETE FROM task_templates WHERE id = ?', req.params.id);
    emit('template');
    return { ok: true };
  }));

  // Entities (companies) a task can be for
  r.get('/entities', wrap(() => all('SELECT id, code, name FROM entities ORDER BY sort, id')));
  r.post('/entities', wrap((req) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 120);
    if (!name) throw bad('name is required');
    if (get('SELECT id FROM entities WHERE name = ?', name)) throw bad('That entity already exists');
    const code = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) + '_' + Date.now().toString(36);
    const sort = (get('SELECT MAX(sort) AS s FROM entities')?.s ?? 0) + 10;
    const id = run('INSERT INTO entities (code, name, sort) VALUES (?, ?, ?)', code, name, sort).lastInsertRowid;
    emit('entity');
    return get('SELECT id, code, name FROM entities WHERE id = ?', id);
  }));

  // Due-date reminders (top of the Inbox)
  r.get('/reminders', wrap((req) =>
    all(
      `SELECT r.*, t.title, t.due_date, t.status FROM reminders r LEFT JOIN tasks t ON t.id = r.task_id
       WHERE r.read_at IS NULL AND (r.user_email IS NULL OR r.user_email = ?) ORDER BY r.id DESC LIMIT 50`,
      req.hive.email,
    ),
  ));
  r.post('/reminders/:id/read', wrap((req) => {
    run("UPDATE reminders SET read_at = datetime('now') WHERE id = ? AND (user_email IS NULL OR user_email = ?)", req.params.id, req.hive.email);
    emit('reminder');
    return { ok: true };
  }));

  // Waiting for approval: approve (the agent goes ahead and submits) or send back with a note.
  r.post('/tasks/:id/approve', wrap(async (req) => decideTask(req, true)));
  r.post('/tasks/:id/send-back', wrap(async (req) => decideTask(req, false)));

  // Older name for "start": kept for existing callers.
  r.post('/tasks/:id/dispatch', wrap(async (req) => {
    editable(req);
    const result = await startExecution(Number(req.params.id), { key: req.body?.key, actor: me(req) });
    if (!result.ok) throw bad(result.error);
    return { ok: true };
  }));

  // Hand a task to another agent for review, now.
  r.post('/tasks/:id/handoff', wrap(async (req) => {
    if (!getTask(req.params.id)) throw notFound('Task');
    try {
      const id = await handOff(Number(req.params.id), Number(req.body?.agent_id), { by: req.user?.name || 'You' });
      return getTask(id);
    } catch (err) {
      throw bad(err.message);
    }
  }));

  r.delete('/tasks/:id', wrap((req) => {
    editable(req);
    const t = get('SELECT series_id FROM tasks WHERE id = ?', req.params.id);
    if (t?.series_id && req.query.stop_series) run("UPDATE task_series SET ended_at = datetime('now') WHERE id = ?", t.series_id);
    run('DELETE FROM tasks WHERE id = ?', req.params.id);
    emit('task');
    return { ok: true };
  }));

  // Task files (inputs for the agent: statements, invoices, spreadsheets)
  r.get('/tasks/:id', wrap((req) => {
    const task = getTask(req.params.id, req.hive);
    if (!task) throw notFound('Task');
    return task;
  }));
  r.get('/tasks/:id/files', wrap((req) => all('SELECT id, task_id, filename, size, created_at FROM task_files WHERE task_id = ? ORDER BY id', req.params.id)));

  r.post('/tasks/:id/files', express.raw({ type: () => true, limit: '50mb' }), wrap((req) => {
    editable(req);
    let raw;
    try {
      raw = decodeURIComponent(req.get('x-filename') || '');
    } catch {
      throw bad('Please give the file a normal name');
    }
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
    editable(req);
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
  // Start a run for this task (the run panel's button). Same rules as /start.
  r.post('/tasks/:id/runs', wrap(async (req) => {
    editable(req);
    const result = await startExecution(Number(req.params.id), { key: req.body?.key, actor: me(req) });
    if (!result.ok) throw bad(result.error);
    const last = get("SELECT id FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1", Number(req.params.id));
    return last ? runWithEvents(last.id) : { ok: true };
  }));
  r.post('/runs/:id/reply', wrap(async (req) => {
    if (!req.body.text?.trim()) throw bad('text is required');
    await replyToRun(Number(req.params.id), req.body.text.trim());
    return { ok: true };
  }));
  r.post('/runs/:id/confirm', wrap(async (req) => {
    const target = get('SELECT agent_id FROM runs WHERE id = ?', req.params.id);
    if (!target) throw notFound('Run');
    if (!canApproveFor(req.hive, target.agent_id)) throw forbidden("You can't approve or reject this agent's actions. Ask an approver or an owner.");
    const by = req.user?.name || req.user?.email || 'Hive user';
    if (req.body.result !== 'allow' && req.body.remember && req.body.deny_message?.trim()) {
      const runRow = get('SELECT agent_id, task_id FROM runs WHERE id = ?', req.params.id);
      if (runRow) addLesson(runRow.agent_id, req.body.deny_message, { source: 'rejection', taskId: runRow.task_id, by });
    }
    await confirmTool(Number(req.params.id), req.body.event_id, req.body.result === 'allow', req.body.deny_message, {
      by: req.user?.name || req.user?.email || 'Hive user',
      approveRest: Boolean(req.body.approve_rest),
    });
    return { ok: true };
  }));
  r.get('/runs/:id/outputs/:outputId', async (req, res, next) => {
    try {
      const file = await downloadOutput(Number(req.params.id), Number(req.params.outputId));
      if (!file) return res.status(404).json({ error: 'File not found' });
      res.set('Content-Type', file.mime_type);
      res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
      res.send(file.body);
    } catch (err) {
      next(err);
    }
  });
  r.post('/runs/:id/interrupt', wrap(async (req) => {
    await interruptRun(Number(req.params.id));
    return { ok: true };
  }));

  // Recurring tasks (the Workflows screen, and each agent's Tasks → Recurring). See schedules.js.
  const scheduleCtx = (req) => ({ actor: { type: 'user', ref: req.hive.email, name: req.hive.name || req.hive.email }, user: req.hive, via: 'ui' });
  r.get('/workflows', wrap((req) =>
    listSchedules({ agent_id: req.query.agent_id, assignee: req.query.assignee, created_by: req.query.created_by, project_id: req.query.project_id, status: req.query.status }, req.hive),
  ));
  r.get('/workflows/:id', wrap((req) => scheduleDetails(req.params.id, req.hive)));

  r.post('/workflows', wrap((req) => {
    const b = req.body ?? {};
    const { schedule, notes, existing } = createSchedule(b, scheduleCtx(req));
    // Older callers could create a workflow switched off.
    if (b.enabled === false && !existing) return { ...pauseSchedule(schedule.id, scheduleCtx(req)), notes };
    return { ...schedule, notes, existing };
  }));

  r.patch('/workflows/:id', wrap((req) => {
    const { enabled, ...b } = req.body ?? {};
    let out = Object.keys(b).length ? updateSchedule(req.params.id, b, scheduleCtx(req)) : { schedule: scheduleDetails(req.params.id, req.hive), notes: [] };
    // The old on/off switch: pause or resume.
    if (enabled === false) out = { schedule: pauseSchedule(req.params.id, scheduleCtx(req)), notes: out.notes };
    if (enabled === true && out.schedule.status !== 'active') out = { schedule: resumeSchedule(req.params.id, scheduleCtx(req)), notes: out.notes };
    return { ...out.schedule, notes: out.notes };
  }));
  r.post('/workflows/:id/pause', wrap((req) => pauseSchedule(req.params.id, scheduleCtx(req))));
  r.post('/workflows/:id/resume', wrap((req) => resumeSchedule(req.params.id, scheduleCtx(req))));
  r.post('/workflows/:id/cancel', wrap((req) => cancelSchedule(req.params.id, scheduleCtx(req))));

  // Deleting removes the schedule and its history (owners only); cancelling keeps the history.
  r.delete('/workflows/:id', wrap((req) => {
    run('DELETE FROM workflows WHERE id = ?', req.params.id);
    emit('workflow');
    return { ok: true };
  }));

  // "Run now": an extra occurrence; the regular schedule is unchanged. Safe to retry with the same key.
  r.post('/workflows/:id/run', wrap(async (req) => runNow(req.params.id, scheduleCtx(req), { key: req.body?.key })));

  r.get('/workflows/:id/runs', wrap((req) => scheduleDetails(req.params.id, req.hive).runs));

  r.post('/schedule/preview', wrap((req) => previewSchedule(req.body ?? {})));

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

  // The Agent API keeps its original vocabulary ("todo", "blocked"); see agentView in tasks.js.
  r.get('/tasks', wrap((req) => {
    const wanted = new Set(req.query.status ? String(req.query.status).split(',') : ['todo', 'in_progress', 'blocked']);
    return all('SELECT * FROM tasks WHERE agent_id = ? ORDER BY id', req.agent.id)
      .map(agentView)
      .filter((t) => wanted.has(t.status) || wanted.has(t.stage));
  }));

  // Agents create tasks for themselves only, and can't pick reviewers or month-end jobs: those are
  // decisions for people in Hive (otherwise a leaked token could start work on another agent).
  r.post('/tasks', wrap((req) => {
    const { title, description, priority, due_date, status } = req.body ?? {};
    const { id } = createTask({ title, description, priority, due_date, status, agent_id: req.agent.id }, agentActor(req.agent));
    return agentView(getTask(id));
  }));

  r.patch('/tasks/:id', wrap(async (req) => {
    const task = get('SELECT * FROM tasks WHERE id = ?', req.params.id);
    if (!task || task.agent_id !== req.agent.id) throw notFound('Task');
    const { status, result, description, progress, blocked_reason } = req.body;
    const actor = agentActor(req.agent);
    // An agent marking its work done goes through review first, if it has a reviewer (or is a review).
    if (status === 'done' && (task.parent_task_id || (!task.handoff_task_id && reviewerFor(task)) || (task.needs_approval && !task.approved_at))) {
      if (description !== undefined) patchTask(task.id, { description }, actor);
      await finishTask(task.id, { summary: result ?? task.result });
      return agentView(getTask(task.id));
    }
    // "blocked" keeps the stage and records why ("waiting for information"); any other status clears it.
    const patch = { status, result, description, progress };
    if (status === 'blocked') patch.blocked = { kind: 'info', reason: blocked_reason || result || 'Blocked', owner: 'The person who assigned it' };
    else if (status && task.blocked_kind === 'info') patch.blocked = null;
    return agentView(patchTask(task.id, patch, actor));
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
