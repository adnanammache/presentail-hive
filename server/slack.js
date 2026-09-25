// Slack interactivity: the Approve / Reject buttons on approval alerts.
//
// Slack app → Interactivity & Shortcuts → Request URL: https://<hive>/slack/interactions
// Env: SLACK_SIGNING_SECRET (Basic Information → Signing Secret).
//      SLACK_APPROVERS: comma-separated Slack member IDs allowed to approve (U0123,…). If unset and
//      SLACK_ALERT_CHANNEL is a member ID (alerts go to your DMs), that member is the approver.
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { confirmMany } from './managed.js';

export function approvers() {
  const list = (process.env.SLACK_APPROVERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  const channel = process.env.SLACK_ALERT_CHANNEL || '';
  return /^U[A-Z0-9]+$/.test(channel) ? [channel] : [];
}

export function verifySlack(rawBody, timestamp, signature, now = Date.now()) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret || !timestamp || !signature) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 60 * 5) return false; // replay protection
  const expected = 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
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
  if (!action || !['hive_approve', 'hive_reject'].includes(action.action_id)) return null;
  const userId = payload.user?.id;
  if (!approvers().includes(userId)) {
    return 'You are not allowed to approve agent actions from Slack. Ask an admin to add your member ID to SLACK_APPROVERS.';
  }
  const [runId, ids] = String(action.value || '').split(':');
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

export function slackRouter() {
  const r = express.Router();
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
