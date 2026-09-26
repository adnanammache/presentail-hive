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
// Several processes may share this file (e.g. scheduler workers): wait for a lock rather than fail.
db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

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
  status       TEXT NOT NULL DEFAULT 'ready',     -- backlog | ready | scheduled | in_progress | review | waiting_approval | done (see below)
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
CREATE INDEX IF NOT EXISTS idx_messages_agent_time ON messages(agent_id, created_at);
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

-- Files and voice notes sent in an agent's chat. message_id is set once the message is sent.
CREATE TABLE IF NOT EXISTS chat_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  filename    TEXT NOT NULL,
  path        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mime        TEXT,
  voice       INTEGER NOT NULL DEFAULT 0,
  anthropic_file_id TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

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

// ---------------------------------------------------------------- projects, shared ownership, drafts
// Workspace → Project → Task. A task has one accountable assignee: a person (assignee_email, a
// row in users) or an AI agent (agent_id), never both. Stage (status) and blocking are separate.
db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  owner_email  TEXT,                                -- the accountable person (users.email)
  due_date     TEXT,
  health       TEXT,                                -- NULL (not set) | on_track | at_risk | off_track, set by a person
  status       TEXT NOT NULL DEFAULT 'active',      -- active | archived
  color        TEXT NOT NULL DEFAULT '#f59e0b',
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at  TEXT
);
-- People (member_ref = email) and agents (member_ref = agent id) on a project. Being a member
-- grants no tool access to an agent and never starts it.
CREATE TABLE IF NOT EXISTS project_members (
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_type  TEXT NOT NULL,                       -- user | agent
  member_ref   TEXT NOT NULL,
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, member_type, member_ref)
);
CREATE TABLE IF NOT EXISTS project_favorites (
  user_email   TEXT NOT NULL,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_email, project_id)
);
-- Reference files and links for a project ("Project resources").
CREATE TABLE IF NOT EXISTS project_resources (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                       -- file | link
  label        TEXT NOT NULL,
  url          TEXT,
  path         TEXT,
  size         INTEGER,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The New task composer's draft: one per person, never a task until submitted.
CREATE TABLE IF NOT EXISTS task_drafts (
  user_email   TEXT PRIMARY KEY,
  data         TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS draft_files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email   TEXT NOT NULL,
  filename     TEXT NOT NULL,
  path         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Links on a task: references given with it, and deliverables it produced.
CREATE TABLE IF NOT EXISTS task_links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'reference',   -- reference | deliverable
  url          TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS task_comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_type  TEXT NOT NULL,                       -- user | agent
  author_ref   TEXT NOT NULL,
  author_name  TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A task's history: created, assigned, moved, blocked, started, failed, approved…
CREATE TABLE IF NOT EXISTS task_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  text         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, id);
`);
addColumn('tasks', 'project_id', 'INTEGER REFERENCES projects(id) ON DELETE SET NULL');
addColumn('tasks', 'assignee_email', 'TEXT'); // a person; agent_id is the agent. At most one is set.
addColumn('tasks', 'reviewer_email', 'TEXT'); // a person who reviews it (handoff_agent_id is an agent reviewer)
addColumn('tasks', 'created_by', 'TEXT');
addColumn('tasks', 'blocked_kind', 'TEXT'); // NULL | info | approval | failed — separate from the stage
addColumn('tasks', 'blocked_reason', 'TEXT');
addColumn('tasks', 'blocked_owner', 'TEXT'); // who needs to resolve it, in words
addColumn('tasks', 'blocked_at', 'TEXT');
addColumn('tasks', 'client_key', 'TEXT'); // the composer's submission key: the same submission never makes two tasks
addColumn('tasks', 'start_key', 'TEXT'); // the last successful "start" request: retries never start twice
addColumn('tasks', 'progress_done', 'INTEGER'); // measurable progress, only when an agent reports it
addColumn('tasks', 'progress_total', 'INTEGER');
addColumn('tasks', 'progress_label', 'TEXT');
addColumn('reminders', 'user_email', 'TEXT'); // NULL = for everyone (due-date reminders); else that person's notice
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_key ON tasks(client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_email);
`);

