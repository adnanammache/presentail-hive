// Conversations with an agent in Hive: listing, paging messages, sending (with files, voice notes and
// "remember:"), and the activity of the agent's runs in a conversation, built from real run events.
import { all, get, run } from './db.js';
import { emit } from './events.js';
import { canApproveFor } from './roles.js';
import { REMEMBER, addLesson } from './lessons.js';
import { unsentFiles } from './chatFiles.js';
import { postMessage, sendToAgent } from './dispatch.js';
import { canManageChat, canSeeChat, getChat, titleFrom, visibleChatParams, visibleChatSql } from './chatStore.js';

export const publicChat = (c, user) => ({
  id: c.id,
  agent_id: c.agent_id,
  title: c.title || 'New conversation',
  visibility: c.visibility,
  source: c.origin.startsWith('slack:') ? 'slack' : 'hive',
  created_by: c.created_by,
  created_at: c.created_at,
  last_message_at: c.last_message_at,
  can_manage: canManageChat(user, c),
});

/** The conversations with this agent this person may see, most recent first. */
export function listChats(agentId, user) {
  return all(
    `SELECT c.* FROM chats c WHERE c.agent_id = ? AND ${visibleChatSql('c')}
     ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC`,
    agentId, ...visibleChatParams(user),
  ).map((c) => publicChat(c, user));
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
export async function sendChatMessage(chat, user, { body: raw, file_ids, voice: isVoice }) {
  const agent = get('SELECT id, name FROM agents WHERE id = ?', chat.agent_id);
  const body = String(raw ?? '').trim();
  const files = unsentFiles(chat.agent_id, file_ids);
  const voice = Boolean(isVoice) && files.some((f) => f.voice);
  if (voice && !body) throw new Error("Couldn't make out any words in that voice note. Try again a little closer to the mic.");
  if (!body && !files.length) throw new Error('Write a message or attach a file');
  const text = body || `Sent ${files.length === 1 ? 'a file' : `${files.length} files`}.`;
  // by: who is asking, so the agent's schedule tools know whose instruction it is (trusted, not from the model).
  const meta = { email: user?.email ?? null, by: user?.email ?? null, origin: chat.origin, ...(voice ? { voice: true } : {}) };
  let agentText = voice ? `(Voice note, transcribed automatically)\n${text}` : text;

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

export { canSeeChat, canManageChat, getChat };
