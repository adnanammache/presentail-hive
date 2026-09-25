// Presentail's org chart: the teams and titles Hive starts from.
//
// Applied once per database (tracked in app_meta), so anything you rename, move or delete
// in the UI afterwards stays that way. Existing template agents are slotted into their
// matching title instead of being duplicated.
import { db, get, run, newToken } from './db.js';

export const ORG_CHART_VERSION = 'org-chart-v1';

export const ORG = [
  {
    team: 'Accounting',
    color: '#10b981',
    description: 'Bookkeeping, reconciliations, audit and tax across Presentail SAL (Lebanon), Presentail LTD (Cyprus) and the UAE.',
    agents: [
      {
        name: 'Odoo Operator', // existing template agent
        title: 'Lebanon Accountant',
        description: 'Presentail SAL books in Odoo (LBP/USD): BLOM bank feeds and POS sweeps, Toters fee bills and wallet settlements, supplier statement reconciliations.',
      },
      {
        name: 'Ledger', // existing template agent
        title: 'UAE Accountant',
        description: 'UAE books in Wafeq: Talabat, Careem, Noon Food and Now Now month-end, including fee bills, sales invoices and Dubai/Abu Dhabi place of supply.',
      },
      {
        name: 'Kyros',
        title: 'Cyprus Accountant',
        description: 'Presentail LTD books in Odoo (EUR): supplier invoices and bills, Revolut reconciliation, and the LTD side of intercompany charges with SAL.',
      },
      {
        name: 'Vera',
        title: 'Auditor',
        description: "Reviews the accountants' work before it reaches you: duplicates, missing documents, unreconciled lines, and balances that don't match statements.",
      },
      {
        name: 'Levy',
        title: 'Tax Specialist',
        description: 'VAT and tax across entities: UAE VAT returns, Lebanon 11% VAT, Cyprus filings. Tracks deadlines and checks tax treatment on invoices.',
      },
    ],
  },
  {
    team: 'Procurement',
    color: '#f97316',
    description: 'Buying for the business: purchase requests, supplier selection and supplier relationships.',
    agents: [
      {
        name: 'Scout',
        title: 'Procurement Manager',
        description: 'Handles purchase requests: gathers quotes, compares prices and terms, and prepares orders for approval.',
      },
      {
        name: 'Bridge',
        title: 'Supplier Relations',
        description: 'Keeps suppliers in good standing: chases statements, resolves disputes and follows up on payments and deliveries.',
      },
    ],
  },
  {
    team: 'Project Management',
    color: '#6366f1',
    description: 'Keeps every project moving: status, owners, deadlines and weekly reporting.',
    agents: [
      {
        name: 'Atlas',
        title: 'Project Manager',
        description: 'Knows the status of every project, flags risks and slipping deadlines, and writes the weekly project report.',
      },
      {
        name: 'Relay',
        title: 'Project Coordinator',
        description: 'Chases owners for updates, keeps Asana current and makes sure action items from meetings get done.',
      },
    ],
  },
  {
    team: 'Design',
    color: '#ec4899',
    description: "Presentail's look and feel: brand, menus and packaging.",
    agents: [
      {
        name: 'Iris',
        title: 'Brand Designer',
        description: 'Guards the brand: visual identity, social and marketing assets, and consistency across every channel.',
      },
      {
        name: 'Sage',
        title: 'Menu Designer',
        description: 'Designs and updates menus for branches and delivery platforms, keeping items, prices and photos consistent.',
      },
      {
        name: 'Fold',
        title: 'Packaging Designer',
        description: 'Packaging and labels: designs, print-ready files and supplier specs.',
      },
    ],
  },
  {
    team: 'Executive Office',
    color: '#f59e0b',
    description: 'Supports leadership: daily briefs, inbox triage and follow-ups.',
    agents: [
      {
        name: 'Morning Briefer', // existing template agent
        title: 'Chief of Staff',
        description: 'Morning brief every weekday (meetings, urgent emails and Slack threads, decisions waiting on you), plus inbox triage and follow-ups.',
      },
    ],
  },
];

/** Create the org chart's teams and agents. Runs once per database; returns true if it ran. */
export function applyOrgChart() {
  if (get('SELECT value FROM app_meta WHERE key = ?', ORG_CHART_VERSION)) return false;

  db.exec('BEGIN');
  try {
    for (const t of ORG) {
      const team =
        get('SELECT id FROM teams WHERE name = ?', t.team) ??
        { id: Number(run('INSERT INTO teams (name, description, color) VALUES (?, ?, ?)', t.team, t.description, t.color).lastInsertRowid) };

      for (const a of t.agents) {
        const existing = get('SELECT id, team_id FROM agents WHERE name = ?', a.name);
        if (existing) {
          // Slot an existing agent into this title, unless someone already put it on a team.
          if (!existing.team_id) {
            run('UPDATE agents SET title = ?, team_id = ?, description = ? WHERE id = ?', a.title, team.id, a.description, existing.id);
          }
          continue;
        }
        // New titles start paused: they have a job description but no skills or tools yet.
        run(
          `INSERT INTO agents (name, title, team_id, description, platform, status, color, api_token)
           VALUES (?, ?, ?, ?, 'claude', 'paused', ?, ?)`,
          a.name, a.title, team.id, a.description, t.color, newToken(),
        );
      }
    }
    run("INSERT INTO activity (agent_id, kind, text) VALUES (NULL, 'agent', 'Presentail org chart loaded: Accounting, Procurement, Project Management, Design and Executive Office')");
    run('INSERT INTO app_meta (key, value) VALUES (?, ?)', ORG_CHART_VERSION, new Date().toISOString());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log('[org] Presentail org chart applied');
  return true;
}

export const REVIEWERS_VERSION = 'org-reviewers-v1';

/**
 * The Auditor reviews the accountants' work before it reaches you. Applied once; only fills in
 * agents that have no reviewer yet, so your own choices are never overwritten.
 */
export function applyDefaultReviewers() {
  if (get('SELECT value FROM app_meta WHERE key = ?', REVIEWERS_VERSION)) return false;
  const auditor = get("SELECT id FROM agents WHERE title = 'Auditor' ORDER BY id LIMIT 1");
  if (auditor) {
    run(
      "UPDATE agents SET reviewer_id = ? WHERE title IN ('Lebanon Accountant', 'UAE Accountant', 'Cyprus Accountant') AND reviewer_id IS NULL AND id != ?",
      auditor.id,
      auditor.id,
    );
  }
  run('INSERT INTO app_meta (key, value) VALUES (?, ?)', REVIEWERS_VERSION, new Date().toISOString());
  return true;
}
