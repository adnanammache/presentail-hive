// Lessons: what an agent should remember from your corrections, so mistakes don't repeat.
// Saved when you reject something with a reason (and tick "remember"), teach an agent on a task,
// or DM it in Slack starting with "remember:". Every lesson goes into the agent's instructions.
import { all, get, run } from './db.js';
import { emit } from './events.js';
import { logActivity } from './activity.js';

const MAX_IN_PROMPT = 40;

export const listLessons = (agentId) =>
  all(
    `SELECT l.*, t.title AS task_title FROM agent_lessons l LEFT JOIN tasks t ON t.id = l.task_id
     WHERE l.agent_id = ? ORDER BY l.active DESC, l.id DESC`,
    agentId,
  );

export function addLesson(agentId, text, { source = 'manual', taskId = null, by = null } = {}) {
  const body = String(text ?? '').trim().slice(0, 1000);
  if (!body) throw new Error('The lesson is empty');
  const agent = get('SELECT id, name FROM agents WHERE id = ?', agentId);
  if (!agent) throw new Error('Unknown agent');
  const dup = get('SELECT id FROM agent_lessons WHERE agent_id = ? AND lower(text) = lower(?) AND active = 1', agentId, body);
  if (dup) return get('SELECT * FROM agent_lessons WHERE id = ?', dup.id);
  const id = Number(run('INSERT INTO agent_lessons (agent_id, text, source, task_id, created_by) VALUES (?, ?, ?, ?, ?)', agentId, body, source, taskId, by).lastInsertRowid);
  logActivity(agentId, 'agent', `${agent.name} learned: ${body.slice(0, 140)}${by ? ` (from ${by})` : ''}`);
  emit('lesson', { agent_id: agentId });
  return get('SELECT * FROM agent_lessons WHERE id = ?', id);
}

export function updateLesson(id, { text, active }) {
  const l = get('SELECT * FROM agent_lessons WHERE id = ?', id);
  if (!l) throw new Error('Lesson not found');
  if (text !== undefined) {
    if (!String(text).trim()) throw new Error('The lesson is empty');
    run('UPDATE agent_lessons SET text = ? WHERE id = ?', String(text).trim().slice(0, 1000), id);
  }
  if (active !== undefined) run('UPDATE agent_lessons SET active = ? WHERE id = ?', active ? 1 : 0, id);
  emit('lesson', { agent_id: l.agent_id });
  return get('SELECT * FROM agent_lessons WHERE id = ?', id);
}

export function deleteLesson(id) {
  const l = get('SELECT agent_id FROM agent_lessons WHERE id = ?', id);
  run('DELETE FROM agent_lessons WHERE id = ?', id);
  if (l) emit('lesson', { agent_id: l.agent_id });
}

/** The block added to the agent's instructions (empty when it has no lessons). */
export function lessonsBlock(agentId) {
  const rows = all('SELECT text FROM agent_lessons WHERE agent_id = ? AND active = 1 ORDER BY id DESC LIMIT ?', agentId, MAX_IN_PROMPT).reverse();
  if (!rows.length) return '';
  return [
    '## Lessons from past corrections',
    'Presentail taught you these after earlier work. Always follow them; they override your skills where they differ.',
    ...rows.map((r) => `- ${r.text.replace(/\n+/g, ' ')}`),
  ].join('\n');
}

/** "remember: …" / "lesson: …" at the start of a message. */
export const REMEMBER = /^(?:please\s+)?(?:remember|lesson|note for next time)\s*(?:that\b|[:,-])\s*/i;
