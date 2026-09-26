// The live database has lessons from before approvals existed; make sure they upgrade in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('existing lessons stay approved; switched-off agent suggestions move to waiting for approval', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hive-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT 'custom', status TEXT NOT NULL DEFAULT 'idle',
    model TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT '', webhook_url TEXT NOT NULL DEFAULT '',
    api_token TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#6366f1', last_seen_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE agent_lessons (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', task_id INTEGER, created_by TEXT, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO agents (name, api_token) VALUES ('Ziad', 'z');
  INSERT INTO agent_lessons (agent_id, text, source, active) VALUES
    (1, 'Taught by a person', 'manual', 1),
    (1, 'Paused by a person', 'rejection', 0),
    (1, 'Saved live by the agent from an owner', 'agent', 1),
    (1, 'Suggested by the agent from a member', 'agent', 0);`);
  old.close();

  process.env.DB_PATH = file;
  const { all, get } = await import('./db.js');
  const { lessonsBlock } = await import('./lessons.js');
  assert.deepEqual(
    all('SELECT text, status, active FROM agent_lessons ORDER BY id').map((l) => ({ ...l })),
    [
      { text: 'Taught by a person', status: 'approved', active: 1 },
      { text: 'Paused by a person', status: 'approved', active: 0 },
      { text: 'Saved live by the agent from an owner', status: 'approved', active: 1 },
      { text: 'Suggested by the agent from a member', status: 'pending_approval', active: 1 },
    ],
  );
  assert.equal(get('SELECT trust_lessons FROM agents WHERE id = 1').trust_lessons, 0);
  const block = lessonsBlock(1);
  assert.match(block, /\[#1\] Taught by a person[\s\S]*\[#3\] Saved live/);
  assert.ok(!block.includes('Suggested by the agent'), 'the waiting one is not in the instructions');
  assert.ok(!block.includes('Paused'));
});
