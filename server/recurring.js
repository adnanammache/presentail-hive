// Recurring schedules: the rule, when it happens, and what each occurrence covers.
//
// A rule is a small structured object, never a free-form string, and occurrences are computed in
// the schedule's own IANA time zone, in local calendar time, by croner (a maintained cron library).
//
//   { freq: 'daily',     time: '09:00', interval?: n, weekdays?: ['mon', …] }
//   { freq: 'weekly',    time, weekdays: ['mon', …], interval?: n }            every n weeks
//   { freq: 'monthly',   time, month_day: 1…31 | 'last', months?: [1…12], missing_day?: 'last_day' | 'skip' }
//   { freq: 'quarterly', time, month_day, months: [m, m+3, m+6, m+9], missing_day? }
//   { freq: 'yearly',    time, month_day, months: [m], missing_day? }
//   { freq: 'cron',      expr }                                                older workflows only
//
// Defined behaviour (shown to people and agents, never silently changed):
//   - A local time that doesn't exist (the clocks go forward) runs at the same wall time plus the
//     gap, e.g. 02:30 → 03:30. A local time that happens twice (the clocks go back) runs once, the
//     first time.
//   - A day of the month a month doesn't have (the 31st in April, 29 Feb in 2027): 'last_day' (the
//     default) runs on that month's last day; 'skip' skips that month.
//   - "Every n days/weeks" counts from the start date (weeks from the Monday of the start week).
//   - A start date in the past never backdates: the first occurrence is the next one after now.
import { Cron } from 'croner';

export const DEFAULT_TIMEZONE = process.env.HIVE_TIMEZONE || 'Asia/Dubai';
export const DEFAULT_TIME = '09:00';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class RuleError extends Error {}
const fail = (msg) => {
  throw new RuleError(msg);
};

// ---------------------------------------------------------------- calendar helpers

export const isDateStr = (s) => typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const utcDate = (s) => new Date(`${s}T00:00:00Z`);
const toStr = (d) => d.toISOString().slice(0, 10);
export const addDaysStr = (s, n) => toStr(new Date(utcDate(s).getTime() + n * 86400000));
export const daysBetweenStr = (a, b) => Math.round((utcDate(b) - utcDate(a)) / 86400000);
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based
const pad = (n) => String(n).padStart(2, '0');
const ym = (y, m) => `${y}-${pad(m)}`;

export function isTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Local calendar parts of an instant in a time zone. */
export function localParts(instant, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
      .formatToParts(new Date(instant))
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, y: Number(p.year), m: Number(p.month), d: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), dow: DAYS.indexOf(p.weekday.toLowerCase().slice(0, 3)) };
}
export const localDate = (instant, tz) => localParts(instant, tz).date;

/** The first instant of a local date in a time zone (its local midnight, or the first time that exists). */
export function startOfLocalDate(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, tz);
    const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute);
    guess -= asUTC - Date.UTC(y, m - 1, d);
  }
  // A midnight skipped by a DST jump: step forward to the first instant on that date.
  while (localParts(guess, tz).date < dateStr) guess += 15 * 60000;
  return new Date(guess);
}

/** "Mon 5 Oct 2026, 9:00 AM" in the schedule's zone. */
export function formatLocal(instant, tz) {
  if (!instant) return null;
  const p = localParts(instant, tz);
  return `${DAY_NAMES[p.dow].slice(0, 3)} ${p.d} ${MONTHS[p.m - 1]} ${p.y}, ${timeWords(`${p.hour}:${pad(p.minute)}`)}`;
}
export const formatDate = (s) => (isDateStr(s) ? utcDate(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : s ?? '');

// ---------------------------------------------------------------- the rule

const intIn = (v, lo, hi, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) fail(`${what} must be a whole number from ${lo} to ${hi}`);
  return n;
};

function cleanTime(t) {
  const s = String(t ?? DEFAULT_TIME).trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) fail('time must be HH:MM on a 24-hour clock, e.g. "09:00"');
  return `${pad(Number(m[1]))}:${m[2]}`;
}

function cleanWeekdays(list, required) {
  if (list == null || (Array.isArray(list) && !list.length)) {
    if (required) fail('Choose at least one day of the week');
    return null;
  }
  if (!Array.isArray(list)) fail('weekdays must be a list like ["mon", "thu"]');
  const out = [...new Set(list.map((d) => {
    const k = String(d).toLowerCase().slice(0, 3);
    if (!DAYS.includes(k)) fail(`Unknown day of the week: ${d}`);
    return k;
  }))];
  return out.sort((a, b) => ((DAYS.indexOf(a) + 6) % 7) - ((DAYS.indexOf(b) + 6) % 7));
}

