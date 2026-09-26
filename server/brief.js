// The daily brief from your Chief of Staff: what every department did since the last brief,
// what's waiting on you, what failed, what's scheduled today and what it cost.
// Built from Hive's own records (no model call), so it's instant, free and always accurate.
// Delivered to the dashboard, the Chief of Staff's inbox thread and Slack.
import { Cron } from 'croner';
import { all, get, run } from './db.js';
import { emit } from './events.js';
import { baseUrl, sendSlack } from './notify.js';
import { nextRuns } from './scheduler.js';
import { pushToAll } from './push.js';
import { closeSummary } from './close.js';

const CONFIG_KEY = 'brief-config';
export const DEFAULT_CONFIG = { enabled: true, time: '07:45', days: '1-5', timezone: 'Asia/Dubai' };

export function briefConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(get('SELECT value FROM app_meta WHERE key = ?', CONFIG_KEY)?.value || '{}') };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function setBriefConfig(patch) {
  const next = { ...briefConfig() };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (patch.time !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.time)) throw new Error('Time must be HH:MM');
    next.time = patch.time;
  }
  if (patch.days !== undefined) {
    if (!['*', '1-5', '1-6', '0-4'].includes(patch.days)) throw new Error('Unknown days');
    next.days = patch.days;
  }
  if (patch.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: patch.timezone });
    } catch {
      throw new Error('Unknown time zone');
    }
    next.timezone = patch.timezone;
  }
  run('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', CONFIG_KEY, JSON.stringify(next));
  scheduleBrief();
  return next;
}

const cronFor = (c) => {
  const [h, m] = c.time.split(':').map(Number);
  return `${m} ${h} * * ${c.days}`;
};
export const nextBriefAt = () => {
  const c = briefConfig();
  return c.enabled ? nextRuns(cronFor(c), c.timezone)[0] ?? null : null;
};

let job = null;
export function scheduleBrief() {
  job?.stop();
  job = null;
  const c = briefConfig();
  if (!c.enabled) return;
  job = new Cron(cronFor(c), { timezone: c.timezone, protect: true }, () =>
    sendBrief().catch((err) => console.error('[brief]', err.message)),
  );
}
export const stopBrief = () => (job?.stop(), (job = null));

/** Who signs the brief: the agent titled Chief of Staff, if there is one. */
const chiefOfStaff = () => get("SELECT id, name, title FROM agents WHERE title LIKE 'Chief of Staff%' ORDER BY id LIMIT 1");

/** Everything since `since` (SQLite UTC 'YYYY-MM-DD HH:MM:SS'). */
export function buildBrief({ since } = {}) {
  const last = get('SELECT created_at FROM briefs ORDER BY id DESC LIMIT 1')?.created_at;
  // Since the last brief, but never more than 3 days back (Monday covers the weekend).
  since ??= get(
    "SELECT MAX(COALESCE(?, datetime('now', '-1 day')), datetime('now', '-3 days')) AS s",
    last ?? null,
  ).s;

  const approvals = all(
    `SELECT r.id AS run_id, r.task_id, r.pending, a.name AS agent, t.title FROM runs r
     JOIN agents a ON a.id = r.agent_id LEFT JOIN tasks t ON t.id = r.task_id
     WHERE r.status = 'needs_approval' ORDER BY r.updated_at`,
  ).map((r) => {
    let n = 0;
    try {
      n = JSON.parse(r.pending).length;
    } catch {}
    return { run_id: r.run_id, task_id: r.task_id, agent: r.agent, title: r.title ?? 'a chat', count: n };
  });
  const review = all(
    `SELECT t.id AS task_id, t.title, CASE WHEN t.blocked_kind IS NOT NULL THEN 'blocked' ELSE t.status END AS status, t.result, a.name AS agent
     FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id
     WHERE (t.status IN ('review', 'waiting_approval') OR (t.blocked_kind IS NOT NULL AND t.status != 'done'))
       AND t.id NOT IN (SELECT task_id FROM runs WHERE status = 'needs_approval' AND task_id IS NOT NULL)
     ORDER BY CASE WHEN t.blocked_kind IS NOT NULL THEN 0 ELSE 1 END, t.updated_at DESC LIMIT 12`,
  );

  const doneRows = all(
    `SELECT t.id AS task_id, t.title, t.status, a.name AS agent, COALESCE(tm.name, 'No team') AS team, COALESCE(tm.color, '#94a3b8') AS color
     FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id LEFT JOIN teams tm ON tm.id = a.team_id
     WHERE (t.status = 'done' AND t.completed_at > ?) OR (t.status = 'review' AND t.updated_at > ?)
     ORDER BY team, t.updated_at`,
    since,
    since,
  );
  const teams = [];
  for (const r of doneRows) {
    let g = teams.find((x) => x.team === r.team);
    if (!g) teams.push((g = { team: r.team, color: r.color, items: [] }));
    g.items.push({ task_id: r.task_id, title: r.title, agent: r.agent, status: r.status });
  }

  const failed = [
    ...all(
      `SELECT r.task_id, r.error, a.name AS agent, t.title FROM runs r JOIN agents a ON a.id = r.agent_id LEFT JOIN tasks t ON t.id = r.task_id
       WHERE r.status = 'failed' AND r.updated_at > ?`,
      since,
    ),
    ...all(
      `SELECT r.task_id, r.output AS error, a.name AS agent, w.name AS title FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id
       LEFT JOIN agents a ON a.id = w.agent_id WHERE r.status = 'failed' AND r.started_at > ?`,
      since,
    ),
  ].map((f) => ({ ...f, error: (f.error || '').slice(0, 200) }));

  const now = Date.now();
  const today = all('SELECT w.id, w.name, w.schedule, w.timezone, a.name AS agent FROM workflows w LEFT JOIN agents a ON a.id = w.agent_id WHERE w.enabled = 1')
    .map((w) => ({ ...w, at: nextRuns(w.schedule, w.timezone)[0] }))
    .filter((w) => w.at && new Date(w.at).getTime() - now < 24 * 3600 * 1000)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(({ id, name, agent, at, timezone }) => ({ id, name, agent, at, timezone }));

  const spend = {
    since_cents: get('SELECT COALESCE(SUM(cost_cents), 0) AS c FROM runs WHERE created_at > ?', since).c,
    month_cents: get("SELECT COALESCE(SUM(cost_cents), 0) AS c FROM runs WHERE created_at >= date('now', 'start of month')").c,
  };

  const waiting = approvals.length + review.length;
  const doneCount = doneRows.length;
  const headline =
    [
      waiting ? `${waiting} thing${waiting === 1 ? '' : 's'} waiting on you` : 'Nothing waiting on you',
      doneCount ? `${doneCount} task${doneCount === 1 ? '' : 's'} finished` : null,
      failed.length ? `${failed.length} failure${failed.length === 1 ? '' : 's'}` : null,
      today.length ? `${today.length} scheduled today` : null,
    ]
      .filter(Boolean)
      .join(' · ') + '.';

  return { since, headline, approvals, review, teams, failed, today, spend, close: closeSummary() };
}

