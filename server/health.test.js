import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.SLACK_BOT_TOKEN = 'xoxb';
process.env.WAFEQ_API_KEY = 'bad-key';
delete process.env.ODOO_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
const { recordHealth, runChecks, healthReport } = await import('./health.js');

globalThis.fetch = async (url) => {
  url = String(url);
  if (url.includes('slack.com/api/auth.test')) return Response.json({ ok: true, team: 'Presentail', user: 'hive' });
  if (url.includes('api.wafeq.com')) return new Response('{}', { status: 401 });
  throw new Error('unexpected ' + url);
};

test('live checks and what Hive sees while working both show up', async () => {
  const report = await runChecks();
  const row = (k) => report.rows.find((r) => r.key === k);
  assert.equal(row('slack').state, 'ok');
  assert.equal(row('slack').detail, 'connected to Presentail as hive');
  assert.equal(row('wafeq').state, 'down');
  assert.match(row('wafeq').last_error, /401: the API key is not valid/);
  assert.equal(row('odoo').state, 'off');
  assert.equal(row('anthropic').state, 'off');
  assert.deepEqual(report.down, ['Wafeq']);

  // A real call failing, then working again.
  recordHealth('slack', false, 'chat.postMessage: invalid_auth');
  assert.equal(healthReport().rows.find((r) => r.key === 'slack').state, 'down');
  recordHealth('slack', true);
  const slack = healthReport().rows.find((r) => r.key === 'slack');
  assert.equal(slack.state, 'ok');
  assert.match(slack.last_error, /invalid_auth/, 'the last error stays visible for context');
});
