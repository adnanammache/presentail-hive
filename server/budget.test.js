import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.SLACK_BOT_TOKEN = 'xoxb';
process.env.SLACK_ALERT_CHANNEL = 'U1';
const { get, run } = await import('./db.js');
const { checkBudget, checkThresholds, parseBudget, BudgetError } = await import('./budget.js');
const managed = await import('./managed.js');
const { fakeAnthropic } = await import('./testing/fake-anthropic.js');

const slack = [];
globalThis.fetch = async (url, init) => (slack.push(JSON.parse(init.body).text), Response.json({ ok: true }));

test('budgets alert at 80% and 100% once a month, and stop new runs at 100%', () => {
  managed.setManagedClient(fakeAnthropic());
  const team = Number(run("INSERT INTO teams (name, budget_cents) VALUES ('Accounting', 10000)").lastInsertRowid);
  const ledger = Number(run("INSERT INTO agents (name, title, team_id, platform, budget_cents, api_token) VALUES ('Ledger', 'UAE Accountant', ?, 'managed', 5000, 'l')", team).lastInsertRowid);
  const task = Number(run("INSERT INTO tasks (title, agent_id) VALUES ('Talabat', ?)", ledger).lastInsertRowid);

  run("INSERT INTO runs (agent_id, status, cost_cents) VALUES (?, 'ended', 3900)", ledger);
  checkThresholds(ledger);
  assert.equal(slack.length, 0, 'under 80%: quiet');
  checkBudget(ledger);

  run("INSERT INTO runs (agent_id, status, cost_cents) VALUES (?, 'ended', 200)", ledger); // $41 of $50
  checkThresholds(ledger);
  checkThresholds(ledger);
  assert.equal(slack.length, 1, 'the 80% alert is sent once');
  assert.match(slack[0], /Ledger has used \$41\.00 of its \$50\.00 monthly budget \(80%\)/);

  run("INSERT INTO runs (agent_id, status, cost_cents) VALUES (?, 'ended', 1000)", ledger); // $51
  checkThresholds(ledger);
  assert.match(slack.at(-1), /Ledger reached its \$50\.00 monthly budget/);
  assert.throws(() => checkBudget(ledger), BudgetError);
  assert.throws(() => managed.startTaskRun(task), /used its \$50\.00 budget for this month/);

  // Raising the agent's budget lets it run again, until the team's budget is the limit.
  run('UPDATE agents SET budget_cents = 20000 WHERE id = ?', ledger);
  checkBudget(ledger);
  run("INSERT INTO runs (agent_id, status, cost_cents) VALUES (?, 'ended', 5000)", ledger); // team at $101 of $100
  assert.throws(() => checkBudget(ledger), /Accounting team has used its \$100\.00 budget/);
  run('UPDATE teams SET budget_cents = NULL');
  checkBudget(ledger);

  // Last month's spend doesn't count.
  run("UPDATE runs SET created_at = datetime('now', 'start of month', '-3 days')");
  run('UPDATE agents SET budget_cents = 100 WHERE id = ?', ledger);
  checkBudget(ledger);
});

test('budget input is dollars', () => {
  assert.equal(parseBudget('50'), 5000);
  assert.equal(parseBudget('12.5'), 1250);
  assert.equal(parseBudget(''), null);
  assert.equal(parseBudget(undefined), undefined);
  assert.throws(() => parseBudget('-3'), /positive/);
});
