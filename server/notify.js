// Slack alerts: tell you when an agent needs you, finishes, or gets stuck.
//
// Configure with SLACK_BOT_TOKEN (a bot token with chat:write) and SLACK_ALERT_CHANNEL
// (a channel ID like C0123…, or your member ID U0123… for a DM). Without them this is a no-op.
// With SLACK_SIGNING_SECRET as well, approval alerts get Approve / Reject buttons (see slack.js).
import { all, get, run } from './db.js';
import { pushToAll, pushToUser } from './push.js';
import { canApproveFor, knownUser } from './roles.js';
import { recordHealth } from './health.js';

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
    // Auth problems mean Slack is broken for Hive; a single missing channel or thread isn't.
    if (json.ok) recordHealth('slack', true);
    else if (/auth|token|account_inactive|missing_scope/.test(json.error)) recordHealth('slack', false, `${method}: ${json.error}`);
    return json;
  } catch (err) {
    recordHealth('slack', false, err.message);
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

/**
 * Post an alert. By default to SLACK_ALERT_CHANNEL; with `thread` ({ channel, thread_ts }) into
 * that conversation instead, and with `as` (an agent) under the agent's own name and face.
 */
export async function sendSlack({ text, thread, as, ...rest }) {
  if (thread ? !process.env.SLACK_BOT_TOKEN : !slackConfigured()) return { ok: false, skipped: true };
  return slackApi('chat.postMessage', {
    channel: thread?.channel ?? process.env.SLACK_ALERT_CHANNEL,
    thread_ts: thread?.thread_ts,
    text: text.replace(/[*_`]/g, ''),
    blocks: alertBlocks({ text, ...rest }),
    unfurl_links: false,
    ...(as ? { username: `${as.name} · ${as.title || 'Agent'}`.slice(0, 80), icon_url: `${baseUrl()}/avatars/${as.id}.png?v=${encodeURIComponent(`${as.photo_version ?? ''}${as.color ?? ''}`)}` } : {}),
  });
}

/** The Slack thread a task was started from, if any: its updates go there instead of the alert channel. */
const taskThread = (taskId) => (taskId ? get('SELECT channel, thread_ts FROM slack_threads WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', taskId) : null);

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
  const agent = get('SELECT id, name, title, color, photo_version FROM agents WHERE id = ?', r.agent_id);
  const task = r.task_id ? get('SELECT id, title FROM tasks WHERE id = ?', r.task_id) : null;
  // Updates go back to the Slack conversation the work came from, if any.
  const origin = String(r.origin ?? '');
  const thread = taskThread(task?.id) ?? (origin.startsWith('slack:') ? { channel: origin.split(':')[1], thread_ts: origin.split(':')[2] } : null);
  const via = thread ? { thread, as: agent } : {};
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
    // Show everything that will run, in full. If that doesn't fit in a Slack message, there are no
    // buttons: approving something you couldn't see isn't approval.
    const full = pending
      .map((p) => {
        const body = [p.detail, p.preview && p.preview !== '{}' ? p.preview : null].filter(Boolean).join('\n');
        return `*${esc(p.name)}*${p.reason ? `: ${esc(p.reason)}` : ''}\n\`\`\`${esc(body).replace(/```/g, "'''")}\`\`\``;
      })
      .join('\n');
    const fits = full.length <= 2800;
    const lines = fits ? full : `${clip(full, 600)}\n_Too long to review in Slack. Open it in Hive to see everything and approve there._`;
    const value = `${runId}:${pending.map((p) => p.event_id).join(',')}`;
    const n = pending.length > 1 ? ` all ${pending.length}` : '';
    const buttons =
      fits && slackButtonsEnabled() && value.length < 2000
        ? [
            { type: 'button', style: 'primary', text: { type: 'plain_text', text: `Approve${n}` }, action_id: 'hive_approve', value,
              confirm: { title: { type: 'plain_text', text: 'Approve?' }, text: { type: 'mrkdwn', text: `Let ${who} go ahead with${n || ' this'}?` }, confirm: { type: 'plain_text', text: 'Approve' }, deny: { type: 'plain_text', text: 'Cancel' } } },
            { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, action_id: 'hive_reject', value },
          ]
        : [];
    return sendSlack({ text: thread ? '🟡 I need your approval before I go on:' : `🟡 ${who} needs your approval on ${where}`, detail: lines || undefined, link, linkLabel: 'Review in Hive', buttons, ...via }).then((json) => {
      if (json?.ok && json.ts) run('UPDATE runs SET slack_ts = ? WHERE id = ?', `${json.channel}|${json.ts}`, runId);
      return json;
    });
  }
  if (kind === 'done') {
    if (thread) return sendSlack({ text: esc(clip(r.last_message || 'Done.', 2900)), link, ...via });
    return sendSlack({ text: `✅ ${who} finished a turn on ${where} and is waiting for you`, detail: r.last_message ? `>${esc(clip(r.last_message, 600)).replace(/\n/g, '\n>')}` : undefined, link });
  }
  if (kind === 'failed') {
    return sendSlack({ text: `🔴 ${thread ? 'I got stuck' : `${who} got stuck on ${where}`}`, detail: esc(clip(r.error || extra.error || 'Unknown error', 500)), link, ...via });
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

/**
 * An agent proposed a lesson (or a new wording for one): tell the people who can approve it, on
 * their phones and in Slack (with Approve / Reject buttons when Slack buttons are set up).
 */
export function notifyLessonPending(lesson, { edit = false } = {}) {
  if (!lesson) return;
  const agent = get('SELECT id, name, title, color, photo_version FROM agents WHERE id = ?', lesson.agent_id);
  const name = agent?.name ?? 'An agent';
  const text = edit ? lesson.proposed_text : lesson.text;
  const reason = edit ? lesson.proposed_reason : lesson.reason;
  const url = `/#/agents/${lesson.agent_id}/lessons`;
  const title = edit ? `${name} suggested a new wording for a lesson` : `${name} proposed a lesson`;
  for (const u of all("SELECT email FROM users WHERE status = 'active'")) {
    if (canApproveFor(knownUser(u.email), lesson.agent_id)) pushToUser(u.email, { title, body: clip(text, 160), url, tag: `lesson-${lesson.id}` }).catch((err) => console.error('[push]', err.message));
  }
  const buttons =
    !edit && slackButtonsEnabled()
      ? [
          { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: 'hive_lesson_approve', value: String(lesson.id) },
          { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, action_id: 'hive_lesson_reject', value: String(lesson.id) },
        ]
      : [];
  return sendSlack({
    text: `🧠 *${esc(name)}* ${edit ? `suggested a new wording for lesson #${lesson.id}` : 'proposed a lesson'}. It doesn't apply until someone approves it.`,
    detail: `>${esc(clip(text, 600))}${reason ? `\n_Why:_ ${esc(clip(reason, 400))}` : ''}`,
    link: `${baseUrl()}${url}`,
    linkLabel: 'Review in Hive',
    buttons,
  });
}
