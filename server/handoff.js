// Agents handing work to each other, the way the real team works: Ledger finishes the month-end,
// Vera (Auditor) reviews it, and only then does it come to you.
//
// An agent can have a default reviewer (agents.reviewer_id) and a task can name its own
// (tasks.handoff_agent_id). When the agent says it's finished (the `task_complete` tool, or
// the Agent API), Hive opens a "Review: …" task for the reviewer with the same files and the
// agent's outputs. When the reviewer finishes, their verdict is added to the original task,
// which comes back to you for the final say. Review tasks never hand off again (no loops).
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DATA_DIR, all, get, run } from './db.js';
import { emit } from './events.js';
import { logActivity } from './activity.js';
import { dispatchTask } from './dispatch.js';
import { downloadOutput, syncOutputs } from './managed.js';
import { pushToAll } from './push.js';
import { sendSlack, baseUrl } from './notify.js';
import { readyStatus } from './taskSchedule.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const TASK_TOOL = {
  type: 'custom',
  name: 'task_complete',
  description: [
    'Call this exactly once, when the task you were given is finished. Not when you are asking a question,',
    'waiting for approval or stopping part-way. Hive then hands your work to its reviewer (if you have one) or back to the user.',
    'Save any files the reviewer should see to /mnt/session/outputs/ before calling it.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'What you did, with the key numbers, record ids and totals.' },
      check: { type: 'string', description: 'Anything the reviewer or user should look at closely (differences, assumptions, skipped items).' },
    },
    required: ['summary'],
  },
};

const agentById = (id) => (id ? get('SELECT * FROM agents WHERE id = ?', id) : null);

/** Who reviews this task's work, if anyone. */
export function reviewerFor(task) {
  if (!task || task.parent_task_id) return null;
  const id = task.handoff_agent_id || agentById(task.agent_id)?.reviewer_id;
  return id && id !== task.agent_id ? agentById(id) : null;
}

async function copyFiles(fromTaskId, toTaskId) {
  const dir = join(DATA_DIR, 'uploads', String(toTaskId));
  mkdirSync(dir, { recursive: true });
  const names = new Set();
  const add = (filename, write) => {
    let name = basename(filename).replace(/^\.+/, '') || 'file';
    for (let i = 2; names.has(name); i++) name = name.replace(/(\.[^.]*)?$/, (ext) => ` (${i})${ext || ''}`);
    names.add(name);
    const path = join(dir, name);
    const size = write(path);
    run('INSERT INTO task_files (task_id, filename, path, size) VALUES (?, ?, ?, ?)', toTaskId, name, path, size);
  };
  // The inputs the agent worked from…
  for (const f of all('SELECT * FROM task_files WHERE task_id = ? ORDER BY id', fromTaskId)) {
    try {
      add(f.filename, (path) => (copyFileSync(f.path, path), f.size));
    } catch (err) {
      console.error('[handoff] could not copy', f.filename, err.message);
    }
  }
  // …and whatever it produced (reports, workings), from its latest run.
  const lastRun = get("SELECT id FROM runs WHERE task_id = ? AND kind = 'task' ORDER BY id DESC LIMIT 1", fromTaskId);
  if (lastRun) await syncOutputs(lastRun.id, [0]).catch(() => {}); // the turn hasn't ended yet, so fetch them now
  for (const o of lastRun ? all('SELECT id FROM run_outputs WHERE run_id = ? ORDER BY id', lastRun.id) : []) {
    try {
      const out = await downloadOutput(lastRun.id, o.id);
      if (out) add(`output - ${out.filename}`, (path) => (writeFileSync(path, out.body), out.body.length));
    } catch (err) {
      console.error('[handoff] could not copy output', err.message);
    }
  }
  return [...names];
}

