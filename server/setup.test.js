import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
delete process.env.SLACK_BOT_TOKEN;
delete process.env.ODOO_API_KEY;
const { run } = await import('./db.js');
const { setupChecklist, setManualDone, setHidden, markVerified } = await import('./setup.js');

const item = (key) => setupChecklist().items.find((i) => i.key === key);

test('items tick themselves off from live state', () => {
  assert.equal(item('first-live').done, false);
  assert.equal(item('slack').done, false);
  run("INSERT INTO agents (name, title, platform, api_token, ma_agent_id) VALUES ('Ledger', 'UAE Accountant', 'managed', 'agt1', 'agent_1')");
  assert.equal(item('first-live').done, true);
  assert.equal(item('first-live').progress, 'Ledger');

  // Slack needs both the variables and a successful test alert
  process.env.SLACK_BOT_TOKEN = 'xoxb';
  process.env.SLACK_ALERT_CHANNEL = 'C1';
  assert.equal(item('slack').done, false);
  markVerified('slack-tested');
  assert.equal(item('slack').done, true);

  run("INSERT INTO agents (name, title, api_token, status) VALUES ('Vera', 'Auditor', 'agt2', 'paused')");
  assert.equal(item('agents').done, false);
  assert.match(item('agents').detail, /1 agent is still not set up/);
});

test('manual items and hiding are remembered', () => {
  assert.equal(item('backups').done, false);
  setManualDone('backups', true);
  assert.equal(item('backups').done, true);
  setManualDone('backups', false);
  assert.equal(item('backups').done, false);
  setHidden(true);
  assert.equal(setupChecklist().hidden, true);
  setHidden(false);
  assert.equal(setupChecklist().hidden, false);
  const { done, total, items } = setupChecklist();
  assert.equal(total, items.length);
  assert.equal(done, items.filter((i) => i.done).length);
});
