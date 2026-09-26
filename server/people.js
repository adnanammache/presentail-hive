// People: profiles and photos, team membership (people and agents together), the Team & agents
// directory, invitations and deactivation.
//
// Kept apart on purpose:
//   workspace role   users.role (owner | approver | member): what you may do in Hive
//   team membership  team_members (people, many teams) and agents.team_id (an agent's one team)
//   team role        team_members.role (lead | member): a lead may add and remove people on their
//                    own team, nothing more — never workspace permissions, roles or tool access
//   job title        users.title: descriptive text, grants nothing
//   manager          users.manager_email: who someone reports to
//   project access   project_members (see projects.js)
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, all, db, get, run } from './db.js';
import { emit } from './events.js';
import { bad, conflict, forbidden, notFound } from './http.js';
import { MAX_PHOTO, imageType } from './avatars.js';
import { ROLES, setUserRole } from './roles.js';
import { sendMail } from './mail.js';
import { baseUrl } from './notify.js';

export const INVITE_DAYS = 7;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const lower = (e) => String(e ?? '').trim().toLowerCase();
const isOwner = (u) => u?.role === 'owner';

// ---------------------------------------------------------------- photos

/**
 * Which picture to show: an uploaded photo, else the sign-in account's photo (unless the person
 * removed their photo), else nobody's (initials). Every screen uses this one rule.
 */
export function avatarUrl(u) {
  if (!u?.email) return null;
  if (u.photo_source === 'none') return null;
  if (u.photo_source === 'upload') return u.photo_version ? `/api/people/${encodeURIComponent(u.email)}/photo?v=${u.photo_version}` : null;
  return /^https:\/\//.test(u.provider_photo ?? '') ? u.provider_photo : null;
}

