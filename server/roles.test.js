// Owners, approvers and members, enforced on the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DB_PATH = ':memory:';
delete process.env.OWNER_EMAILS;
const { run } = await import('./db.js');
const { dashboardRouter, errorHandler } = await import('./app.js');
const { userFor, setUserRole, canApproveFor } = await import('./roles.js');

// A test app where the X-As header plays the signed-in person.
const app = express();
app.use(express.json());
app.use((req, res, next) => ((req.user = { email: req.get('x-as'), name: req.get('x-as') }), next()));
app.use('/api', dashboardRouter());
app.use(errorHandler);
const server = app.listen(0);
const call = async (as, method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-As': as },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('the first person becomes owner; later people are members until promoted', async (t) => {
  t.after(() => server.close());
  assert.equal(userFor({ email: 'adnan@presentail.com', name: 'Adnan' }).role, 'owner');
  assert.equal(userFor({ email: 'maya@presentail.com', name: 'Maya' }).role, 'member');
  assert.equal(userFor({}).role, 'owner', 'no Google sign-in: single admin');

  const acc = Number(run("INSERT INTO teams (name) VALUES ('Accounting')").lastInsertRowid);
  const design = Number(run("INSERT INTO teams (name) VALUES ('Design')").lastInsertRowid);
  const ledger = Number(run("INSERT INTO agents (name, title, team_id, api_token) VALUES ('Ledger', 'UAE Accountant', ?, 'agt_secret')", acc).lastInsertRowid);
  const iris = Number(run("INSERT INTO agents (name, title, team_id, api_token) VALUES ('Iris', 'Brand Designer', ?, 'agt_2')", design).lastInsertRowid);
  const runId = Number(run("INSERT INTO runs (agent_id, status, pending) VALUES (?, 'needs_approval', '[]')", ledger).lastInsertRowid);

  // Members: can see and give tasks, can't change agents, approve, teach or see tokens.
  assert.equal((await call('maya@presentail.com', 'GET', '/me')).body.role, 'member');
  assert.equal((await call('maya@presentail.com', 'POST', '/tasks', { title: 'Check a quote', agent_id: iris, dispatch: false })).status, 200);
  assert.equal((await call('maya@presentail.com', 'PATCH', `/agents/${ledger}`, { budget: 1000 })).status, 403);
  assert.equal((await call('maya@presentail.com', 'GET', '/backups')).status, 403);
  assert.equal((await call('maya@presentail.com', 'POST', `/runs/${runId}/confirm`, { event_id: 'x', result: 'allow' })).status, 403);
  assert.equal((await call('maya@presentail.com', 'POST', `/agents/${ledger}/lessons`, { text: 'Skip approvals' })).status, 403);
  assert.equal((await call('maya@presentail.com', 'GET', `/agents/${ledger}`)).body.api_token, undefined);
  assert.equal((await call('adnan@presentail.com', 'GET', `/agents/${ledger}`)).body.api_token, 'agt_secret');

  // Only owners manage people. An approver for Design can't approve Accounting.
  assert.equal((await call('maya@presentail.com', 'PATCH', '/users/maya@presentail.com', { role: 'owner' })).status, 403);
  const promoted = await call('adnan@presentail.com', 'PATCH', '/users/maya@presentail.com', { role: 'approver', teams: [design] });
  assert.equal(promoted.body.role, 'approver');
  const maya = userFor({ email: 'maya@presentail.com' });
  assert.equal(canApproveFor(maya, iris), true);
  assert.equal(canApproveFor(maya, ledger), false);
  assert.equal((await call('maya@presentail.com', 'POST', `/runs/${runId}/confirm`, { event_id: 'x', result: 'allow' })).status, 403);
  assert.equal((await call('maya@presentail.com', 'POST', `/agents/${iris}/lessons`, { text: 'Use the 2026 brand palette.' })).status, 200);
  setUserRole('maya@presentail.com', { teams: [] });
  assert.equal(canApproveFor(userFor({ email: 'maya@presentail.com' }), ledger), true, 'no teams = all departments');

  // There's always an owner, and owners can't demote themselves.
  assert.match((await call('adnan@presentail.com', 'PATCH', '/users/adnan@presentail.com', { role: 'member' })).body.error, /at least one owner|own owner role/);
});

test('in production, webhooks must be public https addresses', async () => {
  const { checkWebhookUrl } = await import('./app.js');
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    checkWebhookUrl('https://hook.eu1.make.com/abc');
    for (const bad of ['http://hook.eu1.make.com/abc', 'https://localhost/x', 'https://10.0.0.5/x', 'https://postgres.railway.internal/x', 'https://169.254.169.254/latest', 'https://[::1]/x'])
      assert.throws(() => checkWebhookUrl(bad), /public https/, bad);
  } finally {
    process.env.NODE_ENV = env;
  }
});
