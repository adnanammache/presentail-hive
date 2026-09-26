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
      // Domain sign-ins must come from the company's Google Workspace (the hd claim), not a personal
      // Google account that happens to be registered with a company address.
      const { emails, domains } = env();
      if (!emails.includes(user.email.toLowerCase()) && !domains.includes(String(user.hd || '').toLowerCase())) {
        return fail('Please sign in with your Presentail Google Workspace account.');
      }

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

// ---------- sign-in page ----------
// A calm, on-brand page: the forest-green brand panel with the Presentail wordmark and a honeycomb of
// connected agents, and the sign-in card. Plain server-rendered HTML so it works before sign-in.

/** Points of a pointy-top hexagon centred on (cx, cy). */
const hexPts = (cx, cy, r) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i - 90);
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');

/** The decorative honeycomb: a central hub, outlined cells, filled cells, connectors and nodes. */
function honeycombSvg() {
  const outline = [[38, 190, 34], [104, 146, 34], [410, 48, 42], [358, 292, 32], [574, 124, 44], [668, 262, 40]];
  const filled = [[200, 56, 25], [200, 256, 23], [580, 222, 21]];
  const nodes = [[224, 139], [453, 76], [591, 80], [468, 170], [468, 238], [118, 198], [510, 302], [266, 343], [628, 238]];
  const lines = [
    [200, 56, 359, 153], [224, 139, 359, 153], [224, 139, 118, 198], [118, 198, 200, 256], [200, 256, 359, 153],
    [359, 153, 453, 76], [453, 76, 591, 80], [359, 153, 468, 170], [468, 170, 468, 238],
    [468, 170, 574, 124], [468, 238, 580, 222], [580, 222, 628, 238], [359, 153, 358, 260], [358, 260, 266, 343],
    [580, 222, 510, 302], [200, 256, 266, 343], [138, 146, 200, 56],
  ];
  const hub = hexPts(359, 153, 62);
  return `<svg class="honeycomb" viewBox="0 0 720 360" aria-hidden="true" focusable="false" preserveAspectRatio="xMinYMid meet">
  <g fill="none" stroke="#D5A348" stroke-width="1.2" stroke-opacity=".75">${lines.map(([a, b, c, d]) => `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}"/>`).join('')}</g>
  <g fill="none" stroke="#D5A348" stroke-width="1.4" stroke-opacity=".85">${outline.map(([x, y, r]) => `<polygon points="${hexPts(x, y, r)}"/>`).join('')}</g>
  <g fill="#D5A348">${filled.map(([x, y, r]) => `<polygon points="${hexPts(x, y, r)}"/>`).join('')}${nodes.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5"/>`).join('')}</g>
  <path fill="#D5A348" fill-rule="evenodd" d="M${hub.replace(/ /g, ' L')} Z M${359 + 26} 153 a26 26 0 1 0 -52 0 a26 26 0 1 0 52 0 Z"/>
  <circle cx="359" cy="153" r="25.5" fill="#223B2E"/>
</svg>`;
}

const HIVE_MARK = `<svg class="mark" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true" focusable="false"><path fill="#D5A348" fill-rule="evenodd" d="M32 4 56.2 18v28L32 60 7.8 46V18Z M43 32a11 11 0 1 0-22 0 11 11 0 1 0 22 0Z"/></svg>`;

const GOOGLE_G = `<svg width="22" height="22" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

function loginPage(error) {
  const domains = env().domains.map((d) => '@' + d);
  const accountHint = domains.length ? `Sign in with your ${esc(domains.join(' or '))} account.` : 'Sign in with your approved Google account.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Presentail Hive</title>
<meta name="theme-color" content="#223B2E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path fill='%23D5A348' fill-rule='evenodd' d='M32 4 56.2 18v28L32 60 7.8 46V18Z M43 32a11 11 0 1 0-22 0 11 11 0 1 0 22 0Z'/></svg>">
<style>
:root{
  --forest:#223B2E; /* matches the wordmark artwork's background exactly */
  --ivory:#F8F5ED; --card:#FFFFFF; --gold:#D5A348; --text:#1B2B22; --muted:#697386; --border:#E2DACE;
  --on-forest:#F6F1E4; --red:#B42318; --red-soft:#FEF0EE;
  --sans:"Inter","Segoe UI",ui-sans-serif,system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--ivory);color:var(--text);font:16px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
.page{display:grid;grid-template-columns:57fr 43fr;min-height:100vh;min-height:100dvh}

/* brand panel */
.brand{background:var(--forest);color:var(--on-forest);display:flex;flex-direction:column;
  padding:clamp(40px,4.4vw,72px) clamp(36px,4.4vw,72px) clamp(28px,3vw,44px);min-width:0}
.lockup{display:flex;align-items:center;gap:clamp(18px,2vw,30px)}
.lockup img{display:block;width:clamp(200px,19vw,290px);height:auto}
.lockup .divider{width:1px;align-self:stretch;min-height:56px;background:var(--gold);opacity:.7}
.lockup .hive{font-size:clamp(20px,1.9vw,30px);letter-spacing:.34em;color:var(--gold);font-weight:400;line-height:1}
.copy{margin-top:clamp(40px,6.5vh,84px);max-width:760px}
.copy h1{margin:0;font-weight:800;font-size:clamp(46px,4.75vw,76px);line-height:1.08;letter-spacing:-.025em;color:var(--on-forest)}
.copy h1 span{display:block}
.copy p{margin:clamp(18px,2.4vh,28px) 0 0;font-size:clamp(18px,1.45vw,23px);line-height:1.5;max-width:34em;color:rgba(246,241,228,.88)}
.art{margin-top:clamp(24px,4vh,48px);flex:1 1 auto;display:flex;align-items:center;min-height:0}
.honeycomb{display:block;width:100%;max-width:720px;height:auto;max-height:44vh}
.foot{margin-top:clamp(20px,3vh,36px);font-size:14px;color:rgba(246,241,228,.78)}

/* sign-in */
.signin{display:flex;align-items:center;justify-content:center;padding:clamp(32px,4vw,64px) clamp(20px,3.6vw,56px)}
.card{width:100%;max-width:550px;background:var(--card);border:1px solid var(--border);border-radius:14px;
  padding:clamp(32px,3.4vw,48px) clamp(24px,3vw,40px) clamp(28px,3vw,36px);text-align:center;
  box-shadow:0 1px 2px rgba(34,59,46,.04),0 14px 40px rgba(34,59,46,.06)}
.mark{display:block;width:64px;height:64px;margin:0 auto 22px}
.card h2{margin:0;font-size:clamp(24px,2vw,31px);line-height:1.2;letter-spacing:-.02em;font-weight:800;color:var(--forest);text-wrap:balance}
.card .sub{margin:12px 0 0;color:var(--muted);font-size:clamp(16px,1.2vw,18px)}
.err{margin:22px 0 0;background:var(--red-soft);color:var(--red);border:1px solid #F8D3CF;border-radius:10px;padding:11px 14px;font-size:14.5px;text-align:left}
form{margin:30px 0 0}
.google{display:flex;align-items:center;justify-content:center;gap:14px;width:100%;min-height:58px;padding:12px 20px;
  background:#fff;color:#1F2328;border:1px solid #CFCFD3;border-radius:8px;font:500 17px/1.2 var(--sans);cursor:pointer;
  transition:background-color .15s ease,border-color .15s ease,box-shadow .15s ease}
.google:hover{background:#FAFAF7;border-color:#B9B5AC}
.google:active{background:#F3F1EB}
.google:focus-visible{outline:3px solid var(--gold);outline-offset:3px}
.google[aria-busy="true"]{cursor:progress;color:#57606A}
.google .spin{display:none;width:18px;height:18px;border-radius:50%;border:2px solid #D0D7DE;border-top-color:var(--forest);animation:spin .8s linear infinite}
.google[aria-busy="true"] .spin{display:inline-block}
.google[aria-busy="true"] .g{display:none}
@keyframes spin{to{transform:rotate(360deg)}}
.hint{margin:16px 0 0;color:var(--muted);font-size:15px}
.sep{height:1px;background:var(--border);border:0;margin:clamp(26px,3.4vh,36px) 0}
.help{margin:0;color:var(--muted);font-size:15px}

/* short laptop screens: keep everything in view */
@media (min-width:981px) and (max-height:820px){
  .copy{margin-top:32px}.honeycomb{max-height:34vh}.foot{margin-top:16px}
}
/* stacked: tablets and phones */
@media (max-width:980px){
  .page{grid-template-columns:1fr}
  .brand{padding:36px clamp(20px,6vw,56px) 32px}
  .copy{margin-top:36px}
  .copy h1{font-size:clamp(36px,7vw,56px)}
  .art{margin-top:28px}.honeycomb{max-height:220px;max-width:560px}
  .foot{display:none}
  .signin{padding:32px clamp(20px,6vw,56px) 48px}
}
@media (max-width:600px){
  .brand{padding:28px 22px 30px}
  .lockup{gap:16px}.lockup img{width:180px}.lockup .divider{min-height:44px}.lockup .hive{font-size:18px}
  .copy{margin-top:28px}.copy h1{font-size:clamp(34px,10vw,42px)}.copy p{font-size:17px}
  .art{display:none}
  .signin{padding:24px 20px 40px;align-items:flex-start}
  .card{padding:30px 22px 26px}
}
@media (prefers-reduced-motion:reduce){.google{transition:none}.google .spin{animation-duration:2.4s}}
</style></head>
<body>
<div class="page">
  <section class="brand" aria-label="Presentail Hive">
    <div class="lockup">
      <img src="/brand/presentail-wordmark.png" width="297" height="84" alt="Presentail, flowers &amp; gifts">
      <span class="divider" aria-hidden="true"></span>
      <span class="hive">HIVE</span>
    </div>
    <div class="copy">
      <h1><span>Your AI workforce.</span> <span>One workspace.</span></h1>
      <p>Assign work, monitor your agents, and review what needs your attention.</p>
    </div>
    <div class="art">${honeycombSvg()}</div>
    <div class="foot">Presentail Hive</div>
  </section>

  <main class="signin">
    <div class="card">
      ${HIVE_MARK}
      <h2>Welcome to Presentail Hive</h2>
      <p class="sub">Your workspace for coordinated AI work.</p>
      ${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
      <form method="get" action="/auth/google" id="signin">
        <button type="submit" class="google" id="google">
          <span class="g">${GOOGLE_G}</span><span class="spin" aria-hidden="true"></span>
          <span class="label">Continue with Google</span>
        </button>
      </form>
      <p class="hint">${accountHint}</p>
      <hr class="sep">
      <p class="help">Need access? Contact your administrator.</p>
    </div>
  </main>
</div>
<script>
(function () {
  var form = document.getElementById('signin'), btn = document.getElementById('google'), label = btn.querySelector('.label');
  form.addEventListener('submit', function (e) {
    if (btn.getAttribute('aria-busy') === 'true') { e.preventDefault(); return; } // one sign-in at a time
    btn.setAttribute('aria-busy', 'true');
    label.textContent = 'Redirecting to Google…';
  });
  // Coming back with the browser's Back button: make the button usable again.
  window.addEventListener('pageshow', function () { btn.removeAttribute('aria-busy'); label.textContent = 'Continue with Google'; });
})();
</script>
</body></html>`;
}
