import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'hive-backup-'));
process.env.DB_PATH = join(dir, 'hive.db');
const { run } = await import('./db.js');
const { backupNow, listBackups, backupPath, backupDir, KEEP } = await import('./backup.js');

test('backups are complete copies, the newest 14 are kept, and only Hive-made names can be downloaded', () => {
  run("INSERT INTO agents (name, title, api_token) VALUES ('Ledger', 'UAE Accountant', 'l')");
  const b = backupNow();
  assert.match(b.name, /^hive-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
  const copy = new DatabaseSync(backupPath(b.name), { readOnly: true });
  assert.equal(copy.prepare('SELECT name FROM agents').get().name, 'Ledger');
  copy.close();

  // Older backups beyond the limit are removed.
  for (let i = 0; i < KEEP + 3; i++) writeFileSync(join(backupDir(), `hive-2020-01-${String(i + 1).padStart(2, '0')}-000000.db`), 'old');
  backupNow();
  const names = listBackups().map((x) => x.name);
  assert.equal(names.length, KEEP);
  assert.ok(names[0] >= b.name, 'newest first');
  assert.ok(!names.includes('hive-2020-01-01-000000.db'));

  assert.equal(backupPath('../hive.db'), null);
  assert.equal(backupPath('hive.db'), null);
  assert.equal(backupPath('hive-2019-01-01-000000.db'), null, 'must exist');
});
