// Slack for agents, executed by Hive: read channels and threads, fetch the files posted there, and
// (after approval) post a message.
//
// Hive reads as the agent's own Slack bot when it has one, and otherwise as the shared Hive app
// (SLACK_BOT_TOKEN). Either way a bot only sees the channels it has been invited to, so inviting
// the bot is how a channel is opened to agents. Hive's own tokens refresh themselves, unlike the
// Make Slack connections that went stale (token_revoked).

import { recordHealth } from './health.js';
import { agentBot, postMessage } from './notify.js';
import { FILE_LIMIT } from './google.js';

const TEXT_LIMIT = 60_000;

/** The tokens to read with, the agent's own bot first. */
export function readTokens(agentId) {
  const own = agentBot(agentId)?.bot_token;
  return [...new Set([own, process.env.SLACK_BOT_TOKEN].filter(Boolean))];
}
export const slackReadable = (agentId) => readTokens(agentId).length > 0;

// Slack's read methods take a form, not JSON.
async function call(method, params, token) {
  let res;
  try {
    res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${token}` },
      body: new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    recordHealth('slack', false, err.message);
    return { ok: false, error: err.message };
  }
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (json.ok) recordHealth('slack', true);
  else if (/invalid_auth|token_revoked|account_inactive|not_authed/.test(json.error)) recordHealth('slack', false, `${method}: ${json.error}`);
  return json;
}

const NOT_HERE = /not_in_channel|channel_not_found|missing_scope/;

/** Try each token until one can see the channel. */
async function firstThatWorks(agentId, method, params) {
  const tokens = readTokens(agentId);
  if (!tokens.length) throw new Error('Slack is not connected (no Hive app token and no bot for this agent)');
  let last;
  for (const token of tokens) {
    last = await call(method, params, token);
    if (last.ok) return { json: last, token };
    if (!NOT_HERE.test(last.error)) break;
  }
  if (NOT_HERE.test(last.error))
    throw new Error(`Slack: ${last.error}. Hive can only read channels its bot is in: ask someone to invite the agent's bot (or the Hive app) to the channel with /invite.`);
  throw new Error(`Slack: ${last.error}`);
}

/** A channel id (and message ts) from an id, a #name or a message link. */
export async function channelRef(agentId, ref) {
  const s = String(ref ?? '').trim();
  const link = s.match(/\/archives\/([CGD][A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?/);
  if (link) return { channel: link[1], ts: link[2] ? `${link[2]}.${link[3]}` : undefined };
  if (/^[CGDUW][A-Z0-9]{6,}$/.test(s)) return { channel: s };
  const name = s.replace(/^#/, '').toLowerCase();
  if (!name) throw new Error('channel is required: an id like C0123ABCD, a #name or a message link');
  for (const token of readTokens(agentId)) {
    let cursor;
    do {
      const json = await call('conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 1000, cursor }, token);
      if (!json.ok) break;
      const hit = json.channels.find((c) => c.name === name);
      if (hit) return { channel: hit.id };
      cursor = json.response_metadata?.next_cursor;
    } while (cursor);
  }
  throw new Error(`No channel #${name} that Hive can see. Use the channel's id or a link to a message in it, and make sure the bot is invited.`);
}

const names = new Map();
async function nameOf(userId, token) {
  if (!userId) return 'someone';
  if (!names.has(userId)) {
    const json = await call('users.info', { user: userId }, token);
    names.set(userId, json.ok ? json.user.profile?.display_name || json.user.real_name || json.user.name : userId);
  }
  return names.get(userId);
}

const when = (ts) => new Date(Number(ts) * 1000).toISOString().replace('T', ' ').slice(0, 16);
const toTs = (v) => (v == null || v === '' ? undefined : /^\d+(\.\d+)?$/.test(String(v)) ? String(v) : String(new Date(v).getTime() / 1000));

async function formatMessages(messages, token) {
  const lines = [];
  for (const m of messages) {
    const who = m.bot_profile?.name ?? m.username ?? (await nameOf(m.user, token));
    const files = (m.files ?? []).map((f) => `${f.name ?? f.title ?? 'file'} (${f.mimetype ?? f.filetype ?? '?'}, id ${f.id})`);
    lines.push(
      `[${when(m.ts)} UTC · ts ${m.ts}] ${who}: ${m.text ?? ''}${files.length ? `\n  files: ${files.join('; ')}` : ''}${m.reply_count ? `\n  (${m.reply_count} replies: read with action "thread", ts ${m.ts})` : ''}`,
    );
  }
  const out = lines.join('\n');
  return out.length > TEXT_LIMIT ? `${out.slice(0, TEXT_LIMIT)}\n… [truncated; narrow with oldest/latest]` : out;
}

/** Channels the agent's bot (or the Hive app) is in. */
export async function slackChannels(agentId) {
  const seen = new Map();
  let problem = null;
  for (const token of readTokens(agentId)) {
    const json = await call('users.conversations', { types: 'public_channel,private_channel', exclude_archived: true, limit: 500 }, token);
    if (!json.ok) problem = json.error;
    for (const c of json.channels ?? []) seen.set(c.id, c);
  }
  if (!seen.size) return problem ? `Slack couldn't list channels (${problem}). Use a channel id or a link to a message instead.` : 'The bot is not in any channel yet. Invite it with /invite.';
  return [...seen.values()].map((c) => `- #${c.name} · id ${c.id}${c.is_private ? ' · private' : ''}`).join('\n');
}

/** Recent messages in a channel, newest first. */
export async function slackHistory(agentId, { channel, oldest, latest, limit = 50 } = {}) {
  const ref = await channelRef(agentId, channel);
  const { json, token } = await firstThatWorks(agentId, 'conversations.history', {
    channel: ref.channel,
    oldest: toTs(oldest),
    latest: toTs(latest),
    limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
    inclusive: true,
  });
  if (!json.messages.length) return 'No messages in that range.';
  return `${json.messages.length} message${json.messages.length === 1 ? '' : 's'} in ${ref.channel}, newest first${json.has_more ? ' (more before these: pass latest = the oldest ts shown)' : ''}:\n${await formatMessages(json.messages, token)}`;
}

/** A thread: the first message and its replies. */
export async function slackThread(agentId, { channel, ts } = {}) {
  const ref = await channelRef(agentId, channel);
  const thread = ts ?? ref.ts;
  if (!thread) throw new Error('ts is required (the ts of the thread\'s first message, or give a link to it)');
  const { json, token } = await firstThatWorks(agentId, 'conversations.replies', { channel: ref.channel, ts: thread, limit: 200 });
  return formatMessages(json.messages, token);
}

/** A Slack file id from an id, a files.slack.com download link or a file permalink. */
export function fileId(ref) {
  const m = String(ref ?? '').match(/\b(F[A-Z0-9]{8,})\b/);
  if (!m) throw new Error('Give a Slack file id (F…) or a link to the file');
  return m[1];
}

/** A file's bytes, downloaded with the bot's token (files.slack.com needs it). */
export async function slackFetch(agentId, { file } = {}) {
  const id = fileId(file);
  const { json, token } = await firstThatWorks(agentId, 'files.info', { file: id });
  const f = json.file;
  if (f.size > FILE_LIMIT) throw new Error(`${f.name} is ${Math.round(f.size / 1048576)} MB; Hive fetches files up to ${FILE_LIMIT / 1048576} MB`);
  const url = f.url_private_download || f.url_private;
  if (!url) throw new Error(`${f.name} has no downloadable content (it may be an external link)`);
  // The bot's token only ever goes to Slack.
  if (!/(^|\.)slack\.com$/.test(new URL(url).hostname)) throw new Error(`${f.name} is stored outside Slack (${new URL(url).hostname}); open it from there`);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  // Without access Slack answers with its sign-in page, not an error.
  if (!res.ok || (/text\/html/.test(res.headers.get('content-type') || '') && f.mimetype !== 'text/html')) throw new Error(`Slack wouldn't hand over ${f.name} (HTTP ${res.status}); the bot may lack files:read`);
  return { key: `slack:${f.id}`, filename: f.name || `${f.id}.${f.filetype || 'bin'}`, mimeType: f.mimetype || 'application/octet-stream', bytes: Buffer.from(await res.arrayBuffer()), source: `Slack file ${f.id}` };
}

/** Post as the agent (its own bot, or the Hive app under its name and face). Runs after approval. */
export async function slackPost(agent, { channel, text, thread_ts } = {}) {
  if (!String(text ?? '').trim()) throw new Error('text is required');
  const ref = await channelRef(agent.id, channel);
  const json = await postMessage(agent, { channel: ref.channel, thread_ts: thread_ts ?? ref.ts, text });
  if (!json.ok) throw new Error(`Slack: ${json.error ?? 'not posted'}`);
  return `Posted in ${ref.channel} (ts ${json.ts}).`;
}
