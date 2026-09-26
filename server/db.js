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
-- Every Odoo call an agent makes through Hive: what, for whom, who approved, what came back.
CREATE TABLE IF NOT EXISTS odoo_actions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  agent_id     INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  event_id     TEXT NOT NULL UNIQUE,
  model        TEXT NOT NULL,
  method       TEXT NOT NULL,
  company_id   INTEGER,
  input        TEXT NOT NULL,
  kind         TEXT NOT NULL,                     -- read | write | forbidden
  status       TEXT NOT NULL,                     -- pending | executed | failed | rejected | refused
  approved_by  TEXT,
  result       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, id);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);
`);

addColumn('runs', 'auto_approve', 'INTEGER NOT NULL DEFAULT 0'); // "approve the rest of this run"
addColumn('runs', 'slack_ts', 'TEXT'); // the approval alert in Slack, updated once someone decides
addColumn('runs', 'origin', 'TEXT'); // chats: where the conversation lives ('hive', or 'slack:<channel>:<thread_ts>')
addColumn('agents', 'reviewer_id', 'INTEGER REFERENCES agents(id) ON DELETE SET NULL'); // default reviewer of this agent's work
addColumn('tasks', 'handoff_agent_id', 'INTEGER REFERENCES agents(id) ON DELETE SET NULL'); // this task's reviewer, overriding the default
addColumn('tasks', 'parent_task_id', 'INTEGER REFERENCES tasks(id) ON DELETE SET NULL'); // set on "Review: …" tasks
addColumn('tasks', 'handoff_task_id', 'INTEGER'); // the review task opened for this one

// Month-end close: the recurring jobs per company, and which task did each one for a month.
db.exec(`
CREATE TABLE IF NOT EXISTS close_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity        TEXT NOT NULL,                   -- UAE | Lebanon | Cyprus (free text)
  name          TEXT NOT NULL,
  agent_id      INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  instructions  TEXT NOT NULL DEFAULT '',        -- {month} is replaced with e.g. "August 2026"
  files_hint    TEXT NOT NULL DEFAULT '',        -- what to attach
  due_day       INTEGER NOT NULL DEFAULT 10,     -- due on this day of the following month
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
addColumn('tasks', 'close_item_id', 'INTEGER REFERENCES close_items(id) ON DELETE SET NULL');
addColumn('tasks', 'period', 'TEXT'); // YYYY-MM the close task is for
addColumn('agents', 'budget_cents', 'INTEGER'); // monthly AI budget; NULL = no limit
addColumn('agents', 'sort_order', 'INTEGER'); // place within its team on the org chart; NULL = after the arranged ones, by name
addColumn('agents', 'photo_type', 'TEXT'); // uploaded photo's image type (the file is DATA_DIR/agent-photos/<id>.img)
addColumn('agents', 'photo_version', 'INTEGER'); // changes on each upload, for cache-busting
addColumn('teams', 'budget_cents', 'INTEGER');

