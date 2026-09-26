// Every agent as its own Slack bot: its own name, photo and description, a DM of its own, and
// @mentions or channel invites like a teammate. Hive creates, updates and deletes these Slack apps itself.
//
// Setup, once: an owner connects Hive with a Slack "app configuration token" (api.slack.com/apps →
// Your App Configuration Tokens → Generate, then the refresh token). Slack replaces these tokens every
// 12 hours; Hive swaps them by itself, so the connection keeps working. Installing each app in the
// workspace still needs a person to press Allow in Slack (Slack's rule); "Install all" goes through
// them one after another. Events and button clicks come to the same /slack/events and
// /slack/interactions addresses as the Hive app, told apart by their signature and app ID.
import { randomBytes } from 'node:crypto';
import { all, get, run } from './db.js';
import { agentAvatar, agentAvatarPng } from './avatars.js';
import { botAvatarSvg } from '../shared/botface.js';
import { baseUrl, slackApi } from './notify.js';

export const BOT_SCOPES = [
  'app_mentions:read', 'assistant:write',
  'channels:history', 'groups:history', 'im:history', 'im:read', 'im:write', 'mpim:history',
  'chat:write', 'chat:write.public', 'chat:write.customize',
  'files:read', 'users:read', 'users:read.email',
  'reactions:write', // 👀 on your message while the agent works on its answer
];
// Bumped when the app settings Hive gives Slack change, so every existing app is updated once.
const MANIFEST_VERSION = 2;
export const BOT_EVENTS = ['app_mention', 'message.im', 'message.channels', 'message.groups', 'message.mpim', 'assistant_thread_started', 'app_uninstalled', 'tokens_revoked'];

const CONFIG = 'slack_config_token'; // app_meta: { refresh, token, exp, team_id }
const ORIGIN = 'slack_bots_origin'; // app_meta: the address Slack sends people and events back to

// ---------------------------------------------------------------- talking to Slack's app-management API

/** Slack's app-management methods take the token and arguments as a form. */
let pause = (ms) => new Promise((r) => setTimeout(r, ms));
export const setPause = (fn) => (pause = fn); // tests

/**
 * Slack's app-management methods take the token and arguments as a form. Creating many apps in a row
 * hits Slack's speed limit: wait as long as Slack asks (up to a minute) and try again, a few times.
 */
async function slackForm(method, fields, file) {
  const build = () => {
    if (!file) return new URLSearchParams(Object.entries(fields).filter(([, v]) => v !== undefined));
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', new Blob([file.body], { type: file.type }), file.name);
    return form;
  };
  for (let attempt = 1; ; attempt++) {
    let res;
    let json;
    try {
      res = await fetch(`https://slack.com/api/${method}`, { method: 'POST', body: build(), signal: AbortSignal.timeout(20000) });
    } catch (err) {
      return { ok: false, error: `couldn't reach Slack (${err.message})` };
    }
    try {
      json = await res.json();
    } catch {
      return { ok: false, error: `couldn't reach Slack (HTTP ${res.status})` };
    }
    const limited = res.status === 429 || json?.error === 'ratelimited';
    if (!limited || attempt >= 4) return json;
    const seconds = Math.min(60, Math.max(1, Number(res.headers.get('retry-after')) || 20));
    await pause(seconds * 1000);
  }
}

/** Slack's error codes, in words. */
export function explain(json) {
  const e = json?.error ?? 'unknown_error';
  const detail = (json?.errors ?? []).map((x) => `${x.message}${x.pointer ? ` (${x.pointer})` : ''}`).join('; ');
  const words = {
    invalid_refresh_token: 'Slack no longer accepts the setup token. Connect again with a new one.',
    invalid_auth: 'Slack no longer accepts the setup token. Connect again with a new one.',
    token_expired: 'The setup token expired. Connect again with a new one.',
    not_authed: 'Hive is not connected to Slack yet.',
    ratelimited: 'Slack asked Hive to slow down. Try again in a minute.',
    app_not_found: 'Slack no longer has this app (it may have been deleted in Slack).',
    invalid_manifest: 'Slack rejected the app settings',
    invalid_code: 'That install link was already used or expired. Try Install again.',
    bad_redirect_uri: "Slack didn't accept Hive's address. Open Hive at its usual address and try again.",
  };
  return [words[e] ?? `Slack said: ${e}`, detail].filter(Boolean).join(': ');
}

// ---------------------------------------------------------------- the setup token

