// Who can do what in Hive.
//
//   owner     everything: agents, teams, budgets, workflows, settings, backups, people
//   approver  approve or reject agents' actions, and teach agents lessons, for their departments
//             (all departments if none are set), plus everything a member can do
//   member    view, chat with agents, and give and manage tasks
//
// Everyone who signs in with a Presentail account is recorded here. OWNER_EMAILS (comma-separated)
// are always owners; without it, the first person to sign in becomes the owner. Owners change
// roles in Settings → People.
import { all, get, run } from './db.js';
import { emit } from './events.js';

export const ROLES = ['owner', 'approver', 'member'];
const ownerEmails = () => (process.env.OWNER_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

const parse = (u) => (u ? { ...u, teams: JSON.parse(u.teams || '[]') } : null);

const safePhoto = (url) => (/^https:\/\/[^\s]+$/.test(url ?? '') ? String(url).slice(0, 1000) : null);

/** The Hive user for a signed-in person (created on first sight). `null` email = local/password mode. */
export function userFor({ email, name, picture } = {}) {
  const e = String(email || '').toLowerCase();
  if (!e) return { email: '', name: name || 'Admin', role: 'owner', teams: [] }; // no Google sign-in: single-admin mode
  let u = get('SELECT * FROM users WHERE email = ?', e);
  if (!u) {
    const first = !get("SELECT 1 FROM users WHERE role = 'owner'") && !ownerEmails().length;
    const role = ownerEmails().includes(e) || first ? 'owner' : 'member';
    run('INSERT OR IGNORE INTO users (email, name, role, provider_photo) VALUES (?, ?, ?, ?)', e, name || e, role, safePhoto(picture));
    u = get('SELECT * FROM users WHERE email = ?', e);
    emit('user', {});
  } else {
    // The account's name only until the person edits their profile; the account photo is kept up
    // to date but never replaces an uploaded photo or a removal (see people.js avatarUrl).
    run(
      `UPDATE users SET name = CASE WHEN profile_updated_at IS NULL THEN COALESCE(?, name) ELSE name END,
         provider_photo = COALESCE(?, provider_photo), last_seen_at = datetime('now') WHERE email = ?`,
      name || null, safePhoto(picture), e,
    );
  }
  u = parse(u);
  if (ownerEmails().includes(e)) u.role = 'owner';
  return u;
}

export const listUsers = () => all('SELECT * FROM users ORDER BY CASE role WHEN \'owner\' THEN 0 WHEN \'approver\' THEN 1 ELSE 2 END, name').map(parse);

export function setUserRole(email, { role, teams }, actor) {
  const u = get('SELECT * FROM users WHERE email = ?', String(email).toLowerCase());
  if (!u) throw new Error('Unknown person');
  if (role !== undefined && !ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
  if (role && role !== 'owner' && u.role === 'owner') {
    const owners = get("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND status = 'active'").n; // owners whose access is off don't count
    if (owners <= 1) throw new Error('Hive needs at least one owner');
  }
  if (actor && actor.email === u.email && role && role !== 'owner') throw new Error("You can't remove your own owner role");
  if (teams !== undefined && (!Array.isArray(teams) || teams.some((t) => !Number.isInteger(t)))) throw new Error('teams must be a list of team ids');
  if (role !== undefined) run('UPDATE users SET role = ? WHERE email = ?', role, u.email);
  if (teams !== undefined) run('UPDATE users SET teams = ? WHERE email = ?', JSON.stringify(teams), u.email);
  emit('user', {});
  return parse(get('SELECT * FROM users WHERE email = ?', u.email));
}

/** Can this user approve (or reject, or teach) for this agent? */
export function canApproveFor(user, agentId) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  if (user.role !== 'approver') return false;
  if (!user.teams?.length) return true;
  const a = get('SELECT team_id FROM agents WHERE id = ?', agentId);
  return Boolean(a?.team_id && user.teams.includes(a.team_id));
}

export const isOwner = (user) => user?.role === 'owner';

/** Look up a Hive user by email without creating one (Slack uses this). */
export const knownUser = (email) => {
  const e = String(email || '').toLowerCase();
  const u = parse(get('SELECT * FROM users WHERE email = ?', e));
  if (u && ownerEmails().includes(e)) u.role = 'owner';
  return u ?? (ownerEmails().includes(e) ? { email: e, role: 'owner', teams: [] } : null);
};