/** Open a review task for `reviewer` on `taskId`. Returns the new task id. */
export async function handOff(taskId, reviewerId, { summary, check, by } = {}) {
  const task = get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!task) throw new Error('Task not found');
  const reviewer = agentById(reviewerId);
  if (!reviewer) throw new Error('Unknown reviewer');
  if (reviewer.id === task.agent_id) throw new Error('An agent cannot review its own work');
  const author = agentById(task.agent_id);
  const result = summary ?? task.result ?? '';

  const description = [
    `${author?.name ?? 'An agent'}${author?.title ? ` (${author.title})` : ''} finished "${task.title}" and handed it to you for review.`,
    task.description ? `\nThe original task:\n${task.description}` : '',
    result ? `\nWhat they report:\n${result}` : '',
    check ? `\nThey ask you to check:\n${check}` : '',
    '\nReview the work (their files and outputs are attached, and you can check the source systems yourself).',
    'Do not change anything: report what is right, what is wrong, and what the user should decide.',
    'When you are done, call task_complete with your verdict.',
  ].join('\n');

  const newId = Number(
    run(
      `INSERT INTO tasks (title, description, status, priority, agent_id, parent_task_id, due_date) VALUES (?, ?, 'todo', ?, ?, ?, ?)`,
      `Review: ${task.title}`.slice(0, 200), description, task.priority, reviewer.id, task.id, task.due_date,
    ).lastInsertRowid,
  );
  await copyFiles(task.id, newId);
  run(
    "UPDATE tasks SET handoff_task_id = ?, status = 'review', result = ?, updated_at = datetime('now') WHERE id = ?",
    newId,
    `${result}${check ? `\n\nTo check: ${check}` : ''}\n\n→ Handed to ${reviewer.name} for review.${reviewer.status === 'paused' ? ` ${reviewer.name} isn't set up yet, so the review task is waiting in their queue.` : ''}`.trim(),
    task.id,
  );
  logActivity(task.agent_id, 'task', `${author?.name ?? by ?? 'Someone'} handed "${task.title}" to ${reviewer.name} for review`);
  emit('task', { task_id: task.id });
  emit('task', { task_id: newId });

  if (reviewer.status !== 'paused') dispatchTask(newId).catch((err) => console.error('[handoff] dispatch:', err.message));
  return newId;
}

/**
 * An agent says the task is finished. Hands off to the reviewer, records a review on the
 * original task, or leaves it for you. Returns what to tell the agent.
 */
export async function finishTask(taskId, { summary = '', check = '' } = {}) {
  const task = get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!task) return 'That task no longer exists.';
  const author = agentById(task.agent_id);

  // A review is done: add the verdict to the original work, which comes back to you.
  if (task.parent_task_id) {
    if (task.status === 'done') return 'Your review was already recorded.';
    const parent = get('SELECT * FROM tasks WHERE id = ?', task.parent_task_id);
    run("UPDATE tasks SET status = 'done', result = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", summary, task.id);
    if (parent) {
      const verdict = `\n\n✔ ${author?.name ?? 'Reviewer'}'s review:\n${summary}${check ? `\n\nFor you to decide: ${check}` : ''}`;
      run("UPDATE tasks SET status = ?, result = result || ?, updated_at = datetime('now') WHERE id = ?", readyStatus(parent.id), verdict, parent.id);
      emit('task', { task_id: parent.id });
      const url = `/#/tasks/${parent.id}`;
      pushToAll({ title: `${author?.name ?? 'Reviewer'} reviewed "${parent.title}"`, body: summary.slice(0, 200), url, tag: `task-${parent.id}` }).catch(() => {});
      sendSlack({ text: `🔎 *${esc(author?.name ?? 'Reviewer')}* reviewed *${esc(parent.title)}*, ready for your final say`, detail: `>${esc(summary.slice(0, 600)).replace(/\n/g, '\n>')}`, link: `${baseUrl()}${url}` });
    }
    logActivity(task.agent_id, 'task', `${author?.name ?? 'Reviewer'} finished reviewing "${parent?.title ?? task.title}"`);
    emit('task', { task_id: task.id });
    return 'Thanks. Your review has been added to the original task for the user.';
  }

  const reviewer = !task.handoff_task_id && reviewerFor(task);
  if (reviewer) {
    await handOff(task.id, reviewer.id, { summary, check });
    return `Recorded. Handed to ${reviewer.name} (${reviewer.title}) for review; the user sees both. You can stop here.`;
  }
  const status = readyStatus(task.id);
  run("UPDATE tasks SET status = ?, result = ?, updated_at = datetime('now') WHERE id = ?", status, `${summary}${check ? `\n\nTo check: ${check}` : ''}`, task.id);
  emit('task', { task_id: task.id });
  if (status === 'waiting_approval') {
    const url = `/#/tasks/${task.id}`;
    pushToAll({ title: `${author?.name ?? 'An agent'} needs your approval`, body: `${task.title}: ${summary}`.slice(0, 200), url, tag: `task-${task.id}` }).catch(() => {});
    sendSlack({ text: `✋ *${esc(author?.name ?? 'An agent')}* prepared *${esc(task.title)}* and is waiting for your approval before submitting or paying anything`, detail: `>${esc(summary.slice(0, 600)).replace(/\n/g, '\n>')}`, link: `${baseUrl()}${url}`, linkLabel: 'Approve or send back in Hive' });
    return 'Recorded. Adnan will approve it or send it back; do not submit or pay anything until you hear back. You can stop here.';
  }
  return 'Recorded. The user will review it. You can stop here.';
}
