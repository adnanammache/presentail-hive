// Runs Hive agents on Claude Managed Agents.
//
//   Hive agent  ──sync──▶  Managed agent (model, system prompt, skills, tools, approval rule)
//   Hive task   ──run───▶  Session (task files mounted, integration secrets from a vault)
//   Session events ──────▶ run_events (live activity, approvals, replies, cost) ──SSE──▶ UI
//
// Everything Anthropic-side is created lazily and remembered in app_meta / the agents table,
// so the first task an agent runs sets things up and later runs reuse it.
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { all, get, run, update } from './db.js';
import { emit } from './events.js';
import { logActivity } from './activity.js';
import { INTEGRATIONS, parseList, skillFiles, skillHash, skillLibrary } from './capabilities.js';
import { postMessage } from './dispatch.js';
import { notifyRun, settleApprovalAlert } from './notify.js';
import { TASK_TOOL, finishTask } from './handoff.js';
import { AGENT_DM_TOOL, askAgent } from './conversations.js';
import { lessonsBlock } from './lessons.js';
import { briefExtras, readyStatus } from './taskSchedule.js';
import { clearBlocker, setBlocker } from './tasks.js';
import { formatDay } from './recurrence.js';
import { wafeqTool, clearPlan, executePlan, gatewayConfig, planSummary } from './wafeq.js';
import { baseUrl } from './notify.js';
import { checkBudget, checkThresholds } from './budget.js';
import { recordHealth } from './health.js';
import { odooTool, checkAgentCall, classify, describeCall, formatResult, odooCall } from './odoo.js';

const DEFAULT_MODEL = process.env.DEFAULT_CLAUDE_MODEL || 'claude-opus-5';
const ENV_NAME = process.env.HIVE_ENVIRONMENT_NAME || (process.env.NODE_ENV === 'production' ? 'presentail-hive' : 'presentail-hive-dev');
const ACTIVE = ['starting', 'running', 'needs_approval'];
const NEVER_ASK = 'automatic (agent set to Never ask)';

