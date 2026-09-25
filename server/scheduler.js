// Recurring workflows: each enabled workflow gets a cron job. When it fires we open a run,
// create a task for the assigned agent and dispatch it.
import { Cron } from 'croner';
import { all, get, run } from './db.js';
import { emit } from './events.js';
import { logActivity } from './activity.js';
import { dispatchTask } from './dispatch.js';

const jobs = new Map();

export function validateSchedule(schedule, timezone = 'UTC') {
  try {
    const job = new Cron(schedule, { timezone, paused: true });
    const next = job.nextRun();
    job.stop();
    return { ok: true, next: next?.toISOString() ?? null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function nextRuns(schedule, timezone = 'UTC', count = 1) {
  try {
    const job = new Cron(schedule, { timezone, paused: true });
    const runs = job.nextRuns(count).map((d) => d.toISOString());
    job.stop();
    return runs;
  } catch {
    return [];
  }
}

export function schedule(workflow) {
  unschedule(workflow.id);
  if (!workflow.enabled) return;
  try {
    const job = new Cron(workflow.schedule, { timezone: workflow.timezone || 'UTC', protect: true }, () =>
      runWorkflow(workflow.id, 'schedule').catch((err) => console.error(`[workflow ${workflow.id}]`, err.message)),
    );
    jobs.set(workflow.id, job);
  } catch (err) {
    console.error(`[scheduler] workflow ${workflow.id} has an invalid schedule: ${err.message}`);
  }
}

export function unschedule(id) {
  jobs.get(id)?.stop();
  jobs.delete(id);
}

export function stopScheduler() {
  for (const id of [...jobs.keys()]) unschedule(id);
}

export function startScheduler() {
  for (const wf of all('SELECT * FROM workflows WHERE enabled = 1')) schedule(wf);
  console.log(`[scheduler] ${jobs.size} workflow(s) scheduled`);
}

export function finishRun(runId, status, output = '') {
  run("UPDATE workflow_runs SET status = ?, output = ?, finished_at = datetime('now') WHERE id = ?", status, output, runId);
  emit('workflow', { run_id: runId });
}

export async function runWorkflow(workflowId, trigger = 'manual') {
  const wf = get('SELECT * FROM workflows WHERE id = ?', workflowId);
  if (!wf) throw new Error('Workflow not found');

  const stamp = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: wf.timezone || 'UTC' });
  const task = run(
    "INSERT INTO tasks (title, description, status, priority, agent_id, workflow_id) VALUES (?, ?, 'todo', 'medium', ?, ?)",
    `${wf.name} — ${stamp}`,
    wf.instructions || wf.description,
    wf.agent_id,
    wf.id,
  );
  const taskId = Number(task.lastInsertRowid);
  const { lastInsertRowid } = run('INSERT INTO workflow_runs (workflow_id, task_id, trigger) VALUES (?, ?, ?)', wf.id, taskId, trigger);
  const runId = Number(lastInsertRowid);
  run("UPDATE workflows SET last_run_at = datetime('now') WHERE id = ?", wf.id);
  logActivity(wf.agent_id, 'workflow', `Workflow "${wf.name}" started (${trigger})`);
  emit('task', { task_id: taskId });
  emit('workflow', { workflow_id: wf.id });

  const agent = wf.agent_id && get('SELECT * FROM agents WHERE id = ?', wf.agent_id);
  if (!agent) {
    finishRun(runId, 'failed', 'No agent assigned to this workflow.');
    return { runId, taskId };
  }
  if (agent.status === 'paused') {
    finishRun(runId, 'failed', `${agent.name} is paused — task left in the queue.`);
    return { runId, taskId };
  }
  try {
    const reply = await dispatchTask(taskId, { runId });
    if (reply) finishRun(runId, 'success', reply);
    else if (agent.webhook_url) run("UPDATE workflow_runs SET output = 'Dispatched to webhook — waiting for the agent to complete the task.' WHERE id = ?", runId);
    // Otherwise the run stays "running" until the agent marks the task done via the Agent API.
  } catch (err) {
    finishRun(runId, 'failed', err.message);
  }
  return { runId, taskId };
}
