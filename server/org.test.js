import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'production'; // mirror the live site: template agents, no demo tasks
const { all, get, run } = await import('./db.js');
const { seed } = await import('./seed.js');
const { applyOrgChart, ORG } = await import('./org.js');

test('org chart slots existing agents into titles, adds the rest, and only runs once', () => {
  seed({ demo: false }); // what hive.presentail.com has today: 4 template agents, no teams

  assert.equal(applyOrgChart(), true);

  const teams = all('SELECT name FROM teams ORDER BY name').map((t) => t.name); // alphabetical for a stable comparison
  assert.deepEqual(teams, ['Accounting', 'Design', 'Executive Office', 'Procurement', 'Project Management']);

  const byTitle = (title) => get('SELECT a.*, t.name AS team FROM agents a JOIN teams t ON t.id = a.team_id WHERE a.title = ?', title);
  assert.equal(byTitle('UAE Accountant').name, 'Ledger');
  assert.equal(byTitle('Lebanon Accountant').name, 'Odoo Operator');
  assert.equal(byTitle('Chief of Staff').name, 'Morning Briefer');
  assert.equal(byTitle('Auditor').team, 'Accounting');
  assert.equal(byTitle('Auditor').status, 'paused');
  assert.equal(byTitle('Menu Designer').team, 'Design');

  // Existing agents keep their configuration (system prompt, model).
  assert.match(get("SELECT system_prompt FROM agents WHERE name = 'Ledger'").system_prompt, /bookkeeping/);

  const titles = ORG.flatMap((t) => t.agents).length;
  assert.equal(get('SELECT COUNT(*) n FROM agents WHERE team_id IS NOT NULL').n, titles);
  assert.equal(get("SELECT team_id FROM agents WHERE name = 'Replit Builder'").team_id, null, 'agents outside the chart are left alone');

  // Deleting an agent afterwards sticks: the chart does not re-apply.
  run("DELETE FROM agents WHERE name = 'Fold'");
  assert.equal(applyOrgChart(), false);
  assert.equal(get("SELECT COUNT(*) n FROM agents WHERE name = 'Fold'").n, 0);
});

test('the Auditor reviews the accountants by default, once, without overriding choices', async () => {
  const { applyDefaultReviewers } = await import('./org.js');
  const scout = get("SELECT id FROM agents WHERE name = 'Scout'").id;
  run("UPDATE agents SET reviewer_id = ? WHERE title = 'Cyprus Accountant'", scout); // your own pick
  assert.equal(applyDefaultReviewers(), true);
  const vera = get("SELECT id FROM agents WHERE title = 'Auditor'").id;
  const reviewerOf = (title) => get('SELECT reviewer_id FROM agents WHERE title = ?', title).reviewer_id;
  assert.equal(reviewerOf('UAE Accountant'), vera);
  assert.equal(reviewerOf('Lebanon Accountant'), vera);
  assert.equal(reviewerOf('Cyprus Accountant'), scout);
  assert.equal(reviewerOf('Auditor'), null);
  run("UPDATE agents SET reviewer_id = NULL WHERE title = 'UAE Accountant'");
  assert.equal(applyDefaultReviewers(), false, 'removing a reviewer sticks');
  assert.equal(reviewerOf('UAE Accountant'), null);
});
