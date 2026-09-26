// System health: is each connection working right now, when did it last work, and the last error.
// Two sources: live checks (on demand and every 30 minutes) and what Hive sees while working
// (every Slack post, Odoo call and agent run reports in through recordHealth).
import { Cron } from 'croner';
import { get, run } from './db.js';
import { emit } from './events.js';

const KEY = (k) => `health:${k}`;
const read = (k) => {
  try {
    return JSON.parse(get('SELECT value FROM app_meta WHERE key = ?', KEY(k))?.value || '{}');
  } catch {
    return {};
  }
};

/** Record an outcome for a connection. Cheap; call it from anywhere. */
export function recordHealth(key, ok, error = null) {
  const prev = read(key);
  const now = new Date().toISOString();
  const next = ok
    ? { ...prev, ok: true, last_ok: now, checked_at: now }
    : { ...prev, ok: false, last_error: String(error ?? 'Unknown error').slice(0, 500), last_error_at: now, checked_at: now };
  run('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY(key), JSON.stringify(next));
  if (prev.ok !== next.ok) emit('health', { key });
}

const timeout = (ms) => AbortSignal.timeout(ms);
async function probe(key, fn) {
  try {
    const detail = await fn();
    recordHealth(key, true);
    return detail ?? null;
  } catch (err) {
    recordHealth(key, false, err.message);
    return null;
  }
}

/** The live checks. Each is a harmless read. */
export const CHECKS = {
  anthropic: {
    name: 'Claude (Anthropic)',
    configured: () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    env: 'ANTHROPIC_API_KEY',
    check: async () => {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: {
          'anthropic-version': '2023-06-01',
          ...(process.env.ANTHROPIC_API_KEY ? { 'x-api-key': process.env.ANTHROPIC_API_KEY } : { Authorization: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}` }),
        },
        signal: timeout(15000),
      });
      if (!res.ok) throw new Error(`Anthropic answered ${res.status}${res.status === 401 ? ': the API key is not valid' : ''}`);
    },
  },
  odoo: {
    name: 'Odoo',
    configured: () => Boolean(process.env.ODOO_API_KEY),
    env: 'ODOO_API_KEY',
    check: async () => {
      const { testOdoo } = await import('./odoo.js');
      const r = await testOdoo();
      return `${r.companies.length} companies visible`;
    },
  },
  wafeq: {
    name: 'Wafeq',
    configured: () => Boolean(process.env.WAFEQ_API_KEY),
    env: 'WAFEQ_API_KEY',
    check: async () => {
      const res = await fetch('https://api.wafeq.com/v1/accounts/?page_size=1', { headers: { Authorization: `Api-Key ${process.env.WAFEQ_API_KEY}` }, signal: timeout(15000) });
      if (!res.ok) throw new Error(`Wafeq answered ${res.status}${res.status === 401 || res.status === 403 ? ': the API key is not valid' : ''}`);
    },
  },
  google: {
    name: 'Google (Drive, Gmail)',
    configured: () => Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    env: 'GOOGLE_SERVICE_ACCOUNT_JSON',
    check: async () => {
      const { testGoogle } = await import('./google.js');
      return testGoogle();
    },
  },
  slack: {
    name: 'Slack',
    configured: () => Boolean(process.env.SLACK_BOT_TOKEN),
    env: 'SLACK_BOT_TOKEN',
    check: async () => {
      const res = await fetch('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, signal: timeout(10000) });
      const json = await res.json().catch(() => null);
      if (!json) throw new Error(`Slack answered ${res.status} (not reachable from Hive)`);
      if (!json.ok) throw new Error(`Slack said: ${json.error}${json.error === 'invalid_auth' ? ' (the bot token is not valid)' : ''}`);
      return `connected to ${json.team} as ${json.user}`;
    },
  },
};

const details = new Map();
export async function runChecks() {
  await Promise.all(
    Object.entries(CHECKS)
      .filter(([, c]) => c.configured())
      .map(async ([k, c]) => details.set(k, await probe(k, c.check))),
  );
  return healthReport();
}

export function healthReport() {
  const rows = Object.entries(CHECKS).map(([key, c]) => {
    const h = read(key);
    const configured = c.configured();
    return {
      key,
      name: c.name,
      configured,
      env: c.env,
      state: !configured ? 'off' : h.ok === false ? 'down' : h.ok ? 'ok' : 'unknown',
      detail: details.get(key) ?? null,
      last_ok: h.last_ok ?? null,
      last_error: h.last_error ?? null,
      last_error_at: h.last_error_at ?? null,
      checked_at: h.checked_at ?? null,
    };
  });
  // Hive's own jobs.
  const failedRuns = get("SELECT COUNT(*) AS n FROM runs WHERE status = 'failed' AND updated_at >= datetime('now', '-1 day')").n;
  const lastFail = get("SELECT error, updated_at FROM runs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 1");
  rows.push({
    key: 'runs',
    name: 'Agent runs',
    configured: true,
    state: failedRuns ? 'warn' : 'ok',
    detail: failedRuns ? `${failedRuns} failed in the last 24 hours` : 'No failures in the last 24 hours',
    last_error: lastFail?.error ?? null,
    last_error_at: lastFail?.updated_at ? `${lastFail.updated_at.replace(' ', 'T')}Z` : null,
  });
  const backup = read('backup');
  rows.push({
    key: 'backup',
    name: 'Backups',
    configured: true,
    state: backup.ok === false ? 'down' : backup.last_ok && Date.now() - new Date(backup.last_ok) < 30 * 3600 * 1000 ? 'ok' : 'warn',
    detail: backup.last_ok ? null : 'No backup yet',
    last_ok: backup.last_ok ?? null,
    last_error: backup.last_error ?? null,
    last_error_at: backup.last_error_at ?? null,
  });
  return { rows, down: rows.filter((r) => r.state === 'down').map((r) => r.name) };
}

let job = null;
export function scheduleHealthChecks() {
  job?.stop();
  job = new Cron('*/30 * * * *', { protect: true }, () => runChecks().catch(() => {}));
  setTimeout(() => runChecks().catch(() => {}), 5000); // shortly after start
}
export const stopHealthChecks = () => (job?.stop(), (job = null));
