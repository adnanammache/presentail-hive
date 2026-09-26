// Agents creating tasks: "make this a recurring task for me" in a chat becomes a real task in Hive.
//
// The agent calls `create_task`. Asked by an owner or approver (or the agent is set to Never ask),
// the task is created right away; anyone else's request waits for an approver, like an Odoo change.
// A created task never starts work by itself: no start date, and its repeats don't auto-start, so
// a person always decides when an agent begins.
import { all, get } from './db.js';
import { findAgent } from './conversations.js';
import { teacherOf } from './lessons.js';
import { canApproveFor } from './roles.js';
import { agentActor, createTask } from './tasks.js';
import { describeRule, formatDay, isDate, normalizeRule } from './recurrence.js';
import { cleanSchedule } from './taskSchedule.js';

export const CREATE_TASK_TOOL = {
  type: 'custom',
  name: 'create_task',
  description: [
    'Create a task in Hive, the team\'s task board: a one-off job or a repeating one (e.g. "prepare the UAE VAT documents every quarter").',
    'Use it when the user asks you to create, schedule or set up a task or reminder. It does not start any work: it puts the task on the board',
    'for the person or agent it is assigned to. Include a due date if there is one (required to repeat). Then tell the user what you created.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short and specific, e.g. "Prepare UAE VAT documents (Presentail Flowers Trading LLC)"' },
      description: { type: 'string', description: 'What needs doing, with the details and context someone needs to do it' },
      assignee: {
        type: 'string',
        description: '"me" (the user you are talking to), "you" (yourself), another agent\'s name, or a colleague\'s name or email. Default "me".',
      },
      due_date: { type: 'string', description: 'YYYY-MM-DD. For a repeating task, the first due date.' },
      repeat: { type: 'string', enum: ['none', 'monthly', 'quarterly', 'yearly'], description: 'How often it comes back. Default none.' },
      remind_days: { type: 'integer', description: 'Remind the assignee this many days before the due date (optional)' },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
      reason: { type: 'string', description: 'Why you are creating it (shown to whoever approves it)' },
    },
    required: ['title'],
  },
};

const clean = (s) => String(s ?? '').trim();

/** "me" / "you" / an agent / a person → { assignee, label } or { error }. */
function resolveAssignee(value, r, requester) {
  const v = clean(value).replace(/^@/, '');
  const lower = v.toLowerCase();
  if (!v || ['me', 'myself', 'the user', 'user'].includes(lower)) {
    if (!requester?.email) return { error: 'I could not tell who "me" is here. Name the person (or "you" for yourself).' };
    return { assignee: { type: 'user', email: requester.email }, label: requester.name || requester.email };
  }
  const self = get('SELECT id, name FROM agents WHERE id = ?', r.agent_id);
  if (['you', 'yourself', 'self', 'agent'].includes(lower) || lower === self.name.toLowerCase()) return { assignee: { type: 'agent', id: self.id }, label: self.name };
  const people = all("SELECT email, name FROM users WHERE status = 'active'");
  const person =
    people.find((p) => p.email.toLowerCase() === lower) ??
    people.find((p) => clean(p.name).toLowerCase() === lower) ??
    people.find((p) => clean(p.name).toLowerCase().split(/\s+/)[0] === lower);
  if (person) return { assignee: { type: 'user', email: person.email }, label: person.name || person.email };
  const agent = findAgent(v);
  if (agent) return { assignee: { type: 'agent', id: agent.id }, label: agent.name };
  return { error: `There is no one called "${v}" in Hive. Use "me", "you", an agent's name, or a colleague's name or email.` };
}

/**
 * Check a create_task call and turn it into a task body. Returns { body, summary, trusted } or
 * { error } (a message for the agent). `eventId` makes a retry after a restart the same task.
 */
export function planTask(r, input = {}, eventId) {
  if (r.kind === 'consult') return { error: 'Another agent asked you this, so you cannot create tasks here. Tell them what task is needed.' };
  const title = clean(input.title);
  if (!title) return { error: 'A task needs a title.' };
  const requester = teacherOf(r).user;
  const who = resolveAssignee(input.assignee, r, requester);
  if (who.error) return { error: who.error };
  const repeat = input.repeat && input.repeat !== 'none' ? input.repeat : null;
  const due = clean(input.due_date) || null;
  if (due && !isDate(due)) return { error: 'due_date must be a date like 2026-10-28.' };
  if (repeat && !due) return { error: 'A repeating task needs its first due date.' };
  const body = {
    title,
    description: clean(input.description),
    assignee: who.assignee,
    due_date: due,
    repeat,
    remind_days: input.remind_days ?? undefined,
    priority: input.priority || undefined,
    client_key: `agent-run${r.id}:${eventId}`,
  };
  try {
    cleanSchedule(body); // dates, reminder and repeat rule, checked before anyone is asked
  } catch (err) {
    return { error: err.message };
  }
  const summary = [
    `"${title}" for ${who.label}`,
    due ? `due ${formatDay(due)}` : null,
    repeat ? describeRule(normalizeRule(repeat)).toLowerCase() : null,
  ].filter(Boolean).join(', ');
  const trusted = canApproveFor(requester, r.agent_id) || get('SELECT approval FROM agents WHERE id = ?', r.agent_id)?.approval === 'autonomous';
  return { body, summary, trusted };
}

/** Create the planned task. Returns { id, text } for the agent and { note } for the chat. */
export function createPlannedTask(r, body, summary, { by } = {}) {
  const agent = get('SELECT * FROM agents WHERE id = ?', r.agent_id);
  let created;
  try {
    created = createTask(body, agentActor(agent));
  } catch (err) {
    return { text: `Could not create the task: ${err.message}`, isError: true };
  }
  if (created.existing) return { id: created.id, text: `Task #${created.id} already exists: ${summary}.` };
  return {
    id: created.id,
    text: `Created task #${created.id}: ${summary}. It is on the board and has not been started.`,
    note: `📋 ${agent.name} created task #${created.id}: ${summary}${by ? ` (approved by ${by})` : ''}.`,
  };
}