/** Width and height from the image header: proves the bytes are a real, readable image. */
export function imageSize(buf, type) {
  try {
    if (type === 'image/png') return buf.toString('latin1', 12, 16) === 'IHDR' ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null;
    if (type === 'image/webp') {
      const chunk = buf.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
      return null;
    }
    if (type === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
  } catch {}
  return null;
}

const photoPath = (email) => join(DATA_DIR, 'user-photos', `${createHash('sha256').update(email).digest('hex').slice(0, 32)}.img`);

function mustBeSelf(email, viewer, what = 'change') {
  if (lower(email) !== viewer?.email) throw forbidden(`You can only ${what} your own profile.`);
  const u = get('SELECT * FROM users WHERE email = ?', lower(email));
  if (!u) throw notFound('Person');
  return u;
}

export function savePhoto(email, buf, viewer) {
  const u = mustBeSelf(email, viewer);
  if (!buf?.length) throw bad('Choose a photo');
  if (buf.length > MAX_PHOTO) throw bad('The photo must be under 3 MB');
  const type = imageType(buf);
  if (!type) throw bad('Use a PNG, JPEG or WebP image');
  const size = imageSize(buf, type);
  if (!size || size.w < 32 || size.h < 32 || size.w > 8000 || size.h > 8000) throw bad("That file isn't a readable image (32 to 8000 pixels wide)");
  mkdirSync(join(DATA_DIR, 'user-photos'), { recursive: true });
  writeFileSync(photoPath(u.email), buf);
  run("UPDATE users SET photo_source = 'upload', photo_type = ?, photo_version = ? WHERE email = ?", type, Date.now(), u.email);
  emit('user', { email: u.email });
  return getPerson(u.email, viewer);
}

/** "Remove photo": initials from now on (a later sign-in doesn't bring the account photo back). */
export function removePhoto(email, viewer) {
  const u = mustBeSelf(email, viewer);
  rmSync(photoPath(u.email), { force: true });
  run("UPDATE users SET photo_source = 'none', photo_type = NULL, photo_version = NULL WHERE email = ?", u.email);
  emit('user', { email: u.email });
  return getPerson(u.email, viewer);
}

/** "Use account photo": show the sign-in provider's picture again. */
export function useAccountPhoto(email, viewer) {
  const u = mustBeSelf(email, viewer);
  rmSync(photoPath(u.email), { force: true });
  run("UPDATE users SET photo_source = 'provider', photo_type = NULL, photo_version = NULL WHERE email = ?", u.email);
  emit('user', { email: u.email });
  return getPerson(u.email, viewer);
}

export function photoFile(email) {
  const u = get("SELECT email, photo_type FROM users WHERE email = ? AND photo_source = 'upload'", lower(email));
  if (!u?.photo_type) return null;
  try {
    return { type: u.photo_type, body: readFileSync(photoPath(u.email)) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- profiles

const teamsOf = (email) =>
  all('SELECT t.id, t.name, t.color, m.role FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_email = ? ORDER BY t.name', email);

/** What anyone in the workspace may see about a person. */
export function publicPerson(u) {
  if (!u) return null;
  return {
    email: u.email,
    name: u.name || u.email,
    title: u.title ?? '',
    bio: u.bio ?? '',
    timezone: u.timezone ?? null,
    role: u.role,
    status: u.status ?? 'active',
    avatar_url: avatarUrl(u),
    has_account_photo: /^https:\/\//.test(u.provider_photo ?? ''),
    photo_source: u.photo_source ?? null,
    manager_email: u.manager_email ?? null,
  };
}

export function listPeople({ includeInactive } = {}) {
  return all(
    `SELECT u.*, (SELECT COUNT(*) FROM tasks t WHERE t.assignee_email = u.email AND t.status != 'done') AS open_tasks
     FROM users u ${includeInactive ? '' : "WHERE u.status = 'active'"}
     ORDER BY CASE WHEN u.email = 'admin@local' THEN 1 ELSE 0 END, u.name COLLATE NOCASE`,
  ).map((u) => ({ ...publicPerson(u), open_tasks: u.open_tasks, teams: teamsOf(u.email), last_seen_at: u.last_seen_at }));
}

export function getPerson(email, viewer) {
  const u = get('SELECT * FROM users WHERE email = ?', lower(email));
  if (!u) throw notFound('Person');
  const manager = u.manager_email ? get('SELECT email, name FROM users WHERE email = ?', u.manager_email) : null;
  return {
    ...publicPerson(u),
    teams: teamsOf(u.email),
    manager: manager ? { email: manager.email, name: manager.name || manager.email } : null,
    open_tasks: get("SELECT COUNT(*) AS n FROM tasks WHERE assignee_email = ? AND status != 'done'", u.email).n,
    is_me: viewer?.email === u.email,
    can_manage: isOwner(viewer),
  };
}

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Your own name, job title, bio and timezone. Nobody edits another person's profile. */
export function updateProfile(email, body, viewer) {
  const u = mustBeSelf(email, viewer, 'edit');
  const f = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw bad('Your display name can’t be empty');
    f.name = name.slice(0, 80);
  }
  if (body.title !== undefined) f.title = String(body.title ?? '').trim().slice(0, 80);
  if (body.bio !== undefined) f.bio = String(body.bio ?? '').trim().slice(0, 600);
  if (body.timezone !== undefined) {
    if (body.timezone && !validTimezone(body.timezone)) throw bad('Unknown timezone');
    f.timezone = body.timezone || null;
  }
  for (const k of ['email', 'role', 'status', 'manager_email']) if (body[k] !== undefined) throw bad(`${k} can't be changed here`);
  const keys = Object.keys(f);
  if (keys.length) run(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}, profile_updated_at = datetime('now') WHERE email = ?`, ...keys.map((k) => f[k]), u.email);
  emit('user', { email: u.email });
  return getPerson(u.email, viewer);
}

// ---------------------------------------------------------------- teams (people and agents)

export const teamRole = (email, teamId) => get('SELECT role FROM team_members WHERE team_id = ? AND user_email = ?', Number(teamId), email)?.role ?? null;
const leadOf = (email) => all("SELECT team_id FROM team_members WHERE user_email = ? AND role = 'lead'", email).map((r) => r.team_id);

/** Owners manage every team; a team lead manages the people on their own team. */
export const canManageTeamPeople = (viewer, teamId) => isOwner(viewer) || teamRole(viewer?.email, teamId) === 'lead';

function mustTeam(teamId) {
  const t = get('SELECT * FROM teams WHERE id = ?', Number(teamId));
  if (!t) throw notFound('Team');
  return t;
}

/**
 * Add people and/or agents to a team. Nothing else happens: no agent starts, no task is assigned,
 * no role or tool access changes. An agent has one team, so adding it moves it (owners only).
 */
export function addTeamMembers(teamId, members, viewer) {
  const team = mustTeam(teamId);
  if (!Array.isArray(members) || !members.length) throw bad('Choose who to add');
  const tx = [];
  for (const m of members) {
    if (m?.type === 'user') {
      if (!canManageTeamPeople(viewer, team.id)) throw forbidden(`Only an owner or a lead of ${team.name} can add people to it.`);
      const u = get('SELECT email, status FROM users WHERE email = ?', lower(m.ref ?? m.email));
      if (!u) throw bad('That person is not a member of this workspace');
      if (u.status !== 'active') throw bad(`${u.email}'s access is turned off`);
      tx.push(() => run('INSERT OR IGNORE INTO team_members (team_id, user_email, role, added_by) VALUES (?, ?, ?, ?)', team.id, u.email, 'member', viewer.email));
    } else if (m?.type === 'agent') {
      if (!isOwner(viewer)) throw forbidden('Only an owner can move an AI agent to a team (it changes the agent’s setup).');
      const a = get('SELECT id FROM agents WHERE id = ?', Number(m.ref ?? m.id));
      if (!a) throw bad('Unknown agent');
      tx.push(() => run('UPDATE agents SET team_id = ? WHERE id = ?', team.id, a.id));
    } else throw bad('A member must be a person or an AI agent');
  }
  db.exec('BEGIN');
  try {
    tx.forEach((f) => f());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  emit('user', {});
  emit('agent', {});
  return directoryTeam(team.id);
}

/** Take someone off a team. Their account, agent, tasks and history stay exactly as they are. */
export function removeTeamMember(teamId, type, ref, viewer) {
  const team = mustTeam(teamId);
  if (type === 'user') {
    const email = lower(ref);
    const current = teamRole(email, team.id);
    if (!current) throw notFound('Team member');
    if (!canManageTeamPeople(viewer, team.id)) throw forbidden(`Only an owner or a lead of ${team.name} can remove people from it.`);
    if (current === 'lead' && !isOwner(viewer)) throw forbidden('Only an owner can remove a team lead.');
    run('DELETE FROM team_members WHERE team_id = ? AND user_email = ?', team.id, email);
  } else if (type === 'agent') {
    if (!isOwner(viewer)) throw forbidden('Only an owner can take an AI agent off a team.');
    if (!run('UPDATE agents SET team_id = NULL WHERE id = ? AND team_id = ?', Number(ref), team.id).changes) throw notFound('Team member');
  } else throw bad('type must be user or agent');
  emit('user', {});
  emit('agent', {});
  return directoryTeam(team.id);
}

/** Lead or member (owners only). A lead gets no workspace permissions. */
export function setTeamRole(teamId, email, role, viewer) {
  const team = mustTeam(teamId);
  if (!isOwner(viewer)) throw forbidden('Only an owner can choose team leads.');
  if (!['lead', 'member'].includes(role)) throw bad('role must be lead or member');
  if (!run('UPDATE team_members SET role = ? WHERE team_id = ? AND user_email = ?', role, team.id, lower(email)).changes) throw notFound('Team member');
  emit('user', {});
  return directoryTeam(team.id);
}

// ---------------------------------------------------------------- the directory

const openByPerson = () => Object.fromEntries(all("SELECT assignee_email AS e, COUNT(*) AS n FROM tasks WHERE status != 'done' AND assignee_email IS NOT NULL GROUP BY assignee_email").map((r) => [r.e, r.n]));

function directoryTeam(teamId) {
  const t = mustTeam(teamId);
  const open = openByPerson();
  const people = all(
    `SELECT u.*, m.role AS team_role FROM team_members m JOIN users u ON u.email = m.user_email
     WHERE m.team_id = ? AND u.status = 'active' ORDER BY CASE m.role WHEN 'lead' THEN 0 ELSE 1 END, u.name COLLATE NOCASE`,
    t.id,
  ).map((u) => ({ ...publicPerson(u), team_role: u.team_role, open_tasks: open[u.email] ?? 0 }));
  const agentIds = all('SELECT id FROM agents WHERE team_id = ? ORDER BY name COLLATE NOCASE', t.id).map((a) => a.id);
  return { id: t.id, name: t.name, description: t.description ?? '', color: t.color, people, agent_ids: agentIds };
}

/**
 * Teams with their people and agents, who is on no team, and totals that count each person and
 * agent once however many teams they're on.
 */
export function directory(viewer) {
  const teams = all('SELECT id FROM teams ORDER BY name COLLATE NOCASE').map((t) => directoryTeam(t.id));
  const open = openByPerson();
  const people = all("SELECT u.* FROM users u WHERE u.status = 'active' ORDER BY u.name COLLATE NOCASE");
  const onTeam = new Set(all('SELECT DISTINCT user_email FROM team_members').map((r) => r.user_email));
  const agents = all('SELECT id, team_id FROM agents');
  return {
    teams,
    unassigned_people: people.filter((u) => !onTeam.has(u.email)).map((u) => ({ ...publicPerson(u), open_tasks: open[u.email] ?? 0 })),
    unassigned_agent_ids: agents.filter((a) => !a.team_id).map((a) => a.id),
    totals: { people: people.length, agents: agents.length, teams: teams.length },
    viewer: { email: viewer.email, can_invite: isOwner(viewer), can_manage_org: isOwner(viewer), lead_of: leadOf(viewer.email) },
  };
}

// ---------------------------------------------------------------- organisation (owners)

function checkManager(email, managerEmail) {
  if (!managerEmail) return null;
  const m = lower(managerEmail);
  if (m === email) throw bad('Someone can’t report to themselves');
  const mu = get('SELECT email, status FROM users WHERE email = ?', m);
  if (!mu || mu.status !== 'active') throw bad('The manager must be an active member of this workspace');
  // No loops: walk up from the new manager.
  let cur = mu.email;
  for (let i = 0; cur && i < 50; i++) {
    if (cur === email) throw bad('That would make a reporting loop');
    cur = get('SELECT manager_email FROM users WHERE email = ?', cur)?.manager_email;
  }
  return m;
}

/**
 * Workspace role, manager and teams (with lead/member) for one person. Owners only. The last owner
 * can't be demoted (setUserRole checks).
 */
export function setMembership(email, body, viewer) {
  if (!isOwner(viewer)) throw forbidden('Only an owner can change membership and roles.');
  const u = get('SELECT * FROM users WHERE email = ?', lower(email));
  if (!u) throw notFound('Person');
  if (body.role !== undefined) {
    try {
      setUserRole(u.email, { role: body.role }, viewer);
    } catch (err) {
      throw bad(err.message);
    }
  }
  if (body.manager_email !== undefined) run('UPDATE users SET manager_email = ? WHERE email = ?', checkManager(u.email, body.manager_email), u.email);
  if (body.teams !== undefined) {
    if (!Array.isArray(body.teams)) throw bad('teams must be a list');
    const clean = body.teams.map((t) => {
      mustTeam(t.team_id ?? t.id);
      if (t.role && !['lead', 'member'].includes(t.role)) throw bad('team role must be lead or member');
      return [Number(t.team_id ?? t.id), t.role || 'member'];
    });
    db.exec('BEGIN');
    run('DELETE FROM team_members WHERE user_email = ?', u.email);
    for (const [id, role] of clean) run('INSERT OR REPLACE INTO team_members (team_id, user_email, role, added_by) VALUES (?, ?, ?, ?)', id, u.email, role, viewer.email);
    db.exec('COMMIT');
  }
  emit('user', {});
  return getPerson(u.email, viewer);
}

/** Turn someone's access off. Their tasks, comments and history stay; open tasks are listed to reassign. */
export function deactivate(email, viewer) {
  if (!isOwner(viewer)) throw forbidden('Only an owner can turn off someone’s access.');
  const u = get('SELECT * FROM users WHERE email = ?', lower(email));
  if (!u) throw notFound('Person');
  if (u.email === viewer.email) throw bad('You can’t turn off your own access');
  if (u.role === 'owner' && get("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND status = 'active'").n <= 1) throw bad('Hive needs at least one active owner');
  run("UPDATE users SET status = 'deactivated', deactivated_at = datetime('now') WHERE email = ?", u.email);
  emit('user', {});
  return { ...getPerson(u.email, viewer), needs_reassigning: all("SELECT id, title FROM tasks WHERE assignee_email = ? AND status != 'done' ORDER BY id", u.email) };
}

export function reactivate(email, viewer) {
  if (!isOwner(viewer)) throw forbidden('Only an owner can turn access back on.');
  if (!run("UPDATE users SET status = 'active', deactivated_at = NULL WHERE email = ?", lower(email)).changes) throw notFound('Person');
  emit('user', {});
  return getPerson(email, viewer);
}

// ---------------------------------------------------------------- invitations

const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
const expired = (i) => i.status === 'pending' && i.expires_at < new Date().toISOString();
const inviteState = (i) => (expired(i) ? 'expired' : i.status);
export const publicInvite = (i) =>
  i && {
    id: i.id, email: i.email, role: i.role, teams: JSON.parse(i.teams || '[]'), title: i.title, manager_email: i.manager_email,
    status: inviteState(i), invited_by: i.invited_by, created_at: i.created_at, expires_at: i.expires_at, sent_at: i.sent_at, send_error: i.send_error, accepted_at: i.accepted_at,
  };

export const listInvites = () => all("SELECT * FROM invitations WHERE status IN ('pending') OR accepted_at > datetime('now', '-30 days') ORDER BY id DESC").map(publicInvite);

/** Can this (verified) email get in? A pending, unexpired invitation or an active account. */
export function hasAccessRecord(email) {
  const e = lower(email);
  if (get("SELECT 1 FROM users WHERE email = ? AND status = 'active'", e)) return true;
  return Boolean(get("SELECT 1 FROM invitations WHERE email = ? AND status = 'pending' AND expires_at > ?", e, new Date().toISOString()));
}
export const isDeactivated = (email) => Boolean(get("SELECT 1 FROM users WHERE email = ? AND status = 'deactivated'", lower(email)));

async function deliver(invite, token, viewer) {
  const link = `${baseUrl()}/invite/${token}`;
  const by = viewer?.name || viewer?.email || 'Someone';
  const result = await sendMail({
    to: invite.email,
    subject: `${by} invited you to Presentail Hive`,
    text: `${by} invited you to Presentail Hive, where Presentail's people and AI agents work together.\n\nAccept the invitation (sign in with ${invite.email}):\n${link}\n\nThis link expires in ${INVITE_DAYS} days.`,
    html: `<p>${escapeHtml(by)} invited you to <b>Presentail Hive</b>, where Presentail's people and AI agents work together.</p><p><a href="${link}">Accept the invitation</a> by signing in with <b>${escapeHtml(invite.email)}</b>.</p><p style="color:#5b6480">This link expires in ${INVITE_DAYS} days.</p>`,
  });
  run('UPDATE invitations SET sent_at = ?, send_error = ? WHERE id = ?', result.sent ? new Date().toISOString() : null, result.sent ? null : result.error, invite.id);
  // The link is returned to the owner who asked, so they can share it themselves when email isn't set up.
  return { sent: result.sent, error: result.error ?? null, link };
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function newToken(inviteId) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + INVITE_DAYS * 864e5).toISOString();
  run("UPDATE invitations SET token_hash = ?, expires_at = ?, status = 'pending' WHERE id = ?", hashToken(token), expires, inviteId);
  return token;
}

export async function createInvite(body, viewer) {
  if (!isOwner(viewer)) throw forbidden('Only an owner can invite people.');
  const email = lower(body.email);
  if (!EMAIL.test(email)) throw bad('Enter a valid email address');
  const role = body.role || 'member';
  if (!ROLES.includes(role)) throw bad(`role must be one of ${ROLES.join(', ')}`);
  const teams = (body.teams ?? []).map(Number);
  for (const t of teams) mustTeam(t);
  const existing = get('SELECT status FROM users WHERE email = ?', email);
  if (existing?.status === 'active') throw conflict(`${email} is already a member of this workspace.`);
  if (existing?.status === 'deactivated') throw conflict(`${email} has an account whose access is turned off. Turn it back on in Settings → People.`);
  const pending = get("SELECT * FROM invitations WHERE email = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", email);
  if (pending && !expired(pending)) throw conflict(`${email} already has a pending invitation. Resend it instead.`);
  if (pending) run("UPDATE invitations SET status = 'revoked' WHERE id = ?", pending.id); // an expired one is replaced
  const manager = body.manager_email ? checkManager(email, body.manager_email) : null;
  const id = Number(
    run(
      'INSERT INTO invitations (email, role, teams, title, manager_email, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      email, role, JSON.stringify(teams), String(body.title ?? '').trim().slice(0, 80), manager, 'pending-token', viewer.email, new Date().toISOString(),
    ).lastInsertRowid,
  );
  const token = newToken(id);
  const delivery = await deliver(get('SELECT * FROM invitations WHERE id = ?', id), token, viewer);
  emit('invite', {});
  return { invite: publicInvite(get('SELECT * FROM invitations WHERE id = ?', id)), delivery };
}

/** New link, new 7 days, sent again. The old link stops working. */
export async function resendInvite(id, viewer) {
  if (!isOwner(viewer)) throw forbidden('Only an owner can resend invitations.');
  const i = get('SELECT * FROM invitations WHERE id = ?', Number(id));
  if (!i) throw notFound('Invitation');
  if (i.status !== 'pending') throw bad(`This invitation was ${i.status}`);
  const token = newToken(i.id);
  const delivery = await deliver(get('SELECT * FROM invitations WHERE id = ?', i.id), token, viewer);
  emit('invite', {});
  return { invite: publicInvite(get('SELECT * FROM invitations WHERE id = ?', i.id)), delivery };
}

export function revokeInvite(id, viewer) {
  if (!isOwner(viewer)) throw forbidden('Only an owner can revoke invitations.');
  if (!run("UPDATE invitations SET status = 'revoked' WHERE id = ? AND status = 'pending'", Number(id)).changes) throw bad('Only pending invitations can be revoked');
  emit('invite', {});
  return { ok: true };
}

/** Look up an invitation by its link (for the /invite page), without accepting it. */
export function inviteForToken(token) {
  const i = token ? get('SELECT * FROM invitations WHERE token_hash = ?', hashToken(token)) : null;
  return i ? publicInvite(i) : null;
}

/**
 * Accept an invitation for a verified email (from sign-in). With a token, the link must be valid and
 * for this email; without one, the latest pending invitation for the email is used. Accepting twice
 * changes nothing and never makes a second person or membership.
 */
export function acceptInvite({ email, token, name }) {
  const e = lower(email);
  let i;
  if (token) {
    i = get('SELECT * FROM invitations WHERE token_hash = ?', hashToken(token));
    if (!i) throw new Error('This invitation link is not valid. Ask for a new one.');
    if (i.email !== e) throw new Error(`This invitation is for ${i.email}, but you signed in as ${e}.`);
    if (i.status === 'accepted') return get('SELECT * FROM users WHERE email = ?', e);
    if (i.status === 'revoked') throw new Error('This invitation was withdrawn. Ask for a new one.');
    if (expired(i)) throw new Error('This invitation has expired. Ask for a new one.');
  } else {
    i = get("SELECT * FROM invitations WHERE email = ? AND status = 'pending' AND expires_at > ? ORDER BY id DESC LIMIT 1", e, new Date().toISOString());
    if (!i) return get('SELECT * FROM users WHERE email = ?', e);
  }
  db.exec('BEGIN');
  try {
    const u = get('SELECT * FROM users WHERE email = ?', e);
    if (!u) run('INSERT INTO users (email, name, role, title, manager_email) VALUES (?, ?, ?, ?, ?)', e, name || e, i.role, i.title, i.manager_email);
    else {
      if (u.status !== 'active') run("UPDATE users SET status = 'active', deactivated_at = NULL, role = ? WHERE email = ?", i.role, e);
      if (!u.title && i.title) run('UPDATE users SET title = ? WHERE email = ?', i.title, e);
      if (!u.manager_email && i.manager_email) run('UPDATE users SET manager_email = ? WHERE email = ?', i.manager_email, e);
    }
    for (const t of JSON.parse(i.teams || '[]')) if (get('SELECT 1 FROM teams WHERE id = ?', t)) run('INSERT OR IGNORE INTO team_members (team_id, user_email, role, added_by) VALUES (?, ?, ?, ?)', t, e, 'member', i.invited_by);
    run("UPDATE invitations SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?", i.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  emit('user', {});
  emit('invite', {});
  return get('SELECT * FROM users WHERE email = ?', e);
}
