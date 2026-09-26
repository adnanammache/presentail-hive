// Conversations with an agent in Hive: listing (with each person's archive and read state), paging
// messages, sending (with files, voice notes, file references and "remember:"), the activity of the
// agent's runs in a conversation built from real run events, and the work waiting in it.
import { all, get, run } from './db.js';
import { emit } from './events.js';
import { canApproveFor } from './roles.js';
import { REMEMBER, addLesson } from './lessons.js';
import { unsentFiles } from './chatFiles.js';
import { postMessage, sendToAgent } from './dispatch.js';
import { canManageChat, canSeeChat, getChat, titleFrom, visibleChatParams, visibleChatSql } from './chatStore.js';
import { chatState, isArchivedFor, unreadCount } from './chatState.js';
import { messageRef, refForAgent } from './files.js';
import { getTask, reviewVersion } from './tasks.js';

const nameOf = (email) => (email ? get('SELECT name FROM users WHERE email = ?', email)?.name || email : null);

/** Who can read this conversation, in words (the same rule canSeeChat enforces). */
export function audience(c, user) {
  if (c.visibility === 'shared') return { scope: 'shared', label: 'Shared with everyone in the workspace' };
  if (c.created_by && c.created_by === user?.email) return { scope: 'private', label: 'Private: you and workspace owners' };
  if (!c.created_by) return { scope: 'private', label: 'Private: workspace owners' };
  return { scope: 'private', label: `Private: ${nameOf(c.created_by)} and workspace owners` };
}

export const publicChat = (c, user, state = user ? chatState(c.id, user) : null) => ({
  id: c.id,
  agent_id: c.agent_id,
  title: c.title || 'New conversation',
  visibility: c.visibility,
  audience: audience(c, user),
  source: c.origin.startsWith('slack:') ? 'slack' : 'hive',
  created_by: c.created_by,
  created_at: c.created_at,
  last_message_at: c.last_message_at,
  can_manage: canManageChat(user, c),
  // This person's own state: archived or not, and why it came back if it did.
  archived: Boolean(state?.archived_at),
  archived_at: state?.archived_at ?? null,
  archive_seq: state?.archive_seq ?? 0,
  resurfaced: state?.resurfaced_at ? { reason: state.resurfaced_reason, at: state.resurfaced_at, message_id: state.resurfaced_message_id } : null,
});

/** The conversations with this agent this person may see, most recent first (all of them, as before). */
export function listChats(agentId, user) {
  return all(
    `SELECT c.* FROM chats c WHERE c.agent_id = ? AND ${visibleChatSql('c')}
     ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC`,
    agentId, ...visibleChatParams(user),
  ).map((c) => publicChat(c, user));
}

