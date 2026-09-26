import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { agentRouter, dashboardRouter, errorHandler } from './app.js';
import { authMode, authRouter, requireAuth } from './auth.js';
import { startScheduler } from './scheduler.js';
import { resumeRuns } from './managed.js';
import { seedIfEmpty } from './seed.js';
import { slackRouter } from './slack.js';
import { wafeqGateway } from './wafeq.js';
import { scheduleBrief } from './brief.js';
import { scheduleBackups } from './backup.js';
import { scheduleHealthChecks } from './health.js';
import { startTaskTicker } from './taskSchedule.js';
import { agentAvatar } from './avatars.js';

const PORT = Number(process.env.PORT) || 3001;

if (process.env.NODE_ENV === 'production' && authMode() === 'none' && !process.env.ALLOW_NO_PASSWORD) {
  console.error('Refusing to start: configure Google sign-in (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET) or APP_PASSWORD so the dashboard is not open to the internet.');
  process.exit(1);
}
if (authMode() === 'google' && !process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET is not set; falling back to the Google client secret for signing sessions.');
}

const app = express();
app.set('trust proxy', 1); // Railway terminates TLS in front of us; needed for secure cookies and redirect URLs
// Slack signs its button clicks; verified against the raw body, so this comes before the JSON parser.
app.use(slackRouter());
app.use(wafeqGateway()); // agents' Wafeq calls; each run has its own secret address (no login)
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Agents authenticate with their own bearer tokens, so this router sits before the dashboard sign-in.
app.use('/api/agent', agentRouter());

// App icons, manifest and service worker must load before sign-in so phones can install Hive.
const dist = join(process.cwd(), 'dist');
for (const file of ['manifest.webmanifest', 'sw.js', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
  app.get(`/${file}`, (req, res, next) => (existsSync(join(dist, file)) ? res.sendFile(join(dist, file)) : next()));
}

// Brand artwork for the sign-in page (public: it's shown before sign-in).
app.use('/brand', express.static(join(dist, 'brand'), { maxAge: '7d', fallthrough: false }));

// Agent pictures (uploaded photo or robot face), for the app and for Slack next to each agent's
// messages. Public: Slack fetches them, and they carry no names.
app.get('/avatars/:file', async (req, res) => {
  const img = await agentAvatar(Number.parseInt(req.params.file, 10));
  if (!img) return res.status(404).end();
  // URLs carry ?v=<version>, so a changed photo is a new URL; the file itself can be cached.
  res.type(img.type).set({ 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' }).send(img.body);
});

// Sign-in pages (/login, /auth/*) are public; everything after requireAuth needs a signed-in user.
app.use(authRouter());
app.use(requireAuth);

app.use('/api', dashboardRouter());
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(join(dist, 'index.html')));
}

seedIfEmpty();
startScheduler();
startTaskTicker(); // scheduled starts, reminders and repeating tasks, every minute (Dubai time)
scheduleBrief();
scheduleBackups();
scheduleHealthChecks();
resumeRuns();
app.listen(PORT, () => console.log(`Presentail Hive listening on http://localhost:${PORT} (sign-in: ${authMode()})`));