// Stages are Backlog → Ready → In progress → Needs review → Done; blocking is recorded apart.
// One-time migration (documented in DEPLOY.md):
//   "todo" → "ready".
//   "blocked" → the blocker is kept (reason = the task's last result; "failed" when it says it could
//   not start or run, else "waiting for information"); the stage becomes "in_progress" if the task
//   ever had a run or a workflow run, else "ready". No history is invented.
export function migrateStages() {
  if (db.prepare("SELECT 1 FROM app_meta WHERE key = 'stages_v2'").get()) return;
  db.exec('BEGIN');
  db.exec("UPDATE tasks SET status = 'ready' WHERE status = 'todo'");
  db.exec(`
    UPDATE tasks SET
      blocked_kind = CASE WHEN result LIKE 'Could not start%' OR result LIKE 'Could not run%' THEN 'failed' ELSE 'info' END,
      blocked_reason = NULLIF(result, ''),
      blocked_at = updated_at,
      status = CASE WHEN EXISTS (SELECT 1 FROM runs r WHERE r.task_id = tasks.id)
                     OR EXISTS (SELECT 1 FROM workflow_runs w WHERE w.task_id = tasks.id) THEN 'in_progress' ELSE 'ready' END
    WHERE status = 'blocked'`);
  db.prepare("INSERT INTO app_meta (key, value) VALUES ('stages_v2', '1')").run();
  db.exec('COMMIT');
}
migrateStages();

// Older rows and callers may still say "todo" (the column's old default on existing databases).
db.exec(`CREATE TRIGGER IF NOT EXISTS tasks_todo_is_ready AFTER INSERT ON tasks WHEN NEW.status = 'todo'
  BEGIN UPDATE tasks SET status = 'ready' WHERE id = NEW.id; END;`);
// Repeating tasks carry the new ownership fields to each instance.
addColumn('task_series', 'project_id', 'INTEGER REFERENCES projects(id) ON DELETE SET NULL');
addColumn('task_series', 'assignee_email', 'TEXT');
addColumn('task_series', 'reviewer_email', 'TEXT');
addColumn('task_series', 'created_by', 'TEXT');
addColumn('task_series', 'auto_start', 'INTEGER NOT NULL DEFAULT 1'); // 0: the task was saved without starting, so repeats don't start either

// ---------------------------------------------------------------- people: profiles, teams, invitations
// A person's profile lives on their users row (one workspace). Workspace role (users.role), team
// membership (team_members), team role (lead/member), job title and manager are separate things:
// none of them grants another.
addColumn('users', 'title', "TEXT NOT NULL DEFAULT ''"); // job title: descriptive only, grants nothing
addColumn('users', 'bio', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'timezone', 'TEXT');
addColumn('users', 'photo_source', 'TEXT'); // NULL (account photo if any) | upload | provider | none (removed: initials)
addColumn('users', 'photo_type', 'TEXT');
addColumn('users', 'photo_version', 'INTEGER');
addColumn('users', 'provider_photo', 'TEXT'); // the sign-in provider's picture, refreshed at sign-in
addColumn('users', 'status', "TEXT NOT NULL DEFAULT 'active'"); // active | deactivated
addColumn('users', 'deactivated_at', 'TEXT');
addColumn('users', 'manager_email', 'TEXT'); // who they report to (optional)
addColumn('users', 'profile_updated_at', 'TEXT');
addColumn('task_events', 'actor_ref', 'TEXT'); // "user:<email>" or "agent:<id>", for avatars in history
db.exec(`
-- People on teams (many-to-many). Agents keep their one team in agents.team_id.
CREATE TABLE IF NOT EXISTS team_members (
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_email  TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',   -- lead | member (a lead manages their team's people, nothing else)
  added_by    TEXT,
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (team_id, user_email)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_email);
-- Invitations to join the workspace. The token is only stored hashed.
CREATE TABLE IF NOT EXISTS invitations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  teams         TEXT NOT NULL DEFAULT '[]',     -- team ids to join on acceptance
  title         TEXT NOT NULL DEFAULT '',
  manager_email TEXT,
  token_hash    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | revoked
  invited_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  sent_at       TEXT,
  send_error    TEXT,
  accepted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email, status);
`);

// ---------------------------------------------------------------- conversations with agents
// A conversation (chat) is one thread with one agent. Its origin is where replies go: "chat:<id>" for
// conversations started in Hive, "slack:<channel>:<ts>" for a Slack thread, "hive" for the single
// thread every agent had before conversations existed. Each managed chat run is keyed by origin, so
// every conversation has its own Claude session.
//   visibility: private (whoever started it, plus workspace owners) | shared (everyone who can see
//   the agent). Threads from before conversations existed were visible to everyone, so they stay shared.
db.exec(`
CREATE TABLE IF NOT EXISTS chats (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  origin          TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  visibility      TEXT NOT NULL DEFAULT 'private',
  created_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT,
  UNIQUE (agent_id, origin)
);
`);
addColumn('messages', 'chat_id', 'INTEGER REFERENCES chats(id) ON DELETE CASCADE');
addColumn('tasks', 'source_chat_id', 'INTEGER REFERENCES chats(id) ON DELETE SET NULL'); // the conversation a task was created from
addColumn('tasks', 'source_message_id', 'INTEGER REFERENCES messages(id) ON DELETE SET NULL');
addColumn('agent_lessons', 'title', "TEXT NOT NULL DEFAULT ''");
addColumn('agent_lessons', 'chat_id', 'INTEGER REFERENCES chats(id) ON DELETE SET NULL');
addColumn('agent_lessons', 'message_id', 'INTEGER REFERENCES messages(id) ON DELETE SET NULL');
db.exec(`
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_tasks_source_chat ON tasks(source_chat_id);
`);

