// Recurrence rules, time zones, daylight saving, month lengths, reporting periods and deadlines.
// Pure functions with fixed instants: nothing here depends on today's date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RuleError, checkTemplate, describeRule, formatLocal, localParts, normalizeDeadlineRule, normalizePeriodRule, normalizeRule, occurrencesAfter,
  occurrencesBetween, resolveDeadline, resolvePeriod,
} from './recurring.js';

const at = (s, input, after, n = 4, extra = {}) => {
  const { rule } = normalizeRule(input, { startsOn: extra.starts_on });
  return occurrencesAfter({ rule, timezone: s, ...extra }, new Date(after), n).map((d) => formatLocal(d, s));
};

test('weekly: every Monday at 9:00 in Dubai (UTC+4) lands at 05:00 UTC', () => {
  const { rule } = normalizeRule({ freq: 'weekly', weekdays: ['mon'], time: '09:00' });
  assert.equal(describeRule(rule), 'Every Monday at 9:00 AM');
  const next = occurrencesAfter({ rule, timezone: 'Asia/Dubai' }, new Date('2026-09-26T10:00:00Z'), 2);
  assert.deepEqual(next.map((d) => d.toISOString()), ['2026-09-28T05:00:00.000Z', '2026-10-05T05:00:00.000Z']);
});

test('selected weekdays, every weekday, every n days and every n weeks', () => {
  assert.equal(describeRule(normalizeRule({ freq: 'daily', weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '08:30' }).rule), 'Every weekday at 8:30 AM');
  assert.deepEqual(at('Asia/Dubai', { freq: 'daily', weekdays: ['fri', 'mon'] }, '2026-09-26T00:00:00Z', 3), ['Mon 28 Sep 2026, 9:00 AM', 'Fri 2 Oct 2026, 9:00 AM', 'Mon 5 Oct 2026, 9:00 AM']);
  assert.deepEqual(at('UTC', { freq: 'daily', interval: 3, time: '07:00' }, '2026-01-01T00:00:00Z', 3, { starts_on: '2026-01-01' }), ['Thu 1 Jan 2026, 7:00 AM', 'Sun 4 Jan 2026, 7:00 AM', 'Wed 7 Jan 2026, 7:00 AM']);
  // Every 2 weeks counts from the first matching day on or after the start date.
  assert.deepEqual(at('Asia/Dubai', { freq: 'weekly', weekdays: ['tue'], interval: 2 }, '2026-09-01T00:00:00Z', 3, { starts_on: '2026-10-01' }), ['Tue 6 Oct 2026, 9:00 AM', 'Tue 20 Oct 2026, 9:00 AM', 'Tue 3 Nov 2026, 9:00 AM']);
  assert.equal(describeRule(normalizeRule({ freq: 'weekly', weekdays: ['thu', 'mon'], interval: 2, time: '14:00' }).rule), 'Every 2 weeks on Monday and Thursday at 2:00 PM');
});

