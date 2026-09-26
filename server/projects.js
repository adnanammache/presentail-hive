// Projects (optional homes for tasks), their members, per-person favorites and reference files,
// plus the New task composer's drafts.
//
// Permissions (one workspace; everyone signed in can see every project):
//   manage (edit, archive, delete, members, health)  → the project's owner or a workspace owner
//   contribute (tasks in it, resources)              → managers and the project's human members
// Adding an agent as a member grants it no tool access and never starts it.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, all, get, run } from './db.js';
import { emit } from './events.js';
import { bad, cleanUrl, forbidden, notFound } from './http.js';
import { canContribute, taskEvent } from './tasks.js';
import { avatarUrl } from './people.js';

const HEALTH = ['on_track', 'at_risk', 'off_track'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const canManage = (user, p) => Boolean(user && p && (user.role === 'owner' || p.owner_email === user.email));

function mustGet(id) {
  const p = get('SELECT * FROM projects WHERE id = ?', Number(id));
  if (!p) throw notFound('Project');
  return p;
}

function members(projectId) {
  return all(
    `SELECT m.member_type AS type, m.member_ref AS ref,
       CASE m.member_type WHEN 'user' THEN COALESCE(u.name, m.member_ref) ELSE a.name END AS name,
       CASE m.member_type WHEN 'agent' THEN a.title ELSE u.role END AS detail,
       a.color AS color, a.id AS agent_id, u.email AS u_email, u.photo_source, u.photo_version AS u_photo_version, u.provider_photo
     FROM project_members m
     LEFT JOIN users u ON m.member_type = 'user' AND u.email = m.member_ref
     LEFT JOIN agents a ON m.member_type = 'agent' AND a.id = CAST(m.member_ref AS INTEGER)
     WHERE m.project_id = ? ORDER BY m.member_type DESC, name`,
    projectId,
  )
    .filter((m) => m.name)
    .map(({ u_email, photo_source, u_photo_version, provider_photo, ...m }) => ({
      ...m,
      avatar_url: m.type === 'user' ? avatarUrl({ email: u_email, photo_source, photo_version: u_photo_version, provider_photo }) : null,
    }));
}

/** A project with what the directory and workspace show. Counts come from its tasks. */
export function describe(p, user) {
  const counts = get(
    `SELECT COUNT(*) AS total,
       SUM(status = 'done') AS done,
       SUM(status != 'done' AND blocked_kind IS NOT NULL) AS blocked,
       SUM(status != 'done' AND due_date IS NOT NULL AND due_date < date('now', '+4 hours')) AS overdue,
       SUM(status IN ('review', 'waiting_approval')) AS review,
       SUM(status IN ('in_progress')) AS in_progress
     FROM tasks WHERE project_id = ?`,
    p.id,
  );
  const owner = p.owner_email ? get('SELECT name FROM users WHERE email = ?', p.owner_email) : null;
  const m = members(p.id);
  return {
    ...p,
    owner_name: owner?.name ?? p.owner_email ?? null,
    members: m,
    people_count: m.filter((x) => x.type === 'user').length,
    agent_count: m.filter((x) => x.type === 'agent').length,
    counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v ?? 0])),
    favorite: Boolean(user && get('SELECT 1 FROM project_favorites WHERE user_email = ? AND project_id = ?', user.email, p.id)),
    can_manage: canManage(user, p),
    can_contribute: canContribute(user, p),
  };
}

export function listProjects(user, { status = 'active', q, favorites } = {}) {
  const where = [];
  const params = [];
  if (status !== 'all') where.push('p.status = ?'), params.push(status === 'archived' ? 'archived' : 'active');
  if (q) where.push('(p.name LIKE ? OR p.description LIKE ?)'), params.push(`%${q}%`, `%${q}%`);
  if (favorites) where.push('p.id IN (SELECT project_id FROM project_favorites WHERE user_email = ?)'), params.push(user.email);
  return all(`SELECT p.* FROM projects p ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.status, p.name COLLATE NOCASE`, ...params).map((p) => describe(p, user));
}

export const getProject = (id, user) => describe(mustGet(id), user);

