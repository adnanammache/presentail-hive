import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { run } = await import('./db.js');
const { addLesson, listLessons, updateLesson, deleteLesson, lessonsBlock, REMEMBER } = await import('./lessons.js');
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
  assert.match(system, /## Lessons from past corrections[\s\S]*- Abu Dhabi fees always go to account 5104\.[\s\S]*- Never post before the 3rd/);
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
