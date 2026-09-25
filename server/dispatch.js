// Delivers messages, tasks and workflow runs to agents.
//
// Three delivery channels, tried in order:
//   1. Claude-powered agents (platform = "claude") are answered directly through the Anthropic API.
//   2. Agents with a webhook URL (Make, n8n, Replit, custom servers) receive a JSON POST.
//      If the webhook responds with {"reply": "..."} that text is posted back into the thread.
//   3. Everything else waits in the queue — the agent picks it up via the Agent API (/api/agent/*).
import Anthropic from '@anthropic-ai/sdk';
import { all, get, run } from './db.js';
import { emit } from './events.js';
import { logActivity } from './activity.js';
import { chatWithManagedAgent, startTaskRun } from './managed.js';

const DEFAULT_MODEL = process.env.DEFAULT_CLAUDE_MODEL || 'claude-opus-5';
// Models that accept server-side refusal fallbacks (fallbacks: "default").
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);

let anthropic;
function claude() {
  anthropic ??= new Anthropic();
  return anthropic;
}
export const claudeConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

export function postMessage(agentId, sender, body, meta = null) {
  const { lastInsertRowid } = run('INSERT INTO messages (agent_id, sender, body, meta) VALUES (?, ?, ?, ?)', agentId, sender, body, meta ? JSON.stringify(meta) : null);
  const message = get('SELECT * FROM messages WHERE id = ?', lastInsertRowid);
  if (sender === 'agent') run("UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?", agentId);
  emit('message', { agent_id: agentId, message });
  return message;
}

export async function askClaude(agent, messages) {
  const model = agent.model || DEFAULT_MODEL;
  const params = {
    model,
    max_tokens: 16000,
    system:
      (agent.system_prompt || `You are ${agent.name}, ${agent.title || 'an AI agent'} at Presentail.`) +
      '\n\nYou are managed from Presentail Hive, an operations dashboard. Messages marked [System] come from the dashboard itself (task assignments, scheduled workflow runs). Reply concisely with what you did or what you need.',
    messages,
  };
  if (!model.startsWith('claude-haiku')) params.thinking = { type: 'adaptive' };
  if (FALLBACK_MODELS.has(model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const response = await claude().beta.messages.create(params);
  if (response.stop_reason === 'refusal') return '⚠️ The model declined this request.';
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || '(no text reply)';
}

/** Convert a thread into alternating user/assistant turns for the Messages API. */
function threadToMessages(agentId, limit = 40) {
  const rows = all('SELECT * FROM (SELECT * FROM messages WHERE agent_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id', agentId, limit);
  const out = [];
  for (const m of rows) {
    const role = m.sender === 'agent' ? 'assistant' : 'user';
    const text = m.sender === 'system' ? `[System] ${m.body}` : m.body;
    const last = out.at(-1);
    if (last && last.role === role) last.content += '\n\n' + text;
    else out.push({ role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function callWebhook(agent, payload) {
  const res = await fetch(agent.webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Presentail-Hive' },
    body: JSON.stringify({ ...payload, agent: { id: agent.id, name: agent.name }, callback: callbackInfo() }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Webhook returned HTTP ${res.status}`);
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    return typeof json.reply === 'string' ? json.reply : null;
  } catch {
    return null;
  }
}

function callbackInfo() {
  const base =
    process.env.PUBLIC_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${process.env.PORT || 3001}`);
  return { api: `${base}/api/agent`, auth: 'Authorization: Bearer <agent api token>' };
}

function setAgentStatus(agent, status) {
  run('UPDATE agents SET status = ? WHERE id = ?', status, agent.id);
  emit('agent', { agent_id: agent.id });
}

/**
 * Hand an event to an agent. Returns the agent's reply text (if it replied synchronously),
 * or null when the event was queued / sent fire-and-forget.
 */
export async function deliver(agent, payload) {
  if (!agent || agent.status === 'paused') return null;
  try {
    let reply = null;
    if (agent.platform === 'claude' && claudeConfigured()) {
      setAgentStatus(agent, 'active');
      reply = await askClaude(agent, threadToMessages(agent.id));
      setAgentStatus(agent, 'idle');
    } else if (agent.webhook_url) {
      reply = await callWebhook(agent, payload);
      run("UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?", agent.id);
    }
    if (reply) postMessage(agent.id, 'agent', reply);
    return reply;
  } catch (err) {
    setAgentStatus(agent, 'error');
    postMessage(agent.id, 'system', `Delivery failed: ${err.message}`);
    logActivity(agent.id, 'error', `Delivery to ${agent.name} failed: ${err.message}`);
    throw err;
  }
}

/** User sent a chat message to an agent. */
export async function sendToAgent(agentId, body, meta = null) {
  const agent = get('SELECT * FROM agents WHERE id = ?', agentId);
  const message = postMessage(agentId, 'user', body, meta);
  // Fire and forget: the UI updates over SSE when the reply lands.
  if (agent.platform === 'managed') {
    if (agent.status === 'paused') postMessage(agentId, 'system', `${agent.name} is paused. Resume it to get a reply.`);
    else chatWithManagedAgent(agentId, body);
  } else {
    deliver(agent, { event: 'message', message }).catch(() => {});
  }
  return message;
}

/** Assign a task to its agent: note it in the thread and push it out. */
export async function dispatchTask(taskId, { runId } = {}) {
  const task = get('SELECT * FROM tasks WHERE id = ?', taskId);
  const agent = task?.agent_id && get('SELECT * FROM agents WHERE id = ?', task.agent_id);
  if (!agent) return null;
  if (agent.platform === 'managed') {
    try {
      startTaskRun(task.id); // progress streams into the task's run panel
    } catch (err) {
      run("UPDATE tasks SET status = 'blocked', result = ?, updated_at = datetime('now') WHERE id = ?", `Could not start: ${err.message}`, task.id);
      emit('task', { task_id: task.id });
      throw err;
    }
    return null;
  }
  postMessage(agent.id, 'system', `New task #${task.id}: ${task.title}${task.description ? `\n\n${task.description}` : ''}`);
  const reply = await deliver(agent, { event: runId ? 'workflow.run' : 'task.assigned', task, run_id: runId ?? null });
  if (reply) {
    run("UPDATE tasks SET result = ?, status = 'review', updated_at = datetime('now') WHERE id = ?", reply, task.id);
    emit('task', { task_id: task.id });
  }
  return reply;
}