function cleanMonths(list) {
  if (list == null) return null;
  if (!Array.isArray(list) || !list.length) fail('months must be a list of month numbers, e.g. [3, 6, 9, 12]');
  return [...new Set(list.map((m) => intIn(m, 1, 12, 'Each month')))].sort((a, b) => a - b);
}

function cleanMonthDay(v, fallback) {
  if (v === 'last' || v === 'L') return 'last';
  return intIn(v ?? fallback, 1, 31, 'Day of the month');
}

/**
 * Validate and complete a rule. `startsOn` (a local date) fills the details people leave out: the
 * weekday for "weekly", the day for "monthly", the month for "quarterly"/"yearly". Returns
 * { rule, notes } where notes say which defaults were used.
 */
export function normalizeRule(input, { startsOn } = {}) {
  if (!input || typeof input !== 'object') fail('A recurrence is required');
  const notes = [];
  const freq = String(input.freq ?? input.frequency ?? '').toLowerCase();
  const start = isDateStr(startsOn) ? startsOn : null;
  const startDay = start ? Number(start.slice(8, 10)) : 1;
  const startMonth = start ? Number(start.slice(5, 7)) : 1;
  if (freq === 'cron') {
    const expr = String(input.expr ?? input.schedule ?? '').trim();
    try {
      new Cron(expr, { paused: true }).stop();
    } catch (err) {
      fail(`Invalid cron expression: ${err.message}`);
    }
    return { rule: { freq: 'cron', expr }, notes };
  }
  if (input.time == null) notes.push(`No time given, so it runs at ${DEFAULT_TIME}.`);
  const time = cleanTime(input.time);
  const missing = input.missing_day ?? input.if_day_missing;
  if (missing != null && !['last_day', 'skip'].includes(missing)) fail('if_day_missing must be "last_day" or "skip"');

  if (freq === 'daily') {
    const interval = intIn(input.interval ?? 1, 1, 365, 'Every n days');
    const weekdays = cleanWeekdays(input.weekdays ?? input.days, false);
    if (weekdays && interval > 1) fail('Use either "every n days" or selected weekdays, not both');
    return { rule: { freq, time, ...(interval > 1 ? { interval } : {}), ...(weekdays && weekdays.length < 7 ? { weekdays } : {}) }, notes };
  }
  if (freq === 'weekly') {
    let weekdays = cleanWeekdays(input.weekdays ?? input.days, false);
    if (!weekdays) {
      weekdays = [DAYS[start ? utcDate(start).getUTCDay() : 1]];
      notes.push(`No day of the week given, so it runs on ${DAY_NAMES[DAYS.indexOf(weekdays[0])]}s (the start date's weekday).`);
    }
    const interval = intIn(input.interval ?? 1, 1, 52, 'Every n weeks');
    return { rule: { freq, time, weekdays, ...(interval > 1 ? { interval } : {}) }, notes };
  }
  if (['monthly', 'quarterly', 'yearly'].includes(freq)) {
    if (input.month_day == null && input.day_of_month == null) notes.push(`No day of the month given, so it runs on day ${startDay} (the start date's day).`);
    const monthDay = cleanMonthDay(input.month_day ?? input.day_of_month, startDay);
    let months = cleanMonths(input.months);
    if (freq === 'quarterly' && !months) {
      const first = intIn(input.start_month ?? input.month ?? startMonth, 1, 12, 'The first month');
      months = [0, 3, 6, 9].map((k) => ((first - 1 + k) % 12) + 1).sort((a, b) => a - b);
      if (input.start_month == null && input.month == null) notes.push(`Quarterly from the start month: ${months.map((m) => MONTHS[m - 1]).join(', ')}.`);
    }
    if (freq === 'quarterly' && months.length !== 4) fail('Quarterly needs four months, three apart');
    if (freq === 'yearly' && !months) {
      if (input.month == null) notes.push(`No month given, so it runs every ${MONTH_NAMES[startMonth - 1]}.`);
      months = [intIn(input.month ?? startMonth, 1, 12, 'Month')];
    }
    if (freq === 'yearly' && months.length !== 1) fail('Yearly runs in one month; for several months use monthly with months');
    const rule = { freq, time, month_day: monthDay, ...(months && months.length < 12 ? { months } : {}) };
    if (monthDay !== 'last' && monthDay >= 29) {
      const inMonths = months ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
      const longest = Math.max(...inMonths.map((m) => daysInMonth(2024, m))); // 2024: Feb has 29
      if (monthDay > longest) fail(`${MONTH_NAMES[inMonths[0] - 1]} never has a day ${monthDay}`);
      const short = inMonths.filter((m) => daysInMonth(2025, m) < monthDay); // 2025: Feb has 28
      if (short.length) {
        rule.missing_day = missing ?? 'last_day';
        if (missing == null) notes.push(`Months without day ${monthDay} use their last day instead (say if they should be skipped).`);
      }
    }
    return { rule, notes };
  }
  fail('frequency must be daily, weekly, monthly, quarterly or yearly');
}

