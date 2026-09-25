import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'production';
const { get, run } = await import('./db.js');
const { seed } = await import('./seed.js');
const { applyOrgChart } = await import('./org.js');
const { seedCloseItems, closeBoard, closeSummary, dueDate, saveCloseItem, closingPeriod } = await import('./close.js');

test('close jobs are seeded per company with the right agents, once', () => {
  seed({ demo: false });
  applyOrgChart();
  assert.equal(seedCloseItems(), true);
  assert.equal(seedCloseItems(), false);
  const talabat = get("SELECT c.*, a.name AS agent FROM close_items c JOIN agents a ON a.id = c.agent_id WHERE c.name = 'Talabat'");
  assert.equal(talabat.entity, 'UAE');
  assert.equal(talabat.agent, 'Ledger');
  assert.equal(get("SELECT a.name FROM close_items c JOIN agents a ON a.id = c.agent_id WHERE c.name = 'Toters fee bills'").name, 'Odoo Operator');
  assert.equal(get("SELECT a.name FROM close_items c JOIN agents a ON a.id = c.agent_id WHERE c.entity = 'Cyprus'").name, 'Kyros');
});

test('the board shows each month from the latest task, with due dates and overdue flags', () => {
  const now = new Date('2026-09-25T09:00:00Z');
  assert.equal(closingPeriod(now), '2026-08');
  assert.equal(dueDate('2026-08', 10), '2026-09-10');
  assert.equal(dueDate('2026-01', 31), '2026-02-28', 'clamped to the month');

  const talabat = get("SELECT id, agent_id FROM close_items WHERE name = 'Talabat'");
  const careem = get("SELECT id FROM close_items WHERE name = 'Careem'");
  run("INSERT INTO tasks (title, status, agent_id, close_item_id, period) VALUES ('Talabat Aug (first try)', 'blocked', ?, ?, '2026-08')", talabat.agent_id, talabat.id);
  run("INSERT INTO tasks (title, status, agent_id, close_item_id, period) VALUES ('Talabat Aug', 'done', ?, ?, '2026-08')", talabat.agent_id, talabat.id);
  run("INSERT INTO tasks (title, status, close_item_id, period) VALUES ('Careem Aug', 'review', ?, '2026-08')", careem.id);

  run("UPDATE close_items SET created_at = '2026-07-15 10:00:00'"); // added to Hive in July: June was already closed
  const board = closeBoard({ months: 6, now });
  assert.equal(board.cells[careem.id]['2026-05'].status, 'before');
  assert.equal(board.cells[careem.id]['2026-05'].overdue, false);
  assert.equal(board.cells[careem.id]['2026-06'].status, 'not_started', 'June is the month being closed in July');
  assert.deepEqual(board.periods, ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
  assert.equal(board.cells[talabat.id]['2026-08'].status, 'done', 'the latest attempt counts');
  assert.equal(board.cells[careem.id]['2026-08'].status, 'review');
  assert.equal(board.cells[careem.id]['2026-08'].overdue, true);
  assert.equal(board.cells[talabat.id]['2026-09'].overdue, false);
  assert.equal(board.progress['2026-08'].done, 1);

  const s = closeSummary(now);
  assert.equal(s.label, 'August 2026');
  assert.equal(s.total, board.items.length);
  assert.ok(s.overdue.includes('UAE: Careem'));
  assert.ok(s.not_started.includes('UAE: Noon Food'));
  assert.ok(!s.not_started.includes('UAE: Careem'));
});

test('jobs can be added and edited, with validation', () => {
  const item = saveCloseItem(null, { entity: 'UAE', name: 'Deliveroo', due_day: 5 });
  assert.equal(item.due_day, 5);
  assert.equal(saveCloseItem(item.id, { name: 'Deliveroo UAE' }).name, 'Deliveroo UAE');
  assert.throws(() => saveCloseItem(item.id, { due_day: 40 }), /1–31/);
  assert.throws(() => saveCloseItem(null, { name: 'x' }), /required/);
});
