// Lessons: what an agent should remember from your corrections, so mistakes don't repeat.
// Saved when you reject something with a reason (and tick "remember"), teach an agent on a task,
// start a chat message (Hive or Slack) with "remember:", or when the agent itself notices you've
// told it something lasting and calls save_lesson. Every lesson goes into the agent's instructions.
import { all, get, run } from './db.js';
import { emit } from './events.js';
import { logActivity } from './activity.js';
import { canApproveFor, knownUser } from './roles.js';

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

// ---------------------------------------------------------------- lessons the agent saves itself

export const LESSON_TOOL = {
  type: 'custom',
  name: 'save_lesson',
  description: [
    'Save something the user has taught you so you remember it in every future chat and task (it becomes one of your lessons).',
    'Use it when the user tells you a lasting fact, rule or preference about your work: a deadline or filing schedule, which account',
    'or treatment to use, how they want something done. Do not save one-off instructions for the current job, your own guesses,',
    'or anything already in your lessons or skills. One call per lesson; write it as a short rule that makes sense on its own,',
    'e.g. "UAE VAT is filed quarterly; each return is due on the 28th of the month after the quarter ends." Then tell the user what you saved.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: { lesson: { type: 'string', description: 'The rule or fact, self-contained, one or two sentences' } },
    required: ['lesson'],
  },
};

/** Who taught the agent in this run: whoever last wrote in the chat, or whoever created the task. */
export function teacherOf(r) {
  let email = null;
  if (r.kind === 'chat') {
    const m = get(
      `SELECT meta FROM messages WHERE agent_id = ? AND sender = 'user' AND COALESCE(json_extract(meta, '$.origin'), 'hive') = ? ORDER BY id DESC LIMIT 1`,
      r.agent_id, r.origin ?? 'hive',
    );
    email = m?.meta ? JSON.parse(m.meta).email ?? null : null;
  } else if (r.task_id) email = get('SELECT created_by FROM tasks WHERE id = ?', r.task_id)?.created_by ?? null;
  const user = email ? knownUser(email) : null;
  return { user, name: user?.name || email };
}

/**
 * The agent called save_lesson. Taught by an approver or owner: the lesson is live. Otherwise it
 * is saved switched off, for an approver to turn on. Returns what to tell the agent and the chat.
 */
export function learnFromRun(r, input) {
  if (r.kind === 'consult') return { text: 'Another agent asked you this, so there is nothing to save here.', isError: true };
  const text = String(input?.lesson ?? '').trim();
  if (!text) return { text: 'The lesson is empty.', isError: true };
  if (get('SELECT id FROM agent_lessons WHERE agent_id = ? AND lower(text) = lower(?) AND active = 1', r.agent_id, text)) return { text: 'That is already one of your lessons.' };
  const { user, name } = teacherOf(r);
  const trusted = canApproveFor(user, r.agent_id);
  const lesson = addLesson(r.agent_id, text, { source: 'agent', taskId: r.task_id ?? null, by: name });
  if (!trusted) updateLesson(lesson.id, { active: false });
  return trusted
    ? { text: 'Saved. It is now one of your lessons, so it applies to every future chat and task.', note: `🧠 Saved as a lesson: “${text}”. Edit or remove it in the Lessons tab.` }
    : {
        text: 'Saved as a suggestion, switched off until an approver or owner turns it on in your Lessons tab. Tell the user that.',
        note: `🧠 Suggested a lesson: “${text}”. An approver or owner can switch it on in the Lessons tab.`,
      };
}