/** The croner pattern for a rule; filters in `accepts` handle what cron can't say. */
function cronPattern(rule) {
  if (rule.freq === 'cron') return rule.expr;
  const [hh, mm] = rule.time.split(':').map(Number);
  if (rule.freq === 'daily') return `${mm} ${hh} * * ${rule.weekdays ? rule.weekdays.map((d) => DAYS.indexOf(d)).join(',') : '*'}`;
  if (rule.freq === 'weekly') return `${mm} ${hh} * * ${rule.weekdays.map((d) => DAYS.indexOf(d)).join(',')}`;
  const months = rule.months ? rule.months.join(',') : '*';
  const dom = rule.month_day === 'last' ? 'L' : rule.missing_day === 'last_day' && rule.month_day >= 29 ? '28-31' : String(rule.month_day);
  return `${mm} ${hh} ${dom} ${months} *`;
}

function accepts(rule, p, anchor) {
  if (rule.freq === 'daily' && rule.interval > 1) return daysBetweenStr(anchor, p.date) % rule.interval === 0;
  if (rule.freq === 'weekly' && rule.interval > 1) {
    // Weeks count from the week of the first matching day on or after the start date.
    let first = anchor;
    for (let k = 0; k < 7 && !rule.weekdays.includes(DAYS[utcDate(first).getUTCDay()]); k++) first = addDaysStr(anchor, k + 1);
    const monday = addDaysStr(first, -((utcDate(first).getUTCDay() + 6) % 7));
    return Math.floor(daysBetweenStr(monday, p.date) / 7) % rule.interval === 0;
  }
  if (rule.month_day !== 'last' && rule.missing_day === 'last_day' && rule.month_day >= 29) {
    const last = daysInMonth(p.y, p.m);
    return p.d === rule.month_day || (p.d === last && last < rule.month_day);
  }
  return true;
}

/**
 * Occurrence instants of a schedule strictly after `after` (and not before its start date), up to
 * `count`, never past its end date. `s` has rule, timezone, starts_on, ends_on.
 */
export function occurrencesAfter(s, after, count = 1) {
  const rule = typeof s.rule === 'string' ? JSON.parse(s.rule) : s.rule;
  const tz = s.timezone || DEFAULT_TIMEZONE;
  const anchor = s.starts_on || localDate(after, tz);
  let cursor = new Date(after);
  if (s.starts_on) {
    const start = startOfLocalDate(s.starts_on, tz);
    if (start > cursor) cursor = new Date(start.getTime() - 1000);
  }
  const job = new Cron(cronPattern(rule), { timezone: tz, paused: true });
  const out = [];
  try {
    for (let guard = 0; out.length < count && guard < 5000; guard++) {
      const next = job.nextRun(cursor);
      if (!next) break;
      const p = localParts(next, tz);
      if (s.ends_on && p.date > s.ends_on) break;
      cursor = next;
      if (accepts(rule, p, anchor)) out.push(next);
    }
  } finally {
    job.stop();
  }
  return out;
}

