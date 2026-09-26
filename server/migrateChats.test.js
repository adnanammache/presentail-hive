// Several Hive processes starting at once (an overlapping redeploy, worker processes) all run the
// start-up migrations on the same database: none may fail, and messages get exactly one conversation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const start = (file) =>
  exec(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', "await import('./server/db.js'); process.exit(0);"], {
    cwd: process.cwd(),
    env: { ...process.env, DB_PATH: file, HIVE_SCHEDULER: 'off' },
  });

test('processes starting together give old messages their conversations without "database is locked"', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hive-migrate-')), 'hive.db');
  await start(file); // create the schema
  const db = new DatabaseSync(file);
  for (let a = 1; a <= 30; a++) db.prepare("INSERT INTO agents (id, name, api_token) VALUES (?, ?, ?)").run(a, `Agent ${a}`, `t${a}`);
  const add = db.prepare('INSERT INTO messages (agent_id, sender, body, meta) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 300; i++) add.run((i % 30) + 1, i % 2 ? 'agent' : 'user', `Message ${i}`, JSON.stringify({ origin: Math.floor(i / 30) % 2 ? 'hive' : 'slack:C1:1.2' }));
  db.close();

  const results = await Promise.allSettled(Array.from({ length: 6 }, () => start(file)));
  const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason.stderr || r.reason.message);
  assert.deepEqual(failed, [], 'every process started');

  const check = new DatabaseSync(file);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id IS NULL').get().n, 0);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM chats').get().n, 60, 'one conversation per agent and place');
  check.close();
});
