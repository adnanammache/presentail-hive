import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.ALLOWED_EMAIL_DOMAIN = 'presentail.com';
process.env.ALLOWED_EMAILS = 'partner@gmail.com';
process.env.PUBLIC_URL = 'https://hive.example.com';

const express = (await import('express')).default;
const { authRouter, requireAuth, createSessionToken, isAllowed } = await import('./auth.js');
const { agentRouter, dashboardRouter } = await import('./app.js');

let server;
let base;
before(() => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRouter());
  app.use(authRouter());
  app.use(requireAuth);
  app.get('/api/me', (req, res) => res.json(req.user));
  app.use('/api', dashboardRouter());
  app.get('/', (req, res) => res.send('dashboard'));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const get = (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie: `hive_session=${cookie}` } : {} });

test('allow-list: company domain and named emails only', () => {
  assert.ok(isAllowed('adnan@presentail.com'));
  assert.ok(isAllowed('Partner@Gmail.com'));
  assert.ok(!isAllowed('someone@gmail.com'));
  assert.ok(!isAllowed('adnan@presentail.com.evil.io'));
  assert.ok(!isAllowed('adnan@notpresentail.com'));
});

test('signed-out visitors are sent to the Google sign-in page', async () => {
  let res = await get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');

  res = await get('/api/overview');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).login, '/login');

  res = await get('/login');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Continue with Google/);
});

test('/auth/google redirects to Google with state, callback URL and domain hint', async () => {
  const res = await get('/auth/google');
  assert.equal(res.status, 302);
  const url = new URL(res.headers.get('location'));
  assert.equal(url.host, 'accounts.google.com');
  assert.equal(url.searchParams.get('client_id'), process.env.GOOGLE_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://hive.example.com/auth/google/callback');
  assert.equal(url.searchParams.get('hd'), 'presentail.com');
  assert.match(res.headers.get('set-cookie'), new RegExp(`hive_oauth_state=${url.searchParams.get('state')}`));
});

test('callback rejects a mismatched state', async () => {
  const res = await fetch(`${base}/auth/google/callback?code=x&state=forged`, { redirect: 'manual', headers: { cookie: 'hive_oauth_state=real' } });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/login\?error=/);
});

test('valid sessions get in; tampered, expired or off-domain ones do not', async () => {
  const good = createSessionToken({ email: 'adnan@presentail.com', name: 'Adnan' });
  let res = await get('/api/me', good);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).email, 'adnan@presentail.com');

  const [body, sig] = good.split('.');
  const forgedBody = Buffer.from(JSON.stringify({ email: 'evil@gmail.com', name: 'x', exp: Date.now() + 1e9 })).toString('base64url');
  assert.equal((await get('/api/me', `${forgedBody}.${sig}`)).status, 401);
  assert.equal((await get('/api/me', `${body}.AAAA`)).status, 401);
  assert.equal((await get('/api/me', createSessionToken({ email: 'adnan@presentail.com' }, -1))).status, 401);
  assert.equal((await get('/api/me', createSessionToken({ email: 'someone@gmail.com' }))).status, 401);
});

test('agent API still works with agent tokens and no Google session', async () => {
  const res = await get('/api/agent/me');
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /agent token/);
});

test('logout clears the session cookie', async () => {
  const res = await get('/auth/logout', createSessionToken({ email: 'adnan@presentail.com' }));
  assert.equal(res.headers.get('location'), '/login');
  assert.match(res.headers.get('set-cookie'), /hive_session=;.*Max-Age=0/);
});
