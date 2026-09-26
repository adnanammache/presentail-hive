import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendModel } from '../shared/modelAdvice.js';

const rec = (title, description = '', integrations = []) => recommendModel({ title, description, integrations }).model;

test("each Presentail agent gets a sensible model", () => {
  assert.equal(rec('UAE Accountant', 'UAE books in Wafeq: Talabat, Careem…'), 'claude-opus-5');
  assert.equal(rec('Tax Specialist', 'VAT and tax across entities'), 'claude-opus-5');
  assert.equal(rec('Auditor'), 'claude-opus-5');
  assert.equal(rec('Chief of Staff', 'Morning brief every weekday, plus inbox triage and follow-ups.'), 'claude-sonnet-5');
  assert.equal(rec('Procurement Manager'), 'claude-sonnet-5');
  assert.equal(rec('Brand Designer'), 'claude-sonnet-5');
  assert.equal(rec('Internal Tools Engineer'), 'claude-opus-5');
  assert.equal(rec('Morning Briefer', 'Summarises calendar, Slack and email'), 'claude-haiku-4-5');
  assert.equal(rec('Helper', '', ['wafeq']), 'claude-opus-5', 'anything that can change the books');
  assert.equal(rec(''), 'claude-opus-5', 'nothing described yet: the safe default');
  assert.match(recommendModel({ title: 'Auditor' }).why, /careful/);
});
