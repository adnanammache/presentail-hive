// Recurring workflows: starting the durable schedule ticker, finishing runs, cron helpers for
// older workflows. The scheduling itself lives in schedules.js.
import { Cron } from 'croner';
import { all, get, run } from './db.js';
import { emit } from './events.js';
import { occurrencesAfter } from './recurring.js';
import { startScheduleTicker, stopScheduleTicker } from './schedules.js';
import { notifyWorkflowFailed } from './notify.js';

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

// Schedules used to be in-memory cron jobs; they're now stored and claimed by a durable ticker
// (schedules.js), so they survive restarts and several workers can share the database.
export function startScheduler() {
  const n = all("SELECT COUNT(*) AS n FROM workflows WHERE status = 'active'")[0].n;
  // Schedules from before the durable ticker have no stored next run yet: give them one.
  for (const wf of all("SELECT * FROM workflows WHERE status = 'active' AND next_run_at IS NULL")) {
    const [next] = occurrencesAfter(wf, new Date(), 1);
    if (next) run('UPDATE workflows SET next_run_at = ? WHERE id = ? AND next_run_at IS NULL', next.toISOString(), wf.id);
  }
  startScheduleTicker();
  console.log(`[scheduler] ${n} recurring task(s) active`);
}
export const stopScheduler = () => stopScheduleTicker();

export function finishRun(runId, status, output = '') {
  run("UPDATE workflow_runs SET status = ?, output = ?, finished_at = datetime('now') WHERE id = ?", status, output, runId);
  emit('workflow', { run_id: runId });
  if (status === 'failed') {
    const r = get('SELECT r.task_id, w.name FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?', runId);
    if (r) notifyWorkflowFailed(r.name, output, r.task_id);
  }
}

/** Legacy entry point: a manual run is a "Run now" occurrence, authorized by the schedule's owner. */
export async function runWorkflow(workflowId, trigger = 'manual') {
  const { runNow } = await import('./schedules.js');
  const wf = get('SELECT authorized_by FROM workflows WHERE id = ?', workflowId);
  if (!wf) throw new Error('Workflow not found');
  const user = { ...(get('SELECT * FROM users WHERE email = ?', wf.authorized_by) ?? {}), role: 'owner' };
  return runNow(workflowId, { actor: { type: 'user', ref: user.email ?? 'hive', name: 'Hive' }, user, via: trigger });
}
