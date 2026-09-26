import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { run } = await import('./db.js');
const { addLesson, listLessons, updateLesson, deleteLesson, lessonsBlock, REMEMBER, proposeLesson, approveLesson, rejectLesson, resolveProposal, setTrustLessons, findDuplicate, similarity, lessonProblem, parseVerdict, setLessonJudge, unseenLessons, lessonIdsInForce, markApplied, describeLessons } =
  await import('./lessons.js');
const { get, all } = await import('./db.js');
const { composeSystem } = await import('./managed.js');

test('lessons are kept per agent and go into its instructions', () => {
  const id = Number(run("INSERT INTO agents (name, title, api_token) VALUES ('Ledger', 'UAE Accountant', 'l')").lastInsertRowid);
  const other = Number(run("INSERT INTO agents (name, title, api_token) VALUES ('Kyros', 'Cyprus Accountant', 'k')").lastInsertRowid);
  assert.equal(lessonsBlock(id), '');
  assert.ok(!composeSystem({ id, name: 'Ledger', title: 'UAE Accountant', integrations: '[]' }).includes('Lessons'));

  const a = addLesson(id, 'Abu Dhabi fees always go to account 5104.', { source: 'rejection', by: 'Adnan' });
  addLesson(id, 'Never post before the 3rd of the month.');
  assert.equal(addLesson(id, 'abu dhabi fees always go to account 5104.').id, a.id, 'no duplicates');
  assert.throws(() => addLesson(id, '   '), /empty/);

  const system = composeSystem({ id, name: 'Ledger', title: 'UAE Accountant', integrations: '[]' });
  assert.match(system, /## Lessons from past corrections[\s\S]*- \[#\d+\] Abu Dhabi fees always go to account 5104\.[\s\S]*- \[#\d+\] Never post before the 3rd/);
  assert.equal(lessonsBlock(other), '', 'other agents are unaffected');

  updateLesson(a.id, { active: false });
  assert.ok(!lessonsBlock(id).includes('5104'), 'paused lessons are left out');
  updateLesson(a.id, { active: true, text: 'Abu Dhabi fees go to 5104 (not 5103).' });
  assert.match(lessonsBlock(id), /not 5103/);
  deleteLesson(a.id);
  assert.equal(listLessons(id).length, 1);
});

test('"remember:" messages are recognised', () => {
  for (const t of ['remember: X', 'Remember that X', 'lesson - X', 'please remember, X', 'note for next time: X']) assert.equal(t.replace(REMEMBER, ''), 'X', t);
  assert.ok(!REMEMBER.test('Do you remember the August total?'));
  assert.ok(!REMEMBER.test('Remember the August total?'), 'a question, not a lesson');
});

// ---------------------------------------------------------------- lessons agents propose

const WAFEQ = 'UAE sales in Wafeq sit in two places: Cash invoices (`simplified-invoices`) and Invoices (`invoices`). Always check both.';
let n = 0;
const newAgent = (name = `Agent ${++n}`) => Number(run('INSERT INTO agents (name, title, api_token) VALUES (?, ?, ?)', name, 'Tax', `t${n}`).lastInsertRowid);
const propose = (agentId, text, reason = 'test') => proposeLesson({ id: null, kind: 'chat', agent_id: agentId }, { text, reason });
const rows = (agentId) => all('SELECT * FROM agent_lessons WHERE agent_id = ? ORDER BY id', agentId);
setLessonJudge(null); // wording only, unless a test sets a judge

test('pending and rejected lessons never reach the prompt; approved ones do', async () => {
  const id = newAgent('Ziad');
  const human = addLesson(id, 'Never post before the 3rd of the month.');
  const res = await propose(id, WAFEQ, 'Reported six months of revenue missing; only queried invoices.');
  assert.match(res.text, /^Proposed as lesson #\d+\..*does NOT apply yet/);
  const [, pending] = rows(id);
  assert.equal(pending.status, 'pending_approval');
  assert.equal(pending.active, 1, 'active, but not approved');

  const shown = () => [lessonsBlock(id), composeSystem({ id, name: 'Ziad', title: 'Tax', integrations: '[]' })];
  for (const text of shown()) {
    assert.ok(!text.includes('Wafeq'), 'a pending lesson is never in the instructions');
    assert.ok(text.includes('Never post before the 3rd'), 'human lessons are unaffected');
  }
  assert.deepEqual(lessonIdsInForce(id), [human.id]);
  assert.deepEqual(unseenLessons(id, [human.id]), [], 'nothing to tell a running chat while it waits');

  // Rejected: still not in the prompt, and it can't be approved by pausing/unpausing.
  rejectLesson(pending.id, { note: 'Not now', by: 'Adnan' });
  updateLesson(pending.id, { active: true });
  for (const text of shown()) assert.ok(!text.includes('Wafeq'), 'a rejected lesson is never in the instructions');

  // Approved (after all): in the prompt, and told to sessions already running.
  approveLesson(pending.id, { by: 'Adnan' });
  for (const text of shown()) assert.match(text, new RegExp(`\\[#${pending.id}\\] UAE sales in Wafeq`));
  assert.deepEqual(unseenLessons(id, [human.id]).map((l) => l.id), [pending.id]);

  // Paused: out again.
  updateLesson(pending.id, { active: false });
  assert.ok(!lessonsBlock(id).includes('Wafeq'));
});

test('edit & approve rewords before it applies; a trusted agent needs no approval', async () => {
  const id = newAgent();
  await propose(id, 'Book Careem commission to account 5210 in Wafeq, never to 5200.');
  const [l] = rows(id);
  approveLesson(l.id, { text: 'Book Careem commission to 5210 (Commissions), never 5200.', by: 'Adnan' });
  assert.match(lessonsBlock(id), /5210 \(Commissions\)/);
  assert.throws(() => approveLesson(l.id, {}), /already approved/);
  assert.throws(() => rejectLesson(l.id, {}), /Only a lesson waiting/);

  setTrustLessons(id, true);
  const res = await propose(id, 'File UAE VAT returns quarterly; each is due on the 28th of the month after the quarter ends.');
  assert.match(res.text, /^Saved as lesson #\d+\. You are trusted/);
  assert.equal(rows(id).at(-1).status, 'approved');
  assert.match(lessonsBlock(id), /File UAE VAT returns quarterly/);
});

test('dedupe: the same lesson in other words is caught and no row is created', async () => {
  const id = newAgent();
  await propose(id, WAFEQ);
  approveLesson(rows(id)[0].id, {});
  const before = rows(id).length;

  // Exact (any case), and reworded with the same words.
  for (const text of [WAFEQ.toUpperCase(), 'Always check both Wafeq Cash invoices (simplified-invoices) and Invoices (invoices) for UAE sales.']) {
    const res = await propose(id, text);
    assert.match(res.text, /^Not saved: you already have this as lesson #\d+/, text);
    assert.equal(rows(id).length, before);
  }

  // Same rule plus specifics: offered as a new wording for the existing lesson, not a new row.
  const longer = 'UAE sales in Wafeq sit in two places: Cash invoices (`simplified-invoices`, marketplace revenue) and Invoices (`invoices`). Always check both, for every month.';
  const res = await propose(id, longer, 'Marketplace revenue is in cash invoices');
  assert.match(res.text, /offered to a person as a new wording for #\d+\. Nothing new was created/);
  assert.equal(rows(id).length, before);
  const [existing] = rows(id);
  assert.equal(existing.proposed_text, longer);
  assert.ok(!lessonsBlock(id).includes('marketplace revenue'), 'the new wording waits too');
  resolveProposal(existing.id, { accept: true, by: 'Adnan' });
  assert.match(lessonsBlock(id), /marketplace revenue/);
  assert.equal(get('SELECT proposed_text FROM agent_lessons WHERE id = ?', existing.id).proposed_text, null);

  // A lesson waiting for approval is a duplicate too.
  await propose(id, 'Post Talabat fee bills to the Talabat Transactions clearing account in Wafeq.');
  const res2 = await propose(id, 'In Wafeq, post Talabat fee bills to the Talabat Transactions clearing account.');
  assert.match(res2.text, /already waiting for approval as #\d+/);
  assert.equal(rows(id).length, before + 1);

  // A different rule that shares some words is not a duplicate.
  const other = await propose(id, 'UAE purchase bills in Wafeq go to the Bills list (`bills`), never to expenses.');
  assert.match(other.text, /^Proposed as lesson/);
});

test('dedupe: rejected lessons cannot be proposed again', async () => {
  const id = newAgent();
  await propose(id, 'Always round UAE VAT down to the nearest fils on Wafeq invoices.');
  rejectLesson(rows(id)[0].id, { note: 'Wafeq rounds per line', by: 'Adnan' });
  const res = await propose(id, 'On Wafeq invoices, always round UAE VAT down to the nearest fils.');
  assert.match(res.text, /Adnan rejected this before as #\d+ \(“Wafeq rounds per line”\)\. Do not propose it again\./);
  assert.equal(res.isError, true);
  assert.equal(rows(id).length, 1);
  assert.match(describeLessons(id), /Rejected \(never propose these again\):\n- #\d+: Always round UAE VAT down .*\(reason: Wafeq rounds per line\)/);
});

test('dedupe: different wording with the same meaning goes to the judge', async (t) => {
  const id = newAgent();
  await propose(id, 'Marketplace revenue for UAE is booked as Wafeq cash invoices, not standard invoices.');
  approveLesson(rows(id)[0].id, {});
  const asked = [];
  t.after(() => setLessonJudge(null));

  // The judge says it's the same: blocked.
  setLessonJudge(async (text, candidates) => (asked.push({ text, candidates }), { duplicate_of: candidates[0].id, adds_detail: false }));
  const res = await propose(id, 'For UAE marketplace sales, look in Wafeq cash invoices rather than regular invoices.');
  assert.match(res.text, /already have this as lesson/);
  assert.equal(rows(id).length, 1);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].candidates.map((c) => c.id), [rows(id)[0].id]);

  // Nothing alike: the judge isn't asked at all.
  await propose(id, 'Toters fee bills for Presentail SAL are paid through the Toters Wallet journal in Odoo.');
  assert.equal(asked.length, 1);

  // The judge fails: wording decides, so a paraphrase is saved rather than lost.
  setLessonJudge(async () => {
    throw new Error('overloaded');
  });
  const saved = await propose(id, 'When checking UAE marketplace takings, include the Wafeq cash invoice list as well.');
  assert.match(saved.text, /^Proposed as lesson/);

  // The judge names a lesson it wasn't shown: ignored.
  assert.deepEqual(parseVerdict('{"duplicate_of": 999, "adds_detail": true}', [{ id: 1, text: 'x' }]), { duplicate_of: null, adds_detail: false });
  assert.deepEqual(parseVerdict('Sure! {"duplicate_of": "#1", "adds_detail": true}', [{ id: 1, text: 'x' }]), { duplicate_of: 1, adds_detail: true });
  assert.equal(parseVerdict('no idea', [{ id: 1, text: 'x' }]), null);
});

test('dedupe: wording similarity', () => {
  const same = similarity(WAFEQ, 'Always check both Wafeq Cash invoices (simplified-invoices) and Invoices (invoices) for UAE sales.');
  assert.ok(same.dice >= 0.75, `reworded: ${same.dice}`);
  const different = similarity('Abu Dhabi fees always go to account 5104.', 'Dubai fees always go to account 5103.');
  assert.ok(different.dice < 0.75, `different accounts: ${different.dice}`);
  assert.equal(similarity('', WAFEQ).dice, 0);
});

test('lessons must be short and specific', async () => {
  assert.match(lessonProblem('Be more careful with revenue.'), /^Too vague/);
  assert.match(lessonProblem('Do better.'), /^Too vague/);
  assert.match(lessonProblem('x'.repeat(301)), /^Too long \(301 characters, the limit is 300\)/);
  assert.equal(lessonProblem(WAFEQ), null);
  const id = newAgent();
  const res = await propose(id, 'Be more careful with revenue.');
  assert.equal(res.isError, true);
  assert.match(res.note, /was not saved: Too vague to act on\./, 'the chat is told it was not saved');
  assert.equal(rows(id).length, 0);
  const scoped = await proposeLesson({ kind: 'chat', agent_id: id }, { text: WAFEQ, reason: 'x', scope: 'Ledger' });
  assert.match(scoped.text, /scope must be "self"/);
});

test('lesson_applied records use, for approved lessons of this agent only', async () => {
  const id = newAgent();
  const other = newAgent();
  const a = addLesson(id, 'Abu Dhabi fees always go to account 5104.');
  await propose(id, WAFEQ);
  const pending = rows(id).at(-1);
  const theirs = addLesson(other, 'Never post before the 3rd of the month.');
  assert.match(markApplied(id, [a.id, pending.id, theirs.id, 'junk']).text, /Noted: 1 lesson\./);
  assert.equal(get('SELECT use_count FROM agent_lessons WHERE id = ?', a.id).use_count, 1);
  assert.ok(get('SELECT last_used_at FROM agent_lessons WHERE id = ?', a.id).last_used_at);
  assert.equal(get('SELECT use_count FROM agent_lessons WHERE id = ?', theirs.id).use_count, 0);
  assert.equal(markApplied(id, []).isError, true);
});

test('human lessons and "remember:" are unchanged: approved at once, no approval step', () => {
  const id = newAgent();
  const l = addLesson(id, 'Abu Dhabi fees always go to account 5104.', { source: 'chat', by: 'Adnan' });
  assert.equal(l.status, 'approved');
  assert.match(lessonsBlock(id), /5104/);
  assert.equal(listLessons(id)[0].id, l.id);
});
