import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { agentRouter, dashboardRouter, errorHandler } from './app.js';
import { startScheduler } from './scheduler.js';
import { seedIfEmpty } from './seed.js';

const PORT = Number(process.env.PORT) || 3001;
const PASSWORD = process.env.APP_PASSWORD;

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Agents authenticate with their own bearer tokens, so this router sits before the dashboard password.
app.use('/api/agent', agentRouter());

// Optional single-user password for the dashboard (HTTP Basic auth, any username).
if (PASSWORD) {
  const expected = Buffer.from(PASSWORD);
  app.use((req, res, next) => {
    const [, encoded = ''] = (req.get('authorization') || '').split(' ');
    const supplied = Buffer.from(Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':'));
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Presentail Hive"').status(401).send('Authentication required');
  });
}

app.use('/api', dashboardRouter());
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

const dist = join(process.cwd(), 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(join(dist, 'index.html')));
}

seedIfEmpty();
startScheduler();
app.listen(PORT, () => console.log(`Presentail Hive API listening on http://localhost:${PORT}`));
