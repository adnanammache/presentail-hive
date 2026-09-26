import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.DB_PATH = ':memory:';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const express = (await import('express')).default;
const { agentRouter, dashboardRouter, errorHandler } = await import('./app.js');
const { stopScheduler } = await import('./scheduler.js');

let base;
let server;
let hook;
let hookUrl;
const hookCalls = [];

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRouter());
  app.use('/api', dashboardRouter());
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;

  // A fake Make-style webhook that answers synchronously.
  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hookCalls.push(JSON.parse(body));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ reply: 'On it.' }));
    });
  }).listen(0);
  hookUrl = `http://localhost:${hook.address().port}/`;
});

after(() => {
  stopScheduler();
  server.closeAllConnections();
  server.close();
  hook.closeAllConnections();
  hook.close();
});

const call = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let teamId;
const newAgent = async (body) => {
  teamId ??= (await call('/teams', { method: 'POST', body: { name: 'Test team' } })).body.id;
  return call('/agents', { method: 'POST', body: { title: 'Tester', team_id: teamId, ...body } });
};

test('agent lifecycle, chat via webhook, and the Agent API', async () => {
  const { body: agent } = await newAgent({ name: 'Hooky', platform: 'make', webhook_url: hookUrl });
  assert.match(agent.api_token, /^agt_/);

  // The list endpoint never leaks tokens.
  const { body: list } = await call('/agents');
  assert.equal(list[0].api_token, undefined);

  await call(`/agents/${agent.id}/messages`, { method: 'POST', body: { body: 'Hello' } });
  await wait(100);
  const { body: thread } = await call(`/agents/${agent.id}/messages`);
  assert.deepEqual(thread.map((m) => [m.sender, m.body]), [['user', 'Hello'], ['agent', 'On it.']]);
  assert.equal(hookCalls.at(-1).event, 'message');

  // Agent API: bad token is rejected, good token sees its tasks.
  assert.equal((await call('/agent/tasks', { token: 'nope' })).status, 401);
  const { body: task } = await call('/tasks', { method: 'POST', body: { title: 'Reconcile', agent_id: agent.id } });
  await wait(100);
  assert.equal(hookCalls.at(-1).event, 'task.assigned');
  const { body: mine } = await call('/agent/tasks?status=todo,review', { token: agent.api_token });
  assert.ok(mine.some((t) => t.id === task.id));

  const { body: done } = await call(`/agent/tasks/${task.id}`, { method: 'PATCH', token: agent.api_token, body: { status: 'done', result: 'All matched' } });
  assert.equal(done.status, 'done');
  assert.ok(done.completed_at);
});

test('workflows validate cron and complete runs when the task is done', async () => {
  const { body: agent } = await newAgent({ name: 'Poller', platform: 'custom' });
  assert.equal((await call('/workflows', { method: 'POST', body: { name: 'Bad', schedule: 'every day' } })).status, 400);

  const { body: wf } = await call('/workflows', { method: 'POST', body: { name: 'Weekly report', schedule: '0 9 * * 1', timezone: 'Asia/Dubai', agent_id: agent.id } });
  assert.ok(wf.next_run_at);

  await call(`/workflows/${wf.id}/run`, { method: 'POST' });
  await wait(100);
  let { body: runs } = await call(`/workflows/${wf.id}/runs`);
  assert.equal(runs[0].status, 'running');

  const { body: tasks } = await call('/agent/tasks', { token: (await call(`/agents/${agent.id}`)).body.api_token });
  const runTask = tasks.find((t) => t.workflow_id === wf.id);
  await call(`/agent/tasks/${runTask.id}`, { method: 'PATCH', token: (await call(`/agents/${agent.id}`)).body.api_token, body: { status: 'done', result: 'Sent' } });
  ({ body: runs } = await call(`/workflows/${wf.id}/runs`));
  assert.equal(runs[0].status, 'success');
  assert.equal(runs[0].output, 'Sent');
});

test('agents are created with a name, title and team', async () => {
  const { body: team } = await call('/teams', { method: 'POST', body: { name: 'Finance', color: '#10b981' } });
  assert.equal((await call('/teams', { method: 'POST', body: { name: 'finance' } })).status, 400, 'team names are unique, any case');

  assert.equal((await call('/agents', { method: 'POST', body: { name: 'No title', team_id: team.id } })).status, 400);
  assert.equal((await call('/agents', { method: 'POST', body: { name: 'No team', title: 'Accountant' } })).status, 400);
  assert.equal((await call('/agents', { method: 'POST', body: { name: 'Bad team', title: 'Accountant', team_id: 9999 } })).status, 400);

  const { status, body: agent } = await call('/agents', { method: 'POST', body: { name: 'Ledger', title: 'Month-End Accountant', team_id: team.id } });
  assert.equal(status, 200);
  assert.equal(agent.title, 'Month-End Accountant');
  assert.equal(agent.team_name, 'Finance');

  const { body: teams } = await call('/teams');
  assert.equal(teams.find((t) => t.id === team.id).agent_count, 1);

  // Moving teams and renaming titles
  const { body: ops } = await call('/teams', { method: 'POST', body: { name: 'Operations' } });
  const { body: moved } = await call(`/agents/${agent.id}`, { method: 'PATCH', body: { team_id: ops.id, title: 'Ops Lead' } });
  assert.equal(moved.team_name, 'Operations');
  assert.equal(moved.title, 'Ops Lead');
  assert.equal((await call(`/agents/${agent.id}`, { method: 'PATCH', body: { title: '  ' } })).status, 400);

  // Deleting a team keeps its agents, just without a team
  await call(`/teams/${ops.id}`, { method: 'DELETE' });
  const { body: after } = await call(`/agents/${agent.id}`);
  assert.equal(after.team_id, null);
  assert.equal(after.name, 'Ledger');
});

test('org chart layout: put someone at the top of a team, or move them to another team', async () => {
  const { body: acc } = await call('/teams', { method: 'POST', body: { name: 'Accounting layout' } });
  const { body: other } = await call('/teams', { method: 'POST', body: { name: 'Other layout' } });
  const mk = async (name) => (await call('/agents', { method: 'POST', body: { name, title: 'Accountant', team_id: acc.id } })).body;
  const ananya = await mk('Ananya');
  const karim = await mk('Karim');
  const maya = await mk('Maya');

  const order = async (team) => (await call('/agents')).body.filter((a) => a.team_id === team).sort((a, b) => a.sort_order - b.sort_order).map((a) => a.name);
  assert.equal((await call('/org/layout', { method: 'PUT', body: { teams: [{ team_id: acc.id, ids: [karim.id, ananya.id, maya.id] }] } })).status, 200);
  assert.deepEqual(await order(acc.id), ['Karim', 'Ananya', 'Maya']);

  await call('/org/layout', { method: 'PUT', body: { teams: [{ team_id: acc.id, ids: [karim.id, ananya.id] }, { team_id: other.id, ids: [maya.id] }] } });
  assert.deepEqual(await order(acc.id), ['Karim', 'Ananya']);
  assert.deepEqual(await order(other.id), ['Maya']);

  assert.equal((await call('/org/layout', { method: 'PUT', body: { teams: [{ team_id: acc.id, ids: [karim.id, karim.id] }] } })).status, 400);
  assert.equal((await call('/org/layout', { method: 'PUT', body: { teams: [{ team_id: 99999, ids: [karim.id] }] } })).status, 400);
});