let client;
/** Tests inject a fake client here. */
export const setManagedClient = (c) => (client = c);
const api = () => (client ??= new Anthropic());
export const managedReady = () => Boolean(client || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const meta = {
  get: (key) => {
    const row = get('SELECT value FROM app_meta WHERE key = ?', key);
    return row ? JSON.parse(row.value) : null;
  },
  set: (key, value) => run('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value)),
};

const configuredIntegrations = () => Object.entries(INTEGRATIONS).filter(([, i]) => process.env[i.env]);

// ---------------------------------------------------------------- infrastructure

/** One shared sandbox environment: tools the skills need, and network access only to our integrations. */
export async function ensureEnvironment() {
  const hosts = [...new Set(configuredIntegrations().flatMap(([, i]) => i.hosts))];
  // Wafeq goes through Hive's gateway, so the sandbox needs to reach Hive (and only Hive) for it.
  if (process.env.WAFEQ_API_KEY) {
    try {
      hosts.push(new URL(baseUrl()).hostname);
    } catch {}
  }
  hosts.sort();
  const config = {
    type: 'cloud',
    networking: { type: 'limited', allowed_hosts: hosts, allow_package_managers: true, allow_mcp_servers: false },
    packages: { apt: ['poppler-utils'], pip: ['openpyxl', 'pdfplumber'] },
  };
  const h = hash(config);
  const saved = meta.get('ma:environment');
  if (saved?.hash === h) return saved.id;

  let id = saved?.id;
  if (id) {
    await api().beta.environments.update(id, { config });
  } else {
    try {
      id = (await api().beta.environments.create({ name: ENV_NAME, config })).id;
    } catch (err) {
      if (err?.status !== 409) throw err;
      // Already exists (e.g. the database was restored): adopt it.
      for await (const env of api().beta.environments.list()) if (env.name === ENV_NAME) id = env.id;
      if (!id) throw err;
      await api().beta.environments.update(id, { config });
    }
  }
  meta.set('ma:environment', { id, hash: h });
  return id;
}

/** A vault holding integration secrets. The sandbox only ever sees placeholders; Anthropic swaps the real value in at egress. */
export async function ensureVault() {
  // Integrations Hive runs itself (Odoo) never go to the vault.
  const integrations = configuredIntegrations().filter(([, i]) => i.via !== 'hive');
  let vault = meta.get('ma:vault');
  // Integrations that moved to going through Hive: take their old credential out of the vault.
  for (const [key, i] of Object.entries(INTEGRATIONS)) {
    const saved = i.via === 'hive' ? meta.get(`ma:cred:${key}`) : null;
    if (saved?.id && vault) {
      await api().beta.vaults.credentials.archive(saved.id, { vault_id: vault.id }).catch(() => {});
      run('DELETE FROM app_meta WHERE key = ?', `ma:cred:${key}`);
    }
  }
  if (!integrations.length) return null;
  if (!vault) {
    vault = { id: (await api().beta.vaults.create({ display_name: `Presentail Hive (${ENV_NAME})` })).id };
    meta.set('ma:vault', vault);
  }
  for (const [key, i] of integrations) {
    const secretHash = hash([i.env, process.env[i.env], i.hosts]);
    const saved = meta.get(`ma:cred:${key}`);
    if (saved?.hash === secretHash) continue;
    if (saved?.id) await api().beta.vaults.credentials.archive(saved.id, { vault_id: vault.id }).catch(() => {});
    const cred = await api().beta.vaults.credentials.create(vault.id, {
      display_name: `${i.name} (${i.env})`,
      auth: {
        type: 'environment_variable',
        secret_name: i.env,
        secret_value: process.env[i.env],
        networking: { type: 'limited', allowed_hosts: i.hosts },
        injection_location: { header: true },
      },
    });
    meta.set(`ma:cred:${key}`, { id: cred.id, hash: secretHash });
  }
  return vault.id;
}

/** Upload (or re-version) a Presentail skill from agent-skills/, returning the agent's skill reference. */
async function ensureSkill(item) {
  if (item.source === 'anthropic') return { type: 'anthropic', skill_id: item.skill_id };
  const h = skillHash(item.key);
  const saved = meta.get(`skill:${item.key}`);
  if (saved?.hash === h) return { type: 'custom', skill_id: saved.id, version: 'latest' };
  const files = await Promise.all(skillFiles(item.key).map((f) => toFile(f.content, f.path)));
  const id = saved?.id
    ? (await api().skills.versions.create(saved.id, { files }), saved.id)
    : (await api().skills.create({ files, display_name: item.name })).id;
  meta.set(`skill:${item.key}`, { id, hash: h });
  return { type: 'custom', skill_id: id, version: 'latest' };
}

// ---------------------------------------------------------------- agents

export function composeSystem(agent) {
  const team = agent.team_id ? get('SELECT name FROM teams WHERE id = ?', agent.team_id)?.name : null;
  const wanted = parseList(agent.integrations);
  const available = wanted.filter((k) => INTEGRATIONS[k] && process.env[INTEGRATIONS[k].env]);
  const missing = wanted.filter((k) => !available.includes(k));
  const autonomous = agent.approval === 'autonomous';
  const lines = [
    `You are ${agent.name}, ${agent.title || 'an agent'}${team ? ` on Presentail's ${team} team` : ' at Presentail'}.`,
    agent.description,
    agent.system_prompt,
    '',
    '## How you work (Presentail Hive)',
    '- Your work arrives as tasks from Presentail Hive. Files attached to a task are in /workspace/inputs/.',
    available.length
      ? `- Systems you can reach: ${available
          .map((k) =>
            k === 'wafeq'
              ? `Wafeq (through Hive: your Wafeq scripts read the address from /workspace/hive/wafeq.json automatically. Reads are live; writes are queued, not sent: the scripts report them as QUEUED. After a real run, call \`wafeq_plan\` with action "submit"; ${autonomous ? 'Hive posts the whole batch straight away' : 'a person approves the whole batch and Hive posts it'}, then tells you the real ids. Never try to reach api.wafeq.com directly)`
              : INTEGRATIONS[k].via === 'hive'
              ? `${INTEGRATIONS[k].name} (through the \`${k}\` tool; Hive runs each call, ${autonomous ? 'reads and changes alike run immediately' : 'reads are immediate and every change waits for a person to approve it, so say what you are about to change and why before calling'})`
              : `${INTEGRATIONS[k].name} (credentials are in $${INTEGRATIONS[k].env}; use it exactly as your skills describe)`,
          )
          .join('; ')}.`
      : '- You have no live system access yet; work from the files and information you are given.',
    missing.length ? `- Not connected yet: ${missing.map((k) => INTEGRATIONS[k]?.name ?? k).join(', ')}. If a task needs them, say so and stop.` : '',
    autonomous
      ? '- You are trusted to post without asking. Once your checks pass (a dry run, totals, duplicates), write to live systems (bills, invoices, payments, journal entries) straight away: do not stop for a go-ahead, even where a skill says to wait after the dry run. The one exception is a task that itself says it needs approval: then stop and ask as it describes. Otherwise stop only when something is genuinely wrong or missing.'
      : '- Before writing to any live system (bills, invoices, payments, journal entries, emails), do a dry run, show a short summary (counts, totals, anything unusual) and stop to ask for an explicit go-ahead. Only write after the user approves in this conversation.',
    '- Save files meant for the user in /mnt/session/outputs/.',
    '- End every turn with a brief summary: what you did, key totals, what is left, and exactly what you need from the user.',
    '- If something is missing (a file, access, a decision), say precisely what and stop rather than guessing.',
    '',
    lessonsBlock(agent.id),
  ];
  return lines.filter((l) => l != null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function buildAgentConfig(agent) {
  const library = skillLibrary();
  const skills = [];
  const keys = parseList(agent.skills);
  // Agents with Odoo always get the guide to using the odoo tool.
  if (parseList(agent.integrations).includes('odoo') && !keys.includes('hive-odoo')) keys.unshift('hive-odoo');
  for (const key of keys) {
    const item = library.find((s) => s.key === key);
    if (item) skills.push(await ensureSkill(item));
  }
  const ask = { type: 'always_ask' };
  // "Never ask": the owner trusts this agent to post on its own.
  const autonomous = agent.approval === 'autonomous';
  // Agents holding a credential for a system Hive doesn't broker (used from bash) must have every
  // command approved, since that's the only gate on their writes, unless they are set to never ask.
  const vaulted = parseList(agent.integrations).some((k) => INTEGRATIONS[k] && INTEGRATIONS[k].via !== 'hive');
  const askEveryCommand = agent.approval === 'every_command' || (vaulted && !autonomous);
  return {
    name: `${agent.name} · ${agent.title || 'Agent'}`.slice(0, 200),
    model: agent.model || DEFAULT_MODEL,
    system: composeSystem(agent),
    skills,
    tools: [
      {
        type: 'agent_toolset_20260401',
        default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
        configs: [
          // "Ask before every command": anything that can change state waits for a click in Hive.
          ...(askEveryCommand ? ['bash', 'write', 'edit'].map((name) => ({ name, permission_policy: ask })) : []),
          // Web tools run on Anthropic's servers, outside the sandbox's network limits: a way for
          // injected instructions to send data out. Presentail's agents don't need them.
          { name: 'web_fetch', enabled: false },
          { name: 'web_search', enabled: false },
        ],
      },
      ...(parseList(agent.integrations).includes('odoo') ? [odooTool({ autonomous })] : []),
      ...(parseList(agent.integrations).includes('wafeq') ? [wafeqTool({ autonomous })] : []),
      TASK_TOOL,
      AGENT_DM_TOOL,
    ],
    metadata: { hive_agent_id: String(agent.id) },
  };
}

/** Create or update this agent on Claude Managed Agents. No-op when nothing changed. */
export async function syncAgent(agentId) {
  const agent = get('SELECT * FROM agents WHERE id = ?', agentId);
  if (!agent) throw new Error('Agent not found');
  if (agent.platform !== 'managed') throw new Error(`${agent.name} is not a Claude Managed Agent`);
  if (!managedReady()) throw new Error('ANTHROPIC_API_KEY is not set on the server');
  try {
    const config = await buildAgentConfig(agent);
    const h = hash(config);
    if (agent.ma_agent_id && agent.ma_config_hash === h) return get('SELECT * FROM agents WHERE id = ?', agentId);

    let remote;
    if (agent.ma_agent_id) {
      try {
        remote = await api().beta.agents.update(agent.ma_agent_id, { ...config, version: agent.ma_agent_version });
      } catch (err) {
        if (err?.status !== 409) throw err; // edited elsewhere: retry on top of the latest version
        const latest = await api().beta.agents.retrieve(agent.ma_agent_id);
        remote = await api().beta.agents.update(agent.ma_agent_id, { ...config, version: latest.version });
      }
    } else {
      remote = await api().beta.agents.create(config);
    }
    run('UPDATE agents SET ma_agent_id = ?, ma_agent_version = ?, ma_config_hash = ?, ma_sync_error = NULL WHERE id = ?', remote.id, remote.version, h, agentId);
    logActivity(agentId, 'agent', `${agent.name} synced to Claude Managed Agents (v${remote.version})`);
  } catch (err) {
    run('UPDATE agents SET ma_sync_error = ? WHERE id = ?', err.message, agentId);
    emit('agent', { agent_id: agentId });
    throw err;
  }
  emit('agent', { agent_id: agentId });
  return get('SELECT * FROM agents WHERE id = ?', agentId);
}

// ---------------------------------------------------------------- runs

const getRun = (id) => get('SELECT * FROM runs WHERE id = ?', id);
const RUN_FIELDS = ['session_id', 'status', 'pending', 'last_message', 'error', 'cost_cents'];

function setRun(id, patch) {
  update('runs', id, patch, RUN_FIELDS);
  run("UPDATE runs SET updated_at = datetime('now') WHERE id = ?", id);
  const r = getRun(id);
  emit('run', { run_id: id, task_id: r?.task_id ?? null, agent_id: r?.agent_id ?? null });
  return r;
}

function setTask(taskId, status, result) {
  if (!taskId) return;
  const task = get('SELECT status FROM tasks WHERE id = ?', taskId);
  if (!task || task.status === 'done') return;
  if (result !== undefined) run("UPDATE tasks SET status = ?, result = ?, updated_at = datetime('now') WHERE id = ?", status, result, taskId);
  else run("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?", status, taskId);
  emit('task', { task_id: taskId });
}

function failRun(runId, err) {
  // API-level failures (auth, overload, network) say Claude isn't working; others are the task's own.
  if (err?.status || /api key|authentication|overloaded|ECONN|fetch failed|timed out/i.test(err?.message ?? '')) recordHealth('anthropic', false, err.message);
  const r = setRun(runId, { status: 'failed', error: err.message || String(err) });
  // The task keeps its stage; the failure is a blocker you can see and retry.
  if (r.task_id) setBlocker(r.task_id, { kind: 'failed', reason: `Could not run: ${err.message || err}` });
  logActivity(r.agent_id, 'error', `Run #${runId} failed: ${err.message || err}`);
  notifyRun(runId, 'failed');
}

async function uploadTaskFiles(taskId) {
  const files = all('SELECT * FROM task_files WHERE task_id = ? ORDER BY id', taskId);
  for (const f of files) {
    if (f.anthropic_file_id) continue;
    const uploaded = await api().beta.files.upload({ file: await toFile(await readFile(f.path), f.filename) });
    run('UPDATE task_files SET anthropic_file_id = ? WHERE id = ?', uploaded.id, f.id);
    f.anthropic_file_id = uploaded.id;
  }
  return files;
}

async function createSession(agent, { title, files = [], metadata, runId }) {
  const synced = await syncAgent(agent.id);
  const environmentId = await ensureEnvironment();
  const vaultId = await ensureVault();
  const resources = files.map((f) => ({ type: 'file', file_id: f.anthropic_file_id, mount_path: `/workspace/inputs/${f.filename}` }));
  // Agents with Wafeq get this run's gateway address (reads live, writes queued for approval).
  if (runId && parseList(agent.integrations).includes('wafeq') && process.env.WAFEQ_API_KEY) {
    const config = await api().beta.files.upload({ file: await toFile(Buffer.from(JSON.stringify(gatewayConfig(baseUrl(), runId), null, 2)), 'wafeq.json') });
    resources.push({ type: 'file', file_id: config.id, mount_path: '/workspace/hive/wafeq.json' });
  }
  return api().beta.sessions.create({
    agent: { type: 'agent', id: synced.ma_agent_id, version: synced.ma_agent_version },
    environment_id: environmentId,
    vault_ids: vaultId ? [vaultId] : [],
    title: title.slice(0, 200),
    resources,
    metadata,
  });
}

function taskPrompt(task, files, note) {
  const extras = briefExtras(task);
  return [
    `Task #${task.id}: ${task.title}`,
    task.description ? `\n${task.description}` : '',
    task.due_date ? `\nDue: ${formatDay(task.due_date)}` : '',
    extras.length ? `\n${extras.join('\n')}` : '',
    note ? `\n\n${note}` : '',
    files.length ? `\nAttached files (in /workspace/inputs/):\n${files.map((f) => `- ${f.filename}`).join('\n')}` : '\nNo files are attached to this task.',
  ].join('');
}

/** Start a Managed Agents session working on a task. Returns immediately; progress arrives as run events. */
export function startTaskRun(taskId, { note } = {}) {
  const task = get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!task) throw new Error('Task not found');
  const agent = task.agent_id && get('SELECT * FROM agents WHERE id = ?', task.agent_id);
  if (!agent || agent.platform !== 'managed') throw new Error('This task is not assigned to a Claude Managed Agent');
  if (agent.status === 'paused') throw new Error(`${agent.name} is paused`);
  if (!managedReady()) throw new Error('ANTHROPIC_API_KEY is not set on the server');
  checkBudget(agent.id);
  if (get(`SELECT id FROM runs WHERE task_id = ? AND status IN (${ACTIVE.map(() => '?').join(',')})`, taskId, ...ACTIVE)) {
    throw new Error('This task is already running');
  }
  const runId = Number(run("INSERT INTO runs (kind, task_id, agent_id, status) VALUES ('task', ?, ?, 'starting')", taskId, agent.id).lastInsertRowid);
  setRun(runId, {});
  setTask(taskId, 'in_progress');
  logActivity(agent.id, 'task', `${agent.name} started "${task.title}"`);

  (async () => {
    const files = await uploadTaskFiles(taskId);
    const session = await createSession(agent, { title: task.title, files, runId, metadata: { hive_task_id: String(taskId), hive_run_id: String(runId) } });
    setRun(runId, { session_id: session.id, status: 'running' });
    recordHealth('anthropic', true);
    await sendAndFollow(runId, [{ type: 'user.message', content: [{ type: 'text', text: taskPrompt(task, files, note) }] }]);
  })().catch((err) => failRun(runId, err));

  return getRun(runId);
}

/**
 * Chat with a managed agent. Each conversation has its own session: Hive's chat is one, and every
 * Slack thread is another, so people never see each other's conversations or get each other's answers.
 */
export async function chatWithManagedAgent(agentId, text, { origin = 'hive' } = {}) {
  const agent = get('SELECT * FROM agents WHERE id = ?', agentId);
  const say = (msg) => postMessage(agentId, 'system', msg, { origin });
  let r = get("SELECT * FROM runs WHERE kind = 'chat' AND agent_id = ? AND COALESCE(origin, 'hive') = ? AND status NOT IN ('failed', 'ended') ORDER BY id DESC LIMIT 1", agentId, origin);
  try {
    checkBudget(agentId);
  } catch (err) {
    return say(err.message);
  }
  if (r && parseList(r.pending).length) return say(`${agent.name} is waiting for an approval first. Approve or reject it, then send your message again.`);
  try {
    if (!r) {
      const runId = Number(run("INSERT INTO runs (kind, agent_id, status, origin) VALUES ('chat', ?, 'starting', ?)", agentId, origin).lastInsertRowid);
      const session = await createSession(agent, { title: `Chat with ${agent.name}`, runId, metadata: { hive_chat_agent_id: String(agentId) } });
      r = setRun(runId, { session_id: session.id, status: 'running' });
    }
    run('UPDATE runs SET auto_approve = 0 WHERE id = ?', r.id);
    // Mark the run active before following: after an earlier turn it is "waiting", and follow()
    // stops as soon as its history replay sees an inactive run, which would drop this reply until
    // the next message replays it.
    setRun(r.id, { status: 'running' });
    await sendAndFollow(r.id, [{ type: 'user.message', content: [{ type: 'text', text }] }]);
  } catch (err) {
    if (r) setRun(r.id, { status: 'failed', error: err.message });
    say(`Could not reach ${agent.name}: ${err.message}`);
  }
}

/**
 * Another agent asks this managed agent a question: a fresh session, one turn, and its answer.
 * Waits up to `timeoutMs`; if the agent needs an approval meanwhile, a person approves it in Hive.
 */
export async function consultManagedAgent(agentId, text, { timeoutMs = 15 * 60 * 1000, title = 'Question from a colleague' } = {}) {
  const agent = get('SELECT * FROM agents WHERE id = ?', agentId);
  checkBudget(agentId);
  const runId = Number(run("INSERT INTO runs (kind, agent_id, status) VALUES ('consult', ?, 'starting')", agentId).lastInsertRowid);
  try {
    const session = await createSession(agent, { title, runId, metadata: { hive_consult_run_id: String(runId) } });
    setRun(runId, { session_id: session.id, status: 'running' });
    await sendAndFollow(runId, [{ type: 'user.message', content: [{ type: 'text', text }] }]);
  } catch (err) {
    setRun(runId, { status: 'failed', error: err.message });
    throw err;
  }
  const started = Date.now();
  for (;;) {
    const r = getRun(runId);
    if (r.status === 'waiting' || r.status === 'ended') return { runId, text: r.last_message || '(no answer)' };
    if (r.status === 'failed') throw new Error(r.error || 'failed');
    if (Date.now() - started > timeoutMs) {
      // Whoever asked has moved on: don't leave approvals behind that nobody is waiting for.
      const pending = parseList(r.pending);
      if (pending.length) await confirmMany(runId, pending.map((p) => p.event_id), false, { by: 'Hive (the question timed out)', denyMessage: 'The colleague who asked has moved on.' }).catch(() => {});
      await interruptRun(runId).catch(() => {});
      return { runId, text: r.last_message || null, timedOut: true, needsApproval: pending.length > 0 };
    }
    await new Promise((res) => setTimeout(res, 500));
  }
}

export async function replyToRun(runId, text) {
  const r = getRun(runId);
  if (!r?.session_id || ['failed', 'ended'].includes(r.status)) throw new Error('This run has ended; start a new one');
  if (parseList(r.pending).length) throw new Error('The agent is waiting for an approval. Approve or reject it first, then reply.');
  checkBudget(r.agent_id);
  run('UPDATE runs SET auto_approve = 0 WHERE id = ?', runId);
  setRun(runId, { status: 'running' });
  setTask(r.task_id, 'in_progress');
  if (r.task_id) clearBlocker(r.task_id, ['info']);
  sendAndFollow(runId, [{ type: 'user.message', content: [{ type: 'text', text }] }]).catch((err) => failRun(runId, err));
}

export async function confirmTool(runId, eventId, allow, denyMessage, { by = 'Hive user', approveRest = false } = {}) {
  const r = getRun(runId);
  const pending = parseList(r?.pending);
  const item = pending.find((p) => p.event_id === eventId);
  if (!item) throw new Error('That approval is no longer pending');
  // "Approve the rest of this turn": this and the agent's further Odoo changes until it next stops
  // and hands back. Only on task runs; chats and consults are shared and long-lived.
  if (allow && approveRest) {
    if (r.kind !== 'task') throw new Error('"Approve the rest" is only available on tasks. Approve each change here.');
    run('UPDATE runs SET auto_approve = 1 WHERE id = ?', runId);
  }
  const resolving = allow && approveRest ? pending.filter((p) => p.event_id === eventId || p.kind === 'odoo') : [item];
  await resolvePending(runId, resolving, allow, denyMessage, by);
}

/**
 * Approve or reject several pending calls at once (e.g. from a Slack button). Only the listed
 * event ids are touched, so nobody approves something they weren't shown.
 * Returns how many were still pending.
 */
export async function confirmMany(runId, eventIds, allow, { by = 'Hive user', denyMessage } = {}) {
  const pending = parseList(getRun(runId)?.pending);
  const resolving = pending.filter((p) => eventIds.includes(p.event_id));
  if (resolving.length) await resolvePending(runId, resolving, allow, denyMessage, by);
  return resolving.length;
}

async function resolvePending(runId, resolving, allow, denyMessage, by) {
  const r = getRun(runId);
  const rest = parseList(r.pending).filter((p) => !resolving.some((x) => x.event_id === p.event_id));
  setRun(runId, { pending: JSON.stringify(rest), status: rest.length ? 'needs_approval' : 'running' });
  if (!rest.length) {
    setTask(r.task_id, 'in_progress');
    if (r.task_id) clearBlocker(r.task_id, ['approval'], by);
    settleApprovalAlert(runId, `${allow ? '✅ Approved' : '⛔ Rejected'} by ${by}`);
  }

  const events = [];
  for (const p of resolving) {
    if (p.kind === 'wafeq') {
      const text = allow
        ? (await executePlan(runId, by, p.steps)).text
        : (clearPlan(runId), `Rejected by ${by}${denyMessage ? `: ${denyMessage}` : ''}. Nothing was sent to Wafeq and the queue was cleared.`);
      if (allow) logActivity(r.agent_id, 'task', `Wafeq batch approved by ${by}: ${p.detail}`);
      events.push({ type: 'user.custom_tool_result', custom_tool_use_id: p.event_id, content: [{ type: 'text', text }], ...(/^Stopped|^Rejected/.test(text) ? { is_error: true } : {}) });
      continue;
    }
    if (p.kind === 'odoo') {
      if (allow) events.push(await executeOdoo(runId, p.event_id, by));
      else {
        const why = `Rejected by ${by}${denyMessage ? `: ${denyMessage}` : ''}. Nothing was changed in Odoo.`;
        run("UPDATE odoo_actions SET status = 'rejected', approved_by = ?, result = ?, finished_at = datetime('now') WHERE event_id = ?", by, why, p.event_id);
        events.push({ type: 'user.custom_tool_result', custom_tool_use_id: p.event_id, content: [{ type: 'text', text: why }], is_error: true });
      }
    } else {
      const event = { type: 'user.tool_confirmation', tool_use_id: p.event_id, result: allow ? 'allow' : 'deny' };
      if (!allow && denyMessage) event.deny_message = denyMessage;
      events.push(event);
    }
  }
  logActivity(r.agent_id, 'task', `${allow ? 'Approved' : 'Rejected'} ${resolving.length} action${resolving.length === 1 ? '' : 's'} on run #${runId} (${by})`);
  sendAndFollow(runId, events).catch((err) => failRun(runId, err));
}

// ---------------------------------------------------------------- Odoo calls (custom tool)

function recordOdooCall(runId, agentId, eventId, input) {
  const kind = classify(input?.model, input?.method);
  run(
    `INSERT OR IGNORE INTO odoo_actions (run_id, agent_id, event_id, model, method, company_id, input, kind, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
    runId, agentId, eventId, String(input?.model ?? ''), String(input?.method ?? ''), Number(input?.company_id) || null, JSON.stringify(input ?? {}), kind,
  );
}

async function executeOdoo(runId, eventId, by) {
  const action = get('SELECT * FROM odoo_actions WHERE event_id = ?', eventId);
  const result = (text, isError) => ({ type: 'user.custom_tool_result', custom_tool_use_id: eventId, content: [{ type: 'text', text }], ...(isError ? { is_error: true } : {}) });
  if (!action) return result('Unknown tool call', true);
  try {
    const text = formatResult(await odooCall(JSON.parse(action.input)));
    run("UPDATE odoo_actions SET status = 'executed', approved_by = ?, result = ?, finished_at = datetime('now') WHERE id = ?", by, text.slice(0, 20000), action.id);
    if (action.kind === 'write') logActivity(action.agent_id, 'task', `Odoo ${action.model}.${action.method} approved by ${by}`);
    return result(text);
  } catch (err) {
    run("UPDATE odoo_actions SET status = 'failed', approved_by = ?, result = ?, finished_at = datetime('now') WHERE id = ?", by, err.message, action.id);
    return result(err.message, true);
  }
}

function odooPendingItem(action) {
  const input = JSON.parse(action.input);
  const payload = { ...(input.ids ? { ids: input.ids } : {}), ...(input.params ?? {}) };
  return {
    event_id: action.event_id,
    kind: 'odoo',
    name: 'odoo',
    detail: describeCall(input),
    reason: input.reason ?? '',
    preview: JSON.stringify(payload, null, 2), // in full: approvers see everything that will be sent
  };
}

/** The agent is paused on tool calls: answer Odoo reads now, queue Odoo changes for approval. */
async function resolveToolCalls(runId, customIds, builtinPending) {
  const r = getRun(runId);
  // "Never ask": changes run without an approval (never for consults, which stay read-only).
  const autonomous = r.kind !== 'consult' && get('SELECT approval FROM agents WHERE id = ?', r.agent_id)?.approval === 'autonomous';
  const results = [];
  const waiting = [];
  customIds = customIds.filter((id) => !resolving.has(id));
  customIds.forEach((id) => resolving.add(id));
  for (const id of customIds) {
    const call = JSON.parse(get('SELECT data FROM run_events WHERE run_id = ? AND event_id = ?', runId, id)?.data ?? '{}');
    if (call.name === 'wafeq_plan') {
      const action = call.input?.action;
      const reply = (text, isError) => results.push({ type: 'user.custom_tool_result', custom_tool_use_id: id, content: [{ type: 'text', text }], ...(isError ? { is_error: true } : {}) });
      const plan = planSummary(runId);
      if (action === 'clear') {
        clearPlan(runId);
        reply(`Cleared ${plan.steps.length} queued change${plan.steps.length === 1 ? '' : 's'}. Nothing was sent to Wafeq.`);
      } else if (action === 'show') {
        reply(plan.steps.length ? `${plan.headline} queued:\n${plan.full}`.slice(0, 60000) : 'Nothing is queued.');
      } else if (action === 'submit') {
        if (!plan.steps.length) reply('Nothing is queued. Run the script for real (without --dry-run) first; its writes are queued, then submit.', true);
        else if (r.kind === 'consult') reply('You were asked this by another agent, so you cannot post to Wafeq here. Tell them what should change.', true);
        else if (autonomous) {
          const sent = await executePlan(runId, NEVER_ASK, plan.steps.map((st) => st.id));
          logActivity(r.agent_id, 'task', `Wafeq batch posted without approval (Never ask): ${plan.headline}`);
          reply(sent.text, !sent.ok);
        } else
          waiting.push({
            event_id: id,
            kind: 'wafeq',
            name: 'wafeq',
            detail: `${plan.headline}${call.input?.reason ? `: ${call.input.reason}` : ''}`,
            reason: call.input?.reason ?? '',
            steps: plan.steps.map((st) => st.id),
            lines: plan.steps.map((st) => `${st.seq}. ${st.method} ${st.path}${st.summary ? `: ${st.summary}` : ''}`).join('\n'),
            preview: plan.full,
          });
      } else reply('action must be "submit", "show" or "clear".', true);
      continue;
    }
    if (call.name === 'message_agent') {
      const reply =
        r.kind === 'consult'
          ? { text: 'You were asked a question by another agent, so you cannot message others from here. Answer with what you know.', is_error: true }
          : await askAgent(r.agent_id, call.input?.agent, call.input?.message, { runId });
      results.push({ type: 'user.custom_tool_result', custom_tool_use_id: id, content: [{ type: 'text', text: reply.text }], ...(reply.is_error ? { is_error: true } : {}) });
      continue;
    }
    if (call.name === 'task_complete') {
      const reply = r.task_id ? await finishTask(r.task_id, call.input ?? {}) : 'There is no task in a chat. Just reply to the user.';
      results.push({ type: 'user.custom_tool_result', custom_tool_use_id: id, content: [{ type: 'text', text: reply }] });
      continue;
    }
    const action = get('SELECT * FROM odoo_actions WHERE event_id = ?', id);
    if (!action) {
      results.push({ type: 'user.custom_tool_result', custom_tool_use_id: id, content: [{ type: 'text', text: 'Unknown tool' }], is_error: true });
    } else if (action.kind === 'forbidden' || checkAgentCall(JSON.parse(action.input)) || (r.kind === 'consult' && action.kind === 'write')) {
      const problem = checkAgentCall(JSON.parse(action.input));
      const msg =
        action.kind === 'forbidden'
          ? `${action.model}.${action.method} is not allowed through Hive (secrets, users, settings and accounting configuration are off-limits). Ask the user to do this in Odoo.`
          : problem
            ? `Not run: ${problem}`
            : 'You were asked this by another agent, so you can only read from Odoo here. Tell them what should change; they or the user will do it.';
      run("UPDATE odoo_actions SET status = 'refused', result = ?, finished_at = datetime('now') WHERE id = ?", msg, action.id);
      results.push({ type: 'user.custom_tool_result', custom_tool_use_id: id, content: [{ type: 'text', text: msg }], is_error: true });
    } else if (action.kind === 'read' || r.auto_approve || autonomous) {
      results.push(await executeOdoo(runId, id, action.kind === 'read' ? 'automatic (read-only)' : r.auto_approve ? 'approved for this run' : NEVER_ASK));
    } else {
      run("UPDATE odoo_actions SET status = 'pending' WHERE id = ?", action.id);
      waiting.push(odooPendingItem(action));
    }
  }
  const pending = [...builtinPending, ...waiting];
  if (pending.length) askForApproval(runId, pending);
  else setRun(runId, { status: 'running', pending: '[]' });
  if (results.length) await sendAndFollow(runId, results);
}

function askForApproval(runId, pending) {
  const r = setRun(runId, { status: 'needs_approval', pending: JSON.stringify(pending) });
  // Still in progress, but blocked until someone approves (shown as "Waiting for approval").
  if (r.task_id) setBlocker(r.task_id, { kind: 'approval', reason: pending.map((p) => (p.kind === 'odoo' ? `Change Odoo: ${p.detail}` : p.kind === 'wafeq' ? `Post to Wafeq: ${p.detail}` : `Run ${p.name}`)).join('; '), owner: 'An approver' });
  notifyRun(runId, 'approval', { pending });
  if (r.kind === 'chat') {
    for (const p of pending) {
      const text = p.kind === 'odoo' ? `Approval needed: change Odoo, ${p.detail}${p.reason ? `\n${p.reason}` : ''}` : `Approval needed: ${p.name}${p.detail ? `\n${p.detail}` : ''}`;
      postMessage(r.agent_id, 'system', text, { type: 'approval', run_id: runId, event_id: p.event_id });
    }
  }
}

export async function interruptRun(runId) {
  const r = getRun(runId);
  if (!r?.session_id) throw new Error('Run has no session');
  await api().beta.sessions.events.send(r.session_id, { events: [{ type: 'user.interrupt' }] });
}

// ---------------------------------------------------------------- event stream

const followers = new Map(); // runId -> Stream being consumed

/** Stream-first: open the event stream, then send, so no early events are missed. */
async function sendAndFollow(runId, events) {
  const r = getRun(runId);
  const following = follow(runId);
  await following.opened;
  await api().beta.sessions.events.send(r.session_id, { events });
  return following.done;
}

/** Consume a session's events until it goes idle/terminates. History is replayed first and deduped, so gaps are covered. */
const resolving = new Set(); // custom tool call ids being answered right now (no double answers)

export function follow(runId, attempt = 0, { resume = false } = {}) {
  followers.get(runId)?.controller?.abort();
  let markOpened;
  const opened = new Promise((resolve) => (markOpened = resolve));
  const done = (async () => {
    const r = getRun(runId);
    let stream;
    try {
      stream = await api().beta.sessions.events.stream(r.session_id);
    } finally {
      markOpened();
    }
    followers.set(runId, stream);
    try {
      for await (const ev of api().beta.sessions.events.list(r.session_id)) handleEvent(runId, ev);
      if (!ACTIVE.includes(getRun(runId).status)) return; // it finished while we weren't listening
      if (resume) recoverToolCalls(runId).catch((err) => failRun(runId, err));
      for await (const ev of stream) {
        handleEvent(runId, ev);
        if (ev.type === 'session.status_idle' || ev.type === 'session.status_terminated') break;
      }
    } finally {
      if (followers.get(runId) === stream) followers.delete(runId);
      stream.controller?.abort();
    }
  })().catch(async (err) => {
    if (err?.name === 'AbortError' || err?.constructor?.name === 'APIUserAbortError') return;
    const current = getRun(runId);
    if (current && ACTIVE.includes(current.status) && attempt < 5) {
      await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
      return follow(runId, attempt + 1, { resume }).done;
    }
    failRun(runId, err);
  });
  return { opened, done };
}

const text = (content) => (Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() : '');

function toolSummary(ev) {
  const i = ev.input || {};
  const detail = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? '';
  // Whatever an approver is asked to approve is shown in full: the whole command, and for file
  // writes and edits, the content itself (not just the path).
  const preview = ['write', 'edit'].includes(ev.name) ? JSON.stringify(i, null, 2) : undefined;
  return { name: ev.name, detail: String(detail).slice(0, 20000), ...(preview ? { preview: preview.slice(0, 50000) } : {}), permission: ev.evaluated_permission ?? null };
}

function summarize(ev) {
  switch (ev.type) {
    case 'agent.message':
      return { text: text(ev.content) };
    case 'agent.tool_use':
    case 'agent.mcp_tool_use':
      return toolSummary(ev);
    case 'agent.custom_tool_use':
      if (ev.name === 'task_complete') return { name: 'task_complete', detail: String(ev.input?.summary ?? '').slice(0, 600), kind: 'custom', input: ev.input ?? {} };
      if (ev.name === 'wafeq_plan') return { name: 'wafeq_plan', detail: `${ev.input?.action ?? ''}${ev.input?.reason ? `: ${ev.input.reason}` : ''}`, kind: 'custom', input: ev.input ?? {} };
      if (ev.name === 'message_agent') return { name: 'message_agent', detail: `→ ${ev.input?.agent ?? '?'}: ${String(ev.input?.message ?? '').slice(0, 500)}`, kind: 'custom', input: ev.input ?? {} };
      return { name: ev.name, detail: ev.name === 'odoo' ? describeCall(ev.input || {}) : '', kind: ev.name === 'odoo' ? classify(ev.input?.model, ev.input?.method) : 'custom' };
    case 'user.custom_tool_result':
      return { is_error: Boolean(ev.is_error), preview: text(ev.content).slice(0, 300), tool_use_id: ev.custom_tool_use_id };
    case 'agent.tool_result':
    case 'agent.mcp_tool_result':
      return { is_error: Boolean(ev.is_error), preview: text(ev.content).slice(0, 400) };
    case 'session.status_idle':
      return { stop_reason: ev.stop_reason ?? null };
    case 'session.error':
      return { message: ev.error?.message ?? ev.message ?? 'Session error' };
    case 'session.usage':
      return { cost_cents: Number(ev.usage?.list_cost?.amount ?? 0) };
    case 'user.message':
      return { text: text(ev.content) };
    case 'user.tool_confirmation':
      return { result: ev.result, tool_use_id: ev.tool_use_id };
    default:
      return {};
  }
}

/** Store an event once and apply its effect on the run, task and chat. */
export function handleEvent(runId, ev) {
  if (!ev?.id || !ev.type || ev.type.startsWith('event_')) return;
  const data = summarize(ev);
  const inserted = run('INSERT OR IGNORE INTO run_events (run_id, event_id, type, data) VALUES (?, ?, ?, ?)', runId, ev.id, ev.type, JSON.stringify(data));
  if (!inserted.changes) return;
  const r = getRun(runId);

  switch (ev.type) {
    case 'session.status_running':
      if (r.status !== 'needs_approval') setRun(runId, { status: 'running' });
      break;
    case 'agent.custom_tool_use':
      if (ev.name === 'odoo') recordOdooCall(runId, r.agent_id, ev.id, ev.input);
      emit('run', { run_id: runId, task_id: r.task_id, agent_id: r.agent_id });
      break;
    case 'agent.message':
      if (!data.text) break;
      setRun(runId, { last_message: data.text });
      if (r.kind === 'chat') postMessage(r.agent_id, 'agent', data.text, { run_id: runId, origin: r.origin ?? 'hive' });
      break;
    case 'session.status_idle': {
      const reason = ev.stop_reason?.type;
      if (reason === 'requires_action') {
        const calls = (ev.stop_reason.event_ids ?? []).map((id) => ({ id, row: get('SELECT type, data FROM run_events WHERE run_id = ? AND event_id = ?', runId, id) }));
        const custom = calls.filter((c) => c.row?.type === 'agent.custom_tool_use').map((c) => c.id);
        const builtin = calls
          .filter((c) => c.row?.type !== 'agent.custom_tool_use')
          .map((c) => ({ event_id: c.id, ...(c.row ? JSON.parse(c.row.data) : { name: 'tool', detail: '' }) }));
        if (custom.length) resolveToolCalls(runId, custom, builtin).catch((err) => failRun(runId, err));
        else askForApproval(runId, builtin);
      } else {
        const latest = getRun(runId);
        run('UPDATE runs SET auto_approve = 0 WHERE id = ?', runId); // "approve the rest" ends with the turn
        setRun(runId, { status: 'waiting', pending: '[]', error: reason === 'budget_reached' ? 'Budget reached' : latest.error });
        syncOutputs(runId).catch(() => {});
        // If the agent called task_complete since the user last spoke, that already filed the result
        // (and maybe handed it to a reviewer), so don't overwrite it with the sign-off message.
        const finished = get(
          `SELECT MAX(CASE WHEN type = 'agent.custom_tool_use' AND data LIKE '%"name":"task_complete"%' THEN id END) AS done,
                  MAX(CASE WHEN type = 'user.message' THEN id END) AS spoke FROM run_events WHERE run_id = ?`,
          runId,
        );
        if (finished.done && finished.done > (finished.spoke ?? 0)) break;
        if (r.kind === 'task') notifyRun(runId, 'done');
        setTask(r.task_id, readyStatus(r.task_id), latest.last_message || undefined);
        if (r.task_id) clearBlocker(r.task_id, ['approval', 'info']);
        if (r.task_id) logActivity(r.agent_id, 'task', `Run #${runId} is waiting for your review`);
      }
      break;
    }
    case 'session.status_terminated':
      setRun(runId, { status: 'ended' });
      break;
    case 'session.error':
      setRun(runId, { error: data.message });
      break;
    case 'session.usage':
      setRun(runId, { cost_cents: data.cost_cents });
      checkThresholds(r.agent_id);
      break;
    default:
      emit('run', { run_id: runId, task_id: r.task_id, agent_id: r.agent_id });
  }
}