function cleanMembers(list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw bad('members must be a list');
  const out = [];
  for (const m of list) {
    if (m?.type === 'user') {
      const email = String(m.ref ?? m.email ?? '').toLowerCase();
      const u = get('SELECT status FROM users WHERE email = ?', email);
      if (!u) throw bad('A member is not in this workspace');
      if (u.status !== 'active') throw bad(`${email}'s access is turned off`);
      out.push(['user', email]);
    } else if (m?.type === 'agent') {
      const id = Number(m.ref ?? m.id);
      if (!get('SELECT 1 FROM agents WHERE id = ?', id)) throw bad('Unknown agent');
      out.push(['agent', String(id)]);
    } else throw bad('A member must be a person or an AI agent');
  }
  return out;
}

function setMembers(projectId, list) {
  run('DELETE FROM project_members WHERE project_id = ?', projectId);
  for (const [type, ref] of list) run('INSERT OR IGNORE INTO project_members (project_id, member_type, member_ref) VALUES (?, ?, ?)', projectId, type, ref);
}

function cleanFields(b, partial) {
  const out = {};
  if (b.name !== undefined || !partial) {
    const name = String(b.name ?? '').trim();
    if (!name) throw bad('Give the project a name');
    out.name = name.slice(0, 120);
  }
  if (b.description !== undefined) out.description = String(b.description ?? '').slice(0, 5000);
  if (b.due_date !== undefined) {
    if (b.due_date && !DAY.test(b.due_date)) throw bad('due_date must be a date (YYYY-MM-DD)');
    out.due_date = b.due_date || null;
  }
  if (b.owner_email !== undefined) {
    const email = String(b.owner_email ?? '').toLowerCase();
    if (!get("SELECT 1 FROM users WHERE email = ? AND status = 'active'", email)) throw bad('The owner must be an active person in this workspace');
    out.owner_email = email;
  }
  if (b.health !== undefined) {
    if (b.health !== null && !HEALTH.includes(b.health)) throw bad(`health must be one of: ${HEALTH.join(', ')}`);
    out.health = b.health;
  }
  if (b.color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(b.color)) throw bad('color must be like #f59e0b');
    out.color = b.color;
  }
  return out;
}

export function createProject(body, user) {
  const f = cleanFields({ owner_email: user.email, ...body }, false);
  const list = cleanMembers(body.members) ?? [];
  const id = Number(
    run(
      'INSERT INTO projects (name, description, owner_email, due_date, health, color, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      f.name, f.description ?? '', f.owner_email, f.due_date ?? null, f.health ?? null, f.color ?? '#f59e0b', user.email,
    ).lastInsertRowid,
  );
  setMembers(id, list);
  emit('project', { project_id: id });
  return getProject(id, user);
}

export function updateProject(id, body, user) {
  const p = mustGet(id);
  if (!canManage(user, p)) throw forbidden('Only the project owner or a workspace owner can change this project.');
  const f = cleanFields(body, true);
  if (body.status !== undefined) {
    if (!['active', 'archived'].includes(body.status)) throw bad('status must be active or archived');
    f.status = body.status;
    f.archived_at = body.status === 'archived' ? new Date().toISOString() : null;
  }
  const keys = Object.keys(f);
  if (keys.length) run(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...keys.map((k) => f[k]), p.id);
  const list = cleanMembers(body.members);
  if (list) setMembers(p.id, list);
  emit('project', { project_id: p.id });
  emit('task');
  return getProject(p.id, user);
}

/** Delete a project. Its tasks stay (without a project), with their history. */
export function deleteProject(id, user) {
  const p = mustGet(id);
  if (!canManage(user, p)) throw forbidden('Only the project owner or a workspace owner can delete this project.');
  for (const t of all('SELECT id FROM tasks WHERE project_id = ?', p.id)) taskEvent(t.id, user.name || user.email, 'moved', `Project "${p.name}" was deleted; the task was kept`);
  run('UPDATE tasks SET project_id = NULL WHERE project_id = ?', p.id);
  run('UPDATE task_series SET project_id = NULL WHERE project_id = ?', p.id);
  for (const r of all("SELECT path FROM project_resources WHERE project_id = ? AND kind = 'file'", p.id)) rmSync(r.path, { force: true });
  run('DELETE FROM projects WHERE id = ?', p.id);
  emit('project', { project_id: p.id });
  emit('task');
  return { ok: true };
}

