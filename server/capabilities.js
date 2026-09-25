// What agents can be given: skills (procedures) and integrations (systems they can reach).
//
// Presentail skills live in the repo under agent-skills/<key>/SKILL.md (plus scripts/references),
// so they're version-controlled and reviewed like code. Hive uploads them to Anthropic when an
// agent that uses them is synced. Anthropic's pre-built document skills are available too.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const SKILLS_DIR = join(process.cwd(), 'agent-skills');

/** Systems an agent can reach. The secret comes from Hive's environment (Railway variables). */
export const INTEGRATIONS = {
  odoo: {
    name: 'Odoo',
    description: 'Presentail SAL, LTD and UAE books. Reads run freely; every change waits for your approval in Hive.',
    env: 'ODOO_API_KEY',
    hosts: [], // Hive makes the calls itself; the agent's sandbox never talks to Odoo
    via: 'hive',
  },
  wafeq: {
    name: 'Wafeq',
    description: 'UAE accounting: bills, sales invoices, payments and attachments.',
    env: 'WAFEQ_API_KEY',
    hosts: ['api.wafeq.com'],
  },
};

export const integrationList = () =>
  Object.entries(INTEGRATIONS).map(([key, i]) => ({ key, name: i.name, description: i.description, env: i.env, configured: Boolean(process.env[i.env]) }));

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
            integrations: [/wafeq/i.test(description) && 'wafeq', /odoo/i.test(description) && 'odoo'].filter(Boolean),
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