/** Collect files the agent saved to /mnt/session/outputs/ (they appear a moment after the turn ends). */
export async function syncOutputs(runId, delays = [1500, 4000, 8000]) {
  const r = getRun(runId);
  if (!r?.session_id) return [];
  const inputs = new Set(all('SELECT anthropic_file_id FROM task_files WHERE task_id = ?', r.task_id ?? -1).map((f) => f.anthropic_file_id));
  for (const delay of delays) {
    await new Promise((res) => setTimeout(res, delay));
    let added = 0;
    for await (const f of api().beta.files.list({ scope_id: r.session_id, betas: ['managed-agents-2026-04-01'] })) {
      if (inputs.has(f.id) || f.downloadable === false) continue;
      added += run(
        'INSERT OR IGNORE INTO run_outputs (run_id, file_id, filename, mime_type, size) VALUES (?, ?, ?, ?, ?)',
        runId, f.id, f.filename, f.mime_type || 'application/octet-stream', f.size_bytes || 0,
      ).changes;
    }
    if (added) {
      emit('run', { run_id: runId, task_id: r.task_id, agent_id: r.agent_id });
      break;
    }
  }
  return all('SELECT * FROM run_outputs WHERE run_id = ? ORDER BY id', runId);
}

export async function downloadOutput(runId, outputId) {
  const out = get('SELECT * FROM run_outputs WHERE id = ? AND run_id = ?', outputId, runId);
  if (!out) return null;
  const response = await api().beta.files.download(out.file_id);
  return { ...out, body: Buffer.from(await response.arrayBuffer()) };
}

