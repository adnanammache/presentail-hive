// Each person's own view of a conversation (the chat_user_state table): whether it is archived in their
// history, how far they have read, and why it came back to their active history.
//
// Archiving only organises one person's history. It never changes the conversation, its messages or
// files, its tasks, runs, schedules or lessons, or who may see it; other people's histories are
// untouched. An archived conversation stays readable through search and links.
//
// Coming back by itself ("resurfacing") happens once per new qualifying event, at the moment it is
// stored, for each person who archived the conversation and can still see it:
//   - a new message from another person                       → "message"
//   - a new message that @mentions them (name or email)       → "mention"
//   - a new approval request in the chat they can approve     → "request"
// The agent's replies, progress and completion notes never bring it back, and an older request that
// is still unresolved never undoes a later archive: only new events count. No notification is sent
// for resurfacing; the person's usual notifications are unchanged.
import { all, get, run } from './db.js';
import { canApproveFor, knownUser } from './roles.js';
import { canSeeChat } from './chatStore.js';

const who = (user) => String(user?.email ?? '').toLowerCase();

export const readBaseline = () => Number(get("SELECT value FROM app_meta WHERE key = 'chat_read_baseline'")?.value ?? 0);

export const chatState = (chatId, user) => get('SELECT * FROM chat_user_state WHERE chat_id = ? AND user_email = ?', chatId, who(user)) ?? null;

const ensureRow = (chatId, email) => run('INSERT OR IGNORE INTO chat_user_state (chat_id, user_email) VALUES (?, ?)', chatId, email);

export const isArchivedFor = (chat, user) => Boolean(chat && user && chatState(chat.id, user)?.archived_at);

/**
 * Archive for this person. Idempotent: archiving again keeps the original archive time.
 * Returns { changed, state }.
 */
export function archiveChat(chat, user) {
  const email = who(user);
  ensureRow(chat.id, email);
  const { changes } = run(
    `UPDATE chat_user_state SET archived_at = datetime('now'), archive_seq = archive_seq + 1,
       resurfaced_at = NULL, resurfaced_reason = NULL, resurfaced_message_id = NULL, updated_at = datetime('now')
     WHERE chat_id = ? AND user_email = ? AND archived_at IS NULL`,
    chat.id, email,
  );
  return { changed: changes > 0, state: chatState(chat.id, user) };
}

/**
 * Back to this person's active history. Idempotent. `seq` (from the archive being undone) makes Undo
 * safe: if the person has since restored and archived again, a stale Undo changes nothing.
 * Restoring never touches the conversation's activity time.
 */
export function restoreChat(chat, user, { seq } = {}) {
  const email = who(user);
  const current = chatState(chat.id, user);
  if (!current?.archived_at) return { changed: false, state: current };
  if (seq != null && Number(seq) !== current.archive_seq) return { changed: false, stale: true, state: current };
  const { changes } = run(
    `UPDATE chat_user_state SET archived_at = NULL, archive_seq = archive_seq + 1, resurfaced_at = NULL, resurfaced_reason = NULL,
       resurfaced_message_id = NULL, updated_at = datetime('now')
     WHERE chat_id = ? AND user_email = ? AND archived_at IS NOT NULL AND archive_seq = ?`,
    chat.id, email, current.archive_seq,
  );
  return { changed: changes > 0, state: chatState(chat.id, user) };
}

/** Everything up to this message has been seen (never moves backwards, never past the conversation's end). */
export function markRead(chat, user, messageId) {
  const last = get('SELECT MAX(id) AS id FROM messages WHERE chat_id = ?', chat.id)?.id ?? 0;
  const upTo = Math.min(Number(messageId) || last, last);
  const email = who(user);
  ensureRow(chat.id, email);
  run(
    `UPDATE chat_user_state SET last_read_message_id = MAX(COALESCE(last_read_message_id, 0), ?), updated_at = datetime('now')
     WHERE chat_id = ? AND user_email = ?`,
    upTo, chat.id, email,
  );
  return chatState(chat.id, user);
}

/** Messages this person hasn't read: others' messages and approval requests after their read position. */
export function unreadCount(chat, user, state = chatState(chat.id, user)) {
  const after = state?.last_read_message_id ?? readBaseline();
  return get(
    `SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND id > ?
       AND (sender = 'agent' OR (sender = 'user' AND COALESCE(lower(json_extract(meta, '$.email')), '') != ?)
            OR (sender = 'system' AND json_extract(meta, '$.type') = 'approval'))`,
    chat.id, after, who(user),
  ).n;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mentions(body, person) {
  const names = [person.email, person.name].filter((n) => n && n.trim().length >= 3);
  return names.some((n) => new RegExp(`(^|[^\\w@])@${escapeRe(n.trim())}(?![\\w-])`, 'i').test(body));
}

/** Why this new message should bring the conversation back for this person, or null. */
export function resurfaceReason(chat, message, person) {
  let meta = {};
  try {
    meta = message.meta ? JSON.parse(message.meta) : {};
  } catch {
    meta = {};
  }
  const author = String(meta.email ?? meta.by ?? '').toLowerCase();
  if (message.sender === 'user' && author === person.email) return null; // their own message
  if (mentions(String(message.body ?? ''), person)) return 'mention';
  if (message.sender === 'system' && meta.type === 'approval' && canApproveFor(person, chat.agent_id)) return 'request';
  if (message.sender === 'user' && author && author !== person.email) return 'message';
  return null; // the agent's replies and progress, notes, messages without a known author
}

/** Called once for every new message (dispatch.postMessage). Returns the people it brought back. */
export function resurfaceOnMessage(chat, message) {
  const archived = all('SELECT user_email FROM chat_user_state WHERE chat_id = ? AND archived_at IS NOT NULL', chat.id);
  const back = [];
  for (const { user_email } of archived) {
    const person = knownUser(user_email);
    if (!person || person.status === 'deactivated' || !canSeeChat(person, chat)) continue;
    const reason = resurfaceReason(chat, message, person);
    if (!reason) continue;
    const { changes } = run(
      `UPDATE chat_user_state SET archived_at = NULL, archive_seq = archive_seq + 1, resurfaced_at = datetime('now'),
         resurfaced_reason = ?, resurfaced_message_id = ?, updated_at = datetime('now')
       WHERE chat_id = ? AND user_email = ? AND archived_at IS NOT NULL`,
      reason, message.id, chat.id, user_email,
    );
    if (changes) back.push({ email: user_email, reason });
  }
  return back;
}
