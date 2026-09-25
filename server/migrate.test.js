// The live database was created before teams and titles existed; make sure it upgrades in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('an old database (role column, no teams) is upgraded without losing agents', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hive-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT 'custom', status TEXT NOT NULL DEFAULT 'idle',
    model TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT '', webhook_url TEXT NOT NULL DEFAULT '',
    api_token TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#6366f1', last_seen_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  old.prepare('INSERT INTO agents (name, role, api_token) VALUES (?, ?, ?)').run('Ledger', 'Bookkeeper', 'agt_x');
  old.close();

  process.env.DB_PATH = file;
  const { all, get } = await import('./db.js');
  const agent = get('SELECT * FROM agents WHERE name = ?', 'Ledger');
  assert.equal(agent.title, 'Bookkeeper');
  assert.equal(agent.team_id, null);
  assert.equal(agent.role, undefined);
  assert.deepEqual(all('SELECT * FROM teams'), []);
});