const readConfig = () => {
  try {
    return JSON.parse(get('SELECT value FROM app_meta WHERE key = ?', CONFIG)?.value ?? 'null');
  } catch {
    return null;
  }
};
const writeConfig = (c) =>
  c ? run('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', CONFIG, JSON.stringify(c)) : run('DELETE FROM app_meta WHERE key = ?', CONFIG);

export const origin = () => get('SELECT value FROM app_meta WHERE key = ?', ORIGIN)?.value || baseUrl();
export function setOrigin(url) {
  if (!/^https?:\/\/[^/]+$/.test(url ?? '')) return;
  run('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', ORIGIN, url);
}

/** Swap a refresh token for a fresh access token (and the next refresh token). */
async function rotate(refresh) {
  const json = await slackForm('tooling.tokens.rotate', { refresh_token: refresh });
  if (!json.ok) throw new Error(explain(json));
  const c = { refresh: json.refresh_token, token: json.token, exp: Number(json.exp) || Math.floor(Date.now() / 1000) + 12 * 3600, team_id: json.team_id ?? null };
  writeConfig(c);
  return c;
}

/** Connect Hive to Slack with an app configuration refresh token (xoxe-…). */
export async function connect(refreshToken) {
  const t = String(refreshToken ?? '').trim();
  if (!/^xoxe-/.test(t)) throw new Error('Paste the refresh token: it starts with xoxe- (not xoxe.xoxp-).');
  const c = await rotate(t);
  return { team_id: c.team_id };
}
export const disconnect = () => writeConfig(null);
export const connected = () => Boolean(readConfig()?.refresh);

let rotating = null;
/** A working access token, swapped for a new one when it's close to expiring. */
export async function configToken() {
  const c = readConfig();
  if (!c?.refresh) throw new Error('Hive is not connected to Slack yet. An owner connects it in Settings → Slack bots.');
  if (c.token && c.exp - Date.now() / 1000 > 15 * 60) return c.token;
  rotating ??= rotate(c.refresh).finally(() => (rotating = null));
  return (await rotating).token;
}

/**
 * Keep the refresh token alive and current even when nobody changes anything for a while, and shortly
 * after startup bring every app up to date (e.g. new permissions after an update of Hive).
 */
export function scheduleConfigRefresh() {
  const tick = () => connected() && configToken().catch((err) => console.error('[slack bots] token refresh:', err.message));
  setInterval(tick, 6 * 3600 * 1000).unref();
  setTimeout(() => syncAll().catch((err) => console.error('[slack bots] update:', err.message)), 20_000).unref();
}

/** Update every agent's app whose settings are out of date, one after another. */
export async function syncAll() {
  if (!connected()) return;
  for (const { agent_id } of all('SELECT agent_id FROM agent_slack_apps ORDER BY agent_id')) {
    await syncApp(agent_id).catch((err) => noteError(agent_id, err.message));
  }
}

// ---------------------------------------------------------------- the app, as Slack sees it

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** What Slack is told about the agent; when this changes, the app is updated. */
function profileOf(agent) {
  return JSON.stringify({ v: MANIFEST_VERSION, name: agent.name, title: agent.title, description: agent.description ?? '', color: agent.color ?? '', photo: agent.photo_version ?? '' });
}