db.exec(`
-- Slack threads started with an agent (a chat, or a task created from files)
CREATE TABLE IF NOT EXISTS slack_threads (
  channel     TEXT NOT NULL,
  thread_ts   TEXT NOT NULL,
  agent_id    INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, thread_ts)
);
-- Slack retries events; each is handled once
CREATE TABLE IF NOT EXISTS slack_events (event_id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')));
-- People who use Hive and what they may do (see roles.js)
CREATE TABLE IF NOT EXISTS users (
  email         TEXT PRIMARY KEY,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'member',   -- owner | approver | member
  teams         TEXT NOT NULL DEFAULT '[]',        -- approver: team ids they approve for ([] = all)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Wafeq through Hive: each run's gateway address, and the writes queued for approval
CREATE TABLE IF NOT EXISTS wafeq_tokens (
  token       TEXT PRIMARY KEY,
  run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wafeq_steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,                  -- order within the queue; "$s<seq>.id" refers to it
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  query         TEXT,
  body          TEXT,                              -- JSON, or NULL for file uploads
  file          TEXT,                              -- stored multipart body for uploads
  content_type  TEXT,
  summary       TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',    -- queued | sent | failed | skipped | discarded
  response      TEXT,
  approved_by   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_wafeq_steps_run ON wafeq_steps(run_id, status, seq);
-- What each agent should remember from people's corrections
CREATE TABLE IF NOT EXISTS agent_lessons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual',   -- manual | rejection | slack | task
  task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_by  TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Agents messaging each other
CREATE TABLE IF NOT EXISTS agent_dms (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent_id  INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  to_agent_id    INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  message        TEXT NOT NULL,
  reply          TEXT,
  status         TEXT NOT NULL DEFAULT 'asked',   -- asked | answered | failed
  run_id         INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at    TEXT
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS briefs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  data        TEXT NOT NULL,                     -- the brief as JSON (see brief.js)
  trigger     TEXT NOT NULL DEFAULT 'schedule',  -- schedule | manual
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint    TEXT NOT NULL UNIQUE,
  keys        TEXT NOT NULL,
  user        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
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

// ---------------------------------------------------------------- scheduled and repeating tasks
db.exec(`
-- Which company a task is for. Add more rows to add entities (no code change needed).
CREATE TABLE IF NOT EXISTS entities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A repeating task. Each instance is its own row in tasks (series_id, series_index); the next one is
-- created from these fields when the latest is done or its due date passes (see taskSchedule.js).
CREATE TABLE IF NOT EXISTS task_series (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  rule               TEXT NOT NULL,                 -- JSON, see recurrence.js
  anchor_due         TEXT NOT NULL,                 -- due date of instance number anchor_index
  anchor_index       INTEGER NOT NULL DEFAULT 1,
  ends_on            TEXT,                          -- no instance is due after this date
  start_offset_days  INTEGER,                       -- each instance starts this many days before it's due
  last_index         INTEGER NOT NULL DEFAULT 1,    -- the latest instance created
  title              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  done_definition    TEXT NOT NULL DEFAULT '',
  priority           TEXT NOT NULL DEFAULT 'medium',
  agent_id           INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  handoff_agent_id   INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  entity_id          INTEGER REFERENCES entities(id) ON DELETE SET NULL,
  remind_days        INTEGER,
  needs_approval     INTEGER NOT NULL DEFAULT 0,
  ended_at           TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
-- "Start from template" in the New task panel.
CREATE TABLE IF NOT EXISTS task_templates (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  title              TEXT NOT NULL DEFAULT '',
  description        TEXT NOT NULL DEFAULT '',
  done_definition    TEXT NOT NULL DEFAULT '',
  priority           TEXT NOT NULL DEFAULT 'medium',
  agent_id           INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  agent_name         TEXT,                          -- starter templates find their agent by name
  entity_id          INTEGER REFERENCES entities(id) ON DELETE SET NULL,
  rule               TEXT,                          -- JSON repeat rule, NULL = does not repeat
  start_offset_days  INTEGER,                       -- start this many days before the due date
  remind_days        INTEGER,
  needs_approval     INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Due-date reminders, shown at the top of the Inbox.
CREATE TABLE IF NOT EXISTS reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
addColumn('tasks', 'series_id', 'INTEGER REFERENCES task_series(id) ON DELETE SET NULL');
addColumn('tasks', 'series_index', 'INTEGER');
addColumn('tasks', 'start_on', 'TEXT'); // Dubai date the agent starts; NULL = when created
addColumn('tasks', 'entity_id', 'INTEGER REFERENCES entities(id) ON DELETE SET NULL'); // NULL = all / not entity-specific
addColumn('tasks', 'remind_days', 'INTEGER'); // remind this many days before due; NULL = no reminder
addColumn('tasks', 'reminded_at', 'TEXT');
addColumn('tasks', 'needs_approval', 'INTEGER NOT NULL DEFAULT 0'); // stop before submitting or paying anything
addColumn('tasks', 'approved_at', 'TEXT');
addColumn('tasks', 'approved_by', 'TEXT');
addColumn('tasks', 'done_definition', "TEXT NOT NULL DEFAULT ''");
db.exec(`
CREATE INDEX IF NOT EXISTS idx_tasks_series ON tasks(series_id, series_index);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled ON tasks(status, start_on);
`);

const ENTITIES = [
  ['sal', 'Presentail SAL (Lebanon)'],
  ['uae_dxb', 'Presentail Flowers Trading LLC – Dubai'],
  ['uae_auh', 'Presentail Flowers Trading LLC – Abu Dhabi'],
  ['uae', 'Presentail Flowers Trading LLC – UAE (Dubai + Abu Dhabi)'],
  ['ltd', 'Presentail Ltd (Cyprus)'],
];
ENTITIES.forEach(([code, name], i) => db.prepare('INSERT OR IGNORE INTO entities (code, name, sort) VALUES (?, ?, ?)').run(code, name, (i + 1) * 10));

// Starter templates, added once (deleting one later doesn't bring it back).
if (!db.prepare("SELECT 1 FROM app_meta WHERE key = 'starter_templates'").get()) {
  const entity = (code) => db.prepare('SELECT id FROM entities WHERE code = ?').get(code)?.id ?? null;
  const templates = [
    {
      name: 'UAE VAT return',
      title: 'UAE VAT return',
      entity: 'uae',
      rule: { freq: 'quarterly' },
      offset: 18,
      description: [
        'Prepare the UAE VAT return (VAT 201) for Presentail Flowers Trading LLC for the quarter that ended before the due date. Dubai and Abu Dhabi file ONE return under one TRN.',
        '',
        '1. Pull the quarter\'s sales invoices and bills from Wafeq. Check that every Talabat, Careem, Noon Food and Now Now month in the quarter is booked first; list any that are missing.',
        '2. Output VAT by emirate (place of supply): Dubai and Abu Dhabi separately, as on the return.',
        '3. Input VAT from bills; flag any bill without a valid tax invoice or TRN, and any reverse-charge (imported services).',
        '4. Tie the VAT accounts in Wafeq to the return figures and explain any difference.',
        '5. Draft the return box by box with a short workings file.',
      ].join('\n'),
      done: 'VAT 201 figures drafted box by box with workings saved to outputs, differences explained, summary sent to Adnan. Nothing filed.',
    },
    {
      name: 'Lebanon VAT return',
      title: 'Lebanon VAT return',
      entity: 'sal',
      rule: null,
      offset: null,
      description: [
        'Prepare the VAT return for Presentail SAL (Odoo company 2) for the period that ended before the due date. The filing frequency and due date are set on this task.',
        '',
        '1. Check every sales invoice in the period carries 11% VAT (including intercompany invoices to Presentail LTD) and every bill with VAT has a valid invoice.',
        '2. Total output VAT and input VAT from Odoo, per the Lebanese return layout, in LBP and USD where the return needs it.',
        '3. Tie the VAT accounts to the totals and explain any difference.',
        '4. Draft the return with a short workings file.',
      ].join('\n'),
      done: 'Return figures drafted with workings saved to outputs, differences explained, summary sent to Adnan. Nothing filed or paid.',
    },
    {
      name: 'Cyprus VAT return',
      title: 'Cyprus VAT return',
      entity: 'ltd',
      rule: null,
      offset: null,
      description: [
        'Prepare the VAT return for Presentail Ltd (Odoo company 1, EUR books) for the period that ended before the due date. The filing frequency and due date are set on this task.',
        '',
        '1. Output VAT on sales; input VAT on bills; reverse charge on services bought from abroad (including the intercompany bills from Presentail SAL, booked at 0%).',
        '2. Check every bill in the period has its invoice attached.',
        '3. Tie the VAT accounts to the totals and explain any difference.',
        '4. Draft the return box by box with a short workings file.',
      ].join('\n'),
      done: 'Return figures drafted box by box with workings saved to outputs, differences explained, summary sent to Adnan. Nothing filed or paid.',
    },
    {
      name: 'Intercompany SAL→LTD check',
      title: 'Intercompany SAL→LTD check',
      entity: null,
      rule: { freq: 'monthly' },
      offset: 5,
      description: [
        'Check last month\'s intercompany charges between Presentail SAL (Odoo company 2) and Presentail LTD (Odoo company 1).',
        '',
        '1. Every SAL sales invoice to Presentail LTD is posted at 11% VAT.',
        '2. Each one has a matching vendor bill in LTD for the same amount and date, at 0% VAT.',
        '3. Each LTD bill has the SAL invoice PDF attached.',
        '',
        'List anything missing or mismatched, with the invoice and bill numbers. Do not fix anything until Adnan approves.',
      ].join('\n'),
      done: 'A list of every SAL→LTD pair with ✓ or what is wrong, sent to Adnan. No changes made without approval.',
    },
  ];
  const ins = db.prepare(
    `INSERT INTO task_templates (name, title, description, done_definition, priority, agent_name, entity_id, rule, start_offset_days, remind_days, needs_approval)
     VALUES (?, ?, ?, ?, 'high', 'Ziad Karam', ?, ?, ?, 14, 1)`,
  );
  for (const t of templates) ins.run(t.name, t.title, t.description, t.done, t.entity ? entity(t.entity) : null, t.rule ? JSON.stringify(t.rule) : null, t.offset);
  db.prepare("INSERT INTO app_meta (key, value) VALUES ('starter_templates', '1')").run();
}