/** Give every message from before conversations a conversation (idempotent: only rows without one). */
export function migrateChats() {
  const groups = db
    .prepare(`SELECT agent_id, COALESCE(json_extract(meta, '$.origin'), 'hive') AS origin, MIN(id) AS first_id, MAX(created_at) AS last_at
              FROM messages WHERE chat_id IS NULL GROUP BY agent_id, origin`)
    .all();
  if (!groups.length) return;
  db.exec('BEGIN');
  for (const g of groups) {
    const firstUser = db
      .prepare(`SELECT body, meta FROM messages WHERE agent_id = ? AND sender = 'user' AND COALESCE(json_extract(meta, '$.origin'), 'hive') = ? ORDER BY id LIMIT 1`)
      .get(g.agent_id, g.origin);
    const firstLine = String(firstUser?.body ?? '').split('\n')[0].trim();
    const title = (firstLine ? (firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine) : 'Earlier conversation').replace(/^/, g.origin.startsWith('slack:') ? 'Slack: ' : '');
    let createdBy = null;
    try {
      createdBy = firstUser?.meta ? JSON.parse(firstUser.meta).email ?? null : null;
    } catch {
      /* old rows */
    }
    db.prepare(
      `INSERT INTO chats (agent_id, origin, title, visibility, created_by, created_at, last_message_at) VALUES (?, ?, ?, 'shared', ?, (SELECT created_at FROM messages WHERE id = ?), ?)
       ON CONFLICT(agent_id, origin) DO UPDATE SET last_message_at = MAX(COALESCE(chats.last_message_at, ''), excluded.last_message_at)`,
    ).run(g.agent_id, g.origin, title, createdBy, g.first_id, g.last_at);
    const chat = db.prepare('SELECT id FROM chats WHERE agent_id = ? AND origin = ?').get(g.agent_id, g.origin);
    db.prepare(`UPDATE messages SET chat_id = ? WHERE agent_id = ? AND chat_id IS NULL AND COALESCE(json_extract(meta, '$.origin'), 'hive') = ?`).run(chat.id, g.agent_id, g.origin);
  }
  db.exec('COMMIT');
}
migrateChats();

