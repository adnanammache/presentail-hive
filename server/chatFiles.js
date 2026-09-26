// Files and voice notes sent to an agent in Hive's chat.
// Uploaded first (one request per file), then sent with the message that mentions them. A managed
// agent gets each file mounted in its chat session at /workspace/inputs/chat/; a voice note reaches
// it as its transcript (the recording stays in Hive for people to play back).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DATA_DIR, all, get, run } from './db.js';

export const CHAT_DIR = 'inputs/chat';
const dir = (agentId) => resolve(DATA_DIR, 'chat-uploads', String(agentId));

/** A safe, per-agent unique file name (it is also the mount path in the agent's session). */
function uniqueName(agentId, filename) {
  let name = String(filename || 'file').split(/[\\/]/).pop().replace(/[^\w.\- ()&+,]/g, '_').replace(/^\.+/, '').trim().slice(0, 180) || 'file';
  for (let i = 2; get('SELECT id FROM chat_files WHERE agent_id = ? AND filename = ?', agentId, name); i++) name = name.replace(/( \(\d+\))?(\.[^.]*)?$/, (_, _n, ext) => ` (${i})${ext || ''}`);
  return name;
}

export function saveChatFile(agentId, filename, body, { mime = null, voice = false, by = null } = {}) {
  if (!body?.length) throw new Error('Empty file');
  const name = uniqueName(agentId, filename);
  mkdirSync(dir(agentId), { recursive: true });
  const path = join(dir(agentId), name);
  writeFileSync(path, body);
  const { lastInsertRowid } = run(
    'INSERT INTO chat_files (agent_id, filename, path, size, mime, voice, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    agentId, name, path, body.length, mime, voice ? 1 : 0, by,
  );
  return publicFile(get('SELECT * FROM chat_files WHERE id = ?', lastInsertRowid));
}

export const publicFile = (f) => ({ id: f.id, filename: f.filename, size: f.size, voice: Boolean(f.voice) });

/** The uploaded files a new message may carry: this agent's, not yet sent with another message. */
export function unsentFiles(agentId, ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
  const files = wanted.length
    ? all(`SELECT * FROM chat_files WHERE agent_id = ? AND message_id IS NULL AND id IN (${wanted.map(() => '?').join(',')}) ORDER BY id`, agentId, ...wanted)
    : [];
  if (files.length !== wanted.length) throw new Error('One of the files is missing or was already sent. Attach it again.');
  return files;
}

export const linkFiles = (files, messageId) => files.forEach((f) => run('UPDATE chat_files SET message_id = ? WHERE id = ?', messageId, f.id));
