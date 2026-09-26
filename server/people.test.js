// People profiles, photos, shared teams (people + agents), invitations and deactivation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OWNER_EMAILS;
delete process.env.SLACK_BOT_TOKEN;
process.env.RESEND_API_KEY = 'test-key';
process.env.MAIL_FROM = 'Hive <hive@example.com>';

const express = (await import('express')).default;
const { dashboardRouter, errorHandler } = await import('./app.js');
const { get, all, run } = await import('./db.js');
const { userFor } = await import('./roles.js');
const { acceptInvite, avatarUrl } = await import('./people.js');
const { setMailTransport } = await import('./mail.js');
const { isAllowed } = await import('./auth.js');
const { stopScheduler } = await import('./scheduler.js');

// A stand-in mailbox: nothing leaves the test.
const outbox = [];
setMailTransport(async (m) => outbox.push(m));

let base;
let server;
before(() => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const email = req.get('x-user');
    if (email) req.user = { email, name: req.get('x-name') || email.split('@')[0], picture: req.get('x-picture') || '' };
    next();
  });
  app.use('/api', dashboardRouter());
  app.use(errorHandler);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api`;
});
after(() => {
  stopScheduler();
  server.closeAllConnections();
  server.close();
});

const call = async (path, { method = 'GET', body, as = 'adnan@presentail.com', raw, headers = {} } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }), 'x-user': as, ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.arrayBuffer() };
};

/** A tiny but genuine PNG header (width × height), enough for the server's content check. */
function png(w = 64, h = 64) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

// Existing data before this feature: an agent on a team and a task. They must survive untouched.
const teamId = Number(run("INSERT INTO teams (name, color) VALUES ('Accounting', '#10b981')").lastInsertRowid);
const procId = Number(run("INSERT INTO teams (name, color) VALUES ('Procurement', '#f59e0b')").lastInsertRowid);
const agentId = Number(run("INSERT INTO agents (name, title, team_id, platform, status, api_token, system_prompt) VALUES ('Ledger', 'UAE Accountant', ?, 'custom', 'idle', 'agt_l', 'Keep the books.')", teamId).lastInsertRowid);
const floatingAgent = Number(run("INSERT INTO agents (name, title, platform, status, api_token) VALUES ('Scout', 'Procurement', 'custom', 'idle', 'agt_s')").lastInsertRowid);
const oldTask = Number(run("INSERT INTO tasks (title, status, agent_id) VALUES ('Old task', 'in_progress', ?)", agentId).lastInsertRowid);

await call('/me', { as: 'adnan@presentail.com', headers: { 'x-name': 'Adnan Ammache', 'x-picture': 'https://lh3.googleusercontent.com/a/adnan' } }); // first: owner
await call('/me', { as: 'omar@presentail.com', headers: { 'x-name': 'Omar Ali' } });
await call('/me', { as: 'sara@presentail.com', headers: { 'x-name': 'Sara Khan' } });

test('profile: you edit your own; nobody edits someone else’s; email and role are not personal fields', async () => {
  const me = await call('/people/adnan@presentail.com', { method: 'PATCH', body: { name: 'Adnan A.', title: 'Founder', bio: 'Building teams where people and AI work together.', timezone: 'Asia/Dubai' } });
  assert.equal(me.status, 200);
  assert.deepEqual([me.body.name, me.body.title, me.body.timezone], ['Adnan A.', 'Founder', 'Asia/Dubai']);
  assert.equal((await call('/people/adnan@presentail.com', { method: 'PATCH', body: { timezone: 'Mars/Olympus' } })).status, 400);
  assert.equal((await call('/people/adnan@presentail.com', { method: 'PATCH', body: { name: '  ' } })).status, 400);
  assert.equal((await call('/people/adnan@presentail.com', { method: 'PATCH', body: { email: 'x@y.com' } })).status, 400);
  assert.equal((await call('/people/adnan@presentail.com', { method: 'PATCH', body: { role: 'member' } })).status, 400);
  // Not even an owner edits another person's personal profile.
  assert.equal((await call('/people/omar@presentail.com', { method: 'PATCH', body: { title: 'CFO' } })).status, 403);
  assert.equal((await call('/people/adnan@presentail.com', { method: 'PATCH', as: 'omar@presentail.com', body: { title: 'Intern' } })).status, 403);
  // A later sign-in keeps the edited name.
  userFor({ email: 'adnan@presentail.com', name: 'Adnan Ammache', picture: 'https://lh3.googleusercontent.com/a/adnan' });
  assert.equal(get("SELECT name FROM users WHERE email = 'adnan@presentail.com'").name, 'Adnan A.');
});

test('photos: upload (validated), replace, remove, account photo, and sign-in never undoes a choice', async () => {
  // Account photo from sign-in is the default.
  let me = (await call('/me')).body;
  assert.equal(me.avatar_url, 'https://lh3.googleusercontent.com/a/adnan');
  // Validation: type by content, size, real dimensions; your own photo only.
  assert.equal((await call('/people/adnan@presentail.com/photo', { method: 'PUT', raw: Buffer.from('GIF89a not allowed') })).status, 400);
  assert.equal((await call('/people/adnan@presentail.com/photo', { method: 'PUT', raw: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(40)]) })).status, 400, 'a PNG signature without a real header');
  assert.equal((await call('/people/adnan@presentail.com/photo', { method: 'PUT', raw: png(10, 10) })).status, 400, 'too small');
  const big = await call('/people/adnan@presentail.com/photo', { method: 'PUT', raw: Buffer.concat([png(), Buffer.alloc(3.1 * 1024 * 1024)]) });
  assert.equal(big.status, 400);
  assert.match(big.body.error, /under 3 MB/);
  assert.equal((await call('/people/omar@presentail.com/photo', { method: 'PUT', raw: png() })).status, 403);
  // Upload wins over the account photo, and is served.
  const up = await call('/people/adnan@presentail.com/photo', { method: 'PUT', raw: png() });
  assert.equal(up.status, 200);
  assert.match(up.body.avatar_url, /^\/api\/people\/adnan%40presentail\.com\/photo\?v=\d+$/);
  const file = await call('/people/adnan@presentail.com/photo');
  assert.equal(Buffer.from(file.body).length, png().length);
  // Replace: new version.
  await new Promise((r) => setTimeout(r, 5));
  const replaced = await call('/people/adnan@presentail.com/photo', { method: 'PUT', raw: png(128, 128) });
  assert.notEqual(replaced.body.avatar_url, up.body.avatar_url);
  // Sign-in again: the upload stays.
  userFor({ email: 'adnan@presentail.com', name: 'Adnan Ammache', picture: 'https://lh3.googleusercontent.com/a/adnan-new' });
  assert.equal((await call('/me')).body.avatar_url, replaced.body.avatar_url);
  // Remove: initials, and the next sign-in doesn't bring the account photo back.
  assert.equal((await call('/people/adnan@presentail.com/photo', { method: 'DELETE' })).body.avatar_url, null);
  userFor({ email: 'adnan@presentail.com', name: 'Adnan Ammache', picture: 'https://lh3.googleusercontent.com/a/adnan-newer' });
  assert.equal((await call('/me')).body.avatar_url, null);
  assert.equal((await call('/people/adnan@presentail.com/photo')).status, 404);
  // "Use account photo" restores the (latest) account picture.
  assert.equal((await call('/people/adnan@presentail.com/photo/account', { method: 'POST' })).body.avatar_url, 'https://lh3.googleusercontent.com/a/adnan-newer');
  // People without any photo get initials (null), never someone else's picture.
  assert.equal(avatarUrl(get("SELECT * FROM users WHERE email = 'omar@presentail.com'")), null);
  // Non-https provider pictures are ignored.
  userFor({ email: 'omar@presentail.com', name: 'Omar Ali', picture: 'javascript:alert(1)' });
  assert.equal(get("SELECT provider_photo FROM users WHERE email = 'omar@presentail.com'").provider_photo, null);
});

test('the same photo everywhere: people list, task assignee, comments, activity and project members', async () => {
  const photo = (await call('/people/adnan@presentail.com/photo', { method: 'PUT', raw: png() })).body.avatar_url;
  assert.equal((await call('/people')).body.find((p) => p.email === 'adnan@presentail.com').avatar_url, photo);
  const { body: t } = await call('/tasks', { method: 'POST', body: { title: 'Photo check', assignee: 'user:adnan@presentail.com', reviewer_email: 'adnan@presentail.com' } });
  assert.equal(t.assignee.avatar_url, photo);
  assert.equal(t.reviewer.avatar_url, photo);
  await call(`/tasks/${t.id}/comments`, { method: 'POST', body: { body: 'Looks good' } });
  assert.equal((await call(`/tasks/${t.id}/comments`)).body[0].avatar_url, photo);
  assert.equal((await call(`/tasks/${t.id}/events`)).body.find((e) => e.kind === 'created').avatar_url, photo);
  const { body: p } = await call('/projects', { method: 'POST', body: { name: 'Photo project', members: [{ type: 'user', ref: 'adnan@presentail.com' }] } });
  assert.equal(p.members[0].avatar_url, photo);
  const dir = (await call('/directory')).body;
  assert.equal(dir.unassigned_people.find((x) => x.email === 'adnan@presentail.com')?.avatar_url, photo);
});

test('people and agents share teams; people can be on several; totals count each once', async () => {
  // Existing agent membership is kept.
  let dir = (await call('/directory')).body;
  assert.deepEqual(dir.teams.find((t) => t.id === teamId).agent_ids, [agentId]);
  const add = await call(`/teams/${teamId}/members`, { method: 'POST', body: { members: [{ type: 'user', ref: 'omar@presentail.com' }, { type: 'user', ref: 'sara@presentail.com' }, { type: 'agent', ref: floatingAgent }] } });
  assert.equal(add.status, 200);
  assert.deepEqual(add.body.people.map((p) => p.email).sort(), ['omar@presentail.com', 'sara@presentail.com']);
  assert.deepEqual(add.body.agent_ids.sort(), [agentId, floatingAgent].sort());
  await call(`/teams/${procId}/members`, { method: 'POST', body: { members: [{ type: 'user', ref: 'omar@presentail.com' }] } });
  // Adding twice is harmless.
  await call(`/teams/${procId}/members`, { method: 'POST', body: { members: [{ type: 'user', ref: 'omar@presentail.com' }] } });
  dir = (await call('/directory')).body;
  assert.equal(dir.teams.find((t) => t.id === procId).people.length, 1);
  const peopleNow = get("SELECT COUNT(*) AS n FROM users WHERE status = 'active'").n;
  assert.equal(dir.totals.people, peopleNow, 'Omar is on two teams but counted once');
  assert.equal(dir.totals.agents, get('SELECT COUNT(*) AS n FROM agents').n);
  assert.ok(!dir.unassigned_people.some((p) => p.email === 'omar@presentail.com'));
  assert.ok(!dir.unassigned_agent_ids.includes(floatingAgent));
  // Agent config and tasks are untouched by team changes.
  assert.equal(get('SELECT system_prompt FROM agents WHERE id = ?', agentId).system_prompt, 'Keep the books.');
  assert.equal(get('SELECT status FROM tasks WHERE id = ?', oldTask).status, 'in_progress');
  // Removing someone keeps their account, tasks and history.
  await call(`/teams/${procId}/members/user/omar@presentail.com`, { method: 'DELETE' });
  assert.ok(get("SELECT 1 FROM users WHERE email = 'omar@presentail.com' AND status = 'active'"));
  assert.equal((await call('/people/omar@presentail.com')).body.teams.map((t) => t.name).join(), 'Accounting');
});

test('team membership grants nothing else; leads manage only their own team’s people', async () => {
  // Make Sara the Accounting lead (owners only).
  assert.equal((await call(`/teams/${teamId}/members/user/sara@presentail.com`, { method: 'PATCH', as: 'omar@presentail.com', body: { role: 'lead' } })).status, 403);
  assert.equal((await call(`/teams/${teamId}/members/user/sara@presentail.com`, { method: 'PATCH', body: { role: 'lead' } })).status, 200);
  const sara = get("SELECT role FROM users WHERE email = 'sara@presentail.com'");
  assert.equal(sara.role, 'member', 'a team lead is still a workspace member');
  await call('/me', { as: 'lee@presentail.com', headers: { 'x-name': 'Lee' } });
  // A lead adds and removes people on their own team…
  assert.equal((await call(`/teams/${teamId}/members`, { method: 'POST', as: 'sara@presentail.com', body: { members: [{ type: 'user', ref: 'lee@presentail.com' }] } })).status, 200);
  assert.equal((await call(`/teams/${teamId}/members/user/lee@presentail.com`, { method: 'DELETE', as: 'sara@presentail.com' })).status, 200);
  // …but not other teams, agents, roles, invitations or leads.
  assert.equal((await call(`/teams/${procId}/members`, { method: 'POST', as: 'sara@presentail.com', body: { members: [{ type: 'user', ref: 'lee@presentail.com' }] } })).status, 403);
  assert.equal((await call(`/teams/${teamId}/members`, { method: 'POST', as: 'sara@presentail.com', body: { members: [{ type: 'agent', ref: agentId }] } })).status, 403);
  assert.equal((await call('/people/lee@presentail.com/membership', { method: 'PATCH', as: 'sara@presentail.com', body: { role: 'owner' } })).status, 403);
  assert.equal((await call('/invitations', { method: 'POST', as: 'sara@presentail.com', body: { email: 'x@presentail.com' } })).status, 403);
  assert.equal((await call('/users/lee@presentail.com', { method: 'PATCH', as: 'sara@presentail.com', body: { role: 'approver' } })).status, 403);
  // A plain member can't change teams at all.
  assert.equal((await call(`/teams/${teamId}/members/user/omar@presentail.com`, { method: 'DELETE', as: 'lee@presentail.com' })).status, 403);
  // Adding an agent starts nothing and grants no project access.
  const msgs = get('SELECT COUNT(*) AS n FROM messages').n;
  assert.equal(get('SELECT COUNT(*) AS n FROM runs').n, 0);
  assert.equal(msgs, 0);
  assert.equal(get("SELECT COUNT(*) AS n FROM project_members WHERE member_ref = 'lee@presentail.com'").n, 0);
});

test('membership and roles: owners only, with the last owner protected', async () => {
  const m = await call('/people/omar@presentail.com/membership', { method: 'PATCH', body: { role: 'approver', manager_email: 'adnan@presentail.com', teams: [{ team_id: teamId, role: 'member' }, { team_id: procId, role: 'lead' }] } });
  assert.equal(m.status, 200);
  assert.equal(m.body.role, 'approver');
  assert.equal(m.body.manager.email, 'adnan@presentail.com');
  assert.deepEqual(m.body.teams.map((t) => [t.name, t.role]), [['Accounting', 'member'], ['Procurement', 'lead']]);
  // No reporting loops, no reporting to yourself.
  assert.equal((await call('/people/adnan@presentail.com/membership', { method: 'PATCH', body: { manager_email: 'omar@presentail.com' } })).status, 400);
  assert.equal((await call('/people/omar@presentail.com/membership', { method: 'PATCH', body: { manager_email: 'omar@presentail.com' } })).status, 400);
  // The only owner can't demote or deactivate themselves.
  assert.equal((await call('/people/adnan@presentail.com/membership', { method: 'PATCH', body: { role: 'member' } })).status, 400);
  assert.equal((await call('/people/adnan@presentail.com/deactivate', { method: 'POST' })).status, 400);
  // An owner whose access is off doesn't count as "another owner".
  run("INSERT INTO users (email, name, role, status) VALUES ('old.owner@presentail.com', 'Old owner', 'owner', 'deactivated')");
  assert.equal((await call('/users/adnan@presentail.com', { method: 'PATCH', body: { role: 'member' } })).status, 400);
  // A job title grants nothing.
  await call('/people/sara@presentail.com', { method: 'PATCH', as: 'sara@presentail.com', body: { title: 'Chief Owner Administrator' } });
  assert.equal(get("SELECT role FROM users WHERE email = 'sara@presentail.com'").role, 'member');
  assert.equal((await call('/invitations', { as: 'sara@presentail.com' })).status, 403);
});

test('invitations: send, duplicates, members, resend, revoke, expiry, acceptance once', async () => {
  outbox.length = 0;
  const inv = await call('/invitations', { method: 'POST', body: { email: 'Maya@Example.com', role: 'member', teams: [procId], title: 'Procurement Manager' } });
  assert.equal(inv.status, 200);
  assert.equal(inv.body.delivery.sent, true);
  assert.equal(outbox.length, 1);
  assert.deepEqual(outbox[0].to, ['maya@example.com']);
  const link = inv.body.delivery.link;
  assert.ok(outbox[0].text.includes(link));
  const token = link.split('/invite/')[1];
  assert.equal(get('SELECT token_hash FROM invitations WHERE id = ?', inv.body.invite.id).token_hash.includes(token), false, 'only a hash is stored');

  // Duplicates and existing members.
  assert.equal((await call('/invitations', { method: 'POST', body: { email: 'maya@example.com' } })).status, 409);
  assert.equal((await call('/invitations', { method: 'POST', body: { email: 'omar@presentail.com' } })).status, 409);
  assert.equal((await call('/invitations', { method: 'POST', body: { email: 'not-an-email' } })).status, 400);

  // Pending invitations aren't people: not listed, not assignable.
  assert.ok(!(await call('/people')).body.some((p) => p.email === 'maya@example.com'));
  assert.equal((await call('/tasks', { method: 'POST', body: { title: 'x', assignee: 'user:maya@example.com' } })).status, 400);
  // But the invited email may sign in (an outside address, invited explicitly).
  assert.equal(isAllowed('maya@example.com'), true);
  assert.equal(isAllowed('stranger@example.com'), false);

  // Resend: a new link; the old one stops working.
  const again = await call(`/invitations/${inv.body.invite.id}/resend`, { method: 'POST' });
  const token2 = again.body.delivery.link.split('/invite/')[1];
  assert.notEqual(token2, token);
  assert.throws(() => acceptInvite({ email: 'maya@example.com', token }), /not valid/);
  // The wrong person can't use someone else's link.
  assert.throws(() => acceptInvite({ email: 'omar@presentail.com', token: token2 }), /is for maya@example.com/);
  // Accept: a member with the invited role, title and team. Twice changes nothing.
  acceptInvite({ email: 'maya@example.com', token: token2, name: 'Maya Hassan' });
  acceptInvite({ email: 'maya@example.com', token: token2, name: 'Maya Hassan' });
  acceptInvite({ email: 'MAYA@example.com', name: 'Maya Hassan' });
  assert.equal(get("SELECT COUNT(*) AS n FROM users WHERE email = 'maya@example.com'").n, 1);
  assert.equal(get("SELECT COUNT(*) AS n FROM team_members WHERE user_email = 'maya@example.com'").n, 1);
  const maya = get("SELECT * FROM users WHERE email = 'maya@example.com'");
  assert.deepEqual([maya.role, maya.title, maya.status], ['member', 'Procurement Manager', 'active']);
  assert.equal((await call('/invitations')).body.invitations.find((i) => i.id === inv.body.invite.id).status, 'accepted');

  // Revoke and expiry.
  const r = await call('/invitations', { method: 'POST', body: { email: 'revoked@example.com' } });
  await call(`/invitations/${r.body.invite.id}`, { method: 'DELETE' });
  assert.throws(() => acceptInvite({ email: 'revoked@example.com', token: r.body.delivery.link.split('/invite/')[1] }), /withdrawn/);
  assert.equal(isAllowed('revoked@example.com'), false);
  const e = await call('/invitations', { method: 'POST', body: { email: 'late@example.com' } });
  run("UPDATE invitations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", e.body.invite.id);
  assert.throws(() => acceptInvite({ email: 'late@example.com', token: e.body.delivery.link.split('/invite/')[1] }), /expired/);
  assert.equal((await call('/invitations')).body.invitations.find((i) => i.id === e.body.invite.id).status, 'expired');
  assert.equal(isAllowed('late@example.com'), false);
  // An expired invitation can be replaced by a new one.
  assert.equal((await call('/invitations', { method: 'POST', body: { email: 'late@example.com' } })).status, 200);
});

test('without email set up, nothing claims to be sent and the link is given to share', async () => {
  const key = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  outbox.length = 0;
  const inv = await call('/invitations', { method: 'POST', body: { email: 'nomail@example.com' } });
  process.env.RESEND_API_KEY = key;
  assert.equal(inv.body.delivery.sent, false);
  assert.match(inv.body.delivery.error, /not set up/);
  assert.match(inv.body.delivery.link, /\/invite\//);
  assert.equal(outbox.length, 0);
  assert.equal(inv.body.invite.sent_at, null);
});

test('deactivation: keeps work and history, blocks sign-in and new assignments, lists what to reassign', async () => {
  const { body: t } = await call('/tasks', { method: 'POST', body: { title: 'Lee’s job', assignee: 'user:lee@presentail.com' } });
  await call(`/tasks/${t.id}/comments`, { method: 'POST', as: 'lee@presentail.com', body: { body: 'On it' } });
  assert.equal((await call('/people/lee@presentail.com/deactivate', { method: 'POST', as: 'omar@presentail.com' })).status, 403);
  const off = await call('/people/lee@presentail.com/deactivate', { method: 'POST' });
  assert.equal(off.body.status, 'deactivated');
  assert.deepEqual(off.body.needs_reassigning.map((x) => x.id), [t.id]);
  assert.equal(isAllowed('lee@presentail.com'), false, "can't sign in, even on the company domain");
  assert.ok(!(await call('/people')).body.some((p) => p.email === 'lee@presentail.com'));
  assert.ok((await call('/people?all=1')).body.some((p) => p.email === 'lee@presentail.com' && p.status === 'deactivated'));
  assert.equal((await call('/tasks', { method: 'POST', body: { title: 'x', assignee: 'user:lee@presentail.com' } })).status, 400);
  // Their task and comment are still there, still theirs.
  assert.equal(get('SELECT assignee_email FROM tasks WHERE id = ?', t.id).assignee_email, 'lee@presentail.com');
  assert.equal(get('SELECT author_name FROM task_comments WHERE task_id = ?', t.id).author_name, 'lee');
  // Re-inviting a deactivated person is refused with the way back.
  assert.match((await call('/invitations', { method: 'POST', body: { email: 'lee@presentail.com' } })).body.error, /turned off/);
  await call('/people/lee@presentail.com/reactivate', { method: 'POST' });
  assert.equal(isAllowed('lee@presentail.com'), true);
});
