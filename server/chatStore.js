// Conversations with agents (the chats table): finding them, and who may see them.
// Low-level on purpose (db only), so dispatch.js can file every message into its conversation.
import { get, run } from './db.js';

export const getChat = (id) => (Number.isInteger(Number(id)) ? get('SELECT * FROM chats WHERE id = ?', Number(id)) : null);

/** A short, useful title from the first thing someone wrote. */
export function titleFrom(text) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

/**
 * The conversation for an agent and origin, created if it's new. The old single thread ("hive") is
 * shared, as it always was; anything else starts private to whoever started it.
 */
export function ensureChat(agentId, origin = 'hive', { createdBy = null, title = '' } = {}) {
  const found = get('SELECT * FROM chats WHERE agent_id = ? AND origin = ?', agentId, origin);
  if (found) return found;
  const visibility = origin === 'hive' ? 'shared' : 'private';
  const label = origin.startsWith('slack:') && title ? `Slack: ${title}` : title;
  run('INSERT OR IGNORE INTO chats (agent_id, origin, title, visibility, created_by) VALUES (?, ?, ?, ?, ?)', agentId, origin, label, visibility, createdBy);
  return get('SELECT * FROM chats WHERE agent_id = ? AND origin = ?', agentId, origin);
}

/** Private conversations: the person who started them and workspace owners. Shared: everyone. */
export function canSeeChat(user, chat) {
  if (!user || !chat) return false;
  if (chat.visibility === 'shared' || user.role === 'owner') return true;
  return Boolean(chat.created_by && chat.created_by === user.email);
}
/** Renaming and sharing: whoever started it, and owners. */
export const canManageChat = (user, chat) => Boolean(user && chat && (user.role === 'owner' || (chat.created_by && chat.created_by === user.email)));

/** SQL for "this conversation is visible to the viewer", with its two parameters. */
export const visibleChatSql = (alias = 'c') => `(${alias}.visibility = 'shared' OR ${alias}.created_by = ? OR ? = 'owner')`;
export const visibleChatParams = (user) => [user?.email ?? '', user?.role ?? ''];
