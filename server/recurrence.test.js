import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, daysBetween, describeRule, dubaiNow, formatDay, normalizeRule, startReached, stepDate } from './recurrence.js';

const series = (anchor, rule, n) => Array.from({ length: n }, (_, i) => stepDate(anchor, normalizeRule(rule), i + 1));

test('monthly keeps the day, and uses the last day of shorter months (31st → 30th / 28th → back to 31st)', () => {
  assert.deepEqual(series('2026-01-31', 'monthly', 5), ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
  assert.deepEqual(series('2027-12-31', 'monthly', 3), ['2028-01-31', '2028-02-29', '2028-03-31'], 'leap year February');
  assert.deepEqual(series('2026-10-28', 'monthly', 4), ['2026-11-28', '2026-12-28', '2027-01-28', '2027-02-28'], 'across the year end');
  assert.deepEqual(series('2026-01-30', 'monthly', 2), ['2026-02-28', '2026-03-30'], 'the 30th comes back after February');
});

test('quarterly and yearly', () => {
  assert.deepEqual(series('2026-10-28', 'quarterly', 4), ['2027-01-28', '2027-04-28', '2027-07-28', '2027-10-28']);
  assert.deepEqual(series('2026-11-30', 'quarterly', 2), ['2027-02-28', '2027-05-30']);
  assert.deepEqual(series('2026-03-31', 'quarterly', 2), ['2026-06-30', '2026-09-30']);
  assert.deepEqual(series('2028-02-29', 'yearly', 4), ['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  assert.deepEqual(series('2026-04-30', 'yearly', 1), ['2027-04-30']);
});

test('custom: every N days, weeks or months', () => {
  assert.deepEqual(series('2026-10-28', { freq: 'custom', every: 10, unit: 'day' }, 2), ['2026-11-07', '2026-11-17']);
  assert.deepEqual(series('2026-12-24', { freq: 'custom', every: 2, unit: 'week' }, 2), ['2027-01-07', '2027-01-21']);
  assert.deepEqual(series('2026-08-31', { freq: 'custom', every: 2, unit: 'month' }, 3), ['2026-10-31', '2026-12-31', '2027-02-28']);
  assert.equal(describeRule(normalizeRule({ freq: 'custom', every: 2, unit: 'week' })), 'Every 2 weeks');
  assert.equal(describeRule(normalizeRule({ freq: 'custom', every: 1, unit: 'month' })), 'Every month');
  assert.equal(describeRule(normalizeRule('quarterly')), 'Quarterly');
});

test('rules are checked', () => {
  assert.equal(normalizeRule(null), null);
  assert.equal(normalizeRule({ freq: 'none' }), null);
  assert.throws(() => normalizeRule({ freq: 'custom', every: 0, unit: 'day' }), /whole number/);
  assert.throws(() => normalizeRule({ freq: 'custom', every: 2, unit: 'year' }), /days, weeks or months/);
  assert.throws(() => normalizeRule({ freq: 'fortnightly' }), /monthly, quarterly/);
});

test('dates are Dubai dates, shown as "28 Oct 2026"', () => {
  // 20:30 UTC on 9 Oct is 00:30 on 10 Oct in Dubai (UTC+4, no daylight saving).
  assert.deepEqual(dubaiNow(new Date('2026-10-09T20:30:00Z')), { date: '2026-10-10', hour: 0 });
  assert.deepEqual(dubaiNow(new Date('2026-10-10T04:00:00Z')), { date: '2026-10-10', hour: 8 });
  assert.equal(formatDay('2026-10-28'), '28 Oct 2026');
  assert.equal(formatDay('2027-01-05'), '5 Jan 2027');
  assert.equal(addDays('2026-10-28', -18), '2026-10-10');
  assert.equal(daysBetween('2026-10-10', '2026-10-28'), 18);
});

test('a start date is reached at 8:00 Dubai time on the day', () => {
  assert.equal(startReached(null), true, 'no start date = now');
  assert.equal(startReached('2026-10-10', new Date('2026-10-10T03:59:00Z')), false, '7:59 Dubai');
  assert.equal(startReached('2026-10-10', new Date('2026-10-10T04:00:00Z')), true, '8:00 Dubai');
  assert.equal(startReached('2026-10-10', new Date('2026-10-09T23:00:00Z')), false, 'just after midnight in Dubai');
  assert.equal(startReached('2026-10-09', new Date('2026-10-10T01:00:00Z')), true, 'the day after');
});