export function manifestFor(agent, base = origin()) {
  const name = clip(agent.name, 35) || `Agent ${agent.id}`;
  const title = clip(agent.title, 100) || 'AI agent';
  const color = /^#[0-9a-f]{6}$/i.test(agent.color ?? '') ? agent.color : '#5b4ce6';
  const about =
    clip(agent.description, 300) ||
    clip(`${agent.name}, ${title} at Presentail. Ask a question, or attach files to give ${agent.name} a task. Everything also shows in Presentail Hive.`, 300);
  const redirects = [...new Set([base, baseUrl()])].map((b) => `${b}/api/slack/bots/callback`);
  return {
    display_information: { name, description: clip(`${title} · Presentail AI agent`, 140), background_color: color },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: clip(agent.name, 80) || name, always_online: true },
      agent_view: {
        agent_description: about,
        suggested_prompts: [
          { title: 'What can you do?', message: 'What can you help me with?' },
          { title: 'What are you working on?', message: 'What are you working on at the moment?' },
          { title: 'Give you a task', message: 'I have a task for you: ' },
        ],
      },
    },
    oauth_config: { redirect_urls: redirects, scopes: { bot: BOT_SCOPES } },
    settings: {
      event_subscriptions: { request_url: `${base}/slack/events`, bot_events: BOT_EVENTS },
      interactivity: { is_enabled: true, request_url: `${base}/slack/interactions` },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

/**
 * Slack's newer "agent" chat view isn't available everywhere yet: if Slack rejects it, fall back to
 * the older assistant view, then to a plain bot (DMs and mentions still work).
 */
function fallbacks(manifest) {
  const { agent_view: view, ...plain } = manifest.features;
  return [
    manifest,
    { ...manifest, features: { ...plain, assistant_view: { assistant_description: view.agent_description, suggested_prompts: view.suggested_prompts } } },
    { ...manifest, features: plain, oauth_config: { ...manifest.oauth_config, scopes: { bot: BOT_SCOPES.filter((s) => s !== 'assistant:write') } }, settings: { ...manifest.settings, event_subscriptions: { ...manifest.settings.event_subscriptions, bot_events: BOT_EVENTS.filter((e) => e !== 'assistant_thread_started') } } },
  ];
}
const viewRejected = (json) => json.error === 'invalid_manifest' && (json.errors ?? []).some((e) => /agent_view|assistant_view|assistant/.test(`${e.pointer} ${e.message}`));

/** A 512×512 PNG of the agent's picture (Slack wants at least 512 px). */
export async function iconPng(agentId) {
  const agent = get('SELECT id, name, color, photo_type FROM agents WHERE id = ?', agentId);
  if (!agent) return null;
  try {
    const { Resvg } = await import('@resvg/resvg-js');
    let svg;
    if (agent.photo_type && agent.photo_type !== 'image/webp') {
      const img = await agentAvatar(agent.id);
      if (img?.type === agent.photo_type) {
        svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="512" height="512" viewBox="0 0 512 512"><image width="512" height="512" preserveAspectRatio="xMidYMid slice" xlink:href="data:${img.type};base64,${img.body.toString('base64')}"/></svg>`;
      }
    }
    svg ??= botAvatarSvg(agent.name, agent.color || '#6366f1', 512);
    return new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render().asPng();
  } catch (err) {
    console.error('[slack bots] icon:', err.message);
    return agentAvatarPng(agent.id);
  }
}

async function setIcon(appId, agentId, token) {
  const png = await iconPng(agentId);
  if (!png) return { ok: false, error: 'no_icon' };
  return slackForm('apps.icon.set', { token, app_id: appId }, { body: png, type: 'image/png', name: `agent-${agentId}.png` });
}

// ---------------------------------------------------------------- create, update, delete

export const appFor = (agentId) => get('SELECT * FROM agent_slack_apps WHERE agent_id = ?', agentId) ?? null;
export const appById = (appId) => (appId ? get('SELECT * FROM agent_slack_apps WHERE app_id = ?', appId) ?? null : null);
/** Every signing secret Slack may sign a request with: the Hive app's and each agent's app. */
export const signingSecrets = () => [process.env.SLACK_SIGNING_SECRET, ...all('SELECT signing_secret FROM agent_slack_apps').map((r) => r.signing_secret)].filter(Boolean);

const noteError = (agentId, error) => run("UPDATE agent_slack_apps SET error = ?, updated_at = datetime('now') WHERE agent_id = ?", error, agentId);

/** The app without its event and button addresses: see createApp. */
const withoutAddresses = (m) => ({ ...m, settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false } });

/**
 * Create the agent's Slack app (once). Returns the app row.
 * Two steps, so every request from Slack stays signature-checked: Slack tests the events address as
 * soon as it's set, signed with the app's own secret. So the app is created without its addresses,
 * Hive stores the secret, and only then are the addresses added (by syncApp).
 */
export async function createApp(agentId) {
  const agent = get('SELECT * FROM agents WHERE id = ?', agentId);
  if (!agent) throw new Error('Unknown agent');
  const existing = appFor(agentId);
  if (existing) return existing;
  const token = await configToken();
  let json;
  let used;
  for (const manifest of fallbacks(manifestFor(agent))) {
    used = manifest;
    json = await slackForm('apps.manifest.create', { token, manifest: JSON.stringify(withoutAddresses(manifest)) });
    if (json.ok || !viewRejected(json)) break;
  }
  if (!json.ok) throw new Error(explain(json));
  const c = json.credentials ?? {};
  run(
    'INSERT INTO agent_slack_apps (agent_id, app_id, client_id, client_secret, signing_secret, team_id, scopes) VALUES (?, ?, ?, ?, ?, ?, ?)',
    agentId, json.app_id, c.client_id, c.client_secret, c.signing_secret, readConfig()?.team_id ?? null, used.oauth_config.scopes.bot.join(','),
  );
  await syncApp(agentId, { force: true });
  return appFor(agentId);
}

/** Create apps for every agent that doesn't have one yet. Returns { created, failed: [{ agent_id, name, error }] }. */
export async function createAll() {
  await configToken(); // fail once, clearly, if not connected
  const missing = all('SELECT a.id, a.name FROM agents a LEFT JOIN agent_slack_apps s ON s.agent_id = a.id WHERE s.agent_id IS NULL ORDER BY a.id');
  const failed = [];
  let created = 0;
  for (const a of missing) {
    try {
      await createApp(a.id);
      created++;
    } catch (err) {
      failed.push({ agent_id: a.id, name: a.name, error: err.message });
    }
  }
  return { created, failed };
}

/** Bring Slack up to date after the agent's name, title, description, colour or photo changed. */
export async function syncApp(agentId, { force = false } = {}) {
  const app = appFor(agentId);
  const agent = get('SELECT * FROM agents WHERE id = ?', agentId);
  if (!app || !agent || !connected()) return { ok: false, skipped: true };
  const profile = profileOf(agent);
  if (!force && app.profile === profile) return { ok: true, unchanged: true };
  const token = await configToken();
  const before = app.profile ? JSON.parse(app.profile) : {};
  let json;
  let used;
  for (const manifest of fallbacks(manifestFor(agent))) {
    used = manifest;
    json = await slackForm('apps.manifest.update', { token, app_id: app.app_id, manifest: JSON.stringify(manifest) });
    if (json.ok || !viewRejected(json)) break;
  }
  if (!json.ok) {
    noteError(agentId, explain(json));
    return { ok: false, error: explain(json) };
  }
  run('UPDATE agent_slack_apps SET scopes = ? WHERE agent_id = ?', used.oauth_config.scopes.bot.join(','), agentId);
  let error = null;
  if (force || before.photo !== (agent.photo_version ?? '') || before.color !== (agent.color ?? '') || before.name !== agent.name) {
    const icon = await setIcon(app.app_id, agentId, token);
    if (!icon.ok) error = `The photo didn't upload: ${explain(icon)}`;
  }
  run("UPDATE agent_slack_apps SET profile = ?, error = ?, updated_at = datetime('now') WHERE agent_id = ?", profile, error, agentId);
  return { ok: !error, error };
}

/** Called after an agent is edited: update Slack in the background, never failing the edit. */
export function syncSoon(agentId) {
  if (!appFor(agentId) || !connected()) return;
  syncApp(agentId).catch((err) => noteError(agentId, err.message));
}

/** Delete the agent's Slack app (the bot leaves Slack). */
export async function removeApp(agentId) {
  const app = appFor(agentId);
  if (!app) return { ok: true };
  if (connected()) {
    const json = await slackForm('apps.manifest.delete', { token: await configToken(), app_id: app.app_id });
    if (!json.ok && json.error !== 'app_not_found') throw new Error(explain(json));
  }
  run('DELETE FROM agent_slack_apps WHERE agent_id = ?', agentId);
  run('UPDATE slack_threads SET bot_agent_id = NULL WHERE bot_agent_id = ?', agentId);
  return { ok: true, manual: !connected() };
}

// ---------------------------------------------------------------- install (Slack's "Allow" page)

const STATE_MINUTES = 30;
const redirectUri = () => `${origin()}/api/slack/bots/callback`;

/** The Slack page where a person allows the agent's bot in the workspace. `next`: agents to do after. */
export function installUrl(agentId, email, next = []) {
  const app = appFor(agentId);
  if (!app) throw new Error('Create the Slack bot first.');
  run(`DELETE FROM slack_oauth_states WHERE created_at < datetime('now', '-${STATE_MINUTES} minutes')`);
  const state = randomBytes(24).toString('hex');
  run('INSERT INTO slack_oauth_states (state, agent_id, user_email, next) VALUES (?, ?, ?, ?)', state, agentId, email, JSON.stringify(next));
  const q = new URLSearchParams({ client_id: app.client_id, scope: app.scopes || BOT_SCOPES.join(','), redirect_uri: redirectUri(), state });
  if (app.team_id) q.set('team', app.team_id);
  return `https://slack.com/oauth/v2/authorize?${q}`;
}

/** Permissions the app asks for that the workspace hasn't allowed yet (all of them before an install). */
export function missingScopes(app) {
  const wanted = (app?.scopes || BOT_SCOPES.join(',')).split(',');
  if (!app?.bot_token || app.granted_scopes == null) return wanted;
  const granted = app.granted_scopes.split(',');
  return wanted.filter((s) => !granted.includes(s));
}
/** Installed, and allowed to do `scope`. */
export const canDo = (app, scope) => Boolean(app?.bot_token && app.granted_scopes?.split(',').includes(scope));

/** Agents whose bot needs someone to press Allow: not installed yet, or asking for new permissions. */
export const notInstalled = () => all('SELECT * FROM agent_slack_apps ORDER BY agent_id').filter((a) => missingScopes(a).length).map((a) => a.agent_id);

/**
 * Slack sent the person back after Allow (or Cancel). Saves the bot token.
 * Returns { agent_id, next } where `next` is the next agent's install page, if any.
 */
export async function finishInstall({ state, code, error }, email) {
  const row = state ? get(`SELECT * FROM slack_oauth_states WHERE state = ? AND created_at >= datetime('now', '-${STATE_MINUTES} minutes')`, String(state)) : null;
  if (!row) throw new Error('That install link expired. Start again from Settings → Slack bots.');
  run('DELETE FROM slack_oauth_states WHERE state = ?', row.state);
  if (row.user_email !== email) throw new Error('This install was started by someone else. Start again from Settings → Slack bots.');
  if (error) throw new Error(error === 'access_denied' ? 'Install cancelled in Slack.' : `Slack said: ${error}`);
  const app = appFor(row.agent_id);
  if (!app) throw new Error("This agent's Slack bot was removed. Create it again.");
  const json = await slackForm('oauth.v2.access', { client_id: app.client_id, client_secret: app.client_secret, code: String(code ?? ''), redirect_uri: redirectUri() });
  if (!json.ok) throw new Error(explain(json));
  if (json.app_id && json.app_id !== app.app_id) throw new Error('Slack answered for a different app. Try again.');
  run(
    "UPDATE agent_slack_apps SET bot_token = ?, bot_user_id = ?, team_id = ?, granted_scopes = ?, error = NULL, installed_at = datetime('now'), updated_at = datetime('now') WHERE agent_id = ?",
    json.access_token, json.bot_user_id ?? null, json.team?.id ?? app.team_id, json.scope ?? app.scopes ?? null, row.agent_id,
  );
  const queue = JSON.parse(row.next || '[]').filter((id) => appFor(id) && missingScopes(appFor(id)).length);
  return { agent_id: row.agent_id, next: queue.length ? installUrl(queue[0], email, queue.slice(1)) : null };
}

/** Slack told us the app was removed from the workspace, or its token revoked. */
export function forgetInstall(appId) {
  run("UPDATE agent_slack_apps SET bot_token = NULL, bot_user_id = NULL, granted_scopes = NULL, installed_at = NULL, error = 'Removed from Slack. Install it again to bring it back.' WHERE app_id = ?", appId);
}

// ---------------------------------------------------------------- what Settings and agent pages show

/** Opens the bot's DM in Slack. */
export const slackLink = (app) => (app?.bot_token ? `https://slack.com/app_redirect?app=${app.app_id}${app.team_id ? `&team=${app.team_id}` : ''}` : null);

export function status() {
  const c = readConfig();
  const agents = all(
    `SELECT a.id, a.name, a.title, a.color, a.photo_version, a.status, s.app_id, s.team_id, s.bot_token IS NOT NULL AS installed, s.error, s.installed_at,
       s.scopes, s.granted_scopes, s.bot_token IS NOT NULL AS has_token
     FROM agents a LEFT JOIN agent_slack_apps s ON s.agent_id = a.id ORDER BY a.name COLLATE NOCASE`,
  ).map(({ scopes, granted_scopes, has_token, ...a }) => ({ ...a, outdated: Boolean(a.installed && missingScopes({ scopes, granted_scopes, bot_token: has_token }).length) })).map((a) => ({
    agent_id: a.id,
    name: a.name,
    title: a.title,
    color: a.color,
    photo_version: a.photo_version,
    agent_status: a.status,
    // outdated: in Slack and working, but Hive now asks for a new permission, which needs one more Allow
    state: !a.app_id ? 'none' : !a.installed ? 'created' : a.outdated ? 'outdated' : 'installed',
    error: a.error,
    installed_at: a.installed_at,
    slack_url: a.installed ? slackLink({ app_id: a.app_id, team_id: a.team_id, bot_token: true }) : null,
  }));
  return {
    connected: Boolean(c?.refresh),
    team_id: c?.team_id ?? null,
    events_url: `${origin()}/slack/events`,
    agents,
    counts: { total: agents.length, installed: agents.filter((a) => a.state === 'installed' || a.state === 'outdated').length, created: agents.filter((a) => a.state !== 'none').length },
  };
}