test('monthly on a day, the last day, and days some months lack (explicit policy)', () => {
  assert.deepEqual(at('Asia/Dubai', { freq: 'monthly', month_day: 'last', time: '17:00' }, '2026-01-15T00:00:00Z', 3), ['Sat 31 Jan 2026, 5:00 PM', 'Sat 28 Feb 2026, 5:00 PM', 'Tue 31 Mar 2026, 5:00 PM']);
  const { rule, notes } = normalizeRule({ freq: 'monthly', month_day: 31 });
  assert.equal(rule.missing_day, 'last_day', 'the default is surfaced, not silent');
  assert.match(notes.join(' '), /last day instead/);
  assert.match(describeRule(rule), /or the month's last day/);
  assert.deepEqual(at('Asia/Dubai', { freq: 'monthly', month_day: 31 }, '2026-01-01T00:00:00Z', 4), ['Sat 31 Jan 2026, 9:00 AM', 'Sat 28 Feb 2026, 9:00 AM', 'Tue 31 Mar 2026, 9:00 AM', 'Thu 30 Apr 2026, 9:00 AM']);
  assert.deepEqual(at('Asia/Dubai', { freq: 'monthly', month_day: 31, if_day_missing: 'skip' }, '2026-01-01T00:00:00Z', 3), ['Sat 31 Jan 2026, 9:00 AM', 'Tue 31 Mar 2026, 9:00 AM', 'Sun 31 May 2026, 9:00 AM']);
  assert.match(describeRule(normalizeRule({ freq: 'monthly', month_day: 31, if_day_missing: 'skip' }).rule), /skipped in months without a 31st/);
  // Day 14 exists everywhere: no policy needed.
  assert.equal(normalizeRule({ freq: 'monthly', month_day: 14 }).rule.missing_day, undefined);
});

test('quarterly, yearly and explicit months', () => {
  const q = normalizeRule({ freq: 'quarterly', day_of_month: 14, months: [3, 6, 9, 12] }).rule;
  assert.equal(describeRule(q), 'Quarterly on the 14th of Mar, Jun, Sep and Dec at 9:00 AM');
  assert.deepEqual(at('Asia/Dubai', { freq: 'quarterly', day_of_month: 14, months: [12, 3, 9, 6] }, '2026-01-01T00:00:00Z', 4), ['Sat 14 Mar 2026, 9:00 AM', 'Sun 14 Jun 2026, 9:00 AM', 'Mon 14 Sep 2026, 9:00 AM', 'Mon 14 Dec 2026, 9:00 AM']);
  // Quarterly from the start date's month when no months are given, and that default is noted.
  const { rule: qs, notes } = normalizeRule({ freq: 'quarterly', day_of_month: 1 }, { startsOn: '2026-02-10' });
  assert.deepEqual(qs.months, [2, 5, 8, 11]);
  assert.match(notes.join(' '), /Feb, May, Aug, Nov/);
  assert.deepEqual(at('UTC', { freq: 'yearly', month: 1, day_of_month: 31, time: '10:00' }, '2026-02-01T00:00:00Z', 2), ['Sun 31 Jan 2027, 10:00 AM', 'Mon 31 Jan 2028, 10:00 AM']);
  assert.deepEqual(at('Asia/Dubai', { freq: 'monthly', months: [1, 7], day_of_month: 5 }, '2026-01-06T00:00:00Z', 2), ['Sun 5 Jul 2026, 9:00 AM', 'Tue 5 Jan 2027, 9:00 AM']);
  assert.equal(describeRule(normalizeRule({ freq: 'monthly', months: [1, 7], day_of_month: 5 }).rule), 'On the 5th of Jan and Jul at 9:00 AM');
});

test('leap years: 29 Feb skips or uses 28 Feb, as chosen', () => {
  assert.deepEqual(at('UTC', { freq: 'yearly', month: 2, day_of_month: 29, if_day_missing: 'skip' }, '2026-01-01T00:00:00Z', 2), ['Tue 29 Feb 2028, 9:00 AM', 'Sun 29 Feb 2032, 9:00 AM']);
  assert.match(describeRule(normalizeRule({ freq: 'yearly', month: 2, day_of_month: 29, if_day_missing: 'skip' }).rule), /only in leap years/);
  assert.deepEqual(at('UTC', { freq: 'yearly', month: 2, day_of_month: 29 }, '2026-01-01T00:00:00Z', 3), ['Sat 28 Feb 2026, 9:00 AM', 'Sun 28 Feb 2027, 9:00 AM', 'Tue 29 Feb 2028, 9:00 AM']);
});

test('daylight saving: a missing local time moves forward by the gap, a repeated one runs once', () => {
  // New York springs forward at 02:00 on 8 Mar 2026: 02:30 doesn't exist that day.
  const spring = occurrencesAfter({ rule: normalizeRule({ freq: 'daily', time: '02:30' }).rule, timezone: 'America/New_York' }, new Date('2026-03-07T12:00:00Z'), 2);
  assert.deepEqual(spring.map((d) => formatLocal(d, 'America/New_York')), ['Sun 8 Mar 2026, 3:30 AM', 'Mon 9 Mar 2026, 2:30 AM']);
  // It falls back at 02:00 on 1 Nov 2026: 01:30 happens twice; it runs once, the first time (EDT).
  const fall = occurrencesAfter({ rule: normalizeRule({ freq: 'daily', time: '01:30' }).rule, timezone: 'America/New_York' }, new Date('2026-10-31T12:00:00Z'), 2);
  assert.deepEqual(fall.map((d) => d.toISOString()), ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
  // Weekly across the change keeps 09:00 local, so the UTC time shifts.
  const london = occurrencesAfter({ rule: normalizeRule({ freq: 'weekly', weekdays: ['mon'] }).rule, timezone: 'Europe/London' }, new Date('2026-10-19T00:00:00Z'), 2);
  assert.deepEqual(london.map((d) => d.toISOString()), ['2026-10-19T08:00:00.000Z', '2026-10-26T09:00:00.000Z']);
  assert.equal(localParts(london[1], 'Europe/London').hour, 9);
});

test('invalid rules are refused with a reason', () => {
  const bad = (input, re) => assert.throws(() => normalizeRule(input), (e) => e instanceof RuleError && re.test(e.message));
  bad({ freq: 'monthly', months: [2], day_of_month: 30 }, /February never has a day 30/);
  bad({ freq: 'fortnightly' }, /frequency must be/);
  bad({ freq: 'weekly', weekdays: ['funday'] }, /Unknown day/);
  bad({ freq: 'daily', time: '25:00' }, /HH:MM/);
  bad({ freq: 'monthly', day_of_month: 0 }, /1 to 31/);
  bad({ freq: 'daily', interval: 2, weekdays: ['mon'] }, /not both/);
  bad({ freq: 'cron', expr: 'every day' }, /Invalid cron/);
});

test('end dates stop occurrences; start dates are never backdated', () => {
  const { rule } = normalizeRule({ freq: 'weekly', weekdays: ['mon'] });
  const s = { rule, timezone: 'Asia/Dubai', starts_on: '2026-01-01', ends_on: '2026-10-12' };
  // The start date is long past; the next occurrence is the next one after "now", not the first after the start.
  assert.deepEqual(occurrencesAfter(s, new Date('2026-09-30T00:00:00Z'), 5).map((d) => formatLocal(d, 'Asia/Dubai')), ['Mon 5 Oct 2026, 9:00 AM', 'Mon 12 Oct 2026, 9:00 AM']);
  assert.equal(occurrencesBetween(s, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-30T00:00:00Z')).length, 4);
});

test('reporting periods, including ones that cross a year boundary', () => {
  const anchored = normalizePeriodRule({ type: 'anchored', months: 3, anchor_month: 12 });
  // The illustrative schedule on the 14th of Mar, Jun, Sep and Dec.
  assert.deepEqual(resolvePeriod(anchored, '2026-03-14'), { start: '2025-12-01', end: '2026-02-28', label: 'Dec 2025 – Feb 2026' });
  assert.deepEqual(resolvePeriod(anchored, '2026-06-14'), { start: '2026-03-01', end: '2026-05-31', label: 'Mar 2026 – May 2026' });
  assert.deepEqual(resolvePeriod(anchored, '2026-09-14'), { start: '2026-06-01', end: '2026-08-31', label: 'Jun 2026 – Aug 2026' });
  assert.deepEqual(resolvePeriod(anchored, '2026-12-14'), { start: '2026-09-01', end: '2026-11-30', label: 'Sep 2026 – Nov 2026' });
  assert.deepEqual(resolvePeriod(anchored, '2028-03-14').end, '2028-02-29', 'leap February');
  assert.deepEqual(resolvePeriod({ kind: 'previous_month' }, '2026-01-05'), { start: '2025-12-01', end: '2025-12-31', label: 'December 2025' });
  assert.deepEqual(resolvePeriod({ kind: 'previous_quarter' }, '2026-01-05'), { start: '2025-10-01', end: '2025-12-31', label: 'Q4 2025 (Oct–Dec)' });
  assert.deepEqual(resolvePeriod({ kind: 'previous_quarter' }, '2026-03-31').label, 'Q4 2025 (Oct–Dec)');
  assert.deepEqual(resolvePeriod({ kind: 'previous_year' }, '2026-02-01'), { start: '2025-01-01', end: '2025-12-31', label: '2025' });
  assert.deepEqual(resolvePeriod({ kind: 'previous_months', months: 3 }, '2026-02-14'), { start: '2025-11-01', end: '2026-01-31', label: 'Nov 2025 – Jan 2026' });
  assert.deepEqual(resolvePeriod({ kind: 'previous_week' }, '2026-01-01'), { start: '2025-12-22', end: '2025-12-28', label: '22 Dec 2025 – 28 Dec 2025' });
  assert.throws(() => normalizePeriodRule({ type: 'last_fortnight' }), RuleError);
});

test('deadlines are separate from the start and the period; template variables are checked', () => {
  const period = normalizePeriodRule({ type: 'previous_month' });
  const p = resolvePeriod(period, '2026-01-14');
  assert.equal(resolveDeadline(normalizeDeadlineRule({ type: 'days_after_start', days: 3 }), '2026-01-14', p), '2026-01-17');
  assert.equal(resolveDeadline(normalizeDeadlineRule({ type: 'days_after_period_end', days: 28 }, period), '2026-01-14', p), '2026-01-28');
  assert.throws(() => normalizeDeadlineRule({ type: 'days_after_period_end', days: 5 }, null), /needs a reporting period/);
  checkTemplate('Summary for {{period_label}} ({{period_start}}–{{period_end}}), run {{scheduled_date}}', { periodRule: period });
  assert.throws(() => checkTemplate('For {{period_label}}', {}), /needs a reporting period rule/);
  assert.throws(() => checkTemplate('Hello {{user.password}}', { periodRule: period }), /Unknown variable/);
});