const usd = (c) => `$${(c / 100).toFixed(2)}`;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Slack mrkdwn (links into Hive) or plain text for the inbox. */
export function renderBrief(b, { slack = false, timezone = 'UTC' } = {}) {
  const url = baseUrl();
  const task = (id, title) => (slack && id ? `<${url}/#/tasks/${id}|${esc(title)}>` : slack ? esc(title) : title);
  const bold = (s) => (slack ? `*${s}*` : s);
  const time = (iso, tz) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz || timezone });
  const out = [];
  if (b.approvals.length || b.review.length) {
    out.push(bold('Waiting on you'));
    for (const a of b.approvals) out.push(`• 🟡 ${a.agent} needs approval${a.count > 1 ? ` (${a.count})` : ''} on ${task(a.task_id, a.title)}`);
    for (const t of b.review) out.push(`• ${t.status === 'blocked' ? '🔴 Blocked' : '👀 Review'}: ${task(t.task_id, t.title)}${t.agent ? ` (${t.agent})` : ''}`);
    out.push('');
  }
  if (b.teams.length) {
    out.push(bold('Done since the last brief'));
    for (const g of b.teams) out.push(`${g.team}: ${g.items.map((i) => `${task(i.task_id, i.title)}${i.agent ? ` (${i.agent})` : ''}`).join('; ')}`);
    out.push('');
  }
  if (b.failed.length) {
    out.push(bold('Failed'));
    for (const f of b.failed) out.push(`• ${f.agent ?? 'Unassigned'}: ${task(f.task_id, f.title ?? 'a run')}: ${slack ? esc(f.error) : f.error}`);
    out.push('');
  }
  if (b.today.length) {
    out.push(bold('Scheduled today'));
    for (const w of b.today) out.push(`• ${time(w.at, w.timezone)} ${slack ? esc(w.name) : w.name}${w.agent ? ` (${w.agent})` : ''}`);
    out.push('');
  }
  if (b.close && b.close.done < b.close.total) {
    const c = b.close;
    out.push(bold(`${c.label} close: ${c.done} of ${c.total} done`));
    if (c.overdue.length) out.push(`• Overdue: ${c.overdue.join(', ')}`);
    if (c.not_started.length) out.push(`• Not started: ${c.not_started.join(', ')}`);
    out.push(slack ? `<${url}/#/close|Open the close board>` : '');
    out.push('');
  }
  out.push(`AI spend: ${usd(b.spend.since_cents)} since the last brief, ${usd(b.spend.month_cents)} this month.`);
  return out.join('\n').trim();
}

/** Build, store and deliver a brief. */
export async function sendBrief({ trigger = 'schedule' } = {}) {
  const b = buildBrief();
  const cos = chiefOfStaff();
  const id = Number(run('INSERT INTO briefs (data, trigger) VALUES (?, ?)', JSON.stringify(b), trigger).lastInsertRowid);
  const { timezone } = briefConfig();
  if (cos) {
    run("INSERT INTO messages (agent_id, sender, body, meta) VALUES (?, 'agent', ?, ?)", cos.id, `${b.headline}\n\n${renderBrief(b, { timezone })}`, JSON.stringify({ type: 'brief', brief_id: id }));
    emit('message', { agent_id: cos.id });
  }
  emit('brief', { id });
  const from = cos ? `${cos.name}, ${cos.title}` : 'Hive';
  await sendSlack({ text: `☀️ *Daily brief* from ${esc(from)}: ${esc(b.headline)}`, detail: renderBrief(b, { slack: true, timezone }).slice(0, 2900), link: `${baseUrl()}/#/`, linkLabel: 'Open Hive' });
  await pushToAll({ title: 'Daily brief', body: b.headline, url: '/#/' });
  return { id, ...b };
}

export function latestBrief() {
  const row = get('SELECT * FROM briefs ORDER BY id DESC LIMIT 1');
  return row ? { id: row.id, created_at: row.created_at, ...JSON.parse(row.data) } : null;
}
