// Month-end close board: Presentail's recurring monthly jobs per company, and where each month stands.
// A cell is one job for one month; its state comes from the task that does it.
import { all, get, run } from './db.js';

const SEED_KEY = 'close-items-v1';

// Seeded once from the skills Hive already has; edit freely in the UI afterwards.
const SEED = [
  { entity: 'UAE', title: 'UAE Accountant', items: [
    { name: 'Talabat', files: 'Talabat statement archive: the TUAE fee tax-invoice PDFs and the per-store Balance Summary PDFs', skill: 'talabat-month-end' },
    { name: 'Careem', files: 'Careem tax-invoice PDFs for the month', skill: 'careem-month-end' },
    { name: 'Noon Food', files: 'Noon Food fee tax-invoice PDFs and the per-outlet order statement CSVs', skill: 'noon-food-month-end' },
    { name: 'Now Now', files: 'Now Now per-store order spreadsheets (EX*.xlsx)', skill: 'now-now-month-end' },
  ] },
  { entity: 'Lebanon', title: 'Lebanon Accountant', items: [
    { name: 'Toters fee bills', files: 'Invoice-Report-(Store)-Month-Year.pdf for every store', skill: 'toters-fee-bills' },
    { name: 'BLOM bank reconciliation', files: 'eBLOM statement exports (CSV or XLS) for each account, including POS', skill: 'blom-bank-feed' },
    { name: 'Supplier statements', files: "Suppliers' statements of account (PDF or XLSX)", skill: 'sal-supplier-statement-reconciliation' },
    { name: 'Intercompany SAL → LTD', files: 'The amounts and dates (a screenshot or a message is enough)', skill: 'intercompany-sal-ltd' },
  ] },
  { entity: 'Cyprus', title: 'Cyprus Accountant', items: [
    { name: 'Supplier invoices & Revolut', files: 'Supplier invoice PDFs for the month', skill: 'odoo-supplier-invoices' },
  ] },
];

export function seedCloseItems() {
  if (get('SELECT value FROM app_meta WHERE key = ?', SEED_KEY)) return false;
  let sort = 0;
  for (const group of SEED) {
    const agent = get('SELECT id FROM agents WHERE title = ? ORDER BY id LIMIT 1', group.title);
    for (const i of group.items) {
      run(
        'INSERT INTO close_items (entity, name, agent_id, instructions, files_hint, due_day, sort) VALUES (?, ?, ?, ?, ?, 10, ?)',
        group.entity, i.name, agent?.id ?? null,
        `Do the ${i.name} month-end for {month} using your ${i.skill} skill. Check what's already booked first, stop at the dry run and show me the totals before posting anything.`,
        i.files, sort++,
      );
    }
  }
  run('INSERT INTO app_meta (key, value) VALUES (?, ?)', SEED_KEY, new Date().toISOString());
  return true;
}

export const monthLabel = (period) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const shift = (period, n) => {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
export const currentPeriod = (now = new Date()) => `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
/** The month you're closing now: last month. */
export const closingPeriod = (now = new Date()) => shift(currentPeriod(now), -1);
/** A period's due date for an item: `due_day` of the following month. */
export const dueDate = (period, dueDay) => {
  const next = shift(period, 1);
  const [y, m] = next.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${next}-${String(Math.min(dueDay, last)).padStart(2, '0')}`;
};

export const itemInstructions = (item, period) => (item.instructions || '').replaceAll('{month}', monthLabel(period));

/** The board: items by company × the last `months` months (ending with the current month). */
export function closeBoard({ months = 6, now = new Date() } = {}) {
  const current = currentPeriod(now);
  const periods = Array.from({ length: months }, (_, i) => shift(current, i - months + 1));
  const items = all(
    `SELECT c.*, a.name AS agent_name, a.color AS agent_color, a.status AS agent_status, a.platform AS agent_platform
     FROM close_items c LEFT JOIN agents a ON a.id = c.agent_id ORDER BY c.sort, c.id`,
  );
  const tasks = all(
    `SELECT id, close_item_id, period, CASE WHEN blocked_kind IS NOT NULL AND status != 'done' THEN 'blocked' ELSE status END AS status, title, updated_at FROM tasks
     WHERE close_item_id IS NOT NULL AND period >= ? ORDER BY id`,
    periods[0],
  );
  const today = now.toISOString().slice(0, 10);
  const cells = {};
  for (const item of items) {
    cells[item.id] = {};
    for (const p of periods) {
      const t = tasks.filter((x) => x.close_item_id === item.id && x.period === p).at(-1); // latest attempt
      const due = dueDate(p, item.due_day);
      // Months that were already closed before this job was added to Hive aren't Hive's to track.
      const before = !t && p < closingPeriod(new Date(`${item.created_at.replace(' ', 'T')}Z`));
      cells[item.id][p] = {
        task_id: t?.id ?? null,
        status: t?.status ?? (before ? 'before' : 'not_started'),
        due,
        overdue: !before && t?.status !== 'done' && today > due,
      };
    }
  }
  const progress = Object.fromEntries(
    periods.map((p) => {
      const tracked = items.filter((i) => cells[i.id][p].status !== 'before');
      return [p, { done: tracked.filter((i) => cells[i.id][p].status === 'done').length, total: tracked.length }];
    }),
  );
  return { periods, closing: closingPeriod(now), items, cells, progress, labels: Object.fromEntries(periods.map((p) => [p, monthLabel(p)])) };
}

/** One line per company for the brief: what's left of the month being closed. */
export function closeSummary(now = new Date()) {
  const p = closingPeriod(now);
  const board = closeBoard({ months: 2, now });
  if (!board.items.length) return null;
  const left = board.items.filter((i) => !['done', 'before'].includes(board.cells[i.id][p].status));
  return {
    period: p,
    label: monthLabel(p),
    done: board.progress[p].done,
    total: board.progress[p].total,
    overdue: left.filter((i) => board.cells[i.id][p].overdue).map((i) => `${i.entity}: ${i.name}`),
    not_started: left.filter((i) => board.cells[i.id][p].status === 'not_started').map((i) => `${i.entity}: ${i.name}`),
  };
}

const FIELDS = ['entity', 'name', 'agent_id', 'instructions', 'files_hint', 'due_day', 'sort'];
export function saveCloseItem(id, body) {
  const v = Object.fromEntries(FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  if (v.name !== undefined && !String(v.name).trim()) throw new Error('Name is required');
  if (v.entity !== undefined && !String(v.entity).trim()) throw new Error('Company is required');
  if (v.due_day !== undefined && !(Number.isInteger(Number(v.due_day)) && v.due_day >= 1 && v.due_day <= 31)) throw new Error('Due day must be 1–31');
  if (v.agent_id && !get('SELECT id FROM agents WHERE id = ?', v.agent_id)) throw new Error('Unknown agent');
  if (!id) {
    if (!v.name || !v.entity) throw new Error('Name and company are required');
    v.sort ??= (get('SELECT MAX(sort) AS s FROM close_items').s ?? 0) + 1;
    const keys = Object.keys(v);
    id = Number(run(`INSERT INTO close_items (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => v[k] ?? null)).lastInsertRowid);
  } else if (Object.keys(v).length) {
    run(`UPDATE close_items SET ${Object.keys(v).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(v).map((x) => x ?? null), id);
  }
  return get('SELECT * FROM close_items WHERE id = ?', id);
}
