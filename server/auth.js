// Dashboard sign-in.
//
// Preferred: "Continue with Google" (OpenID Connect, authorization-code flow), restricted to
// ALLOWED_EMAIL_DOMAIN (default presentail.com) and/or an explicit ALLOWED_EMAILS list.
// Fallback: APP_PASSWORD via HTTP Basic auth, for local use or before Google is configured.
//
// Sessions are a signed cookie (HMAC-SHA256); no session store is needed.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';

const COOKIE = 'hive_session';
const STATE_COOKIE = 'hive_oauth_state';
const SESSION_DAYS = 30;

const env = () => ({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  secret: process.env.SESSION_SECRET,
  domains: (process.env.ALLOWED_EMAIL_DOMAIN ?? 'presentail.com').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
  emails: (process.env.ALLOWED_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  password: process.env.APP_PASSWORD,
});

export const googleEnabled = () => Boolean(env().clientId && env().clientSecret);
export const authMode = () => (googleEnabled() ? 'google' : env().password ? 'password' : 'none');

// ---------- signed cookies ----------
function sessionKey() {
  const { secret, clientSecret } = env();
  // SESSION_SECRET is recommended; the client secret is a stable fallback so a missing variable
  // doesn't log everyone out on each restart.
  return secret || clientSecret || 'dev-only-secret';
}
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (payload) => {
  const body = b64(JSON.stringify(payload));
  return `${body}.${createHmac('sha256', sessionKey()).update(body).digest('base64url')}`;
};
function verify(token) {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', sessionKey()).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  return payload.exp > Date.now() ? payload : null;
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function setCookie(req, res, name, value, maxAgeSec) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

/** Exposed for tests. */
export const createSessionToken = (user, days = SESSION_DAYS) => sign({ ...user, exp: Date.now() + days * 864e5 });

export function isAllowed(email) {
  const { domains, emails } = env();
  const e = String(email || '').toLowerCase();
  if (emails.includes(e)) return true;
  return domains.some((d) => e.endsWith('@' + d));
}

const baseUrl = (req) => process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;

// ---------- routes ----------
export function authRouter() {
  const r = express.Router();

  r.get('/login', (req, res) => {
    if (authMode() !== 'google') return res.redirect('/');
    if (verify(readCookie(req, COOKIE))) return res.redirect('/');
    res.type('html').send(loginPage(req.query.error));
  });

  r.get('/auth/google', (req, res) => {
    if (!googleEnabled()) return res.redirect('/');
    const state = randomBytes(16).toString('hex');
    setCookie(req, res, STATE_COOKIE, state, 600);
    const params = new URLSearchParams({
      client_id: env().clientId,
      redirect_uri: `${baseUrl(req)}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    // `hd` pre-selects the Workspace domain in Google's account chooser (a hint only; enforced below).
    if (env().domains.length === 1) params.set('hd', env().domains[0]);
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  r.get('/auth/google/callback', async (req, res) => {
    const fail = (msg) => res.redirect(`/login?error=${encodeURIComponent(msg)}`);
    try {
      const expectedState = readCookie(req, STATE_COOKIE);
      setCookie(req, res, STATE_COOKIE, '', 0);
      if (req.query.error) return fail('Google sign-in was cancelled.');
      if (!expectedState || req.query.state !== expectedState) return fail('Sign-in expired, please try again.');

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(req.query.code || ''),
          client_id: env().clientId,
          client_secret: env().clientSecret,
          redirect_uri: `${baseUrl(req)}/auth/google/callback`,
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenRes.ok) return fail('Could not complete Google sign-in.');
      const { access_token } = await tokenRes.json();

      // Fetched directly from Google over TLS with the access token we just received.
      const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!infoRes.ok) return fail('Could not read your Google profile.');
      const user = await infoRes.json();

      if (!user.email_verified) return fail('Your Google email is not verified.');
      if (!isAllowed(user.email)) return fail(`${user.email} is not allowed to access Presentail Hive.`);

      const session = { email: user.email, name: user.name || user.email, picture: user.picture || '', exp: Date.now() + SESSION_DAYS * 864e5 };
      setCookie(req, res, COOKIE, sign(session), SESSION_DAYS * 86400);
      console.log(`[auth] ${user.email} signed in`);
      res.redirect('/');
    } catch (err) {
      console.error('[auth] callback failed:', err.message);
      fail('Sign-in failed, please try again.');
    }
  });

  r.get('/auth/logout', (req, res) => {
    setCookie(req, res, COOKIE, '', 0);
    res.redirect(authMode() === 'google' ? '/login' : '/');
  });

  return r;
}

/** Protects everything mounted after it. Sets req.user when signed in. */
export function requireAuth(req, res, next) {
  const mode = authMode();
  if (mode === 'google') {
    const session = verify(readCookie(req, COOKIE));
    if (session && isAllowed(session.email)) {
      req.user = { email: session.email, name: session.name, picture: session.picture };
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in', login: '/login' });
    return res.redirect('/login');
  }
  if (mode === 'password') {
    const expected = Buffer.from(env().password);
    const [, encoded = ''] = (req.get('authorization') || '').split(' ');
    const supplied = Buffer.from(Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':'));
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
      req.user = { email: '', name: 'Admin', picture: '' };
      return next();
    }
    return res.set('WWW-Authenticate', 'Basic realm="Presentail Hive"').status(401).send('Authentication required');
  }
  req.user = { email: '', name: 'Local', picture: '' };
  next();
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function loginPage(error) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Presentail Hive</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><path d='M16 1.5 29 9v14L16 30.5 3 23V9z' fill='%23f59e0b'/><path d='M16 10.5 21 13.4v5.2L16 21.5l-5-2.9v-5.2z' fill='white'/></svg>">
<style>
:root{--bg:#f6f7fb;--panel:#fff;--text:#0f172a;--muted:#64748b;--border:#e4e7ef;--red:#dc2626;--red-soft:#fdecec}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d14;--panel:#131722;--text:#e6e9f2;--muted:#8b93a7;--border:#252b3b;--red:#f87171;--red-soft:#2e1618}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 Inter,system-ui,-apple-system,'Segoe UI',sans-serif;padding:16px}
.card{width:100%;max-width:380px;background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:36px 28px;text-align:center;box-shadow:0 10px 40px rgb(15 23 42/.08)}
.mark{width:52px;height:56px;margin:0 auto 18px;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);background:radial-gradient(circle,#fff 0 9px,transparent 10px),linear-gradient(135deg,#f59e0b,#d97706)}
h1{font-size:22px;margin:0 0 4px}p{color:var(--muted);margin:0 0 26px}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:11px 16px;border:1px solid var(--border);border-radius:10px;background:var(--panel);color:var(--text);font-weight:600;text-decoration:none}
.btn:hover{border-color:#94a3b8}.err{background:var(--red-soft);color:var(--red);border-radius:10px;padding:9px 12px;margin-bottom:16px;font-size:13.5px}
small{display:block;margin-top:18px;color:var(--muted)}
</style></head><body><main class="card">
<div class="mark"></div><h1>Presentail Hive</h1><p>Mission control for our AI agents</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<a class="btn" href="/auth/google"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Continue with Google</a>
<small>Only ${esc(env().domains.map((d) => '@' + d).join(', ') || 'approved')} accounts can sign in.</small>
</main></body></html>`;
}
