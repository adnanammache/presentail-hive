// "Your setup checklist": what's still left to get Hive fully working, worked out from live state.
// Each item ticks itself off once Hive can see it's done; manual items are ticked in the UI.
import { all, get, run } from './db.js';
import { managedReady } from './managed.js';
import { integrationList } from './capabilities.js';
import { slackButtonsEnabled, slackConfigured } from './notify.js';
import { approvers } from './slack.js';
import { subscriptionCount } from './push.js';
import { authMode } from './auth.js';

const DONE_KEY = 'setup-done';
const HIDDEN_KEY = 'setup-hidden';

const meta = (key) => get('SELECT value FROM app_meta WHERE key = ?', key)?.value ?? null;
const setMeta = (key, value) =>
  run('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);

/** Remember that something was verified (e.g. 'slack-tested'), so its item ticks itself. */
export const markVerified = (key) => setMeta(`verified:${key}`, new Date().toISOString());
const verified = (key) => Boolean(meta(`verified:${key}`));

function manualDone() {
  try {
    return new Set(JSON.parse(meta(DONE_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

export function setManualDone(key, done) {
  const set = manualDone();
  if (done) set.add(key);
  else set.delete(key);
  setMeta(DONE_KEY, JSON.stringify([...set]));
}

export const setHidden = (hidden) => setMeta(HIDDEN_KEY, hidden ? '1' : '');

export function setupChecklist() {
  const integ = Object.fromEntries(integrationList().map((i) => [i.key, i.configured]));
  const manual = manualDone();
  const live = all("SELECT name FROM agents WHERE platform = 'managed' AND ma_agent_id IS NOT NULL");
  const finished = get("SELECT COUNT(*) AS n FROM runs WHERE kind = 'task' AND status IN ('waiting', 'ended')").n;
  const odooRuns = get("SELECT COUNT(*) AS n FROM odoo_actions WHERE status = 'executed' AND kind != 'read'").n;
  const notSetUp = get("SELECT COUNT(*) AS n FROM agents WHERE status = 'paused'").n;

  const items = [
    { key: 'google', title: 'Sign in with Google', detail: 'Only @presentail.com accounts can open Hive.', done: authMode() === 'google', href: '#/settings' },
    { key: 'anthropic', title: 'Connect Claude', detail: 'Set ANTHROPIC_API_KEY in Railway (with Managed Agents access). Powers every agent.', done: managedReady(), href: '#/settings' },
    { key: 'wafeq', title: 'Connect Wafeq', detail: 'Add WAFEQ_API_KEY in Railway so Ledger can post bills.', done: Boolean(integ.wafeq), href: '#/settings' },
    { key: 'odoo', title: 'Connect Odoo', detail: 'Add ODOO_API_KEY in Railway, then Settings → Odoo → Test connection.', done: Boolean(integ.odoo) && verified('odoo-tested'), href: '#/settings' },
    { key: 'slack', title: 'Turn on Slack alerts', detail: 'Add SLACK_BOT_TOKEN and SLACK_ALERT_CHANNEL, then Settings → Send test alert.', done: slackConfigured() && verified('slack-tested'), href: '#/settings' },
    {
      key: 'first-live',
      title: 'Make your first agent live',
      detail: 'Open Ledger → Skills & tools, tick the Talabat skills, PDF, Excel and Wafeq, then "Make it a Managed Agent".',
      done: live.length > 0,
      progress: live.length ? live.map((a) => a.name).join(', ') : null,
      href: '#/agents',
    },
    { key: 'first-run', title: 'Run a first real task', detail: 'Try the Talabat month-end and stop at the dry run. Nothing posts without your approval.', done: finished > 0, href: '#/tasks' },
    { key: 'odoo-run', title: 'First approved Odoo change', detail: 'Give Odoo Operator a read-only task first, then Toters for the month.', done: odooRuns > 0, href: '#/agents' },
    {
      key: 'agents',
      title: 'Set up the rest of the team',
      detail: notSetUp ? `${notSetUp} agent${notSetUp === 1 ? ' is' : 's are'} still not set up (Cyprus Accountant, Auditor, …). Delete or assign Replit Builder.` : 'Every agent is set up.',
      done: notSetUp === 0,
      href: '#/map',
    },
    { key: 'backups', title: 'Check daily backups', detail: 'Confirm backups are on for the Railway volume that holds Hive’s database.', manual: true },
    { key: 'make-webhook', title: 'Regenerate the old Make webhook', detail: 'Its URL was in the skills you shared. Make → the webhook → regenerate.', manual: true },
    {
      key: 'phone',
      title: 'Hive on your phone, with notifications',
      detail: 'Open hive.presentail.com → Share → Add to Home Screen, open it from there, then Settings → Turn on notifications.',
      done: subscriptionCount() > 0,
      href: '#/settings',
    },
  ].map((i) => (i.manual ? { ...i, done: manual.has(i.key) } : i));

  return { items, hidden: Boolean(meta(HIDDEN_KEY)), done: items.filter((i) => i.done).length, total: items.length };
}
