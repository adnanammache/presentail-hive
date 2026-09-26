// Slack interactivity: the Approve / Reject buttons on approval alerts.
//
// Slack app → Interactivity & Shortcuts → Request URL: https://<hive>/slack/interactions
// Env: SLACK_SIGNING_SECRET (Basic Information → Signing Secret).
//      SLACK_APPROVERS: comma-separated Slack member IDs allowed to approve (U0123,…). If unset and
//      SLACK_ALERT_CHANNEL is a member ID (alerts go to your DMs), that member is the approver.
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { confirmMany } from './managed.js';
import { handleSlackMessage, slackPerson, threadFor } from './conversations.js';
import { canApproveFor, knownUser } from './roles.js';
import { get, run } from './db.js';
import { markVerified } from './setup.js';
import { approveLesson, rejectLesson } from './lessons.js';
import { appById, forgetInstall, signingSecrets } from './slackBots.js';

export function approvers() {
  const list = (process.env.SLACK_APPROVERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  const channel = process.env.SLACK_ALERT_CHANNEL || '';
  return /^U[A-Z0-9]+$/.test(channel) ? [channel] : [];
}

/** Signed by Slack for the Hive app or for one of the agents' own apps. */
export function verifySlack(rawBody, timestamp, signature, now = Date.now(), secrets = signingSecrets()) {
  if (!secrets.length || !timestamp || !signature) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 60 * 5) return false; // replay protection
  const b = Buffer.from(String(signature));
  return secrets.some((secret) => {
    const a = Buffer.from('v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex'));
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

async function reply(responseUrl, text) {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error('[slack] reply failed:', err.message);
  }
}

/** Handle one button click. Exported for tests. */
export async function handleAction(payload) {
  const action = payload.actions?.[0];
  if (['hive_lesson_approve', 'hive_lesson_reject'].includes(action?.action_id)) return handleLessonAction(payload, action);
  if (!action || !['hive_approve', 'hive_reject'].includes(action.action_id)) return null;
  const userId = payload.user?.id;
  const [runId, ids] = String(action.value || '').split(':');
  // Allowed: members listed in SLACK_APPROVERS, or people whose Hive role lets them approve this agent.
  if (!approvers().includes(userId)) {
    const token = appById(payload.api_app_id)?.bot_token;
    const person = await slackPerson(userId, { token }).catch(() => null);
    const agentId = get('SELECT agent_id FROM runs WHERE id = ?', Number(runId))?.agent_id;
    if (!person?.ok || !canApproveFor(knownUser(person.email), agentId)) {
      return "You can't approve this agent's actions. An owner can make you an approver in Hive (Settings → People).";
    }
  }
  const eventIds = (ids || '').split(',').filter(Boolean);
  const allow = action.action_id === 'hive_approve';
  const by = `${payload.user?.name || payload.user?.username || userId} (Slack)`;
  try {
    const n = await confirmMany(Number(runId), eventIds, allow, { by, denyMessage: allow ? undefined : 'Rejected from Slack' });
    if (!n) return 'Already handled: nothing from this alert is still waiting.';
    return null; // the alert itself is updated to show who decided
  } catch (err) {
    return `Could not do that: ${err.message}`;
  }
}

/** Approve or reject a lesson an agent proposed, from its Slack alert. */
async function handleLessonAction(payload, action) {
  const userId = payload.user?.id;
  const lesson = get('SELECT id, agent_id, status FROM agent_lessons WHERE id = ?', Number(action.value));
  if (!lesson) return 'That lesson no longer exists.';
  if (!approvers().includes(userId)) {
    const person = await slackPerson(userId).catch(() => null);
    if (!person?.ok || !canApproveFor(knownUser(person.email), lesson.agent_id)) {
      return "You can't approve this agent's lessons. An owner can make you an approver in Hive (Settings → People).";
    }
  }
  if (lesson.status !== 'pending_approval') return `Already handled: lesson #${lesson.id} is ${lesson.status === 'approved' ? 'approved' : 'rejected'}.`;
  const by = `${payload.user?.name || payload.user?.username || userId} (Slack)`;
  try {
    if (action.action_id === 'hive_lesson_approve') approveLesson(lesson.id, { by });
    else rejectLesson(lesson.id, { by, note: 'Rejected from Slack' });
    return `${action.action_id === 'hive_lesson_approve' ? 'Approved' : 'Rejected'} lesson #${lesson.id}.`;
  } catch (err) {
    return `Could not do that: ${err.message}`;
  }
}

/** Handle each Slack event once (Slack retries, and a mention can arrive as two events). */
const firstTime = (key) => run('INSERT OR IGNORE INTO slack_events (event_id) VALUES (?)', key).changes > 0;

/** Route one event from Slack's Events API. Exported for tests. */
export async function handleEvent(payload) {
  if (payload.type !== 'event_callback' || !firstTime(payload.event_id)) return;
  markVerified('slack-events');
  const ev = payload.event ?? {};
  // An agent's own bot (null: the shared Hive app, or an app Hive doesn't know).
  const app = appById(payload.api_app_id);
  if (app && ['app_uninstalled', 'tokens_revoked'].includes(ev.type)) return forgetInstall(app.app_id);
  const bot = app?.bot_token ? app : null;
  if (ev.bot_id || ev.app_id || (ev.subtype && ev.subtype !== 'file_share') || !ev.user) return; // our own posts, edits, joins
  const isDm = ev.type === 'message' && ev.channel_type === 'im';
  const isMention = ev.type === 'app_mention';
  const inOurThread = ev.type === 'message' && ev.thread_ts && threadFor(ev.channel, ev.thread_ts);
  if (!isDm && !isMention && !inOurThread) return;
  if (!firstTime(`msg:${ev.channel}:${ev.ts}`)) return;
  await handleSlackMessage(ev, { bot });
}

export function slackRouter() {
  const r = express.Router();
  r.post('/slack/events', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!verifySlack(raw, req.get('x-slack-request-timestamp'), req.get('x-slack-signature'))) return res.status(401).send('Bad signature');
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return res.status(400).send('Bad payload');
    }
    if (payload.type === 'url_verification') return res.json({ challenge: payload.challenge });
    res.status(200).send('');
    handleEvent(payload).catch((err) => console.error('[slack] event:', err.message));
  });
  r.post('/slack/interactions', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!verifySlack(raw, req.get('x-slack-request-timestamp'), req.get('x-slack-signature'))) {
      return res.status(401).send('Bad signature');
    }
    let payload;
    try {
      payload = JSON.parse(new URLSearchParams(raw).get('payload') || '{}');
    } catch {
      return res.status(400).send('Bad payload');
    }
    res.status(200).send(''); // Slack wants an answer within 3 seconds; do the work after
    const message = await handleAction(payload);
    if (message) await reply(payload.response_url, message);
  });
  return r;
}
