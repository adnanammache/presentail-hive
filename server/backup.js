// Nightly backups of Hive's database, kept next to it on the volume (last 14), plus on demand.
// Each backup is a complete, consistent SQLite file (VACUUM INTO), safe to take while Hive runs.
// Download one from Settings and keep it somewhere else too (e.g. Google Drive).
//
// To restore: stop the service, replace hive.db on the volume with the backup file, start again.
import { Cron } from 'croner';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, db } from './db.js';
import { logActivity } from './activity.js';
import { recordHealth } from './health.js';

export const KEEP = 14;
const NAME = /^hive-\d{4}-\d{2}-\d{2}-\d{6}\.db$/;
export const backupDir = () => join(DATA_DIR, 'backups');

export function listBackups() {
  let names = [];
  try {
    names = readdirSync(backupDir()).filter((n) => NAME.test(n));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const st = statSync(join(backupDir(), name));
      return { name, size: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

export function backupNow({ reason = 'manual' } = {}) {
  mkdirSync(backupDir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const name = `hive-${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}-${stamp.slice(8)}.db`;
  const path = join(backupDir(), name);
  rmSync(path, { force: true });
  try {
    db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  } catch (err) {
    recordHealth('backup', false, err.message);
    throw err;
  }
  recordHealth('backup', true);
  for (const old of listBackups().slice(KEEP)) rmSync(join(backupDir(), old.name), { force: true });
  if (reason === 'manual') logActivity(null, 'system', `Backup ${name} created`);
  return listBackups().find((b) => b.name === name);
}

/** Absolute path of a backup, only for names Hive itself created. */
export function backupPath(name) {
  if (!NAME.test(String(name))) return null;
  const path = join(backupDir(), name);
  try {
    statSync(path);
    return path;
  } catch {
    return null;
  }
}

let job = null;
export function scheduleBackups() {
  job?.stop();
  job = new Cron('15 3 * * *', { timezone: 'Asia/Dubai', protect: true }, () => {
    try {
      backupNow({ reason: 'nightly' });
    } catch (err) {
      console.error('[backup]', err.message);
      logActivity(null, 'error', `Nightly backup failed: ${err.message}`);
    }
  });
  // First start (or no backup in the last day): take one now so there's always a recent copy.
  const latest = listBackups()[0];
  if (!latest || Date.now() - new Date(latest.created_at).getTime() > 26 * 3600 * 1000) {
    try {
      backupNow({ reason: 'startup' });
    } catch (err) {
      console.error('[backup]', err.message);
    }
  }
}
export const stopBackups = () => (job?.stop(), (job = null));
