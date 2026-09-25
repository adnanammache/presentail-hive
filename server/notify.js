// Slack alerts: tell you when an agent needs you, finishes, or gets stuck.
//
// Configure with SLACK_BOT_TOKEN (a bot token with chat:write) and SLACK_ALERT_CHANNEL
// (a channel ID like C0123…, or your member ID U0123… for a DM). Without them this is a no-op.
import { get } from './db.js';

export const slackConfigured = () => Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_ALERT_CHANNEL);

const baseUrl = () =>
  process.env.PUBLIC_URL?.replace(/\/$/, '') ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${process.env.PORT || 3001}`);

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sendSlack({ text, detail, link, linkLabel = 'Open in Hive' }) {
  if (!slackConfigured()) return { ok: false, skipped: true };
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  if (detail) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: detail } });
  if (link) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: linkLabel }, url: link }] });
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      body: JSON.stringify({ channel: process.env.SLACK_ALERT_CHANNEL, text: text.replace(/[*_`]/g, ''), blocks, unfurl_links: false }),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json();
    if (!json.ok) console.error('[slack]', json.error);
    return json;
  } catch (err) {
    console.error('[slack]', err.message);
    return { ok: false, error: err.message };
  }
}

/** Alert for a run's state change. kind: approval | done | failed */
export function notifyRun(runId, kind, extra = {}) {
  const r = get('SELECT * FROM runs WHERE id = ?', runId);
  if (!r) return;
  const agent = get('SELECT name, title FROM agents WHERE id = ?', r.agent_id);
  const task = r.task_id ? get('SELECT id, title FROM tasks WHERE id = ?', r.task_id) : null;
  const where = task ? `*${esc(task.title)}*` : 'a chat';
  const link = task ? `${baseUrl()}/#/tasks/${task.id}` : `${baseUrl()}/#/inbox/${r.agent_id}`;
  const who = `*${esc(agent?.name ?? 'An agent')}*`;
  if (kind === 'approval') {
    const lines = (extra.pending ?? []).map((p) => `\`${esc(clip(`${p.name} ${p.detail || ''}`.trim(), 280))}\``).join('\n');
    return sendSlack({ text: `🟡 ${who} needs your approval on ${where}`, detail: lines || undefined, link, linkLabel: 'Review in Hive' });
  }
  if (kind === 'done') {
    return sendSlack({ text: `✅ ${who} finished a turn on ${where} and is waiting for you`, detail: r.last_message ? `>${esc(clip(r.last_message, 600)).replace(/\n/g, '\n>')}` : undefined, link });
  }
  if (kind === 'failed') {
    return sendSlack({ text: `🔴 ${who} got stuck on ${where}`, detail: esc(clip(r.error || extra.error || 'Unknown error', 500)), link });
  }
}

export function notifyWorkflowFailed(workflowName, output, taskId) {
  return sendSlack({
    text: `🔴 Scheduled workflow *${esc(workflowName)}* failed`,
    detail: esc(clip(output, 500)),
    link: taskId ? `${baseUrl()}/#/tasks/${taskId}` : `${baseUrl()}/#/workflows`,
  });
}
