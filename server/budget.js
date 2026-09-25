// Monthly AI budgets per agent and per department (list price, as Claude Managed Agents reports it).
// At 80% you get an alert; at 100% new runs for that agent or department don't start until the
// budget is raised. A run already going isn't cut off mid-way.
import { get, run } from './db.js';
import { emit } from './events.js';
import { logActivity } from './activity.js';
import { pushToAll } from './push.js';
import { baseUrl, sendSlack } from './notify.js';

const MONTH = "date('now', 'start of month')";
const usd = (c) => `$${(c / 100).toFixed(2)}`;
const month = () => new Date().toISOString().slice(0, 7);

export const agentSpend = (agentId) => get(`SELECT COALESCE(SUM(cost_cents), 0) AS c FROM runs WHERE agent_id = ? AND created_at >= ${MONTH}`, agentId).c;
export const teamSpend = (teamId) =>
  get(`SELECT COALESCE(SUM(r.cost_cents), 0) AS c FROM runs r JOIN agents a ON a.id = r.agent_id WHERE a.team_id = ? AND r.created_at >= ${MONTH}`, teamId).c;

export class BudgetError extends Error {}

/** Throws if the agent or its department has used its whole monthly budget. */
export function checkBudget(agentId) {
  const a = get('SELECT a.name, a.budget_cents, a.team_id, t.name AS team, t.budget_cents AS team_budget FROM agents a LEFT JOIN teams t ON t.id = a.team_id WHERE a.id = ?', agentId);
  if (!a) return;
  if (a.budget_cents != null) {
    const spent = agentSpend(agentId);
    if (spent >= a.budget_cents) throw new BudgetError(`${a.name} has used its ${usd(a.budget_cents)} budget for this month (${usd(spent)}). Raise it in ${a.name}'s settings to continue.`);
  }
  if (a.team_budget != null) {
    const spent = teamSpend(a.team_id);
    if (spent >= a.team_budget) throw new BudgetError(`The ${a.team} team has used its ${usd(a.team_budget)} budget for this month (${usd(spent)}). Raise it in the team's settings to continue.`);
  }
}

function alertOnce(key, text, url) {
  const k = `budget-alert:${key}:${month()}`;
  if (get('SELECT value FROM app_meta WHERE key = ?', k)) return false;
  run('INSERT INTO app_meta (key, value) VALUES (?, ?)', k, new Date().toISOString());
  sendSlack({ text, link: `${baseUrl()}${url}`, linkLabel: 'Open in Hive' });
  pushToAll({ title: 'AI budget', body: text.replace(/[*_]/g, ''), url, tag: `budget-${key}` }).catch(() => {});
  emit('budget', {});
  return true;
}

/** After a run's cost changes: 80% and 100% alerts, once per month each. */
export function checkThresholds(agentId) {
  const a = get('SELECT a.id, a.name, a.budget_cents, a.team_id, t.name AS team, t.budget_cents AS team_budget FROM agents a LEFT JOIN teams t ON t.id = a.team_id WHERE a.id = ?', agentId);
  if (!a) return;
  const levels = (spent, budget) => [100, 80].find((p) => budget > 0 && spent >= (budget * p) / 100);
  if (a.budget_cents != null) {
    const spent = agentSpend(a.id);
    const p = levels(spent, a.budget_cents);
    if (p && alertOnce(`agent:${a.id}:${p}`, p === 100 ? `⛔ *${a.name}* reached its ${usd(a.budget_cents)} monthly budget. New runs are paused until you raise it.` : `⚠️ *${a.name}* has used ${usd(spent)} of its ${usd(a.budget_cents)} monthly budget (80%).`, `/#/agents/${a.id}`))
      logActivity(a.id, 'error', `${a.name} is at ${p}% of its monthly budget`);
  }
  if (a.team_budget != null) {
    const spent = teamSpend(a.team_id);
    const p = levels(spent, a.team_budget);
    if (p) alertOnce(`team:${a.team_id}:${p}`, p === 100 ? `⛔ The *${a.team}* team reached its ${usd(a.team_budget)} monthly budget. New runs are paused until you raise it.` : `⚠️ The *${a.team}* team has used ${usd(spent)} of its ${usd(a.team_budget)} monthly budget (80%).`, '/#/org');
  }
}

/** Budget input from the UI: dollars (or null for no limit) → cents. */
export function parseBudget(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error('Budget must be a positive amount in dollars');
  return Math.round(n * 100);
}
