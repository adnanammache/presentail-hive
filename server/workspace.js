// The agent workspace: a truthful status for the header, and the Work overview panel (the tasks linked
// to a conversation, what's coming up, recent files). Everything comes from runs, tasks, workflows and
// stored files; nothing is guessed from what a message says.
import { all, get } from './db.js';
import { canApproveFor } from './roles.js';
import { getTask, needsMe } from './tasks.js';
import { nextRuns } from './scheduler.js';
import { dubaiNow } from './recurrence.js';
import { canSeeChat, getChat } from './chatStore.js';

/**
 * Configuration (enabled / paused) apart from what the agent is doing right now. With several things
 * going on, the label says all of them ("2 running · 1 waiting for your approval").
 */
export function agentStatus(agent, user) {
  const config = agent.status === 'paused' ? 'paused' : 'enabled';
  const runs = all("SELECT id, kind, status, task_id FROM runs WHERE agent_id = ? AND status IN ('starting', 'running', 'needs_approval')", agent.id);
  const tasks = all(
    `SELECT t.*, h.status AS handoff_status FROM tasks t LEFT JOIN tasks h ON h.id = t.handoff_task_id
     WHERE t.agent_id = ? AND t.status != 'done' AND (t.status IN ('review', 'waiting_approval') OR t.blocked_kind IS NOT NULL)`,
    agent.id,
  );
  const working = runs.filter((r) => r.status !== 'needs_approval').length;
  const approvals = runs.filter((r) => r.status === 'needs_approval');
  const mine = (t) => needsMe(t, user) || (t.blocked_kind === 'info' && [t.created_by, t.reviewer_email].includes(user?.email));
  const review = tasks.filter((t) => ['review', 'waiting_approval'].includes(t.status) && !t.blocked_kind);
  const input = tasks.filter((t) => t.blocked_kind === 'info');
  const failed = tasks.filter((t) => t.blocked_kind === 'failed').length + (agent.status === 'error' ? 1 : 0);
  const canApprove = canApproveFor(user, agent.id);

  const parts = [];
  if (working) parts.push({ kind: 'working', count: working, text: `${working} running`, one: 'Working' });
  const forYou = review.filter(mine).length + input.filter(mine).length;
  if (forYou) parts.push({ kind: 'you', count: forYou, text: `${forYou} waiting for you`, one: 'Waiting for you' });
  if (approvals.length)
    parts.push({ kind: 'approval', count: approvals.length, text: `${approvals.length} waiting for ${canApprove ? 'your ' : ''}approval`, one: canApprove ? 'Waiting for your approval' : 'Waiting for approval' });
  const othersReview = review.filter((t) => !mine(t)).length;
  if (othersReview) parts.push({ kind: 'review', count: othersReview, text: `${othersReview} in review`, one: 'Waiting for review' });
  const othersInput = input.filter((t) => !mine(t)).length;
  if (othersInput) parts.push({ kind: 'input', count: othersInput, text: `${othersInput} waiting for input`, one: 'Waiting for input' });
  if (failed) parts.push({ kind: 'failed', count: failed, text: `${failed} failed`, one: 'Execution failed' });

  const label = !parts.length ? 'Idle' : parts.length === 1 && parts[0].count === 1 ? parts[0].one : parts.map((p) => p.text).join(' · ');
  const lead = parts.find((p) => ['you', 'approval'].includes(p.kind)) ?? parts.find((p) => p.kind === 'failed') ?? parts[0];
  const tone = !lead ? 'neutral' : { you: 'amber', approval: 'amber', failed: 'red', working: 'blue' }[lead.kind] ?? 'neutral';
  const last = get("SELECT MAX(updated_at) AS at FROM runs WHERE agent_id = ?", agent.id)?.at;
  return { config, label, tone, parts, last_activity_at: [agent.last_seen_at, last].filter(Boolean).sort().at(-1) ?? null };
}

/** The tasks explicitly linked to a conversation: created from it (in Hive or its Slack thread). */
export function chatTasks(chat, user) {
  if (!chat) return [];
  return all("SELECT id FROM tasks WHERE source_chat_id = ? ORDER BY CASE WHEN status = 'done' THEN 1 ELSE 0 END, updated_at DESC LIMIT 8", chat.id)
    .map((r) => getTask(r.id, user))
    .filter(Boolean);
}

