// Sample data so the dashboard isn't empty on first launch. Edit or delete freely.
import { get, run, newToken } from './db.js';

const AGENTS = [
  {
    name: 'Ledger',
    role: 'Month-end bookkeeping (Wafeq)',
    description: 'Processes delivery-platform statements — Talabat, Careem, Noon Food, Now Now — into Wafeq bills and sales invoices.',
    platform: 'claude',
    model: 'claude-opus-5',
    color: '#10b981',
    status: 'idle',
    system_prompt:
      "You are Ledger, Presentail's bookkeeping agent. You handle month-end for delivery platforms in Wafeq. Be precise with amounts and always list what you posted and what still needs a human.",
  },
  {
    name: 'Odoo Operator',
    role: 'Odoo reconciliation via Make',
    description: 'Make scenarios that reconcile BLOM, book Toters fee bills and intercompany SAL ⇄ LTD invoices in Odoo.',
    platform: 'make',
    color: '#8b5cf6',
    status: 'active',
  },
  {
    name: 'Morning Briefer',
    role: 'Daily brief & inbox triage',
    description: 'Summarises calendar, Slack and email every weekday morning.',
    platform: 'claude',
    model: 'claude-opus-5',
    color: '#f59e0b',
    status: 'idle',
    system_prompt: 'You are the Morning Briefer. Produce short, skimmable daily briefs: meetings, urgent threads, decisions needed.',
  },
  {
    name: 'Replit Builder',
    role: 'Internal tools & prototypes',
    description: 'Builds and ships small internal apps on Replit.',
    platform: 'replit',
    color: '#3b82f6',
    status: 'paused',
  },
];

const WORKFLOWS = [
  { agent: 'Ledger', name: 'Talabat month-end', schedule: '0 9 2 * *', timezone: 'Asia/Dubai', description: 'Fee bills + per-branch sales invoices for last month.', instructions: 'Run Talabat month-end in Wafeq for the previous month: itemised fee bills and one paid sales invoice per branch. Report totals per branch.' },
  { agent: 'Ledger', name: 'Careem month-end', schedule: '0 10 2 * *', timezone: 'Asia/Dubai', description: 'Commission bills and cash sales invoices.', instructions: 'Process last month’s Careem tax invoices into Wafeq commission bills and cash sales invoices. Dedupe against what is already posted.' },
  { agent: 'Ledger', name: 'Noon Food month-end', schedule: '0 11 2 * *', timezone: 'Asia/Dubai', description: 'Fee bills and per-order sales invoices.', instructions: 'Process Noon Food fee invoices and order statements for the previous month in Wafeq.' },
  { agent: 'Odoo Operator', name: 'BLOM reconciliation', schedule: '0 9 3 * *', timezone: 'Asia/Beirut', description: 'Import eBLOM statements and reconcile in Odoo.', instructions: 'Import last month’s BLOM statements into Odoo, pair the POS sweeps and report any drift.' },
  { agent: 'Odoo Operator', name: 'Toters fee bills', schedule: '0 12 3 * *', timezone: 'Asia/Beirut', description: 'Book Toters per-store fee bills and settle via the wallet journal.', instructions: 'Book last month’s Toters fee bills in Odoo SAL and settle them through the Toters Wallet journal.' },
  { agent: 'Morning Briefer', name: 'Morning brief', schedule: '45 7 * * 1-5', timezone: 'Asia/Dubai', description: 'Weekday morning summary.', instructions: 'Prepare today’s morning brief: meetings, urgent emails and Slack threads, decisions waiting on Adnan.' },
];

const TASKS = [
  { agent: 'Ledger', title: 'Reconcile August Talabat SOA', status: 'review', priority: 'high', result: 'Posted 4 fee bills and 6 branch sales invoices. Abu Dhabi branch earnings differ from SOA by AED 12.40 — needs a look.' },
  { agent: 'Ledger', title: 'Backfill Now Now July orders', status: 'in_progress', priority: 'medium' },
  { agent: 'Odoo Operator', title: 'Fix duplicated BLOM USD lines (June)', status: 'blocked', priority: 'urgent', result: 'Waiting for the June eBLOM XLS export.' },
  { agent: 'Odoo Operator', title: 'Intercompany SAL ⇄ LTD for September', status: 'todo', priority: 'medium' },
  { agent: 'Replit Builder', title: 'Prototype supplier-statement upload page', status: 'backlog', priority: 'low' },
  { agent: 'Morning Briefer', title: 'Add Asana overdue tasks to the brief', status: 'done', priority: 'low' },
];

export function seed() {
  const ids = {};
  for (const a of AGENTS) {
    const { lastInsertRowid } = run(
      `INSERT INTO agents (name, role, description, platform, status, model, system_prompt, color, api_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.name, a.role, a.description, a.platform, a.status, a.model ?? '', a.system_prompt ?? '', a.color, newToken(),
    );
    ids[a.name] = Number(lastInsertRowid);
  }
  for (const w of WORKFLOWS) {
    run(
      'INSERT INTO workflows (name, description, agent_id, schedule, timezone, instructions) VALUES (?, ?, ?, ?, ?, ?)',
      w.name, w.description, ids[w.agent], w.schedule, w.timezone, w.instructions,
    );
  }
  for (const t of TASKS) {
    run(
      `INSERT INTO tasks (title, status, priority, agent_id, result, completed_at) VALUES (?, ?, ?, ?, ?, ${t.status === 'done' ? "datetime('now')" : 'NULL'})`,
      t.title, t.status, t.priority, ids[t.agent], t.result ?? '',
    );
  }
  run("INSERT INTO messages (agent_id, sender, body) VALUES (?, 'user', ?)", ids.Ledger, 'Can you check why the Abu Dhabi Talabat numbers are off?');
  run(
    "INSERT INTO messages (agent_id, sender, body) VALUES (?, 'agent', ?)",
    ids.Ledger,
    'The Balance Summary for Abu Dhabi includes a AED 12.40 refund dated 1 September. It belongs to August on the SOA but September in the PDF. Want me to book it in August?',
  );
  run("INSERT INTO activity (agent_id, kind, text) VALUES (NULL, 'system', 'Presentail Hive initialised with sample data')");
}

export function seedIfEmpty() {
  if (process.env.NO_SEED) return;
  if (get('SELECT COUNT(*) n FROM agents').n === 0) seed();
}

if (process.argv[1]?.endsWith('seed.js') && process.argv.includes('--force')) {
  for (const t of ['activity', 'messages', 'workflow_runs', 'tasks', 'workflows', 'agents']) run(`DELETE FROM ${t}`);
  seed();
  console.log('Seeded sample data.');
}
