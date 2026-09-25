import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

// On Railway, an attached volume exposes RAILWAY_VOLUME_MOUNT_PATH; keep the database there so it survives deploys.
const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DB_PATH = process.env.DB_PATH || (volume ? `${volume.replace(/\/$/, '')}/hive.db` : './data/hive.db');
if (process.env.RAILWAY_ENVIRONMENT && !volume && !process.env.DB_PATH) {
  console.warn('[db] No Railway volume attached: data will be lost on every redeploy. Attach a volume to this service.');
}
if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#6366f1',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  team_id       INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  description   TEXT NOT NULL DEFAULT '',
  platform      TEXT NOT NULL DEFAULT 'custom',   -- claude | make | replit | n8n | custom | human
  status        TEXT NOT NULL DEFAULT 'idle',     -- active | idle | paused | error
  model         TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  webhook_url   TEXT NOT NULL DEFAULT '',
  api_token     TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '#6366f1',
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  agent_id     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  schedule     TEXT NOT NULL,                     -- cron expression
  timezone     TEXT NOT NULL DEFAULT 'UTC',
  instructions TEXT NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_run_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id  INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  task_id      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'running',   -- running | success | failed
  trigger      TEXT NOT NULL DEFAULT 'schedule',  -- schedule | manual | api
  output       TEXT NOT NULL DEFAULT '',
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'todo',      -- backlog | todo | in_progress | review | done | blocked
  priority     TEXT NOT NULL DEFAULT 'medium',    -- low | medium | high | urgent
  agent_id     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  workflow_id  INTEGER REFERENCES workflows(id) ON DELETE SET NULL,
  due_date     TEXT,
  result       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  sender      TEXT NOT NULL,                      -- user | agent | system
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id, id);
CREATE INDEX IF NOT EXISTS idx_runs_workflow ON workflow_runs(workflow_id, id);
`);

// ---- migrations for databases created by earlier versions ----
const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
if (columns('agents').includes('role')) db.exec('ALTER TABLE agents RENAME COLUMN role TO title');
if (!columns('agents').includes('team_id')) db.exec('ALTER TABLE agents ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_agents_team ON agents(team_id)');

// Capabilities (skills, integrations, approval rule) and the link to Claude Managed Agents.
const addColumn = (table, name, ddl) => {
  if (!columns(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
};
addColumn('agents', 'skills', "TEXT NOT NULL DEFAULT '[]'");
addColumn('agents', 'integrations', "TEXT NOT NULL DEFAULT '[]'");
addColumn('agents', 'approval', "TEXT NOT NULL DEFAULT 'agent_asks'");
addColumn('agents', 'ma_agent_id', 'TEXT');
addColumn('agents', 'ma_agent_version', 'INTEGER');
addColumn('agents', 'ma_config_hash', 'TEXT');
addColumn('agents', 'ma_sync_error', 'TEXT');
addColumn('messages', 'meta', 'TEXT');

db.exec(`
CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS task_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  path        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  anthropic_file_id TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One run = one Claude Managed Agents session working on a task (or an agent's chat).
CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL DEFAULT 'task',      -- task | chat
  task_id      INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id     INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  session_id   TEXT,
  status       TEXT NOT NULL DEFAULT 'starting',  -- starting | running | needs_approval | waiting | failed | ended
  pending      TEXT NOT NULL DEFAULT '[]',        -- tool calls waiting for approval
  last_message TEXT NOT NULL DEFAULT '',
  error        TEXT,
  cost_cents   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS run_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  event_id    TEXT NOT NULL,
  type        TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, event_id)
);
CREATE TABLE IF NOT EXISTS run_outputs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  file_id     TEXT NOT NULL,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
  size        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, file_id)
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, id);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);
`);

export const DATA_DIR = DB_PATH === ':memory:' ? './data' : dirname(DB_PATH);

export const newToken = () => 'agt_' + randomBytes(24).toString('hex');

export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const get = (sql, ...params) => db.prepare(sql).get(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);

/** Build an UPDATE from a whitelist of fields present in `patch`. */
export function update(table, id, patch, fields) {
  const keys = fields.filter((f) => patch[f] !== undefined);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  run(`UPDATE ${table} SET ${sets} WHERE id = ?`, ...keys.map((k) => patch[k]), id);
}