/** Occurrences in (from, to]: used to catch up after downtime. Capped. */
export function occurrencesBetween(s, fromExclusive, toInclusive, cap = 1000) {
  const out = [];
  let cursor = new Date(fromExclusive);
  while (out.length < cap) {
    const [next] = occurrencesAfter(s, cursor, 1);
    if (!next || next > new Date(toInclusive)) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

// ---------------------------------------------------------------- in words

const ordinal = (n) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const listWords = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
export function timeWords(time) {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Every Monday at 9:00 AM", "Quarterly on the 14th (Mar, Jun, Sep, Dec) at 9:00 AM". */
export function describeRule(rule) {
  if (!rule) return 'Does not repeat';
  if (typeof rule === 'string') rule = JSON.parse(rule);
  if (rule.freq === 'cron') return `Custom schedule (cron: ${rule.expr})`;
  const at = ` at ${timeWords(rule.time)}`;
  const days = (list) => {
    const key = list.join(',');
    if (key === 'mon,tue,wed,thu,fri') return 'weekday';
    return listWords(list.map((d) => DAY_NAMES[DAYS.indexOf(d)]));
  };
  if (rule.freq === 'daily') {
    if (rule.weekdays) return `Every ${days(rule.weekdays)}${at}`;
    return `${rule.interval > 1 ? `Every ${rule.interval} days` : 'Every day'}${at}`;
  }
  if (rule.freq === 'weekly') return `${rule.interval > 1 ? `Every ${rule.interval} weeks on ${days(rule.weekdays)}` : `Every ${days(rule.weekdays)}`}${at}`;
  const day = rule.month_day === 'last' ? 'the last day' : `the ${ordinal(rule.month_day)}`;
  const missing =
    rule.missing_day === 'skip' ? ` (skipped in months without a ${ordinal(rule.month_day)})` : rule.missing_day === 'last_day' ? ` (or the month's last day if it's shorter)` : '';
  const months = rule.months?.map((m) => MONTHS[m - 1]);
  if (rule.freq === 'yearly') {
    const leap = rule.month_day === 29 && rule.months[0] === 2 && rule.missing_day === 'skip' ? ' (only in leap years)' : rule.month_day === 29 && rule.months[0] === 2 ? ' (28 Feb in other years)' : '';
    return `Every year on ${rule.month_day === 'last' ? `the last day of ${MONTH_NAMES[rule.months[0] - 1]}` : `${rule.month_day} ${MONTH_NAMES[rule.months[0] - 1]}`}${leap}${at}`;
  }
  if (rule.freq === 'quarterly') return `Quarterly on ${day} of ${listWords(months)}${missing}${at}`;
  return `${months ? `On ${day} of ${listWords(months)}` : `Monthly on ${day}`}${missing}${at}`;
}

// ---------------------------------------------------------------- reporting periods

export const PERIOD_KINDS = ['none', 'previous_week', 'previous_month', 'previous_quarter', 'previous_year', 'previous_months', 'anchored'];

/** { kind, months?, anchor_month? } or null. */
export function normalizePeriodRule(p) {
  if (p == null || p === 'none' || p.kind === 'none' || p.type === 'none') return null;
  const kind = String(p.kind ?? p.type ?? p);
  if (!PERIOD_KINDS.includes(kind)) fail(`reporting period must be one of: ${PERIOD_KINDS.join(', ')}`);
  if (kind === 'previous_months') return { kind, months: intIn(p.months, 1, 24, 'Number of months') };
  if (kind === 'anchored') return { kind, months: intIn(p.months, 1, 12, 'Period length in months'), anchor_month: intIn(p.anchor_month, 1, 12, 'The month a period starts in') };
  return { kind };
}

function monthsPeriod(y, m, length, anchorMonth) {
  // The latest period of `length` months (starting in months ≡ anchorMonth) that ended before month y-m.
  const M = y * 12 + (m - 1);
  const a = anchorMonth - 1;
  const S = a + Math.floor((M - length - a) / length) * length;
  const E = S + length - 1;
  const sy = Math.floor(S / 12), sm = (S % 12) + 1, ey = Math.floor(E / 12), em = (E % 12) + 1;
  return { start: `${ym(sy, sm)}-01`, end: `${ym(ey, em)}-${pad(daysInMonth(ey, em))}` };
}

export function periodLabel(start, end) {
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  if (start.slice(8) !== '01' || Number(end.slice(8)) !== daysInMonth(ey, em)) return `${formatDate(start)} – ${formatDate(end)}`;
  if (sy === ey && sm === em) return `${MONTH_NAMES[sm - 1]} ${sy}`;
  if (sy === ey && sm === 1 && em === 12) return String(sy);
  if (sy === ey && em - sm === 2 && sm % 3 === 1) return `Q${(sm + 2) / 3} ${sy} (${MONTHS[sm - 1]}–${MONTHS[em - 1]})`;
  return `${MONTHS[sm - 1]} ${sy} – ${MONTHS[em - 1]} ${ey}`;
}

/** The reporting period for an occurrence on local date `onDate`: { start, end, label } or null. */
export function resolvePeriod(rule, onDate) {
  if (!rule) return null;
  const [y, m] = onDate.split('-').map(Number);
  let p;
  if (rule.kind === 'previous_week') {
    const monday = addDaysStr(onDate, -((utcDate(onDate).getUTCDay() + 6) % 7));
    p = { start: addDaysStr(monday, -7), end: addDaysStr(monday, -1) };
  } else if (rule.kind === 'previous_month') p = monthsPeriod(y, m, 1, 1);
  else if (rule.kind === 'previous_quarter') p = monthsPeriod(y, m, 3, 1);
  else if (rule.kind === 'previous_year') p = monthsPeriod(y, m, 12, 1);
  else if (rule.kind === 'previous_months') p = monthsPeriod(y, m, rule.months, m); // ends the month before
  else if (rule.kind === 'anchored') p = monthsPeriod(y, m, rule.months, rule.anchor_month);
  else return null;
  return { ...p, label: periodLabel(p.start, p.end) };
}

export function describePeriodRule(rule) {
  if (!rule) return 'None';
  if (rule.kind === 'previous_week') return 'The previous week (Monday–Sunday)';
  if (rule.kind === 'previous_month') return 'The previous calendar month';
  if (rule.kind === 'previous_quarter') return 'The previous calendar quarter';
  if (rule.kind === 'previous_year') return 'The previous calendar year';
  if (rule.kind === 'previous_months') return `The ${rule.months} full month${rule.months === 1 ? '' : 's'} before the run`;
  return `The latest completed ${rule.months}-month period (periods start in ${MONTH_NAMES[rule.anchor_month - 1]}, every ${rule.months} months)`;
}

// ---------------------------------------------------------------- deadlines

export const DEADLINE_KINDS = ['none', 'days_after_start', 'days_after_period_end'];

export function normalizeDeadlineRule(d, periodRule) {
  if (d == null || d === 'none' || d.kind === 'none' || d.type === 'none') return null;
  const kind = String(d.kind ?? d.type ?? '');
  if (!DEADLINE_KINDS.includes(kind)) fail(`deadline must be one of: ${DEADLINE_KINDS.join(', ')}`);
  if (kind === 'days_after_period_end' && !periodRule) fail('A deadline after the period ends needs a reporting period');
  return { kind, days: intIn(d.days ?? 0, 0, 365, 'Deadline days') };
}

/** Due date (local date) for an occurrence on `onDate` with period `period`. */
export function resolveDeadline(rule, onDate, period) {
  if (!rule) return null;
  if (rule.kind === 'days_after_start') return addDaysStr(onDate, rule.days);
  if (rule.kind === 'days_after_period_end' && period) return addDaysStr(period.end, rule.days);
  return null;
}

export function describeDeadlineRule(rule) {
  if (!rule) return 'No due date';
  if (rule.kind === 'days_after_start') return rule.days === 0 ? 'Due the same day it starts' : `Due ${rule.days} day${rule.days === 1 ? '' : 's'} after it starts`;
  return rule.days === 0 ? 'Due the day the reporting period ends' : `Due ${rule.days} day${rule.days === 1 ? '' : 's'} after the reporting period ends`;
}

// ---------------------------------------------------------------- template variables

export const TEMPLATE_VARIABLES = ['scheduled_date', 'due_date', 'period_start', 'period_end', 'period_label'];

/** Check {{variables}} in a text: only the documented ones, and period ones only with a period rule. */
export function checkTemplate(text, { periodRule, deadlineRule } = {}) {
  for (const [, name] of String(text ?? '').matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
    if (!TEMPLATE_VARIABLES.includes(name)) fail(`Unknown variable {{${name}}}. Use ${TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(', ')}`);
    if (name.startsWith('period_') && !periodRule) fail(`{{${name}}} needs a reporting period rule`);
    if (name === 'due_date' && !deadlineRule) fail('{{due_date}} needs a deadline rule');
  }
}

export function fillTemplate(text, vars) {
  return String(text ?? '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, name) => (vars[name] != null ? vars[name] : m));
}