export function setFavorite(id, user, on) {
  mustGet(id);
  if (on) run('INSERT OR IGNORE INTO project_favorites (user_email, project_id) VALUES (?, ?)', user.email, Number(id));
  else run('DELETE FROM project_favorites WHERE user_email = ? AND project_id = ?', user.email, Number(id));
  emit('project', { project_id: Number(id) });
  return { favorite: on };
}

// ---------------------------------------------------------------- resources

export const listResources = (id) =>
  all('SELECT id, project_id, kind, label, url, size, created_by, created_at FROM project_resources WHERE project_id = ? ORDER BY id', Number(mustGet(id).id));

export function addResource(id, user, { url, label, file }) {
  const p = mustGet(id);
  if (!canContribute(user, p)) throw forbidden("Only the project's members can add resources.");
  let rid;
  if (file) {
    const dir = join(DATA_DIR, 'project-files', String(p.id));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${Date.now()}-${file.name}`);
    writeFileSync(path, file.body);
    rid = run("INSERT INTO project_resources (project_id, kind, label, path, size, created_by) VALUES (?, 'file', ?, ?, ?, ?)", p.id, file.name, path, file.body.length, user.name || user.email).lastInsertRowid;
  } else {
    const clean = cleanUrl(url);
    if (!clean) throw bad('Enter a web link (https://…)');
    rid = run("INSERT INTO project_resources (project_id, kind, label, url, created_by) VALUES (?, 'link', ?, ?, ?)", p.id, String(label || clean).slice(0, 200), clean, user.name || user.email).lastInsertRowid;
  }
  emit('project', { project_id: p.id });
  return get('SELECT id, project_id, kind, label, url, size, created_by, created_at FROM project_resources WHERE id = ?', rid);
}

export function removeResource(id, rid, user) {
  const p = mustGet(id);
  if (!canContribute(user, p)) throw forbidden("Only the project's members can remove resources.");
  const r = get('SELECT * FROM project_resources WHERE id = ? AND project_id = ?', Number(rid), p.id);
  if (!r) throw notFound('Resource');
  if (r.path) rmSync(r.path, { force: true });
  run('DELETE FROM project_resources WHERE id = ?', r.id);
  emit('project', { project_id: p.id });
  return { ok: true };
}

export const resourceFile = (id, rid) => get("SELECT * FROM project_resources WHERE id = ? AND project_id = ? AND kind = 'file'", Number(rid), Number(id));

// ---------------------------------------------------------------- composer drafts (one per person)

export function getDraft(email) {
  const d = get('SELECT data, updated_at FROM task_drafts WHERE user_email = ?', email);
  const files = all('SELECT id, filename, size FROM draft_files WHERE user_email = ? ORDER BY id', email);
  return d ? { data: JSON.parse(d.data), updated_at: d.updated_at, files } : { data: null, updated_at: null, files };
}

export function saveDraft(email, data) {
  const json = JSON.stringify(data ?? {});
  if (json.length > 200_000) throw bad('The draft is too long');
  run(
    `INSERT INTO task_drafts (user_email, data, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_email) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    email, json,
  );
  return getDraft(email);
}

/** Throw the draft away, files included. `keepFiles` after a submit (they were moved to the task). */
export function discardDraft(email) {
  for (const f of all('SELECT path FROM draft_files WHERE user_email = ?', email)) rmSync(f.path, { force: true });
  run('DELETE FROM draft_files WHERE user_email = ?', email);
  run('DELETE FROM task_drafts WHERE user_email = ?', email);
  return { ok: true };
}

export function addDraftFile(email, file) {
  if (get('SELECT COUNT(*) AS n FROM draft_files WHERE user_email = ?', email).n >= 20) throw bad('A draft can hold up to 20 files');
  const dir = join(DATA_DIR, 'draft-files', Buffer.from(email).toString('hex').slice(0, 64));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${file.name}`);
  writeFileSync(path, file.body);
  const id = run('INSERT INTO draft_files (user_email, filename, path, size) VALUES (?, ?, ?, ?)', email, file.name, path, file.body.length).lastInsertRowid;
  return get('SELECT id, filename, size FROM draft_files WHERE id = ?', id);
}

export function removeDraftFile(email, id) {
  const f = get('SELECT * FROM draft_files WHERE id = ? AND user_email = ?', Number(id), email);
  if (!f) throw notFound('File');
  rmSync(f.path, { force: true });
  run('DELETE FROM draft_files WHERE id = ?', f.id);
  return { ok: true };
}
