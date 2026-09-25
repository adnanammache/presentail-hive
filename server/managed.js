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
import { notifyRun } from './notify.js';

const DEFAULT_MODEL = process.env.DEFAULT_CLAUDE_MODEL || 'claude-opus-5';
const ENV_NAME = process.env.HIVE_ENVIRONMENT_NAME || (process.env.NODE_ENV === 'production' ? 'presentail-hive' : 'presentail-hive-dev');
const ACTIVE = ['starting', 'running', 'needs_approval'];

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
  const hosts = [...new Set(configuredIntegrations().flatMap(([, i]) => i.hosts))].sort();
  const config = {
    type: 'cloud',
    networking: { type: 'limited', allowed_hosts: hosts, allow_package_managers: true, allow_mcp_servers: true },
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
  const integrations = configuredIntegrations();
  if (!integrations.length) return null;
  let vault = meta.get('ma:vault');
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
  const lines = [
    `You are ${agent.name}, ${agent.title || 'an agent'}${team ? ` on Presentail's ${team} team` : ' at Presentail'}.`,
    agent.description,
    agent.system_prompt,
    '',
    '## How you work (Presentail Hive)',
    '- Your work arrives as tasks from Presentail Hive. Files attached to a task are in /workspace/inputs/.',
    available.length
      ? `- Systems you can reach: ${available.map((k) => `${INTEGRATIONS[k].name} (credentials are in $${INTEGRATIONS[k].env}; use it exactly as your skills describe)`).join('; ')}.`
      : '- You have no live system access yet; work from the files and information you are given.',
    missing.length ? `- Not connected yet: ${missing.map((k) => INTEGRATIONS[k]?.name ?? k).join(', ')}. If a task needs them, say so and stop.` : '',
    '- Before writing to any live system (bills, invoices, payments, journal entries, emails), do a dry run, show a short summary (counts, totals, anything unusual) and stop to ask for an explicit go-ahead. Only write after the user approves in this conversation.',
    '- Save files meant for the user in /mnt/session/outputs/.',
    '- End every turn with a brief summary: what you did, key totals, what is left, and exactly what you need from the user.',
    '- If something is missing (a file, access, a decision), say precisely what and stop rather than guessing.',
  ];
  return lines.filter((l) => l != null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function buildAgentConfig(agent) {
  const library = skillLibrary();
  const skills = [];
  for (const key of parseList(agent.skills)) {
    const item = library.find((s) => s.key === key);
    if (item) skills.push(await ensureSkill(item));
  }
  const ask = { type: 'always_ask' };
  return {
    name: `${agent.name} · ${agent.title || 'Agent'}`.slice(0, 200),
    model: agent.model || DEFAULT_MODEL,
    system: composeSystem(agent),
    skills,
    tools: [
      {
        type: 'agent_toolset_20260401',
        default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
        // "Ask before every command": anything that can change state waits for a click in Hive.
        configs: agent.approval === 'every_command' ? ['bash', 'write', 'edit'].map((name) => ({ name, permission_policy: ask })) : [],
      },
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
  const r = setRun(runId, { status: 'failed', error: err.message || String(err) });
  setTask(r.task_id, 'blocked', `Could not run: ${err.message || err}`);
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

async function createSession(agent, { title, files = [], metadata }) {
  const synced = await syncAgent(agent.id);
  const environmentId = await ensureEnvironment();
  const vaultId = await ensureVault();
  return api().beta.sessions.create({
    agent: { type: 'agent', id: synced.ma_agent_id, version: synced.ma_agent_version },
    environment_id: environmentId,
    vault_ids: vaultId ? [vaultId] : [],
    title: title.slice(0, 200),
    resources: files.map((f) => ({ type: 'file', file_id: f.anthropic_file_id, mount_path: `/workspace/inputs/${f.filename}` })),
    metadata,
  });
}

function taskPrompt(task, files) {
  return [
    `Task #${task.id}: ${task.title}`,
    task.description ? `\n${task.description}` : '',
    task.due_date ? `\nDue: ${task.due_date}` : '',
    files.length ? `\nAttached files (in /workspace/inputs/):\n${files.map((f) => `- ${f.filename}`).join('\n')}` : '\nNo files are attached to this task.',
  ].join('');
}

/** Start a Managed Agents session working on a task. Returns immediately; progress arrives as run events. */
export function startTaskRun(taskId) {
  const task = get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!task) throw new Error('Task not found');
  const agent = task.agent_id && get('SELECT * FROM agents WHERE id = ?', task.agent_id);
  if (!agent || agent.platform !== 'managed') throw new Error('This task is not assigned to a Claude Managed Agent');
  if (agent.status === 'paused') throw new Error(`${agent.name} is paused`);
  if (!managedReady()) throw new Error('ANTHROPIC_API_KEY is not set on the server');
  if (get(`SELECT id FROM runs WHERE task_id = ? AND status IN (${ACTIVE.map(() => '?').join(',')})`, taskId, ...ACTIVE)) {
    throw new Error('This task is already running');
  }
  const runId = Number(run("INSERT INTO runs (kind, task_id, agent_id, status) VALUES ('task', ?, ?, 'starting')", taskId, agent.id).lastInsertRowid);
  setRun(runId, {});
  setTask(taskId, 'in_progress');
  logActivity(agent.id, 'task', `${agent.name} started "${task.title}"`);

  (async () => {
    const files = await uploadTaskFiles(taskId);
    const session = await createSession(agent, { title: task.title, files, metadata: { hive_task_id: String(taskId), hive_run_id: String(runId) } });
    setRun(runId, { session_id: session.id, status: 'running' });
    await sendAndFollow(runId, [{ type: 'user.message', content: [{ type: 'text', text: taskPrompt(task, files) }] }]);
  })().catch((err) => failRun(runId, err));

  return getRun(runId);
}

/** Chat with a managed agent: one long-lived session per agent. */
export async function chatWithManagedAgent(agentId, text) {
  const agent = get('SELECT * FROM agents WHERE id = ?', agentId);
  let r = get("SELECT * FROM runs WHERE kind = 'chat' AND agent_id = ? AND status NOT IN ('failed', 'ended') ORDER BY id DESC LIMIT 1", agentId);
  try {
    if (!r) {
      const runId = Number(run("INSERT INTO runs (kind, agent_id, status) VALUES ('chat', ?, 'starting')", agentId).lastInsertRowid);
      const session = await createSession(agent, { title: `Chat with ${agent.name}`, metadata: { hive_chat_agent_id: String(agentId) } });
      r = setRun(runId, { session_id: session.id, status: 'running' });
    }
    await sendAndFollow(r.id, [{ type: 'user.message', content: [{ type: 'text', text }] }]);
  } catch (err) {
    if (r) setRun(r.id, { status: 'failed', error: err.message });
    postMessage(agentId, 'system', `Could not reach ${agent.name}: ${err.message}`);
  }
}

export async function replyToRun(runId, text) {
  const r = getRun(runId);
  if (!r?.session_id || ['failed', 'ended'].includes(r.status)) throw new Error('This run has ended; start a new one');
  setRun(runId, { status: 'running' });
  setTask(r.task_id, 'in_progress');
  sendAndFollow(runId, [{ type: 'user.message', content: [{ type: 'text', text }] }]).catch((err) => failRun(runId, err));
}

export async function confirmTool(runId, eventId, allow, denyMessage) {
  const r = getRun(runId);
  const pending = parseList(r?.pending);
  if (!pending.some((p) => p.event_id === eventId)) throw new Error('That approval is no longer pending');
  const rest = pending.filter((p) => p.event_id !== eventId);
  setRun(runId, { pending: JSON.stringify(rest), status: rest.length ? 'needs_approval' : 'running' });
  if (!rest.length) setTask(r.task_id, 'in_progress');
  const event = { type: 'user.tool_confirmation', tool_use_id: eventId, result: allow ? 'allow' : 'deny' };
  if (!allow && denyMessage) event.deny_message = denyMessage;
  sendAndFollow(runId, [event]).catch((err) => failRun(runId, err));
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
export function follow(runId, attempt = 0) {
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
      return follow(runId, attempt + 1).done;
    }
    failRun(runId, err);
  });
  return { opened, done };
}

const text = (content) => (Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() : '');

function toolSummary(ev) {
  const i = ev.input || {};
  const detail = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? '';
  return { name: ev.name, detail: String(detail).slice(0, 600), permission: ev.evaluated_permission ?? null };
}

function summarize(ev) {
  switch (ev.type) {
    case 'agent.message':
      return { text: text(ev.content) };
    case 'agent.tool_use':
    case 'agent.mcp_tool_use':
      return toolSummary(ev);
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
    case 'agent.message':
      if (!data.text) break;
      setRun(runId, { last_message: data.text });
      if (r.kind === 'chat') postMessage(r.agent_id, 'agent', data.text);
      break;
    case 'session.status_idle': {
      const reason = ev.stop_reason?.type;
      if (reason === 'requires_action') {
        const ids = ev.stop_reason.event_ids ?? [];
        const pending = ids.map((id) => {
          const call = get('SELECT data FROM run_events WHERE run_id = ? AND event_id = ?', runId, id);
          return { event_id: id, ...(call ? JSON.parse(call.data) : { name: 'tool', detail: '' }) };
        });
        setRun(runId, { status: 'needs_approval', pending: JSON.stringify(pending) });
        setTask(r.task_id, 'review');
        notifyRun(runId, 'approval', { pending });
        if (r.kind === 'chat') {
          for (const p of pending) {
            postMessage(r.agent_id, 'system', `Approval needed: ${p.name}${p.detail ? `\n${p.detail}` : ''}`, { type: 'approval', run_id: runId, event_id: p.event_id });
          }
        }
      } else {
        const latest = getRun(runId);
        setRun(runId, { status: 'waiting', pending: '[]', error: reason === 'budget_reached' ? 'Budget reached' : latest.error });
        syncOutputs(runId).catch(() => {});
        if (r.kind === 'task') notifyRun(runId, 'done');
        setTask(r.task_id, 'review', latest.last_message || undefined);
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
    follow(r.id).done.catch(() => {});
  }
}

export function runWithEvents(runId) {
  const r = getRun(runId);
  if (!r) return null;
  const events = all('SELECT event_id, type, data, created_at FROM run_events WHERE run_id = ? ORDER BY id', runId).map((e) => ({ ...e, data: JSON.parse(e.data) }));
  const outputs = all('SELECT id, filename, mime_type, size, created_at FROM run_outputs WHERE run_id = ? ORDER BY id', runId);
  return { ...r, pending: parseList(r.pending), events, outputs };
}