// ---------------------------------------------------------------- recurring schedules (see schedules.js)
// A workflow is a recurring schedule: who gets the work (an agent or a person), when (a structured
// rule in its own time zone), what each task says, and the policies for missed and overlapping runs.
// Each occurrence is a workflow_runs row, unique per schedule and time, linked to the task it made.
addColumn('workflows', 'rule', 'TEXT'); // canonical JSON rule (recurring.js); NULL on old rows until migrated
addColumn('workflows', 'expected_result', "TEXT NOT NULL DEFAULT ''");
addColumn('workflows', 'project_id', 'INTEGER REFERENCES projects(id) ON DELETE SET NULL');
addColumn('workflows', 'assignee_email', 'TEXT'); // a person; agent_id is an agent. Exactly one is set.
addColumn('workflows', 'mode', "TEXT NOT NULL DEFAULT 'create_and_start'"); // create_and_start | create_only
addColumn('workflows', 'starts_on', 'TEXT'); // local date (schedule's time zone), inclusive
addColumn('workflows', 'ends_on', 'TEXT'); // local date, inclusive; NULL = no end
addColumn('workflows', 'max_occurrences', 'INTEGER'); // NULL = no limit
addColumn('workflows', 'occurrence_count', 'INTEGER NOT NULL DEFAULT 0'); // scheduled occurrences so far (created or skipped)
addColumn('workflows', 'deadline_rule', 'TEXT'); // JSON, see recurring.js
addColumn('workflows', 'period_rule', 'TEXT'); // JSON reporting-period rule
addColumn('workflows', 'missed_policy', "TEXT NOT NULL DEFAULT 'run_latest'"); // run_latest | skip_all
addColumn('workflows', 'overlap_policy', 'TEXT'); // skip_if_running | skip_if_open | always_create
addColumn('workflows', 'status', 'TEXT'); // active | paused | ended | error
addColumn('workflows', 'status_reason', 'TEXT');
addColumn('workflows', 'version', 'INTEGER NOT NULL DEFAULT 1');
addColumn('workflows', 'next_run_at', 'TEXT'); // ISO instant of the next scheduled occurrence
addColumn('workflows', 'priority', "TEXT NOT NULL DEFAULT 'medium'");
addColumn('workflows', 'needs_approval', 'INTEGER NOT NULL DEFAULT 0');
addColumn('workflows', 'remind_days', 'INTEGER');
addColumn('workflows', 'created_by_type', 'TEXT'); // user | agent
addColumn('workflows', 'created_by_ref', 'TEXT'); // email or agent id
addColumn('workflows', 'created_by_name', 'TEXT');
addColumn('workflows', 'authorized_by', 'TEXT'); // the person whose instruction permits this schedule
addColumn('workflows', 'authorization', 'TEXT'); // JSON provenance: how and where it was asked for
addColumn('workflows', 'client_key', 'TEXT'); // idempotency key of the request that created it
addColumn('workflows', 'updated_at', 'TEXT');
addColumn('workflows', 'ended_at', 'TEXT');
addColumn('workflow_runs', 'scheduled_for', 'TEXT'); // the occurrence's instant (ISO)
addColumn('workflow_runs', 'occurrence_key', 'TEXT'); // "<schedule>:<instant>" or "<schedule>:manual:<key>"
addColumn('workflow_runs', 'state', 'TEXT'); // pending | created | skipped | failed (the occurrence itself)
addColumn('workflow_runs', 'dispatch_status', 'TEXT'); // none | pending | retrying | dispatched | failed
addColumn('workflow_runs', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
addColumn('workflow_runs', 'next_attempt_at', 'TEXT');
addColumn('workflow_runs', 'last_error', 'TEXT');
addColumn('workflow_runs', 'skip_reason', 'TEXT');
addColumn('workflow_runs', 'period_start', 'TEXT');
addColumn('workflow_runs', 'period_end', 'TEXT');
addColumn('workflow_runs', 'due_date', 'TEXT');
addColumn('workflow_runs', 'schedule_version', 'INTEGER');
addColumn('workflow_runs', 'snapshot', 'TEXT'); // the schedule's task template when this occurrence was due
addColumn('workflow_runs', 'lease_until', 'TEXT'); // a worker is delivering it until then
addColumn('workflow_runs', 'requested_by', 'TEXT'); // manual runs: who asked
addColumn('tasks', 'occurrence_id', 'INTEGER'); // the workflow_runs row that made this task
addColumn('tasks', 'scheduled_for', 'TEXT');
addColumn('tasks', 'period_start', 'TEXT'); // the reporting period this task covers
addColumn('tasks', 'period_end', 'TEXT');
addColumn('runs', 'requested_by', 'TEXT'); // chats: the person whose message the agent is answering now
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_occurrence ON workflow_runs(occurrence_key) WHERE occurrence_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_client_key ON workflows(client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflows_due ON workflows(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_runs_delivery ON workflow_runs(state, dispatch_status);
`);
// Older workflows (and rows older code still inserts, e.g. the seed): their cron expression becomes a
// "cron" rule and enabled becomes the status. They were created by owners before authorization was
// recorded, so until an owner edits, runs or resumes one, they count as authorized by the owners.
export function normalizeLegacyWorkflows() {
  db.exec(`UPDATE workflows SET rule = json_object('freq', 'cron', 'expr', schedule) WHERE rule IS NULL`);
  db.exec(`UPDATE workflows SET status = CASE WHEN enabled = 1 THEN 'active' ELSE 'paused' END WHERE status IS NULL`);
  db.exec(`UPDATE workflows SET overlap_policy = CASE WHEN assignee_email IS NOT NULL THEN 'always_create' ELSE 'skip_if_running' END WHERE overlap_policy IS NULL`);
  db.exec(`UPDATE workflow_runs SET state = 'created' WHERE state IS NULL`);
}
normalizeLegacyWorkflows();
db.exec(`
-- What happened to a schedule and who did it: created, edited, paused, suspended, failed dispatches…
CREATE TABLE IF NOT EXISTS schedule_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id  INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  actor        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  text         TEXT NOT NULL,
  data         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_schedule_events ON schedule_events(workflow_id, id);
`);
