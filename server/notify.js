// Slack alerts: tell you when an agent needs you, finishes, or gets stuck.
//
// Configure with SLACK_BOT_TOKEN (a bot token with chat:write) and SLACK_ALERT_CHANNEL
// (a channel ID like C0123…, or your member ID U0123… for a DM). Without them this is a no-op.
// With SLACK_SIGNING_SECRET as well, approval alerts get Approve / Reject buttons (see slack.js).
import { get, run } from './db.js';
import { pushToAll } from './push.js';

export const slackConfigured = () => Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_ALERT_CHANNEL);

export const baseUrl = () =>
  process.env.PUBLIC_URL?.replace(/\/$/, '') ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${process.env.PORT || 3001}`);

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const slackButtonsEnabled = () => slackConfigured() && Boolean(process.env.SLACK_SIGNING_SECRET);

export async function slackApi(method, body) {
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json();
    if (!json.ok) console.error(`[slack] ${method}:`, json.error);
    return json;
  } catch (err) {
    console.error('[slack]', err.message);
    return { ok: false, error: err.message };
  }
}

export function alertBlocks({ text, detail, link, linkLabel = 'Open in Hive', buttons = [] }) {
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  if (detail) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: detail } });
  const elements = [...buttons];
  if (link) elements.push({ type: 'button', text: { type: 'plain_text', text: linkLabel }, url: link, action_id: 'hive_open' });
  if (elements.length) blocks.push({ type: 'actions', elements });
  return blocks;
}

export async function sendSlack({ text, ...rest }) {
  if (!slackConfigured()) return { ok: false, skipped: true };
  return slackApi('chat.postMessage', {
    channel: process.env.SLACK_ALERT_CHANNEL,
    text: text.replace(/[*_`]/g, ''),
    blocks: alertBlocks({ text, ...rest }),
    unfurl_links: false,
  });
}

/** Once an approval is decided (in Hive or Slack), swap the alert's buttons for who decided. */
export async function settleApprovalAlert(runId, outcome) {
  const r = get('SELECT slack_ts FROM runs WHERE id = ?', runId);
  if (!r?.slack_ts || !slackConfigured()) return;
  run('UPDATE runs SET slack_ts = NULL WHERE id = ?', runId);
  const [channel, ts] = r.slack_ts.split('|');
  const { text, link } = approvalText(runId);
  return slackApi('chat.update', { channel, ts, text: `${outcome}: ${text}`.replace(/[*_`]/g, ''), blocks: alertBlocks({ text, detail: esc(outcome), link }) });
}

function approvalText(runId) {
  const r = get('SELECT * FROM runs WHERE id = ?', runId);
  const agent = get('SELECT name FROM agents WHERE id = ?', r?.agent_id);
  const task = r?.task_id ? get('SELECT id, title FROM tasks WHERE id = ?', r.task_id) : null;
  const where = task ? `*${esc(task.title)}*` : 'a chat';
  const link = task ? `${baseUrl()}/#/tasks/${task.id}` : `${baseUrl()}/#/inbox/${r?.agent_id}`;
  return { text: `🟡 *${esc(agent?.name ?? 'An agent')}* needs your approval on ${where}`, link };
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
  const name = agent?.name ?? 'An agent';
  const title = task?.title ?? 'a chat';
  const url = task ? `/#/tasks/${task.id}` : `/#/inbox/${r.agent_id}`;
  const push = {
    approval: { title: `${name} needs your approval`, body: title },
    done: { title: `${name} finished`, body: `${title}: ${clip(r.last_message, 160)}` },
    failed: { title: `${name} got stuck`, body: `${title}: ${clip(r.error || extra.error || 'Unknown error', 160)}` },
  }[kind];
  if (push) pushToAll({ ...push, url, tag: `run-${runId}` }).catch((err) => console.error('[push]', err.message));
  if (kind === 'approval') {
    const pending = extra.pending ?? [];
    const lines = pending
      .map((p) => `\`${esc(clip(`${p.name} ${p.detail || ''}`.trim(), 280))}\`${p.reason ? `\n${esc(clip(p.reason, 200))}` : ''}`)
      .join('\n');
    // The buttons carry the exact calls shown, so a click never approves something newer.
    const value = `${runId}:${pending.map((p) => p.event_id).join(',')}`;
    const n = pending.length > 1 ? ` all ${pending.length}` : '';
    const buttons =
      slackButtonsEnabled() && value.length < 2000
        ? [
            { type: 'button', style: 'primary', text: { type: 'plain_text', text: `Approve${n}` }, action_id: 'hive_approve', value,
              confirm: { title: { type: 'plain_text', text: 'Approve?' }, text: { type: 'mrkdwn', text: `Let ${who} go ahead with${n || ' this'}?` }, confirm: { type: 'plain_text', text: 'Approve' }, deny: { type: 'plain_text', text: 'Cancel' } } },
            { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, action_id: 'hive_reject', value },
          ]
        : [];
    return sendSlack({ text: `🟡 ${who} needs your approval on ${where}`, detail: lines || undefined, link, linkLabel: 'Review in Hive', buttons }).then((json) => {
      if (json?.ok && json.ts) run('UPDATE runs SET slack_ts = ? WHERE id = ?', `${json.channel}|${json.ts}`, runId);
      return json;
    });
  }
  if (kind === 'done') {
    return sendSlack({ text: `✅ ${who} finished a turn on ${where} and is waiting for you`, detail: r.last_message ? `>${esc(clip(r.last_message, 600)).replace(/\n/g, '\n>')}` : undefined, link });
  }
  if (kind === 'failed') {
    return sendSlack({ text: `🔴 ${who} got stuck on ${where}`, detail: esc(clip(r.error || extra.error || 'Unknown error', 500)), link });
  }
}

export function notifyWorkflowFailed(workflowName, output, taskId) {
  pushToAll({ title: `Workflow failed: ${workflowName}`, body: clip(output, 200), url: taskId ? `/#/tasks/${taskId}` : '/#/workflows' }).catch(() => {});
  return sendSlack({
    text: `🔴 Scheduled workflow *${esc(workflowName)}* failed`,
    detail: esc(clip(output, 500)),
    link: taskId ? `${baseUrl()}/#/tasks/${taskId}` : `${baseUrl()}/#/workflows`,
  });
}