/** What's coming up for this agent: start dates, due dates (labelled as such) and scheduled workflows. */
export function upcoming(agent) {
  const today = dubaiNow().date;
  const items = [];
  const tasks = all(
    `SELECT id, title, status, start_on, due_date, series_id FROM tasks
     WHERE agent_id = ? AND status != 'done' AND ((status = 'scheduled' AND start_on IS NOT NULL) OR due_date IS NOT NULL)`,
    agent.id,
  );
  for (const t of tasks) {
    const starts = t.status === 'scheduled' && t.start_on && t.start_on >= today;
    items.push({
      kind: 'task', id: t.id, title: t.title, recurring: Boolean(t.series_id),
      at: starts ? t.start_on : t.due_date, at_kind: starts ? 'start' : 'due', date_only: true, overdue: !starts && t.due_date < today,
    });
  }
  for (const w of all('SELECT id, name, schedule, timezone FROM workflows WHERE agent_id = ? AND enabled = 1', agent.id)) {
    const next = nextRuns(w.schedule, w.timezone)[0];
    if (next) items.push({ kind: 'workflow', id: w.id, title: w.name, recurring: true, at: new Date(next).toISOString(), at_kind: 'run', date_only: false });
  }
  const key = (i) => (i.date_only ? `${i.at}T00:00:00Z` : i.at);
  return items.filter((i) => i.at).sort((a, b) => key(a).localeCompare(key(b))).slice(0, 8);
}

/**
 * Recent files: those of this conversation (sent in it, or made by the agent in it) and of its linked
 * tasks. With none, the agent's recent task deliverables, labelled as such. Links go through the
 * routes that check access.
 */
export function recentFiles(agent, chat, linkedTasks) {
  const items = [];
  if (chat) {
    for (const f of all(
      "SELECT f.id, f.filename, f.size, f.created_at FROM chat_files f JOIN messages m ON m.id = f.message_id WHERE m.chat_id = ? AND f.voice = 0 ORDER BY f.id DESC LIMIT 10",
      chat.id,
    ))
      items.push({ key: `chat-${f.id}`, filename: f.filename, size: f.size, at: f.created_at, kind: 'shared', url: `/api/chat-files/${f.id}` });
    for (const o of all(
      "SELECT o.id, o.run_id, o.filename, o.size, o.created_at FROM run_outputs o JOIN runs r ON r.id = o.run_id WHERE r.kind = 'chat' AND r.agent_id = ? AND COALESCE(r.origin, 'hive') = ? ORDER BY o.id DESC LIMIT 10",
      agent.id, chat.origin,
    ))
      items.push({ key: `out-${o.id}`, filename: o.filename, size: o.size, at: o.created_at, kind: 'deliverable', url: `/api/runs/${o.run_id}/outputs/${o.id}` });
  }
  for (const t of linkedTasks) {
    for (const f of all('SELECT id, filename, size, created_at FROM task_files WHERE task_id = ? ORDER BY id DESC LIMIT 10', t.id))
      items.push({ key: `task-${f.id}`, filename: f.filename, size: f.size, at: f.created_at, kind: 'task', task_id: t.id, url: `/api/tasks/${t.id}/files/${f.id}/download` });
    for (const o of all("SELECT o.id, o.run_id, o.filename, o.size, o.created_at FROM run_outputs o JOIN runs r ON r.id = o.run_id WHERE r.task_id = ? ORDER BY o.id DESC LIMIT 10", t.id))
      items.push({ key: `out-${o.id}`, filename: o.filename, size: o.size, at: o.created_at, kind: 'deliverable', task_id: t.id, url: `/api/runs/${o.run_id}/outputs/${o.id}` });
  }
  if (items.length) return { scope: 'conversation', items: dedupe(items) };
  const broader = all(
    `SELECT o.id, o.run_id, o.filename, o.size, o.created_at, r.task_id FROM run_outputs o JOIN runs r ON r.id = o.run_id
     WHERE r.agent_id = ? AND r.kind = 'task' ORDER BY o.id DESC LIMIT 6`,
    agent.id,
  ).map((o) => ({ key: `out-${o.id}`, filename: o.filename, size: o.size, at: o.created_at, kind: 'deliverable', task_id: o.task_id, url: `/api/runs/${o.run_id}/outputs/${o.id}` }));
  return { scope: broader.length ? 'agent' : 'none', items: broader };
}
const dedupe = (items) => [...new Map(items.map((i) => [i.key, i])).values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);

/** Everything the workspace shows next to a conversation (chatId optional). */
export function workspace(agent, user, chatId) {
  const chat = chatId ? getChat(chatId) : null;
  const visible = chat && chat.agent_id === agent.id && canSeeChat(user, chat) ? chat : null;
  const tasks = chatTasks(visible, user);
  const tz = get('SELECT timezone FROM users WHERE email = ?', user?.email ?? '')?.timezone ?? null;
  return {
    status: agentStatus(agent, user),
    chat_id: visible?.id ?? null,
    current_tasks: tasks,
    upcoming: upcoming(agent),
    files: recentFiles(agent, visible, tasks),
    timezone: tz,
  };
}