const likeParam = (q) => `%${String(q).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const oneLine = (text, n = 90) => {
  const line = String(text ?? '').split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? '';
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};
function snippet(body, q, n = 90) {
  const text = String(body ?? '').replace(/\s+/g, ' ');
  const i = text.toLowerCase().indexOf(String(q).toLowerCase());
  if (i < 0) return oneLine(body, n);
  const start = Math.max(0, i - 30);
  const out = text.slice(start, start + n);
  return `${start > 0 ? '…' : ''}${out}${start + n < text.length ? '…' : ''}`;
}
const encodeCursor = (k, id) => Buffer.from(JSON.stringify([k, id])).toString('base64url');
function decodeCursor(c) {
  try {
    const [k, id] = JSON.parse(Buffer.from(String(c), 'base64url').toString());
    return typeof k === 'string' && Number.isInteger(id) ? { k, id } : null;
  } catch {
    return null;
  }
}

/**
 * The history panel: this person's conversations with an agent, a page at a time.
 *   filter: active (default, by latest activity) | archived (by when they archived it) | all (by activity)
 *   q: matches the title or any message in the conversation (only conversations they may see)
 * Each row: title, activity and archive times, a preview of the latest message, unread count, and what
 * is waiting in it (from runs and tasks, see chatWork).
 */
export function listConversations(agentId, user, { filter = 'active', q = '', cursor, limit = 30 } = {}) {
  if (!['active', 'archived', 'all'].includes(filter)) filter = 'active';
  const n = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const sortKey = filter === 'archived' ? 's.archived_at' : 'COALESCE(c.last_message_at, c.created_at)';
  const where = ['c.agent_id = ?', visibleChatSql('c')];
  const params = [agentId, ...visibleChatParams(user)];
  if (filter === 'active') where.push('s.archived_at IS NULL');
  if (filter === 'archived') where.push('s.archived_at IS NOT NULL');
  const query = String(q ?? '').trim().slice(0, 200);
  if (query) {
    where.push(`(c.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.sender != 'system' AND m.body LIKE ? ESCAPE '\\'))`);
    params.push(likeParam(query), likeParam(query));
  }
  const at = cursor ? decodeCursor(cursor) : null;
  if (at) {
    where.push(`(${sortKey} < ? OR (${sortKey} = ? AND c.id < ?))`);
    params.push(at.k, at.k, at.id);
  }
  const rows = all(
    `SELECT c.*, ${sortKey} AS sort_key FROM chats c
     LEFT JOIN chat_user_state s ON s.chat_id = c.id AND s.user_email = ?
     WHERE ${where.join(' AND ')}
     ORDER BY sort_key DESC, c.id DESC LIMIT ?`,
    String(user?.email ?? '').toLowerCase(), ...params, n + 1,
  );
  const page = rows.slice(0, n);
  const chats = page.map((c) => {
    const state = chatState(c.id, user);
    const last = get("SELECT sender, body, created_at FROM messages WHERE chat_id = ? AND sender != 'system' ORDER BY id DESC LIMIT 1", c.id);
    const hit = query ? get("SELECT body FROM messages WHERE chat_id = ? AND sender != 'system' AND body LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 1", c.id, likeParam(query)) : null;
    const work = chatWork(c, user);
    const lead = work.items.find((i) => i.key === work.primary);
    return {
      ...publicChat(c, user, state),
      preview: hit ? { sender: null, text: snippet(hit.body, query), match: true } : last ? { sender: last.sender, text: oneLine(last.body) } : null,
      unread: unreadCount(c, user, state),
      attention: lead ? { kind: lead.kind, label: lead.label, mine: lead.mine } : null,
    };
  });
  const tail = page.at(-1);
  return { chats, next_cursor: rows.length > n && tail ? encodeCursor(tail.sort_key, tail.id) : null, filter, q: query };
}

export function createChat(agentId, user, { title = '' } = {}) {
  const { lastInsertRowid } = run(
    "INSERT INTO chats (agent_id, origin, title, visibility, created_by) VALUES (?, ?, ?, 'private', ?)",
    agentId, `new:${Date.now()}:${Math.random()}`, titleFrom(title), user?.email ?? null,
  );
  const id = Number(lastInsertRowid);
  run('UPDATE chats SET origin = ? WHERE id = ?', `chat:${id}`, id);
  emit('chat', { agent_id: agentId, chat_id: id });
  return publicChat(getChat(id), user);
}

export function updateChat(chat, user, { title, visibility }) {
  if (title !== undefined) {
    const t = titleFrom(title);
    if (!t) throw new Error('Give the conversation a name');
    run('UPDATE chats SET title = ? WHERE id = ?', t, chat.id);
  }
  if (visibility !== undefined) {
    if (!['private', 'shared'].includes(visibility)) throw new Error('visibility must be private or shared');
    run('UPDATE chats SET visibility = ? WHERE id = ?', visibility, chat.id);
  }
  emit('chat', { agent_id: chat.agent_id, chat_id: chat.id });
  return publicChat(getChat(chat.id), user);
}

/** A page of messages, oldest first: the latest `limit`, or those before / after a message id. */
export function chatMessages(chatId, { before, after, limit = 50 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  if (after) return { messages: all('SELECT * FROM messages WHERE chat_id = ? AND id > ? ORDER BY id LIMIT 500', chatId, Number(after)), has_more: false };
  const rows = before
    ? all('SELECT * FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?', chatId, Number(before), n + 1)
    : all('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?', chatId, n + 1);
  return { messages: rows.slice(0, n).reverse(), has_more: rows.length > n };
}

/**
 * Send a person's message in a conversation. `file_ids`: files uploaded for it; `voice`: the body is a
 * voice note's transcript. "remember: …" also saves a lesson (approvers and owners only).
 */
export async function sendChatMessage(chat, user, { body: raw, file_ids, voice: isVoice, refs: rawRefs }) {
  const agent = get('SELECT id, name FROM agents WHERE id = ?', chat.agent_id);
  // Archived for this person: their draft stays, but nothing is sent until they restore it.
  if (isArchivedFor(chat, user)) {
    const err = new Error('This conversation is archived. Restore it to continue chatting.');
    err.status = 409;
    throw err;
  }
  const body = String(raw ?? '').trim();
  // Files or passages the message is about: each one checked against this person's access.
  const refs = (Array.isArray(rawRefs) ? rawRefs : []).slice(0, 5).map((r) => messageRef(r, user));
  const files = unsentFiles(chat.agent_id, file_ids);
  const voice = Boolean(isVoice) && files.some((f) => f.voice);
  if (voice && !body) throw new Error("Couldn't make out any words in that voice note. Try again a little closer to the mic.");
  if (!body && !files.length) throw new Error(refs.length ? 'Write what you want to ask about it' : 'Write a message or attach a file');
  const text = body || `Sent ${files.length === 1 ? 'a file' : `${files.length} files`}.`;
  // by: who is asking, so the agent's schedule tools know whose instruction it is (trusted, not from the model).
  const meta = { email: user?.email ?? null, by: user?.email ?? null, origin: chat.origin, ...(voice ? { voice: true } : {}), ...(refs.length ? { refs } : {}) };
  let agentText = voice ? `(Voice note, transcribed automatically)\n${text}` : text;
  if (refs.length) agentText = `${agentText}\n\n${refs.map(refForAgent).join('\n\n')}`;

  const lesson = REMEMBER.test(body) ? body.replace(REMEMBER, '').trim() : '';
  if (lesson) {
    if (!canApproveFor(user, chat.agent_id)) {
      const err = new Error(`Only approvers and owners can teach ${agent.name}. Send it without "remember", or ask one of them.`);
      err.status = 403;
      throw err;
    }
    addLesson(chat.agent_id, lesson, { source: 'chat', by: user?.name || user?.email || null, chatId: chat.id });
    // The running chat was set up before this lesson, so tell the agent now as well.
    agentText = `${voice ? '(Voice note, transcribed automatically) ' : ''}Remember this from now on. It is saved in your lessons, so it applies to every future chat and task too: ${lesson}`;
  }
  const message = await sendToAgent(chat.agent_id, text, meta, { files, agentText });
  if (lesson) postMessage(chat.agent_id, 'system', `🧠 Saved as a lesson. ${agent.name} will follow it in every chat and task from now on. Edit it in the Knowledge tab.`, { origin: chat.origin });
  return message;
}

// ---------------------------------------------------------------- activity

const STEP_TYPES = new Set(['agent.tool_use', 'agent.mcp_tool_use', 'agent.custom_tool_use']);
const ACTIVE = ['starting', 'running', 'needs_approval'];
const TOOL_LABELS = {
  bash: 'Ran a command', read: 'Read a file', write: 'Wrote a file', edit: 'Edited a file', glob: 'Looked for files', grep: 'Searched files',
  odoo: 'Odoo', wafeq_plan: 'Wafeq', message_agent: 'Asked a colleague', save_lesson: 'Saved a lesson', task_complete: 'Finished the task',
};
const clip = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * What the agent did in this conversation: its runs' tool steps, grouped into one block per stretch of
 * work between messages. Only what the run events record: step names, safe one-line summaries,
 * times, errors, and the run's status. Never thinking or raw output.
 */
export function chatActivity(chat) {
  const runs = all("SELECT id, status, error, pending, created_at, updated_at FROM runs WHERE kind = 'chat' AND agent_id = ? AND COALESCE(origin, 'hive') = ? ORDER BY id", chat.agent_id, chat.origin);
  const blocks = [];
  for (const r of runs) {
    const events = all('SELECT event_id, type, data, created_at FROM run_events WHERE run_id = ? ORDER BY id', r.id);
    let cur = null;
    const close = (state) => {
      if (!cur) return;
      cur.state = cur.error ? 'failed' : state;
      blocks.push(cur);
      cur = null;
    };
    for (const e of events) {
      const d = JSON.parse(e.data);
      if (STEP_TYPES.has(e.type)) {
        cur ??= { id: `${r.id}:${e.event_id}`, run_id: r.id, started_at: e.created_at, steps: [], errors: 0 };
        cur.steps.push({ label: TOOL_LABELS[d.name] ?? d.name, tool: d.name, detail: clip(d.name === 'odoo' || d.name === 'wafeq_plan' || d.name === 'message_agent' || d.name === 'save_lesson' ? d.detail : d.detail?.split('\n')[0]), at: e.created_at, change: d.kind === 'write' });
        cur.finished_at = e.created_at;
      } else if ((e.type === 'agent.tool_result' || e.type === 'agent.mcp_tool_result' || e.type === 'user.custom_tool_result') && d.is_error && cur?.steps.length) {
        cur.steps.at(-1).failed = true;
        cur.errors += 1;
      } else if (e.type === 'session.error') {
        cur ??= { id: `${r.id}:${e.event_id}`, run_id: r.id, started_at: e.created_at, steps: [], errors: 0 };
        cur.error = clip(d.message, 240);
        cur.finished_at = e.created_at;
      } else if (e.type === 'agent.message' || e.type === 'user.message' || e.type === 'session.status_idle') {
        close('done');
      }
    }
    if (cur) close(r.status === 'needs_approval' ? 'approval' : ACTIVE.includes(r.status) ? 'running' : r.status === 'failed' ? 'failed' : 'done');
  }
  const latest = runs.at(-1);
  return {
    run: latest
      ? { id: latest.id, status: latest.status, working: ACTIVE.includes(latest.status), needs_approval: latest.status === 'needs_approval', error: latest.status === 'failed' ? latest.error : null }
      : null,
    blocks,
  };
}

// ---------------------------------------------------------------- work waiting in a conversation

const parseList = (s) => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const pendingLabel = (p) => (p.kind === 'odoo' ? `Change Odoo: ${p.detail}` : p.kind === 'wafeq' ? `Post to Wafeq: ${p.detail}` : `Run ${p.name}${p.detail ? `: ${clip(p.detail, 120)}` : ''}`);

/** The run's latest step, from its events ("Read a file: vat.xlsx"). */
function currentStep(runId) {
  const e = get(`SELECT type, data, created_at FROM run_events WHERE run_id = ? AND type IN (${[...STEP_TYPES].map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`, runId, ...STEP_TYPES);
  if (!e) return null;
  const d = JSON.parse(e.data);
  const detail = clip(d.name === 'bash' ? '' : String(d.detail ?? '').split('\n')[0], 100);
  return { label: `${TOOL_LABELS[d.name] ?? d.name}${detail ? `: ${detail}` : ''}`, at: e.created_at };
}

// Which item the status strip leads with when several things are going on.
const PRIORITY = { approval: 0, input: 1, review: 2, failed: 3, working: 4 };

/**
 * What is going on in a conversation that someone may need to act on, from execution and task state
 * (never from what a message says): the agent's chat runs, and the tasks linked to the conversation
 * (created from it). Each item names its run or task, so Stop, Approve or Reply act on exactly that.
 *   working  a run is going (current step, reported progress)        → Stop that run
 *   approval a run waits for approval of specific calls              → Approve / Reject each call
 *   input    a task waits for information                            → Reply to that task
 *   review   a task's result waits for this person's review          → Approve / Request changes (that version)
 *   failed   the latest chat run failed, or a task's execution failed → Reply / Retry the task
 * `mine`: this person is the one who can act.
 */
export function chatWork(chat, user) {
  const items = [];
  const canApprove = canApproveFor(user, chat.agent_id);
  const agentName = get('SELECT name FROM agents WHERE id = ?', chat.agent_id)?.name ?? 'The agent';
  const runs = all("SELECT id, status, error, pending, created_at, updated_at FROM runs WHERE kind = 'chat' AND agent_id = ? AND COALESCE(origin, 'hive') = ? ORDER BY id DESC LIMIT 5", chat.agent_id, chat.origin);
  for (const r of runs.filter((x) => ACTIVE.includes(x.status))) {
    if (r.status === 'needs_approval') {
      const pending = parseList(r.pending).map((p) => ({ event_id: p.event_id, label: pendingLabel(p), kind: p.kind ?? 'tool' }));
      items.push({ key: `run:${r.id}:approval`, kind: 'approval', source: 'chat', run_id: r.id, mine: canApprove, label: canApprove ? 'Waiting for your approval' : 'Waiting for approval', title: pending[0]?.label ?? 'An action needs approval', pending, since: r.updated_at });
    } else {
      const step = currentStep(r.id);
      items.push({ key: `run:${r.id}:working`, kind: 'working', source: 'chat', run_id: r.id, mine: true, label: 'Working', title: `${agentName} is working in this conversation`, step: step?.label ?? null, since: r.created_at });
    }
  }
  const latest = runs[0];
  if (latest?.status === 'failed') items.push({ key: `run:${latest.id}:failed`, kind: 'failed', source: 'chat', run_id: latest.id, mine: true, label: 'Failed', title: `${agentName} stopped with an error`, detail: clip(latest.error, 240) || null, since: latest.updated_at });

  const tasks = all("SELECT id FROM tasks WHERE source_chat_id = ? AND status != 'done' ORDER BY updated_at DESC LIMIT 10", chat.id).map((t) => getTask(t.id, user)).filter(Boolean);
  for (const t of tasks) {
    const base = { source: 'task', task_id: t.id, task_title: t.title, run_id: t.run_id ?? null };
    if (t.run_status === 'needs_approval') {
      const r = get('SELECT pending, updated_at FROM runs WHERE id = ?', t.run_id);
      const pending = parseList(r?.pending).map((p) => ({ event_id: p.event_id, label: pendingLabel(p), kind: p.kind ?? 'tool' }));
      items.push({ ...base, key: `task:${t.id}:approval`, kind: 'approval', mine: canApprove, label: canApprove ? 'Waiting for your approval' : 'Waiting for approval', title: t.title, pending, since: r?.updated_at });
    } else if (['starting', 'running'].includes(t.run_status)) {
      items.push({ ...base, key: `task:${t.id}:working`, kind: 'working', mine: true, label: 'Working', title: t.title, step: currentStep(t.run_id)?.label ?? null, progress: t.progress, since: t.updated_at });
    }
    if (t.blocker?.kind === 'info') {
      const mine = [t.created_by, t.reviewer_email, t.assignee_email].includes(user?.email);
      items.push({ ...base, key: `task:${t.id}:input`, kind: 'input', mine, label: mine ? 'Waiting for your input' : 'Waiting for input', title: t.title, detail: t.blocker.reason ?? null, since: t.blocked_at });
    }
    if (t.blocker?.kind === 'failed') items.push({ ...base, key: `task:${t.id}:failed`, kind: 'failed', mine: Boolean(t.can_edit), label: 'Failed', title: t.title, detail: t.blocker.reason ?? null, since: t.blocked_at });
    if (['review', 'waiting_approval'].includes(t.status) && !t.blocker && t.needs_me) {
      items.push({
        ...base, key: `task:${t.id}:review`, kind: 'review', mine: true, title: t.title,
        label: t.status === 'review' ? 'Waiting for your review' : 'Waiting for your approval to submit',
        review: { mode: t.status === 'review' ? 'review' : 'submit', version: reviewVersion(t.id), deliverables: t.deliverable_count, result: clip(t.result, 280) || null },
        since: t.updated_at,
      });
    }
  }
  items.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || Number(b.mine) - Number(a.mine));
  return { items, primary: items[0]?.key ?? null };
}

/** Before archiving: what is still going on, in plain words (nothing for an idle conversation). */
export function archiveWarnings(chat, user) {
  const { items } = chatWork(chat, user);
  const out = [];
  const agentName = get('SELECT name FROM agents WHERE id = ?', chat.agent_id)?.name ?? 'The agent';
  for (const i of items) {
    if (i.kind === 'working') out.push(i.source === 'task' ? `“${i.task_title}” is running. Archiving hides this conversation from your active chats; the task will continue.` : `${agentName} is still working here. Archiving hides this conversation from your active chats; the work will continue.`);
    if (i.kind === 'approval') out.push(`${i.source === 'task' ? `“${i.task_title}”` : 'This conversation'} has an approval waiting. It stays in the approval queue and on the task.`);
    if (i.kind === 'input' && i.mine) out.push(`“${i.task_title}” is waiting for your input. It stays on the task and in your tasks.`);
    if (i.kind === 'review') out.push(`“${i.task_title}” is waiting for your review. It stays in your tasks.`);
  }
  return [...new Set(out)];
}

export { canSeeChat, canManageChat, getChat };