/** After a restart, pick up runs that were mid-flight. */
export function resumeRuns() {
  if (!managedReady()) return;
  for (const r of all("SELECT * FROM runs WHERE status IN ('starting', 'running')")) {
    if (!r.session_id) {
      failRun(r.id, new Error('Interrupted by a server restart before the session started'));
      continue;
    }
    follow(r.id, 0, { resume: true }).done.catch(() => {});
  }
}

/**
 * After a restart: the agent may be paused on tool calls Hive never answered (the process stopped
 * mid-way). Answer them now. Odoo changes that already ran are reported, never run twice.
 */
export async function recoverToolCalls(runId) {
  const r = getRun(runId);
  if (r?.status !== 'running') return;
  const answered = new Set(
    all("SELECT data FROM run_events WHERE run_id = ? AND type = 'user.custom_tool_result'", runId).map((e) => JSON.parse(e.data).tool_use_id),
  );
  const waitingApproval = new Set(parseList(r.pending).map((p) => p.event_id));
  const open = all("SELECT event_id FROM run_events WHERE run_id = ? AND type = 'agent.custom_tool_use' ORDER BY id", runId)
    .map((e) => e.event_id)
    .filter((id) => !answered.has(id) && !waitingApproval.has(id) && !resolving.has(id));
  if (!open.length) return;
  const toResolve = [];
  const results = [];
  for (const id of open) {
    const action = get('SELECT * FROM odoo_actions WHERE event_id = ?', id);
    if (action && !['queued', 'pending'].includes(action.status)) {
      // Already decided before the restart: send what happened instead of running it again.
      results.push({ type: 'user.custom_tool_result', custom_tool_use_id: id, content: [{ type: 'text', text: action.result || action.status }], ...(action.status === 'executed' ? {} : { is_error: true }) });
    } else toResolve.push(id);
  }
  if (results.length) await sendAndFollow(runId, results);
  if (toResolve.length) await resolveToolCalls(runId, toResolve, []);
}

export function runWithEvents(runId) {
  const r = getRun(runId);
  if (!r) return null;
  const events = all('SELECT event_id, type, data, created_at FROM run_events WHERE run_id = ? ORDER BY id', runId).map((e) => ({ ...e, data: JSON.parse(e.data) }));
  const outputs = all('SELECT id, filename, mime_type, size, created_at FROM run_outputs WHERE run_id = ? ORDER BY id', runId);
  return { ...r, pending: parseList(r.pending), events, outputs };
}
