// Agents creating one-off tasks: "create a task for me to chase the Careem statement by Friday"
// becomes a real task in Hive. Repeating work goes through the recurring-task tools
// (scheduleTools.js); this tool shares their rules: the person who asked is established from what
// they actually wrote (a quoted request), never from the model, and names resolve the same way.
// A created task never starts work by itself: it goes on the board, and a person starts it.
import { get } from './db.js';
import { ASSIGNEE, USER_REQUEST, ToolError, checkGrounded, resolveAssignee, resolveProject, toolContext } from './scheduleTools.js';
import { createTask } from './tasks.js';
import { formatDay, isDate } from './recurrence.js';

export const CREATE_TASK_TOOL = {
  type: 'custom',
  name: 'create_task',
  description: [
    'Create a one-off task in Presentail Hive, on the board for its assignee (you by default). It does not start any work.',
    'Use it only when the person explicitly asks for a task, reminder or to-do in this conversation. For anything that repeats, use schedule_recurring_task instead.',
    'Returns the created task; only say it exists after this succeeds.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      user_request: USER_REQUEST,
      title: { type: 'string', description: 'Short and specific, e.g. "Chase Careem for the September statement"' },
      description: { type: 'string', description: 'What needs doing, complete enough to act on without this conversation' },
      assignee: ASSIGNEE,
      due_date: { type: 'string', description: 'YYYY-MM-DD (optional)' },
      remind_days_before_due: { type: 'integer', description: 'Remind the assignee this many days before the due date (needs a due date)' },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
      project: { type: ['string', 'integer'], description: 'Project name or id (optional)' },
    },
    required: ['user_request', 'title'],
  },
};

const fail = (text) => ({ text, isError: true });

/**
 * Handle a create_task call from a Managed Agents run. `eventId` makes a retried call (e.g. after a
 * restart) the same task. Returns { text, isError } for the agent, plus { id, note } once created.
 */
export function createTaskFromRun(runId, input = {}, { eventId } = {}) {
  const ctx = toolContext(runId);
  if (!ctx.agent) return fail('Unknown run');
  const problem = checkGrounded(ctx, input.user_request);
  if (problem) return fail(problem);
  const title = String(input.title ?? '').trim();
  if (!title) return fail('A task needs a title.');
  const due = String(input.due_date ?? '').trim() || null;
  if (due && !isDate(due)) return fail('due_date must be a date like 2026-10-28.');
  if (input.remind_days_before_due != null && !due) return fail('A reminder needs a due date.');
  let assignee;
  let projectId;
  try {
    assignee = resolveAssignee(ctx, input.assignee).ref;
    projectId = resolveProject(ctx, input.project);
  } catch (err) {
    if (err instanceof ToolError) return fail(err.message);
    throw err;
  }
  let created;
  try {
    // Made by the person who asked (so the task shows who it's for), through the agent.
    created = createTask(
      {
        title,
        description: String(input.description ?? '').trim(),
        assignee,
        due_date: due,
        remind_days: input.remind_days_before_due ?? undefined,
        priority: input.priority || undefined,
        project_id: projectId ?? undefined,
        client_key: `agent-run${runId}:${eventId}`,
      },
      { type: 'user', ref: ctx.user.email, name: `${ctx.user.name || ctx.user.email} (via ${ctx.agent.name})` },
    );
  } catch (err) {
    return fail(`Could not create the task: ${err.message}`);
  }
  const task = get(
    'SELECT t.*, a.name AS agent_name, u.name AS person_name FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id LEFT JOIN users u ON u.email = t.assignee_email WHERE t.id = ?',
    created.id,
  );
  const who = task.agent_name || task.person_name || task.assignee_email || 'no one';
  const summary = `"${task.title}" for ${who}${task.due_date ? `, due ${formatDay(task.due_date)}` : ''}`;
  if (created.existing) return { id: task.id, text: `Task #${task.id} already exists: ${summary}.` };
  return {
    id: task.id,
    text: `Created task #${task.id}: ${summary}. It is on the board and has not been started.`,
    note: `📋 ${ctx.agent.name} created task #${task.id}: ${summary}.`,
  };
}
