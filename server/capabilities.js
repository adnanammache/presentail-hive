// What agents can be given: skills (procedures) and integrations (systems they can reach).
//
// Presentail skills live in the repo under agent-skills/<key>/SKILL.md (plus scripts/references),
// so they're version-controlled and reviewed like code. Hive uploads them to Anthropic when an
// agent that uses them is synced. Anthropic's pre-built document skills are available too.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { get } from './db.js';
import { gmailConfigured, googleConfigured } from './google.js';

export const SKILLS_DIR = join(process.cwd(), 'agent-skills');

/** Systems an agent can reach. The secret comes from Hive's environment (Railway variables). */
export const INTEGRATIONS = {
  odoo: {
    name: 'Odoo',
    description: 'Presentail SAL, LTD and UAE books. Reads run freely; changes wait for your approval in Hive unless the agent is set to Never ask.',
    env: 'ODOO_API_KEY',
    hosts: [], // Hive makes the calls itself; the agent's sandbox never talks to Odoo
    via: 'hive',
  },
  wafeq: {
    name: 'Wafeq',
    description: 'UAE accounting: bills, sales invoices, payments and attachments. Reads run freely; changes wait for your approval in Hive unless the agent is set to Never ask.',
    env: 'WAFEQ_API_KEY',
    hosts: [], // through Hive's gateway (wafeq.js): the key never enters the agent's sandbox
    via: 'hive',
  },
  // Drive, Gmail and Slack: read-only through Hive (connectors.js). Files the agent fetches land in
  // its workspace; posting in Slack and attaching a file to Odoo wait for approval.
  drive: {
    name: 'Google Drive',
    description: 'Search and read Drive files and Google Sheets, fetch files into the workspace, attach them to Odoo. Read-only: sees what is shared with Hive\'s Google account.',
    env: 'GOOGLE_SERVICE_ACCOUNT_JSON',
    ready: googleConfigured,
    hosts: [],
    via: 'hive',
  },
  gmail: {
    name: 'Gmail',
    description: 'Search and read the mailboxes in GOOGLE_GMAIL_MAILBOXES and fetch attachments (invoices, statements). Read-only: agents cannot send email.',
    env: 'GOOGLE_GMAIL_MAILBOXES',
    ready: gmailConfigured,
    hosts: [],
    via: 'hive',
  },
  slack: {
    name: 'Slack',
    description: 'Read the channels and threads its bot is invited to and fetch the files posted there. Posting a message waits for your approval unless the agent is set to Never ask.',
    env: 'SLACK_BOT_TOKEN',
    // Agents with their own Slack bot can read without the shared Hive app.
    ready: () => Boolean(process.env.SLACK_BOT_TOKEN) || Boolean(get('SELECT 1 FROM agent_slack_apps WHERE bot_token IS NOT NULL LIMIT 1')),
    hosts: [],
    via: 'hive',
  },
};

/** Is this integration set up on the server? */
export const integrationReady = (key) => {
  const i = INTEGRATIONS[key];
  if (!i) return false;
  try {
    return Boolean(i.ready ? i.ready() : process.env[i.env]);
  } catch {
    return false;
  }
};

export const integrationList = () =>
  Object.entries(INTEGRATIONS).map(([key, i]) => ({ key, name: i.name, description: i.description, env: i.env, configured: integrationReady(key) }));

const BUILTIN_SKILLS = [
  { key: 'anthropic:pdf', name: 'PDF', description: 'Read, extract and create PDF files (Anthropic).', source: 'anthropic', skill_id: 'pdf' },
  { key: 'anthropic:xlsx', name: 'Excel', description: 'Read, clean and build spreadsheets (Anthropic).', source: 'anthropic', skill_id: 'xlsx' },
  { key: 'anthropic:docx', name: 'Word', description: 'Read and write Word documents (Anthropic).', source: 'anthropic', skill_id: 'docx' },
];

function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === '>-' || value === '>' || value === '|') {
      const block = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(' ');
    }
    out[kv[1]] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === '__pycache__' || name.startsWith('.')) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** All files of a local skill, with paths relative to agent-skills/ (e.g. "talabat-month-end/SKILL.md"). */
export function skillFiles(key) {
  const dir = join(SKILLS_DIR, key);
  return walk(dir)
    .sort()
    .map((full) => ({ path: relative(SKILLS_DIR, full), content: readFileSync(full) }));
}

export function skillHash(key) {
  const h = createHash('sha256');
  for (const f of skillFiles(key)) h.update(f.path).update('\0').update(f.content);
  return h.digest('hex').slice(0, 16);
}

export function skillLibrary() {
  const local = existsSync(SKILLS_DIR)
    ? readdirSync(SKILLS_DIR)
        .filter((k) => existsSync(join(SKILLS_DIR, k, 'SKILL.md')))
        .map((key) => {
          const fm = frontmatter(readFileSync(join(SKILLS_DIR, key, 'SKILL.md'), 'utf8'));
          const description = (fm.description || '').replace(/\s+/g, ' ');
          return {
            key,
            name: key.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
            description: description.split(/(?<=\.)\s/)[0] || description,
            source: 'presentail',
            integrations: [
              /wafeq/i.test(description) && 'wafeq',
              /odoo/i.test(description) && 'odoo',
              /google drive|google sheet|\bdrive\b/i.test(description) && 'drive',
              /gmail/i.test(description) && 'gmail',
              /slack/i.test(description) && 'slack',
            ].filter(Boolean),
          };
        })
    : [];
  return [...local, ...BUILTIN_SKILLS.map((s) => ({ ...s, integrations: [] }))];
}

export const parseList = (json) => {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
