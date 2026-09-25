// Ledger finishes, Vera reviews, and the verdict lands on the original task for the user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = ':memory:';
const { all, get, run } = await import('./db.js');
const managed = await import('./managed.js');
const { handOff, reviewerFor } = await import('./handoff.js');
const { fakeAnthropic } = await import('./testing/fake-anthropic.js');

globalThis.fetch = async () => new Response('{"ok":true}'); // Slack, if configured

const waitFor = async (fn, what) => {
  for (let i = 0; i < 300; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};
const idle = { type: 'session.status_idle', stop_reason: { type: 'end_turn' } };

test('work is handed to the reviewer with its files and outputs, and the verdict comes back', async () => {
  const fake = fakeAnthropic();
  managed.setManagedClient(fake);
  // Answer each send by what it is, whichever session it's for.
  Object.defineProperty(fake.script, 'shift', {
    value: () => (events) => {
      const e = events[0];
      const said = e.content?.[0]?.text ?? '';
      if (e.type === 'user.message' && said.startsWith('Task') && said.includes('Review:'))
        return [
          { type: 'agent.message', content: [{ type: 'text', text: 'Checked the bills against the PDFs.' }] },
          { id: 'v_done', type: 'agent.custom_tool_use', name: 'task_complete', input: { summary: 'All 3 bills match. Abu Dhabi is AED 12.40 short.', check: 'Accept the AED 12.40 difference?' } },
          { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['v_done'] } },
        ];
      if (e.type === 'user.message')
        return [
          { type: 'agent.message', content: [{ type: 'text', text: 'Posted 3 bills.' }] },
          { id: 'l_done', type: 'agent.custom_tool_use', name: 'task_complete', input: { summary: 'Posted 3 bills, AED 18,420.55.', check: 'Abu Dhabi branch' } },
          { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: ['l_done'] } },
        ];
      if (e.type === 'user.custom_tool_result') return [{ type: 'agent.message', content: [{ type: 'text', text: 'Done, signing off.' }] }, idle];
      return [idle];
    },
  });

  const vera = Number(run("INSERT INTO agents (name, title, platform, api_token) VALUES ('Vera', 'Auditor', 'managed', 'v')").lastInsertRowid);
  const ledger = Number(run("INSERT INTO agents (name, title, platform, api_token, reviewer_id) VALUES ('Ledger', 'UAE Accountant', 'managed', 'l', ?)", vera).lastInsertRowid);
  const taskId = Number(run("INSERT INTO tasks (title, description, agent_id) VALUES ('Talabat August', 'Post the fee bills.', ?)", ledger).lastInsertRowid);
  const dir = mkdtempSync(join(tmpdir(), 'hive-handoff-'));
  writeFileSync(join(dir, 'TUAE-1.pdf'), '%PDF bills');
  run('INSERT INTO task_files (task_id, filename, path, size) VALUES (?, ?, ?, 10)', taskId, 'TUAE-1.pdf', join(dir, 'TUAE-1.pdf'));
  assert.equal(reviewerFor(get('SELECT * FROM tasks WHERE id = ?', taskId)).name, 'Vera');

  // Ledger's session has saved a summary file by the time it finishes.
  const create = fake.beta.sessions.create;
  fake.beta.sessions.create = async (p) => {
    const session = await create(p);
    if (fake.calls.sessions.length === 1) fake.outputs[session.id] = [{ id: 'file_sum', filename: 'summary.xlsx', mime_type: 'application/vnd.ms-excel', size_bytes: 9 }];
    return session;
  };
  // Every managed agent gets the task_complete tool.
  const started = managed.startTaskRun(taskId);
  await waitFor(() => fake.calls.agentsCreate[0], 'agent created');
  assert.ok(fake.calls.agentsCreate[0].tools.some((t) => t.name === 'task_complete'));
  assert.ok(fake.calls.agentsCreate[0].tools.some((t) => t.name === 'message_agent'));

  // Ledger finishes → a review task for Vera, with the input file and Ledger's output.
  const review = await waitFor(() => get('SELECT * FROM tasks WHERE parent_task_id = ?', taskId), 'review task');
  assert.equal(review.title, 'Review: Talabat August');
  assert.equal(review.agent_id, vera);
  assert.match(review.description, /Posted 3 bills, AED 18,420\.55[\s\S]*Abu Dhabi branch/);
  const files = all('SELECT filename, path FROM task_files WHERE task_id = ? ORDER BY id', review.id);
  assert.deepEqual(files.map((f) => f.filename), ['TUAE-1.pdf', 'output - summary.xlsx']);
  assert.equal(readFileSync(files[1].path, 'utf8'), 'contents of file_sum');

  // Ledger's sign-off message doesn't overwrite what it filed.
  await waitFor(() => get('SELECT status FROM runs WHERE id = ?', started.id).status === 'waiting', 'Ledger turn end');
  assert.match(get('SELECT result FROM tasks WHERE id = ?', taskId).result, /Posted 3 bills[\s\S]*Handed to Vera/);

  // Vera reviews → the verdict is added to Ledger's task, which is back with the user.
  const reviewed = await waitFor(() => get("SELECT * FROM tasks WHERE id = ? AND result LIKE '%Vera''s review%'", taskId), 'verdict');
  assert.equal(reviewed.status, 'review');
  assert.match(reviewed.result, /All 3 bills match[\s\S]*For you to decide: Accept the AED 12\.40 difference\?/);
  assert.equal(get('SELECT status FROM tasks WHERE id = ?', review.id).status, 'done');
  // Review tasks never hand off again.
  assert.equal(reviewerFor(get('SELECT * FROM tasks WHERE id = ?', review.id)), null);
  await waitFor(() => all("SELECT id FROM runs WHERE status NOT IN ('waiting', 'failed', 'ended')").length === 0, 'runs settle');
});

test('manual hand-offs are validated', async () => {
  const a = Number(run("INSERT INTO agents (name, title, api_token) VALUES ('Scout', 'Procurement', 's')").lastInsertRowid);
  const t = Number(run("INSERT INTO tasks (title, agent_id) VALUES ('Quotes', ?)", a).lastInsertRowid);
  await assert.rejects(handOff(t, a), /own work/);
  await assert.rejects(handOff(t, 9999), /Unknown reviewer/);
});
